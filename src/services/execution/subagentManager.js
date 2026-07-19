/**
 * ZAO - Subagent Manager
 *
 * ZAO's answer to Claude Code's Subagents/Agent Teams. Before this file,
 * SYSTEM_COMPONENTS.md's own comparison table was blunt about it: "None -
 * ZAO has no context-isolation mechanism at all besides chat-history
 * compaction." This is that mechanism.
 *
 * WHY runToolTask() WAS ALREADY HALFWAY THERE: toolOrchestrator.js's
 * runToolTask() builds a brand-new `history` array from scratch on every
 * call (system prompt + one user message) and never reads any outside
 * state - it's already a genuinely isolated ReAct loop per call. What was
 * missing wasn't isolation, it was the ability to fire off SEVERAL of
 * those isolated loops at once from a single parent request and get their
 * results back as one summarized tool result, instead of the person
 * having to type each one as a separate message. That's all this module
 * adds: a fan-out/fan-in layer on top of the loop that already existed.
 *
 * ISOLATION GUARANTEE: a subagent gets a fresh history containing only
 * the prompt it was given - no visibility into the parent conversation,
 * the parent's scratchpad, or any sibling subagent running in parallel.
 * The parent model only ever sees each subagent's FINAL answer (via the
 * agent_spawn_subagents tool result), never its intermediate tool calls -
 * this is the actual value of context isolation: ten file reads and
 * three failed greps inside a subagent cost that subagent's context
 * window, not the parent's.
 *
 * RECURSION GUARD: a subagent is spawned with context.isSubagent = true,
 * which toolOrchestrator.js's schema list filters agent_spawn_subagents
 * out of - a subagent cannot itself spawn subagents. One level of
 * nesting only, by design (matches Claude Code's own subagents, which
 * likewise don't spawn sub-subagents).
 *
 * CIRCULAR IMPORT NOTE: this module imports runToolTask from
 * toolOrchestrator.js, and toolOrchestrator.js's TOOL_REGISTRY imports
 * spawnSubagents from this module - a real circular dependency, kept
 * deliberately rather than merging the two files. Both imports are only
 * ever CALLED from inside async function bodies (never referenced at
 * module-evaluation time), which is the case ES module circular imports
 * support correctly - the binding is live and resolved by the time either
 * function actually runs.
 */

import { newTraceId, startSpan, endSpan } from './telemetry';

/**
 * @param {Array<{description: string, prompt: string}>} tasks - one entry per subagent to spawn; `description` is the short label shown in the parent's live checklist, `prompt` is the full isolated instruction that subagent receives as its only input
 * @param {object} context - passed through to each subagent's runToolTask call (githubUsername, permissionMode, sessionId, conversationId) MINUS isSubagent, which this always sets itself
 * @param {function} onSubagentStep - optional callback(description, label) fired for each subagent's own onStep events, prefixed so the parent's live checklist can show "[Subagent 2] Created App.js" style lines
 * @returns {Promise<{success: boolean, results: Array<{description: string, success: boolean, answer: string|null, error: object|null}>}>}
 */
export async function spawnSubagents(tasks, context = {}, onSubagentStep = null) {
  // Lazy require avoids the circular-import module-evaluation trap
  // described in this file's header - toolOrchestrator.js is only
  // touched once this function actually runs, never while either module
  // is first being loaded.
  const { runToolTask } = require('../toolOrchestrator');

  const traceId = context.traceId || newTraceId();
  const parentSpanId = context.parentSpanId || null;

  const runOne = async (task, index) => {
    const { spanId } = await startSpan({
      traceId,
      parentSpanId,
      sessionId: context.sessionId || null,
      conversationId: context.conversationId || null,
      name: `subagent:${task.description}`,
      toolName: 'agent_spawn_subagents',
      attributes: { index, prompt: task.prompt.slice(0, 500) },
    });

    const result = await runToolTask(
      task.prompt,
      { ...context, isSubagent: true, traceId, parentSpanId: spanId },
      (label) => onSubagentStep?.(task.description, label)
    );

    await endSpan(spanId, {
      status: result.success ? 'ok' : 'error',
      errorMessage: result.error?.message || null,
      attributes: { stepsCompleted: result.stepsCompleted?.length || 0 },
    });

    return { description: task.description, success: result.success, answer: result.answer, error: result.error };
  };

  // Genuinely parallel - each subagent's own runToolTask loop makes its
  // own model calls concurrently, not queued one after another. This is
  // the "Agent Teams" half of the feature: three independent subtasks
  // (e.g. "write the backend route", "write the frontend screen", "write
  // the tests") run at the same time instead of serially.
  const results = await Promise.all(tasks.map((task, i) => runOne(task, i)));

  return { success: results.every((r) => r.success), results };
}
