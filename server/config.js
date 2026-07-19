/**
 * ZAO Backend config - PC (Windows) edition.
 *
 * This backend now runs on your PC instead of on-device in Termux. The
 * phone app talks to it over LAN (home WiFi) or through a Cloudflare Quick
 * Tunnel URL when you're out - see server/start.bat and the Settings
 * screen's Backend Connection section.
 */

const path = require('path');

// Folder where llama-server.exe and the GGUF both live.
const MODEL_DIR = process.env.ZAO_MODEL_DIR || 'C:\\Users\\User\\Downloads\\Model';

module.exports = {
  // The ZAO app's public-facing port. Both LAN and the Cloudflare tunnel
  // point at this same port on the PC.
  PORT: Number(process.env.PORT || 8080),

  // Internal port llama-server itself listens on (not exposed directly -
  // index.js proxies to it). Different from PORT so the two processes
  // never collide.
  LLAMA_PORT: Number(process.env.LLAMA_PORT || 8081),

  // Path to the llama-server binary, extracted from
  // llama-b10038-bin-win-cpu-x64.zip.
  LLAMA_SERVER_BIN: process.env.LLAMA_SERVER_BIN || path.join(MODEL_DIR, 'llama-server.exe'),

  // Path to the Qwen2.5-Coder-3B GGUF.
  MODEL_PATH: process.env.MODEL_PATH || path.join(MODEL_DIR, 'Qwen2.5-coder-3B-instruct-Q4_K_M.gguf'),

  MODEL_LABEL: 'Qwen2.5 Coder 3B (Q4_K_M)',

  CONTEXT_SIZE: Number(process.env.ZAO_CONTEXT_SIZE || 4096),

  // Thread count for llama-server's CPU inference. Defaults to the PC's
  // actual logical core count (os.cpus().length), which is normally a much
  // better default on a desktop/laptop CPU than the old phone default of 4.
  THREADS: Number(process.env.LLAMA_THREADS || require('os').cpus().length),

  // Shared-secret token the phone app must send as `Authorization: Bearer
  // <token>` on every request. Required because this server is now bound
  // to 0.0.0.0 and reachable over LAN and the public Cloudflare tunnel, not
  // just 127.0.0.1 like the old Termux version. Change this to your own
  // value and put the same value in the app's Settings > Backend
  // Connection screen.
  AUTH_TOKEN: process.env.ZAO_AUTH_TOKEN || 'change-me-to-a-real-secret',

  // Exposed separately (not just buried in AUTH_TOKEN's value) so
  // index.js can check "is this still the placeholder" without having
  // to hardcode the placeholder string in two places. This server binds
  // to 0.0.0.0 - reachable over LAN and, via the Cloudflare tunnel, the
  // public internet - so shipping with this default un-warned-about is
  // a real exposure, not a theoretical one.
  DEFAULT_AUTH_TOKEN: 'change-me-to-a-real-secret',

  // Default shell used by the /terminal/run route. cmd per your setup -
  // your different Python versions are reachable as separate PATH commands
  // (python39, python311, etc.) so no extra config is needed here for
  // that.
  TERMINAL_SHELL: process.env.ZAO_TERMINAL_SHELL || 'cmd',

  // Working directory terminal commands run from by default.
  TERMINAL_CWD: process.env.ZAO_TERMINAL_CWD || 'C:\\Users\\User',

  // Max time (ms) a single terminal command is allowed to run before being
  // killed. Prevents a runaway/hanging command from tying up a slot
  // forever.
  TERMINAL_TIMEOUT_MS: Number(process.env.ZAO_TERMINAL_TIMEOUT_MS || 120000),

  // Python command used for OCR (see ocr.js / scripts/ocr_extract.py).
  // Same "just a PATH command" approach as TERMINAL_SHELL - if you have
  // multiple Python installs, point this at whichever one has
  // pytesseract/PyMuPDF/Pillow installed (e.g. 'python311').
  PYTHON_BIN: process.env.ZAO_PYTHON_BIN || 'python',

  // Max time (ms) a single OCR request is allowed to run before being
  // killed - scanned multi-page PDFs can be slow on CPU, so this is
  // deliberately more generous than TERMINAL_TIMEOUT_MS.
  OCR_TIMEOUT_MS: Number(process.env.ZAO_OCR_TIMEOUT_MS || 180000),

  // Max time (ms) a single /data/analyze request is allowed to run
  // before being killed (see data.js / scripts/data_analyze.py). Large
  // CSVs can take a while to load and groupby, so this gets the same
  // more-generous budget as OCR rather than TERMINAL_TIMEOUT_MS's
  // shorter default.
  DATA_TIMEOUT_MS: Number(process.env.ZAO_DATA_TIMEOUT_MS || 180000),
};
