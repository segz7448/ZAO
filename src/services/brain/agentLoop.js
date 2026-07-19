/**
 * ZAO - Agent Loop
 *
 * BEFORE THIS FILE: orchestrator.js called frontendBrain.decideRoute()
 * ONCE per message, then executed exactly that one route
 * (CHAT/TOOL_TASK/BROWSING/HIERARCHICAL_PLAN) and returned - a single
 * up-front routing decision, not a loop. That meant a message couldn't
 * fluidly shift mid-turn: "check the repo's open issues and then look
 * up how other projects fixed the one about X" would classify as
 * 'github' and run ONLY the tool orchestrator, never reaching the live
 * web lookup the second half of the sentence needed, because the
 * routing decision was made once, before anything had actually been
 * tried.
 *
 * THIS FILE is the gather -> act -> verify loop that was missing:
 *
 *   1. GATHER - assemble this iteration's context: the person's
 *      standing instructions (projectInstructions.js), the agent's own
 *      past-session notes (autoMemoryNotes.js), and a summary of what's
 *      already been done THIS turn (previous iterations' results).
 *   2. ACT - ask frontendBrain.decideRoute() what to do next (passing
 *      which routes already ran this turn, so it doesn't just repeat
 *      one that didn't resolve things - see decideRoute's priorAttempts
 *      param), then actually run that route's handler.
 *   3. VERIFY - for anything other than CHAT, ask the model a single
 *      cheap question: does the ORIGINAL request still have unresolved
 *      parts after this action? If yes, loop back to GATHER with the
 *      new information folded in. If no (or CHAT was the route, which
 *      is always a terminal answer), stop.
 *
 * This mirrors Claude Code's own framing (gather context -> act ->
 * verify, repeating until done) rather than toolOrchestrator.js's
 * existing ReAct loop, which already does this WITHIN one tool
 * category (github/filesystem/terminal/pdf/office) - this file is the
 * layer above that, letting a turn move BETWEEN categories (chat, tool
 * task, browsing, hierarchical plan) rather than committing to one for
 * the whole message.
 *
 * INTERRUPTIBILITY: `isCancelled` is checked between every iteration
 * (never mid-iteration - an in-flight tool call or plan step still
 * runs to a safe stopping point) so the person can stop a multi-step
 * turn the same way Claude Code lets someone interrupt mid-loop,
 * without ZAO needing to abort a half-finished GitHub push or terminal
 * command.
 *
 * COST DISCIPLINE: the common case (a plain chat message) costs
 * EXACTLY what it cost before this file existed - one decideRoute call,
 * one CHAT completion, no verify call, loop exits after iteration 1.
 * The extra iterations and verify calls only happen for messages that
 * actually resolve to an action route, and even then stop as soon as
 * verify says the request is satisfied.
 */

import { decideRoute, BRAIN_ROUTES } from './frontendBrain';
import { getProjectInstructionsBlock } from '../memory/projectInstructions';
import { getAutoMemoryBlock } from '../memory/autoMemoryNotes';
import * as backendClient from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';

const MAX_LOOP_ITERATIONS = 6;

const VERIFY_SYSTEM_PROMPT = `You just watched an AI assistant take one action toward a person's request. Decide if the request is now fully handled. Respond with ONLY one JSON object, no markdown fences, no commentary:
{"done": true|false, "remaining": "<short description of what's left, or empty string if done>"}

Say done:false only if the ORIGINAL request clearly has a distinct part that this action did not address (e.g. it asked for two separate things and only one was done). If the action addressed the request, or only partially succeeded but there's nothing further and different to try, say done:true.`;

/**
 * @param {object} params - same shape orchestrator.js already builds;
 *   see its own JSDoc for what each field is used for. This function
 *   does not change orchestrator.js's external contract - it's called
 *   FROM orchestrator.js in place of the old single decideRoute+switch
 *   block, and returns the same result shape orchestrator.js already
 *   returns to the UI.
 * @param {object} handlers - the four route handlers
 *   ({ runChat, runToolTask, runBrowsing, runHierarchicalPlan }),
 *   injected so this file doesn't import
 *   toolOrchestrator/backendBrain/reasoningEngine directly and stays
 *   testable/reusable. Each receives (effectiveMessage, paramsWithContext)
 *   and returns the same { success, data, error } shape orchestrator.js
 *   already produces for that route. paramsWithContext carries a new
 *   `standingContext` array (system-role blocks from
 *   projectInstructions.js/autoMemoryNotes.js) that each handler is
 *   responsible for prepending to whatever history/messages it builds -
 *   this file gathers that context once per turn but doesn't reach into
 *   each handler's internal message construction itself.
 * @param {function} [isCancelled] - returns true if the person asked to
 *   stop; checked between iterations only.
 * @param {function} [onLoopStep] - fired once per iteration with
 *   { route, reason } for a UI progress indicator, separate from each
 *   route's own onStep/onBrowserStep/onPlanStep callbacks.
 * @returns {Promise<{ success, data, error }>}
 */
export async function runAgentLoop(params, handlers, { isCancelled = () => false, onLoopStep = null } = {}) {
  const { lastMessageText } = params;

  const [projectBlock, autoMemoryBlock] = await Promise.all([
    getProjectInstructionsBlock(),
    getAutoMemoryBlock(),
  ]);
  const standingContext = [projectBlock, autoMemoryBlock].filter(Boolean);

  const attemptedRoutes = [];
  const priorResultsSummary = [];
  let lastResult = null;

  for (let iteration = 0; iteration < MAX_LOOP_ITERATIONS; iteration += 1) {
    if (isCancelled()) {
      return lastResult || {
        success: false,
        data: null,
        error: { type: 'CANCELLED', message: 'Stopped.' },
      };
    }

    // ---- GATHER ----
    // The message actually routed/acted on this iteration: the original
    // text on the first pass, or the original text plus a short note of
    // what's already been done on later passes, so decideRoute() and the
    // route handler both see what's outstanding rather than re-reading
    // the original request cold.
    const effectiveMessage = priorResultsSummary.length === 0
      ? lastMessageText
      : `${lastMessageText}\n\n[Already done this turn: ${priorResultsSummary.join('; ')}]`;

    // ---- ACT ----
    const { route, reason } = await decideRoute(effectiveMessage, attemptedRoutes);
    attemptedRoutes.push(route);
    onLoopStep?.({ route, reason, iteration });

    const stepResult = await runOneRoute(route, effectiveMessage, { ...params, standingContext }, handlers);
    lastResult = stepResult;

    if (!stepResult.success) {
      // A real failure (backend down, tool error, no browser session) is
      // surfaced immediately rather than swallowed into another
      // iteration - matches orchestrator.js's existing contract that a
      // failure is a real failure, not a silent fallback.
      return stepResult;
    }

    if (route === BRAIN_ROUTES.CHAT) {
      // Plain chat is always a terminal answer - no verify call. This is
      // also where every other route lands once decideRoute() has
      // exhausted the useful actions (see frontendBrain.js's
      // priorAttempts escalation) and falls through to CHAT to
      // synthesize a final answer from whatever was gathered.
      return stepResult;
    }

    priorResultsSummary.push(summarizeForNextIteration(route, stepResult));

    // ---- VERIFY ----
    const verify = await verifyResolved(lastMessageText, route, stepResult);
    if (verify.done) {
      return stepResult;
    }
    // else: loop back to GATHER with priorResultsSummary/attemptedRoutes
    // carrying forward, so the next decideRoute() call sees what's
    // already been tried.
  }

  // Iteration budget exhausted without a clean "done" - return whatever
  // the last action produced rather than an empty failure, since partial
  // progress (e.g. 3 of 4 requested steps) is still a real, useful result.
  return lastResult || {
    success: false,
    data: null,
    error: { type: 'UNKNOWN', message: 'Could not complete this within the step budget.' },
  };
}

async function runOneRoute(route, effectiveMessage, params, handlers) {
  switch (route) {
    case BRAIN_ROUTES.HIERARCHICAL_PLAN:
      return handlers.runHierarchicalPlan(effectiveMessage, params);
    case BRAIN_ROUTES.TOOL_TASK:
      return handlers.runToolTask(effectiveMessage, params);
    case BRAIN_ROUTES.BROWSING:
      return handlers.runBrowsing(effectiveMessage, params);
    case BRAIN_ROUTES.CHAT:
    default:
      return handlers.runChat(effectiveMessage, params);
  }
}

function summarizeForNextIteration(route, stepResult) {
  const label = {
    [BRAIN_ROUTES.HIERARCHICAL_PLAN]: 'ran a multi-step plan',
    [BRAIN_ROUTES.TOOL_TASK]: 'ran a tool task',
    [BRAIN_ROUTES.BROWSING]: 'browsed the web',
  }[route] || 'took an action';

  const snippet = (stepResult.data?.content || '').slice(0, 160);
  return snippet ? `${label} (${snippet})` : label;
}

/**
 * One cheap classifier-style call, same pattern as intentClassifier.js -
 * asks whether the ORIGINAL request still has unresolved parts after
 * the action just taken. Never throws the loop off course: any failure
 * here (backend hiccup, unparseable response) defaults to done:true, so
 * a verify-step glitch degrades to "stop after one action" (the exact
 * pre-agentLoop.js behavior) rather than risking a runaway loop.
 */
async function verifyResolved(originalMessage, route, stepResult) {
  try {
    const history = [
      { role: 'system', content: VERIFY_SYSTEM_PROMPT },
      { role: 'user', content: `Original request: ${originalMessage}\n\nAction taken (${route}): ${(stepResult.data?.content || '').slice(0, 500)}` },
    ];

    const result = await backendClient.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
      maxTokens: 60,
      temperature: 0,
    });

    if (result.success && result.data?.content) {
      const cleaned = result.data.content.replace(/```json/gi, '').replace(/```/g, '').trim();
      const parsed = JSON.parse(cleaned);
      if (typeof parsed?.done === 'boolean') return parsed;
    }
  } catch (err) {
    // Falls through to the safe default below.
  }
  return { done: true, remaining: '' };
}
