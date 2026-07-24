/**
 * ZAO - Intent Classifier
 *
 * Decides WHICH EXECUTION MODE a message needs - 'github' (tool
 * orchestrator: repo/file/terminal/document actions), 'browsing' (live
 * web access), or 'general' (normal chat) - by actually asking the model
 * to understand the request, the same way a person reading the message
 * would, rather than scanning it for a fixed list of exact phrases.
 *
 * WHY THIS EXISTS: `localModels.js`'s original `classifyTask()` matched
 * literal substrings ('push to github', 'search the web', etc.) against
 * the lowercased message. That's brittle in the way any keyword list is
 * brittle - "put this up on my repo", "can you check what's live on
 * their site right now", "spin up a PR for this" all mean exactly the
 * same thing as their keyword-list counterparts but don't contain any
 * of the literal phrases, so they'd silently misroute to plain chat.
 * A professional agent shouldn't need the person to phrase things in a
 * way that happens to match a hardcoded list - it should understand the
 * request. This module makes that call with the model itself; the old
 * keyword list still exists (`localModels.js`'s `classifyTask()`) but
 * only as a degraded fallback for when the model call itself can't be
 * made (backend unreachable) - see `classifyIntent()` below.
 *
 * Kept as its own module (not folded into `orchestrator.js`) so any
 * other part of the app that needs "what kind of task is this" - a
 * future phase of the planning system included - can reuse the same
 * real classification instead of re-implementing keyword matching
 * elsewhere.
 */

import * as backendClient from './backend/backendClient';
import { MODEL_KEYS, classifyTask as classifyTaskByKeyword } from '../config/localModels';

const VALID_INTENTS = new Set(['github', 'browsing', 'general']);

const CLASSIFIER_SYSTEM_PROMPT = `Classify what this message actually needs, not what topic it's about. Respond with ONLY one JSON object, no markdown fences, no commentary:
{"intent": "github" | "browsing" | "general"}

- "github": the message is asking for a concrete WRITE action to actually be carried out - creating/editing/deleting a real file or folder, pushing/committing/branching/releasing on GitHub, running a terminal command, or producing a real PDF/Word/Excel/PowerPoint/zip file. Something must actually be built, changed, or run on the device or repo, not just found or explained.
- "browsing": the message needs real, CURRENT information from the live internet that the model's own training can't reliably answer - a specific webpage's current content, today's news, a current price, today's/current weather, the current date or time, checking whether something is still true right now, or an explicit instruction to search/browse/visit/check a site. Purely looking something up or checking on something, with nothing being built or changed, is "browsing" even if the person also wants it summarized or explained afterward - that's still just reading, not writing. Treat ANY question about the CURRENT/TODAY's date, time, or weather as "browsing", never "general" - a model's training data goes stale the moment it's trained, so it can never answer these from what it "knows," no matter how ordinary or simple the question sounds.
- "general": everything else - questions answerable from general knowledge that does NOT go stale (historical facts, how something works, math, definitions), requests to write/explain/plan/brainstorm/debug-in-place, casual conversation, or coding help that doesn't require actually running anything.

If a message could plausibly fit two categories, prefer whichever one is CHEAPER to get wrong. Between "browsing" and "github": "browsing" is one extra step; "github" can kick off a much larger multi-step plan, so when genuinely unsure between the two, pick "browsing" - a pure lookup/check request should never be escalated into a build/change/run pipeline on a guess. Only pick "github" when the message is unambiguous about wanting something actually created, changed, or run. Between "browsing" and "general": a wrong "general" guess means confidently fabricating something that looks current but is actually stale or invented (dates, weather, prices, news) with no indication anything is wrong; a wrong "browsing" guess just costs one extra lookup step. So when unsure between "browsing" and "general", also pick "browsing" - the cost of silently making something up is always worse than the cost of double-checking something that turns out to be timeless.`;

/**
 * @param {string} messageText
 * @param {object} [options]
 * @param {boolean} [options.browserAgentActive] - true if the person
 *   currently has a live browser agent session open (see App.js's
 *   `browserAgentActive` - the full-screen view is open, a task is
 *   running, or one is awaiting human input). Passed through as extra
 *   context for the model to weigh, not a hard override - a message
 *   sent while browsing is open that's genuinely unrelated (e.g. "what's
 *   7 times 8") should still classify as "general", this just tips
 *   genuinely ambiguous cases toward "browsing" rather than "github",
 *   since the person is right there watching a live browser session and
 *   a message like "check their pricing page too" almost certainly means
 *   "browsing", not "create a file."
 * @returns {Promise<'github'|'browsing'|'general'>}
 */
export async function classifyIntent(messageText, options = {}) {
  const text = (messageText || '').trim();
  if (!text) return 'general';

  const { browserAgentActive = false } = options;
  const userContent = browserAgentActive
    ? `[Context: the person currently has a live browser agent session open on their PC and is watching it.]\n\n${text}`
    : text;

  const history = [
    { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
    { role: 'user', content: userContent },
  ];

  try {
    const result = await backendClient.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
      maxTokens: 20,
      temperature: 0,
    });

    if (result.success && result.data?.content) {
      const parsed = safeParseIntentJson(result.data.content);
      if (parsed && VALID_INTENTS.has(parsed.intent)) {
        return parsed.intent;
      }
    }
  } catch (err) {
    // Falls through to the keyword fallback below - a classification
    // failure should never block the message from being handled somehow.
  }

  // Fallback: the model call failed outright (backend unreachable,
  // timed out) or returned something unparseable. Degraded, but keeps
  // the app usable rather than defaulting to 'general' and silently
  // skipping a github/browsing task the person actually wanted acted on.
  return classifyTaskByKeyword(text);
}

function safeParseIntentJson(rawContent) {
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}
