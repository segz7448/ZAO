/**
 * ZAO Backend - Terminal route (PC edition)
 *
 * The app POSTs the command it wants run to this server, and
 * this file picks a shell for it and spawns it on the PC itself.
 *
 * PC is the full terminal, and the ONLY terminal ZAO has: cmd.exe,
 * PowerShell, Git Bash, and Python are all real options here, not just
 * cmd. chooseShell() below auto-detects which one a command actually
 * needs (PowerShell cmdlet syntax, unix/bash syntax, or a raw Python
 * snippet vs. a plain `python file.py` PATH call) so the model doesn't
 * have to think about shells at all - it just sends the command it wants
 * run, the way it would to a person's real PC. An explicit `shell` field
 * in the request body always overrides the guess, for the rare case the
 * model (or you) wants to pin one.
 *
 * SANDBOXING: gitbash/python commands run inside a real, isolated Docker
 * container (see sandbox.js) whenever Docker is available and the
 * request hasn't set hostAccess: true - actual kernel-level filesystem/
 * network isolation, not just commandSafety.js's regex pattern-matching.
 * cmd/powershell commands, and anything with hostAccess: true, still run
 * directly on the host (see sandbox.js's header for exactly why). Every
 * response reports `sandboxed: true/false` so the model/UI never claims
 * isolation that didn't actually happen.
 *
 * There is no on-device fallback terminal - if this PC backend is
 * unreachable, terminal commands simply cannot run right now (see
 * terminalRouter.js's checkTerminalStatus on the app side).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const sandbox = require('./sandbox');

// ---------------------------------------------------------------------------
// Shell auto-detection
// ---------------------------------------------------------------------------

// PowerShell-only syntax: cmdlets (Verb-Noun), $env:/$PSVersionTable,
// object pipelines (Select-Object, Where-Object, ForEach-Object), or an
// explicit "powershell"/"pwsh" invocation.
const POWERSHELL_PATTERN = /(^|\s)(pwsh|powershell)(\.exe)?(\s|$)|\b[A-Z][a-zA-Z]*-[A-Z][a-zA-Z]*\b|\$env:|\$PSVersionTable|\bSelect-Object\b|\bWhere-Object\b|\bForEach-Object\b/;

// Bash/unix-only syntax that cmd.exe simply can't run: command
// substitution, unix env-var export, a leading ./script, chmod/chown,
// unix pipes into grep/sed/awk, heredocs, or an explicit bash/sh call.
const GITBASH_PATTERN = /\$\([^)]*\)|`[^`]*`|^\s*export\s+\w+=|^\s*\.\/|^\s*chmod\b|^\s*chown\b|\|\s*(grep|sed|awk|xargs)\b|<<['"]?\w+['"]?|(^|\s)(bash|sh)(\s|$)/;

// A raw multi-line/quoted Python snippet meant to run directly (not
// `python script.py args`, which is just a normal PATH command any
// shell can run as-is).
const PYTHON_SNIPPET_PATTERN = /^\s*python[0-9.]*\s+-c\s+["']/;

/**
 * Picks which shell a command needs, unless the caller already forced
 * one via the `shell` request field or config.TERMINAL_AUTO_SHELL is off.
 * @returns {'cmd'|'powershell'|'gitbash'|'python'}
 */
function chooseShell(command, explicitShell, config) {
  const valid = new Set(['cmd', 'powershell', 'gitbash', 'python']);
  if (explicitShell && valid.has(explicitShell)) return explicitShell;
  if (!config.TERMINAL_AUTO_SHELL) return config.TERMINAL_SHELL || 'cmd';

  if (PYTHON_SNIPPET_PATTERN.test(command)) return 'python';
  if (GITBASH_PATTERN.test(command)) return 'gitbash';
  if (POWERSHELL_PATTERN.test(command)) return 'powershell';
  return 'cmd';
}

/**
 * Builds the spawn() args for a given shell + command.
 */
function buildSpawnArgs(shell, command, config) {
  switch (shell) {
    case 'powershell':
      return { bin: config.POWERSHELL_BIN, args: ['-NoProfile', '-NonInteractive', '-Command', command] };
    case 'gitbash':
      return { bin: config.GIT_BASH_PATH, args: ['-lc', command] };
    case 'python': {
      // Strip the leading `python -c "..."` wrapper if present and run
      // the snippet directly - avoids double-quoting the code through
      // an extra shell layer.
      const match = command.match(/^\s*python[0-9.]*\s+-c\s+(["'])([\s\S]*)\1\s*$/);
      const code = match ? match[2] : command;
      return { bin: config.PYTHON_BIN, args: ['-c', code] };
    }
    case 'cmd':
    default:
      return { bin: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
}

/**
 * POST /terminal/run
 * body: { command: string, cwd?: string, timeoutMs?: number, shell?: 'cmd'|'powershell'|'gitbash'|'python', hostAccess?: boolean, allowNetwork?: boolean }
 */
function registerTerminalRoute(app, config, log) {
  app.post('/terminal/run', async (req, res) => {
    const command = req.body?.command;
    if (!command || typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ error: { message: 'Missing "command" string in request body.' } });
    }

    const cwd = req.body?.cwd || config.TERMINAL_CWD;
    const timeoutMs = Number(req.body?.timeoutMs) || config.TERMINAL_TIMEOUT_MS;
    const hostAccess = req.body?.hostAccess === true;

    const shell = chooseShell(command, req.body?.shell, config);

    // ---- Try the sandbox first (gitbash/python only - see sandbox.js's
    // header for why cmd/powershell can't go through Docker) ----
    let sandboxed = false;
    let bin;
    let args;

    const sandboxEligible = !hostAccess && config.SANDBOX_ENABLED && (shell === 'gitbash' || shell === 'python');
    if (sandboxEligible && await sandbox.isDockerAvailable()) {
      const imageReady = await sandbox.ensureSandboxImage(log);
      if (imageReady) {
        const allowNetwork = req.body?.allowNetwork === true || sandbox.commandLikelyNeedsNetwork(command);
        const built = sandbox.buildSandboxedSpawnArgs(shell, command, {
          cwd,
          allowNetwork,
          memoryLimit: config.SANDBOX_MEMORY_LIMIT,
          cpuLimit: config.SANDBOX_CPU_LIMIT,
          pidsLimit: config.SANDBOX_PIDS_LIMIT,
        });
        bin = built.bin;
        args = built.args;
        sandboxed = true;
      }
    }

    if (!sandboxed) {
      if (shell === 'gitbash' && !fs.existsSync(config.GIT_BASH_PATH)) {
        return res.status(500).json({
          error: { message: `Git Bash not found at "${config.GIT_BASH_PATH}". Set ZAO_GIT_BASH_PATH to your actual bash.exe location, or pass "shell": "cmd" to bypass auto-detection for this command.` },
        });
      }
      const built = buildSpawnArgs(shell, command, config);
      bin = built.bin;
      args = built.args;
    }

    log(`Terminal request [${shell}${sandboxed ? ', sandboxed' : hostAccess ? ', hostAccess' : ', unsandboxed'}]: ${command} (cwd=${cwd})`);

    const child = spawn(bin, args, {
      cwd: sandboxed ? undefined : cwd, // the sandbox's cwd is set via docker's own -w flag instead
      windowsHide: true,
      timeout: timeoutMs,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    child.on('error', (err) => {
      log('Terminal spawn error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: `Failed to run command via ${shell}: ${err.message}` } });
      }
    });

    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM') timedOut = true;
      log(`Terminal command exited (shell=${shell}, sandboxed=${sandboxed}, code=${code}, signal=${signal || 'none'})`);
      if (res.headersSent) return;
      res.json({
        exitCode: code,
        timedOut,
        stdout,
        stderr,
        shellUsed: shell,
        sandboxed,
      });
    });
  });
}

module.exports = { registerTerminalRoute, chooseShell };
