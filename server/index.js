#!/usr/bin/env node
/**
 * ZAO Backend - PC (Windows) edition
 *
 * Single-model, single-user. Wraps llama.cpp's `llama-server` (started as a
 * child process) with a small Express layer that:
 *   - Spawns/monitors llama-server on startup, restarts it if it dies
 *   - Exposes /v1/chat/completions (proxies straight to llama-server, same
 *     OpenAI-compatible shape the app already expects)
 *   - Exposes /health so the app can check the backend is up, both over
 *     LAN and through the Cloudflare tunnel - also reports whether THIS PC
 *     currently has internet access (internetAvailable), so the app can
 *     tell the person plainly when an internet-dependent terminal command
 *     (npm/pip install, git pull/clone/push, curl, downloads) will fail,
 *     even though the PC backend itself is perfectly reachable
 *   - Exposes /terminal/run so the app's Terminal tool can run cmd
 *     commands on this PC (see terminal.js)
 *   - Exposes /process/start, /process/:id/status, /process/:id/logs,
 *     and /process/:id/stop so the app can run long-lived commands (dev
 *     servers, watchers) in the background instead of blocking a single
 *     HTTP request on a process that's never meant to exit (see
 *     processManager.js)
 *   - Exposes /ocr/extract for scanned/image-based PDFs and plain images -
 *     runs free, open-source OCR (Tesseract via pytesseract + PyMuPDF) in
 *     a Python subprocess on this PC (see ocr.js)
 *   - Exposes a WebSocket at /browser-agent/stream for the autonomous
 *     Playwright browser agent (see browserAgent.js, browserStream.js) -
 *     live screenshot streaming to the phone plus two-way manual control
 *     (tap/type) for CAPTCHAs and similar human-intervention cases
 *   - Exposes /preview/start, /preview/screenshot, /preview/stop, and
 *     /preview/list (see devPreview.js) so a dev server (npm start, vite,
 *     etc.) can be started as a tracked background process, its local
 *     URL detected automatically, and the rendered page screenshotted via
 *     the same shared Playwright Chromium instance browserAgent.js uses -
 *     closes the loop on "does this HTML/CSS actually render right"
 *     without the person checking manually
 *   - Requires an Authorization: Bearer <token> header on every request
 *     except /health, since this is now reachable over LAN and the public
 *     internet (via Cloudflare Quick Tunnel), not just 127.0.0.1
 *
 * Run with: start.bat (double-click, or run from cmd/PowerShell/Git Bash)
 *
 * Config is entirely in config.js - edit MODEL_DIR there (or set the
 * ZAO_MODEL_DIR env var) if your model/binary aren't in
 * C:\Users\User\Downloads\Model.
 */

const express = require('express');
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const { registerTerminalRoute } = require('./terminal');
const { registerProcessRoutes } = require('./processManager');
const { registerOcrRoute } = require('./ocr');
const { registerWebSearchRoute } = require('./webSearch');
const { registerWebFetchRoute } = require('./webFetch');
const { registerSessionRoutes } = require('./backgroundSessions');
const { registerDataRoute } = require('./data');
const { registerPcFilesRoute } = require('./pcFiles');
const { registerPcZipRoute } = require('./pcZip');
const { registerPcGitRoute } = require('./pcGit');
const { registerBrowserAgentStream } = require('./browserStream');
const { shutdownBrowser } = require('./browserAgent');
const { registerDevPreviewRoute, shutdownAllPreviewServers } = require('./devPreview');

const app = express();
app.use(express.json({ limit: '25mb' }));

// ---------------------------------------------------------------------------
// CORS - the phone app is a different origin (Expo/React Native fetch from
// the device), so allow it through. Locked down to just what's needed.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// Auth - every route except /health requires the shared-secret token.
// Required now that this server is bound to 0.0.0.0 and reachable over LAN
// and the public Cloudflare tunnel, not just loopback like the old Termux
// version.
// ---------------------------------------------------------------------------
app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token || token !== config.AUTH_TOKEN) {
    return res.status(401).json({ error: { message: 'Missing or invalid Authorization token.' } });
  }
  next();
});

// ---------------------------------------------------------------------------
// Rate limiting - crude but real. This server is single-user by design (one
// phone, one token), so the goal isn't fairness between users, it's putting
// a ceiling on how fast a leaked/guessed token (or a bug in the app causing
// a retry storm) can hammer this machine or the model. In-memory sliding
// window, no extra dependency - restarts reset it, which is fine for a
// single-PC personal backend.
// ---------------------------------------------------------------------------
const RATE_LIMIT_WINDOW_MS = 60000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 120; // generous for normal chat/tool use, well below abuse territory
const requestLog = new Map(); // ip -> array of request timestamps

app.use((req, res, next) => {
  if (req.path === '/health') return next();
  const ip = req.ip || req.connection?.remoteAddress || 'unknown';
  const now = Date.now();
  const timestamps = (requestLog.get(ip) || []).filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
  timestamps.push(now);
  requestLog.set(ip, timestamps);

  if (timestamps.length > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({ error: { message: 'Too many requests - slow down and try again shortly.' } });
  }
  next();
});

// Periodic cleanup so requestLog doesn't grow forever if lots of distinct
// IPs ever hit this (unlikely for a single-user LAN/tunnel backend, but
// free to guard against).
setInterval(() => {
  const now = Date.now();
  for (const [ip, timestamps] of requestLog.entries()) {
    const fresh = timestamps.filter((t) => now - t < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) requestLog.delete(ip);
    else requestLog.set(ip, fresh);
  }
}, RATE_LIMIT_WINDOW_MS).unref();

function log(...args) {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  console.log(`[${ts}]`, ...args);
}

// ---------------------------------------------------------------------------
// Internet connectivity self-check
//
// The phone can tell whether IT can reach this PC (that's what /health's
// caller already knows just by getting a response at all), but it has no
// way to know whether THIS PC's own internet connection is up - e.g. the
// PC is on, ZAO backend is running, phone can reach it fine over LAN, but
// the PC's WiFi/ISP is down. That distinction matters because tasks
// needing internet (npm install, pip install, git pull, downloads) will
// fail on this PC even though the PC backend itself is perfectly
// reachable - the app surfaces this as a clear "no internet on the PC"
// message rather than a confusing command failure (see
// terminalRouter.js's checkTerminalStatus - there's no fallback terminal
// to route to instead, so this is purely informational for the model).
//
// Checked periodically in the background (not on every single /health
// poll - that would mean an outbound request every time the app checks
// status, which is wasteful and adds latency to /health). Cached result is
// served instantly; the check itself runs on its own timer.
// ---------------------------------------------------------------------------
let internetAvailable = null; // null = not checked yet
const INTERNET_CHECK_INTERVAL_MS = 15000; // 15s - frequent enough to catch a dropped connection quickly, cheap enough not to matter
const INTERNET_CHECK_TIMEOUT_MS = 3000;
const INTERNET_CHECK_HOSTS = ['1.1.1.1', '8.8.8.8']; // Cloudflare + Google DNS - fast, extremely reliable uptime, no auth/redirects to worry about

function checkOneHost(host) {
  return new Promise((resolve) => {
    const req = http.get({ host, port: 80, path: '/', timeout: INTERNET_CHECK_TIMEOUT_MS }, (res) => {
      res.destroy(); // don't need the body - a response at all means connectivity is up
      resolve(true);
    });
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

async function refreshInternetStatus() {
  // Try hosts in sequence, not parallel - the first success is enough to
  // confirm connectivity, and sequential avoids firing multiple outbound
  // requests on every check when the first one usually just works.
  for (const host of INTERNET_CHECK_HOSTS) {
    const ok = await checkOneHost(host);
    if (ok) {
      if (internetAvailable !== true) log('Internet connectivity: UP');
      internetAvailable = true;
      return;
    }
  }
  if (internetAvailable !== false) log('Internet connectivity: DOWN (both check hosts unreachable)');
  internetAvailable = false;
}

// ---------------------------------------------------------------------------
// Startup sanity checks - fail loudly and clearly rather than a cryptic
// spawn ENOENT if paths in config.js are wrong.
// ---------------------------------------------------------------------------
function checkPathsOrExit() {
  const problems = [];
  if (!fs.existsSync(config.LLAMA_SERVER_BIN)) {
    problems.push(`llama-server.exe not found at: ${config.LLAMA_SERVER_BIN}`);
  }
  if (!fs.existsSync(config.MODEL_PATH)) {
    problems.push(`Model GGUF not found at: ${config.MODEL_PATH}`);
  }
  if (config.AUTH_TOKEN === 'change-me-to-a-real-secret') {
    log('WARNING: AUTH_TOKEN is still the default placeholder. Set ZAO_AUTH_TOKEN (or edit config.js) to a real secret before exposing this over the Cloudflare tunnel.');
  }
  if (problems.length) {
    log('Cannot start - fix these paths in config.js (or the matching env vars) first:');
    problems.forEach((p) => log('  - ' + p));
    process.exit(1);
  }
}

// ---------------------------------------------------------------------------
// llama-server child process management
// ---------------------------------------------------------------------------
let llamaProcess = null;
let llamaReady = false;
let restartCount = 0;
const MAX_RESTARTS = 5;

function startLlamaServer() {
  log(`Starting llama-server (model: ${config.MODEL_PATH})...`);
  llamaReady = false;

  llamaProcess = spawn(
    config.LLAMA_SERVER_BIN,
    [
      '-m', config.MODEL_PATH,
      '--host', '127.0.0.1',
      '--port', String(config.LLAMA_PORT),
      '-c', String(config.CONTEXT_SIZE),
      '-t', String(config.THREADS),
      '--jinja', // enables chat template + tool-calling
      '-ngl', '0', // CPU-only build
    ],
    {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }
  );

  llamaProcess.stdout.on('data', (d) => process.stdout.write(`[llama-server] ${d}`));
  llamaProcess.stderr.on('data', (d) => process.stderr.write(`[llama-server] ${d.toString()}`));
  pollLlamaHealth();

  llamaProcess.on('exit', (code, signal) => {
    llamaReady = false;
    if (healthPollTimer) { clearInterval(healthPollTimer); healthPollTimer = null; }
    log(`llama-server exited (code=${code}, signal=${signal}).`);
    if (restartCount < MAX_RESTARTS) {
      restartCount += 1;
      log(`Restarting (attempt ${restartCount}/${MAX_RESTARTS}) in 2s...`);
      setTimeout(startLlamaServer, 2000);
    } else {
      log('Too many restarts - giving up. Check MODEL_PATH / LLAMA_SERVER_BIN in config.js.');
    }
  });
}

function llamaBaseUrl() {
  return `http://127.0.0.1:${config.LLAMA_PORT}`;
}

let healthPollTimer = null;

function pollLlamaHealth() {
  if (healthPollTimer) clearInterval(healthPollTimer);
  llamaReady = false;
  let attempts = 0;

  healthPollTimer = setInterval(() => {
    attempts += 1;
    const req = http.get(`${llamaBaseUrl()}/health`, { timeout: 2000 }, (res) => {
      res.on('data', () => {});
      res.on('end', () => {
        if (res.statusCode === 200 && !llamaReady) {
          llamaReady = true;
          log(`llama-server is ready after ${attempts} health check(s).`);
          clearInterval(healthPollTimer);
          healthPollTimer = null;
        }
      });
    });
    req.on('timeout', () => req.destroy());
    req.on('error', () => {
      // Not up yet - keep polling silently, expected during model load.
    });
  }, 1500);
}

/** Proxies a request to llama-server, forwarding body as-is and streaming back the response. */
function proxyToLlama(req, res, reqPath) {
  const body = JSON.stringify(req.body);
  const options = {
    hostname: '127.0.0.1',
    port: config.LLAMA_PORT,
    path: reqPath,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
    },
  };

  const proxyReq = http.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode || 200);
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value !== undefined) res.setHeader(key, value);
    }
    proxyRes.pipe(res);
  });

  proxyReq.on('error', (err) => {
    log('Proxy to llama-server failed:', err.message);
    res.status(502).json({ error: { message: `llama-server is not responding: ${err.message}` } });
  });

  proxyReq.write(body);
  proxyReq.end();
}

/**
 * Sends a chat history straight to llama-server and returns the same
 * { success, content, error } shape the old backendClient.js's
 * _callModel() used - the browser agent (browserAgent.js) needs this same
 * call but isn't itself an Express request/response, so it can't reuse
 * proxyToLlama() above directly.
 */
function sendToModel(history) {
  return new Promise((resolve) => {
    if (!llamaReady) {
      resolve({ success: false, content: null, error: { message: 'Model is still loading.' } });
      return;
    }
    const body = JSON.stringify({ messages: history, max_tokens: 1024, temperature: 0.2 });
    const options = {
      hostname: '127.0.0.1',
      port: config.LLAMA_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.message?.content || null;
          if (!content) {
            resolve({ success: false, content: null, error: { message: 'No content from model.' } });
            return;
          }
          resolve({ success: true, content, error: null });
        } catch (err) {
          resolve({ success: false, content: null, error: { message: `Failed to parse model response: ${err.message}` } });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, content: null, error: { message: err.message } }));
    req.write(body);
    req.end();
  });
}

/**
 * Same idea as sendToModel() above, but supports passing `tools` (OpenAI
 * function-calling schemas) and returns the assistant message's
 * tool_calls alongside its content, instead of assuming a plain text
 * reply. sendToModel() is left as-is (browserAgent.js's plain-text ReAct
 * loop has no tool-calling needs); this is what backgroundSessions.js's
 * server-side agent loop drives - the toolOrchestrator.js pattern already
 * used for the phone's in-app tool loop, just with the model call and the
 * tool loop both running here on the PC instead of split across a phone
 * app + this backend.
 * @returns {Promise<{success: boolean, content: string|null, toolCalls: Array|null, error: object|null}>}
 */
function sendToolCall(history, tools) {
  return new Promise((resolve) => {
    if (!llamaReady) {
      resolve({ success: false, content: null, toolCalls: null, error: { message: 'Model is still loading.' } });
      return;
    }
    const body = JSON.stringify({ messages: history, tools, max_tokens: 2048, temperature: 0.3 });
    const options = {
      hostname: '127.0.0.1',
      port: config.LLAMA_PORT,
      path: '/v1/chat/completions',
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const message = parsed?.choices?.[0]?.message;
          if (!message) {
            resolve({ success: false, content: null, toolCalls: null, error: { message: 'No message from model.' } });
            return;
          }
          resolve({ success: true, content: message.content || null, toolCalls: message.tool_calls || null, error: null });
        } catch (err) {
          resolve({ success: false, content: null, toolCalls: null, error: { message: `Failed to parse model response: ${err.message}` } });
        }
      });
    });
    req.on('error', (err) => resolve({ success: false, content: null, toolCalls: null, error: { message: err.message } }));
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check - no auth required, so the app can show connection status
// before you've even entered a token, and so a quick browser visit to
// http://<tunnel-url>/health works for a sanity check.
app.get('/health', (req, res) => {
  res.json({
    status: llamaReady ? 'ready' : 'starting',
    model: config.MODEL_LABEL,
    port: config.PORT,
    internetAvailable, // null until the first background check completes (~15s after startup)
  });
});

app.post('/v1/chat/completions', (req, res) => {
  if (!llamaReady) {
    return res.status(503).json({ error: { message: 'Model is still loading. Try again in a moment.' } });
  }
  log(`Chat request (${(req.body?.messages || []).length} messages, tools=${req.body?.tools ? 'yes' : 'no'})`);
  proxyToLlama(req, res, '/v1/chat/completions');
});

registerTerminalRoute(app, config, log);
registerProcessRoutes(app, config, log);
registerOcrRoute(app, config, log);
registerWebSearchRoute(app, config, log);
registerWebFetchRoute(app, config, log);
registerDataRoute(app, config, log);
registerPcFilesRoute(app, config, log);
registerPcZipRoute(app, config, log);
registerPcGitRoute(app, config, log);
registerDevPreviewRoute(app, config, log);
registerSessionRoutes(app, config, log, sendToolCall);

if (config.AUTH_TOKEN === config.DEFAULT_AUTH_TOKEN) {
  log('='.repeat(70));
  log('WARNING: AUTH_TOKEN is still the default placeholder value.');
  log('This server binds to 0.0.0.0 and is reachable over LAN, and over the');
  log('public internet if you run the Cloudflare tunnel. Anyone who can');
  log('reach it can use the default token to run commands on this PC.');
  log('Set ZAO_AUTH_TOKEN to a real secret (env var, or edit config.js)');
  log('before exposing this beyond your own machine.');
  log('='.repeat(70));
}

const httpServer = app.listen(config.PORT, '0.0.0.0', () => {
  log(`ZAO backend listening on http://0.0.0.0:${config.PORT} (reachable via LAN IP and Cloudflare tunnel)`);
  log(`Health check: http://127.0.0.1:${config.PORT}/health`);
  log(`Browser agent stream: ws://0.0.0.0:${config.PORT}/browser-agent/stream`);
  checkPathsOrExit();
  startLlamaServer();
  refreshInternetStatus(); // fire immediately so /health has a real value ASAP, not just after the first interval tick
  setInterval(refreshInternetStatus, INTERNET_CHECK_INTERVAL_MS);
});

registerBrowserAgentStream(httpServer, config, log, sendToModel);

process.on('SIGINT', async () => {
  log('Shutting down...');
  if (healthPollTimer) clearInterval(healthPollTimer);
  if (llamaProcess) llamaProcess.kill();
  shutdownAllPreviewServers();
  await shutdownBrowser();
  process.exit(0);
});
