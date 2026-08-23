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
  getRecoveryAttempts,
  recordCheckpointSuggestion,
  resolveCheckpointSuggestion,
  startStepAction,
  completeStepAction,
  logStepReasoning,
  getPreferences,
} from '../../db/database';
import { TOOL_REGISTRY } from '../toolOrchestrator';
import { checkStepResourceReadiness } from './resourcePlanner';
import { planRecovery, buildRecoveryAttemptRecord } from './recoveryPlanner';
import { evaluateCheckpointPressure, buildCheckpointRecord } from './checkpointBalancer';
import { PLAN_STATUS, STEP_STATUS, RECOVERY_STRATEGIES } from './planTypes';
import { recordProcedure } from '../memory/proceduralMemory';

/**
 * Every tool result's .error can be either a plain string or an
 * {message, ...} object depending on which tool produced it (see
 * TOOL_REGISTRY entries across toolOrchestrator.js - not all of them
 * agree on a shape). Every call site below that stores or interpolates
 * an error into a text column/prompt needs a STRING, and passing the
 * raw object straight into a template literal or a TEXT column silently
 * stringifies it to the literal text "[object Object]" - exactly what
 * showed up in Step Detail's recovery-attempt text and would otherwise
 * get written into errorMessage/recoveryPlanner.js's own prompt too.
 * This is the one place that extracts a real message, so every call
 * site below stays consistent rather than repeating the same
 * string-vs-object check five times.
 */
function errorText(err, fallback = 'unknown error') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  return err.message || fallback;
}

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
 * pc_log_decision reuses fs_create_file's target=path/content=text shape
 * (see executionPlanner.js's own prompt comment) as
 * target=decision/content=reasoning, rather than the plan-step schema
 * growing a whole extra pair of fields just for this one tool. The
 * generic args-building in runStepTool only ever populates
 * path/target/name from step.target - it has no way to know THIS
 * tool's actual parameter names are `decision`/`reasoning`, so without
 * this translation the real call would always receive
 * decision:undefined, reasoning:undefined and fail its own
 * required-field check every single time a PLAN (as opposed to a
 * direct chat tool-call, which passes real named arguments) tried to
 * use it - a real bug this function exists to fix.
 */
export function translatePcLogDecisionArgs(step, baseArgs) {
  return { ...baseArgs, decision: step.target, reasoning: baseArgs.content || null, projectPath: baseArgs.projectPath || null };
}

/**
 * terminal_pc_run_command and pc_process_start both require a real
 * `command` string (see their TOOL_REGISTRY.run() signatures in
 * toolOrchestrator.js), but the generic args builder above only ever
 * populates path/target/name from step.target - it never sets `command`
 * unless the model's details_json for this step happened to include one
 * explicitly. When it didn't, args.command was undefined, so the VM
 * backend correctly rejected every attempt with "Missing \"command\"
 * string in request body" - and recoveryPlanner.js kept retrying the
 * exact same shape, since nothing in the retry path added the missing
 * field either. step.target IS the intended command for a terminal step
 * (executionPlanner.js's prompt asks the model to put it there), so
 * fall back to that - same convention translatePcLogDecisionArgs above
 * already uses for pc_log_decision's mismatched shape.
 */
export function translateTerminalArgs(step, baseArgs) {
  return { ...baseArgs, command: baseArgs.command || step.target || null };
}

/**
 * Zip/unzip tool functions (see TOOL_REGISTRY in toolOrchestrator.js)
 * take two distinct paths - a folder/zip AND a separate output/destination
 * path - under names that don't match the generic path/target/name
 * aliasing runStepTool builds for every step (that aliasing only ever
 * has ONE real value, step.target, to work with). The model supplies the
 * second path via extraArgs (see EXECUTION_SYSTEM_PROMPT in
 * executionPlanner.js), which the details spread already puts on
 * baseArgs under its own key (e.g. baseArgs.zipPath) - what's still
 * missing is renaming step.target's generic path/target/name aliases
 * into the SPECIFIC name each zip function actually destructures
 * (folderPath, zipOutputPath, destinationFolder, ...), since none of
 * those specific names get set by the generic aliasing at all.
 */
export function translateZipArgs(resolvedToolName, step, baseArgs) {
  switch (resolvedToolName) {
    case 'pc_fs_zip':
      return { ...baseArgs, folderPath: baseArgs.folderPath || step.target || null, zipPath: baseArgs.zipPath || null };
    case 'pc_fs_extract_zip':
      return { ...baseArgs, zipPath: baseArgs.zipPath || step.target || null, destinationFolderPath: baseArgs.destinationFolderPath || null };
    case 'fs_zip':
      return { ...baseArgs, folderPath: baseArgs.folderPath || step.target || null, zipOutputPath: baseArgs.zipOutputPath || baseArgs.zipPath || null };
    case 'fs_extract_zip':
      return { ...baseArgs, zipPath: baseArgs.zipPath || step.target || null, destinationFolder: baseArgs.destinationFolder || baseArgs.destinationFolderPath || null };
    default:
      return baseArgs;
  }
}
const ZIP_ACTIONS_SECOND_PATH_FIELD = {
  pc_fs_zip: 'zipPath',
  pc_fs_extract_zip: 'destinationFolderPath',
  fs_zip: 'zipOutputPath',
  fs_extract_zip: 'destinationFolder',
};

/**
 * github_commit_files/github_create_branch (and friends) take separate
 * `owner` and `repo` strings, but a plan step only has one `target`
 * field - EXECUTION_SYSTEM_PROMPT asks the model for target = "owner/repo"
 * for these, so split it here rather than asking the schema to grow an
 * owner/repo pair just for this one domain.
 */
export function translateGithubArgs(step, baseArgs) {
  if (baseArgs.owner && baseArgs.repo) return baseArgs;
  const [owner, repo] = String(step.target || '').split('/').map((s) => s.trim());
  return { ...baseArgs, owner: baseArgs.owner || owner || null, repo: baseArgs.repo || repo || null };
}

/**
 * pc_git_remote_add's `url` needs GitHub credentials embedded for later
 * `pc_git_push`/`pc_git_pull` calls to authenticate (the PC's git CLI has
 * no other way to know the person's token - it isn't logged into
 * anything, and the model is never given the raw secret to type into a
 * plan step in the first place, by design). This injects it exactly
 * like `git` itself accepts on an HTTPS remote: https://TOKEN@github.com/owner/repo.git
 * - only for github.com hosts, and only if the URL doesn't already carry
 * credentials (so a person's own pre-authenticated URL is never
 * clobbered). SSH-style remotes (git@github.com:owner/repo.git) aren't
 * touched - that's a different auth mechanism (the PC's own SSH key),
 * not something a token can help with.
 */
export function injectGithubCredentialsIntoUrl(url, githubToken) {
  if (!githubToken || typeof url !== 'string') return url;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (err) {
    return url; // not a parseable absolute URL (e.g. SSH shorthand) - leave untouched
  }
  if (!/(^|\.)github\.com$/i.test(parsed.hostname)) return url;
  if (parsed.username || parsed.password) return url;
  parsed.username = githubToken;
  return parsed.toString();
}

/**
 * Runs one step's actual tool call via TOOL_REGISTRY - the same
 * function map toolOrchestrator.js's own loop uses. A plan step's
 * `action` should match a TOOL_REGISTRY key exactly (executionPlanner.js
 * asks the model for this, but the model can drift), so this resolves
 * loosely: exact match first, then a normalized fallback, then a clear
 * "couldn't resolve" failure rather than a crash.
 */
async function runStepTool(step, planId, { agentSession = null, githubToken = null } = {}) {
  // ---- Planner failure: executionPlanner.js couldn't get a real,
  // parseable step out of the model for this unit of work (backend
  // unreachable, or a response that never resolved to valid JSON even
  // after its balanced-object extraction - see
  // executionPlanner.js's fallbackStepForUnit doc for the full story).
  // Fail this step HONESTLY rather than silently attempting a tool call
  // with action:null/target:null, which used to run (or silently no-op)
  // while the model still wrote a plausible "done" summary afterward -
  // exactly the "it says it's finished but it isn't" / "it explains how
  // to do it myself instead of doing it" failure this flag exists to
  // stop. A real failure here lets recoveryPlanner.js actually retry the
  // unit or surface it to the person, instead of the plan quietly
  // limping along on a step that never did anything.
  let plannedDetails = {};
  try {
    plannedDetails = step.details_json ? JSON.parse(step.details_json) : {};
  } catch (err) {
    plannedDetails = {};
  }
  if (plannedDetails.plannerFailed) {
    return {
      success: false,
      noRetry: false,
      error: `The planner couldn't produce a real action for "${step.description}" - the model's response for this step wasn't usable. Retrying should ask it again.`,
    };
  }

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

  if (resolvedToolName === 'pc_log_decision') {
    args = translatePcLogDecisionArgs(step, args);
  }

  if (resolvedToolName === 'terminal_pc_run_command' || resolvedToolName === 'pc_process_start') {
    args = translateTerminalArgs(step, args);
  }

  if (ZIP_ACTIONS_SECOND_PATH_FIELD[resolvedToolName]) {
    args = translateZipArgs(resolvedToolName, step, args);
  }

  if (resolvedToolName === 'github_commit_files' || resolvedToolName === 'github_create_branch') {
    args = translateGithubArgs(step, args);
  }

  if (resolvedToolName === 'pc_git_remote_add') {
    args = { ...args, url: injectGithubCredentialsIntoUrl(args.url, githubToken) };
  }

  // A content-writing step with no content isn't a tool-call bug to
  // retry - it's a planning gap (the model never generated the file's
  // text / the decision's reasoning). executionPlanner.js's
  // repairMissingStepContent() already gets a dedicated second attempt
  // at filling this in before a step ever reaches here, so landing in
  // this branch means BOTH the original planning call and the focused
  // repair call came back empty. Retrying the identical tool call at
  // that point just reproduces the same native "undefined" crash every
  // time, so fail this immediately with a clear, actionable error
  // instead of looping through recoveryPlanner.js on a call that can
  // never succeed as-is.
  //
  // Covers every action whose TOOL_REGISTRY.run() needs real body text:
  // fs_create_file/pc_fs_create_file take it as `content`;
  // pc_log_decision takes it as `reasoning` (see
  // translatePcLogDecisionArgs above, which runs before this check).
  const CONTENT_FIELD_BY_ACTION = {
    fs_create_file: 'content',
    pc_fs_create_file: 'content',
    pc_log_decision: 'reasoning',
  };
  const requiredContentField = CONTENT_FIELD_BY_ACTION[resolvedToolName];
  if (requiredContentField && typeof args[requiredContentField] !== 'string') {
    const subject = resolvedToolName === 'pc_log_decision' ? `the decision "${step.target || 'this decision'}"` : `"${step.target || 'a file'}"`;
    const errorMessage = `This step was supposed to write ${subject} but no content was generated for it. Re-run the request and ask ZAO to write it directly in chat instead of through a plan.`;
    const actionId = uuidv4();
    await startStepAction(actionId, { stepId: step.id, planId, toolName: resolvedToolName, label: step.description, input: args });
    await completeStepAction(actionId, { status: 'failed', error: errorMessage });
    return { success: false, error: errorMessage, noRetry: true };
  }

  // Same idea as the content guard above, for zip/unzip: these need a
  // SECOND path the model was asked to supply via extraArgs (see
  // EXECUTION_SYSTEM_PROMPT), and translateZipArgs just renamed it onto
  // the field the real tool function destructures. If the model never
  // supplied it, fail honestly now instead of calling the zip/unzip
  // function with an undefined output path.
  const zipSecondPathField = ZIP_ACTIONS_SECOND_PATH_FIELD[resolvedToolName];
  if (zipSecondPathField && typeof args[zipSecondPathField] !== 'string') {
    const errorMessage = `This step was supposed to ${resolvedToolName.includes('extract') ? 'extract' : 'zip'} "${step.target || 'a path'}" but the ${resolvedToolName.includes('extract') ? 'destination folder' : 'output zip path'} was never specified. Re-run the request and ask ZAO to do it directly in chat instead of through a plan.`;
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
export function normalizeActionGuess(step) {
  const domainDefaults = {
    files: 'pc_fs_create_file',
    github: 'github_commit_files',
    terminal: 'terminal_pc_run_command',
    // "time" and "search" each map to exactly one real tool - unlike
    // files/github/terminal (many possible actions, so a wrong guess
    // there needs a real re-plan), a wrong action name in these two
    // domains almost certainly just means the model meant the one tool
    // that domain exists for (e.g. "get_time", "current_time" instead of
    // "time_get_current"), so defaulting here is safe insurance rather
    // than failing a step that would otherwise need a re-plan for no
    // real ambiguity.
    time: 'time_get_current',
    search: 'web_search',
    test: 'pc_run_tests',
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

  // Read once per run, not per step - permission_mode doesn't change
  // mid-execution, and this loop can iterate many times for a
  // multi-step plan. 'auto'/'bypassPermissions' skip the is_risky pause
  // below entirely, same reasoning as backendBrain.js's plan-level gate:
  // someone who chose auto-run doesn't expect ANY step, risky or not,
  // to stop and wait, given ZAO's own file/git checkpoints already make
  // undoing a bad step cheap. Without this, backendBrain.js's plan-level
  // bypass only skipped the FIRST pause (before any step ran) - this
  // loop's own is_risky check is a second, independent gate that ran
  // regardless of mode until now, which is exactly why auto mode still
  // stopped on the very first risky step of a plan.
  const prefsResult = await getPreferences().catch(() => null);
  const permissionMode = prefsResult?.data?.permission_mode || 'default';
  const skipsRiskGate = permissionMode === 'auto' || permissionMode === 'bypassPermissions';

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

    // ---- Risk gate (Phase 1 contract, unchanged for default/acceptEdits/plan modes) ----
    if (step.is_risky && !skipsRiskGate) {
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
    const result = await runStepTool(step, planId, { agentSession, githubToken });

    if (result.success) {
      await updatePlanStep(step.id, planId, { status: STEP_STATUS.DONE, result, completedAt: Date.now() });
      await updateMilestonesAfterStep(plan, step.id);
      onStep?.(step.description);

      // ---- Checkpoint balancing ----
      // Re-read the plan so the step just marked 'done' above is
      // reflected in what evaluateCheckpointPressure() sees - the `plan`
      // object in this closure was fetched before this step ran.
      // Skipped entirely in auto/bypassPermissions, same as the risk
      // gate above - this is a proactive "you may want to check in"
      // pause rather than a risk approval, but it still stops the plan
      // and waits, which is exactly what auto mode is for not doing.
      if (!skipsRiskGate) {
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
      }

      continue;
    }

    // ---- Failure: hand off to recovery planning ----
    const outcome = await handleStepFailure(plan, step, result, { onStep, permissionMode });
    if (outcome === 'abort') {
      await updatePlanStatus(planId, PLAN_STATUS.FAILED, { completedAt: Date.now() });
      return { success: false, status: PLAN_STATUS.FAILED, error: { message: `Aborted: ${step.description} failed and could not be recovered.` } };
    }
    if (outcome === 'ask_person') {
      await updatePlanStep(step.id, planId, { status: STEP_STATUS.AWAITING_APPROVAL, errorMessage: errorText(result.error, 'This step failed and needs your input to continue.') });
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
async function handleStepFailure(plan, step, result, { onStep, permissionMode = 'default' }) {
  const planId = plan.id;
  const isAutoMode = permissionMode === 'auto' || permissionMode === 'bypassPermissions';

  if (result.noRetry) {
    // Genuinely unrecoverable step-level failure (a planning gap, not
    // something a retry/install can fix). Normally this needs a
    // person's eyes - but auto mode has no one to hand it to, so fail
    // forward the same way every other exhausted-recovery path in this
    // module does rather than stalling at an approval screen.
    if (isAutoMode) {
      const hasDependents = (plan.steps || []).some((s) => {
        if (s.id === step.id) return false;
        if (s.depends_on_step_id === step.id) return true;
        if (s.depends_on_step_ids) return s.depends_on_step_ids.split(',').filter(Boolean).includes(step.id);
        return false;
      });
      if (hasDependents) {
        await updatePlanStep(step.id, planId, { status: STEP_STATUS.FAILED, errorMessage: errorText(result.error) });
        onStep?.({ ...step, status: STEP_STATUS.FAILED, error_message: errorText(result.error) });
        return 'abort';
      }
      await updatePlanStep(step.id, planId, { status: STEP_STATUS.SKIPPED, errorMessage: errorText(result.error) });
      onStep?.({ ...step, status: STEP_STATUS.SKIPPED, error_message: errorText(result.error) });
      return 'skipped';
    }
    await updatePlanStep(step.id, planId, { status: STEP_STATUS.AWAITING_APPROVAL, errorMessage: errorText(result.error) });
    onStep?.({ ...step, status: STEP_STATUS.AWAITING_APPROVAL, error_message: errorText(result.error) });
    return 'ask_person';
  }

  const previousAttemptsResult = await getRecoveryAttempts(step.id);
  // Best-effort: a lookup failure shouldn't block recovery entirely, but
  // it MUST NOT silently fall back to an empty array here - that was the
  // original bug (see the header comment this replaces), and it defeats
  // MAX_AUTO_RETRIES: planRecovery() reads previousAttempts.length as the
  // attempt count, so an empty array always looks like "first failure,"
  // no matter how many times this exact step has already failed and
  // recovered-and-retried. Falling back to step.retry_count instead keeps
  // the ceiling real even when the DB read itself fails.
  const previousAttempts = previousAttemptsResult.success
    ? previousAttemptsResult.data
    : Array.from({ length: step.retry_count || 0 });
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
    { previousAttempts, isRisky: !!step.is_risky, permissionMode }
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
        ? `${step.description}\n\n[Recovery attempt ${attemptNumber}: previous attempt failed (${errorText(result.error)}). Try instead: ${alternateDescription}]`
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
      await updatePlanStep(step.id, planId, { status: STEP_STATUS.SKIPPED, errorMessage: errorText(result.error) });
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
      const askReason = decision.reasoning || errorText(result.error);
      await updatePlanStep(step.id, planId, {
        status: STEP_STATUS.AWAITING_APPROVAL,
        errorMessage: askReason,
      });
      await resolveRecoveryAttempt(attemptRecord.id, 'asked_person');
      onStep?.({ ...step, status: STEP_STATUS.AWAITING_APPROVAL, error_message: askReason });
      return 'ask_person';
    }
  }
}

/**
 * ============================================================
 * PERSON-DRIVEN RESUME ACTIONS
 * ============================================================
 * The four functions below are what planStore.js's approveStep/
 * rejectStep/acceptCheckpoint/dismissCheckpoint (in turn called from
 * PlanScreen.js's Approve/Skip/checkpoint buttons - see App.js's
 * usePlanStore() destructuring) actually call. Each one resolves
 * whatever's blocking the plan for exactly the reason the button says,
 * then calls runExecutionPlan() again to pick the loop back up - the
 * SAME resumability runExecutionPlan() already has for a reopened app
 * (it re-reads plan+steps from sqlite rather than trusting anything held
 * in memory), so "resume after a person's decision" and "resume after
 * reopening the app mid-plan" are the same code path, not two.
 */

/**
 * PlanScreen.js's "Approve & run" button on a step paused by
 * is_risky (the risk gate above) or a recovery escalation
 * (RECOVERY_STRATEGIES.ASK_PERSON) - both leave a step at
 * awaiting_approval, which is why one function handles both origins
 * rather than needing to know which one paused it.
 *
 * @param {object} step - the awaiting_approval step object PlanScreen.js
 *   already has in hand (from activePlan.steps)
 * @param {string} planId
 * @param {object} options - forwarded to runExecutionPlan (githubToken,
 *   agentSession, onStep, onAwaitingApproval, onCheckpointSuggested,
 *   shouldContinue)
 */
export async function approveStepAndResume(step, planId, options = {}) {
  await updatePlanStep(step.id, planId, { status: STEP_STATUS.PENDING, errorMessage: null });
  return runExecutionPlan(planId, options);
}

/**
 * PlanScreen.js's "Skip" button on an awaiting_approval step - the
 * person declining a risky action or a recovery escalation, rather than
 * approving it. Marked SKIPPED (not FAILED) since this is a deliberate
 * choice, not an error - mirrors RECOVERY_STRATEGIES.SKIP_AND_CONTINUE's
 * own status choice for the same reason. Steps depending on this one
 * will be marked BLOCKED the next time runExecutionPlan()'s loop
 * computes ready/blocked steps, same as any other unmet dependency.
 */
export async function rejectStepAndResume(step, planId, options = {}) {
  await updatePlanStep(step.id, planId, {
    status: STEP_STATUS.SKIPPED,
    errorMessage: 'Skipped by person (declined at approval).',
  });
  return runExecutionPlan(planId, options);
}

/**
 * PlanScreen.js's "Mark checkpoint & continue" button - the person has
 * actually verified/tested what's accumulated so far. Resets
 * checkpointBalancer.js's pressure clock (moves last_checkpoint_at to
 * now via resolveCheckpointSuggestion's 'accepted' path) and resumes.
 */
export async function acceptCheckpointAndResume(planId, options = {}) {
  await resolveCheckpointSuggestion(planId, 'accepted');
  await updatePlanStatus(planId, PLAN_STATUS.RUNNING);
  return runExecutionPlan(planId, options);
}

/**
 * PlanScreen.js's "Not now" / dismiss button on a checkpoint suggestion
 * - explicitly NOT resetting the pressure clock (resolveCheckpointSuggestion's
 * 'dismissed' path), so the same accumulated pressure carries forward
 * and will likely suggest again soon rather than going quiet for good.
 */
export async function dismissCheckpointAndResume(planId, options = {}) {
  await resolveCheckpointSuggestion(planId, 'dismissed');
  await updatePlanStatus(planId, PLAN_STATUS.RUNNING);
  return runExecutionPlan(planId, options);
}
  