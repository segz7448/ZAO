/**
 * ZAO - Reasoning Router
 *
 * Decides which reasoning strategy (src/services/reasoning/*)  a plain
 * CHAT-route message should use, once frontendBrain.js has already
 * decided the message isn't a tool task, hierarchical plan, or
 * browsing request (those get REACT/HYBRID_SYMBOLIC_PLAN/REACT
 * respectively - see reasoningEngine.js's STRATEGY_FOR_ROUTE for that
 * part). This module only covers what happens once a message is
 * heading for a direct model answer.
 *
 * Cheapest-first, same principle frontendBrain.js already uses for
 * routing:
 *   1. Free local heuristics (regex) - catches the two patterns that
 *      are cheap and reliable to detect without a model call at all:
 *      abductive (debugging-shaped: an error/stack trace/"not
 *      working") and analogical (explicit "is X like Y" / "compare X
 *      to Y" phrasing).
 *   2. One classifier model call - for everything else, asks the model
 *      itself which reasoning shape fits, the same way
 *      intentClassifier.js asks which execution mode a message needs
 *      rather than keyword-matching it.
 *   3. Keyword fallback - if the classifier call itself fails
 *      (backend unreachable), default to CHAIN_OF_THOUGHT rather than
 *      blocking the message; CoT is a safe, always-reasonable default.
 */

import * as backendClient from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import { REASONING_STRATEGIES } from './reasoningTypes';

const VALID_STRATEGIES = new Set([
  REASONING_STRATEGIES.CHAIN_OF_THOUGHT,
  REASONING_STRATEGIES.TREE_OF_THOUGHT,
  REASONING_STRATEGIES.DEDUCTIVE,
  REASONING_STRATEGIES.INDUCTIVE,
  REASONING_STRATEGIES.ABDUCTIVE,
  REASONING_STRATEGIES.ANALOGICAL,
]);

// Debugging-shaped language: an error, a failure, a stack trace, "isn't
// working" phrasing. Cheap and reliable enough to catch for free,
// without spending a model call to notice what's already obvious.
const ABDUCTIVE_HINT_RE = /\b(error|exception|stack ?trace|traceback|crash(?:ing|ed)?|bug|doesn'?t work|isn'?t working|not working|won'?t (?:start|run|build|load|connect)|fails? to|failing|broke(?:n)?|why is (?:this|it|my))\b/i;

// Explicit analogy/comparison phrasing.
const ANALOGICAL_HINT_RE = /\b(is (?:it|this|that) like|similar to|analogous to|compare[sd]? (?:.+ )?to|reminds? me of|same as|think of it (?:like|as))\b/i;

// Open-ended "what should I do" / strategy / design framing where
// multiple reasonable approaches genuinely exist and picking the wrong
// first one matters - the exact shape tree_of_thought is for.
const TREE_OF_THOUGHT_HINT_RE = /\b(what should i do about|how should i approach|what'?s the best way to|help me (?:decide|choose) between|weigh(?:ing)? the (?:options|pros and cons)|should i (?:choose|go with|pick))\b/i;

// A stated rule/premise applied to reach a conclusion that necessarily
// follows - "given/if X, then/does Y" framing, or an explicit reference
// to a policy/law/definition being applied to a specific case.
const DEDUCTIVE_HINT_RE = /\b(given that|if .+ then|does (?:this|it) (?:qualify|count) as|according to the (?:rule|policy|law|definition)|based on the (?:rule|policy|criteria))\b/i;

// Specific examples/observations offered up front, asking what general
// pattern they suggest.
const INDUCTIVE_HINT_RE = /\b(what(?:'?s| is) the pattern|what do (?:these|those) (?:have in common|suggest)|based on (?:these|these results|this data)|notice (?:a|any) (?:pattern|trend))\b/i;

// A message this short, with none of the hints above, is essentially
// never going to land on anything but chain_of_thought even after a
// full classifier call - it's the classifier's own most common output
// for exactly this shape of message. Skipping the call here doesn't
// remove a safety check (CoT still does its own full reasoning pass on
// the actual answer, this only skips PICKING that strategy), it just
// stops paying a full model round-trip for an outcome that was already
// certain. Longer/more complex messages, where the strategy genuinely
// could be one of the special five, still always go to the classifier.
const SHORT_MESSAGE_SKIP_THRESHOLD = 140;

const CLASSIFIER_SYSTEM_PROMPT = `Classify what reasoning shape this request actually needs. Respond with ONLY one JSON object, no markdown fences, no commentary:
{"strategy": "chain_of_thought" | "tree_of_thought" | "deductive" | "inductive" | "abductive" | "analogical"}

- "tree_of_thought": there are genuinely multiple reasonable ways to approach this (open-ended design/strategy/creative/planning questions, "what should I do about X" with no single right answer) and picking the wrong first approach would matter.
- "deductive": applying a known rule, law, definition, or policy to a specific case to reach a conclusion that necessarily follows (e.g. "does this qualify for X given the rule that...", math/logic problems with given premises).
- "inductive": the request gives specific examples, data points, or observations and asks what general pattern/rule they suggest.
- "abductive": diagnosing a cause from a symptom or incomplete evidence - debugging, "why is this happening", troubleshooting.
- "analogical": explicitly comparing this situation to another one, or asking to explain something by relating it to something else familiar.
- "chain_of_thought": everything else - ordinary questions, explanations, writing help, casual conversation, anything with one straightforward line of reasoning to a single answer.`;

/**
 * @param {string} messageText
 * @returns {Promise<{strategy: string, reason: string}>}
 */
export async function decideReasoningStrategy(messageText) {
  const text = (messageText || '').trim();
  if (!text) {
    return { strategy: REASONING_STRATEGIES.CHAIN_OF_THOUGHT, reason: 'Empty message - default.' };
  }

  if (ABDUCTIVE_HINT_RE.test(text)) {
    return { strategy: REASONING_STRATEGIES.ABDUCTIVE, reason: 'Debugging/error-shaped language detected locally.' };
  }

  if (ANALOGICAL_HINT_RE.test(text)) {
    return { strategy: REASONING_STRATEGIES.ANALOGICAL, reason: 'Explicit comparison/analogy phrasing detected locally.' };
  }

  if (TREE_OF_THOUGHT_HINT_RE.test(text)) {
    return { strategy: REASONING_STRATEGIES.TREE_OF_THOUGHT, reason: 'Open-ended decision/strategy phrasing detected locally.' };
  }

  if (DEDUCTIVE_HINT_RE.test(text)) {
    return { strategy: REASONING_STRATEGIES.DEDUCTIVE, reason: 'Rule-applied-to-a-case phrasing detected locally.' };
  }

  if (INDUCTIVE_HINT_RE.test(text)) {
    return { strategy: REASONING_STRATEGIES.INDUCTIVE, reason: 'Pattern-from-examples phrasing detected locally.' };
  }

  // Short message, none of the five special hints above fired - the
  // classifier call would almost always return chain_of_thought anyway
  // (see SHORT_MESSAGE_SKIP_THRESHOLD's comment), so skip straight to it
  // and save the round-trip. Longer messages still go to the classifier
  // below, since a longer message has more room to genuinely be one of
  // the special five without tripping any single short keyword pattern.
  if (text.length <= SHORT_MESSAGE_SKIP_THRESHOLD) {
    return { strategy: REASONING_STRATEGIES.CHAIN_OF_THOUGHT, reason: 'Short, no special-strategy signal - skipped classifier call.' };
  }

  try {
    const history = [
      { role: 'system', content: CLASSIFIER_SYSTEM_PROMPT },
      { role: 'user', content: text },
    ];

    const result = await backendClient.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
      maxTokens: 20,
      temperature: 0,
    });

    if (result.success && result.data?.content) {
      const parsed = safeParseJson(result.data.content);
      if (parsed && VALID_STRATEGIES.has(parsed.strategy)) {
        return { strategy: parsed.strategy, reason: 'Model classification.' };
      }
    }
  } catch (err) {
    // Falls through to the default below.
  }

  return { strategy: REASONING_STRATEGIES.CHAIN_OF_THOUGHT, reason: 'Classifier unavailable - safe default.' };
}

function safeParseJson(rawContent) {
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}
