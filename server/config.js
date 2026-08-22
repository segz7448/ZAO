/**
 * ZAO Backend config - Alibaba Cloud VM edition.
 *
 * This backend runs on a dedicated, always-on Alibaba Cloud VM instead of
 * on-device or on a person's PC. The phone app talks to it over a single
 * fixed IP - see server/start.sh and the Settings screen's Server
 * Connection section.
 *
 * MODEL: no local inference. This VM is a thin, always-on relay - it
 * forwards /v1/chat/completions straight to Alibaba Cloud's Model Studio
 * (DashScope) OpenAI-compatible API, which actually hosts
 * qwen3-coder-30b-a3b-instruct. There is no local model process,
 * no GGUF weights, and no local GPU/CPU inference on this VM anymore.
 */

module.exports = {
  // The ZAO app's public-facing port on this VM.
  PORT: Number(process.env.PORT || 8000),

  // Alibaba Cloud Model Studio (DashScope) OpenAI-compatible endpoint -
  // this VM's dedicated workspace host (ap-southeast-1 MaaS), not the
  // generic dashscope-intl.aliyuncs.com one.
  DASHSCOPE_BASE_URL: process.env.DASHSCOPE_BASE_URL || 'https://ws-huaqujanfkq8v50o.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1',

  // Model Studio API key (from the Alibaba Cloud console - Model Studio >
  // API-KEY). This is DIFFERENT from AUTH_TOKEN below: this key is what
  // this VM sends to Alibaba; AUTH_TOKEN is what the phone sends to this
  // VM. Required - there's no local fallback if this is missing.
  DASHSCOPE_API_KEY: process.env.DASHSCOPE_API_KEY || '',

  MODEL_NAME: process.env.ZAO_MODEL_NAME || 'qwen3-coder-30b-a3b-instruct',

  MODEL_LABEL: 'Qwen3 Coder 30B A3B Instruct (Alibaba Model Studio)',

  // Timeout for calls out to Model Studio.
  MODEL_TIMEOUT_MS: Number(process.env.ZAO_MODEL_TIMEOUT_MS || 120000),

  // The model API key. The phone app must send this as `Authorization:
  // Bearer <token>` on every request. Change this to your own value and
  // enter the SAME value in the app's Settings > Server Connection >
  // Model API key field.
  AUTH_TOKEN: process.env.ZAO_AUTH_TOKEN || 'change-me-to-a-real-secret',

  // Exposed separately (not just buried in AUTH_TOKEN's value) so
  // index.js can check "is this still the placeholder" without having
  // to hardcode the placeholder string in two places. This server binds
  // to 0.0.0.0 and is reachable over the public internet at the VM's
  // IP, so shipping with this default un-warned-about is a real
  // exposure, not a theoretical one.
  DEFAULT_AUTH_TOKEN: 'change-me-to-a-real-secret',

  // Default/fallback shell used by the /terminal/run route when
  // auto-detection (see chooseShell() in terminal.js) can't tell
  // whether a command is meant for bash or python. This is a Linux VM,
  // so bash and python are the only two shells that exist here - no
  // cmd/PowerShell/Git Bash to route between anymore. Different Python
  // versions are reachable as separate PATH commands (python3.10,
  // python3.11, etc.) through bash, so no extra config is needed for
  // that.
  TERMINAL_SHELL: process.env.ZAO_TERMINAL_SHELL || 'bash',

  // Set to 'false' to disable auto-detection entirely and always use
  // TERMINAL_SHELL - useful if the heuristics in chooseShell() ever
  // guess wrong for your workflow and you'd rather pin one shell.
  TERMINAL_AUTO_SHELL: process.env.ZAO_TERMINAL_AUTO_SHELL !== 'false',

  // Working directory terminal commands run from by default.
  TERMINAL_CWD: process.env.ZAO_TERMINAL_CWD || '/root',

  // Max time (ms) a single terminal command is allowed to run before being
  // killed. Prevents a runaway/hanging command from tying up a slot
  // forever.
  TERMINAL_TIMEOUT_MS: Number(process.env.ZAO_TERMINAL_TIMEOUT_MS || 120000),

  // Real OS-level sandboxing for terminal commands (see sandbox.js) -
  // every command runs inside an isolated Docker container instead of
  // directly on the host, whenever Docker is available and the caller
  // hasn't set hostAccess: true. Set to 'false' to disable entirely and
  // always run on the host (the old behavior) - useful if Docker isn't
  // installed on the VM, or if the container overhead isn't worth it
  // for your workflow.
  SANDBOX_ENABLED: process.env.ZAO_SANDBOX_ENABLED !== 'false',

  // Resource limits applied to every sandboxed command - keeps a
  // runaway or fork-bombing command capped to the container's own
  // cgroup instead of able to take the whole VM down.
  SANDBOX_MEMORY_LIMIT: process.env.ZAO_SANDBOX_MEMORY_LIMIT || '512m',
  SANDBOX_CPU_LIMIT: process.env.ZAO_SANDBOX_CPU_LIMIT || '1.5',
  SANDBOX_PIDS_LIMIT: process.env.ZAO_SANDBOX_PIDS_LIMIT || '256',

  // Python command used for OCR (see ocr.js / scripts/ocr_extract.py).
  // Same "just a PATH command" approach as TERMINAL_SHELL - if you have
  // multiple Python installs, point this at whichever one has
  // pytesseract/PyMuPDF/Pillow installed (e.g. 'python3.11').
  PYTHON_BIN: process.env.ZAO_PYTHON_BIN || 'python3',

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

  // VM <-> phone file bridge (see pcFiles.js / pcFilePullTool.js). The
  // VM and the phone are separate filesystems - anything
  // terminal_pc_run_command creates on the VM (npm install's
  // node_modules, a built APK, a bundle) stays on the VM until
  // explicitly pulled over. PC_BRIDGE_ROOT is the one folder /pc-fs/list
  // and /pc-fs/read are allowed to reach into - defaults to
  // TERMINAL_CWD (wherever your projects live) so you don't have to set
  // it separately, but override it if your build outputs live somewhere
  // else entirely.
  PC_BRIDGE_ROOT: process.env.ZAO_PC_BRIDGE_ROOT || process.env.ZAO_TERMINAL_CWD || '/root',

  // Single-pull size limit for /pc-fs/read, in bytes - it's one base64
  // JSON response, not a stream, so this keeps a huge accidental read
  // (an unzipped node_modules, a multi-GB video) from tying up the
  // connection. Default 200MB comfortably covers a release APK.
  PC_BRIDGE_MAX_FILE_BYTES: Number(process.env.ZAO_PC_BRIDGE_MAX_FILE_MB || 200) * 1024 * 1024,
};
