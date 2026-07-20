/**
 * ZAO Backend - Terminal route (PC edition)
 *
 * Replaces the old phone-side Termux RUN_COMMAND Intent approach for
 * heavy work. The app POSTs the command it wants run to this server, and
 * this file picks a shell for it and spawns it on the PC itself.
 *
 * PC is the full terminal: cmd.exe, PowerShell, Git Bash, and Python are
 * all real options here, not just cmd. chooseShell() below auto-detects
 * which one a command actually needs (PowerShell cmdlet syntax, unix/bash
 * syntax, or a raw Python snippet vs. a plain `python file.py` PATH
 * call) so the model doesn't have to think about shells at all - it just
 * sends the command it wants run, the way it would to a person's real PC.
 * An explicit `shell` field in the request body always overrides the
 * guess, for the rare case the model (or you) wants to pin one.
 *
 * Termux (see src/services/terminal/termuxTerminalTool.js) is the
 * fallback - only used when this PC backend is unreachable, or reachable
 * but the PC itself has no internet for an internet-dependent command
 * (see terminalRouter.js). It is not a second "lightweight tasks" tier
 * anymore; when the PC is up and online, everything runs here.
 */

const { spawn } = require('child_process');
const fs = require('fs');

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
 * body: { command: string, cwd?: string, timeoutMs?: number, shell?: 'cmd'|'powershell'|'gitbash'|'python' }
 */
function registerTerminalRoute(app, config, log) {
  app.post('/terminal/run', (req, res) => {
    const command = req.body?.command;
    if (!command || typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ error: { message: 'Missing "command" string in request body.' } });
    }

    const cwd = req.body?.cwd || config.TERMINAL_CWD;
    const timeoutMs = Number(req.body?.timeoutMs) || config.TERMINAL_TIMEOUT_MS;

    const shell = chooseShell(command, req.body?.shell, config);
    const { bin, args } = buildSpawnArgs(shell, command, config);

    if (shell === 'gitbash' && !fs.existsSync(bin)) {
      return res.status(500).json({
        error: { message: `Git Bash not found at "${bin}". Set ZAO_GIT_BASH_PATH to your actual bash.exe location, or pass "shell": "cmd" to bypass auto-detection for this command.` },
      });
    }

    log(`Terminal request [${shell}]: ${command} (cwd=${cwd})`);

    const child = spawn(bin, args, {
      cwd,
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
      log(`Terminal command exited (shell=${shell}, code=${code}, signal=${signal || 'none'})`);
      if (res.headersSent) return;
      res.json({
        exitCode: code,
        timedOut,
        stdout,
        stderr,
        shellUsed: shell,
      });
    });
  });
}

module.exports = { registerTerminalRoute, chooseShell };
