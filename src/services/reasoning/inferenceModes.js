/**
 * ZAO - Inference Modes: Deductive, Inductive, Abductive, Analogical
 *
 * Four reasoning shapes, each a single model call with a system prompt
 * that names the reasoning move explicitly rather than leaving it
 * implicit the way plain chain-of-thought does. Same
 * <thinking>/<answer> contract as chainOfThought.js so
 * reasoningEngine.js and the ChatScreen.js trace chip can treat all
 * five (CoT + these four) uniformly.
 *
 * reasoningRouter.js decides which of these (if any) a message needs;
 * this file only implements the four prompts + the shared parsing.
 */

import * as backendClient from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import { withSystemPrompt, splitThinkingAndAnswer } from './chainOfThought';

const DEDUCTIVE_SYSTEM_PROMPT = `Reason deductively: general rule(s) -> specific conclusion. Inside <thinking></thinking>, first state the general rule(s) or principle(s) that apply here, then state the specific facts of this case, then show the conclusion that necessarily follows from applying the rule to those facts - deduction should feel airtight, not probabilistic. Then give the person-facing answer inside <answer></answer>. Use ONLY these two tags.`;

const INDUCTIVE_SYSTEM_PROMPT = `Reason inductively: specific examples/evidence -> general rule. Inside <thinking></thinking>, look at the specific cases, examples, or data points actually present in the request, identify the pattern they share, and state the general rule that best fits - and be explicit that an inductive conclusion is probable, not certain, and note what would strengthen or weaken it. Then give the person-facing answer inside <answer></answer>. Use ONLY these two tags.`;

const ABDUCTIVE_SYSTEM_PROMPT = `Reason abductively: this is a best-guess explanation from incomplete evidence (the shape of real debugging). Inside <thinking></thinking>, list 2-3 plausible explanations/causes, weigh each one against the specific evidence given (what fits, what doesn't), then commit to the best-supported explanation and state what would confirm or rule it out. Then give the person-facing answer inside <answer></answer>, including the recommended next step to test the explanation if this is a debugging-style request. Use ONLY these two tags.`;

const ANALOGICAL_SYSTEM_PROMPT = `Reason analogically: map this situation onto a structurally similar one you know well, then carry that known situation's logic across the mapping. Inside <thinking></thinking>, name the analogous situation explicitly, map its relevant parts onto this one, note where the analogy holds and where it breaks down, then draw the conclusion the mapping supports. Then give the person-facing answer inside <answer></answer> - it can reference the analogy if that makes the answer clearer, but must stand on its own. Use ONLY these two tags.`;

async function runInferenceCall(history, systemPrompt) {
  const augmented = withSystemPrompt(history, systemPrompt);
  const result = await backendClient.sendMessage(augmented, MODEL_KEYS.QWEN25_CODER_3B, {
    maxTokens: 1024,
    temperature: 0.6,
  });

  if (!result.success) {
    return { success: false, content: '', trace: null, error: result.error };
  }

  const { thinking, answer } = splitThinkingAndAnswer(result.data?.content || '');
  return { success: true, content: answer, trace: thinking, error: null };
}

/** General rule -> specific conclusion. @param {Array<{role, content}>} history */
export function runDeductive(history) {
  return runInferenceCall(history, DEDUCTIVE_SYSTEM_PROMPT);
}

/** Specific examples -> general rule. @param {Array<{role, content}>} history */
export function runInductive(history) {
  return runInferenceCall(history, INDUCTIVE_SYSTEM_PROMPT);
}

/** Best-guess explanation from incomplete evidence (debugging-shaped). @param {Array<{role, content}>} history */
export function runAbductive(history) {
  return runInferenceCall(history, ABDUCTIVE_SYSTEM_PROMPT);
}

/** Reasoning by structural mapping to a known situation. @param {Array<{role, content}>} history */
export function runAnalogical(history) {
  return runInferenceCall(history, ANALOGICAL_SYSTEM_PROMPT);
}
