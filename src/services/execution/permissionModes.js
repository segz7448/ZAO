/**
 * ZAO - Permission Modes
 *
 * Five modes, same names/shape as Claude Code, interactively switchable
 * from Settings (persisted in user_preferences.permission_mode - see
 * src/db/database.js) and readable mid-task by toolOrchestrator.js /
 * planExecutor.js before every tool call:
 *
 *   - 'default'            - safe tools run free; WRITE_TOOLS and RISKY
 *                             terminal commands need confirmation. This is
 *                             the pre-existing behavior commandSafety.js
 *                             already had - just now named and switchable
 *                             rather than the only option.
 *   - 'acceptEdits'        - file edits/creates/moves/zips auto-run
 *                             without confirmation (the "diff already
 *                             looks right, stop asking me" mode); destructive
 *                             ones (fs_delete) and terminal commands still
 *                             follow 'default' rules.
 *   - 'plan'               - read-only. Only READ_TOOLS (+ todo_write,
 *                             web_search, time_get_current) are allowed;
 *                             every WRITE_TOOL and terminal command is
 *                             refused outright, not just gated - matches
 *                             Claude Code's plan mode being a hard
 *                             "can't touch anything yet" state, not a
 *                             softer confirmation step.
 *   - 'auto'               - ZAO's autonomous-run mode: every WRITE_TOOL
 *                             and RISKY terminal command auto-runs with no
 *                             confirmation. HARD_BLOCKED terminal patterns
 *                             (commandSafety.js) still can't run - that
 *                             tier has no override in ANY mode, including
 *                             this one and bypassPermissions below. This
 *                             is a deliberate ZAO-specific hardening
 *                             beyond upstream Claude Code's actual
 *                             behavior: a phone-based agent with SAF
 *                             filesystem access and a real PC shell
 *                             backend has a bigger unattended blast radius
 *                             than a developer's own terminal, so the
 *                             catastrophic tier stays a hard floor no
 *                             mode can lift.
 *   - 'bypassPermissions'  - same as 'auto' (every WRITE_TOOL and RISKY
 *                             terminal command skips confirmation). Kept
 *                             as a separate named mode rather than merged
 *                             with 'auto' because Settings surfaces them
 *                             as textually distinct options (matching
 *                             Claude Code's own five-name list) even
 *                             though ZAO's gate treats them identically -
 *                             if a future need to distinguish them shows
 *                             up (e.g. auto-mode keeping hooks active,
 *                             bypass skipping hooks too) the branch is
 *                             already here to diverge without a schema
 *                             change.
 *
 * This module does NOT execute anything - it's a pure decision function.
 * The caller (toolOrchestrator.js's tool loop, planExecutor.js's step
 * loop) is responsible for actually pausing and surfacing a confirmation
 * UI when requiresConfirmation is true, same as commandSafety.js's
 * pre-existing needsConfirmation contract.
 *
 * A mode letting a call auto-run (requiresConfirmation: false here in
 * 'acceptEdits'/'auto'/'bypassPermissions', where 'default' would have
 * been true) is not the last word on whether it actually runs unattended
 * - toolOrchestrator.js layers actionConfidence.js's per-action
 * confidence check on top of exactly those calls, and can still convert
 * a specific low-confidence one back into a confirmation card even
 * though the mode said to skip it. This module only ever answers "does
 * the MODE require confirmation for this kind of tool"; it has no
 * opinion on any individual call's content.
 */

import { checkCommandSafety } from '../terminal/commandSafety';

export const PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions'];

// Tools that mutate something outside the model's own head - a file, a
// GitHub repo, a generated document. Read/search/inspect tools (fs_read_file,
// fs_grep, fs_glob, fs_list_folder, fs_check_syntax, fs_check_project_syntax,
// github_read_file, github_clone_repo, web_search, time_get_current,
// terminal_check_status, todo_write) are deliberately excluded - they're
// always allowed outside 'plan' mode since they can't change anything.
const WRITE_TOOLS = new Set([
  'fs_create_file', 'fs_create_folder', 'fs_edit_file', 'fs_rename', 'fs_move',
  'fs_zip', 'fs_extract_zip',
  'github_create_repo', 'github_commit_files', 'github_create_branch',
  'github_create_pull_request', 'github_create_release',
  'pdf_create', 'pdf_merge', 'pdf_split', 'docx_create', 'xlsx_create', 'csv_create', 'pptx_create',
]);

// The subset of WRITE_TOOLS that's destructive/hard-to-undo even with
// checkpoints (deleting something ZAO never snapshotted a "before" for in
// the same way an edit gets one) - stays gated in 'acceptEdits' even
// though ordinary edits don't.
const DESTRUCTIVE_TOOLS = new Set(['fs_delete']);

const TERMINAL_TOOLS = new Set(['terminal_pc_run_command', 'terminal_termux_run_command']);

/**
 * @param {string} toolName - the function name from TOOL_REGISTRY (toolOrchestrator.js)
 * @param {object} args - the tool call's parsed arguments (needed for terminal commands, to run commandSafety's pattern check)
 * @param {string} mode - one of PERMISSION_MODES
 * @returns {{ allowed: boolean, requiresConfirmation: boolean, reason: string|null }}
 */
export function getToolPermissionDecision(toolName, args, mode = 'default') {
  const isWrite = WRITE_TOOLS.has(toolName);
  const isDestructive = DESTRUCTIVE_TOOLS.has(toolName);
  const isTerminal = TERMINAL_TOOLS.has(toolName);

  // 'plan' mode is a hard floor regardless of the tool - nothing that
  // touches the outside world runs, full stop, no confirmation escape
  // hatch (that's the whole point of plan mode: think and propose, don't
  // act yet).
  if (mode === 'plan' && (isWrite || isDestructive || isTerminal)) {
    return { allowed: false, requiresConfirmation: false, reason: `Plan mode is read-only - "${toolName}" was not run. Switch to a different permission mode to let ZAO act on this plan.` };
  }

  if (isTerminal) {
    const safety = checkCommandSafety(args?.command || '');
    if (safety.blocked) {
      // HARD_BLOCKED has no override in any mode - see module header.
      return { allowed: false, requiresConfirmation: false, reason: safety.reason };
    }
    if (safety.risky) {
      const autoRuns = mode === 'auto' || mode === 'bypassPermissions';
      return autoRuns
        ? { allowed: true, requiresConfirmation: false, reason: null }
        : { allowed: true, requiresConfirmation: true, reason: safety.reason };
    }
    return { allowed: true, requiresConfirmation: false, reason: null };
  }

  if (isDestructive) {
    const autoRuns = mode === 'auto' || mode === 'bypassPermissions';
    return autoRuns
      ? { allowed: true, requiresConfirmation: false, reason: null }
      : { allowed: true, requiresConfirmation: true, reason: `"${toolName}" deletes something - confirm before it runs.` };
  }

  if (isWrite) {
    const autoRuns = mode === 'acceptEdits' || mode === 'auto' || mode === 'bypassPermissions';
    return autoRuns
      ? { allowed: true, requiresConfirmation: false, reason: null }
      : { allowed: true, requiresConfirmation: true, reason: `"${toolName}" makes a change - confirm before it runs.` };
  }

  // Everything else (reads, search, time, todo_write) is always free.
  return { allowed: true, requiresConfirmation: false, reason: null };
}

export function isWriteTool(toolName) {
  return WRITE_TOOLS.has(toolName) || DESTRUCTIVE_TOOLS.has(toolName);
}
