/**
 * ZAO - Terminal Status
 *
 * ZAO has exactly ONE terminal tool: terminal_pc_run_command
 * (pcTerminalTool.js) - the full terminal. The PC backend
 * (server/terminal.js) auto-detects which shell a command actually
 * needs - cmd.exe, PowerShell, Git Bash, or a raw Python interpreter -
 * and runs it there. This covers everything: APK builds, Docker, AI
 * inference, video processing, Android emulator, Visual Studio builds,
 * npm/pip installs, git operations, PowerShell cmdlets, unix-style
 * pipelines - the model never has to think about which shell.
 *
 * There is no on-device fallback terminal. If the PC backend is
 * unreachable, terminal commands simply cannot run right now - the
 * model should say so plainly rather than attempting a workaround.
 *
 * checkTerminalStatus() is a cheap call the model can make before a
 * terminal command if it isn't sure the PC is currently reachable,
 * returning both PC reachability/internet status and a plain-language
 * recommendation.
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
        "PC backend is unreachable right now, so terminal_pc_run_command cannot run anything - there is no fallback terminal. Tell the person clearly that the PC backend needs to be reachable (check that start.bat is running and the connection settings are correct) before any terminal command can be attempted.",
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
        "PC backend is reachable and terminal_pc_run_command still works for everything offline (local file operations, already-downloaded builds, AI inference, local Docker/emulator work) - but the PC itself currently has no internet access, so anything internet-dependent (npm install, pip install, git pull/clone/push, curl, downloads, anything hitting a remote registry or API) will fail until the PC's own internet connection is back. Tell the person if a requested command needs internet and this is the situation.",
    };
  }

  return {
    pcReachable: true,
    pcModelReady: health.ready,
    pcInternetAvailable: pcInternetAvailable === true ? true : null,
    recommendation:
      "PC backend is reachable and online. Use terminal_pc_run_command for everything - it auto-detects which shell (cmd/PowerShell/Git Bash/Python) each command needs.",
  };
}
