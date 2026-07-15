/**
 * ZAO Backend config - edit MODEL_PATH to match where your GGUF actually
 * lives in Termux (e.g. after copying it off the SD card into
 * $HOME/models/ or wherever you keep it).
 */

const path = require('path');
const os = require('os');

module.exports = {
  // The ZAO app's public-facing port. This is what the phone app connects
  // to automatically at http://127.0.0.1:8080 - no URL entry needed.
  PORT: 8080,

  // Internal port llama-server itself listens on (not exposed to the app
  // directly - index.js proxies to it). Different from PORT so the two
  // processes never collide.
  LLAMA_PORT: 8081,

  // Path to the llama-server binary. If you built llama.cpp yourself in
  // Termux, this is usually llama.cpp/build/bin/llama-server. Override
  // with the LLAMA_SERVER_BIN env var if yours lives elsewhere.
  LLAMA_SERVER_BIN: process.env.LLAMA_SERVER_BIN || path.join(os.homedir(), 'llama.cpp/build/bin/llama-server'),

  // Path to the Qwen2.5-Coder-3B GGUF. Override with MODEL_PATH env var.
  MODEL_PATH: process.env.MODEL_PATH || path.join(os.homedir(), 'models/Qwen2.5-coder-3B-instruct-Q4_K_M.gguf'),

  MODEL_LABEL: 'Qwen2.5 Coder 3B',

  CONTEXT_SIZE: 4096,

  // Thread count for llama-server's CPU inference. 4 is a safe default for
  // mid-range phone CPUs; bump it if your device has more cores to spare.
  THREADS: Number(process.env.LLAMA_THREADS || 4),
};
