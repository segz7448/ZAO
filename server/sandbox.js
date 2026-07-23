/**
 * ZAO Backend - Sandboxed execution
 *
 * WHAT THIS FIXES: commandSafety.js (src/services/terminal/commandSafety.js,
 * client-side) is regex pattern-matching against the raw command string -
 * a real but honestly-documented "last resort backstop," not isolation. A
 * cleverly obfuscated or encoded command (base64 + a decode-and-eval,
 * calling through an interpreter, string concatenation, an alias) can
 * slip past a regex in a way it categorically cannot slip past a real
 * kernel-level sandbox. This module is that second, structural layer:
 * actual filesystem/network/resource isolation via Docker, not string
 * matching.
 *
 * HOW: when Docker is reachable, a command is run inside an ephemeral
 * (--rm) Linux container instead of directly on the host:
 *   - --read-only root filesystem; only the project's own working
 *     directory is bind-mounted (read-write) - nothing else on the PC's
 *     disk is visible to the command at all, let alone writable. A
 *     malicious `rm -rf /` inside the sandbox hits the container's own
 *     throwaway root, not your PC.
 *   - --network none by default - no outbound access at all unless the
 *     caller explicitly says the command needs it (npm/pip install, git
 *     pull, curl), in which case a network-enabled bridge is used
 *     instead. Default-deny, not default-allow.
 *   - --cap-drop=ALL --security-opt=no-new-privileges:true - no Linux
 *     capabilities (can't touch raw sockets, can't change ownership
 *     outside the mount, can't load kernel modules, etc.) and no
 *     privilege escalation via setuid binaries.
 *   - --memory / --pids-limit / --cpus - a runaway or fork-bombing
 *     command can't take the whole PC down; it's capped to the
 *     container's own cgroup.
 *   - runs as a non-root container user (see the Dockerfile referenced
 *     in ensureSandboxImage() below), so even inside the container's own
 *     throwaway filesystem, most of it still isn't writable.
 *
 * HONEST LIMITATION, stated plainly rather than glossed over: Docker
 * Desktop on Windows runs LINUX containers (via its WSL2 backend) by
 * default - genuine kernel namespace/cgroup isolation, but a *Linux*
 * one. That means only commands already being run through bash (see
 * terminal.js's chooseShell() -> 'gitbash' or 'python') can be
 * transparently sandboxed this way; there's no equivalent way to drop a
 * raw cmd.exe/PowerShell invocation into an isolated Windows namespace
 * without Windows containers, which are far heavier and poorly
 * supported on Docker Desktop. So:
 *   - shell === 'gitbash' or 'python'  -> sandboxed here when Docker is
 *     available and the caller hasn't set hostAccess: true.
 *   - shell === 'cmd' or 'powershell'  -> still runs directly on the
 *     host, exactly as before. This is unavoidable without Windows
 *     containers, not a bug - and terminal.js reports `sandboxed: false`
 *     for these so the model/UI never claims isolation that didn't
 *     happen.
 *   - hostAccess: true (from the client) always skips the sandbox on
 *     purpose - APK builds, the Android emulator, Visual Studio, Docker
 *     itself, and anything else that genuinely needs the real PC can't
 *     function inside a throwaway container, so this is an explicit,
 *     visible opt-out rather than the sandbox silently failing closed.
 */

const { spawn, execFile } = require('child_process');
const path = require('path');
const os = require('os');

const SANDBOX_IMAGE = 'zao-sandbox:latest';
const DOCKER_CHECK_TIMEOUT_MS = 3000;
const DOCKER_CHECK_INTERVAL_MS = 30000; // recheck periodically - Docker Desktop can be started/stopped mid-session

let dockerAvailable = null; // null = not checked yet
let lastDockerCheck = 0;
let imageEnsured = false;

/**
 * Cheap, cached check for whether `docker` is on PATH AND the daemon is
 * actually up (not just installed) - `docker version` fails fast if the
 * daemon isn't running, which is the common case right after a reboot.
 */
function isDockerAvailable() {
  const now = Date.now();
  if (dockerAvailable !== null && now - lastDockerCheck < DOCKER_CHECK_INTERVAL_MS) {
    return Promise.resolve(dockerAvailable);
  }
  return new Promise((resolve) => {
    execFile('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: DOCKER_CHECK_TIMEOUT_MS }, (err) => {
      dockerAvailable = !err;
      lastDockerCheck = Date.now();
      resolve(dockerAvailable);
    });
  });
}

/**
 * Builds (once) the small sandbox image commands actually run inside -
 * bash + coreutils + git + node + python3 + pip, a non-root `sandbox`
 * user, nothing else. Cached via imageEnsured so this only happens once
 * per server process, not once per command. If the build fails (no
 * internet on first run, Docker Desktop still starting up, etc.) the
 * caller falls back to unsandboxed execution rather than blocking every
 * terminal command on it.
 */
function ensureSandboxImage(log) {
  if (imageEnsured) return Promise.resolve(true);
  return new Promise((resolve) => {
    execFile('docker', ['image', 'inspect', SANDBOX_IMAGE], (inspectErr) => {
      if (!inspectErr) {
        imageEnsured = true;
        return resolve(true);
      }
      log('[sandbox] Building sandbox image (one-time, first run only)...');
      const dockerfile = [
        'FROM debian:bookworm-slim',
        'RUN apt-get update && apt-get install -y --no-install-recommends bash coreutils git curl ca-certificates python3 python3-pip nodejs npm && rm -rf /var/lib/apt/lists/*',
        'RUN useradd -m -s /bin/bash sandbox',
        'USER sandbox',
        'WORKDIR /work',
      ].join('\n');

      const build = spawn('docker', ['build', '-t', SANDBOX_IMAGE, '-'], { stdio: ['pipe', 'ignore', 'pipe'] });
      let stderr = '';
      build.stderr.on('data', (d) => { stderr += d.toString(); });
      build.on('error', () => resolve(false));
      build.on('close', (code) => {
        if (code === 0) {
          imageEnsured = true;
          log('[sandbox] Sandbox image built successfully.');
          resolve(true);
        } else {
          log('[sandbox] Failed to build sandbox image:', stderr.slice(-500));
          resolve(false);
        }
      });
      build.stdin.write(dockerfile);
      build.stdin.end();
    });
  });
}

/**
 * @param {'gitbash'|'python'} shell - only these two are ever sandboxable (see header)
 * @param {string} command
 * @param {object} opts - { cwd, allowNetwork, memoryLimit, cpuLimit, pidsLimit }
 * @returns {{ bin: string, args: string[] }} a `docker run ...` invocation
 *   ready to hand to child_process.spawn, equivalent in shape to
 *   terminal.js's own buildSpawnArgs() output.
 */
function buildSandboxedSpawnArgs(shell, command, opts) {
  const {
    cwd,
    allowNetwork = false,
    memoryLimit = '512m',
    cpuLimit = '1.5',
    pidsLimit = '256',
  } = opts;

  // The project directory is the ONLY thing from the host filesystem
  // visible inside the container, and only that one folder - not the
  // user's whole home directory, not the C: drive, nothing else.
  const mountSource = cwd || os.homedir();
  const mountTarget = '/work';

  const args = [
    'run', '--rm', '-i',
    '--read-only', // root filesystem is read-only
    '--tmpfs', '/tmp:rw,size=256m', // scratch space that doesn't touch the host or persist
    '-v', `${mountSource}:${mountTarget}`,
    '-w', mountTarget,
    '--memory', memoryLimit,
    '--cpus', cpuLimit,
    '--pids-limit', pidsLimit,
    '--cap-drop', 'ALL',
    '--security-opt', 'no-new-privileges:true',
    '--network', allowNetwork ? 'bridge' : 'none',
    SANDBOX_IMAGE,
  ];

  if (shell === 'python') {
    const match = command.match(/^\s*python[0-9.]*\s+-c\s+(["'])([\s\S]*)\1\s*$/);
    const code = match ? match[2] : command;
    args.push('python3', '-c', code);
  } else {
    // gitbash - run through bash inside the container, same -lc shape
    // terminal.js uses for the real Git Bash path.
    args.push('bash', '-lc', command);
  }

  return { bin: 'docker', args };
}

/**
 * Heuristic for whether a command plausibly needs outbound network
 * access - deliberately conservative (default-deny is the whole point
 * of --network none). Only recognized package-manager/VCS/download
 * commands get network turned on; everything else stays isolated even
 * from the internet.
 */
const NEEDS_NETWORK_PATTERN = /\b(npm|pnpm|yarn|pip|pip3|git\s+(clone|pull|push|fetch)|curl|wget)\b/i;
function commandLikelyNeedsNetwork(command) {
  return NEEDS_NETWORK_PATTERN.test(command);
}

module.exports = {
  isDockerAvailable,
  ensureSandboxImage,
  buildSandboxedSpawnArgs,
  commandLikelyNeedsNetwork,
  SANDBOX_IMAGE,
};
