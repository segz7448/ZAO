#!/usr/bin/env node
/**
 * ZAO Backend - Alibaba Cloud VM edition, OpenRouter model relay
 *
 * Single-model, single-user. No local inference: this is a thin, always-on
 * Express relay that:
 *   - Exposes /v1/chat/completions and forwards it straight to OpenRouter's
 *     OpenAI-compatible API, currently pointed at `stealth/ox-alpha` (see
 *     config.js's header comment for the full story) - same
 *     request/response shape the app already expects, just relayed over
 *     HTTPS instead of proxied to Alibaba Model Studio (no local model
 *     process, and no Alibaba dependency left at all)
 *   - Exposes /health so the app can check the backend is up at the VM's
 *     IP - also reports whether the VM currently has internet access
 *     (internetAvailable), so the app can tell the person plainly when an
 *     internet-dependent terminal command (npm/pip install, git
 *     pull/clone/push, curl, downloads) will fail, even though the VM
 *     backend itself is perfectly reachable
 *   - Exposes /terminal/run so the app's Terminal tool can run bash/Python
 *     commands on this VM (see terminal.js)
 *   - Exposes /process/start, /process/:id/status, /process/:id/logs,
 *     and /process/:id/stop so the app can run long-lived commands (dev
 *     servers, watchers) in the background instead of blocking a single
 *     HTTP request on a process that's never meant to exit (see
 *     processManager.js)
 *   - Exposes /ocr/extract for scanned/image-based PDFs and plain images -
 *     runs free, open-source OCR (Tesseract via pytesseract + PyMuPDF) in
 *     a Python subprocess on this VM (see ocr.js)
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
 *     except /health, since this is reachable over the public internet at
 *     the VM's IP, not just 127.0.0.1
 *
 * Run with: server/start.sh (or set it up as a systemd service - see that
 * file's own header - so it survives reboots on the 24/7 VM).
 *
 * Config is entirely in config.js. Unlike the old DashScope setup, the
 * OpenRouter key mostly does NOT live here - the app sends it per request
 * as an `X-OpenRouter-Key` header (see cachedOpenRouterKey below).
 * OPENROUTER_API_KEY in config.js is only an operator-level fallback.
 */

const express = require('express');
const http = require('http');
const https = require('https');
const { URL } = require('url');
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
app.use(express.json({ limit: `${config.MAX_JSON_BODY_MB}mb` }));

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
// Required since this server is bound to 0.0.0.0 and reachable over the
// public internet at the VM's IP, not just loopback.
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
// OpenRouter key caching - the app sends the person's own OpenRouter key
// as `X-OpenRouter-Key` on every request (backendClient.js's authHeaders()
// attaches it automatically once it's saved in Settings), which is the
// primary path per config.js's header comment. This middleware runs after
// the auth check above (so it only ever sees requests already proven to
// be from the phone, not the open internet) and just remembers the most
// recent key in memory - that's what lets server-initiated calls with no
// live HTTP request to read a header from (sendToModel/sendToolCall below,
// used by browserAgent.js and backgroundSessions.js) still have a key to
// use. Resets on VM restart, same tradeoff as the rate limiter's in-memory
// window - fine for a single-user personal backend.
// ---------------------------------------------------------------------------
let cachedOpenRouterKey = config.OPENROUTER_API_KEY || null;

app.use((req, res, next) => {
  const suppliedKey = req.headers['x-openrouter-key'];
  if (suppliedKey) cachedOpenRouterKey = suppliedKey;
  next();
});

function activeOpenRouterKey() {
  return cachedOpenRouterKey || config.OPENROUTER_API_KEY || null;
}

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
// upstream 401 the first time the app tries to send a message.
// ---------------------------------------------------------------------------
function checkPathsOrExit() {
  if (config.AUTH_TOKEN === 'change-me-to-a-real-secret') {
    log('WARNING: AUTH_TOKEN is still the default placeholder. Set ZAO_AUTH_TOKEN (or edit config.js) to a real secret before exposing this over the public internet.');
  }
  if (!config.OPENROUTER_API_KEY) {
    // Not fatal - the app sends its own key per request as X-OpenRouter-Key
    // (see cachedOpenRouterKey above), so the VM doesn't need one baked in
    // to start up. This is just a heads-up for the operator.
    log('NOTE: OPENROUTER_API_KEY is not set in config.js/env. That\'s fine - the app sends the OpenRouter key from Settings > Server Connection on every request. This env var is only a fallback for server-initiated calls (browser agent, background sessions) before the app has sent a key at least once.');
  }
}

// ---------------------------------------------------------------------------
// OpenRouter relay - no local inference. This VM just forwards chat
// completions to OpenRouter's hosted `stealth/ox-alpha` (see config.js's
// header comment) over HTTPS and streams the response straight back to the
// phone. "Ready" means the VM itself is up - unlike the old DashScope setup
// there's no single fixed key to check at startup, since the real key now
// travels with each request (see activeOpenRouterKey() above).
// ---------------------------------------------------------------------------
function modelReady() {
  return true;
}

/** Forwards a request to OpenRouter, injecting the model name + key and streaming the response back. */
function proxyToOpenRouter(req, res, reqPath) {
  const key = req.headers['x-openrouter-key'] || activeOpenRouterKey();
  if (!key) {
    return res.status(503).json({ error: { message: 'No OpenRouter API key available. Add yours in Settings > Server Connection > OpenRouter API key.' } });
  }

  const upstream = new URL(config.OPENROUTER_BASE_URL + reqPath);
  const bodyObj = { ...req.body, model: req.body?.model || config.MODEL_NAME };
  const body = JSON.stringify(bodyObj);

  const headers = {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Authorization: `Bearer ${key}`,
  };
  if (config.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = config.OPENROUTER_SITE_URL;
  if (config.OPENROUTER_SITE_NAME) headers['X-Title'] = config.OPENROUTER_SITE_NAME;

  const options = {
    hostname: upstream.hostname,
    port: upstream.port || 443,
    path: upstream.pathname + upstream.search,
    method: 'POST',
    headers,
    timeout: config.MODEL_TIMEOUT_MS,
  };

  const proxyReq = https.request(options, (proxyRes) => {
    res.status(proxyRes.statusCode || 200);
    for (const [key, value] of Object.entries(proxyRes.headers)) {
      if (value !== undefined) res.setHeader(key, value);
    }
    proxyRes.pipe(res);
  });

  proxyReq.on('timeout', () => proxyReq.destroy(new Error('OpenRouter request timed out')));
  proxyReq.on('error', (err) => {
    log('Relay to OpenRouter failed:', err.message);
    if (!res.headersSent) {
      res.status(502).json({ error: { message: `OpenRouter is not responding: ${err.message}` } });
    }
  });

  proxyReq.write(body);
  proxyReq.end();
}

/**
 * Sends a chat history straight to OpenRouter and returns the same
 * { success, content, error } shape backendClient.js's non-streaming path
 * expects - the browser agent (browserAgent.js) needs this same call but
 * isn't itself an Express request/response, so it can't reuse
 * proxyToOpenRouter() above directly (no live `req` to read a header from -
 * this is exactly why activeOpenRouterKey() falls back to the cached key).
 */
function sendToModel(history) {
  return new Promise((resolve) => {
    const key = activeOpenRouterKey();
    if (!key) {
      resolve({ success: false, content: null, error: { message: 'No OpenRouter API key available yet - send at least one chat message from the app first, or set OPENROUTER_API_KEY on the VM.' } });
      return;
    }
    const body = JSON.stringify({ model: config.MODEL_NAME, messages: history, max_tokens: 1024, temperature: 0.2 });
    const upstream = new URL(config.OPENROUTER_BASE_URL + '/chat/completions');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${key}` };
    if (config.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = config.OPENROUTER_SITE_URL;
    if (config.OPENROUTER_SITE_NAME) headers['X-Title'] = config.OPENROUTER_SITE_NAME;
    const options = {
      hostname: upstream.hostname,
      port: upstream.port || 443,
      path: upstream.pathname,
      method: 'POST',
      headers,
      timeout: config.MODEL_TIMEOUT_MS,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const content = parsed?.choices?.[0]?.message?.content || null;
          if (!content) {
            resolve({ success: false, content: null, error: { message: parsed?.error?.message || 'No content from model.' } });
            return;
          }
          resolve({ success: true, content, error: null });
        } catch (err) {
          resolve({ success: false, content: null, error: { message: `Failed to parse model response: ${err.message}` } });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('OpenRouter request timed out')));
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
 * tool loop both running here on the VM instead of split across a phone
 * app + this backend.
 * @returns {Promise<{success: boolean, content: string|null, toolCalls: Array|null, error: object|null}>}
 */
function sendToolCall(history, tools) {
  return new Promise((resolve) => {
    const key = activeOpenRouterKey();
    if (!key) {
      resolve({ success: false, content: null, toolCalls: null, error: { message: 'No OpenRouter API key available yet - send at least one chat message from the app first, or set OPENROUTER_API_KEY on the VM.' } });
      return;
    }
    const body = JSON.stringify({ model: config.MODEL_NAME, messages: history, tools, max_tokens: 2048, temperature: 0.3 });
    const upstream = new URL(config.OPENROUTER_BASE_URL + '/chat/completions');
    const headers = { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Authorization: `Bearer ${key}` };
    if (config.OPENROUTER_SITE_URL) headers['HTTP-Referer'] = config.OPENROUTER_SITE_URL;
    if (config.OPENROUTER_SITE_NAME) headers['X-Title'] = config.OPENROUTER_SITE_NAME;
    const options = {
      hostname: upstream.hostname,
      port: upstream.port || 443,
      path: upstream.pathname,
      method: 'POST',
      headers,
      timeout: config.MODEL_TIMEOUT_MS,
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const message = parsed?.choices?.[0]?.message;
          if (!message) {
            resolve({ success: false, content: null, toolCalls: null, error: { message: parsed?.error?.message || 'No message from model.' } });
            return;
          }
          resolve({ success: true, content: message.content || null, toolCalls: message.tool_calls || null, error: null });
        } catch (err) {
          resolve({ success: false, content: null, toolCalls: null, error: { message: `Failed to parse model response: ${err.message}` } });
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('OpenRouter request timed out')));
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
  // /health is intentionally exempt from the auth middleware above (see
  // that block) so the app can always tell whether the VM itself is
  // reachable, even with no token yet. If a token WAS sent, though, this
  // reports whether it's valid - that's what lets Settings run "Test &
  // Save" on the VM IP and the model API key as two independent checks:
  // the IP test never sends a token and only cares about `status`; the
  // API key test sends the token and reads `authValid`.
  const header = req.headers.authorization || '';
  const suppliedToken = header.startsWith('Bearer ') ? header.slice(7) : null;
  res.json({
    status: modelReady() ? 'ready' : 'starting',
    model: config.MODEL_LABEL,
    port: config.PORT,
    internetAvailable, // null until the first background check completes (~15s after startup)
    authValid: suppliedToken === null ? null : suppliedToken === config.AUTH_TOKEN,
    // Whether SOME OpenRouter key is currently available for model calls -
    // either sent on this very request (X-OpenRouter-Key) or cached from a
    // previous one. Doesn't confirm the key is actually VALID with
    // OpenRouter (see /openrouter/key-status for that) - just that there's
    // something to try.
    openRouterKeyPresent: Boolean(req.headers['x-openrouter-key'] || activeOpenRouterKey()),
  });
});

// Validates an OpenRouter key against OpenRouter itself (GET /key returns
// rate-limit/credit info for a valid key, 401 for an invalid one) - what
// Settings > Server Connection > OpenRouter API key's "Test & Save" calls,
// same pattern as ModelApiKeySection's existing VM-auth-token check.
app.get('/openrouter/key-status', (req, res) => {
  const key = req.headers['x-openrouter-key'];
  if (!key) {
    return res.status(400).json({ valid: false, error: { message: 'No X-OpenRouter-Key header sent.' } });
  }
  const upstream = new URL(config.OPENROUTER_BASE_URL + '/key');
  const options = {
    hostname: upstream.hostname,
    port: upstream.port || 443,
    path: upstream.pathname,
    method: 'GET',
    headers: { Authorization: `Bearer ${key}` },
    timeout: 10000,
  };
  const upstreamReq = https.request(options, (upstreamRes) => {
    let data = '';
    upstreamRes.on('data', (chunk) => { data += chunk; });
    upstreamRes.on('end', () => {
      if (upstreamRes.statusCode === 200) {
        try {
          const parsed = JSON.parse(data);
          res.json({ valid: true, limit: parsed?.data?.limit ?? null, limitRemaining: parsed?.data?.limit_remaining ?? null });
        } catch {
          res.json({ valid: true, limit: null, limitRemaining: null });
        }
      } else {
        res.json({ valid: false, error: { message: `OpenRouter rejected this key (${upstreamRes.statusCode}).` } });
      }
    });
  });
  upstreamReq.on('timeout', () => upstreamReq.destroy(new Error('timed out')));
  upstreamReq.on('error', (err) => res.status(502).json({ valid: false, error: { message: err.message } }));
  upstreamReq.end();
});

app.post('/v1/chat/completions', (req, res) => {
  // NOTE: "live tool-choice: no" here does NOT mean tools are broken or
  // unavailable - most requests never need it. The hierarchical-plan
  // pipeline (planExecutor.js) already knows which tool a step needs
  // before this call happens (decided earlier by executionPlanner.js)
  // and just calls it directly - no live function-calling round-trip,
  // so no tools array is sent for those, by design. Only a handful of
  // request types actually ask the model to choose a tool live (the
  // flat ReAct loop subagents use, the intent/reasoning classifiers) -
  // "yes" only ever shows up for those. If tool CALLS themselves are
  // failing, check the person's actual error message/Settings > Agent
  // activity log instead of this line.
  const liveToolCount = req.body?.tools?.length || 0;
  log(`Chat request (${(req.body?.messages || []).length} messages, live tool-choice: ${liveToolCount > 0 ? `yes, ${liveToolCount} tool(s) offered` : 'no (tool already decided upstream, if any)'})`);
  proxyToOpenRouter(req, res, '/chat/completions');
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
  log('This server binds to 0.0.0.0 and is reachable over the public');
  log('internet at this VM\'s IP. Anyone who can reach it can use the');
  log('default token to run commands on this VM.');
  log('Set ZAO_AUTH_TOKEN to a real secret (env var, or edit config.js)');
  log('before exposing this beyond your own machine.');
  log('='.repeat(70));
}

const httpServer = app.listen(config.PORT, '0.0.0.0', () => {
  checkPathsOrExit();
  log(`ZAO backend listening on http://0.0.0.0:${config.PORT} (reachable via the VM's public IP)`);
  log(`Health check: http://127.0.0.1:${config.PORT}/health`);
  log(`Browser agent stream: ws://0.0.0.0:${config.PORT}/browser-agent/stream`);
  log(`Model: ${config.MODEL_NAME} via ${config.OPENROUTER_BASE_URL} (OpenRouter)`);
  log(`OpenRouter key: ${activeOpenRouterKey() ? 'configured (env fallback)' : 'not set yet - waiting for the app to send one'}`);
  refreshInternetStatus(); // fire immediately so /health has a real value ASAP, not just after the first interval tick
  setInterval(refreshInternetStatus, INTERNET_CHECK_INTERVAL_MS);
});

registerBrowserAgentStream(httpServer, config, log, sendToModel);

process.on('SIGINT', async () => {
  log('Shutting down...');
  shutdownAllPreviewServers();
  await shutdownBrowser();
  process.exit(0);
});
