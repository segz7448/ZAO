/**
 * ZAO - Planning Types & Hierarchy (shared constants)
 *
 * This is the vocabulary every other file in src/services/planning/
 * speaks. Nothing here executes anything - it's the map that everything
 * else is drawn on.
 *
 * ============================================================
 * WHY THIS SHAPE: how Claude (the model ZAO's planning loop is modeled
 * after) actually plans
 * ============================================================
 * A capable agentic model doesn't jump straight from "the person's
 * request" to "a list of tool calls." It moves through a small number of
 * distinct planning concerns, mostly in this order, and it revisits
 * earlier ones when new information invalidates them:
 *
 *   1. What does "done" actually mean here?            -> Goal planning
 *   2. What are the major pieces of work?               -> Project planning
 *   3. What are the concrete units of work in each piece? -> Task planning
 *   4. What has to happen before what?                   -> Dependency planning
 *   5. What do I need that I might not have?             -> Resource planning
 *   6. What do I do if a step fails?                     -> Recovery planning
 *   7. In what order, with what tool calls, right now?   -> Execution planning
 *   8. How do I know I'm making real progress?           -> Milestone planning
 *
 * These 8 TYPES are concerns, not always separate objects - a trivial
 * one-step request still implicitly answers all 8 ("done" = the one
 * step succeeds, one project, one task, no dependencies, no extra
 * resources, retry-on-failure, run it, the only milestone is
 * completion) without ZAO ever materializing 8 rows for it. They become
 * real, separate plan rows once a goal is big enough that collapsing
 * them would lose information the person or the executor needs later.
 *
 * The 4-level HIERARCHY is how those concerns get organized into
 * actual persisted plan nodes (see src/db/database.js's `plans` table,
 * `level` column) once a goal is complex enough to need more than one:
 *
 *   Strategic  - the overall goal and what success looks like.
 *                One per top-level request. plan_type: 'goal'.
 *   Project    - a major deliverable/phase within the goal.
 *                Zero or more per Strategic plan. plan_type: 'project'.
 *   Task       - a concrete unit of work within a project.
 *                One or more per Project plan. plan_type: 'task'.
 *   Execution  - the actual ordered, tool-callable steps.
 *                Exactly one per Task plan (or the whole thing, for a
 *                simple request with no Project/Task layers at all).
 *                plan_type: 'execution'.
 *
 * 'dependency', 'resource', 'recovery', and 'milestone' plan_types don't
 * get their own hierarchy LEVEL - they're metadata that decorates
 * whichever level produced them (see planStore.js's
 * attachDependencyPlan/attachResourcePlan/etc.), because "what depends
 * on what" or "what do we need" isn't itself a rung in the ladder, it's
 * a property of the plan at whatever rung it was computed for.
 *
 * A simple request ("rename this file") never grows past a single
 * Execution-level plan with plan_type 'execution' - this whole hierarchy
 * is opt-in complexity, triggered by strategicPlanner.js's own
 * assessment of the goal's size (see shouldDecompose() below), not a
 * mandatory ceremony for every request.
 */

/** The 8 planning concerns. Used as `plan_type` on a `plans` row, and as the vocabulary planCoordinator.js's log/telemetry uses to describe what phase of planning is happening. */
export const PLANNING_TYPES = Object.freeze({
  GOAL: 'goal',               // 1. Goal planning - what "done" means, success criteria
  PROJECT: 'project',         // 2. Project planning - major phases/deliverables
  TASK: 'task',               // 3. Task planning - concrete units of work, with subtasks
  DEPENDENCY: 'dependency',   // 4. Dependency planning - ordering constraints, blockers
  RESOURCE: 'resource',       // 5. Resource planning - credentials, connections, tools needed
  RECOVERY: 'recovery',       // 6. Recovery planning - what to do when a step fails
  EXECUTION: 'execution',     // 7. Execution planning - the literal ordered tool-call steps
  MILESTONE: 'milestone',     // 8. Milestone planning - checkpoints that mark real progress
});

/** The 4-level plan hierarchy. Used as `level` on a `plans` row. Ordered top to bottom - index in this array = depth. */
export const PLAN_LEVELS = Object.freeze({
  STRATEGIC: 'strategic',
  PROJECT: 'project',
  TASK: 'task',
  EXECUTION: 'execution',
});

/** Ordered top->bottom, for anything that needs to walk or render the hierarchy depth-first. */
export const PLAN_LEVEL_ORDER = Object.freeze([
  PLAN_LEVELS.STRATEGIC,
  PLAN_LEVELS.PROJECT,
  PLAN_LEVELS.TASK,
  PLAN_LEVELS.EXECUTION,
]);

/** Which plan_type is expected to produce a plan row at which level - used by planStore.js to validate a planner isn't creating a mismatched node (e.g. a 'task' plan_type at the 'project' level). */
export const LEVEL_FOR_TYPE = Object.freeze({
  [PLANNING_TYPES.GOAL]: PLAN_LEVELS.STRATEGIC,
  [PLANNING_TYPES.PROJECT]: PLAN_LEVELS.PROJECT,
  [PLANNING_TYPES.TASK]: PLAN_LEVELS.TASK,
  [PLANNING_TYPES.EXECUTION]: PLAN_LEVELS.EXECUTION,
});

/** Every state a plan node can be in. Mirrors the CHECK constraint on plans.status in database.js - kept here too so JS code importing this file doesn't need to duplicate the raw string list. */
export const PLAN_STATUS = Object.freeze({
  PLANNING: 'planning',
  RUNNING: 'running',
  AWAITING_APPROVAL: 'awaiting_approval',
  PAUSED: 'paused',
  RECOVERING: 'recovering',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

export const TERMINAL_PLAN_STATUSES = Object.freeze([
  PLAN_STATUS.COMPLETED,
  PLAN_STATUS.FAILED,
  PLAN_STATUS.CANCELLED,
]);

/** Every state a single step can be in. Mirrors plan_steps.status's CHECK constraint. 'blocked' is new in Phase 2 - a step whose dependency failed/was skipped, so it can never run, distinct from 'pending' (still eligible once its turn comes). */
export const STEP_STATUS = Object.freeze({
  PENDING: 'pending',
  RUNNING: 'running',
  AWAITING_APPROVAL: 'awaiting_approval',
  DONE: 'done',
  FAILED: 'failed',
  SKIPPED: 'skipped',
  BLOCKED: 'blocked',
});

/** Recovery strategies recoveryPlanner.js can choose between - ordered roughly least-to-most drastic, which recoveryPlanner.js's escalation logic relies on. */
export const RECOVERY_STRATEGIES = Object.freeze({
  RETRY: 'retry',
  RETRY_WITH_BACKOFF: 'retry_with_backoff',
  ALTERNATE_APPROACH: 'alternate_approach',
  SKIP_AND_CONTINUE: 'skip_and_continue',
  ASK_PERSON: 'ask_person',
  ABORT_PLAN: 'abort_plan',
});

export const RESOURCE_TYPES = Object.freeze({
  CREDENTIAL: 'credential',
  CONNECTION: 'connection',
  TOOL: 'tool',
  PERMISSION: 'permission',
  DISK_SPACE: 'disk_space',
  OTHER: 'other',
});

export const MILESTONE_STATUS = Object.freeze({
  PENDING: 'pending',
  IN_PROGRESS: 'in_progress',
  REACHED: 'reached',
  MISSED: 'missed',
});

/**
 * Heuristic gate for "does this goal actually need the Strategic -> Project
 * -> Task -> Execution ladder, or is it small enough to go straight to a
 * single Execution plan?" Mirrors how Claude itself scales planning depth
 * to task size rather than always maximally decomposing - a one-line fix
 * doesn't get a project plan, a "rebuild my app's backend" request does.
 *
 * This is intentionally cheap and local (no model call) since it just
 * decides which planner to invoke next, not what the plan contains -
 * strategicPlanner.js still asks the model for the real judgment call on
 * genuinely ambiguous requests via its own escalation path.
 *
 * @param {string} goalText
 * @returns {{ decompose: boolean, reason: string }}
 */
export function shouldDecompose(goalText) {
  const text = (goalText || '').toLowerCase();

  // Strong multi-project signals: the person named several distinct
  // deliverables, or used words that imply a build spanning many parts.
  const multiPartSignals = [
    /\band\b.*\band\b/, // "X and Y and Z" - 2+ conjunctions suggests several deliverables
    /\bthen\b.*\bthen\b/,
    /\bapp\b.*\b(backend|api|database|server)\b/,
    /\bfull(-|\s)stack\b/,
    /\brebuild\b/,
    /\bfrom scratch\b/,
    /\bmulti(-|\s)(phase|step|part|stage)\b/,
    /\bmigrat(e|ion)\b/,
    /\bend(-|\s)to(-|\s)end\b/,
  ];

  const wordCount = text.split(/\s+/).filter(Boolean).length;

  const matched = multiPartSignals.some((pattern) => pattern.test(text));
  if (matched) {
    return { decompose: true, reason: 'Goal language suggests multiple deliverables or phases.' };
  }
  if (wordCount > 40) {
    return { decompose: true, reason: 'Goal description is long enough to likely bundle several sub-goals.' };
  }
  return { decompose: false, reason: 'Goal reads as a single, concrete unit of work.' };
}
