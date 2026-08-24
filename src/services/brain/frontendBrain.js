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
  DEEP_RESEARCH: 'deep_research',         // -> multi-search research report, no browser agent
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
const QUICK_LOOKUP_PATTERN = /\b(what(?:'s|s| is) (?:today'?s?|the current) date|what day is it|what time is it|current time|today'?s (?:date|weather)|weather (?:today|right now|in \w+)|current weather|latest news|today'?s news|news today|stock price|share price|(?:exchange|conversion) rate|how much is \d|current price of|score of the|final score|who won the (?:game|match)|is .+ still (?:alive|around|in business|the ceo|the president|active|available)|does .+ still exist)\b/i;

function isQuickLookupQuery(messageText) {
  return QUICK_LOOKUP_PATTERN.test((messageText || '').trim());
}

/**
 * Same free/local convention as isQuickLookupQuery, for the opposite
 * end of the spectrum - an explicit ask for a proper researched report
 * (ChatGPT/Claude's "Deep Research" mode), not a one-fact lookup. Kept
 * to clear trigger phrasings so an ordinary "what's the weather" never
 * accidentally balloons into a multi-search report.
 */
const DEEP_RESEARCH_PATTERN = /\b(deep research|research report|comprehensive report|write (?:me )?a report on|do (?:a |some )?(?:deep dive|research) on|research .+ (?:for me|thoroughly)|in[- ]depth (?:research|analysis|report) on)\b/i;

function isDeepResearchQuery(messageText) {
  return DEEP_RESEARCH_PATTERN.test((messageText || '').trim());
}

/**
 * Free, local, no-model-call check for an explicit "go navigate the live
 * browser somewhere" instruction - "go to facebook.com", "open
 * twitter", "visit their pricing page", "navigate to reddit.com". This
 * is unambiguous in a way classifyIntent() sometimes isn't: the small
 * Ox Alpha model, asked to classify a bare "Go to Facebook" with no
 * other context, has been observed guessing "general" (answering as
 * plain chat, "I'm a text-based assistant, open your own browser") even
 * though the classifier's own system prompt already calls "an explicit
 * instruction to search/browse/visit/check a site" browsing - the
 * *reason* it should be caught on the free heuristic here rather than
 * left to that one model call. Deliberately requires one of a handful
 * of literal navigation verbs (not just any site-sounding message), so
 * this stays narrow the same way isQuickLookupQuery/isDeepResearchQuery
 * are narrow - a wrong guess here means real browser-agent steps get
 * spent on something that wasn't actually a navigation request.
 */
const EXPLICIT_BROWSE_PATTERN = /\b(?:go to|open|visit|navigate to|browse to|pull up|check out)\b\s+(?:the\s+)?(?:[\w.-]+\.(?:com|org|net|io|co|dev|gov|edu)\b|(?:facebook|instagram|twitter|x\.com|tiktok|youtube|reddit|linkedin|amazon|google|wikipedia|github|gmail|netflix|spotify)\b)/i;

function isExplicitBrowseQuery(messageText) {
  return EXPLICIT_BROWSE_PATTERN.test((messageText || '').trim());
}

/**
 * Loose match for "this message is plausibly about GitHub/the repo" -
 * used only when options.githubToolsEnabled is true (the person
 * explicitly turned the composer's GitHub toggle on for this message).
 * Intentionally broad: better to over-catch here, since a false match
 * just means this hands the message to the real 'github' pipeline
 * (HIERARCHICAL_PLAN, which still reasons about what to actually do)
 * instead of leaving it to classifyIntent()'s own guess - a false MISS
 * is the real cost, since that's the exact failure mode reported: the
 * model answering "I don't have GitHub access, go check github.com
 * yourself" for a message that plainly wanted a real GitHub action.
 */
const GITHUB_INTENT_PATTERN = /\b(github|repo|repository|commit|branch|pull request|\bpr\b|push|clone|merge|issue|release|my (?:code|project|files?))\b/i;

function isGithubFlavoredQuery(messageText) {
  return GITHUB_INTENT_PATTERN.test((messageText || '').trim());
}

/**
 * Deliberately narrow set of exact conversational openers/closers -
 * greetings, thanks, small talk - matched as the WHOLE message (with
 * light punctuation tolerance), not a substring. "hi" fast-paths; "hi,
 * can you also check my repo" does not, since it's no longer
 * unambiguous. See decideRoute()'s fast-path comment for why narrow
 * beats clever here.
 */
const PLAIN_CHAT_FAST_PATH = /^(hi|hello|hey|hiya|yo|sup|good (?:morning|afternoon|evening|night)|thanks|thank you|thx|ty|cool|nice|ok|okay|got it|sounds good|lol|lmao|haha|how are you\??|how'?s it going\??|what'?s up\??|who are you\??|what can you do\??)[.!?]*$/i;

export async function decideRoute(messageText, priorAttempts = [], options = {}) {
  const { githubToolsEnabled = false } = options;

  if (githubToolsEnabled && isGithubFlavoredQuery(messageText) && !priorAttempts.includes(BRAIN_ROUTES.HIERARCHICAL_PLAN)) {
    // The person explicitly turned GitHub tools on for this message -
    // don't leave it to classifyIntent()'s guess (see
    // isGithubFlavoredQuery's own comment for the exact failure mode
    // this closes). shouldDecompose still runs so a genuinely large
    // goal still gets the right decomposition treatment underneath.
    const decomposition = shouldDecompose(messageText);
    return {
      route: BRAIN_ROUTES.HIERARCHICAL_PLAN,
      intent: 'github',
      decompose: decomposition.decompose,
      reason: 'GitHub tools explicitly enabled for this message and it mentions the repo/GitHub - routing with confidence rather than guessing.',
    };
  }

  if (isDeepResearchQuery(messageText) && !priorAttempts.includes(BRAIN_ROUTES.DEEP_RESEARCH)) {
    return { route: BRAIN_ROUTES.DEEP_RESEARCH, intent: 'browsing', decompose: false, reason: 'Explicit request for a researched report - running multiple searches, not a single lookup.' };
  }

  if (isQuickLookupQuery(messageText) && !priorAttempts.includes(BRAIN_ROUTES.QUICK_LOOKUP)) {
    return { route: BRAIN_ROUTES.QUICK_LOOKUP, intent: 'browsing', decompose: false, reason: 'Simple current-info lookup (date/time/weather/news) - a quick tool call, not the full browser agent.' };
  }

  if (isExplicitBrowseQuery(messageText) && !priorAttempts.includes(BRAIN_ROUTES.BROWSING)) {
    return { route: BRAIN_ROUTES.BROWSING, intent: 'browsing', decompose: false, reason: 'Explicit "go to/open/visit a site" instruction - routing with confidence rather than leaving it to the classifier.' };
  }

  // FAST PATH: skip the classifier model call entirely for messages that
  // are unmistakably plain conversation - no realistic reading of these
  // needs a tool, a file written, or live data, so paying for a whole
  // extra model round-trip just to confirm "yes, this is chat" is pure
  // added latency with nothing gained. This is deliberately narrow
  // (short, exact conversational openers/closers) rather than any
  // length- or keyword-based guess - a wrong guess here means silently
  // skipping a github/browsing action the person actually wanted, so
  // this only fires for phrasings that couldn't reasonably mean
  // anything else. Everything else still goes through classifyIntent
  // exactly as before.
  if (PLAIN_CHAT_FAST_PATH.test((messageText || '').trim()) && !priorAttempts.length) {
    return { route: BRAIN_ROUTES.CHAT, intent: 'general', decompose: false, reason: 'Plain conversational message - skipped the classifier call.' };
  }

  const intent = await classifyIntent(messageText, { browserAgentActive: options.browserAgentActive, githubToolsEnabled });

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
