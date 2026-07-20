/**
 * ZAO - Plan Coordinator
 *
 * The single entry point that turns a person's request into a fully
 * persisted plan (or plan tree), by running every planner in this
 * folder in the right order and writing the result to the database via
 * src/db/database.js. Nothing else in the app should call the
 * individual planners directly for a fresh plan - callers (chatStore.js,
 * toolOrchestrator.js, or a future "Plan this" chat action) call
 * buildPlan() here and get back a ready-to-execute, ready-to-display
 * plan id.
 *
 * ============================================================
 * THE FULL PIPELINE (mirrors how Claude works through a non-trivial
 * agentic task end to end, not just how it writes one plan)
 * ============================================================
 *
 *   1. strategicPlanner.planGoal()
 *        -> Goal planning: what does the person want, what does done
 *           mean, is this big enough to decompose further.
 *
 *   2. IF decompose: projectPlanner.planProjects()
 *        -> Project planning: one plan node per major deliverable.
 *
 *   3. FOR EACH project (or the strategic plan itself, if no project
 *      layer): taskPlanner.planTasks()
 *        -> Task planning: concrete units of work + subtasks,
 *           with same-project task dependencies noted.
 *
 *   4. FOR EACH task: executionPlanner.planExecution()
 *        -> Execution planning: literal tool-callable steps, in
 *           dependency-resolved order, each risk-classified.
 *        (dependencyPlanner.js runs INSIDE this step, both for
 *        intra-task step ordering and for threading cross-task
 *        dependencies through as real step ids.)
 *
 *   5. resourcePlanner.planResources() over the full flattened step list
 *        -> Resource planning: what does this plan need that might not
 *           be available (PC backend up? GitHub connected?).
 *
 *   6. milestonePlanner.planMilestones() over the full ordered step list
 *        -> Milestone planning: group steps into checkpoints that read
 *           as real progress, not just a step tally.
 *
 *   7. Persist everything: one plans row per hierarchy node (Strategic
 *      -> Project -> Task -> Execution), plan_steps for every execution
 *      step, plan_milestones, plan_resources.
 *
 * Recovery planning (recoveryPlanner.js) is NOT part of this pipeline -
 * it only runs later, reactively, when planCoordinator's companion
 * executor (the plan-runner loop, wired up in planStore.js's executor
 * hook) hits a failed step. It has nothing to plan before a failure
 * exists to react to.
 *
 * ============================================================
 * COLLAPSING FOR SIMPLE REQUESTS
 * ============================================================
 * A 'small'-scope goal (see planTypes.js's shouldDecompose, applied
 * inside strategicPlanner.js) skips steps 2 and 3 entirely: no Project
 * plans, no Task plans - executionPlanner.js runs ONCE, directly against
 * a synthetic task built from the strategic plan itself. The result is
 * exactly what Phase 1's flat single-plan model already produced: one
 * plans row (level: 'execution'), a list of plan_steps, nothing more.
 * The hierarchy is there when a goal needs it and invisible when it
 * doesn't - the same scaling behavior Claude applies to its own planning
 * depth.
 */

import { v4 as uuidv4 } from 'uuid';
import {
  createPlan,
  insertPlanSteps,
  insertPlanMilestones,
  insertPlanResources,
  getPlanTree,
  getPlanAncestors,
} from '../../db/database';
import { planGoal } from './strategicPlanner';
import { planProjects } from './projectPlanner';
import { planTasks } from './taskPlanner';
import { planExecution } from './executionPlanner';
import { planResources } from './resourcePlanner';
import { planMilestones } from './milestonePlanner';
import { PLAN_LEVELS, PLANNING_TYPES } from './planTypes';

/**
 * @param {string} goalText - the person's raw request
 * @param {object} context - { conversationId, githubToken, githubUsername, onProgress }
 *   onProgress(stage: string) - optional callback fired as the pipeline moves through stages, for a live "Planning... (breaking down tasks)" indicator in the UI while buildPlan runs (this can take several model calls for a large goal).
 * @returns {Promise<{success: boolean, rootPlanId: string|null, executionPlanIds: string[], error: object|null}>}
 */
export async function buildPlan(goalText, context = {}) {
  const { conversationId = null, githubToken = null, onProgress = null } = context;
  const emit = (stage) => onProgress?.(stage);

  try {
    // ---- 1. Goal planning ----
    emit('Understanding the goal…');
    const goalResult = await planGoal(goalText, { conversationId });
    if (!goalResult.success) {
      return { success: false, rootPlanId: null, executionPlanIds: [], error: goalResult.error || { message: 'Goal planning failed.' } };
    }
    const strategicPlan = goalResult.strategicPlan;

    const strategicRow = await createPlan(strategicPlan.id, {
      conversationId,
      goal: strategicPlan.goal,
      level: PLAN_LEVELS.STRATEGIC,
      planType: PLANNING_TYPES.GOAL,
      successCriteria: strategicPlan.successCriteria,
    });
    if (!strategicRow.success) {
      return { success: false, rootPlanId: null, executionPlanIds: [], error: { message: strategicRow.error } };
    }

    const executionPlanIds = [];
    // taskEndStepIds: maps a task's own id -> the last step id in its
    // resolved order, so a sibling task that declares a dependency on it
    // (taskPlanner.js's dependsOnTaskIds) can thread that through to
    // executionPlanner.js as a real cross-task step dependency.
    const taskEndStepIds = new Map();

    // ---- 2 & 3. Project + Task planning (only if the goal warrants it) ----
    let taskGroups; // Array<{ parentPlanId: string, tasks: Array<taskPlan> }>

    if (strategicPlan.decompose) {
      emit('Breaking the goal into projects…');
      const projectsResult = await planProjects(strategicPlan);
      if (!projectsResult.success) {
        return { success: false, rootPlanId: strategicPlan.id, executionPlanIds: [], error: projectsResult.error };
      }

      taskGroups = [];
      for (const project of projectsResult.projectPlans) {
        await createPlan(project.id, {
          conversationId,
          goal: project.title,
          level: PLAN_LEVELS.PROJECT,
          planType: PLANNING_TYPES.PROJECT,
          parentPlanId: strategicPlan.id,
          successCriteria: project.successCriteria,
        });

        emit(`Planning tasks for "${project.title}"…`);
        const tasksResult = await planTasks(project);
        if (!tasksResult.success) {
          return { success: false, rootPlanId: strategicPlan.id, executionPlanIds: [], error: tasksResult.error };
        }
        taskGroups.push({ parentPlanId: project.id, tasks: tasksResult.taskPlans });
      }
    } else {
      // Small-scope goal: no project layer, one synthetic task group
      // sourced directly from the strategic plan so executionPlanner.js
      // still has a uniform "task" shape to consume.
      emit('Planning tasks…');
      const tasksResult = await planTasks({ id: strategicPlan.id, title: strategicPlan.goal, description: strategicPlan.successCriteria });
      if (!tasksResult.success) {
        return { success: false, rootPlanId: strategicPlan.id, executionPlanIds: [], error: tasksResult.error };
      }
      taskGroups = [{ parentPlanId: strategicPlan.id, tasks: tasksResult.taskPlans }];
    }

    // ---- 4. Execution planning (per task, across all groups) ----
    // Tasks are processed in an order that respects cross-task
    // dependencies within the SAME group (topological, via a light local
    // pass) so a dependent task's cross-task step ids are always
    // available by the time it's planned. Tasks in different groups
    // (different projects) are assumed independent unless a future
    // planner links them - out of scope for this pass.
    for (const group of taskGroups) {
      const orderedTasks = orderTasksByDependency(group.tasks);

      for (const task of orderedTasks) {
        await createPlan(task.id, {
          conversationId,
          goal: task.title,
          level: PLAN_LEVELS.TASK,
          planType: PLANNING_TYPES.TASK,
          parentPlanId: group.parentPlanId,
        });

        emit(`Planning execution steps for "${task.title}"…`);
        const crossTaskDeps = (task.dependsOnTaskIds || [])
          .map((depTaskId) => taskEndStepIds.get(depTaskId))
          .filter(Boolean);

        const execResult = await planExecution(task, crossTaskDeps);
        if (!execResult.success) {
          return { success: false, rootPlanId: strategicPlan.id, executionPlanIds, error: execResult.error };
        }

        if (execResult.steps.length === 0) continue;

        // Each task gets its own leaf Execution-level plans row so
        // PlanScreen.js can show/collapse per-task progress, and so a
        // task's steps have a stable plan_id to insert against.
        const executionPlanId = uuidv4();
        await createPlan(executionPlanId, {
          conversationId,
          goal: task.title,
          level: PLAN_LEVELS.EXECUTION,
          planType: PLANNING_TYPES.EXECUTION,
          parentPlanId: task.id,
        });
        executionPlanIds.push(executionPlanId);

        // ---- 5. Resource planning (per execution plan's step set) ----
        emit('Checking what this needs…');
        const resourceResult = await planResources(execResult.steps, { githubToken });
        if (resourceResult.resources.length) {
          await insertPlanResources(executionPlanId, resourceResult.resources);
        }

        // ---- 6. Milestone planning (per execution plan's step set) ----
        emit('Marking checkpoints…');
        const milestoneResult = await planMilestones(execResult.steps.map((s) => ({ id: s.id, description: s.description })));
        if (milestoneResult.milestones.length) {
          await insertPlanMilestones(executionPlanId, milestoneResult.milestones);
        }

        const stepsToInsert = execResult.steps.map((step, index) => ({
          id: step.id,
          stepOrder: index,
          domain: step.domain,
          description: step.description,
          reasoning: step.reasoning,
          action: step.action,
          target: step.target,
          details: (step.subtaskTitle || step.content)
            ? { subtask: step.subtaskTitle || null, content: step.content || null }
            : null,
          dependsOnStepId: step.dependsOnStepId,
          dependsOnStepIds: step.dependsOnStepIds,
          milestoneId: milestoneResult.stepMilestoneMap.get(step.id) || null,
          isRisky: step.isRisky,
          riskReason: step.riskReason,
        }));

        await insertPlanSteps(executionPlanId, stepsToInsert);

        if (execResult.steps.length > 0) {
          taskEndStepIds.set(task.id, execResult.steps[execResult.steps.length - 1].id);
        }
      }
    }

    emit('Plan ready.');
    return { success: true, rootPlanId: strategicPlan.id, executionPlanIds, error: null };
  } catch (err) {
    console.error('[planCoordinator] buildPlan failed:', err);
    return { success: false, rootPlanId: null, executionPlanIds: [], error: { type: 'UNEXPECTED_ERROR', message: err?.message || 'Planning failed unexpectedly.' } };
  }
}

/** Cheap local topological pass for ordering a single task group by dependsOnTaskIds before execution planning - reuses the same idea as dependencyPlanner.js but kept inline here since it's a small, task-id-only sort with no need for the fuller step-graph machinery. Falls back to original order on a cycle rather than failing the whole build over a task-level ordering conflict (execution-level dependency resolution is the one that actually matters for correctness). */
function orderTasksByDependency(tasks) {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const visited = new Set();
  const visiting = new Set();
  const ordered = [];
  let hasCycle = false;

  function visit(task) {
    if (visited.has(task.id)) return;
    if (visiting.has(task.id)) { hasCycle = true; return; }
    visiting.add(task.id);
    for (const depId of task.dependsOnTaskIds || []) {
      const depTask = byId.get(depId);
      if (depTask) visit(depTask);
    }
    visiting.delete(task.id);
    visited.add(task.id);
    ordered.push(task);
  }

  for (const task of tasks) visit(task);
  return hasCycle ? tasks : ordered;
}

/**
 * Convenience read: loads the full plan tree for display, given any node
 * id in it (walks up to the root first). Thin wrapper so callers don't
 * need to import both database.js and planTypes.js just to get a
 * ready-to-render tree.
 */
export async function loadPlanForDisplay(anyPlanIdInTree) {
  const ancestorsResult = await getPlanAncestors(anyPlanIdInTree);
  const rootId = ancestorsResult.success && ancestorsResult.data.length
    ? ancestorsResult.data[ancestorsResult.data.length - 1].id
    : anyPlanIdInTree;

  return getPlanTree(rootId);
}
