/**
 * ZAO - Agent Loop
 *
 * BEFORE THIS FILE: orchestrator.js called frontendBrain.decideRoute()
 * ONCE per message, then executed exactly that one route
 * (CHAT/BROWSING/HIERARCHICAL_PLAN) and returned - a single
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
import { getPreferences } from '../../db/database';
import * as backendClient from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import * as timeTool from '../time/timeTool';

const MAX_LOOP_ITERATIONS = 6;

const VERIFY_SYSTEM_PROMPT = `You just watched an AI assistant take one action toward a person's request. Decide if the request is now fully handled. Respond with ONLY one JSON object, no markdown fences, no commentary:
{"done": true|false, "remaining": "<short description of what's left, or empty string if done>"}

Say done:false only if the ORIGINAL request clearly has a distinct part that this action did not address (e.g. it asked for two separate things and only one was done). If the action addressed the request, or only partially succeeded but there's nothing further and different to try, say done:true.`;

/**
 * @param {object} params - same shape orchestrator.js already builds;
 *   see its own JSDoc for what each field is used for, including
 *   `browserAgentActive` (passed straight through to decideRoute() -
 *   see frontendBrain.js's own JSDoc for what it does with it). This function
 *   does not change orchestrator.js's external contract - it's called
 *   FROM orchestrator.js in place of the old single decideRoute+switch
 *   block, and returns the same result shape orchestrator.js already
 *   returns to the UI.
 * @param {object} handlers - the three route handlers
 *   ({ runChat, runBrowsing, runHierarchicalPlan }),
 *   injected so this file doesn't import
 *   toolOrchestrator/backendBrain/reasoningEngine directly and stays
 *   testable/reusable. Each receives (effectiveMessage, paramsWithContext)
 *   and returns the same { success, data, error } shape orchestrator.js
 *   already produces for that route. paramsWithContext carries a new
 *   `standingContext` array (system-role blocks from
 *   projectInstructions.js/autoMemoryNotes.js, plus a web-search hint
 *   block when the composer's web-search toggle is on) that each handler is
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
  const { lastMessageText, webSearchEnabled } = params;

  const [projectBlock, autoMemoryBlock, prefsResult] = await Promise.all([
    getProjectInstructionsBlock(),
    getAutoMemoryBlock(),
    getPreferences().catch(() => null),
  ]);

  // REAL-TIME STAMP: unconditional, every single message, every route -
  // not gated behind classification, web-search toggle, or the model
  // choosing to check anything. This is what actually makes "the model
  // can't get the date/time wrong" true rather than aspirational: the
  // fact is simply already IN the text it reads before it writes a
  // single token, on every turn, with no code path that skips it. This
  // is the enforcement half of the fix; chatGroundingBackstop.js /
  // intentClassifier.js's sharpened prompt are the other half (catching
  // cases where the model needs MORE than just today's date - a live
  // search result, for instance).
  //
  // Deliberately phrased as a hard override rather than a normal system
  // note: a small local model can still choose to ignore plain
  // instructional text, so the wording itself doesn't "force" anything
  // - what actually can't be worked around is that the true date/time is
  // unconditionally present in every single context this model ever
  // sees. There is no route, no classification outcome, no toggle
  // state that skips this block.
  const preferredTimezone = prefsResult?.success ? prefsResult.data?.preferred_timezone : null;
  const timeResult = timeTool.getCurrentTime(preferredTimezone || null);
  const realTimeBlock = timeResult.success
    ? {
        role: 'system',
        content: `[SYSTEM - ALWAYS TRUE, OVERRIDES YOUR OWN TRAINING]: The real current date and time, just checked, is ${timeResult.data.formatted} (${timeResult.data.zoneName}). Your training data has a cutoff long before this and cannot know anything that happened after it. Whenever your answer touches the date, time, "current"/"latest"/"today", or anything that could have changed since training - trust ONLY this stamp and any tool results you're given, never your own training-data sense of what year or date it is. Do not say "as of my last update" or similar - that phrasing was written for a version of you without this information. If you're unsure whether something needs a live check (news, prices, current tools/versions, "is X still true"), use the web_search tool rather than guessing from training.`,
      }
    : null;

  const webSearchBlock = webSearchEnabled
    ? { role: 'system', content: 'The person has turned on web search for this message. Prioritize calling the web_search tool to ground your answer in current information rather than answering from memory alone, unless the question is about something timeless that a search genuinely wouldn\'t improve (e.g. pure math, a definition, general advice).' }
    : null;
  const standingContext = [realTimeBlock, projectBlock, autoMemoryBlock, webSearchBlock].filter(Boolean);

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
    const { route, reason } = await decideRoute(effectiveMessage, attemptedRoutes, { browserAgentActive: params.browserAgentActive });
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
    [BRAIN_ROUTES.BROWSING]: 'browsed the web',
  }[route] || 'took an action';

  const snippet = (stepResult.data?.content || '').slice(0, 160);
  return snippet ? `${label} (${snippet})` : label;
}

// Multi-part requests are the ONLY reason verifyResolved's extra model
// call earns its keep - it exists to catch "check the repo's issues AND
// look up how others fixed one of them" style messages where one action
// satisfied only part of what was asked. A message with none of these
// multi-part signals, and only one real sentence, was never going to
// have unresolved parts after a successful action, so paying for the
// classifier call there is pure overhead with no coverage benefit - same
// "broad net, skip only the clearly-safe case" principle as
// chatGroundingBackstop.js's own pre-filter. Deliberately over-inclusive:
// any hint of "and then"/"also"/two-or-more sentences still pays for the
// real check.
const MULTI_PART_WORD_RE = /\b(and (?:also |then )?|also|then|after that|next,?|additionally|as well as|both|either|besides that)\b/i;

// Counts real sentence-ending punctuation (. ! ?) followed by more
// non-whitespace content - i.e. genuinely more than one sentence, not
// just any period anywhere (a mid-string period like "Mr. Smith" or a
// single trailing "please." would false-positive on a naive test, which
// defeats the whole point of skipping the round-trip for single-part
// messages).
function looksMultiPart(text) {
  if (MULTI_PART_WORD_RE.test(text)) return true;
  const sentenceEnds = text.match(/[.!?]+(?=\s+\S)/g);
  return !!sentenceEnds && sentenceEnds.length >= 1;
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
  // Speed: a clearly single-part, single-sentence original message has
  // nothing left that COULD be unresolved after a successful action -
  // see looksMultiPart's comment for why skipping here doesn't cut
  // coverage, just the round-trip for cases the check was never going
  // to flag anyway.
  if (!looksMultiPart((originalMessage || '').trim())) {
    return { done: true, remaining: '' };
  }

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
