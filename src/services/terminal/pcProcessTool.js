/**
 * ZAO - PC Background Process Tool
 *
 * WHAT THIS FIXES: terminal_pc_run_command (pcTerminalTool.js) waits for
 * the command to exit before returning - correct for npm install or a
 * build, a dead end for anything meant to keep running (npm start, a
 * dev server, a watcher). Before this existed, "run npm start" was a
 * guaranteed 2-minute timeout with nothing useful to show for it.
 *
 * pc_process_start hands back an id immediately instead of blocking;
 * pc_process_status/pc_process_logs/pc_process_stop then let the model
 * (and the person, since this is a phone, not a terminal window in
 * front of them) check on it, read its output, and kill it whenever it
 * wants - see server/processManager.js for the PC-side half of this.
 *
 * TRACKING FOR NOTIFICATIONS: every process started here is also
 * recorded in ZAO's own `background_processes` table (src/db/database.js)
 * so src/services/background/processWatcherTask.js can notice - even
 * from a background wakeup, not just while this exact chat is open -
 * when a tracked process crashes or finishes, and fire a local
 * notification for it. Starting a process through the raw backendClient
 * function without going through here would skip that tracking; always
 * go through startProcess() below, not startPcProcess() directly.
 *
 * SAFETY: same two gates as pcTerminalTool.js's runCommand -
 * commandSafety.js's pattern check (HARD_BLOCKED never runs; RISKY needs
 * `confirmed`) and the syntax/JSX project-run gate for anything that
 * actually starts/serves a project. Background processes have no
 * sandbox option (see processManager.js's header for why a dev server
 * can't run through the Docker sandbox), so there's no hostAccess/
 * allowNetwork here the way there is for terminal_pc_run_command.
 */

import { startPcProcess, getPcProcessStatus, getPcProcessLogs, stopPcProcess } from '../backend/backendClient';
import { checkCommandSafety } from './commandSafety';
import { checkBeforeProjectRun } from '../execution/projectRunGate';
import { addBackgroundProcess, updateBackgroundProcessStatus } from '../../db/database';

/**
 * Starts a command as a tracked background process on the PC. Returns
 * immediately with an id - does NOT wait for the command to exit.
 * @param {string} command
 * @param {object} options - { cwd, shell, confirmed, label, sourceConversationId }
 * @returns {Promise<{success, data: {id, shellUsed}|null, error}>}
 */
export async function startProcess(command, options = {}) {
  const { cwd = null, shell = null, confirmed = false, label = null, sourceConversationId = null } = options;

  const safety = checkCommandSafety(command);
  if (safety.blocked) {
    return { success: false, data: null, error: { message: safety.reason, blocked: true } };
  }
  if (safety.risky && !confirmed) {
    return { success: false, data: null, error: { message: safety.reason, needsConfirmation: true } };
  }

  // Same syntax/JSX gate terminal_pc_run_command uses - fires only for
  // commands that actually start/build/serve a project (npm start,
  // expo start, etc.), which is exactly the shape of command this tool
  // is for.
  const runGate = await checkBeforeProjectRun(command);
  if (runGate.blocked) {
    return { success: false, data: null, error: { message: runGate.reason, syntaxBlocked: true, failures: runGate.failures } };
  }

  const result = await startPcProcess(command, { cwd: cwd || undefined, shell: shell || undefined });
  if (!result.success) {
    return { success: false, data: null, error: result.error };
  }

  const { id, shellUsed } = result.data;

  // Best-effort tracking - a DB write failure shouldn't hide that the
  // process itself really did start on the PC; the person still gets an
  // id back to check on it manually, just without the automatic
  // "finished" notification.
  const dbResult = await addBackgroundProcess({ id, label: label || command, command, sourceConversationId });
  if (!dbResult.success) {
    console.warn('[PcProcessTool] Started process but failed to record it for notification tracking:', dbResult.error);
  }

  return { success: true, data: { id, shellUsed }, error: null };
}

/**
 * @param {string} processId
 * @returns {Promise<{success, data: {status, exitCode, signal, startedAt, finishedAt, pid, command, shellUsed, cwd}|null, error}>}
 */
export async function checkStatus(processId) {
  const result = await getPcProcessStatus(processId);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * @param {string} processId
 * @param {object} options - { tail, sinceIndex }
 * @returns {Promise<{success, data: {lines, nextIndex, status}|null, error}>}
 */
export async function tailLogs(processId, options = {}) {
  const result = await getPcProcessLogs(processId, options);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Stops a background process and mirrors the stop into ZAO's own
 * record immediately, rather than waiting for processWatcherTask.js's
 * next poll to notice - a deliberate stop shouldn't also trigger the
 * "it crashed" notification once the watcher catches up.
 * @param {string} processId
 * @param {object} options - { signal }
 */
export async function stopProcess(processId, options = {}) {
  const result = await stopPcProcess(processId, options);
  if (!result.success) return { success: false, data: null, error: result.error };

  if (result.data?.stopped) {
    await updateBackgroundProcessStatus(processId, 'killed', null);
  }
  return { success: true, data: result.data, error: null };
}
