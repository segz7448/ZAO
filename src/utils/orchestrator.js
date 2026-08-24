/**
 * ZAO - Orchestrator
 *
 * The single entry point the UI calls to "send a message and get a
 * response." Everything text-based goes to the one Ox Alpha model
 * served by the PC backend (src/services/backend/backendClient.js) -
 * no manual mode, no fallback chain, no per-task model switching.
 *
 * Images and video ARE understood by the model: Ox Alpha has native
 * vision/video input, so an attached image/video is base64-encoded and
 * sent as an image_url/video_url content part directly on the outbound
 * message (see chatStore.js's buildMultimodalContent() and
 * fileProcessor.js's processImage/processVideo) - no separate OCR or
 * vision model, no fallback chain, just Ox Alpha reading the actual
 * pixels. (There is still no image GENERATION/editing - only input.)
 * Camera/gallery/file attachments also still work for sending files INTO
 * tool tasks (e.g. "zip this file", "push this to GitHub") the same as
 * before.
 *
 * Contract: sendMessageOrchestrated() NEVER throws. It always resolves to a
 * result object. The UI only needs to handle one shape.
 *
 * ROUTING, AS OF agentLoop.js: this file used to make ONE routing
 * decision (frontendBrain.decideRoute()) and execute exactly that route.
 * The routing/execution now lives in src/services/brain/agentLoop.js,
 * which runs a real gather -> act -> verify LOOP: it can decide a
 * message needs a tool task, run it, notice (via a cheap verify call)
 * that part of the request is still unresolved, and re-route to
 * browsing or another tool step within the SAME turn - rather than
 * committing to one route up front and stopping there regardless of
 * whether it actually satisfied the request. This file's job is now
 * just to build the THREE route handlers agentLoop.js calls
 * (runChat/runBrowsing/runHierarchicalPlan, matching frontendBrain.js's
 * BRAIN_ROUTES exactly) and adapt their results back to the { success,
 * data, error } shape the UI expects - the external contract below is
 * unchanged from before agentLoop.js existed.
 *
 * NOTE ON toolOrchestrator.js's runToolTask(): there is deliberately no
 * fourth "runToolTask" handler here. frontendBrain.js routes every
 * tool-flavored ('github' intent) message to HIERARCHICAL_PLAN
 * unconditionally now, even a one-step request (see its own comment on
 * why - the propose-and-approve gate applies equally regardless of plan
 * size), so runToolTask()'s flat ReAct loop is no longer reachable as a
 * TOP-LEVEL chat route at all. It's still very much alive as a
 * primitive: subagentManager.js's spawnSubagents() calls it directly to
 * run each isolated subagent, which is itself only ever invoked FROM
 * inside a hierarchical plan step (the agent_spawn_subagents tool,
 * gated the same way any other plan step is). If a direct,
 * un-gated single-shot tool route is ever wanted back as a real chat
 * route, it needs its own BRAIN_ROUTES entry in frontendBrain.js and a
 * handler here - it was never actually wired that way in this app.
 */

import { logUsageEvent, getApiKey } from '../db/database';
import {
  getModelKeyForTask,
  ACTIVE_MODEL,
  MODEL_KEYS,
} from '../config/localModels';
import { usePreferencesStore } from '../store/preferencesStore';
import { runAgentLoop } from '../services/brain/agentLoop';
import { runHierarchicalPlan } from '../services/brain/backendBrain';
import { runReasoningChat, STRATEGY_FOR_ROUTE } from '../services/reasoning/reasoningEngine';
import { getGroundingNote, enforceRealTime } from '../services/reasoning/chatGroundingBackstop';
import * as timeTool from '../services/time/timeTool';
import * as webSearchTool from '../services/search/webSearchTool';
import * as webFetchTool from '../services/search/webFetchTool';
import * as backendClient from '../services/backend/backendClient';

/**
 * Renders standingContext (system-role blocks from
 * projectInstructions.js/autoMemoryNotes.js, see agentLoop.js) as a
 * plain-text preface for the three routes that take a bare message
 * string rather than a {role,content} history array. CHAT gets the
 * cleaner treatment (real system-role messages prepended to history,
 * see runChatHandler below) since it already works with a full history
 * array; these three don't, and reworking their internals to accept a
 * separate context array is a bigger change than this pass makes.
 */
function withStandingContextPreface(message, standingContext) {
  if (!standingContext?.length) return message;
  const preface = standingContext.map((block) => block.content).join('\n\n');
  return `${preface}\n\n---\n\n${message}`;
}

/**
 * @param {object} params
 * @param {Array<{role, content}>} params.history - full conversation so far, including the new user message
 * @param {string} [params.lastMessageText] - used for task classification
 * @param {boolean} [params.browserAccessEnabled] - the composer bar's globe toggle's
 *   current persisted state (see src/store/preferencesStore.js). No longer a hard
 *   precondition for browsing - if `agentSession` is live, a browsing-classified message
 *   uses it regardless of this flag, and the flag gets synced to true afterward. This
 *   param mainly exists so the toggle's displayed state can be kept in sync with reality;
 *   the real gate is whether agentSession exists (see the PC BROWSER AGENT section below).
 * @param {boolean} [params.webSearchEnabled] - the composer bar's web-search toggle's
 *   current state for this message (see ChatScreen.js). web_search is always available to
 *   the model as a tool regardless of this flag - this only adds a standing-context hint
 *   (agentLoop.js) nudging the model to actually use it this turn rather than answer from
 *   what it already knows.
 * @param {boolean} [params.browserAgentActive] - true when the person currently has a live
 *   browser agent session open (the full-screen view, a running task, or one awaiting human
 *   input - see App.js). Passed through to frontendBrain.js's decideRoute() as extra
 *   classifier context, so a genuinely ambiguous message tips toward the fast BROWSING route
 *   instead of getting escalated into the much slower HIERARCHICAL_PLAN pipeline on a guess.
 * @param {object} [params.agentSession] - the connected BrowserAgentStream instance
 *   (src/services/browserAgent/browserAgentStream.js), created once at the App level and
 *   held for the lifetime of the browser-agent PiP so a session's browser state/history
 *   (held on the PC) survives across multiple separate tasks in the same conversation.
 * @param {function} [params.onBrowserStep] - callback fired per completed browser-agent step
 * @param {string} [params.githubUsername] - hint passed to the tool orchestrator so the coder model
 *   doesn't have to ask "whose account?" on every request
 * @param {function} [params.onGithubStep] - callback fired per completed tool-orchestrator step
 * @param {string} [params.conversationId] - the active conversation, threaded through to
 *   planCoordinator.js so a hierarchical plan (see the HIERARCHICAL PLAN section below) is
 *   associated with the conversation it came from, same as any other plan created via PlanScreen.
 * @param {function} [params.onPlanProgress] - callback fired with a short stage label
 *   ("Breaking the goal into projects…", etc.) while a plan is being BUILT (planCoordinator.js)
 * @param {function} [params.onPlanStep] - callback fired per completed step while a plan is RUNNING (planExecutor.js)
 * @param {function} [params.isCancelled] - returns true once the person has asked to stop;
 *   checked by agentLoop.js between loop iterations (see its own header for why only between,
 *   never mid-iteration).
 * @param {function} [params.onLoopStep] - fired once per agentLoop.js iteration with
 *   { route, reason, iteration }, for a UI indicator distinct from each route's own step callback.
 * @param {function} [params.onToken] - fired with the in-progress reply text as it streams in.
 *   Only the CHAT route actually produces incremental text (see reasoningEngine.js's
 *   runReasoningChat JSDoc for which reasoning strategies do/don't stream) - the other
 *   three routes ignore this and keep using their own step callbacks
 *   (onGithubStep/onBrowserStep/onPlanStep/onPlanProgress) instead, since a tool task,
 *   browsing session, or hierarchical plan doesn't have a single streaming completion to
 *   expose in the first place.
 * @param {function} [params.onThinkingToken] - fired with the model's in-progress
 *   reasoning text while it's still inside <thinking>, before onToken starts firing for
 *   the actual answer. Same CHAT-route-only caveat as onToken above.
 *
 * @returns {Promise<{
 *   success: boolean,
 *   data: { content: string, family: string, provider: string, modelId: string, planId?: string } | null,
 *   error: { type: string, message: string } | null,
 * }>}
 */
export async function sendMessageOrchestrated({
  history,
  lastMessageText = '',
  browserAccessEnabled = false,
  browserAgentActive = false,
  webSearchEnabled = false,
  githubToolsEnabled = false,
  agentSession = null,
  onBrowserStep = null,
  githubUsername = null,
  onGithubStep = null,
  conversationId = null,
  onPlanProgress = null,
  onPlanStep = null,
  isCancelled = () => false,
  onLoopStep = null,
  onToken = null,
  onThinkingToken = null,
}) {
  try {
    if (!Array.isArray(history) || history.length === 0) {
      return {
        success: false,
        data: null,
        error: { type: 'BAD_REQUEST', message: 'No conversation history provided' },
      };
    }

    const params = {
      history,
      lastMessageText,
      browserAccessEnabled,
      browserAgentActive,
      webSearchEnabled,
      githubToolsEnabled,
      agentSession,
      onBrowserStep,
      githubUsername,
      onGithubStep,
      conversationId,
      onPlanProgress,
      onPlanStep,
      onToken,
      onThinkingToken,
    };

    const handlers = {
      runHierarchicalPlan: runHierarchicalPlanHandler,
      runDeepResearch: runDeepResearchHandler,
      runQuickLookup: runQuickLookupHandler,
      runBrowsing: runBrowsingHandler,
      runChat: runChatHandler,
    };

    return await runAgentLoop(params, handlers, { isCancelled, onLoopStep });
  } catch (err) {
    // Absolute last-resort catch. The UI should never see an uncaught exception
    // from this function, no matter what goes wrong internally.
    console.error('[Orchestrator] Unexpected error:', err);
    return {
      success: false,
      data: null,
      error: { type: 'UNKNOWN', message: 'Something went wrong. Please try again.' },
    };
  }
}

// ========================================================================
// HIERARCHICAL PLAN (backendBrain.js's HYBRID_SYMBOLIC_NEURAL path) -
// handles every "github"-flavored request now, big or small (see
// frontendBrain.js's decideRoute) - a 'small'-scope goal collapses to a
// single flat execution plan (planCoordinator.js's "COLLAPSING FOR
// SIMPLE REQUESTS"), so this is the one path for GitHub/Filesystem/
// Terminal/PDF/Office work regardless of size. Builds a real
// Strategic -> Project -> Task -> Execution plan tree
// (src/services/planning/planCoordinator.js) and runs it
// (planExecutor.js) - the exact same functions planStore.js already
// wraps for PlanScreen.js, just triggered from chat instead of
// requiring the person to have already built a plan another way.
// Returns a planId so the UI can offer a "View Plan" action on the
// reply instead of only a plain-text summary.
// ========================================================================
async function runHierarchicalPlanHandler(effectiveMessage, params) {
  const { conversationId, onPlanProgress, onPlanStep, standingContext, githubToolsEnabled, githubUsername } = params;

  // The person explicitly turned the GitHub toggle on for this message
  // (frontendBrain.js's forced-routing already got us here with
  // confidence) but hasn't actually added their GitHub username/token in
  // Settings yet - surface that plainly now, rather than letting a plan
  // start, reach an actual GitHub tool call several steps in, and fail
  // there with a less clear error.
  if (githubToolsEnabled && !githubUsername && /\b(github|repo|repository|commit|branch|push|pull request|\bpr\b|clone|merge|issue|release)\b/i.test(effectiveMessage)) {
    return {
      success: false,
      data: null,
      error: {
        type: 'GITHUB_NOT_CONFIGURED',
        message: 'GitHub tools are on, but no GitHub account is connected yet. Add your GitHub username and a personal access token in Settings > GitHub, then try again.',
      },
    };
  }

  // Actual token lookup - this used to be hardcoded to `null` here with a
  // comment claiming it was "resolved inside resourcePlanner.js/the tools
  // themselves via stored settings" - that was never true anywhere in the
  // codebase: resourcePlanner.js's checkResource('github_token', ...)
  // only ever reads context.githubToken (never touches secure storage
  // itself), so passing null unconditionally meant every hierarchical
  // plan saw GitHub as "not connected" and blocked its github-domain
  // steps even when a valid token was saved in Settings. githubTool.js's
  // OWN direct API calls (commitFiles, etc.) DO fetch the token
  // themselves via getApiKey('github') and were never affected by this -
  // only the plan-time availability check (and anything else relying on
  // this context value) was silently broken.
  const githubTokenResult = await getApiKey('github');
  const githubToken = githubTokenResult?.data?.key_value || null;

  const planResult = await runHierarchicalPlan(withStandingContextPreface(effectiveMessage, standingContext), {
    conversationId,
    githubToken,
    onProgress: onPlanProgress,
    onStep: onPlanStep,
  });

  if (planResult.content) {
    // A plan was at least built (and, usually, partially or fully run)
    // even on a "failure" outcome (a step that couldn't recover) -
    // surface that as a real reply with a planId rather than collapsing
    // it into a generic error, so the person can open the plan and see
    // exactly what did and didn't happen.
    return {
      success: true,
      data: {
        content: planResult.content,
        family: ACTIVE_MODEL.key,
        provider: 'local-backend',
        modelId: ACTIVE_MODEL.label,
        planId: planResult.planId,
        reasoningType: STRATEGY_FOR_ROUTE.HIERARCHICAL_PLAN,
      },
      error: null,
    };
  }

  return {
    success: false,
    data: null,
    error: planResult.error || { type: 'UNKNOWN', message: 'Could not build a plan for this.' },
  };
}

// ========================================================================
// PC BROWSER AGENT - runs on the person's PC via Playwright
// (server/browserAgent.js), streamed live to the phone.
//
// The REAL gate here is whether a live agentSession exists (the PC
// browser agent is actually connected), not the composer bar's
// globe/browser-access preference toggle. That toggle used to be a
// hard precondition: if the person forgot to flip it, a message
// classified as 'browsing' fell straight through to plain chat
// completion below and got a normal-chat answer with NO real web
// access behind it - confidently wrong/stale, with no indication
// anything was missing. Now: if the message needs live web access and
// a session is actually available, ZAO just uses it (the request
// itself is the person's consent - they asked a question that needs
// it) and syncs the preference to reflect that, rather than making a
// forgotten toggle the difference between a real answer and a silent
// guess. If NO session is available at all (PC not connected, PiP not
// mounted), that's a genuine capability gap - handled below as a
// clear, honest response instead of a silent chat fallback.
// ========================================================================
// ========================================================================
// DEEP RESEARCH - the multi-search, cited-report mode (ChatGPT/Claude's
// "Deep Research" equivalent). Distinct from QUICK_LOOKUP (one fact, one
// search) and from BROWSING (interacting with a live page) - this runs
// several searches from different angles, optionally reads a couple of
// the best pages in full, and writes an actual structured report with
// sources. Still no visual browser session at any point.
// ========================================================================
async function generateResearchAngles(topic, modelKey) {
  const history = [
    {
      role: 'system',
      content: 'Break the research topic into 4-5 distinct, specific search queries that together would cover it well - different angles (background, current state, key players/numbers, recent developments, common debates/counterpoints), not near-duplicates of each other. Respond with ONLY a JSON array of strings, no markdown fences, no commentary. Example: ["query one", "query two", "query three"]',
    },
    { role: 'user', content: topic },
  ];
  const result = await backendClient.sendMessage(history, modelKey, { maxTokens: 200, temperature: 0.4 });
  if (!result.success || !result.data?.content) return [topic]; // fall back to just the raw topic as one search
  try {
    const cleaned = result.data.content.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    if (Array.isArray(parsed) && parsed.length > 0) return parsed.slice(0, 5).map(String);
  } catch { /* fall through to raw-topic fallback below */ }
  return [topic];
}

async function runDeepResearchHandler(effectiveMessage, params) {
  const { history, onToken, onPlanProgress } = params;
  const modelKey = getModelKeyForTask ? getModelKeyForTask() : MODEL_KEYS.OX_ALPHA;

  onPlanProgress?.({ stage: 'planning_searches', message: 'Breaking this into research angles\u2026' });
  const angles = await generateResearchAngles(effectiveMessage, modelKey);

  const allResults = [];
  for (const angle of angles) {
    onPlanProgress?.({ stage: 'searching', message: `Searching: ${angle}` });
    const r = await webSearchTool.search(angle, 5);
    if (r.success && r.data?.results) {
      allResults.push({ angle, results: r.data.results });
    }
  }

  if (allResults.length === 0) {
    return {
      success: false,
      data: null,
      error: { type: 'DEEP_RESEARCH_ERROR', message: 'None of the research searches returned results - check the backend\u2019s internet connectivity.' },
    };
  }

  // Read the top 2-3 most-referenced/highest-value pages in full for
  // depth beyond a snippet, same instinct as web_fetch's own doc: a
  // snippet often isn't enough, a full page usually is. Kept small (not
  // one fetch per result) so this stays fast relative to a full
  // hierarchical plan.
  const topUrls = [...new Set(allResults.flatMap((a) => a.results.slice(0, 1).map((r) => r.url)))].slice(0, 3);
  const fetchedPages = [];
  for (const url of topUrls) {
    onPlanProgress?.({ stage: 'reading', message: `Reading: ${url}` });
    const fetched = await webFetchTool.fetchUrl(url).catch(() => null);
    if (fetched?.success && fetched.data?.text) {
      fetchedPages.push({ url, content: fetched.data.text.slice(0, 4000) });
    }
  }

  const searchDigest = allResults
    .map(({ angle, results }) => `Angle: ${angle}\n${results.slice(0, 5).map((r, i) => `${i + 1}. ${r.title} - ${r.snippet} (${r.url})`).join('\n')}`)
    .join('\n\n');
  const fullPageDigest = fetchedPages.map((p) => `--- Full page: ${p.url} ---\n${p.content}`).join('\n\n');

  onPlanProgress?.({ stage: 'writing', message: 'Writing the report\u2026' });

  const synthesisHistory = [
    {
      role: 'system',
      content: `Write a clear, well-organized research report answering the person's request, using ONLY the material below (current as of right now). Use headers to structure it, lead with the most important findings, note where sources disagree, and end with a "Sources" list of the URLs actually used. Don't pad it - be thorough but not repetitive.\n\nSearch results by angle:\n${searchDigest}${fullPageDigest ? `\n\nFull page content:\n${fullPageDigest}` : ''}`,
    },
    ...history,
  ];

  const completion = await backendClient.sendMessage(synthesisHistory, modelKey, { temperature: 0.3 });
  if (!completion.success || !completion.data?.content) {
    return {
      success: false,
      data: null,
      error: { type: 'DEEP_RESEARCH_ERROR', message: completion.error?.message || 'Could not synthesize the research report.' },
    };
  }

  onToken?.(completion.data.content);
  logUsageEvent('deep_research', effectiveMessage.slice(0, 80), { anglesSearched: angles.length, pagesRead: fetchedPages.length }).catch(() => {});

  return {
    success: true,
    data: {
      content: completion.data.content,
      family: ACTIVE_MODEL.key,
      provider: 'local-backend',
      modelId: ACTIVE_MODEL.label,
      reasoningType: STRATEGY_FOR_ROUTE.BROWSING,
    },
    error: null,
  };
}

// ========================================================================
// QUICK LOOKUP - the light path frontendBrain.js's QUICK_LOOKUP route
// takes for plain date/time/weather/news questions, so these don't pull
// up the full live Playwright browser agent (runBrowsingHandler below)
// just to answer something like "what's today's date". Two cases:
//   - date/time: resolved entirely on-device via timeTool.js (same data
//     source as the time_get_current tool) - no backend call, instant.
//   - weather/news (or anything the date/time check doesn't match): one
//     web_search call, then one plain non-streaming completion asking
//     the model to answer using just those results. Still real,
//     current, sourced information - just without opening a visual
//     browser session to get it.
// ========================================================================
const DATE_TIME_ONLY_RE = /\b(date|day|time)\b/i;

async function runQuickLookupHandler(effectiveMessage, params) {
  const { history, onToken } = params;

  if (DATE_TIME_ONLY_RE.test(effectiveMessage) && !/\bweather\b/i.test(effectiveMessage)) {
    const timeResult = timeTool.getCurrentTime(null);
    if (timeResult.success) {
      const content = `It's currently ${timeResult.data.formatted} (${timeResult.data.zoneName}).`;
      onToken?.(content);
      return {
        success: true,
        data: { content, family: ACTIVE_MODEL.key, provider: 'on-device', modelId: 'device clock', reasoningType: STRATEGY_FOR_ROUTE.BROWSING },
        error: null,
      };
    }
    // Falls through to web_search below if timeTool itself couldn't
    // resolve anything (extremely unlikely for a plain "what's the
    // date" with no timezone named), rather than returning nothing.
  }

  const searchResult = await webSearchTool.search(effectiveMessage, 5);
  if (!searchResult.success) {
    return {
      success: false,
      data: null,
      error: { type: 'QUICK_LOOKUP_ERROR', message: searchResult.error?.message || 'Web search failed.' },
    };
  }

  const resultsSummary = (searchResult.data?.results || [])
    .slice(0, 5)
    .map((r, i) => `${i + 1}. ${r.title} - ${r.snippet} (${r.url})`)
    .join('\n');

  const synthesisHistory = [
    { role: 'system', content: 'Answer the person\u2019s question directly and concisely using ONLY the search results below - they\u2019re current as of right now, more current than anything you already know. Don\u2019t mention "search results" or list sources unless asked; just answer naturally, the way you would if you simply knew the answer.\n\nSearch results:\n' + resultsSummary },
    ...history,
  ];

  const modelKey = getModelKeyForTask ? getModelKeyForTask() : MODEL_KEYS.OX_ALPHA;
  const completion = await backendClient.sendMessage(synthesisHistory, modelKey, { temperature: 0.3 });

  if (!completion.success || !completion.data?.content) {
    return {
      success: false,
      data: null,
      error: { type: 'QUICK_LOOKUP_ERROR', message: completion.error?.message || 'Could not synthesize an answer from search results.' },
    };
  }

  // Citations: same idea as ChatGPT/Claude showing sources under a
  // researched answer, kept lightweight here - just the top results
  // actually used, not a full inline-citation system.
  const sourceLines = (searchResult.data?.results || [])
    .slice(0, 3)
    .map((r) => `- ${r.title}: ${r.url}`)
    .join('\n');
  const contentWithSources = sourceLines
    ? `${completion.data.content}\n\nSources:\n${sourceLines}`
    : completion.data.content;

  onToken?.(contentWithSources);
  logUsageEvent('quick_lookup', effectiveMessage.slice(0, 80), null).catch(() => {});

  return {
    success: true,
    data: {
      content: contentWithSources,
      family: ACTIVE_MODEL.key,
      provider: 'local-backend',
      modelId: ACTIVE_MODEL.label,
      reasoningType: STRATEGY_FOR_ROUTE.BROWSING,
    },
    error: null,
  };
}

async function runBrowsingHandler(effectiveMessage, params) {
  const { agentSession, browserAccessEnabled, onBrowserStep, standingContext } = params;

  if (!agentSession) {
    // No live session - a genuine capability gap, not a consent gate.
    // Answering from plain chat completion here would risk presenting
    // stale/fabricated "current" information as if it were real, so
    // this is surfaced honestly instead of silently falling through.
    return {
      success: false,
      data: null,
      error: {
        type: 'NEEDS_BROWSER_ACCESS',
        message: 'This needs live web access, but the browser agent isn\u2019t connected right now. Make sure your PC backend is running and reachable, then try again.',
      },
    };
  }

  if (!browserAccessEnabled) {
    // Sync the toggle to reality now that it's actually being used, so
    // the composer bar reflects what's happening rather than staying
    // stuck on a state the person forgot about.
    usePreferencesStore.getState().setBrowserAccessEnabled(true).catch(() => {});
  }

  const agentResult = await agentSession.runTaskAwaitable(withStandingContextPreface(effectiveMessage, standingContext), {
    onStep: (stepInfo) => onBrowserStep?.(stepInfo),
  });

  if (agentResult.success) {
    logUsageEvent('browser_session', effectiveMessage.slice(0, 80), { stepsUsed: agentResult.stepsUsed }).catch(() => {});
    return {
      success: true,
      data: {
        content: agentResult.answer,
        family: ACTIVE_MODEL.key,
        provider: 'local-backend',
        modelId: ACTIVE_MODEL.label,
        browserStepsUsed: agentResult.stepsUsed,
        reasoningType: STRATEGY_FOR_ROUTE.BROWSING,
      },
      error: null,
    };
  }

  if (agentResult.needsHuman) {
    return {
      success: false,
      data: null,
      error: { type: 'NEEDS_HUMAN', message: agentResult.reason },
    };
  }

  return {
    success: false,
    data: null,
    error: {
      type: agentResult.error?.type || 'BROWSER_AGENT_ERROR',
      message: agentResult.error?.message || 'Browser agent task failed.',
    },
  };
}

// ========================================================================
// NORMAL CHAT COMPLETION - the one Ox Alpha model, served via OpenRouter by the
// PC backend, put to work through the REASONING ENGINE
// (src/services/reasoning/reasoningEngine.js) - a chosen reasoning
// strategy (chain-of-thought by default; tree-of-thought/deductive/
// inductive/abductive/analogical when reasoningRouter.js's classifier
// flags one of those) rather than a single bare completion call. Never
// throws - falls back to a plain completion internally on any
// strategy-level failure. Also the route agentLoop.js/frontendBrain.js
// fall through to once every action route available for a request has
// already been tried this turn (see frontendBrain.js's priorAttempts
// escalation), so this can be the FINAL step of a multi-route turn,
// synthesizing an answer from what agentLoop.js's effectiveMessage says
// was already done - not only ever the first and only step.
// ========================================================================
async function runChatHandler(effectiveMessage, params) {
  const { history, lastMessageText, standingContext, onToken, onThinkingToken } = params;
  const modelKey = getModelKeyForTask();

  // Real system-role blocks, prepended once - CHAT is the one route that
  // already works with a full {role,content} history array, so this gets
  // the cleaner treatment instead of the plain-text preface the other
  // three routes use (see withStandingContextPreface's own comment).
  let historyWithContext = standingContext?.length
    ? [...standingContext, ...history]
    : history;

  // Backstop for intentClassifier.js misrouting a current-info question
  // ("what's today's date", "weather in X") into this tool-less route -
  // see chatGroundingBackstop.js's own header for the full story. Cheap,
  // fails open, and a no-op for the vast majority of CHAT messages that
  // genuinely don't need it.
  const { groundingNote } = await getGroundingNote(effectiveMessage || lastMessageText).catch(() => ({ groundingNote: null }));
  if (groundingNote) {
    historyWithContext = [...historyWithContext, { role: 'system', content: groundingNote }];
  }

  const result = await runReasoningChat(historyWithContext, effectiveMessage || lastMessageText, onToken, onThinkingToken);

  if (result.success) {
    // Output-side enforcement (see chatGroundingBackstop.js's
    // enforceRealTime doc) - catches the model falling back to its
    // training-era sense of "now" even after being given the real
    // stamp in standingContext above. Runs regardless of route or
    // whether a groundingNote fired this turn, since this is a plain
    // instant local lookup (no network), not a conditional check.
    const timeForEnforcement = timeTool.getCurrentTime(null);
    const enforcedContent = timeForEnforcement.success
      ? enforceRealTime(result.content, timeForEnforcement.data)
      : result.content;

    return {
      success: true,
      data: {
        content: enforcedContent,
        family: modelKey,
        provider: 'local-backend',
        modelId: ACTIVE_MODEL.label,
        reasoningType: result.reasoningType,
        reasoningTrace: result.reasoningTrace,
      },
      error: null,
    };
  }

  return {
    success: false,
    data: null,
    error: result.error || { type: 'UNKNOWN', message: 'Backend failed to respond.' },
  };
}
