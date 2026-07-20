/**
 * ZAO - Plan Store (Zustand)
 *
 * Holds the active plan's live state, backed by the plans/plan_steps
 * (+ plan_milestones/plan_resources/plan_recovery_attempts) tables (see
 * src/db/database.js's Plans section). Same pattern as chatStore.js:
 * store actions call the safe database.js wrappers and check `.success`
 * rather than throwing, so the UI (PlanScreen.js) can always render
 * something even if a DB call fails.
 *
 * Phase 2: this now fronts the full hierarchical planning system in
 * src/services/planning/ - planCoordinator.js (builds a Strategic ->
 * Project -> Task -> Execution tree via all 8 planning types) and
 * planExecutor.js (runs an Execution-level leaf plan's steps, with
 * dependency scheduling, resource/risk gating, and recovery). Phase 1's
 * createPlanFromSteps() is kept EXACTLY as it was for any caller that
 * just wants a flat single-level plan without going through the full
 * hierarchy - it still works standalone, it's just no longer the only
 * way to create a plan.
 */

import { create } from 'zustand';
import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';
import {
  createPlan,
  insertPlanSteps,
  getPlan,
  getPlanTree,
  getPlans,
  getActivePlans,
  updatePlanStatus,
  updatePlanStep,
  deletePlan as dbDeletePlan,
} from '../db/database';
import { classifyStep } from '../services/planning/riskClassifier';
import { PLAN_STATUS } from '../services/planning/planTypes';
import { buildPlan as coordinatorBuildPlan, loadPlanForDisplay } from '../services/planning/planCoordinator';
import {
  runExecutionPlan,
  approveStepAndResume as executorApproveStep,
  rejectStepAndResume as executorRejectStep,
  acceptCheckpointAndResume as executorAcceptCheckpoint,
  dismissCheckpointAndResume as executorDismissCheckpoint,
} from '../services/planning/planExecutor';
import { runApprovedPlan } from '../services/brain/backendBrain';

export const usePlanStore = create((set, get) => ({
  // The plan currently shown/active in PlanScreen.js - null when nothing's
  // running. Shape: { id, conversation_id, goal, status, created_at,
  // updated_at, completed_at, steps: [...] }
  activePlan: null,
  // Plans list for history view (most recent first) - loaded on demand,
  // not kept in sync automatically; call loadPlans() after actions that
  // change it if the history view is open.
  plans: [],
  // Any plan left in a non-terminal state from a previous app session -
  // checked once on launch (see loadActivePlansOnLaunch) so the person can
  // be shown "you had a plan in progress" rather than it silently vanishing.
  resumablePlans: [],
  isLoading: false,
  error: null,
  // Non-terminal, cosmetic-only progress string surfaced while
  // buildPlanFromGoal() is mid-flight (it can take several sequential
  // model calls for a large goal) - e.g. "Breaking the goal into
  // projects...". Cleared once the build finishes either way.
  planningStage: null,
  // The full nested tree ({ ...strategicPlan, children: [...] }) for the
  // currently active hierarchical plan, loaded on demand via
  // loadPlanTree() - kept separate from activePlan (which stays a single
  // flat plan node, same shape Phase 1 always used) so existing
  // consumers of activePlan/PlanScreen.js's flat checklist view keep
  // working unchanged; a tree-aware view reads activePlanTree instead.
  activePlanTree: null,

  /**
   * Full Phase 2 entry point: runs the entire planning pipeline
   * (Strategic -> Project -> Task -> Execution, plus dependency,
   * resource, and milestone planning) for a raw goal via
   * planCoordinator.js, and persists the whole resulting tree. Use this
   * instead of createPlanFromSteps() whenever the caller wants ZAO to
   * actually figure out HOW to break the goal down, rather than handing
   * in an already-decided step list.
   *
   * @param {string} goalText
   * @param {object} context - { conversationId, githubToken }
   * @returns {Promise<{success: boolean, rootPlanId: string|null, executionPlanIds: string[], error: object|null}>}
   */
  async buildPlanFromGoal(goalText, context = {}) {
    set({ isLoading: true, error: null, planningStage: 'Starting…' });

    const result = await coordinatorBuildPlan(goalText, {
      ...context,
      onProgress: (stage) => set({ planningStage: stage }),
    });

    if (!result.success) {
      set({ isLoading: false, error: result.error, planningStage: null });
      return result;
    }

    // Show the root (strategic) plan as activePlan for any flat-view
    // consumer, and the full tree for anything hierarchy-aware.
    const rootPlan = await getPlan(result.rootPlanId);
    const tree = await getPlanTree(result.rootPlanId);
    set({
      activePlan: rootPlan.success ? rootPlan.data : null,
      activePlanTree: tree.success ? tree.data : null,
      isLoading: false,
      planningStage: null,
    });

    return result;
  },

  /** Loads the full nested plan tree for any plan id in it (walks to the root automatically) - for a hierarchy-aware view rather than a single flat plan's checklist. */
  async loadPlanTree(anyPlanIdInTree) {
    set({ isLoading: true, error: null });
    const result = await loadPlanForDisplay(anyPlanIdInTree);
    if (!result.success) {
      set({ isLoading: false, error: result.error });
      return result;
    }
    set({ activePlanTree: result.data, isLoading: false });
    return result;
  },

  /**
   * Starts (or resumes) running an Execution-level leaf plan via
   * planExecutor.js. Call once per execution plan id returned by
   * buildPlanFromGoal() - typically in order, since planCoordinator.js
   * already sequenced tasks by their dependencies. Refreshes
   * activePlan/activePlanTree when the run pauses (awaiting approval,
   * completed, or failed) so the UI reflects the outcome immediately.
   *
   * @param {string} executionPlanId
   * @param {object} options - { githubToken, onStep, onAwaitingApproval }
   */
  async runPlan(executionPlanId, options = {}) {
    set({ isLoading: true, error: null });
    const result = await runExecutionPlan(executionPlanId, {
      ...options,
      shouldContinue: () => !get().__cancelRequested,
    });
    await get().refreshActivePlan();
    set({ isLoading: false });
    return result;
  },

  /**
   * Starts a plan that runHierarchicalPlan() built and paused for
   * review - PlanScreen.js's "Start plan" button, shown only when the
   * plan is awaiting_approval AND every step is still pending (i.e. it
   * hasn't started yet - distinct from a risky step pausing mid-run,
   * which uses approveStep() above instead). Nothing this plan does
   * (file writes, commits, terminal commands) happens before this is
   * called.
   *
   * @param {string} planId - whatever plan id PlanScreen.js is showing;
   *   may be an Execution-level leaf itself (the common case - a small
   *   request collapses to exactly one) or a Strategic root with
   *   Execution leaves further down the tree (a decomposed goal).
   * @param {object} options - { githubToken, onStep, onAwaitingApproval }
   */
  async startPlan(planId, options = {}) {
    set({ isLoading: true, error: null });
    get().resetCancelFlag();

    const leafIds = await collectExecutionLeafIds(planId);
    if (leafIds.length === 0) {
      set({ isLoading: false });
      return { success: false, content: '', status: null, error: { message: 'No plan steps found to run.' } };
    }

    const result = await runApprovedPlan(planId, leafIds, {
      ...options,
      shouldContinue: () => !get().__cancelRequested,
    });
    await get().refreshActivePlan();
    set({ isLoading: false });
    return result;
  },

  /** Approves the currently awaiting_approval step (risky step, or a recovery escalation) and resumes its plan's executor loop. */
  async approveStep(step, planId, options = {}) {
    set({ isLoading: true });
    const result = await executorApproveStep(step, planId, options);
    await get().refreshActivePlan();
    set({ isLoading: false });
    return result;
  },

  /** Skips the currently awaiting_approval step and resumes its plan's executor loop. */
  async rejectStep(step, planId, options = {}) {
    set({ isLoading: true });
    const result = await executorRejectStep(step, planId, options);
    await get().refreshActivePlan();
    set({ isLoading: false });
    return result;
  },

  /**
   * Accepts a checkpointBalancer.js suggestion - PlanScreen.js's "Mark
   * checkpoint & continue" button, used once the person has actually
   * verified/tested what's been built so far. Resets the pressure clock
   * and resumes execution.
   */
  async acceptCheckpoint(planId, options = {}) {
    set({ isLoading: true });
    const result = await executorAcceptCheckpoint(planId, options);
    await get().refreshActivePlan();
    set({ isLoading: false });
    return result;
  },

  /** Dismisses a checkpointBalancer.js suggestion without resetting the pressure clock - "not now" rather than "already checked" - and resumes execution. */
  async dismissCheckpoint(planId, options = {}) {
    set({ isLoading: true });
    const result = await executorDismissCheckpoint(planId, options);
    await get().refreshActivePlan();
    set({ isLoading: false });
    return result;
  },

  /** Sets a flag runPlan()'s executor loop polls between steps - PlanScreen.js's "Stop" button calls this before calling setPlanStatus(planId, 'cancelled'). */
  requestCancel() {
    set({ __cancelRequested: true });
  },

  /**
   * PlanScreen.js's "Stop" button. Setting __cancelRequested halts
   * whichever executor loop is currently running (startPlan()/runPlan()
   * both poll it as shouldContinue, and there's only ever one live loop
   * at a time regardless of how many leaves a decomposed goal has) -
   * this additionally marks every one of THIS plan's still-non-terminal
   * Execution leaves as cancelled, so a decomposed goal's status reads
   * correctly rather than only the single row the Stop button happened
   * to be pointed at.
   */
  async cancelPlan(planId) {
    get().requestCancel();
    const leafIds = await collectExecutionLeafIds(planId);
    for (const leafId of leafIds.length ? leafIds : [planId]) {
      const leaf = await getPlan(leafId);
      if (leaf.success && leaf.data && !['completed', 'failed', 'cancelled'].includes(leaf.data.status)) {
        await updatePlanStatus(leafId, 'cancelled');
      }
    }
    await get().refreshActivePlan();
  },

  resetCancelFlag() {
    set({ __cancelRequested: false });
  },

  /**
   * Creates a new plan and persists all of its steps in one call - the
   * point where a domain planner's output (an ordered list of steps)
   * becomes a real, resumable, trackable plan. Risk classification
   * happens here, once, at creation time - not re-evaluated per step
   * later - so a plan's approval requirements are stable and visible
   * up-front rather than surprising the person mid-run.
   *
   * @param {object} params
   * @param {string} [params.conversationId]
   * @param {string} params.goal - the original request this plan fulfills, shown as the plan's title
   * @param {Array<{domain, description, action, target, details, dependsOnStepId}>} params.steps - ordered; dependsOnStepId (if any) should reference another step's `id` you provide below
   * @returns {Promise<{success: boolean, planId: string|null, error: string|null}>}
   */
  async createPlanFromSteps({ conversationId = null, goal, steps }) {
    set({ isLoading: true, error: null });

    const planId = uuidv4();
    const planResult = await createPlan(planId, { conversationId, goal });
    if (!planResult.success) {
      set({ isLoading: false, error: planResult.error });
      return { success: false, planId: null, error: planResult.error };
    }

    // Assign real step ids up front (rather than letting the DB layer
    // generate them) so dependsOnStepId references between steps in the
    // same batch can be resolved by the caller before insertion - the
    // caller building `steps` should generate its own ids the same way if
    // it needs to wire up dependencies; simple linear plans (the common
    // case for a 3B model's plans) can leave dependsOnStepId unset and
    // rely on step_order alone.
    const stepsWithIds = steps.map((step, index) => {
      const risk = classifyStep({ domain: step.domain, action: step.action, target: step.target, details: step.details });
      return {
        id: step.id || uuidv4(),
        stepOrder: index,
        domain: step.domain,
        description: step.description,
        action: step.action,
        target: step.target,
        details: step.details,
        dependsOnStepId: step.dependsOnStepId || null,
        isRisky: risk.risky,
        riskReason: risk.reason,
      };
    });

    const insertResult = await insertPlanSteps(planId, stepsWithIds);
    if (!insertResult.success) {
      set({ isLoading: false, error: insertResult.error });
      return { success: false, planId: null, error: insertResult.error };
    }

    const fullPlan = await getPlan(planId);
    set({ activePlan: fullPlan.data, isLoading: false, error: null });
    return { success: true, planId, error: null };
  },

  /** Loads a specific plan (with its steps) as the active plan - used when the person taps into a resumable/past plan from history. Builds an aggregated display view (see buildDisplayPlan below) for a non-leaf plan id, so a decomposed goal's Strategic root shows its real steps rather than an empty checklist. */
  async loadPlan(planId) {
    set({ isLoading: true, error: null });
    const result = await getPlan(planId);
    if (!result.success) {
      set({ isLoading: false, error: result.error });
      return { success: false, error: result.error };
    }
    const displayPlan = result.data ? await buildDisplayPlan(result.data) : null;
    set({ activePlan: displayPlan, isLoading: false });
    return { success: true, error: null };
  },

  /** Refreshes the active plan from the DB - call after any step update so PlanScreen.js's checklist reflects the latest status without needing its own polling. */
  async refreshActivePlan() {
    const current = get().activePlan;
    if (!current) return;
    const result = await getPlan(current.id);
    if (result.success && result.data) {
      const displayPlan = await buildDisplayPlan(result.data);
      set({ activePlan: displayPlan });
    }
  },

  async loadPlans(limit = 50) {
    set({ isLoading: true });
    const result = await getPlans(limit);
    set({ plans: result.success ? result.data : [], isLoading: false });
  },

  /** Checked once at app launch (see App.js) - surfaces any plan that was left running/paused/awaiting approval when the app last closed. */
  async loadActivePlansOnLaunch() {
    const result = await getActivePlans();
    if (result.success) {
      // getActivePlans() returns every non-terminal row in the plans
      // table, which includes every strategic/project/task/execution
      // node in a hierarchical tree, not just the one the person would
      // recognize as "a plan." Only top-level nodes (no parent_plan_id)
      // are worth surfacing as a "resume?" banner - opening any of
      // those still lets PlanScreen.js walk the full tree underneath.
      const topLevel = (result.data || []).filter((p) => !p.parent_plan_id);
      set({ resumablePlans: topLevel });
    }
  },

  /** Dismisses a resumable-plan banner locally without touching the plan's own status - the plan stays exactly as it was (still resumable later from Plan History), this just stops it from being surfaced again this session. */
  dismissResumablePlan(planId) {
    set((state) => ({
      resumablePlans: state.resumablePlans.filter((p) => p.id !== planId),
    }));
  },

  async setPlanStatus(planId, status, options = {}) {
    const result = await updatePlanStatus(planId, status, options);
    if (result.success) {
      await get().refreshActivePlan();
    }
    return result;
  },

  /**
   * Records one step's outcome as the executor (Phase 2+) works through
   * the plan. planId is passed explicitly (rather than read from
   * activePlan) so a step update from a background task still lands
   * correctly even if the person has navigated away from PlanScreen.js in
   * the meantime.
   */
  async setStepStatus(stepId, planId, statusUpdate) {
    const result = await updatePlanStep(stepId, planId, statusUpdate);
    if (result.success) {
      const current = get().activePlan;
      if (current?.id === planId) {
        await get().refreshActivePlan();
      }
    }
    return result;
  },

  async removePlan(planId) {
    const result = await dbDeletePlan(planId);
    if (result.success) {
      set((state) => ({
        activePlan: state.activePlan?.id === planId ? null : state.activePlan,
        plans: state.plans.filter((p) => p.id !== planId),
        resumablePlans: state.resumablePlans.filter((p) => p.id !== planId),
      }));
    }
    return result;
  },

  clearActivePlan() {
    set({ activePlan: null });
  },
}));

/**
 * A Strategic/Project/Task-level plan row never carries its own steps
 * (only Execution-level leaves do - see planCoordinator.js) - passing
 * one straight to PlanScreen.js means an empty checklist even though
 * real steps exist further down the tree. This walks down to every
 * Execution leaf under planRow and flattens their steps/milestones/
 * checkpoint into one display-friendly plan object, so a decomposed
 * goal's root shows exactly what a single-leaf request already does.
 * Each flattened step KEEPS its real plan_id (the leaf it actually
 * belongs to, not the root) so PlanScreen.js's approve/reject/
 * checkpoint actions resolve against the right executor run.
 *
 * A plan that's already an Execution-level leaf (the common case now
 * that every task goes through the planner - see frontendBrain.js) is
 * returned unchanged; this only does work for the decomposed case.
 */
async function buildDisplayPlan(planRow) {
  if (planRow.level === 'execution') return planRow;

  const treeResult = await getPlanTree(planRow.id);
  if (!treeResult.success || !treeResult.data) return planRow;

  const leaves = [];
  function walk(node) {
    if (!node) return;
    if (node.level === 'execution') { leaves.push(node); return; }
    for (const child of node.children || []) walk(child);
  }
  walk(treeResult.data);

  if (leaves.length === 0) return planRow;

  const steps = leaves.flatMap((leaf) => (leaf.steps || []).map((s) => ({ ...s, plan_id: leaf.id })));
  const milestones = leaves.flatMap((leaf) => leaf.milestones || []);
  const checkpointLeaf = leaves.find((l) => l.checkpoint_pending);

  return {
    ...planRow,
    status: aggregateStatus(leaves),
    steps,
    milestones,
    checkpoint_pending: !!checkpointLeaf,
    checkpoint_reason: checkpointLeaf?.checkpoint_reason || null,
    checkpoint_plan_id: checkpointLeaf?.id || null,
  };
}

/** Rolls several Execution leaves' individual statuses up into one plan-level status for the aggregated view above - ordered most-attention-needed first, since that's what a person opening the plan most wants surfaced. */
function aggregateStatus(leaves) {
  const statuses = leaves.map((l) => l.status);
  if (statuses.includes(PLAN_STATUS.FAILED)) return PLAN_STATUS.FAILED;
  if (statuses.includes(PLAN_STATUS.AWAITING_APPROVAL)) return PLAN_STATUS.AWAITING_APPROVAL;
  if (statuses.includes(PLAN_STATUS.RECOVERING)) return PLAN_STATUS.RECOVERING;
  if (statuses.includes(PLAN_STATUS.RUNNING)) return PLAN_STATUS.RUNNING;
  if (statuses.includes(PLAN_STATUS.PAUSED)) return PLAN_STATUS.PAUSED;
  if (statuses.every((s) => s === PLAN_STATUS.COMPLETED)) return PLAN_STATUS.COMPLETED;
  if (statuses.includes(PLAN_STATUS.CANCELLED)) return PLAN_STATUS.CANCELLED;
  return PLAN_STATUS.PLANNING;
}

/**
 * Walks down from planId to every Execution-level leaf under it, in
 * tree order (planCoordinator.js already sequences siblings by
 * dependency/creation order, and getPlanTree.js preserves that). If
 * planId is itself an Execution-level plan (the common case - a
 * request small enough to collapse per planCoordinator.js's
 * "COLLAPSING FOR SIMPLE REQUESTS" IS its own leaf), returns it alone
 * without a tree walk.
 */
async function collectExecutionLeafIds(planId) {
  const planResult = await getPlan(planId);
  if (!planResult.success || !planResult.data) return [];
  if (planResult.data.level === 'execution') return [planId];

  const treeResult = await getPlanTree(planId);
  if (!treeResult.success || !treeResult.data) return [];

  const leaves = [];
  function walk(node) {
    if (!node) return;
    if (node.level === 'execution') {
      leaves.push(node.id);
      return;
    }
    for (const child of node.children || []) walk(child);
  }
  walk(treeResult.data);
  return leaves;
}
