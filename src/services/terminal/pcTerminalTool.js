/**
 * ZAO - VM Terminal Tool
 *
 * Runs REAL shell commands (npm install, pip install, Docker, video
 * processing, etc.) on the Alibaba Cloud VM - not a terminal-styled UI
 * widget, not a fake command interpreter.
 *
 * This is the ONLY terminal tool ZAO has - there is no on-device
 * fallback. If the VM backend is unreachable, terminal commands simply
 * can't run right now (see terminalRouter.js's checkTerminalStatus).
 *
 * ROLE: full terminal. Full system access to whatever's on the VM - the
 * VM backend (server/terminal.js) auto-detects which shell a given
 * command actually needs (bash, or a raw Python interpreter) and spawns
 * it there, so this tool doesn't hardcode one shell - Docker, AI
 * inference, video processing, multiple Python versions, unix-style
 * pipelines, all of it.
 *
 * SANDBOXING: by default, every command runs inside a real isolated
 * Docker container instead of directly on the host - actual
 * kernel-level filesystem/network isolation (see server/sandbox.js),
 * not just commandSafety.js's regex check below. The returned
 * `sandboxed` flag says whether isolation actually happened for that
 * specific command; anything needing real host access (Docker itself, a
 * system service) can't be sandboxed this way and always reports
 * sandboxed: false - pass hostAccess: true explicitly for anything that
 * needs the real VM rather than the sandbox silently failing closed.
 *
 * Sends the command over HTTP to the VM backend's /terminal/run route
 * (see server/terminal.js's chooseShell()), which auto-picks the shell,
 * runs the command there, and returns real stdout/stderr/exit code plus
 * which shell it used (shellUsed). The command runs on the VM
 * configured in Settings > Server Connection, using the bash/Python
 * versions installed there.
 */

import { runTerminalCommand } from '../backend/backendClient';
import { checkCommandSafety } from './commandSafety';
import { checkBeforeProjectRun } from '../execution/projectRunGate';

const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes - generous for npm/pip installs, still bounded

/**
 * Sends one shell command to the VM backend for real execution (via
 * bash or Python - see server/terminal.js's chooseShell()), waits for it
 * to finish (or time out), and returns its actual stdout/stderr/exit code.
 *
 * SAFETY, two independent layers:
 *   1. Real isolation (server/sandbox.js) - commands run inside an
 *      ephemeral, read-only, network-isolated Docker container whenever
 *      Docker is available and hostAccess isn't set, so even a command
 *      that gets past layer 2 below can't reach the real filesystem or
 *      network. This is the structural fix; the regex layer below is
 *      defense-in-depth on top of it, not instead of it.
 *   2. commandSafety.js - regex pattern-matching against the raw
 *      command string as a fast, cheap first check. Catastrophic
 *      commands (drive wipes, fork bombs) are refused outright.
 *      Irreversible-but-legitimate ones (rm -rf, git push --force, DROP
 *      TABLE...) are refused UNLESS options.confirmed is true - by
 *      design, nothing in the tool schema lets the model set that
 *      itself; it's meant to be set only by an explicit human
 *      confirmation step in the app.
 *
 * @param {string} command - a real shell command, e.g. "npm install" or "python3.11 script.py"
 * @param {object} options - { timeoutMs, workingDirectory, confirmed, shell, hostAccess, allowNetwork }
 * @param {boolean} [options.hostAccess] - skip the sandbox entirely and
 *   run directly on the host, even for commands that would otherwise be
 *   sandboxed. Needed for anything that has to touch real host state
 *   beyond the project folder - Docker itself, a system service.
 * @param {boolean} [options.allowNetwork] - lets a sandboxed command
 *   reach the network (the sandbox defaults to --network none). Not
 *   needed for npm/pip/git commands - the VM backend already recognizes
 *   those and turns network on automatically; only set this for
 *   anything else that genuinely needs outbound access (curl, a script
 *   hitting an API).
 * @returns {Promise<{success, data: {stdout, stderr, exitCode, shellUsed, sandboxed}|null, error}>}
 */
export async function runCommand(command, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, workingDirectory = null, confirmed = false, shell = null, hostAccess = false, allowNetwork = false } = options;

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
    hostAccess,
    allowNetwork,
  });

  if (!result.success) {
    return { success: false, data: null, error: result.error };
  }

  const { exitCode, timedOut, stdout, stderr, shellUsed, sandboxed } = result.data;

  if (timedOut) {
    return {
      success: false,
      data: { stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), exitCode, shellUsed, sandboxed },
      error: { message: `Command did not finish within ${Math.round(timeoutMs / 1000)}s and was killed.`, exitCode },
    };
  }

  const succeeded = exitCode === 0;

  // Real success/failure, with the actual output either way - a failing
  // command (missing dependency, wrong Python version, etc.) is reported
  // honestly with its real stderr, never hidden or reframed as a success.
  // shellUsed tells the model (and you, in logs) which of bash/python
  // actually ran it - useful when a
  // command fails because the auto-detected shell guessed wrong, so the
  // next attempt can pass an explicit `shell` override instead. sandboxed
  // tells the model (and you) whether this specific command actually got
  // real isolation or ran directly on the host.
  return {
    success: succeeded,
    data: { stdout: (stdout || '').trim(), stderr: (stderr || '').trim(), exitCode, shellUsed, sandboxed },
    error: succeeded ? null : { message: (stderr || '').trim() || `Command exited with code ${exitCode}`, exitCode },
  };
}
