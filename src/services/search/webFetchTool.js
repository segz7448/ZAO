/**
 * ZAO - Web Fetch Tool
 *
 * Claude Code's WebFetch equivalent: given a URL - one the person pasted,
 * or one that came back from a prior web_search call - actually retrieve
 * that page and return its readable text, instead of only ever seeing a
 * 1-2 line search snippet. The actual fetch/HTML-to-text extraction
 * happens on the PC backend (see server/webFetch.js); this file is just
 * the thin { success, data, error } wrapper toolOrchestrator.js's
 * TOOL_REGISTRY expects, same shape webSearchTool.js already uses.
 */

import { runWebFetch } from '../backend/backendClient';

/**
 * @param {string} url
 * @returns {Promise<{success, data: {url, finalUrl, title, text, truncated}|null, error}>}
 */
export async function fetchUrl(url) {
  if (!url || !url.trim()) {
    return { success: false, data: null, error: { message: 'A URL is required.' } };
  }
  return runWebFetch(url.trim());
}
