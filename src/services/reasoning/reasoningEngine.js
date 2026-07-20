/**
 * ZAO - Reasoning Engine
 *
 * The single entry point orchestrator.js calls for the CHAT route (see
 * src/services/brain/frontendBrain.js's BRAIN_ROUTES.CHAT) - the
 * reasoning-layer equivalent of what backendBrain.js's
 * runHierarchicalPlan is for the HIERARCHICAL_PLAN route. Everything
 * else in src/services/reasoning/ is a strategy this file dispatches
 * to; nothing else should need to know reasoningRouter.js or the
 * individual strategy modules exist.
 *
 * Flow for a CHAT-route message:
 *   1. reasoningRouter.decideReasoningStrategy() - cheapest-first
 *      routing (local heuristics, then one classifier call) to one of:
 *      CHAIN_OF_THOUGHT, TREE_OF_THOUGHT, DEDUCTIVE, INDUCTIVE,
 *      ABDUCTIVE, ANALOGICAL.
 *   2. Run that strategy - one or more model calls, strategy-specific.
 *   3. shouldAutoReflect() below decides - on its own, per message, no
 *      person-facing setting - whether this specific reply is worth a
 *      self-reflection critique+revise pass (selfReflection.js) on top.
 *      Tree-of-thought is always skipped here since it already carries
 *      its own critique/evaluate step (see treeOfThought.js's header) -
 *      running a second critique back to back would just double the
 *      latency for no real gain.
 *
 * WHY THIS IS FULLY AUTOMATIC, NOT A TOGGLE: every other routing
 * decision in this app - which BRAIN_ROUTE a message needs
 * (frontendBrain.js), which reasoning strategy fits
 * (reasoningRouter.js) - is made by the app reading the message, not by
 * a setting the person has to know to flip. Self-reflection follows the
 * same principle: whether an answer is worth double-checking is a
 * property of the answer, not a standing preference someone sets once
 * and forgets about. A person who wants ZAO to be more careful
 * shouldn't have to remember a switch exists.
 *
 * Every step degrades instead of throwing - same "never throws"
 * contract orchestrator.js itself keeps. A failure at any stage falls
 * back to the plain backendClient.sendMessage() completion so a
 * reasoning-layer bug never turns into "the person got no reply".
 */

import * as backendClient from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import { REASONING_STRATEGIES } from './reasoningTypes';
import { decideReasoningStrategy } from './reasoningRouter';
import { runChainOfThought } from './chainOfThought';
import { runTreeOfThought } from './treeOfThought';
import { runDeductive, runInductive, runAbductive, runAnalogical } from './inferenceModes';
import { runSelfReflection } from './selfReflection';

// Every runner is called with (history, messageText, onToken); only
// CHAIN_OF_THOUGHT (the default, and by far the most common, strategy)
// currently streams - the rest ignore the third arg. They're not wired
// for the same reason self-reflection below isn't: each makes more than
// one model call before landing on final person-facing content (ToT's
// branch+evaluate, the inference modes' structured-claim parsing), so
// there's no single "the tokens arriving right now ARE the answer"
// stream to expose - streaming their first draft call would show
// intermediate reasoning, not the reply.
const STRATEGY_RUNNERS = {
  [REASONING_STRATEGIES.CHAIN_OF_THOUGHT]: (history, messageText, onToken) => runChainOfThought(history, onToken),
  [REASONING_STRATEGIES.TREE_OF_THOUGHT]: (history, messageText) => runTreeOfThought(history, messageText),
  [REASONING_STRATEGIES.DEDUCTIVE]: (history) => runDeductive(history),
  [REASONING_STRATEGIES.INDUCTIVE]: (history) => runInductive(history),
  [REASONING_STRATEGIES.ABDUCTIVE]: (history) => runAbductive(history),
  [REASONING_STRATEGIES.ANALOGICAL]: (history) => runAnalogical(history),
};

/**
 * Labels the reasoning strategy behind a reply that DIDN'T go through
 * this engine at all - the tool orchestrator (ReAct), the browser
 * agent (ReAct), and the hierarchical planner (hybrid symbolic plan)
 * each already have their own execution path (see orchestrator.js);
 * this map just lets orchestrator.js tag those replies with the same
 * reasoning_type field plain-chat replies get, so ChatScreen.js's
 * reasoning chip can label ANY reply consistently rather than only
 * ones that came from runReasoningChat() below.
 */
export const STRATEGY_FOR_ROUTE = Object.freeze({
  TOOL_TASK: REASONING_STRATEGIES.REACT,
  BROWSING: REASONING_STRATEGIES.REACT,
  HIERARCHICAL_PLAN: REASONING_STRATEGIES.HYBRID_SYMBOLIC_PLAN,
});

// Correctness-sensitive strategies: deduction is a chain of claims that
// either holds or doesn't (one broken link and the whole conclusion is
// wrong), and abduction is diagnosing a real cause from a symptom -
// both are exactly the shape of answer where being wrong is costly, so
// both are always worth a second look.
const ALWAYS_REFLECT_STRATEGIES = new Set([
  REASONING_STRATEGIES.DEDUCTIVE,
  REASONING_STRATEGIES.ABDUCTIVE,
]);

// A code block, or numbers being computed/compared, both plain
// chain-of-thought/inductive/analogical answers can contain even though
// their strategy alone doesn't flag them as high-stakes - the content
// itself is the signal here, not the strategy that produced it.
const HIGH_STAKES_CONTENT_RE = /```|\b\d+(?:\.\d+)?\s*(?:%|percent)?\s*(?:[-+*/×÷]|equals?|=)\s*\d/i;

// Explicit accuracy language in the request itself - the person is
// telling us correctness matters more than usual for this one message.
const ACCURACY_REQUEST_RE = /\b(make sure|double[- ]check|verify|is this (?:correct|right|accurate)|are you sure|confirm|exact(?:ly)?)\b/i;

/**
 * Decides - per reply, from signals already available, with no model
 * call of its own - whether this specific answer is worth
 * selfReflection.js's extra critique+revise pass. Never a person-facing
 * setting (see this file's header) and never applied to tree-of-thought
 * (it already critiques itself).
 */
function shouldAutoReflect(strategy, messageText, draftContent) {
  if (strategy === REASONING_STRATEGIES.TREE_OF_THOUGHT) return false;
  if (ALWAYS_REFLECT_STRATEGIES.has(strategy)) return true;
  if (HIGH_STAKES_CONTENT_RE.test(draftContent || '')) return true;
  if (ACCURACY_REQUEST_RE.test(messageText || '')) return true;
  return false;
}

/**
 * @param {Array<{role, content}>} history - full conversation, ending in the new user message
 * @param {string} messageText - the raw new user message (used by ToT's evaluator and the router's classifier)
 * @param {(text: string) => void} [onToken] - see chainOfThought.js's runChainOfThought() JSDoc.
 *   Only fires for the CHAIN_OF_THOUGHT strategy (the default) and the plain-completion
 *   fallback below - other strategies make multiple internal model calls before a final
 *   answer exists, so there's nothing to stream (see STRATEGY_RUNNERS' comment). NOTE:
 *   if shouldAutoReflect() below decides this reply is worth a self-reflection pass,
 *   finalContent can still change AFTER the streamed draft finished - the bubble will
 *   show the revised text once ready, same as any other content update, but it means a
 *   streamed reply is not always the literal final one for reflection-worthy answers.
 * @returns {Promise<{
 *   success: boolean,
 *   content: string,
 *   reasoningType: string|null,
 *   reasoningTrace: object|null,
 *   error: object|null,
 * }>}
 */
export async function runReasoningChat(history, messageText, onToken) {
  let strategy = REASONING_STRATEGIES.CHAIN_OF_THOUGHT;
  let routeReason = 'default';

  try {
    const decision = await decideReasoningStrategy(messageText);
    strategy = decision.strategy;
    routeReason = decision.reason;
  } catch (err) {
    // Router itself failed - keep the CoT default rather than blocking.
  }

  const runner = STRATEGY_RUNNERS[strategy] || STRATEGY_RUNNERS[REASONING_STRATEGIES.CHAIN_OF_THOUGHT];

  let result;
  try {
    result = await runner(history, messageText, onToken);
  } catch (err) {
    result = { success: false, content: '', trace: null, error: { type: 'UNKNOWN', message: err?.message || 'Reasoning strategy failed.' } };
  }

  if (!result.success) {
    // Strategy-level failure (parsing, malformed model output, etc.) -
    // fall back to one plain completion rather than surfacing an error
    // for what might just be a JSON-parsing hiccup on a small model. This
    // is a raw completion with no <thinking>/<answer> wrapping, so unlike
    // chainOfThought.js it can stream straight through with no tag parsing.
    const plain = await backendClient.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, { maxTokens: 1024, temperature: 0.7, onToken });
    if (!plain.success) {
      return { success: false, content: '', reasoningType: null, reasoningTrace: null, error: plain.error };
    }
    return {
      success: true,
      content: plain.data.content,
      reasoningType: REASONING_STRATEGIES.CHAIN_OF_THOUGHT,
      reasoningTrace: { note: `${strategy} failed (${result.error?.message || 'unknown'}); used a plain completion instead.` },
      error: null,
    };
  }

  let finalContent = result.content;
  let finalTrace = result.trace;
  let reasoningType = strategy;

  const worthReflecting = shouldAutoReflect(strategy, messageText, finalContent);
  if (worthReflecting) {
    try {
      const reflected = await runSelfReflection(messageText, finalContent);
      if (reflected.success && reflected.trace?.revised) {
        finalContent = reflected.content;
        finalTrace = { ...(typeof finalTrace === 'object' && finalTrace ? finalTrace : { thinking: finalTrace }), selfReflection: reflected.trace };
        reasoningType = REASONING_STRATEGIES.SELF_REFLECTION;
      }
    } catch (err) {
      // Reflection pass failing shouldn't cost the person the draft
      // answer they already have.
    }
  }

  return {
    success: true,
    content: finalContent,
    reasoningType,
    reasoningTrace: finalTrace,
    error: null,
  };
}
