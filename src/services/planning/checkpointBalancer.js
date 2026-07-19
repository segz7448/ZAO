/**
 * ZAO - Checkpoint Balancer
 *
 * Not one of the 8 planning types, and not per-step like
 * riskClassifier.js - this is a running BALANCE check across a whole
 * plan's execution so far: how much unverified change has piled up
 * since the last pause, and is it time to suggest stopping to check
 * before going further.
 *
 * ============================================================
 * WHAT THIS MIRRORS
 * ============================================================
 * A capable agent working through a long unattended sequence of
 * successful steps doesn't just keep going because nothing has failed
 * yet - at some point it notices the accumulated surface area of
 * unverified change and says, out loud, something like: "Given the
 * volume built today, I'd suggest packaging this as a checkpoint now
 * for real device testing before continuing... untested code compounding
 * on untested code makes debugging much harder later." That's a
 * judgment about VOLUME AND BLAST RADIUS, made proactively, not a
 * reaction to any single step being risky (every step in that example
 * may have individually succeeded and been perfectly safe).
 *
 * riskClassifier.js answers "should THIS step pause for approval before
 * it runs?" - a local, per-step, pre-execution question. This module
 * answers a different question, asked AFTER steps succeed: "given
 * everything that's happened since the last checkpoint, should we
 * pause here anyway, even though nothing failed?" It's a balance
 * between forward progress and accumulated unverified risk - hence
 * "balancer", not "classifier".
 *
 * ============================================================
 * SIGNALS (what accumulates pressure)
 * ============================================================
 *   - stepsSinceCheckpoint     - raw count; even uniformly safe steps
 *                                add up to something worth checking
 *   - filesSinceCheckpoint     - distinct file/coding targets touched;
 *                                more surface area = harder to verify by
 *                                inspection alone
 *   - domainsSinceCheckpoint   - distinct domains touched (files + github
 *                                + terminal in the same stretch is a
 *                                wider blast radius than files alone)
 *   - riskyApprovedSinceCheckpoint - risky steps the person already
 *                                approved; each one is a point where
 *                                something irreversible happened, so
 *                                these weigh heavily
 *   - hasVerificationStep      - whether ANY step since the last
 *                                checkpoint already looked like a
 *                                test/build/syntax-check. This REDUCES
 *                                pressure, since verification already
 *                                happened organically as part of the
 *                                plan itself (e.g. executionPlanner.js
 *                                planned an explicit syntax-check step) -
 *                                the balancer shouldn't nag for a
 *                                checkpoint that's already effectively
 *                                happened.
 *
 * This module is pure/read-only with respect to a plan's steps - it
 * only reads plan.steps and plan.last_checkpoint_at and returns a
 * verdict. planExecutor.js is the only caller that acts on that verdict
 * (persisting a suggestion via database.js's recordCheckpointSuggestion,
 * pausing the run loop).
 */

import { v4 as uuidv4 } from 'uuid';
import { STEP_STATUS } from './planTypes';

/** Regex fragments that mark a step as "this itself is a verification action" - matched against description/action, case-insensitively. Kept intentionally broad (test, build, compile, lint, syntax, verify, check) since executionPlanner.js's model-authored descriptions phrase these many different ways. */
const VERIFICATION_PATTERNS = [
  /\btest(s|ing)?\b/i,
  /\bsyntax\s*check/i,
  /\bbuild\b/i,
  /\bcompile/i,
  /\blint/i,
  /\bverify|verification/i,
  /\bvalidate|validation/i,
  /\brun\s+(the\s+)?(app|tests)\b/i,
];

/** Weights used to turn raw signal counts into one pressure score. Tuned so a small, careful plan (a handful of steps, one file) never trips the threshold, while a long multi-file, multi-domain, multiple-risky-approvals stretch does - same shape of judgment call as image 4's "given the volume built today" moment. */
const WEIGHTS = {
  perStep: 1,
  perFile: 1.5,
  perDomainBeyondFirst: 2.5, // the first domain touched is "free" - it's crossing INTO a second/third domain in the same stretch that widens blast radius
  perRiskyApproved: 3,
  verificationDiscount: 5, // subtracted once if any verification-shaped step ran since the last checkpoint
};

/** Pressure score at or above this suggests a checkpoint. Deliberately not hit by "wrote 3 new files, one syntax check in between" (a normal, well-verified stretch) but easily hit by "12 steps, 5 files, 2 domains, 2 risky approvals, no verification in between" - the image-4 scenario. */
const PRESSURE_THRESHOLD = 10;

/** Hard cap: regardless of how low the computed pressure score is (e.g. many trivial same-file steps with a low per-signal score), never let more than this many steps run since the last checkpoint without at least suggesting one - mirrors not letting "volume" alone go unchecked forever even if each individual signal looks mild. */
const HARD_STEP_CAP = 15;

/**
 * @param {object} plan - a plan row with `.steps` attached (from getPlan()/getPlanTree()), including last_checkpoint_at, created_at
 * @returns {{
 *   shouldSuggest: boolean,
 *   pressureScore: number,
 *   stepsSinceCheckpoint: number,
 *   filesSinceCheckpoint: string[],
 *   domainsSinceCheckpoint: string[],
 *   riskyApprovedSinceCheckpoint: number,
 *   hasVerificationStep: boolean,
 *   reason: string|null,
 * }}
 */
export function evaluateCheckpointPressure(plan) {
  const cutoff = plan.last_checkpoint_at || plan.created_at || 0;
  const steps = plan.steps || [];

  const doneSinceCheckpoint = steps.filter((s) => s.status === STEP_STATUS.DONE && (s.completed_at || 0) >= cutoff);

  if (doneSinceCheckpoint.length === 0) {
    return {
      shouldSuggest: false,
      pressureScore: 0,
      stepsSinceCheckpoint: 0,
      filesSinceCheckpoint: [],
      domainsSinceCheckpoint: [],
      riskyApprovedSinceCheckpoint: 0,
      hasVerificationStep: false,
      reason: null,
    };
  }

  const files = new Set();
  const domains = new Set();
  let riskyApproved = 0;
  let hasVerificationStep = false;

  for (const step of doneSinceCheckpoint) {
    if (step.domain === 'files' || step.domain === 'coding') {
      if (step.target) files.add(step.target);
    }
    domains.add(step.domain);
    if (step.is_risky) riskyApproved += 1;
    const text = `${step.description || ''} ${step.action || ''}`;
    if (VERIFICATION_PATTERNS.some((pattern) => pattern.test(text))) {
      hasVerificationStep = true;
    }
  }

  const domainOverflow = Math.max(0, domains.size - 1);
  let pressureScore =
    doneSinceCheckpoint.length * WEIGHTS.perStep +
    files.size * WEIGHTS.perFile +
    domainOverflow * WEIGHTS.perDomainBeyondFirst +
    riskyApproved * WEIGHTS.perRiskyApproved;

  if (hasVerificationStep) {
    pressureScore = Math.max(0, pressureScore - WEIGHTS.verificationDiscount);
  }

  const overHardCap = doneSinceCheckpoint.length >= HARD_STEP_CAP;
  const shouldSuggest = pressureScore >= PRESSURE_THRESHOLD || overHardCap;

  return {
    shouldSuggest,
    pressureScore: Math.round(pressureScore * 10) / 10,
    stepsSinceCheckpoint: doneSinceCheckpoint.length,
    filesSinceCheckpoint: Array.from(files),
    domainsSinceCheckpoint: Array.from(domains),
    riskyApprovedSinceCheckpoint: riskyApproved,
    hasVerificationStep,
    reason: shouldSuggest ? buildReason({ steps: doneSinceCheckpoint.length, files: files.size, domains: domains.size, riskyApproved, overHardCap }) : null,
  };
}

/** Builds the human-readable suggestion text shown in PlanScreen.js's checkpoint banner - phrased the same way image 4's real suggestion was: naming the volume, naming the risk, naming why pausing now is cheaper than pausing later. */
function buildReason({ steps, files, domains, riskyApproved, overHardCap }) {
  const parts = [];
  parts.push(`${steps} step${steps === 1 ? '' : 's'} completed`);
  if (files > 0) parts.push(`${files} file${files === 1 ? '' : 's'} touched`);
  if (domains > 1) parts.push(`${domains} different areas involved`);
  if (riskyApproved > 0) parts.push(`${riskyApproved} risky step${riskyApproved === 1 ? '' : 's'} already approved`);

  const summary = parts.join(', ');
  const closing = overHardCap
    ? 'that\u2019s a lot to run unattended - worth a checkpoint before continuing.'
    : 'untested change compounding on untested change makes problems harder to trace later - worth verifying before continuing.';

  return `${summary}. ${closing.charAt(0).toUpperCase()}${closing.slice(1)}`;
}

/**
 * Builds the plan_checkpoints insert payload from an evaluation -
 * planExecutor.js calls this right before database.js's
 * recordCheckpointSuggestion() so the shape stays in one place.
 */
export function buildCheckpointRecord(evaluation) {
  return {
    id: uuidv4(),
    stepsCovered: evaluation.stepsSinceCheckpoint,
    filesCovered: evaluation.filesSinceCheckpoint,
    domainsCovered: evaluation.domainsSinceCheckpoint,
    riskySteps: evaluation.riskyApprovedSinceCheckpoint,
    pressureScore: evaluation.pressureScore,
    reason: evaluation.reason,
  };
}
