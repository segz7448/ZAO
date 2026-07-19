/**
 * ZAO Backend - Terminal route (PC edition)
 *
 * Replaces the old phone-side Termux RUN_COMMAND Intent approach. The app
 * now just POSTs the command it wants run to this server, and this file
 * spawns it via `cmd.exe /c <command>` on the PC itself.
 *
 * Your different Python installs (python39, python311, etc.) work as-is
 * here since they're plain PATH commands - the model can call
 * `python311 script.py` etc. directly with no extra config needed.
 */

const { spawn } = require('child_process');

/**
 * POST /terminal/run
 * body: { command: string, cwd?: string, timeoutMs?: number }
 */
function registerTerminalRoute(app, config, log) {
  app.post('/terminal/run', (req, res) => {
    const command = req.body?.command;
    if (!command || typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ error: { message: 'Missing "command" string in request body.' } });
    }

    const cwd = req.body?.cwd || config.TERMINAL_CWD;
    const timeoutMs = Number(req.body?.timeoutMs) || config.TERMINAL_TIMEOUT_MS;

    log(`Terminal request: ${command} (cwd=${cwd})`);

    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
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
        res.status(500).json({ error: { message: `Failed to run command: ${err.message}` } });
      }
    });

    child.on('close', (code, signal) => {
      if (signal === 'SIGTERM') timedOut = true;
      log(`Terminal command exited (code=${code}, signal=${signal || 'none'})`);
      if (res.headersSent) return;
      res.json({
        exitCode: code,
        timedOut,
        stdout,
        stderr,
      });
    });
  });
}

module.exports = { registerTerminalRoute };
