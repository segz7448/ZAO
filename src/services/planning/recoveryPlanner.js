/**
 * ZAO - Recovery Planner (Planning type 6/8)
 *
 * "What do I do if a step fails?" - not every failure means the plan is
 * dead. A network hiccup deserves a retry; a wrong assumption deserves a
 * different approach; a genuinely blocked step deserves a human's input
 * rather than the executor guessing forever. This mirrors how Claude
 * handles a failed tool call: it doesn't treat every failure as fatal,
 * but it also doesn't blindly retry the exact same thing indefinitely -
 * it reads the error, picks a proportionate response, and escalates if
 * that response doesn't work either.
 *
 * ESCALATION LADDER (least to most drastic - see RECOVERY_STRATEGIES in
 * planTypes.js, which this module's ordering matches exactly):
 *   1. retry                - transient-looking error, first failure, try again as-is
 *   2. retry_with_backoff   - transient-looking error, already failed once, wait then retry
 *   3. alternate_approach   - same error twice, or a non-transient error - ask the model for a different way to do this one step
 *   4. skip_and_continue    - the step is non-critical (nothing else in the plan depends on it) and has failed multiple times
 *   5. ask_person           - the step is risky, or critical (other steps depend on it), or every automated option above has been exhausted
 *   6. abort_plan           - a resource the whole plan depends on is gone, or the person explicitly cancels
 *
 * This module decides the STRATEGY; it doesn't execute retries itself -
 * planCoordinator.js's executor loop calls back in here after every step
 * failure, gets a strategy, and acts on it (re-running the step,
 * re-planning just that step via executionPlanner.js's single-step
 * mode, marking it skipped, or flipping the plan to awaiting_approval /
 * failed).
 */

import { v4 as uuidv4 } from 'uuid';
import * as llamaEngine from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import { RECOVERY_STRATEGIES } from './planTypes';

const MAX_AUTO_RETRIES = 2; // after this many automated attempts on one step, recovery always escalates to ask_person rather than looping forever
const BACKOFF_MS_BASE = 1500;

/** Rough heuristic for "does this error look like it might just work if we tried again" vs "this will fail identically every time." Deliberately simple string matching - recoveryPlanner.js only needs a coarse signal, not a full error taxonomy. */
const TRANSIENT_ERROR_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /network/i,
  /econnrefused/i,
  /econnreset/i,
  /rate.?limit/i,
  /429/,
  /5\d\d/, // 5xx server errors
  /unreachable/i,
  /temporarily/i,
];

function looksTransient(errorMessage) {
  const text = errorMessage || '';
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Decides the recovery strategy for one failed step. Pure/cheap first
 * (no model call) for the common cases - first-time transient failure,
 * or a step that's already hit MAX_AUTO_RETRIES - since those don't need
 * judgment. Only calls the model for the genuinely ambiguous middle case:
 * a non-transient failure where an alternate approach might exist.
 *
 * @param {object} step - the failed plan_steps row, plus { hasDependents: boolean } indicating whether other pending steps depend on this one
 * @param {object} options - { previousAttempts: Array<{strategy, outcome}>, isRisky: boolean }
 * @returns {Promise<{ strategy: string, reasoning: string, waitMs: number|null, alternateAction: object|null }>}
 */
export async function planRecovery(step, options = {}) {
  const { previousAttempts = [], isRisky = false } = options;
  const attemptCount = previousAttempts.length;
  const transient = looksTransient(step.error_message || step.errorMessage);
  const hasDependents = !!step.hasDependents;

  // Already exhausted automated attempts - always hand to the person
  // rather than retrying forever. This is the hard ceiling regardless of
  // how promising the error looks.
  if (attemptCount >= MAX_AUTO_RETRIES) {
    return {
      strategy: RECOVERY_STRATEGIES.ASK_PERSON,
      reasoning: `This step has failed ${attemptCount} time(s) already - stopping automated retries and asking for your input rather than looping.`,
      waitMs: null,
      alternateAction: null,
    };
  }

  // A risky step that failed should always come back to the person
  // rather than being auto-retried or auto-skipped - the same "person's
  // eyes on it" principle riskClassifier.js applies before a risky step
  // runs applies again once one has failed.
  if (isRisky) {
    return {
      strategy: RECOVERY_STRATEGIES.ASK_PERSON,
      reasoning: 'This step is marked risky - failures on risky steps need your review rather than an automatic retry.',
      waitMs: null,
      alternateAction: null,
    };
  }

  if (transient && attemptCount === 0) {
    return {
      strategy: RECOVERY_STRATEGIES.RETRY,
      reasoning: 'The error looks transient (network/timeout/rate-limit) - retrying as-is.',
      waitMs: null,
      alternateAction: null,
    };
  }

  if (transient && attemptCount === 1) {
    return {
      strategy: RECOVERY_STRATEGIES.RETRY_WITH_BACKOFF,
      reasoning: 'Still looks transient after one retry - waiting briefly before trying again in case the underlying issue (rate limit, brief outage) needs a moment to clear.',
      waitMs: BACKOFF_MS_BASE * Math.pow(2, attemptCount),
      alternateAction: null,
    };
  }

  // Non-transient, or transient but already retried with backoff once -
  // this is the genuinely ambiguous case. Ask the model whether a
  // different concrete approach exists for this one step, or whether the
  // step is safe to skip (nothing depends on it) vs needs a person.
  const modelDecision = await askModelForRecoveryStrategy(step, { hasDependents, attemptCount });
  return modelDecision;
}

async function askModelForRecoveryStrategy(step, { hasDependents, attemptCount }) {
  const systemPrompt = `You are ZAO's recovery planner. One plan step failed and simple retries haven't resolved it (or don't look like they would). Decide what should happen next.

Options, in order of preference:
- "alternate_approach": if you can suggest a genuinely different way to accomplish the SAME step's goal (different tool, different command, different target), which might avoid whatever caused the failure. Only choose this if you have a concrete alternative in mind - describe it in "alternateDescription".
- "skip_and_continue": ONLY if nothing else in the plan depends on this step succeeding (hasDependents is false) and skipping it wouldn't undermine the plan's goal.
- "ask_person": if the failure suggests a real decision or missing information only the person can supply (e.g. ambiguous requirements, a missing credential, a genuinely destructive edge case).

Respond with ONLY a JSON object, no markdown fences, no commentary:
{ "strategy": "alternate_approach" | "skip_and_continue" | "ask_person", "reasoning": "one sentence", "alternateDescription": "only if strategy is alternate_approach - a concrete different way to do this step" }`;

  const userContent = `Step: ${step.description}\nDomain: ${step.domain}\nAction: ${step.action || 'n/a'}\nTarget: ${step.target || 'n/a'}\nError: ${step.error_message || step.errorMessage || 'unknown error'}\nAttempts so far: ${attemptCount}\nOther pending steps depend on this one: ${hasDependents}`;

  const history = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const modelResult = await llamaEngine.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
    maxTokens: 300,
    temperature: 0.3,
  });

  const parsed = modelResult.success && modelResult.data?.content ? safeParseRecoveryJson(modelResult.data.content) : null;

  if (parsed?.strategy === RECOVERY_STRATEGIES.SKIP_AND_CONTINUE && !hasDependents) {
    return {
      strategy: RECOVERY_STRATEGIES.SKIP_AND_CONTINUE,
      reasoning: parsed.reasoning || 'Nothing else in the plan depends on this step - skipping it and continuing.',
      waitMs: null,
      alternateAction: null,
    };
  }

  if (parsed?.strategy === RECOVERY_STRATEGIES.ALTERNATE_APPROACH && parsed.alternateDescription) {
    return {
      strategy: RECOVERY_STRATEGIES.ALTERNATE_APPROACH,
      reasoning: parsed.reasoning || 'Trying a different approach to the same step.',
      waitMs: null,
      alternateAction: { description: parsed.alternateDescription },
    };
  }

  // Default/fallback: if the model call failed, returned something
  // unparseable, or genuinely picked ask_person - always safe to hand to
  // the person rather than guessing.
  return {
    strategy: RECOVERY_STRATEGIES.ASK_PERSON,
    reasoning: parsed?.reasoning || 'This step needs your input to move forward.',
    waitMs: null,
    alternateAction: null,
  };
}

function safeParseRecoveryJson(rawContent) {
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

/**
 * Builds the plan_recovery_attempts row shape for a decision returned by
 * planRecovery() - a thin helper so planCoordinator.js doesn't
 * hand-assemble this object inline at every call site.
 */
export function buildRecoveryAttemptRecord(planId, stepId, attemptNumber, decision) {
  return {
    id: uuidv4(),
    planId,
    stepId,
    attemptNumber,
    strategy: decision.strategy,
    reasoning: decision.reasoning,
  };
}
