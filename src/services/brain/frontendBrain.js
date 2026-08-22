/**
 * ZAO - Frontend Brain (the "reflex layer")
 *
 * Runs on the phone, in-process with the UI. Its job is the cheap part
 * of "what should happen with this message" - the part that either
 * needs no model call at all (shouldDecompose's heuristic, from
 * src/services/planning/planTypes.js) or a single fast ROUTER-role call
 * (classifyIntent, from src/services/intentClassifier.js) - so
 * orchestrator.js has one place to ask "what kind of thing is this"
 * instead of re-deriving that answer at every call site.
 *
 * This is deliberately thin: it does NOT run the plan, call tools, or
 * talk to the browser agent - it only decides which of the backend
 * brain's paths (src/services/brain/backendBrain.js) a message should
 * take. See brainTypes.js for how this fits the frontend/backend brain
 * split.
 */

import { classifyIntent } from '../intentClassifier';
import { shouldDecompose } from '../planning/planTypes';

/** Every route frontendBrain.decideRoute() can hand back to orchestrator.js. */
export const BRAIN_ROUTES = Object.freeze({
  HIERARCHICAL_PLAN: 'hierarchical_plan', // -> backendBrain.runHierarchicalPlan (HYBRID_SYMBOLIC_NEURAL)
  QUICK_LOOKUP: 'quick_lookup',           // -> a single flat tool call (web_search / time_get_current) - NOT the visual browser agent
  BROWSING: 'browsing',                   // -> the live PC browser agent
  CHAT: 'chat',                           // -> plain CONVERSATIONALIST completion
});

/**
 * Decides which backend path a message should take. Two signals feed
 * this, deliberately in cheapest-first order:
 *
 *   1. shouldDecompose(messageText) - free, local, no model call. Only
 *      matters for tool-flavored requests (a "decompose"-worthy signal
 *      on a browsing or plain-chat message doesn't change anything -
 *      there's no bigger version of "check today's news" to plan).
 *   2. classifyIntent(messageText) - one ROUTER-role model call
 *      (src/services/intentClassifier.js), same call this always made;
 *      frontendBrain.js doesn't add a second model round-trip, it just
 *      also consults the free heuristic before returning.
 *
 * As of agentLoop.js, this is no longer necessarily the ONLY routing
 * call for a message - agentLoop.js calls it once per iteration of its
 * gather->act->verify loop, passing what's been tried so far as
 * `priorAttempts` so a route already tried (and found insufficient by
 * the loop's verify step) isn't just re-picked forever. Passing no
 * `priorAttempts` (every pre-existing call site) keeps the original
 * one-shot behavior exactly as before.
 *
 * @param {string} messageText
 * @param {Array<string>} [priorAttempts] - routes already tried this
 *   turn (BRAIN_ROUTES values), most-recent last. When the freshly
 *   classified route is already in here, this nudges toward the next
 *   most specific route instead of repeating one that didn't resolve
 *   things, since a route that already ran and got flagged
 *   insufficient by agentLoop.js's verify step needs to be answered
 *   with something DIFFERENT, not the same action again.
 * @param {object} [options]
 * @param {boolean} [options.browserAgentActive] - passed straight
 *   through to classifyIntent() as extra context (see that function's
 *   own JSDoc) - true when the person currently has a live browser
 *   agent session open, so a genuinely ambiguous message tips toward
 *   "browsing" instead of escalating into the much slower
 *   HIERARCHICAL_PLAN pipeline on a guess.
 * @returns {Promise<{ route: string, intent: 'github'|'browsing'|'general', decompose: boolean, reason: string }>}
 */
/**
 * Free, local, no-model-call check for the specific class of "current
 * info" question that a single web_search or time_get_current tool call
 * fully answers - a plain date/time/weather/news lookup, nothing that
 * needs a real page interacted with (clicking, logging in, filling a
 * form, reading a specific site the person named). classifyIntent()'s
 * own prompt correctly tells the model these ARE "browsing" (they need
 * live data, not the model's stale training), but historically
 * BRAIN_ROUTES.BROWSING meant one specific, heavy thing - opening the
 * live Playwright browser agent (see runBrowsingHandler in
 * orchestrator.js) - for every one of them, even "what's today's date."
 * This heuristic catches the common, genuinely simple cases and routes
 * them to QUICK_LOOKUP instead, which runs a single flat tool call
 * (web_search / time_get_current, see runQuickLookupHandler) with no
 * visual browser session at all. Anything this pattern doesn't match
 * still falls through to the model classifier and, if genuinely
 * "browsing", the full agent - this is intentionally narrow (a few
 * clear phrasings) rather than trying to replace classifyIntent()
 * entirely, so it only takes over the easy, unambiguous cases.
 */
const QUICK_LOOKUP_PATTERN = /\b(what(?:'s|s| is) (?:today'?s?|the current) date|what day is it|what time is it|current time|today'?s (?:date|weather)|weather (?:today|right now|in \w+)|current weather|latest news|today'?s news|news today)\b/i;

function isQuickLookupQuery(messageText) {
  return QUICK_LOOKUP_PATTERN.test((messageText || '').trim());
}

export async function decideRoute(messageText, priorAttempts = [], options = {}) {
  if (isQuickLookupQuery(messageText) && !priorAttempts.includes(BRAIN_ROUTES.QUICK_LOOKUP)) {
    return { route: BRAIN_ROUTES.QUICK_LOOKUP, intent: 'browsing', decompose: false, reason: 'Simple current-info lookup (date/time/weather/news) - a quick tool call, not the full browser agent.' };
  }

  const intent = await classifyIntent(messageText, { browserAgentActive: options.browserAgentActive });

  if (intent === 'browsing') {
    if (priorAttempts.includes(BRAIN_ROUTES.BROWSING)) {
      // Browsing already ran this turn and the loop's verify step still
      // flagged something outstanding - browsing itself can't produce a
      // different outcome by running again unchanged, so hand back to
      // CHAT to at least synthesize an answer from what's already been
      // gathered rather than repeating the same action.
      return { route: BRAIN_ROUTES.CHAT, intent, decompose: false, reason: 'Already browsed this turn - answering from what was found.' };
    }
    return { route: BRAIN_ROUTES.BROWSING, intent, decompose: false, reason: 'Needs live web access.' };
  }

  if (intent === 'github') {
    const decomposition = shouldDecompose(messageText);

    // Always HIERARCHICAL_PLAN now, big goal or small - see this
    // function's own comment above and planCoordinator.js's
    // "COLLAPSING FOR SIMPLE REQUESTS" section for why a small request
    // isn't any more expensive to plan than before, it just now also
    // gets a propose-and-approve gate before anything runs.
    if (priorAttempts.includes(BRAIN_ROUTES.HIERARCHICAL_PLAN)) {
      // Already tried and agentLoop.js's verify step still found
      // something unresolved - re-planning the identical request won't
      // change that outcome, so fall through to CHAT to synthesize an
      // answer from whatever was already gathered rather than looping.
      return { route: BRAIN_ROUTES.CHAT, intent, decompose: false, reason: 'Already attempted this turn - answering from what was done so far.' };
    }

    return {
      route: BRAIN_ROUTES.HIERARCHICAL_PLAN,
      intent,
      decompose: decomposition.decompose,
      reason: decomposition.reason,
    };
  }

  return { route: BRAIN_ROUTES.CHAT, intent, decompose: false, reason: 'General chat - no action or live data needed.' };
}
