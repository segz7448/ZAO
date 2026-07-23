/**
 * ZAO - Plan Executor
 *
 * The runtime counterpart to planCoordinator.js: once a plan (or an
 * Execution-level leaf plan within a larger hierarchy) has been built
 * and persisted, this module actually walks its steps and runs them,
 * one dependency-respecting step at a time, using the exact same
 * TOOL_REGISTRY toolOrchestrator.js's own loop uses - the plan executor
 * doesn't reimplement tool-calling, it just adds scheduling, approval
 * gating, and recovery around the same primitives.
 *
 * WHAT THIS ADDS ON TOP OF "JUST RUN THE STEPS IN ORDER":
 *   - Dependency-aware scheduling: a step only starts once every id in
 *     its depends_on_step_id / depends_on_step_ids has status 'done'.
 *     If a dependency failed or was skipped, this step is marked
 *     'blocked' instead of silently running against missing prior work
 *     (mirrors resourcePlanner.js's readiness check, but for step
 *     ordering instead of external resources).
 *   - Resource gating: before a step starts, resourcePlanner.js's
 *     checkStepResourceReadiness() is consulted against the plan's
 *     already-computed plan_resources rows - a step needing GitHub with
 *     no token on file gets marked 'blocked' rather than failing deep
 *     inside a tool call.
 *   - Risk pausing: exactly Phase 1's contract - a step with is_risky=1
 *     stops the executor and sets status 'awaiting_approval' rather than
 *     running, same as riskClassifier.js originally promised.
 *   - Recovery on failure: a failed step is hand off to
 *     recoveryPlanner.js, which returns a strategy; this executor acts
 *     on it (retry/backoff/alternate/skip/ask/abort) rather than just
 *     marking 'failed' and stopping.
 *
 * This module does not decide WHAT to run (that's already been decided
 * by planCoordinator.js at plan-creation time) - it only decides WHEN
 * each already-planned step is ready to run and WHAT HAPPENS on
 * success/failure. Same separation of concerns as Phase 1's comments
 * already called out between planning and the "Phase 2" executor - this
 * IS that executor.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  getPlan,
  updatePlanStep,
  updatePlanStatus,
  updateMilestoneStatus,
  getPlanResources,
  insertRecoveryAttempt,
  resolveRecoveryAttempt,
  recordCheckpointSuggestion,
  resolveCheckpointSuggestion,
  startStepAction,
  completeStepAction,
  logStepReasoning,
} from '../../db/database';
import { TOOL_REGISTRY } from '../toolOrchestrator';
import { checkStepResourceReadiness } from './resourcePlanner';
import { planRecovery, buildRecoveryAttemptRecord } from './recoveryPlanner';
import { evaluateCheckpointPressure, buildCheckpointRecord } from './checkpointBalancer';
import { PLAN_STATUS, STEP_STATUS, RECOVERY_STRATEGIES } from './planTypes';
import { recordProcedure } from '../memory/proceduralMemory';

/**
 * Finds every step in `steps` that is currently eligible to run: status
 * 'pending', and every one of its dependencies (single + fan-in list)
 * already 'done'. Steps whose dependency failed/was skipped are flagged
 * separately so the caller can mark them 'blocked' rather than leaving
 * them stuck as 'pending' forever.
 */
export function computeReadySteps(steps) {
  const statusById = new Map(steps.map((s) => [s.id, s.status]));
  const ready = [];
  const newlyBlocked = [];

  for (const step of steps) {
    if (step.status !== STEP_STATUS.PENDING) continue;

    const depIds = new Set();
    if (step.depends_on_step_id) depIds.add(step.depends_on_step_id);
    if (step.depends_on_step_ids) {
      for (const id of step.depends_on_step_ids.split(',').filter(Boolean)) depIds.add(id);
    }

    if (depIds.size === 0) {
      ready.push(step);
      continue;
    }

    let anyDeadDependency = false;
    let allDone = true;
    for (const depId of depIds) {
      const depStatus = statusById.get(depId);
      if (depStatus === STEP_STATUS.FAILED || depStatus === STEP_STATUS.SKIPPED || depStatus === STEP_STATUS.BLOCKED) {
        anyDeadDependency = true;
      }
      if (depStatus !== STEP_STATUS.DONE) {
        allDone = false;
      }
    }

    if (anyDeadDependency) {
      newlyBlocked.push(step);
    } else if (allDone) {
      ready.push(step);
    }
    // else: still waiting on a pending/running dependency - leave as-is
  }

  return { ready, newlyBlocked };
}

/**
 * Runs one step's actual tool call via TOOL_REGISTRY - the same
 * function map toolOrchestrator.js's own loop uses. A plan step's
 * `action` should match a TOOL_REGISTRY key exactly (executionPlanner.js
 * asks the model for this, but the model can drift), so this resolves
 * loosely: exact match first, then a normalized fallback, then a clear
 * "couldn't resolve" failure rather than a crash.
 */
async function runStepTool(step, planId, { agentSession = null } = {}) {
  // ---- Browser domain: no TOOL_REGISTRY entry exists for this - browsing
  // runs through the live PC agent session (Playwright, server/browserAgent.js),
  // same mechanism orchestrator.js's ad-hoc chat path uses, not a
  // registered tool function. Handled as its own branch rather than
  // forcing it through TOOL_REGISTRY's shape.
  if (step.domain === 'browser') {
    return runBrowserStep(step, planId, agentSession);
  }

  const resolvedToolName = TOOL_REGISTRY[step.action] ? step.action : normalizeActionGuess(step);
  const toolDef = TOOL_REGISTRY[resolvedToolName];

  if (!toolDef) {
    return { success: false, error: `Could not resolve a tool for action "${step.action}" (domain: ${step.domain}). This step may need to be re-planned.` };
  }

  let args = {};
  try {
    const details = step.details_json ? JSON.parse(step.details_json) : {};
    args = { path: step.target, target: step.target, name: step.target, ...details, ...(step.parsedArgs || {}) };
  } catch (err) {
    args = { path: step.target, target: step.target };
  }

  // fs_create_file with no content isn't a tool-call bug to retry - it's
  // a planning gap (the model never generated the file's text). Retrying
  // the identical call just reproduces the same native "undefined" crash
  // every time, so fail this immediately with a clear, actionable error
  // instead of looping through recoveryPlanner.js on a call that can
  // never succeed as-is.
  if (resolvedToolName === 'fs_create_file' && typeof args.content !== 'string') {
    const errorMessage = `This step was supposed to create "${step.target || 'a file'}" but no file content was generated for it. Re-run the request and ask ZAO to write the file directly in chat instead of through a plan.`;
    const actionId = uuidv4();
    await startStepAction(actionId, { stepId: step.id, planId, toolName: resolvedToolName, label: step.description, input: args });
    await completeStepAction(actionId, { status: 'failed', error: errorMessage });
    return { success: false, error: errorMessage, noRetry: true };
  }

  // ---- Tier 4 of the trace model: log the REAL tool-call attempt ----
  // Logged BEFORE the call runs (not after) so a hang or thrown
  // exception still leaves a 'running' row behind rather than no record
  // at all - and action_order auto-increments per step in
  // startStepAction(), so a retried step (recoveryPlanner.js) naturally
  // produces one row per attempt, each with its own real input/output,
  // instead of overwriting the previous attempt's record.
  const actionId = uuidv4();
  await startStepAction(actionId, {
    stepId: step.id,
    planId,
    toolName: resolvedToolName,
    label: step.description,
    input: args,
  });

  try {
    const result = await toolDef.run(args);
    await completeStepAction(actionId, { status: result.success ? 'done' : 'failed', output: result });
    return result;
  } catch (err) {
    const errorMessage = err?.message || 'Tool call threw an unexpected error.';
    await completeStepAction(actionId, { status: 'failed', error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

/**
 * Runs one browser-domain step through the live PC agent session. There
 * is no separate on/off "browser access" precondition here the way
 * orchestrator.js's ad-hoc chat path used to have - a browser-domain
 * step only exists in a plan because executionPlanner.js decided the
 * goal genuinely needs it, and the plan itself already went through
 * riskClassifier.js's approval gate for anything actually risky (a
 * form submit, a payment). Requiring an ADDITIONAL manual toggle on top
 * of that would just be a forgettable extra step blocking a task the
 * person already asked for - so the real (and only) gate here is
 * whether a live agentSession actually exists to run it on.
 */
async function runBrowserStep(step, planId, agentSession) {
  const actionId = uuidv4();
  const input = { task: step.target || step.description };

  await startStepAction(actionId, {
    stepId: step.id,
    planId,
    toolName: 'browser_agent_task',
    label: step.description,
    input,
  });

  if (!agentSession) {
    // Genuine capability gap (PC not connected / PiP not mounted), not a
    // consent gate - surfaced as a real, actionable failure so
    // recoveryPlanner.js's ask_person path (risky-adjacent, no automatic
    // retry can fix "no session exists") gives the person something
    // concrete to act on.
    const errorMessage = 'The browser agent isn\u2019t connected right now, so this step can\u2019t run. Make sure your PC backend is running and reachable, then resume this plan.';
    await completeStepAction(actionId, { status: 'failed', error: errorMessage });
    return { success: false, error: errorMessage };
  }

  try {
    const agentResult = await agentSession.runTaskAwaitable(input.task);
    if (agentResult.success) {
      await completeStepAction(actionId, { status: 'done', output: agentResult });
      return { success: true, data: agentResult.answer, stepsUsed: agentResult.stepsUsed };
    }

    const errorMessage = agentResult.needsHuman
      ? (agentResult.reason || 'This step needs a person to take over in the browser (e.g. a CAPTCHA or login).')
      : (agentResult.error?.message || 'Browser agent task failed.');
    await completeStepAction(actionId, { status: 'failed', error: errorMessage });
    return { success: false, error: errorMessage, needsHuman: !!agentResult.needsHuman };
  } catch (err) {
    const errorMessage = err?.message || 'Browser agent task threw an unexpected error.';
    await completeStepAction(actionId, { status: 'failed', error: errorMessage });
    return { success: false, error: errorMessage };
  }
}

/** Best-effort guess if a step's literal `action` string doesn't exactly match a TOOL_REGISTRY key - tries the most common domain-default action so a near-miss from the model doesn't immediately fail the step. */
function normalizeActionGuess(step) {
  const domainDefaults = {
    files: 'fs_create_file',
    github: 'github_commit_files',
    terminal: 'terminal_pc_run_command',
  };
  return domainDefaults[step.domain] || step.action;
}

/**
 * Marks any milestone whose target_step_id just completed as 'reached',
 * and any milestone whose steps are now in progress as 'in_progress'.
 * Cheap, called after every step completion rather than in a separate
 * pass, so PlanScreen.js's milestone display never lags behind the
 * step checklist it's summarizing.
 */
async function updateMilestonesAfterStep(plan, completedStepId) {
  const milestone = (plan.milestones || []).find((m) => m.target_step_id === completedStepId);
  if (milestone) {
    await updateMilestoneStatus(milestone.id, 'reached', { reachedAt: Date.now() });
  }
}

/**
 * Runs one Execution-level plan to completion (or until it needs
 * approval / hits an unrecoverable failure / is cancelled). Call this
 * once per execution plan id produced by planCoordinator.buildPlan() -
 * for a plan with multiple execution leaves (several tasks), the caller
 * (planStore.js) runs this once per leaf, typically in the leaf order
 * planCoordinator already produced.
 *
 * @param {string} planId - an Execution-level plans row id
 * @param {object} options - { githubToken, onStep(label), onAwaitingApproval(step), shouldContinue(): boolean - polled between steps so a person's "Stop" tap actually halts the loop }
 * @returns {Promise<{ success: boolean, status: string, error: object|null }>}
 */
export async function runExecutionPlan(planId, options = {}) {
  const { githubToken = null, agentSession = null, onStep = null, onAwaitingApproval = null, onCheckpointSuggested = null, shouldContinue = () => true } = options;

  const planResult = await getPlan(planId);
  if (!planResult.success || !planResult.data) {
    return { success: false, status: PLAN_STATUS.FAILED, error: { message: 'Plan not found.' } };
  }

  await updatePlanStatus(planId, PLAN_STATUS.RUNNING);

  // Loop: each pass re-reads the plan (cheap - local sqlite), computes
  // which steps are ready, and runs the first ready one. Re-reading
  // rather than caching in memory keeps this resilient to a resumed
  // session (person closed the app mid-plan and reopened it) without a
  // separate "resume" code path - runExecutionPlan() picking back up on
  // a partially-done plan IS the resume path.
  while (shouldContinue()) {
    const currentPlanResult = await getPlan(planId);
    if (!currentPlanResult.success || !currentPlanResult.data) {
      return { success: false, status: PLAN_STATUS.FAILED, error: { message: 'Plan disappeared mid-run.' } };
    }
    const plan = currentPlanResult.data;
    const steps = plan.steps || [];

    const { ready, newlyBlocked } = computeReadySteps(steps);

    for (const blockedStep of newlyBlocked) {
      await updatePlanStep(blockedStep.id, planId, { status: STEP_STATUS.BLOCKED, errorMessage: 'A dependency for this step did not complete successfully.' });
    }

    const allSteps = [...steps];
    const stillPending = allSteps.some((s) => s.status === STEP_STATUS.PENDING || s.status === STEP_STATUS.RUNNING);
    const anyAwaiting = allSteps.some((s) => s.status === STEP_STATUS.AWAITING_APPROVAL);

    if (ready.length === 0) {
      if (anyAwaiting) {
        await updatePlanStatus(planId, PLAN_STATUS.AWAITING_APPROVAL);
        return { success: true, status: PLAN_STATUS.AWAITING_APPROVAL, error: null };
      }
      if (!stillPending) {
        const anyFailed = allSteps.some((s) => s.status === STEP_STATUS.FAILED);
        const finalStatus = anyFailed ? PLAN_STATUS.FAILED : PLAN_STATUS.COMPLETED;
        await updatePlanStatus(planId, finalStatus, { completedAt: Date.now() });

        // Procedural memory: distill this run's step sequence into a
        // reusable recipe ONLY on a clean completion - a failed or
        // partially-blocked run isn't "how to do X", it's a cautionary
        // tale, and recording it as a hint would steer a future similar
        // goal toward the same failure. Fire-and-forget: never let this
        // delay or fail the plan-completion response itself.
        if (finalStatus === PLAN_STATUS.COMPLETED) {
          recordProcedure(plan.goal, allSteps.map((s) => ({ domain: s.domain, description: s.description })), planId)
            .catch((err) => console.error('[PlanExecutor] recordProcedure failed:', err));
        }

        return { success: !anyFailed, status: finalStatus, error: null };
      }
      // Nothing ready, nothing awaiting, but something's still pending -
      // shouldn't normally happen (would imply an unresolvable
      // dependency that computeReadySteps didn't catch), but don't spin
      // forever if it does.
      await updatePlanStatus(planId, PLAN_STATUS.FAILED, { completedAt: Date.now() });
      return { success: false, status: PLAN_STATUS.FAILED, error: { message: 'Plan stalled: remaining steps are neither ready nor blocked.' } };
    }

    const step = ready[0];

    // ---- Risk gate (Phase 1 contract, unchanged) ----
    if (step.is_risky) {
      await updatePlanStep(step.id, planId, { status: STEP_STATUS.AWAITING_APPROVAL });
      onAwaitingApproval?.(step);
      await updatePlanStatus(planId, PLAN_STATUS.AWAITING_APPROVAL);
      return { success: true, status: PLAN_STATUS.AWAITING_APPROVAL, error: null };
    }

    // ---- Resource gate ----
    const resourcesResult = await getPlanResources(planId);
    const readiness = checkStepResourceReadiness(resourcesResult.data || [], step);
    if (!readiness.allowed) {
      await updatePlanStep(step.id, planId, { status: STEP_STATUS.BLOCKED, errorMessage: `Blocked: ${readiness.blockedBy} is not available.` });
      continue;
    }

    // ---- Run the step ----
    await updatePlanStep(step.id, planId, { status: STEP_STATUS.RUNNING, startedAt: Date.now() });
    const result = await runStepTool(step, planId, { agentSession });

    if (result.success) {
      await updatePlanStep(step.id, planId, { status: STEP_STATUS.DONE, result, completedAt: Date.now() });
      await updateMilestonesAfterStep(plan, step.id);
      onStep?.(step.description);

      // ---- Checkpoint balancing ----
      // Re-read the plan so the step just marked 'done' above is
      // reflected in what evaluateCheckpointPressure() sees - the `plan`
      // object in this closure was fetched before this step ran.
      const refreshedForCheckpoint = await getPlan(planId);
      if (refreshedForCheckpoint.success && refreshedForCheckpoint.data) {
        const evaluation = evaluateCheckpointPressure(refreshedForCheckpoint.data);
        if (evaluation.shouldSuggest) {
          const record = buildCheckpointRecord(evaluation);
          await recordCheckpointSuggestion(planId, record);
          await updatePlanStatus(planId, PLAN_STATUS.PAUSED);
          onCheckpointSuggested?.(evaluation);
          return { success: true, status: PLAN_STATUS.PAUSED, error: null, checkpoint: evaluation };
        }
      }

      continue;
    }

    // ---- Failure: hand off to recovery planning ----
    const outcome = await handleStepFailure(plan, step, result, { onStep });
    if (outcome === 'abort') {
      await updatePlanStatus(planId, PLAN_STATUS.FAILED, { completedAt: Date.now() });
      return { success: false, status: PLAN_STATUS.FAILED, error: { message: `Aborted: ${step.description} failed and could not be recovered.` } };
    }
    if (outcome === 'ask_person') {
      await updatePlanStep(step.id, planId, { status: STEP_STATUS.AWAITING_APPROVAL, errorMessage: result.error || 'This step failed and needs your input to continue.' });
      onAwaitingApproval?.(step);
      await updatePlanStatus(planId, PLAN_STATUS.AWAITING_APPROVAL);
      return { success: true, status: PLAN_STATUS.AWAITING_APPROVAL, error: null };
    }
    // 'retried' or 'skipped' - loop continues, computeReadySteps will
    // pick up the next eligible step (which may be this same one again,
    // now back to 'pending' after a retry).
  }

  return { success: true, status: PLAN_STATUS.PAUSED, error: null };
}

/**
 * Runs recoveryPlanner.planRecovery() for one failed step and acts on
 * the strategy it returns. Returns a short outcome tag the caller's loop
 * switches on: 'retried' (step is back to pending, loop should continue
 * and will pick it up again), 'skipped' (step marked skipped, loop
 * continues), 'ask_person' (caller should pause the whole plan),
 * 'abort' (caller should fail the whole plan).
 */
async function handleStepFailure(plan, step, result, { onStep }) {
  const planId = plan.id;

  if (result.noRetry) {
    await updatePlanStep(step.id, planId, { status: STEP_STATUS.AWAITING_APPROVAL, errorMessage: result.error });
    onStep?.({ ...step, status: STEP_STATUS.AWAITING_APPROVAL, error_message: result.error });
    return 'ask_person';
  }

  const previousAttempts = []; // recoveryPlanner reads retry_count directly off the step; a fuller implementation would also fetch getRecoveryAttempts(step.id) here for richer context
  const hasDependents = (plan.steps || []).some((s) => {
    if (s.id === step.id) return false;
    if (s.depends_on_step_id === step.id) return true;
    if (s.depends_on_step_ids) {
      return s.depends_on_step_ids.split(',').filter(Boolean).includes(step.id);
    }
    return false;
  });

  const decision = await planRecovery(
    { ...step, error_message: result.error, hasDependents },
    { previousAttempts, isRisky: !!step.is_risky }
  );

  const attemptNumber = (step.retry_count || 0) + 1;
  const attemptRecord = buildRecoveryAttemptRecord(planId, step.id, attemptNumber, decision);
  await insertRecoveryAttempt(attemptRecord);

  switch (decision.strategy) {
    case RECOVERY_STRATEGIES.RETRY: {
      await updatePlanStep(step.id, planId, { status: STEP_STATUS.PENDING, retryCount: attemptNumber, errorMessage: null });
      await resolveRecoveryAttempt(attemptRecord.id, 'retried');
      onStep?.(`Retrying: ${step.description}`);
      return 'retried';
    }

    case RECOVERY_STRATEGIES.RETRY_WITH_BACKOFF: {
      if (decision.waitMs) {
        await new Promise((resolve) => setTimeout(resolve, decision.waitMs));
      }
      await updatePlanStep(step.id, planId, { status: STEP_STATUS.PENDING, retryCount: attemptNumber, errorMessage: null });
      await resolveRecoveryAttempt(attemptRecord.id, 'retried');
      onStep?.(`Retrying after a short wait: ${step.description}`);
      return 'retried';
    }

    case RECOVERY_STRATEGIES.ALTERNATE_APPROACH: {
      // Actually change what gets retried, not just reset status and
      // hope - append the model's suggested different approach onto the
      // step's own description, so the next pass through runStepTool()
      // (and, for a coding step, whatever reads the description as its
      // instruction) sees the new guidance instead of silently repeating
      // the exact same failing action.
      const alternateDescription = decision.alternateAction?.description;
      const nextDescription = alternateDescription
        ? `${step.description}\n\n[Recovery attempt ${attemptNumber}: previous attempt failed (${result.error || 'unknown error'}). Try instead: ${alternateDescription}]`
        : step.description;
      await updatePlanStep(step.id, planId, {
        status: STEP_STATUS.PENDING,
        retryCount: attemptNumber,
        errorMessage: null,
        description: nextDescription,
      });
      await resolveRecoveryAttempt(attemptRecord.id, 'retried');
      onStep?.(`Trying a different approach: ${step.description}`);
      return 'retried';
    }

    case RECOVERY_STRATEGIES.SKIP_AND_CONTINUE: {
      await updatePlanStep(step.id, planId, { status: STEP_STATUS.SKIPPED, errorMessage: result.error });
      await resolveRecoveryAttempt(attemptRecord.id, 'skipped');
      onStep?.(`Skipped (nothing else depends on it): ${step.description}`);
      return 'skipped';
    }

    case RECOVERY_STRATEGIES.ABORT_PLAN: {
      await resolveRecoveryAttempt(attemptRecord.id, 'aborted');
      onStep?.(`Could not recover: ${step.description}`);
      return 'abort';
    }

    case RECOVERY_STRATEGIES.ASK_PERSON:
    default: {
      await updatePlanStep(step.id, planId, {
        status: STEP_STATUS.AWAITING_APPROVAL,
        errorMessage: decision.reasoning || result.error,
      });
      await resolveRecoveryAttempt(attemptRecord.id, 'asked_person');
      onStep?.({ ...step, status: STEP_STATUS.AWAITING_APPROVAL, error_message: result.error });
      return 'ask_person';
    }
  }
}
  