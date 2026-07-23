/**
 * ZAO - Background Process Watcher
 *
 * WHAT THIS FIXES: pc_process_start (pcProcessTool.js) turns "run npm
 * start" into a real running process instead of a 2-minute dead end -
 * but the person is on their phone, not sitting in front of a terminal
 * watching it. Without this, the only way to learn a background build
 * finished or a dev server crashed is to remember to go ask ZAO. This
 * watches ZAO's own `background_processes` record (src/db/database.js)
 * and fires a local notification the moment a tracked process's status
 * changes to something terminal (exited/killed/error) that hasn't been
 * notified about yet.
 *
 * TWO CHECK PATHS, same underlying checkTrackedProcesses():
 *   - Foreground poll (startForegroundProcessWatch/stopForegroundProcessWatch)
 *     - a plain setInterval while the app is open, for a near-immediate
 *     notification the moment a watched process finishes.
 *   - OS background task (registerProcessWatcherTask), same shape as
 *     backgroundPlanTask.js - periodically wakes the app up even when
 *     it's closed. Same HONEST LIMITATIONS as that file: minimumInterval
 *     is a hint to the OS, not a guarantee (anywhere from ~15 minutes on
 *     a frequently-used app to effectively never on one the person
 *     hasn't opened in days - see Expo's own docs), and each wakeup gets
 *     a short OS-enforced time budget.
 *
 * Both paths require the PC backend to be reachable from wherever the
 * phone currently is - if it isn't, a check just fails quietly and
 * tries again next time, same as any other network-dependent poll.
 */

import * as BackgroundTask from 'expo-background-task';
import * as TaskManager from 'expo-task-manager';
import * as Notifications from 'expo-notifications';
import { initDatabase, getTrackedBackgroundProcesses, updateBackgroundProcessStatus, markBackgroundProcessNotified } from '../../db/database';
import { getPcProcessStatus } from '../backend/backendClient';

export const PROCESS_WATCHER_TASK = 'zao-pc-process-watch';
const MINIMUM_INTERVAL_SECONDS = 15 * 60; // 15 min - the practical floor both platforms enforce anyway (see backgroundPlanTask.js)
const FOREGROUND_POLL_INTERVAL_MS = 5000; // while the app is open, check often enough that "finished" feels near-instant

const TERMINAL_STATUSES = new Set(['exited', 'killed', 'error']);

function notificationForStatus(row, status, exitCode) {
  if (status === 'error') {
    return { title: 'Background process failed to start', body: row.label };
  }
  if (status === 'killed') {
    return { title: 'Background process stopped', body: row.label };
  }
  // 'exited'
  const succeeded = exitCode === 0;
  return {
    title: succeeded ? 'Background process finished' : 'Background process crashed',
    body: succeeded ? row.label : `${row.label} (exit code ${exitCode})`,
  };
}

async function notify(row, status, exitCode) {
  try {
    const perms = await Notifications.getPermissionsAsync();
    let granted = perms.granted || perms.ios?.status === 3; // 3 = PROVISIONAL on iOS, still countable
    if (!granted) {
      const req = await Notifications.requestPermissionsAsync();
      granted = !!req.granted;
    }
    if (!granted) return; // no permission - ZAO's own record is still updated below either way, just no OS alert

    const { title, body } = notificationForStatus(row, status, exitCode);
    await Notifications.scheduleNotificationAsync({
      content: { title, body, data: { backgroundProcessId: row.id } },
      trigger: null, // fire immediately - this IS the alert, not a scheduled future one
    });
  } catch (err) {
    console.error('[ProcessWatcher] notify failed:', err);
  }
}

/**
 * One pass: pulls every process ZAO is still tracking (running, or
 * finished but not yet notified), checks its current status on the PC,
 * and fires a notification + marks it notified the first time it's
 * seen in a terminal state. Safe to call repeatedly - a process already
 * marked notified is skipped even if checked again.
 * @returns {Promise<'Success'|'Failed'|'NoData'>}
 */
export async function checkTrackedProcesses() {
  await initDatabase();

  const tracked = await getTrackedBackgroundProcesses();
  if (!tracked.success) return 'Failed';
  if ((tracked.data || []).length === 0) return 'NoData';

  let didWork = false;

  for (const row of tracked.data) {
    // eslint-disable-next-line no-await-in-loop
    const result = await getPcProcessStatus(row.id);
    if (!result.success) continue; // PC unreachable right now - try again next poll, nothing to update

    const { status, exitCode } = result.data;
    didWork = true;

    if (status !== row.status) {
      // eslint-disable-next-line no-await-in-loop
      await updateBackgroundProcessStatus(row.id, status, exitCode ?? null);
    }

    if (TERMINAL_STATUSES.has(status) && !row.notified) {
      // eslint-disable-next-line no-await-in-loop
      await notify(row, status, exitCode ?? null);
      // eslint-disable-next-line no-await-in-loop
      await markBackgroundProcessNotified(row.id);
    }
  }

  return didWork ? 'Success' : 'NoData';
}

// Must be defined in the global module scope, not inside a component or
// effect - see backgroundPlanTask.js's identical note on why.
TaskManager.defineTask(PROCESS_WATCHER_TASK, async () => {
  try {
    const outcome = await checkTrackedProcesses();
    return BackgroundTask.BackgroundTaskResult[outcome];
  } catch (err) {
    console.error('[ProcessWatcher] background task failed:', err);
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

/** Call once at app startup (see App.js) - idempotent, safe to call every launch. */
export async function registerProcessWatcherTask() {
  try {
    const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(PROCESS_WATCHER_TASK);
    if (alreadyRegistered) return { success: true };
    await BackgroundTask.registerTaskAsync(PROCESS_WATCHER_TASK, {
      minimumInterval: MINIMUM_INTERVAL_SECONDS,
    });
    return { success: true };
  } catch (err) {
    // Expected on a simulator/emulator without real background task
    // support, or a Go/Expo-Go build - non-fatal, the foreground poller
    // below still covers any process finishing while the app is open.
    console.warn('[ProcessWatcher] background task registration failed (non-fatal):', err?.message);
    return { success: false, error: err?.message };
  }
}

/** Exposed for Settings, in case the person wants to turn this off. */
export async function unregisterProcessWatcherTask() {
  try {
    await BackgroundTask.unregisterTaskAsync(PROCESS_WATCHER_TASK);
    return { success: true };
  } catch (err) {
    return { success: false, error: err?.message };
  }
}

let foregroundTimer = null;

/** Starts a plain setInterval poll while the app is open/foregrounded - a near-instant "finished" notification instead of waiting for the OS to grant a background wakeup. Call once at app startup alongside registerProcessWatcherTask(); idempotent. */
export function startForegroundProcessWatch() {
  if (foregroundTimer) return;
  foregroundTimer = setInterval(() => {
    checkTrackedProcesses().catch((err) => console.error('[ProcessWatcher] foreground poll failed:', err));
  }, FOREGROUND_POLL_INTERVAL_MS);
}

/** Stops the foreground poll - call on app teardown if ever needed; not required for correctness since the interval is harmless idle work, just tidy. */
export function stopForegroundProcessWatch() {
  if (foregroundTimer) {
    clearInterval(foregroundTimer);
    foregroundTimer = null;
  }
}
