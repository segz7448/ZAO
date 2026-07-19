/**
 * ZAO - Terminal Command Safety
 *
 * Both terminal tools (pcTerminalTool.js, termuxTerminalTool.js) execute
 * whatever command string they're given, by design - that's the whole
 * point of a real shell tool. Before this module, that meant a model
 * mistake, a bad plan, or a prompt-injected instruction (e.g. text
 * pulled from a webpage during a browsing task) could run something
 * irreversible with zero gate in between. This module is that gate.
 *
 * Two tiers:
 *   - HARD_BLOCKED: never runs, no override. Reserved for commands with
 *     no legitimate use in ZAO's own task set and catastrophic blast
 *     radius (wipe a whole drive, wipe root, disk partitioning).
 *   - RISKY: runs, but only when the caller explicitly marks the call as
 *     human-confirmed (see runCommand()'s `confirmed` option in both
 *     terminal tools). Without that, the command is refused with a
 *     clear reason instead of silently executing - the model sees the
 *     refusal in the tool result and has to relay it to the person
 *     rather than pretending the task is done.
 *
 * These are the SAME patterns `src/services/planning/riskClassifier.js`
 * already uses to decide whether a *planned* step needs approval -
 * re-exported from here so there's one list, not two that can drift.
 * The difference is where the gate sits: riskClassifier.js gates entry
 * into planExecutor.js's step loop (the hierarchical-plan path);
 * this module gates the raw tool call itself, which also covers the
 * flat ReAct tool loop (toolOrchestrator.js) that riskClassifier.js
 * never sees.
 */

// Never runs, under any circumstances, from either terminal tool. Kept
// intentionally short - a broad blocklist creates false confidence and
// still lets close variants slip through; the point of this tier is a
// last-resort backstop against total data loss, not a substitute for the
// RISKY tier below actually being checked before every call.
const HARD_BLOCKED_PATTERNS = [
  /\brm\s+-rf?\s+\/\s*($|[^a-z])/i, // rm -rf / (root wipe, not e.g. rm -rf ./foo)
  /\brm\s+-rf?\s+\/\*/i, // rm -rf /*
  /\bmkfs\b/i, // format a filesystem
  /\bdd\s+.*of=\/dev\//i, // dd writing directly to a device
  /\bformat\s+[a-z]:\s*\/?\s*$/i, // Windows: format c: with no other args (whole-drive wipe)
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, // fork bomb
];

// Runs only when explicitly human-confirmed. Same list riskClassifier.js
// uses for terminal/coding steps - see that file's own docstring for the
// full rationale (irreversible-only, not "anything that could go wrong").
const RISKY_TERMINAL_PATTERNS = [
  /\brm\s+-rf?\b/,
  /\brmdir\b/,
  /\bdel\s+\/[fsq]/i,
  /\brd\s+\/s/i,
  /\bdrop\s+(table|database)\b/i,
  /\btruncate\s+table\b/i,
  /\bgit\s+push\b/,
  /\bgit\s+push\s+--force\b/,
  /\bgit\s+reset\s+--hard\b/,
  /\bformat\b.*[a-z]:/i,
  /\bdiskpart\b/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
];

/**
 * @param {string} command
 * @returns {{ blocked: boolean, risky: boolean, reason: string|null }}
 */
function checkCommandSafety(command) {
  const cmd = (command || '').toLowerCase();

  for (const pattern of HARD_BLOCKED_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        blocked: true,
        risky: true,
        reason: 'This command is permanently blocked (catastrophic, irreversible data loss) and cannot be run through ZAO regardless of confirmation.',
      };
    }
  }

  for (const pattern of RISKY_TERMINAL_PATTERNS) {
    if (pattern.test(cmd)) {
      return {
        blocked: false,
        risky: true,
        reason: 'This command is irreversible or destructive - it needs explicit human confirmation before it can run.',
      };
    }
  }

  return { blocked: false, risky: false, reason: null };
}

export { checkCommandSafety, HARD_BLOCKED_PATTERNS, RISKY_TERMINAL_PATTERNS };
