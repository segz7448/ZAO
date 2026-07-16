/**
 * ZAO Backend config - edit MODEL_PATH to match where your GGUF actually
 * lives in Termux (e.g. after copying it off the SD card into
 * $HOME/models/ or wherever you keep it).
 *
 * NOTE: if your model/binary live under /storage/emulated/0/... (shared
 * Android storage, not Termux's private filesystem), Termux can only see
 * that path if you've already run `termux-setup-storage` once (grants the
 * storage permission and creates ~/storage/shared as a symlink to
 * /storage/emulated/0). Without that, Node will get ENOENT/EACCES trying
 * to read these paths even though they look correct. The direct
 * /storage/emulated/0/... path below works either way as long as that
 * permission has been granted - `termux-setup-storage` just also gives you
 * the shorter ~/storage/shared/... alias if you'd rather use that.
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

  // Path to the llama-server binary, extracted from
  // llama-b10037-bin-android-arm64.tar.gz. Double-check this matches where
  // the binary actually landed after extraction - release tarballs don't
  // always put it at <folder>/bin/llama-server, sometimes it's directly in
  // the extracted root instead. Run `find /storage/emulated/0/Download/llama-b10037 -name llama-server`
  // in Termux to confirm the real path if this doesn't work.
  LLAMA_SERVER_BIN: process.env.LLAMA_SERVER_BIN || '/storage/emulated/0/Download/llama-b10037/bin/llama-server',

  // Path to the Qwen2.5-Coder-1.5B GGUF. Override with MODEL_PATH env var.
  MODEL_PATH: process.env.MODEL_PATH || '/storage/emulated/0/Model/qwen2.5-coder-1.5b-instruct-q5_0.gguf',

  MODEL_LABEL: 'Qwen2.5 Coder 1.5B (Q5_0)',

  CONTEXT_SIZE: 4096,

  // Thread count for llama-server's CPU inference. 4 is a safe default for
  // mid-range phone CPUs; bump it if your device has more cores to spare.
  THREADS: Number(process.env.LLAMA_THREADS || 4),
};
