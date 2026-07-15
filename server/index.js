#!/usr/bin/env node
/**
 * ZAO Backend - Termux server
 *
 * Single-model, single-user, local-only. Wraps llama.cpp's `llama-server`
 * (started as a child process) with a small Express layer that:
 *   - Spawns/monitors llama-server on startup, restarts it if it dies
 *   - Exposes /v1/chat/completions (proxies straight to llama-server,
 *     same OpenAI-compatible shape the app already expects)
 *   - Exposes /health so the app can auto-discover the backend on
 *     127.0.0.1 without you typing a URL anywhere
 *   - Logs every request/response to stdout so you can see what's
 *     happening live in the Termux session
 *
 * Run with: ./start.sh (see start.sh in this folder)
 *
 * Config is entirely in server/config.js - edit the MODEL_PATH there to
 * point at your Qwen2.5-Coder-3B GGUF file.
 */

const express = require('express');
const { spawn } = require('child_process');
const http = require('http');
const config = require('./config');

const app = express();
app.use(express.json({ limit: '25mb' }));

// ---------------------------------------------------------------------------
// llama-server child process management
// ---------------------------------------------------------------------------
let llamaProcess = null;
let llamaReady = false;
let restartCount = 0;
const MAX_RESTARTS = 5;

function log(...args) {
  const ts = new Date().toISOString().split('T')[1].replace('Z', '');
  console.log(`[${ts}]`, ...args);
}

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
      '-ngl', '0', // CPU only - Android Vulkan backend still immature
    ],
    { stdio: ['ignore', 'pipe', 'pipe'] }
  );

  llamaProcess.stdout.on('data', (d) => process.stdout.write(`[llama-server] ${d}`));
  llamaProcess.stderr.on('data', (d) => {
    const text = d.toString();
    process.stderr.write(`[llama-server] ${text}`);
    // llama-server prints "HTTP server listening" (older) or
    // "server is listening on" (newer) once it's actually ready for requests
    if (/listening/i.test(text)) {
      llamaReady = true;
      log('llama-server is ready.');
    }
  });

  llamaProcess.on('exit', (code, signal) => {
    llamaReady = false;
    log(`llama-server exited (code=${code}, signal=${signal}).`);
    if (restartCount < MAX_RESTARTS) {
      restartCount += 1;
      log(`Restarting (attempt ${restartCount}/${MAX_RESTARTS}) in 2s...`);
      setTimeout(startLlamaServer, 2000);
    } else {
      log('Too many restarts - giving up. Check your model path and llama-server binary in server/config.js.');
    }
  });
}

function llamaBaseUrl() {
  return `http://127.0.0.1:${config.LLAMA_PORT}`;
}

/** Proxies a request to llama-server, forwarding body as-is and streaming back the response. */
function proxyToLlama(req, res, path) {
  const body = JSON.stringify(req.body);
  const options = {
    hostname: '127.0.0.1',
    port: config.LLAMA_PORT,
    path,
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

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

// Health check - the app polls this on launch/foreground to auto-detect
// the backend at 127.0.0.1:<PORT>. No URL entry needed on the phone side.
app.get('/health', (req, res) => {
  res.json({
    status: llamaReady ? 'ready' : 'starting',
    model: config.MODEL_LABEL,
    port: config.PORT,
  });
});

// Chat completions - same request/response shape as llama-server's own
// OpenAI-compatible endpoint, just proxied through so we can log + guard.
app.post('/v1/chat/completions', (req, res) => {
  if (!llamaReady) {
    return res.status(503).json({ error: { message: 'Model is still loading. Try again in a moment.' } });
  }
  log(`Chat request (${(req.body?.messages || []).length} messages, tools=${req.body?.tools ? 'yes' : 'no'})`);
  proxyToLlama(req, res, '/v1/chat/completions');
});

app.listen(config.PORT, '127.0.0.1', () => {
  log(`ZAO backend listening on http://127.0.0.1:${config.PORT}`);
  log(`Health check: http://127.0.0.1:${config.PORT}/health`);
  startLlamaServer();
});

process.on('SIGINT', () => {
  log('Shutting down...');
  if (llamaProcess) llamaProcess.kill();
  process.exit(0);
});
