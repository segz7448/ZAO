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
 * OUTPUT-SIDE ENFORCEMENT: the real-time system block in agentLoop.js
 * and the grounding notes above are still just TEXT the model reads -
 * a small local model can still ignore instructions, especially ones
 * about its own training cutoff, which is a hard habit to override
 * through prompting alone. This function is the part that doesn't
 * depend on the model cooperating at all: it scans the model's actual
 * output AFTER generation for the concrete patterns that show it fell
 * back to its training-era sense of "now" anyway (a stale year, or a
 * "my last update"-style hedge), and deterministically corrects the
 * reply in code - no second model call, no relying on it to self-
 * correct. This is the piece that's actually enforced rather than
 * requested.
 *
 * @param {string} replyText - the model's finished reply
 * @param {{formatted: string, zoneName: string}} realTime - this
 *   turn's real time data (same shape timeTool.getCurrentTime returns)
 * @returns {string} the reply, corrected if a stale-date pattern was found
 */
export function enforceRealTime(replyText, realTime) {
  if (!replyText || !realTime?.formatted) return replyText;

  let corrected = replyText;

  // Catch training-cutoff hedges like "as of my last update", "as of my
  // knowledge cutoff", "as of 2023/2024" etc. - these phrases are ALWAYS
  // wrong to say once a real-time stamp has been provided, regardless of
  // what year follows them, so this doesn't try to detect which years are
  // "stale" (that breaks the moment training data advances) - it removes
  // the hedge itself, since the model has no excuse to use it anymore.
  const hedgePattern = /\b(as of my (last update|knowledge cutoff|training data)|my (last update|training data) (was|is)|i don'?t have (real-?time|access to current) (information|data))\b[^.!?]*[.!?]/gi;
  if (hedgePattern.test(corrected)) {
    corrected = corrected.replace(hedgePattern, '').replace(/\s{2,}/g, ' ').trim();
  }

  // Catch an explicit stale year the model stated as "today"/"current"
  // that doesn't match the real year just provided - e.g. answering
  // "10/02/2023" when the real stamp says 2026. Only fires on a clear
  // current-date claim (today/current/right now + a year), not on any
  // year mentioned anywhere in the reply (a reply legitimately discussing
  // a past event's year should never be touched).
  const realYearMatch = realTime.formatted.match(/\b(20\d{2})\b/);
  const realYear = realYearMatch ? realYearMatch[1] : null;
  if (realYear) {
    const staleDateClaim = /\b(today'?s?|current(ly)?|right now)\b[^.!?\n]{0,40}\b(20\d{2})\b/gi;
    corrected = corrected.replace(staleDateClaim, (match, _p1, _p2, claimedYear) => {
      if (claimedYear === realYear) return match; // already correct, leave it
      return `${match.split(claimedYear)[0]}${realYear} (correcting a stale date - the real current date/time is ${realTime.formatted}, ${realTime.zoneName})`;
    });
  }

  return corrected;
}

// Broad net, deliberately over-inclusive: any of these words showing up
// ANYWHERE is enough to still pay for the classifier call below, since a
// false negative here (skipping the check when it was actually needed)
// is a real regression back to the original bug, while a false positive
// (running the classifier call when it wasn't needed) only costs the
// same one extra round-trip this function already cost before this
// pre-filter existed - never worse than the pre-fix baseline. Only a
// message with NONE of these words skips straight past the classifier
// call, onto the reasoning engine, saving the round-trip for the large
// share of ordinary CHAT messages (writing help, explanations, casual
// conversation) that have no plausible connection to current info at all.
const CURRENCY_SIGNAL_RE = /\b(today|now|current(ly)?|latest|recent(ly)?|this (?:week|month|year)|new(?:est)?|up.?to.?date|date|time|clock|weather|forecast|temperature|news|price|score|stock|release[ds]?|version|update[ds]?|still|when (?:is|does|will)|what (?:day|time|year)|right now)\b/i;

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

  // Speed: skip the classifier call entirely when nothing in the message
  // even plausibly relates to current info - see CURRENCY_SIGNAL_RE's
  // comment for why this is safe to skip rather than a coverage cut.
  if (!CURRENCY_SIGNAL_RE.test(text)) return { groundingNote: null };

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
