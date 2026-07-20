/**
 * ZAO - PC Terminal Tool
 *
 * Runs REAL shell commands (npm install, pip install, gradlew
 * assembleRelease, APK builds, Docker, Visual Studio builds, etc.) on the
 * person's PC - not a terminal-styled UI widget, not a fake command
 * interpreter.
 *
 * This is one of TWO terminal tools ZAO has - see also
 * termuxTerminalTool.js, which runs commands directly on the phone via
 * Termux instead, but ONLY as a fallback (see terminalRouter.js) - this
 * tool is the default/primary/full terminal.
 *
 * ROLE: full terminal. Full system access to whatever's on the PC - the
 * PC backend (server/terminal.js) auto-detects which shell a given
 * command actually needs (cmd.exe, powershell.exe, Git Bash, or a raw
 * Python interpreter) and spawns it there, so this tool doesn't hardcode
 * one shell - Docker, Android emulator, AI inference, video processing,
 * multiple Python versions, unix-style pipelines, PowerShell cmdlets, all
 * of it. See terminalRouter.js for how the model falls back to Termux
 * only when this is unreachable or the PC itself has no internet access.
 *
 * Sends the command over HTTP to the PC backend's /terminal/run route
 * (see server/terminal.js's chooseShell()), which auto-picks the shell,
 * runs the command there, and returns real stdout/stderr/exit code plus
 * which shell it used (shellUsed). No Termux install, no RUN_COMMAND
 * permission dance, no native module needed for this path - the PC
 * backend runs the command synchronously and hands back the result in one
 * HTTP response. The trade-off is the command runs on whichever PC is
 * configured in Settings > Backend Connection, using the shells/Python
 * versions installed there, not whatever's on the phone.
 */

import { runTerminalCommand } from '../backend/backendClient';
import { checkCommandSafety } from './commandSafety';
import { checkBeforeProjectRun } from '../execution/projectRunGate';

const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes - generous for npm/pip installs, still bounded

/**
 * Sends one shell command to the PC backend for real execution (via
 * cmd.exe), waits for it to finish (or time out), and returns its actual
 * stdout/stderr/exit code.
 *
 * SAFETY GATE: every command passes through commandSafety.js first.
 * Catastrophic commands (drive wipes, fork bombs) are refused outright.
 * Irreversible-but-legitimate ones (rm -rf, git push --force, DROP
 * TABLE...) are refused UNLESS options.confirmed is true - by design,
 * nothing in the tool schema lets the model set that itself; it's meant
 * to be set only by an explicit human confirmation step in the app (not
 * yet wired to a UI - see SYSTEM_COMPONENTS.md's human-in-the-loop
 * section). Until that UI exists, this means risky commands correctly
 * fail with a clear reason rather than running unattended - a stricter
 * default than "runs, no questions asked."
 *
 * @param {string} command - a real shell command, e.g. "npm install" or "python311 script.py"
 * @param {object} options - { timeoutMs, workingDirectory, confirmed }
 * @returns {Promise<{success, data: {stdout, stderr, exitCode}|null, error}>}
 */
export async function runCommand(command, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, workingDirectory = null, confirmed = false, shell = null } = options;

  const safety = checkCommandSafety(command);
  if (safety.blocked) {
    return { success: false, data: null, error: { message: safety.reason, blocked: true } };
  }
  if (safety.risky && !confirmed) {
    return { success: false, data: null, error: { message: safety.reason, needsConfirmation: true } };
  }

  // SYNTAX / JSX CHECK GATE - see projectRunGate.js. Only fires for
  // commands that actually start/build/serve a project (npm start,
  // expo start, etc.); everything else passes through untouched. No
  // `confirmed` override here, unlike the RISKY tier above - a broken
  // project can't be made to run by confirming harder.
  const runGate = await checkBeforeProjectRun(command);
  if (runGate.blocked) {
    return { success: false, data: null, error: { message: runGate.reason, syntaxBlocked: true, failures: runGate.failures } };
  }

  const result = await runTerminalCommand(command, {
    cwd: workingDirectory || undefined,
    timeoutMs,
    shell: shell || undefined,
  });

  if (!result.success) {
    return { success: false, data: null, error: result.error };
  }

  const { exitCode, timedOut, stdout, stderr, shellUsed } = result.data;

  if (timedOut) {
    return {
      success: false,
      data: { stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), exitCode, shellUsed },
      error: { message: `Command did not finish within ${Math.round(timeoutMs / 1000)}s and was killed.`, exitCode },
    };
  }

  const succeeded = exitCode === 0;

  // Real success/failure, with the actual output either way - a failing
  // command (missing dependency, wrong Python version, etc.) is reported
  // honestly with its real stderr, never hidden or reframed as a success.
  // shellUsed tells the model (and you, in logs) which of
  // cmd/powershell/gitbash/python actually ran it - useful when a
  // command fails because the auto-detected shell guessed wrong, so the
  // next attempt can pass an explicit `shell` override instead.
  return {
    success: succeeded,
    data: { stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), exitCode, shellUsed },
    error: succeeded ? null : { message: (stderr || '').trim() || `Command exited with code ${exitCode}`, exitCode },
  };
}
