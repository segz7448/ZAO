/**
 * ZAO Backend - Background Process Manager
 *
 * WHAT THIS FIXES: terminal.js's /terminal/run holds the HTTP request
 * open until the child process exits - fine for npm install or a build,
 * a dead end for anything meant to keep running (npm start, a dev
 * server, a long-lived watcher). Before this file existed, "run npm
 * start" was a 2-minute timeout waiting on a process that was never
 * going to exit on its own.
 *
 * This spawns the process detached from any single HTTP request and
 * hands back an id immediately. The app can then poll /process/:id/status,
 * tail /process/:id/logs, and kill it with /process/:id/stop whenever it
 * wants - the process itself keeps running on the PC in between.
 *
 * SHELL SELECTION: reuses terminal.js's chooseShell()/buildSpawnArgs so a
 * background command gets the same cmd/PowerShell/Git Bash/Python
 * auto-detection as a foreground one.
 *
 * NOT SANDBOXED: unlike /terminal/run, background processes always run
 * directly on the host, never through sandbox.js's Docker isolation.
 * Two reasons: (1) a dev server needs a stable port bound on the real
 * host network to be reachable at all - the sandbox's --network none
 * default (or even its bridge mode) works against that; (2) these are
 * long-lived by design, which is a different risk shape than sandbox.js
 * was built for (ephemeral, one-shot commands). Anything genuinely
 * dangerous is still caught by commandSafety.js on the app side before
 * it ever reaches this route.
 *
 * LOGS: stdout/stderr are captured into a bounded ring buffer per
 * process (MAX_LOG_LINES) so a chatty dev server can't grow memory
 * without bound - older lines are dropped silently, newest ones always
 * survive. Each line is tagged with a monotonically increasing index so
 * /process/:id/logs can be polled incrementally with `sinceIndex`
 * instead of re-fetching the whole buffer every time.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const crypto = require('crypto');
const { chooseShell } = require('./terminal');

const MAX_LOG_LINES = 2000;

/** @type {Map<string, ProcessRecord>} */
const processes = new Map();

/**
 * @typedef {Object} ProcessRecord
 * @property {string} id
 * @property {string} command
 * @property {string} shell
 * @property {string} cwd
 * @property {import('child_process').ChildProcess} child
 * @property {'running'|'exited'|'killed'|'error'} status
 * @property {number|null} exitCode
 * @property {string|null} signal
 * @property {number} startedAt
 * @property {number|null} finishedAt
 * @property {Array<{i:number, stream:'stdout'|'stderr', text:string}>} logs
 * @property {number} nextLogIndex
 */

function buildSpawnArgsForShell(shell, command, config) {
  switch (shell) {
    case 'powershell':
      return { bin: config.POWERSHELL_BIN, args: ['-NoProfile', '-NonInteractive', '-Command', command] };
    case 'gitbash':
      return { bin: config.GIT_BASH_PATH, args: ['-lc', command] };
    case 'python': {
      const match = command.match(/^\s*python[0-9.]*\s+-c\s+(["'])([\s\S]*)\1\s*$/);
      const code = match ? match[2] : command;
      return { bin: config.PYTHON_BIN, args: ['-c', code] };
    }
    case 'cmd':
    default:
      return { bin: 'cmd.exe', args: ['/d', '/s', '/c', command] };
  }
}

function appendLog(record, stream, chunk) {
  const text = chunk.toString();
  // Split on newlines so /process/:id/logs?tail=N counts actual lines,
  // not arbitrary chunk boundaries - a slow dev server flushing one
  // byte at a time shouldn't fragment into hundreds of "log lines".
  const lines = text.split(/\r?\n/).filter((l, idx, arr) => l.length > 0 || idx < arr.length - 1);
  for (const line of lines) {
    record.logs.push({ i: record.nextLogIndex++, stream, text: line });
  }
  while (record.logs.length > MAX_LOG_LINES) record.logs.shift();
}

/**
 * Starts a command as a tracked background process. Returns immediately
 * with an id - never waits for the process to exit.
 * @returns {{ id: string, shellUsed: string } | { error: string }}
 */
function startProcess({ command, cwd, shell: explicitShell, config, log }) {
  const shell = chooseShell(command, explicitShell, config);

  if (shell === 'gitbash' && !fs.existsSync(config.GIT_BASH_PATH)) {
    return { error: `Git Bash not found at "${config.GIT_BASH_PATH}". Set ZAO_GIT_BASH_PATH, or pass "shell": "cmd" to bypass auto-detection.` };
  }

  const { bin, args } = buildSpawnArgsForShell(shell, command, config);
  const id = crypto.randomUUID();

  const child = spawn(bin, args, {
    cwd: cwd || config.TERMINAL_CWD,
    windowsHide: true,
  });

  const record = {
    id,
    command,
    shell,
    cwd: cwd || config.TERMINAL_CWD,
    child,
    status: 'running',
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    finishedAt: null,
    logs: [],
    nextLogIndex: 0,
  };
  processes.set(id, record);

  child.stdout.on('data', (d) => appendLog(record, 'stdout', d));
  child.stderr.on('data', (d) => appendLog(record, 'stderr', d));

  child.on('error', (err) => {
    record.status = 'error';
    record.finishedAt = Date.now();
    appendLog(record, 'stderr', `[process error] ${err.message}\n`);
    log(`Background process [${id}] failed to start: ${err.message}`);
  });

  child.on('close', (code, signal) => {
    if (record.status === 'error') return; // already recorded via 'error' above
    record.exitCode = code;
    record.signal = signal || null;
    record.finishedAt = Date.now();
    record.status = signal && record.killRequested ? 'killed' : 'exited';
    log(`Background process [${id}] ${record.status} (shell=${shell}, code=${code}, signal=${signal || 'none'})`);
  });

  log(`Background process started [${id}] (shell=${shell}): ${command} (cwd=${record.cwd})`);
  return { id, shellUsed: shell };
}

function getProcess(id) {
  return processes.get(id) || null;
}

function getStatus(id) {
  const record = getProcess(id);
  if (!record) return null;
  return {
    id: record.id,
    command: record.command,
    shellUsed: record.shell,
    cwd: record.cwd,
    status: record.status,
    exitCode: record.exitCode,
    signal: record.signal,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
    pid: record.child.pid,
  };
}

/**
 * @param {string} id
 * @param {{ tail?: number, sinceIndex?: number }} options
 */
function getLogs(id, { tail, sinceIndex } = {}) {
  const record = getProcess(id);
  if (!record) return null;

  let lines = record.logs;
  if (typeof sinceIndex === 'number') {
    lines = lines.filter((l) => l.i > sinceIndex);
  } else if (typeof tail === 'number' && tail > 0) {
    lines = lines.slice(-tail);
  }

  return {
    id: record.id,
    status: record.status,
    lines,
    nextIndex: record.nextLogIndex - 1, // last index actually emitted so far
  };
}

/**
 * @param {string} id
 * @param {{ signal?: string }} options
 */
function stopProcess(id, { signal = 'SIGTERM' } = {}) {
  const record = getProcess(id);
  if (!record) return { error: 'No process found with that id.' };
  if (record.status !== 'running') {
    return { alreadyStopped: true, status: record.status };
  }
  record.killRequested = true;
  try {
    // On Windows, child_process signals other than SIGKILL are mapped to
    // an unconditional taskkill anyway - passing the requested signal
    // through is still correct on POSIX PCs running this same backend.
    record.child.kill(signal);
    return { stopped: true };
  } catch (err) {
    return { error: err.message };
  }
}

function listProcesses() {
  return Array.from(processes.values()).map((r) => getStatus(r.id));
}

function registerProcessRoutes(app, config, log) {
  app.post('/process/start', (req, res) => {
    const command = req.body?.command;
    if (!command || typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ error: { message: 'Missing "command" string in request body.' } });
    }
    const result = startProcess({
      command,
      cwd: req.body?.cwd,
      shell: req.body?.shell,
      config,
      log,
    });
    if (result.error) return res.status(500).json({ error: { message: result.error } });
    res.json(result);
  });

  app.get('/process/list', (req, res) => {
    res.json({ processes: listProcesses() });
  });

  app.get('/process/:id/status', (req, res) => {
    const status = getStatus(req.params.id);
    if (!status) return res.status(404).json({ error: { message: 'No process found with that id.' } });
    res.json(status);
  });

  app.get('/process/:id/logs', (req, res) => {
    const tail = req.query.tail ? Number(req.query.tail) : undefined;
    const sinceIndex = req.query.sinceIndex !== undefined ? Number(req.query.sinceIndex) : undefined;
    const result = getLogs(req.params.id, { tail, sinceIndex });
    if (!result) return res.status(404).json({ error: { message: 'No process found with that id.' } });
    res.json(result);
  });

  app.post('/process/:id/stop', (req, res) => {
    const result = stopProcess(req.params.id, { signal: req.body?.signal });
    if (result.error) return res.status(404).json({ error: { message: result.error } });
    res.json(result);
  });
}

module.exports = { registerProcessRoutes, startProcess, getStatus, getLogs, stopProcess, listProcesses };
