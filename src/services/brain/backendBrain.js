/**
 * ZAO - Backend Brain (the "cortex")
 *
 * Runs on the PC (server/, src/services/backend/backendClient.js) - this
 * is where every actual model call happens. There is exactly one model
 * underneath (Qwen2.5-Coder-3B, DENSE_TRANSFORMER - see brainTypes.js),
 * but this app puts it to work as a MULTI_BRAIN_ENSEMBLE: several
 * distinct ROLES, each its own system prompt/temperature/job, all
 * hitting that same model. This file is the single place that names
 * those roles (BRAIN_ROLES below) - most of them already exist as
 * separate modules (src/services/intentClassifier.js,
 * src/services/planning/*Planner.js), this just gives the pattern a
 * name and a home so it's documented rather than implicit, and adds the
 * one role that didn't exist anywhere yet: the entry point that
 * actually RUNS the HYBRID_SYMBOLIC_NEURAL planning pipeline
 * (src/services/planning/) end to end for a chat message, which is the
 * "not wired up yet" gap this module closes.
 *
 * frontendBrain.js decides WHETHER a message needs this; this module
 * decides HOW the backend actually carries it out once that decision
 * is made.
 */

import {
  buildPlan as coordinatorBuildPlan,
} from '../planning/planCoordinator';
import { runExecutionPlan } from '../planning/planExecutor';
import { getPlan, updatePlanStatus, getPreferences } from '../../db/database';
import { PLAN_STATUS, STEP_STATUS } from '../planning/planTypes';
import { withProceduralHint } from '../memory/proceduralMemory';

/**
 * The ensemble's roster. Each entry is a conceptual role, not a
 * separate model - `implementedIn` points at the module that actually
 * carries the role out (its own system prompt lives there, not
 * duplicated here, so there's exactly one place each prompt can drift
 * out of date). Kept as data (not a running registry other code
 * dispatches through) because each role's calling contract is
 * different enough (classifier wants one JSON object back, planner
 * wants a step array, executor wants a tool call) that a single
 * generic "call this role" function would just be a thin, leaky
 * wrapper around what's already there - this exists so the roles are
 * enumerable and explainable in one place, not to replace their call
 * sites.
 */
export const BRAIN_ROLES = Object.freeze({
  ROUTER: {
    key: 'router',
    label: 'Router',
    job: 'Decides which execution mode a message needs (chat / hierarchical plan / live browsing) by actually reading the request, not keyword-matching it.',
    implementedIn: 'src/services/intentClassifier.js (classifyIntent)',
  },
  STRATEGIC_PLANNER: {
    key: 'strategic_planner',
    label: 'Strategic planner',
    job: 'Goal planning - what "done" means, whether the goal is big enough to decompose further.',
    implementedIn: 'src/services/planning/strategicPlanner.js (planGoal)',
  },
  PROJECT_PLANNER: {
    key: 'project_planner',
    label: 'Project planner',
    job: 'Breaks a large goal into major deliverables/phases.',
    implementedIn: 'src/services/planning/projectPlanner.js (planProjects)',
  },
  TASK_PLANNER: {
    key: 'task_planner',
    label: 'Task planner',
    job: 'Breaks a project (or a small goal directly) into concrete units of work.',
    implementedIn: 'src/services/planning/taskPlanner.js (planTasks)',
  },
  EXECUTION_PLANNER: {
    key: 'execution_planner',
    label: 'Execution planner',
    job: 'Turns one task into the literal, ordered, tool-callable steps.',
    implementedIn: 'src/services/planning/executionPlanner.js (planExecution)',
  },
  RECOVERY_PLANNER: {
    key: 'recovery_planner',
    label: 'Recovery planner',
    job: 'Decides how to react when a step fails - retry, alternate approach, skip, ask the person, or abort.',
    implementedIn: 'src/services/planning/recoveryPlanner.js (planRecovery)',
  },
  TOOL_EXECUTOR: {
    key: 'tool_executor',
    label: 'Tool executor',
    job: 'Flat ReAct-style loop: decides which registered tool functions to call, in what order. Not reachable as a top-level chat route anymore (frontendBrain.js sends every tool-flavored request through HIERARCHICAL_PLAN below instead, size notwithstanding) - today this only runs as the isolated worker each subagent uses (src/services/execution/subagentManager.js), spawned from inside a hierarchical plan step via agent_spawn_subagents, never directly from a chat message.',
    implementedIn: 'src/services/toolOrchestrator.js (runToolTask)',
  },
  REASONER: {
    key: 'reasoner',
    label: 'Reasoner',
    job: 'Picks and runs a reasoning strategy for a plain-chat message - chain-of-thought by default, or tree-of-thought/deductive/inductive/abductive/analogical when reasoningRouter.js classifies one of those, plus an optional self-reflection critique+revise pass. See src/services/reasoning/reasoningTypes.js for the full taxonomy this implements.',
    implementedIn: 'src/services/reasoning/reasoningEngine.js (runReasoningChat)',
  },
  CONVERSATIONALIST: {
    key: 'conversationalist',
    label: 'Conversationalist',
    job: 'The actual completion call(s) a reasoning strategy makes - one or more per turn depending on the strategy (see the Reasoner role above). No tools, no plan.',
    implementedIn: 'src/services/reasoning/*.js (each strategy module) via src/services/backend/backendClient.js',
  },
});

/**
 * Runs the planning half of the HYBRID_SYMBOLIC_NEURAL pipeline for a
 * goal that frontendBrain.js has decided needs real action: builds the
 * Strategic -> Project -> Task -> Execution tree (planCoordinator.js,
 * itself several BRAIN_ROLES in sequence) - and stops there.
 *
 * ============================================================
 * PLAN MODE: explore/propose here, execute only after approval
 * ============================================================
 * This mirrors Claude Code's Plan Mode rather than its own former
 * behavior: build the plan, mark every resulting Execution-level leaf
 * as `awaiting_approval`, and hand back a plain-language proposal - NO
 * tool call, file write, commit, or command runs yet. Nothing mutates
 * anything until the person reviews the plan (PlanScreen.js, opened via
 * the chat reply's planId) and explicitly starts it
 * (planStore.js's startPlan(), which calls runApprovedPlan() below).
 *
 * Because frontendBrain.js now routes every tool-flavored request
 * through this function - not just ones big enough to trigger
 * shouldDecompose() - this gate is "baked into every task": a one-line
 * fix collapses to a single Execution-level plan with one or two steps
 * (see planCoordinator.js's COLLAPSING FOR SIMPLE REQUESTS) but still
 * stops for a plan-level approval before it touches anything, exactly
 * as often as a "rebuild the whole backend" goal does - the depth of
 * the plan scales with the goal, the approval gate does not.
 *
 * @param {string} goalText - the person's raw request
 * @param {object} context - { conversationId, githubToken, onProgress(stage) }
 * @returns {Promise<{
 *   success: boolean,
 *   content: string,
 *   rootPlanId: string|null,
 *   planId: string|null,
 *   status: string|null,
 *   error: object|null,
 * }>}
 */
export async function runHierarchicalPlan(goalText, context = {}) {
  const { conversationId = null, githubToken = null, onProgress = null } = context;

  // Procedural memory (src/services/memory/proceduralMemory.js): if a
  // similar goal has succeeded before, fold a short "here's what worked
  // last time" hint straight into the prompt the planners see - this is
  // the one place procedural memory plugs in, rather than threading a
  // new parameter through every planner in planCoordinator.js.
  const augmentedGoalText = await withProceduralHint(goalText);

  const buildResult = await coordinatorBuildPlan(augmentedGoalText, { conversationId, githubToken, onProgress });
  if (!buildResult.success) {
    return {
      success: false,
      content: '',
      rootPlanId: buildResult.rootPlanId,
      planId: null,
      status: null,
      error: buildResult.error || { message: 'Could not build a plan for this.' },
    };
  }

  const { rootPlanId, executionPlanIds } = buildResult;

  if (executionPlanIds.length === 0) {
    // The goal planned down to zero concrete steps (e.g. it was already
    // answerable, or the planner judged nothing actionable was needed) -
    // surface the strategic plan itself rather than claiming a run that
    // never happened. Nothing to approve, so this is terminal.
    const rootPlan = await getPlan(rootPlanId);
    return {
      success: true,
      content: rootPlan.success && rootPlan.data
        ? `I looked this over: "${rootPlan.data.goal}". It didn't break down into any concrete steps to run - let me know if you'd like me to try a specific action instead.`
        : "I looked this over but didn't find any concrete steps to run.",
      rootPlanId,
      planId: rootPlanId,
      status: PLAN_STATUS.COMPLETED,
      error: null,
    };
  }

  // Whether this plan-level gate even applies: 'auto'/'bypassPermissions'
  // mean every WRITE_TOOL and risky terminal command already auto-runs at
  // the per-step level (permissionModes.js), so pausing the WHOLE PLAN
  // here first - before a single step is even attempted - directly
  // contradicts that setting. Someone who turned auto-run on doesn't
  // expect a "create a folder" goal to sit at awaiting_approval; they
  // expect it to just happen. 'plan' mode still gets no bypass here (it's
  // read-only by definition, so proposing without running is exactly
  // right), and 'default'/'acceptEdits' keep the existing propose-first
  // behavior since those modes still expect a look-before-you-run gate
  // for anything above their own auto-run tier.
  const prefsResult = await getPreferences().catch(() => null);
  const permissionMode = prefsResult?.data?.permission_mode || 'default';
  const skipsPlanGate = permissionMode === 'auto' || permissionMode === 'bypassPermissions';

  if (skipsPlanGate) {
    return runApprovedPlan(rootPlanId, executionPlanIds, {
      githubToken,
      onStep: context.onStep,
      onAwaitingApproval: context.onAwaitingApproval,
      shouldContinue: context.shouldContinue,
    }).then((result) => ({
      success: result.success,
      content: result.content,
      rootPlanId,
      planId: executionPlanIds.length === 1 ? executionPlanIds[0] : rootPlanId,
      status: result.status,
      error: result.error,
      clockData: result.clockData,
    }));
  }

  // Mark every leaf as awaiting the person's go-ahead. Deliberately NOT
  // 'planning' (which reads as "still working") or left at whatever
  // planCoordinator.js's createPlan() defaulted to - awaiting_approval
  // is a real, already-understood state (PlanScreen.js's amber "Needs
  // your approval" badge) and, since no step has run yet, is
  // unambiguous from the step-level awaiting_approval a risky step
  // produces mid-run (see PlanScreen.js's new "review before starting"
  // bar, which checks for exactly this: plan-level awaiting_approval
  // with every step still pending).
  for (const executionPlanId of executionPlanIds) {
    await updatePlanStatus(executionPlanId, PLAN_STATUS.AWAITING_APPROVAL);
  }

  const rootPlan = await getPlan(rootPlanId);
  const goal = rootPlan.success && rootPlan.data ? rootPlan.data.goal : goalText;
  const content = await describePlanForApproval(goal, executionPlanIds);

  // A single Execution-level plan (the common case now that every task
  // goes through this gate, not just decomposed goals) has its steps
  // directly on it - point the chat reply's planId straight at it so
  // "View Plan" opens something with a real checklist to approve,
  // rather than the Strategic root (which never carries its own steps -
  // see planCoordinator.js). A multi-part goal still points at the
  // root; PlanScreen.js's flat view is a known gap for that case,
  // unchanged from before this pass.
  const displayPlanId = executionPlanIds.length === 1 ? executionPlanIds[0] : rootPlanId;

  return {
    success: true,
    content,
    rootPlanId,
    planId: displayPlanId,
    status: PLAN_STATUS.AWAITING_APPROVAL,
    error: null,
  };
}

/**
 * Builds the plain-language plan proposal shown in chat and atop
 * PlanScreen.js's "review before starting" bar - the Plan Mode
 * equivalent of Claude Code presenting its plan text for approval
 * before touching anything. Pulls each execution leaf's step
 * descriptions (already model-written by executionPlanner.js) rather
 * than re-summarizing them with another model call - the plan itself is
 * the fastest, most accurate description of what it will do.
 */
async function describePlanForApproval(goal, executionPlanIds) {
  const leafPlans = await Promise.all(executionPlanIds.map((id) => getPlan(id)));
  const allSteps = leafPlans
    .filter((p) => p.success && p.data)
    .flatMap((p) => p.data.steps || []);

  if (allSteps.length === 0) {
    return `I've reviewed "${goal}" but it didn't produce any concrete steps - let me know if you'd like me to try a specific action instead.`;
  }

  const riskyCount = allSteps.filter((s) => s.is_risky).length;
  const bullets = allSteps
    .slice(0, 12)
    .map((s) => `${s.is_risky ? '⚠️ ' : '• '}${s.description}`)
    .join('\n');
  const overflow = allSteps.length > 12 ? `\n…and ${allSteps.length - 12} more step${allSteps.length - 12 === 1 ? '' : 's'}.` : '';
  const riskyNote = riskyCount > 0
    ? `\n\n${riskyCount} of these ${riskyCount === 1 ? 'is' : 'are'} flagged as higher-risk and will ask for a separate okay when I get to ${riskyCount === 1 ? 'it' : 'them'}.`
    : '';

  return `Here's my plan for "${goal}" - nothing has run yet:\n\n${bullets}${overflow}${riskyNote}\n\nOpen the plan to start it, or tell me to change something first.`;
}

/**
 * Runs every Execution-level leaf plan under a goal, in the order
 * planCoordinator.js already sequenced them (cross-task/cross-project
 * dependencies threaded through as real step ids). This is the second
 * half of the old runHierarchicalPlan() - now only reached once the
 * person has actually approved the plan runHierarchicalPlan() proposed
 * (planStore.js's startPlan() calls this after PlanScreen.js's "Start
 * plan" button).
 *
 * @param {string} rootPlanId
 * @param {string[]} executionPlanIds - ordered
 * @param {object} context - { githubToken, onStep(label), onAwaitingApproval(step) }
 * @returns {Promise<{ success: boolean, content: string, status: string|null, error: object|null, clockData: {timezone: string|null, label: string}|null }>}
 */
export async function runApprovedPlan(rootPlanId, executionPlanIds, context = {}) {
  const { githubToken = null, onStep = null, onAwaitingApproval = null, shouldContinue = () => true } = context;

  let lastResult = null;
  for (const executionPlanId of executionPlanIds) {
    lastResult = await runExecutionPlan(executionPlanId, { githubToken, onStep, onAwaitingApproval, shouldContinue });
    if (!lastResult.success || lastResult.status !== PLAN_STATUS.COMPLETED) {
      break;
    }
  }

  const rootPlan = await getPlan(rootPlanId);
  const goal = rootPlan.success && rootPlan.data ? rootPlan.data.goal : '';
  const content = summarizePlanOutcome(goal, lastResult, executionPlanIds.length);

  // CLOCK WIDGET: toolOrchestrator.js's flat runToolTask() loop captures
  // clockData the moment a time_get_current call succeeds, so chatStore.js
  // can render a live ClockWidget on the reply bubble (see its own
  // buildAssistantMessageFromResult). Every tool-flavored request now
  // goes through THIS plan pipeline instead (frontendBrain.js routes
  // 'github' intent to HIERARCHICAL_PLAN unconditionally - see its own
  // comment), which has no in-loop equivalent: runStepTool() calls
  // TOOL_REGISTRY directly, one step at a time, with no shared loop
  // state to stash a "last clock reading" in. Recovering it here instead
  // by re-reading the finished plan's own steps (already persisted to
  // plan_steps.result_json by updatePlanStep) is the least invasive
  // fix - it doesn't touch the executor's per-step loop at all, just
  // looks at what it already wrote down. Only meaningful on a genuinely
  // completed run; an in-progress/awaiting-approval/failed plan hasn't
  // necessarily reached its time_get_current step yet, so don't guess.
  const clockData = lastResult?.status === PLAN_STATUS.COMPLETED
    ? await findLastClockReading(executionPlanIds)
    : null;

  return {
    success: !!lastResult?.success,
    content,
    status: lastResult?.status || null,
    error: lastResult?.success ? null : (lastResult?.error || { message: 'The plan could not finish.' }),
    clockData,
  };
}

/**
 * Scans a just-completed run's execution-leaf plans for the LAST
 * successful time_get_current step (later step_order wins, matching
 * runToolTask()'s own "only the first refusal is captured but a later
 * successful call overwrites clockData" behavior - see its comment) and
 * returns the same {timezone, label} shape ChatScreen.js's ClockWidget
 * expects. Returns null if the run never called it - the normal case,
 * and not an error.
 */
async function findLastClockReading(executionPlanIds) {
  try {
    const plans = await Promise.all(executionPlanIds.map((id) => getPlan(id)));
    let reading = null;
    for (const p of plans) {
      if (!p.success || !p.data) continue;
      const steps = (p.data.steps || [])
        .filter((s) => s.action === 'time_get_current' && s.status === STEP_STATUS.DONE && s.result_json)
        .sort((a, b) => (a.step_order || 0) - (b.step_order || 0));
      for (const step of steps) {
        try {
          const parsed = JSON.parse(step.result_json);
          if (parsed?.success && parsed.data) {
            reading = { timezone: parsed.data.timezone ?? null, label: parsed.data.resolvedLabel ?? null };
          }
        } catch (err) {
          // Malformed result_json for this one step - skip it, keep
          // whatever reading (if any) was already found.
        }
      }
    }
    return reading;
  } catch (err) {
    // Best-effort only - a failure here should never break the plan's
    // own success/content result, just mean no clock widget this time.
    return null;
  }
}

/** Builds the chat-visible summary line for a hierarchical-plan run's outcome, keyed off the last execution plan's terminal/paused status. */
function summarizePlanOutcome(goal, lastResult, planCount) {
  const multiPart = planCount > 1 ? ` across ${planCount} parts` : '';
  switch (lastResult?.status) {
    case PLAN_STATUS.COMPLETED:
      return `Done - I broke "${goal}" down${multiPart} and ran it through to completion. Open the plan to see everything that happened.`;
    case PLAN_STATUS.AWAITING_APPROVAL:
      return `I've broken "${goal}" down into a plan${multiPart} and started running it - one step needs your approval before I continue. Open the plan to review it.`;
    case PLAN_STATUS.PAUSED:
      return `I've broken "${goal}" down into a plan${multiPart} and made real progress - I'd suggest checking in before I continue. Open the plan to see where things stand.`;
    case PLAN_STATUS.FAILED:
      return `I broke "${goal}" down into a plan${multiPart}, but hit a step I couldn't recover from. Open the plan to see what happened and what finished before that.`;
    default:
      return `I've broken "${goal}" down into a plan${multiPart}. Open the plan to see the steps and progress.`;
  }
}
