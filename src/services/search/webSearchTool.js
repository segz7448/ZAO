/**
 * ZAO - Web Search Tool
 *
 * This is Claude Code's WebSearch equivalent: real, current information
 * from the open web, callable by the local coder model as an ordinary
 * tool_call - no API key on the phone, no cloud search vendor tied into
 * the app itself. The actual fetch/parse happens on the PC backend (see
 * server/webSearch.js); this file is just the thin { success, data,
 * error } wrapper toolOrchestrator.js's TOOL_REGISTRY expects, same
 * shape every other tool module in this repo uses.
 */

import { runWebSearch } from '../backend/backendClient';

/**
 * @param {string} query
 * @param {number} [maxResults]
 * @returns {Promise<{success, data: {query, results: Array<{title,url,snippet}>}|null, error}>}
 */
export async function search(query, maxResults = 5) {
  if (!query || !query.trim()) {
    return { success: false, data: null, error: { message: 'A search query is required.' } };
  }
  return runWebSearch(query.trim(), maxResults);
}
