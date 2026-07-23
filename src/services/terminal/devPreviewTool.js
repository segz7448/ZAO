/**
 * ZAO - Dev Server + Visual Preview Tool
 *
 * Closes a specific gap terminal_pc_run_command (pcTerminalTool.js)
 * can't: that tool runs a command to completion (or until its timeout
 * kills it), which is right for a build but wrong for a dev server -
 * `npm start`, `vite`, `expo start --web`, `python -m http.server`, etc.
 * never finish on their own. This tool starts one as its own tracked
 * background process on the PC (server/devPreview.js), detects the
 * local URL it prints, and then screenshots the actual rendered page
 * via the same shared Playwright Chromium instance the browser agent
 * already keeps running (server/browserAgent.js's getBrowser()) - so
 * the model can SEE whether HTML/CSS renders correctly instead of the
 * person checking manually or the model just reasoning from source.
 *
 * SAFETY: starting a dev server is still running a real shell command
 * on the PC, so it goes through the exact same two gates
 * terminal_pc_run_command uses before anything is spawned:
 *   1. commandSafety.js - regex-level catastrophic/risky command check.
 *   2. projectRunGate.js - syntax-checks the project before letting a
 *      start/serve/build command run, so a broken project doesn't get
 *      "started" only to crash immediately with a confusing error.
 * There is no separate sandbox for dev servers (unlike gitbash/python
 * commands in sandbox.js) - a dev server binds a real port and needs to
 * be reachable from the PC's own Chromium instance, which a network-
 * isolated container would block by default. It runs directly on the
 * host, same trust level as hostAccess: true would give a terminal
 * command.
 */

import { startDevServer as backendStartDevServer, screenshotDevPreview as backendScreenshotDevPreview, stopDevServer as backendStopDevServer } from '../backend/backendClient';
import { checkCommandSafety } from './commandSafety';
import { checkBeforeProjectRun } from '../execution/projectRunGate';
import { writeBinaryFileFromBase64 } from '../filesystem/filesystemTool';

const PREVIEW_FOLDER = 'zao-previews';

function previewFileName(finalUrl) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${PREVIEW_FOLDER}/preview-${stamp}.png`;
}

/**
 * Starts a dev server on the PC and waits for its local URL to be
 * detected (or for detection to time out, in which case the server is
 * left running rather than killed - see server/devPreview.js's header).
 * @param {string} command - e.g. "npm start", "vite", "python -m http.server 8000"
 * @param {object} [options] - { workingDirectory, port }
 * @returns {Promise<{success, data: {previewId, url, status, output, pid}|null, error}>}
 */
export async function startServer(command, options = {}) {
  const safety = checkCommandSafety(command);
  if (safety.blocked) {
    return { success: false, data: null, error: { message: safety.reason, blocked: true } };
  }
  if (safety.risky && !options.confirmed) {
    return { success: false, data: null, error: { message: safety.reason, needsConfirmation: true } };
  }

  const runGate = await checkBeforeProjectRun(command);
  if (runGate.blocked) {
    return { success: false, data: null, error: { message: runGate.reason, syntaxBlocked: true, failures: runGate.failures } };
  }

  const result = await backendStartDevServer(command, { cwd: options.workingDirectory || undefined, port: options.port || undefined });
  if (!result.success) {
    return { success: false, data: null, error: result.error };
  }

  const { previewId, url, status, output, pid, reused } = result.data;
  return { success: true, data: { previewId, url, status, output, pid, reused: !!reused }, error: null };
}

/**
 * Screenshots the rendered page of a running dev server (by previewId)
 * or any arbitrary URL, and saves it to the phone (under zao-previews/)
 * so the person can actually open and look at it.
 *
 * WHY IT'S SAVED RATHER THAN RETURNED INLINE: the local model driving
 * this tool loop is Qwen2.5-Coder-3B (see server/config.js) - text-only,
 * no vision input - so handing raw image bytes back into its own
 * tool-result context would be useless; there's nowhere for it to
 * "look" at them. Saving the PNG and returning its path plus real,
 * text-level signal (page title, HTTP status, browser console errors)
 * gives the model something it can actually reason about and relay
 * ("the page loaded but threw 2 console errors" / "got a 404"), while
 * the person gets the actual rendered screenshot to open themselves.
 *
 * @param {object} options - { previewId, url, fullPage, viewportWidth, viewportHeight }
 * @returns {Promise<{success, data: {path, title, finalUrl, httpStatus, consoleErrors}|null, error}>}
 */
export async function screenshot(options = {}) {
  if (!options.previewId && !options.url) {
    return { success: false, data: null, error: { message: 'Provide either previewId (of a running dev server) or an explicit url.' } };
  }
  const result = await backendScreenshotDevPreview(options);
  if (!result.success) {
    return { success: false, data: null, error: result.error };
  }
  const { screenshotBase64, title, finalUrl, httpStatus, consoleErrors } = result.data;

  const relativePath = previewFileName(finalUrl);
  const writeResult = await writeBinaryFileFromBase64(relativePath, screenshotBase64, 'image/png');
  if (!writeResult.success) {
    // The screenshot itself succeeded on the PC side - only saving it to
    // the phone failed (e.g. no filesystem access granted yet). Report
    // that distinctly rather than as a screenshot failure, since the
    // page-load signal (title/status/console errors) is still valid.
    return {
      success: false,
      data: { title, finalUrl, httpStatus, consoleErrors },
      error: { message: `Screenshot was taken but couldn't be saved to the phone: ${writeResult.error?.message || 'unknown error'}. Grant filesystem access in Settings if this keeps happening.` },
    };
  }

  return {
    success: true,
    data: { path: writeResult.data.path, title, finalUrl, httpStatus, consoleErrors },
    error: null,
  };
}

/**
 * Stops a dev server previously started with startServer().
 * @param {string} previewId
 * @returns {Promise<{success, data: {success, alreadyStopped}|null, error}>}
 */
export async function stopServer(previewId) {
  if (!previewId) {
    return { success: false, data: null, error: { message: 'previewId is required.' } };
  }
  const result = await backendStopDevServer(previewId);
  if (!result.success) {
    return { success: false, data: null, error: result.error };
  }
  return { success: true, data: result.data, error: null };
}
