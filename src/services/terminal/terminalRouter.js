/**
 * ZAO - Terminal Status
 *
 * ZAO has exactly ONE terminal tool: terminal_pc_run_command
 * (pcTerminalTool.js) - the full terminal. The Alibaba Cloud VM backend
 * (server/terminal.js) auto-detects which shell a command actually
 * needs - bash, or a raw Python interpreter - and runs it there. This
 * covers everything: Docker, AI inference, video processing, npm/pip
 * installs, git operations, unix-style pipelines - the model never has
 * to think about which shell.
 *
 * There is no on-device fallback terminal. If the VM backend is
 * unreachable, terminal commands simply cannot run right now - the
 * model should say so plainly rather than attempting a workaround.
 *
 * checkTerminalStatus() is a cheap call the model can make before a
 * terminal command if it isn't sure the VM is currently reachable,
 * returning both VM reachability/internet status and a plain-language
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
        "VM backend is unreachable right now, so terminal_pc_run_command cannot run anything - there is no fallback terminal. Tell the person clearly that the VM backend needs to be reachable (check that the server is running on the VM and the connection settings are correct) before any terminal command can be attempted.",
    };
  }

  // internetAvailable comes through checkBackendHealth() -> /health's
  // internetAvailable field. null means the VM backend hasn't completed
  // its first internet self-check yet (~15s after its own startup) -
  // treat that like "unknown, assume available" rather than blocking on
  // it.
  const pcInternetAvailable = health.internetAvailable ?? null;

  if (pcInternetAvailable === false) {
    return {
      pcReachable: true,
      pcModelReady: health.ready,
      pcInternetAvailable: false,
      recommendation:
        "VM backend is reachable and terminal_pc_run_command still works for everything offline (local file operations, already-downloaded builds, AI inference, local Docker work) - but the VM itself currently has no internet access, so anything internet-dependent (npm install, pip install, git pull/clone/push, curl, downloads, anything hitting a remote registry or API) will fail until the VM's own internet connection is back. Tell the person if a requested command needs internet and this is the situation.",
    };
  }

  return {
    pcReachable: true,
    pcModelReady: health.ready,
    pcInternetAvailable: pcInternetAvailable === true ? true : null,
    recommendation:
      "VM backend is reachable and online. Use terminal_pc_run_command for everything - it auto-detects which shell (bash/Python) each command needs.",
  };
}
