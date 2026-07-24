/**
 * ZAO - Chat Grounding Backstop
 *
 * WHY THIS EXISTS: intentClassifier.js decides up front whether a
 * message needs 'browsing' (real internet/PC-agent access) or 'general'
 * (plain chat completion, no tools at all - see reasoningEngine.js /
 * runReasoningChat). That's a single small-model classification call,
 * and it can be wrong - a plainly-phrased question like "what's today's
 * date" or "what's the weather in X" can get misjudged as 'general'
 * even with the sharpened prompt (see intentClassifier.js's own
 * browsing-vs-general tiebreaker). When that happens, the CHAT route
 * had NO tool access whatsoever and would silently answer from the raw
 * model's stale training data - exactly what produced a confidently
 * wrong "10/02/2023" date and an invented weather forecast in practice.
 *
 * This module is the backstop for exactly that failure mode: a second,
 * CHEAP check that runs at the very start of the CHAT route, using only
 * the two tools that are always safe/fast/available with no PC-agent
 * session required - time_get_current (on-device, instant, no network)
 * and web_search (a single network round-trip). If neither is needed,
 * this adds one extra cheap classifier call and nothing else; if one
 * IS needed, the real tool result gets folded into the message as
 * grounding text BEFORE the reasoning engine ever runs, so the model is
 * answering from a real fact instead of a guess.
 *
 * Deliberately NOT the full toolOrchestrator.js ReAct loop - that's a
 * much heavier multi-step pipeline built for file/git/terminal/office
 * work and requires its own routing ('github' intent). This is scoped
 * to exactly the two read-only, no-side-effect tools a plain chat
 * answer might need to not be wrong, so the common case (a message that
 * genuinely doesn't need either) still costs the same one extra cheap
 * classifier call every CHAT message already tolerates elsewhere in
 * this app (see intentClassifier.js/reasoningRouter.js's own pattern).
 */

import * as backendClient from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import * as timeTool from '../time/timeTool';
import * as webSearchTool from '../search/webSearchTool';

const BACKSTOP_SYSTEM_PROMPT = `A message is about to be answered by a language model with NO internet or clock access - it can only use what it already knows from training, which may be years stale. Decide if answering this WELL genuinely requires one of two things it doesn't have: the real current date/time, or a live web search. Respond with ONLY one JSON object, no markdown fences, no commentary:
{"needs": "time" | "search" | "neither", "timezone": "<IANA timezone or city/place name if needs is time, else empty string>", "searchQuery": "<a short search query if needs is search, else empty string>"}

Use "time" for any question about today's date, the current time (anywhere), or "what day is it". Use "search" for anything needing current/live information the model's training can't have (weather, news, prices, current events, "is X still true"). Use "neither" for anything else, including questions that sound like they might be time-related but aren't asking for the actual current date/time/weather (e.g. "how do timezones work", "what's the history of the calendar").`;

/**
 * @param {string} messageText
 * @returns {Promise<{ groundingNote: string|null }>} groundingNote is a
 *   short plain-text fact to prepend to the model's context (e.g. "The
 *   real current date/time is ..."), or null if nothing was needed or
 *   the check/tool call itself failed - always fails open, never blocks
 *   or throws, matching every other cheap classifier pass in this app
 *   (intentClassifier.js, agentLoop.js's verifyResolved).
 */
export async function getGroundingNote(messageText) {
  const text = (messageText || '').trim();
  if (!text) return { groundingNote: null };

  try {
    const history = [
      { role: 'system', content: BACKSTOP_SYSTEM_PROMPT },
      { role: 'user', content: text },
    ];
    const result = await backendClient.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
      maxTokens: 60,
      temperature: 0,
    });
    if (!result.success || !result.data?.content) return { groundingNote: null };

    const parsed = safeParseJson(result.data.content);
    if (!parsed || !['time', 'search', 'neither'].includes(parsed.needs)) return { groundingNote: null };

    if (parsed.needs === 'time') {
      const timeResult = timeTool.getCurrentTime(parsed.timezone?.trim() || null);
      if (!timeResult.success || !timeResult.data) return { groundingNote: null };
      const d = timeResult.data;
      return {
        groundingNote: `[Real current date/time, just checked - use this, not anything from your own training: ${d.formatted} (${d.zoneName})]`,
      };
    }

    if (parsed.needs === 'search') {
      const query = parsed.searchQuery?.trim() || text;
      const searchResult = await webSearchTool.search(query, 5);
      if (!searchResult.success || !searchResult.data) return { groundingNote: null };
      const snippet = summarizeSearchResults(searchResult.data);
      if (!snippet) return { groundingNote: null };
      return {
        groundingNote: `[Live web search results just now for "${query}" - use this current information, not anything from your own training, and mention it may not capture every detail:\n${snippet}]`,
      };
    }

    return { groundingNote: null };
  } catch (err) {
    // Fails open, same contract as every other cheap classifier pass in
    // this app - a broken backstop should never block the chat reply.
    return { groundingNote: null };
  }
}

function summarizeSearchResults(data) {
  const results = Array.isArray(data?.results) ? data.results : [];
  if (!results.length) return '';
  return results.slice(0, 5).map((r, i) => {
    const line = `${i + 1}. ${r.title || r.url || 'result'}${r.snippet ? ` - ${r.snippet}` : ''}`;
    return line.length > 220 ? `${line.slice(0, 217)}...` : line;
  }).join('\n');
}

function safeParseJson(rawContent) {
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
}
