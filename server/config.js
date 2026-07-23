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

  // Default/fallback shell used by the /terminal/run route when
  // auto-detection (see chooseShell() in terminal.js) can't tell which
  // of cmd/powershell/gitbash a command is meant for. Your different
  // Python versions are reachable as separate PATH commands (python39,
  // python311, etc.) through any of these shells, so no extra config is
  // needed for that.
  TERMINAL_SHELL: process.env.ZAO_TERMINAL_SHELL || 'cmd',

  // Set to 'false' to disable auto-detection entirely and always use
  // TERMINAL_SHELL - useful if the heuristics in chooseShell() ever
  // guess wrong for your workflow and you'd rather pin one shell.
  TERMINAL_AUTO_SHELL: process.env.ZAO_TERMINAL_AUTO_SHELL !== 'false',

  // powershell.exe is on PATH on every Windows install, so this rarely
  // needs changing. pwsh.exe (PowerShell 7+) works too if that's what
  // you have installed - just override the env var.
  POWERSHELL_BIN: process.env.ZAO_POWERSHELL_BIN || 'powershell.exe',

  // Git for Windows' bash.exe is NOT on PATH by default - this is the
  // standard install location. Override if yours is a portable/custom
  // Git install. Bash-style commands (unix pipes, $(...), ./script.sh,
  // export FOO=bar, chmod, etc.) get routed here automatically.
  GIT_BASH_PATH: process.env.ZAO_GIT_BASH_PATH || 'C:\\Program Files\\Git\\bin\\bash.exe',

  // Working directory terminal commands run from by default.
  TERMINAL_CWD: process.env.ZAO_TERMINAL_CWD || 'C:\\Users\\User',

  // Max time (ms) a single terminal command is allowed to run before being
  // killed. Prevents a runaway/hanging command from tying up a slot
  // forever.
  TERMINAL_TIMEOUT_MS: Number(process.env.ZAO_TERMINAL_TIMEOUT_MS || 120000),

  // Real OS-level sandboxing for terminal commands (see sandbox.js) -
  // gitbash/python-classified commands run inside an isolated Docker
  // container instead of directly on the host, whenever Docker is
  // available and the caller hasn't set hostAccess: true. Set to
  // 'false' to disable entirely and always run on the host (the old
  // behavior) - useful if Docker Desktop isn't installed, or if the
  // container overhead isn't worth it for your workflow.
  SANDBOX_ENABLED: process.env.ZAO_SANDBOX_ENABLED !== 'false',

  // Resource limits applied to every sandboxed command - keeps a
  // runaway or fork-bombing command capped to the container's own
  // cgroup instead of able to take the whole PC down.
  SANDBOX_MEMORY_LIMIT: process.env.ZAO_SANDBOX_MEMORY_LIMIT || '512m',
  SANDBOX_CPU_LIMIT: process.env.ZAO_SANDBOX_CPU_LIMIT || '1.5',
  SANDBOX_PIDS_LIMIT: process.env.ZAO_SANDBOX_PIDS_LIMIT || '256',

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

  // PC <-> phone file bridge (see pcFiles.js / pcFilePullTool.js). The
  // PC and the phone are separate filesystems - anything
  // terminal_pc_run_command creates on the PC (npm install's
  // node_modules, a built APK, a bundle) stays on the PC until
  // explicitly pulled over. PC_BRIDGE_ROOT is the one folder /pc-fs/list
  // and /pc-fs/read are allowed to reach into - defaults to
  // TERMINAL_CWD (wherever your projects live) so you don't have to set
  // it separately, but override it if your build outputs live somewhere
  // else entirely.
  PC_BRIDGE_ROOT: process.env.ZAO_PC_BRIDGE_ROOT || process.env.ZAO_TERMINAL_CWD || 'C:\\Users\\User',

  // Single-pull size limit for /pc-fs/read, in bytes - it's one base64
  // JSON response, not a stream, so this keeps a huge accidental read
  // (an unzipped node_modules, a multi-GB video) from tying up the
  // connection. Default 200MB comfortably covers a release APK.
  PC_BRIDGE_MAX_FILE_BYTES: Number(process.env.ZAO_PC_BRIDGE_MAX_FILE_MB || 200) * 1024 * 1024,
};
