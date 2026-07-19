/**
 * ZAO - Orchestrator
 *
 * The single entry point the UI calls to "send a message and get a
 * response." Everything text-based goes to the one Qwen2.5-Coder-3B model
 * served by the Termux backend (src/services/backend/backendClient.js) -
 * no manual mode, no fallback chain, no per-task model switching.
 *
 * There is no image generation, image editing, or vision/OCR anymore
 * (Gemini removed per product decision) - an attached image is passed
 * through as a plain attachment (see chatStore.js/AttachmentSheet) but is
 * not "read" by the model; camera/gallery/file attachments still work for
 * sending files INTO tool tasks (e.g. "zip this file", "push this to
 * GitHub"), just not for visual understanding.
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
 * just to build the four route handlers agentLoop.js calls
 * (runChat/runToolTask/runBrowsing/runHierarchicalPlan) and adapt their
 * results back to the { success, data, error } shape the UI expects -
 * the external contract below is unchanged from before agentLoop.js
 * existed.
 */

import { logUsageEvent } from '../db/database';
import {
  getModelKeyForTask,
  ACTIVE_MODEL,
} from '../config/localModels';
import { runGithubTask } from '../services/toolOrchestrator';
import { usePreferencesStore } from '../store/preferencesStore';
import { runAgentLoop } from '../services/brain/agentLoop';
import { runHierarchicalPlan } from '../services/brain/backendBrain';
import { runReasoningChat, STRATEGY_FOR_ROUTE } from '../services/reasoning/reasoningEngine';

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
      agentSession,
      onBrowserStep,
      githubUsername,
      onGithubStep,
      conversationId,
      onPlanProgress,
      onPlanStep,
      onToken,
    };

    const handlers = {
      runHierarchicalPlan: runHierarchicalPlanHandler,
      runToolTask: runToolTaskHandler,
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
// for a "github"-flavored request big enough that shouldDecompose()
// flagged it (multi-part builds, "rebuild my app's backend", etc.), or
// that a flat TOOL_TASK attempt earlier in this same turn already tried
// and agentLoop.js's verify step found insufficient (see
// frontendBrain.js's priorAttempts escalation). Builds a real
// Strategic -> Project -> Task -> Execution plan tree
// (src/services/planning/planCoordinator.js) and runs it
// (planExecutor.js) - the exact same functions planStore.js already
// wraps for PlanScreen.js, just triggered from chat instead of
// requiring the person to have already built a plan another way.
// Returns a planId so the UI can offer a "View Plan" action on the
// reply instead of only a plain-text summary.
// ========================================================================
async function runHierarchicalPlanHandler(effectiveMessage, params) {
  const { conversationId, onPlanProgress, onPlanStep, standingContext } = params;
  const planResult = await runHierarchicalPlan(withStandingContextPreface(effectiveMessage, standingContext), {
    conversationId,
    githubToken: null, // resolved inside resourcePlanner.js/the tools themselves via stored settings, not passed from here
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
// TOOL ORCHESTRATOR (GitHub + Filesystem + Terminal + PDF + Office) -
// handles "github"-flavored requests small enough not to need the full
// hierarchical plan above.
// ========================================================================
async function runToolTaskHandler(effectiveMessage, params) {
  const { githubUsername, onGithubStep, standingContext } = params;
  const githubResult = await runGithubTask(withStandingContextPreface(effectiveMessage, standingContext), githubUsername, onGithubStep);

  if (githubResult.success) {
    return {
      success: true,
      data: {
        content: githubResult.answer,
        family: ACTIVE_MODEL.key,
        provider: 'local-backend',
        modelId: ACTIVE_MODEL.label,
        toolStepsCompleted: githubResult.stepsCompleted,
        reasoningType: STRATEGY_FOR_ROUTE.TOOL_TASK,
        // Set only when a time_get_current tool call succeeded this turn
        // (see toolOrchestrator.js's runToolTask) - lets ChatScreen.js
        // render a live ClockWidget on this specific bubble, same
        // pattern as planId -> "View Plan" chip.
        clockData: githubResult.clockData || null,
        // Set only when a terminal command this turn was refused
        // specifically because it needs human confirmation
        // (toolOrchestrator.js's Gate 1 / commandSafety.js's RISKY tier) -
        // lets chatStore.js persist it as messages.pending_confirmation so
        // ChatScreen.js can render a real "Approve this command?" card
        // instead of the command just failing closed with no way to ever
        // run it. See HARDENING_NOTES.md.
        pendingConfirmation: githubResult.pendingConfirmation || null,
      },
      error: null,
    };
  }

  return {
    success: false,
    data: null,
    error: githubResult.error || { type: 'UNKNOWN', message: 'Tool task failed.' },
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
// NORMAL CHAT COMPLETION - the one Qwen2.5-Coder-3B model, served by the
// Termux backend, put to work through the REASONING ENGINE
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
  const { history, lastMessageText, standingContext, onToken } = params;
  const modelKey = getModelKeyForTask();

  // Real system-role blocks, prepended once - CHAT is the one route that
  // already works with a full {role,content} history array, so this gets
  // the cleaner treatment instead of the plain-text preface the other
  // three routes use (see withStandingContextPreface's own comment).
  const historyWithContext = standingContext?.length
    ? [...standingContext, ...history]
    : history;

  const result = await runReasoningChat(historyWithContext, effectiveMessage || lastMessageText, onToken);

  if (result.success) {
    return {
      success: true,
      data: {
        content: result.content,
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
