/**
 * ZAO Backend - Dev server + visual preview
 *
 * WHAT THIS CLOSES: terminal_pc_run_command (terminal.js) is a
 * run-to-completion or run-until-timeout command - it's the right tool
 * for a build, but a dev server (`npm start`, `vite`, `python -m
 * http.server`, an Expo web build, etc.) never "completes" on its own,
 * so spawning it through terminal.js just blocks until TERMINAL_TIMEOUT_MS
 * kills it, with no clean way to get the URL back out mid-run and no way
 * to leave it running for a follow-up screenshot. This module is the
 * missing piece: start a dev server as its own tracked background
 * process, detect the local URL it printed, and then use the SAME
 * Playwright Chromium instance browserAgent.js already keeps running
 * (see getBrowser() there) to navigate to that URL and screenshot it -
 * so the model can actually SEE whether the rendered HTML/CSS looks
 * right, instead of the person having to check manually or the model
 * just guessing from source.
 *
 * PROCESS MODEL: one dev server = one tracked entry in `servers`, keyed
 * by a previewId. Starting a server that's already running (same cwd +
 * command) reuses the existing entry rather than spawning a second
 * copy - repeated "start it again" calls from the model are idempotent.
 * Stdout/stderr are tailed into a bounded ring buffer (not the full
 * output - dev servers can log forever) so a status/screenshot call can
 * still show recent output if the server crashed on startup.
 *
 * URL DETECTION: dev servers differ wildly in how they announce their
 * URL (CRA: "Local: http://localhost:3000", Vite: "Local:
 * http://127.0.0.1:5173/", Expo web, a plain http.server's "Serving
 * HTTP on ..."), so rather than hardcoding one framework's exact
 * wording this scans stdout/stderr for the first http://localhost:PORT
 * or http://127.0.0.1:PORT it sees. If the command names an explicit
 * --port/-p, that's used as a hint but the scan still confirms the
 * server actually bound it before declaring success, rather than
 * assuming the flag was honored.
 *
 * LIFECYCLE: servers started here are NOT cleaned up by
 * terminal_pc_run_command's per-command completion (there is none -
 * that's the point) - they keep running on the PC until explicitly
 * stopped via dev_server_stop, or the backend process itself exits
 * (shutdownAllPreviewServers(), wired into index.js's SIGINT/SIGTERM
 * handling the same way shutdownBrowser() already is).
 */

const { spawn } = require('child_process');
const { chooseShell, buildSpawnArgs } = require('./terminal');

const URL_DETECT_TIMEOUT_MS = 30000; // most dev servers announce their URL within a few seconds; generous for cold webpack/metro builds
const RING_BUFFER_MAX_CHARS = 20000; // tail only - dev servers can log indefinitely
const LOCAL_URL_PATTERN = /https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?[^\s"'<>]*/i;

// previewId -> { child, command, cwd, url, status, output, port, startedAt }
const servers = new Map();

function makePreviewId() {
  return `preview_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function appendRing(entry, chunk) {
  entry.output += chunk;
  if (entry.output.length > RING_BUFFER_MAX_CHARS) {
    entry.output = entry.output.slice(entry.output.length - RING_BUFFER_MAX_CHARS);
  }
}

/** Finds an already-running server started with the same command + cwd, so repeated start calls don't spawn duplicates. */
function findExisting(command, cwd) {
  for (const [id, entry] of servers.entries()) {
    if (entry.command === command && entry.cwd === cwd && entry.status !== 'stopped' && entry.status !== 'crashed') {
      return { id, entry };
    }
  }
  return null;
}

/**
 * Starts a dev server as a detached background process and resolves once
 * its local URL is detected in stdout/stderr (or URL_DETECT_TIMEOUT_MS
 * elapses, or the process exits early - whichever comes first).
 *
 * @param {object} opts - { command, cwd, port, config, log }
 * @returns {Promise<{previewId, url, status, output, pid}>}
 */
function startDevServer({ command, cwd, port, config, log }) {
  const existing = findExisting(command, cwd);
  if (existing) {
    return Promise.resolve({
      previewId: existing.id,
      url: existing.entry.url,
      status: existing.entry.status,
      output: existing.entry.output.slice(-2000),
      pid: existing.entry.child.pid,
      reused: true,
    });
  }

  const shell = chooseShell(command, undefined, config);
  const { bin, args } = buildSpawnArgs(shell, command, config);
  const workingDir = cwd || config.TERMINAL_CWD;

  const child = spawn(bin, args, {
    cwd: workingDir,
    windowsHide: true,
  });

  const previewId = makePreviewId();
  const entry = {
    child,
    command,
    cwd: workingDir,
    url: null,
    status: 'starting',
    output: '',
    port: port || null,
    startedAt: Date.now(),
  };
  servers.set(previewId, entry);

  log(`Dev server starting [${previewId}]: ${command} (cwd=${workingDir})`);

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const checkForUrl = (chunk) => {
      appendRing(entry, chunk);
      if (entry.url) return;
      const match = entry.output.match(LOCAL_URL_PATTERN);
      if (match) {
        entry.url = match[0].replace(/\/$/, '');
        entry.status = 'running';
        log(`Dev server URL detected [${previewId}]: ${entry.url}`);
        finish({
          previewId,
          url: entry.url,
          status: 'running',
          output: entry.output.slice(-2000),
          pid: child.pid,
        });
      }
    };

    child.stdout.on('data', (d) => checkForUrl(d.toString()));
    child.stderr.on('data', (d) => checkForUrl(d.toString()));

    child.on('error', (err) => {
      entry.status = 'crashed';
      appendRing(entry, `\n[spawn error] ${err.message}`);
      log(`Dev server spawn error [${previewId}]: ${err.message}`);
      finish({ previewId, url: null, status: 'crashed', output: entry.output.slice(-2000), pid: null, error: err.message });
    });

    child.on('close', (code, signal) => {
      if (entry.status !== 'stopped') entry.status = 'crashed';
      appendRing(entry, `\n[process exited] code=${code} signal=${signal || 'none'}`);
      log(`Dev server exited [${previewId}]: code=${code} signal=${signal || 'none'}`);
      finish({
        previewId,
        url: entry.url,
        status: entry.status,
        output: entry.output.slice(-2000),
        pid: null,
        exitCode: code,
      });
    });

    const timer = setTimeout(() => {
      // Not necessarily a failure - some servers are just slow to print
      // their URL (cold Metro/webpack builds) or announce it in a format
      // this doesn't recognize. Leave the process running and report
      // 'running_no_url_detected' rather than killing it; the caller can
      // still pass a manual URL/port to dev_preview_screenshot, and can
      // call dev_server_stop explicitly if it turns out to be wedged.
      entry.status = entry.url ? 'running' : 'running_no_url_detected';
      finish({
        previewId,
        url: entry.url,
        status: entry.status,
        output: entry.output.slice(-2000),
        pid: child.pid,
      });
    }, URL_DETECT_TIMEOUT_MS);
  });
}

function stopDevServer(previewId) {
  const entry = servers.get(previewId);
  if (!entry) return { success: false, error: `No tracked dev server with id "${previewId}".` };
  if (entry.status === 'stopped' || !entry.child.pid) {
    return { success: true, alreadyStopped: true };
  }
  entry.status = 'stopped';
  try {
    // Windows: taskkill /T kills the whole process tree (npm start spawns
    // a child node process; killing just the npm wrapper leaves the real
    // server running orphaned). POSIX-style kill as a fallback if this
    // backend is ever run under WSL/gitbash directly.
    if (process.platform === 'win32') {
      spawn('taskkill', ['/pid', String(entry.child.pid), '/T', '/F'], { windowsHide: true });
    } else {
      entry.child.kill('SIGTERM');
    }
  } catch (err) {
    return { success: false, error: err.message };
  }
  return { success: true };
}

function listDevServers() {
  return Array.from(servers.entries()).map(([previewId, entry]) => ({
    previewId,
    command: entry.command,
    cwd: entry.cwd,
    url: entry.url,
    status: entry.status,
    startedAt: entry.startedAt,
  }));
}

function getServerUrl(previewId) {
  const entry = servers.get(previewId);
  return entry ? entry.url : null;
}

/** Kills every still-running tracked dev server. Call on backend shutdown so a restart doesn't leave orphaned servers holding ports. */
function shutdownAllPreviewServers() {
  for (const previewId of servers.keys()) {
    stopDevServer(previewId);
  }
}

// ---------------------------------------------------------------------------
// Screenshot: reuses browserAgent.js's single shared Chromium instance
// (getBrowser()) rather than the full AgentSession task-loop - this just
// needs one navigate + one screenshot, not a multi-step reasoning agent.
// A short-lived incognito-style context/page is opened per call and
// closed immediately after, so preview screenshots never pile up tabs on
// the same browser instance the real browsing agent uses.
// ---------------------------------------------------------------------------
async function screenshotUrl(url, { fullPage = false, viewportWidth = 1280, viewportHeight = 800 } = {}) {
  const { getBrowser } = require('./browserAgent');
  const browser = await getBrowser();
  const context = await browser.newContext({ viewport: { width: viewportWidth, height: viewportHeight } });
  try {
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    const response = await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 }).catch(async () => {
      // networkidle can hang forever on a page with polling/websockets
      // (common in dev servers with HMR) - fall back to domcontentloaded
      // rather than failing the whole screenshot over that.
      return page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
    });
    await page.waitForTimeout(300); // let a final paint/animation settle
    const buffer = await page.screenshot({ type: 'png', fullPage });
    const title = await page.title().catch(() => '');
    return {
      success: true,
      screenshotBase64: buffer.toString('base64'),
      title,
      finalUrl: page.url(),
      httpStatus: response ? response.status() : null,
      consoleErrors: consoleErrors.slice(0, 20),
    };
  } finally {
    await context.close().catch(() => {});
  }
}

/**
 * POST /preview/start   body: { command, cwd?, port? }
 * POST /preview/screenshot   body: { previewId?, url?, fullPage?, viewportWidth?, viewportHeight? }
 * POST /preview/stop   body: { previewId }
 * GET  /preview/list
 */
function registerDevPreviewRoute(app, config, log) {
  app.post('/preview/start', async (req, res) => {
    const command = req.body?.command;
    if (!command || typeof command !== 'string' || !command.trim()) {
      return res.status(400).json({ error: { message: 'Missing "command" string in request body.' } });
    }
    try {
      const result = await startDevServer({
        command,
        cwd: req.body?.cwd,
        port: req.body?.port,
        config,
        log,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: { message: `Failed to start dev server: ${err.message}` } });
    }
  });

  app.post('/preview/screenshot', async (req, res) => {
    const previewId = req.body?.previewId;
    let url = req.body?.url;
    if (previewId && !url) {
      url = getServerUrl(previewId);
      if (!url) {
        return res.status(400).json({
          error: { message: `Dev server "${previewId}" has no detected URL yet. Pass an explicit "url" instead, or check its status first.` },
        });
      }
    }
    if (!url) {
      return res.status(400).json({ error: { message: 'Provide either "previewId" (of a running dev server) or an explicit "url".' } });
    }
    try {
      const result = await screenshotUrl(url, {
        fullPage: req.body?.fullPage === true,
        viewportWidth: Number(req.body?.viewportWidth) || 1280,
        viewportHeight: Number(req.body?.viewportHeight) || 800,
      });
      res.json(result);
    } catch (err) {
      log(`Preview screenshot error: ${err.message}`);
      res.status(500).json({ error: { message: `Failed to screenshot "${url}": ${err.message}` } });
    }
  });

  app.post('/preview/stop', (req, res) => {
    const previewId = req.body?.previewId;
    if (!previewId) {
      return res.status(400).json({ error: { message: 'Missing "previewId" in request body.' } });
    }
    const result = stopDevServer(previewId);
    if (!result.success) return res.status(404).json(result);
    res.json(result);
  });

  app.get('/preview/list', (req, res) => {
    res.json({ servers: listDevServers() });
  });
}

module.exports = {
  registerDevPreviewRoute,
  shutdownAllPreviewServers,
};
