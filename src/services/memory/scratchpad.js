/**
 * ZAO - Scratchpad / short-term working memory
 *
 * This is the memory type that needs the LEAST new wiring, because ZAO
 * already has two working implementations of it - this module exists to
 * name the pattern, document where it already lives, and give any NEW
 * agent loop a ready-made, correctly-bounded implementation instead of
 * inventing a third slightly-different one:
 *
 *   1. server/browserAgent.js - `BrowserAgentSession.history` (PC side).
 *      An in-process array of {role, content} turns for one live
 *      Playwright browsing session: system prompt, then an
 *      observe -> think -> act loop appended turn by turn. Already has
 *      its own trimming logic (see the `observationIndices` /
 *      `__trimmed` handling around line ~210 of that file) so old page
 *      observations get collapsed once they're no longer the most
 *      recent one - exactly the "keep the current run's reasoning
 *      state, don't let it grow unbounded" job a scratchpad does.
 *      Discarded the moment the session ends; never touches SQLite.
 *
 *   2. src/services/toolOrchestrator.js - the local `history` array
 *      inside runToolTask()'s ReAct loop (phone side). Same idea for
 *      the flat (non-hierarchical) tool-calling path: assistant
 *      tool_calls turn, then a tool-result message per call, repeated
 *      until the loop finishes. Lives only for the duration of that
 *      one function call.
 *
 * Both of those were built independently before this taxonomy pass and
 * are correct as-is (an invasive refactor to force them through a
 * shared class would risk destabilizing two already-working agent
 * loops for no real benefit) - see MEMORY_ARCHITECTURE.md for the full
 * classification. What follows is the shared shape, offered for any
 * FUTURE loop that needs the same pattern.
 */

/**
 * A minimal bounded scratchpad: push turns, read them back for the next
 * model call, and keep the total size in check by collapsing everything
 * except the most recent N entries into a short placeholder - the same
 * strategy server/browserAgent.js already hand-rolls for page
 * observations. Purely in-memory (a plain array wrapper) - there is no
 * persist()/load() here on purpose, since a scratchpad that survives
 * past the run it was built for is no longer a scratchpad, it's
 * episodic memory (see src/db/database.js's messages/plan_step_actions
 * tables for that).
 */
export class Scratchpad {
  /**
   * @param {{ systemPrompt?: string, keepRecent?: number }} options
   */
  constructor({ systemPrompt = null, keepRecent = 6 } = {}) {
    this.entries = systemPrompt ? [{ role: 'system', content: systemPrompt }] : [];
    this.keepRecent = keepRecent;
  }

  /** Appends one turn (role: 'user' | 'assistant' | 'system', plus any extra fields like tool_calls the caller's model API needs passed through). */
  push(entry) {
    this.entries.push(entry);
  }

  /** Collapses every entry beyond the most recent `keepRecent` non-system ones into a single short placeholder, in place - same purpose as browserAgent.js's observation trimming, generalized. `summarize` is a caller-supplied function (content: string) => string, since what counts as a good collapsed form differs by loop (a page observation vs. a tool result read differently). */
  trim(summarize) {
    const systemEntries = this.entries.filter((e) => e.role === 'system');
    const rest = this.entries.filter((e) => e.role !== 'system');
    if (rest.length <= this.keepRecent) return;

    const toCollapse = rest.slice(0, rest.length - this.keepRecent);
    const kept = rest.slice(rest.length - this.keepRecent);
    const collapsedContent = summarize
      ? summarize(toCollapse.map((e) => e.content).join('\n'))
      : `[${toCollapse.length} earlier step(s) omitted to save space]`;

    this.entries = [...systemEntries, { role: 'system', content: collapsedContent }, ...kept];
  }

  /** Returns the plain {role, content, ...} array ready to hand to a model call. */
  toHistory() {
    return this.entries;
  }

  /** Discards everything - called when the run this scratchpad belonged to ends. Explicit rather than relying on garbage collection so a caller holding a long-lived reference (e.g. a screen component) can't accidentally keep leaking turns from a finished run. */
  clear() {
    this.entries = [];
  }
}
