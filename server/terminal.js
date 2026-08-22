/**
 * ZAO Backend - Terminal route (Alibaba Cloud VM edition)
 *
 * The app POSTs the command it wants run to this server, and
 * this file picks a shell for it and spawns it on the VM itself.
 *
 * The VM is the full terminal, and the ONLY terminal ZAO has: bash and
 * Python are the two real options here - this is a Linux VM, so there's
 * no cmd.exe/PowerShell/Git Bash to route between anymore. chooseShell()
 * below auto-detects which one a command actually needs (a raw Python
 * snippet vs. everything else, which just runs through bash) so the
 * model doesn't have to think about shells at all - it just sends the
 * command it wants run, the way it would to a real Linux box. An
 * explicit `shell` field in the request body always overrides the
 * guess, for the rare case the model (or you) wants to pin one.
 *
 * SANDBOXING: every command runs inside a real, isolated Docker
 * container (see sandbox.js) whenever Docker is available and the
 * request hasn't set hostAccess: true - actual kernel-level filesystem/
 * network isolation, not just commandSafety.js's regex pattern-matching.
 * Every response reports `sandboxed: true/false` so the model/UI never
 * claims isolation that didn't actually happen.
 *
 * There is no on-device fallback terminal - if this VM backend is
 * unreachable, terminal commands simply cannot run right now (see
 * terminalRouter.js's checkTerminalStatus on the app side).
 */

const { spawn } = require('child_process');
const sandbox = require('./sandbox');

// ---------------------------------------------------------------------------
// Shell auto-detection
// ---------------------------------------------------------------------------

// A raw multi-line/quoted Python snippet meant to run directly (not
// `python script.py args`, which is just a normal PATH command bash can
// run as-is).
const PYTHON_SNIPPET_PATTERN = /^\s*python[0-9.]*\s+-c\s+["']/;

/**
 * Picks which shell a command needs, unless the caller already forced
 * one via the `shell` request field or config.TERMINAL_AUTO_SHELL is off.
 * @returns {'bash'|'python'}
 */
function chooseShell(command, explicitShell, config) {
  const valid = new Set(['bash', 'python']);
  if (explicitShell && valid.has(explicitShell)) return explicitShell;
  if (!config.TERMINAL_AUTO_SHELL) return config.TERMINAL_SHELL || 'bash';

  if (PYTHON_SNIPPET_PATTERN.test(command)) return 'python';
  return 'bash';
}

/**
 * Builds the spawn() args for a given shell + command.
 */
function buildSpawnArgs(shell, command, config) {
  switch (shell) {
    case 'python': {
      // Strip the leading `python -c "..."` wrapper if present and run
      // the snippet directly - avoids double-quoting the code through
      // an extra shell layer.
      const match = command.match(/^\s*python[0-9.]*\s+-c\s+(["'])([\s\S]*)\1\s*$/);
      const code = match ? match[2] : command;
      return { bin: config.PYTHON_BIN, args: ['-c', code] };
    }
    case 'bash':
    default:
      return { bin: '/bin/bash', args: ['-lc', command] };
  }
}

/**
 * POST /terminal/run
 * body: { command: string, cwd?: string, timeoutMs?: number, shell?: 'bash'|'python', hostAccess?: boolean, allowNetwork?: boolean }
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

    // ---- Try the sandbox first ----
    let sandboxed = false;
    let bin;
    let args;

    const sandboxEligible = !hostAccess && config.SANDBOX_ENABLED;
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
      const built = buildSpawnArgs(shell, command, config);
      bin = built.bin;
      args = built.args;
    }

    log(`Terminal request [${shell}${sandboxed ? ', sandboxed' : hostAccess ? ', hostAccess' : ', unsandboxed'}]: ${command} (cwd=${cwd})`);

    const child = spawn(bin, args, {
      cwd: sandboxed ? undefined : cwd, // the sandbox's cwd is set via docker's own -w flag instead
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
