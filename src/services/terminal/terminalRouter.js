/**
 * ZAO - Terminal Router
 *
 * ZAO has TWO terminal tools, but they are NOT symmetric:
 *   - terminal_pc_run_command (pcTerminalTool.js) - the FULL terminal.
 *     The PC backend (server/terminal.js) auto-detects which shell a
 *     command actually needs - cmd.exe, PowerShell, Git Bash, or a raw
 *     Python interpreter - and runs it there. This is the default/
 *     primary terminal for everything: APK builds, Docker, AI inference,
 *     video processing, Android emulator, Visual Studio builds, npm/pip
 *     installs, git operations, PowerShell cmdlets, unix-style
 *     pipelines - the model never has to think about which shell, and
 *     no longer has to think "is this light enough for Termux" either.
 *   - terminal_termux_run_command (termuxTerminalTool.js) - FALLBACK
 *     ONLY, always-on-device. Used automatically when the PC is
 *     unreachable, or when the PC is reachable but has no internet
 *     right now and the command needs it.
 *
 * The model still needs real, current status to route the fallback
 * case correctly, since "is the PC backend up" and "does the PC have
 * internet right now" can both change between messages.
 * terminal_check_status (below) is that tool: a cheap call the model
 * makes before falling back to Termux, returning both PC reachability/
 * internet status and a plain-language routing hint.
 *
 * This mirrors the person's own mental model exactly:
 *   PC online + has internet   -> terminal_pc_run_command for
 *                                  everything, PC auto-picks the shell
 *   PC online + no internet    -> PC still fine for offline/local tasks
 *                                  (AI inference, local builds), but
 *                                  anything needing internet (npm
 *                                  install, git pull, downloads) should
 *                                  go to Termux instead
 *   PC unreachable             -> everything falls back to Termux;
 *                                  heavy PC-only tasks (APK build, Docker,
 *                                  emulator) simply aren't possible right
 *                                  now and the model should say so rather
 *                                  than attempting them on Termux
 */

import { checkBackendHealth } from '../backend/backendClient';

/**
 * @returns {Promise<{
 *   pcReachable: boolean,
 *   pcModelReady: boolean,
 *   pcInternetAvailable: boolean|null,
 *   recommendation: string
 * }>}
 */
export async function checkTerminalStatus() {
  const health = await checkBackendHealth();

  if (!health.connected) {
    return {
      pcReachable: false,
      pcModelReady: false,
      pcInternetAvailable: null,
      recommendation:
        "PC backend is unreachable right now. Use terminal_termux_run_command for everything until it's back - git pull, npm install, simple scripts, curl, ssh, downloads will work fine there. Heavy PC-only tasks (APK builds, Docker, Android emulator, video processing, Visual Studio builds, large model inference) are not possible until the PC backend is reachable again - tell the person clearly rather than attempting them on Termux.",
    };
  }

  // internetAvailable comes through checkBackendHealth() -> /health's
  // internetAvailable field once backendClient.js is updated to forward it
  // (see checkBackendHealth() in backendClient.js). null means the PC
  // backend hasn't completed its first internet self-check yet (~15s after
  // its own startup) - treat that like "unknown, assume available" rather
  // than blocking on it.
  const pcInternetAvailable = health.internetAvailable ?? null;

  if (pcInternetAvailable === false) {
    return {
      pcReachable: true,
      pcModelReady: health.ready,
      pcInternetAvailable: false,
      recommendation:
        "PC backend is reachable and is still the full terminal for everything offline (local file operations, already-downloaded builds, AI inference, local Docker/emulator work) - but the PC itself currently has no internet access. Route ONLY internet-dependent commands (npm install, pip install, git pull/clone/push, curl, downloads, anything hitting a remote registry or API) to terminal_termux_run_command instead; everything else stays on terminal_pc_run_command.",
    };
  }

  return {
    pcReachable: true,
    pcModelReady: health.ready,
    pcInternetAvailable: pcInternetAvailable === true ? true : null,
    recommendation:
      "PC backend is reachable and online. Use terminal_pc_run_command for everything - it auto-detects which shell (cmd/PowerShell/Git Bash/Python) each command needs. terminal_termux_run_command is fallback-only and shouldn't be used right now since the PC is fully available.",
  };
}
