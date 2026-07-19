/**
 * ZAO - Terminal Router
 *
 * ZAO has TWO terminal tools:
 *   - terminal_pc_run_command (pcTerminalTool.js) - full system access on
 *     the person's PC: Git Bash/cmd/PowerShell, APK builds, Docker, AI
 *     inference, video processing, Android emulator, Visual Studio builds.
 *   - terminal_termux_run_command (termuxTerminalTool.js) - lightweight,
 *     always-on-device: git pull, npm install, simple Python scripts,
 *     curl, ssh, small file downloads. Also the automatic fallback when
 *     the PC is unreachable or offline.
 *
 * The model decides which one to use per task (see toolOrchestrator.js's
 * system prompt) rather than the app hard-routing by keyword - but it
 * needs real, current status to decide well, since "is the PC backend up"
 * and "does the PC have internet right now" can both change between
 * messages. terminal_check_status (below) is that tool: a cheap call the
 * model can make before deciding, returning both PC reachability/internet
 * status and a plain-language routing hint.
 *
 * This mirrors the person's own mental model exactly:
 *   PC online + has internet   -> heavy tasks and internet-dependent PC
 *                                  tasks both fine on PC
 *   PC online + no internet    -> PC still fine for offline/local tasks
 *                                  (AI inference, local builds), but
 *                                  anything needing internet (npm install,
 *                                  git pull, downloads) should go to
 *                                  Termux instead
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
        "PC backend is unreachable right now. Use terminal_termux_run_command for everything - lightweight tasks (git pull, npm install, simple scripts, curl, ssh, downloads) will work fine there. Heavy PC-only tasks (APK builds, Docker, Android emulator, video processing, Visual Studio builds, large model inference) are not possible until the PC backend is reachable again - tell the person clearly rather than attempting them on Termux.",
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
        "PC backend is reachable but the PC itself currently has no internet access. Route internet-dependent commands (npm install, pip install, git pull/clone/push, curl, downloads, anything hitting a remote registry or API) to terminal_termux_run_command instead. Purely local/offline PC tasks (AI inference already running, local file operations, already-downloaded builds) can still use terminal_pc_run_command.",
    };
  }

  return {
    pcReachable: true,
    pcModelReady: health.ready,
    pcInternetAvailable: pcInternetAvailable === true ? true : null,
    recommendation:
      "PC backend is reachable and online. Use terminal_pc_run_command for heavy tasks (APK builds, Docker, Android emulator, video processing, Visual Studio builds, anything needing the PC's full toolchain) and terminal_termux_run_command for small, fast, lightweight tasks (git pull, quick npm install, simple scripts, curl, ssh) - either works when both are healthy, so prefer whichever is simpler/faster for the specific task.",
  };
}
