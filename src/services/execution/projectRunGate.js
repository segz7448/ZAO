/**
 * ZAO - Project Run Gate (pre-run Syntax / JSX check)
 *
 * Closes a specific gap: previously nothing stopped ZAO from running
 * `npm start` / `expo start` / `npm run build` / etc. against a project
 * it had just finished editing, even when the last fs_create_file/
 * fs_edit_file call had introduced a syntax error - the model (and the
 * person) would only find out from the crash output afterwards.
 *
 * RUN_PROJECT_PATTERNS recognizes the shape of a command that actually
 * starts/builds/serves a project - not every shell command needs this
 * (`ls`, `git status`, `cat package.json`, `npm --version` all skip it).
 * When one matches, every checkable file under the SAF-granted folder is
 * parsed with the exact same real parser (syntaxCheck.js) that
 * filesystemTool.js's createFile/editFile already run automatically on
 * every write. Any failure blocks the command outright - mirrors
 * commandSafety.js's HARD_BLOCKED shape (no `confirmed: true` override,
 * since "run it anyway even though it can't start" isn't a real choice) -
 * and the model gets back exactly which file/line is broken instead of
 * the project launching broken, or not launching with an opaque crash.
 *
 * WIRED IN: pcTerminalTool.js's runCommand(), right after
 * checkCommandSafety - so this applies no matter which entry point a
 * call comes through (the normal flat tool loop, or
 * approveAndRunPendingTool's confirmed re-run in toolOrchestrator.js).
 *
 * CAVEAT, stated plainly (same honesty standard as EXECUTION_SAFETY.md):
 * this checks the SAF-granted folder ZAO's own filesystem tools read/
 * write (src/services/filesystem/filesystemTool.js) - the project ZAO
 * has actually been editing. terminal_pc_run_command runs on a
 * *different machine* (the person's PC backend), which may or may not
 * be pointed at that same
 * folder - when it isn't, this gate is still checking real code for real
 * errors, just not a guarantee the PC's copy matches byte-for-byte.
 */
import { checkProjectSyntax } from '../filesystem/filesystemTool';

// Anchored/word-bounded on purpose - e.g. "npm install react-starter-kit"
// or "cat npm-start-notes.md" must NOT match just because "start" appears
// somewhere in the string.
const RUN_PROJECT_PATTERNS = [
  /\bnpm\s+(run\s+)?(start|dev|build|serve)\b/i,
  /\byarn\s+(run\s+)?(start|dev|build|serve)\b/i,
  /\bpnpm\s+(run\s+)?(start|dev|build|serve)\b/i,
  /\bbun\s+(run\s+)?(start|dev|build)\b/i,
  /\bexpo\s+(start|run:android|run:ios|export)\b/i,
  /\bnode\s+\S+\.(m|c)?js\b/i,
  /\breact-native\s+(start|run-android|run-ios)\b/i,
  /\bnext\s+(dev|start|build)\b/i,
  /\bvite\b(?!\s*(--version|-v)\b)/i,
  /\bgradlew\s+(assemble|build|install)/i,
  /\bpython[0-9.]*\s+manage\.py\s+runserver\b/i,
];

/**
 * Whether `command` looks like it launches, builds, or serves a project
 * (as opposed to a read-only or unrelated shell command).
 */
export function isProjectRunCommand(command) {
  if (!command || typeof command !== 'string') return false;
  return RUN_PROJECT_PATTERNS.some((re) => re.test(command));
}

/**
 * Runs the pre-run project syntax check when `command` matches
 * isProjectRunCommand. Returns { blocked: false } for every other
 * command, and also fails OPEN (never blocks) when there's no
 * SAF-granted folder to check or the scan itself errors - this gate
 * exists on top of ZAO's own edits, not as a hard requirement to ever
 * run anything at all.
 *
 * @param {string} command
 * @returns {Promise<{blocked: boolean, reason?: string, failures?: Array<{path: string, errors: Array}>}>}
 */
export async function checkBeforeProjectRun(command) {
  if (!isProjectRunCommand(command)) return { blocked: false };

  const result = await checkProjectSyntax('');
  if (!result.success) return { blocked: false };

  const { failures, filesChecked, valid } = result.data;
  if (valid || filesChecked === 0) return { blocked: false };

  const shown = failures.slice(0, 10);
  const summary = shown
    .map((f) => `  - ${f.path}: ${f.errors.map((e) => `${e.line != null ? `line ${e.line}${e.column != null ? `:${e.column}` : ''} - ` : ''}${e.message}`).join('; ')}`)
    .join('\n');
  const more = failures.length > shown.length ? `\n  ...and ${failures.length - shown.length} more file(s).` : '';

  return {
    blocked: true,
    reason: `Blocked: "${command}" would start/build a project with ${failures.length} file(s) that fail a real syntax check:\n${summary}${more}\n\nFix these (fs_edit_file) - or run fs_check_project_syntax again after fixing - then re-run this command.`,
    failures,
  };
}
