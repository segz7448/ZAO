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
  TOOL_TASK: 'tool_task',                 // -> toolOrchestrator.runToolTask (flat MULTI_BRAIN_ENSEMBLE loop)
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
 * @returns {Promise<{ route: string, intent: 'github'|'browsing'|'general', decompose: boolean, reason: string }>}
 */
export async function decideRoute(messageText, priorAttempts = []) {
  const intent = await classifyIntent(messageText);

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
    // gets a propose-and-approve gate before anything runs. TOOL_TASK
    // (the old flat, ungated ReAct loop in toolOrchestrator.js) is kept
    // as a route this function no longer picks, only so
    // toolOrchestrator.runToolTask stays reachable for anything that
    // deliberately calls it directly rather than as a routing dead-code
    // removal in the same pass.
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
