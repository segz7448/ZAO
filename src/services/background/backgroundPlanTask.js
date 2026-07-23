/**
 * ZAO - Background Plan Continuation
 *
 * WHAT THIS FIXES: previously, closing the app mid-plan meant execution
 * simply stopped - the plan's state survived in SQLite (see
 * planExecutor.js's own comment about a resumed session), but nothing
 * continued it until the person reopened the app and manually tapped
 * back in. This registers a REAL OS-level background task (via
 * expo-background-task/expo-task-manager, the modern replacement for
 * the deprecated expo-background-fetch - see BGTaskScheduler on iOS,
 * WorkManager on Android) that periodically wakes the app up in the
 * background and continues any plan that was actively 'running' when
 * the app was last closed.
 *
 * HONEST LIMITATIONS - stated plainly rather than oversold:
 *   - minimumInterval is a HINT to the OS, not a guarantee. In practice
 *     this fires anywhere from every ~15 minutes (a healthy, frequently
 *     used app) to effectively never (an app the person hasn't opened
 *     in days) - see Expo's own docs. This is a real improvement over
 *     "does nothing at all," not a persistent always-on daemon.
 *   - Each wakeup gets a short, OS-enforced time budget (a spare few
 *     seconds to roughly a minute, platform-dependent) before the OS
 *     kills it - BACKGROUND_TASK_TIME_BUDGET_MS below is a soft
 *     self-imposed cutoff well under that so a run finishes cleanly
 *     with its own JS-side deadline rather than getting killed mid-step.
 *   - Only plans left in status 'running' are touched - never
 *     'awaiting_approval' or 'paused', since those need an actual human
 *     decision this can't make on its own. A risky step encountered
 *     mid-run (see riskClassifier.js) still pauses for approval exactly
 *     as it would in the foreground; this doesn't bypass that gate, it
 *     just means the *next* time the app is opened, less work is left.
 *   - Requires the PC backend to be reachable from wherever the phone
 *     is when the task fires - if it isn't, the task just reports
 *     BackgroundTaskResult.Failed for that wakeup and tries again next
 *     time, same as any other network-dependent background sync.
 *   - A plan step that needs the PC browser agent (agentSession) can't
 *     be driven from here - there's no live agentSession outside a
 *     mounted ChatScreen. Those steps still fail gracefully rather than
 *     hanging (runExecutionPlan reports the step needs it and stops
 *     there without crashing the task), so the rest of a mixed plan's
 *     leaves still get their chance; the browsing step itself just
 *     waits for the person to reopen the app.
 */

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import { initDatabase, getActivePlans, getPlan, getPlanTree } from '../../db/database';
import { runExecutionPlan } from '../planning/planExecutor';

export const BACKGROUND_PLAN_TASK = 'zao-background-plan-continuation';
const MINIMUM_INTERVAL_SECONDS = 15 * 60; // 15 min - the practical floor both platforms enforce anyway
const BACKGROUND_TASK_TIME_BUDGET_MS = 25000; // soft self-imposed cutoff, comfortably under the OS's own kill window

/**
 * Same tree-walk collectExecutionLeafIds() in planStore.js does, but
 * standalone here so this task doesn't have to pull in the zustand
 * store (and everything it in turn imports) just to run headless.
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

/**
 * The actual work done on each background wakeup: find every top-level
 * plan left in 'running' status (interrupted by the app closing, not a
 * deliberate pause or an awaiting-approval stop) and continue each
 * one's execution leaves until either the time budget runs out or every
 * ready step is done/blocked/awaiting approval.
 *
 * @returns {Promise<'Success'|'Failed'|'NoData'>} maps directly to
 *   BackgroundTask.BackgroundTaskResult - see defineTask() below.
 */
export async function continueInterruptedPlans() {
  const deadline = Date.now() + BACKGROUND_TASK_TIME_BUDGET_MS;

  await initDatabase();

  const activeResult = await getActivePlans();
  if (!activeResult.success) return 'Failed';

  const runningTopLevel = (activeResult.data || []).filter(
    (p) => !p.parent_plan_id && p.status === 'running'
  );
  if (runningTopLevel.length === 0) return 'NoData';

  let didWork = false;

  for (const plan of runningTopLevel) {
    if (Date.now() >= deadline) break;

    const leafIds = await collectExecutionLeafIds(plan.id);
    for (const leafId of leafIds) {
      if (Date.now() >= deadline) break;

      // eslint-disable-next-line no-await-in-loop
      const result = await runExecutionPlan(leafId, {
        // Bail out of runExecutionPlan's own internal loop the instant
        // the time budget is up, even mid-plan - it re-reads plan state
        // from SQLite every pass (see its own header comment), so
        // stopping here leaves it in a perfectly resumable state, same
        // as any other interruption.
        shouldContinue: () => Date.now() < deadline,
      });
      didWork = true;
      // A step that hit an awaiting_approval/risky gate, or a genuine
      // failure, both correctly stop this leaf's loop on their own
      // (runExecutionPlan already handles that) - nothing further to do
      // here either way; move on to the next leaf/plan within budget.
      void result;
    }
  }

  return didWork ? 'Success' : 'NoData';
}

// Must be defined in the global module scope (not inside a component or
// effect) so it's registered before the JS engine even knows whether
// this launch is a normal foreground open or a background wakeup - see
// expo-task-manager's own docs on this requirement.
TaskManager.defineTask(BACKGROUND_PLAN_TASK, async () => {
  try {
    const outcome = await continueInterruptedPlans();
    return BackgroundTask.BackgroundTaskResult[outcome];
  } catch (err) {
    console.error('[BackgroundPlanTask] continuation failed:', err);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Call once at app startup (see App.js) - idempotent, safe to call every launch. */
export async function registerBackgroundPlanTask() {
  try {
    const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_PLAN_TASK);
    if (alreadyRegistered) return { success: true };
    await BackgroundTask.registerTaskAsync(BACKGROUND_PLAN_TASK, {
      minimumInterval: MINIMUM_INTERVAL_SECONDS,
    });
    return { success: true };
  } catch (err) {
    // Expected on a simulator/emulator without real background task
    // support, or a Go/Expo-Go build that can't register native tasks -
    // not fatal, foreground resume (planStore.js's loadActivePlansOnLaunch)
    // still covers the same plans the next time the app is opened.
    console.warn('[BackgroundPlanTask] registration failed (non-fatal):', err?.message);
    return { success: false, error: err?.message };
  }
}

/** Exposed for Settings, in case the person wants to turn this off. */
export async function unregisterBackgroundPlanTask() {
  try {
    await BackgroundTask.unregisterTaskAsync(BACKGROUND_PLAN_TASK);
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message };
  }
}
