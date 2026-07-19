/**
 * ZAO - Reminder Service (prospective memory, ZAO-owned)
 *
 * Closes the gap named in MEMORY_ARCHITECTURE.md / memoryTypes.js's
 * PROSPECTIVE entry: before this file existed, "remind me to X" was
 * 100% delegated to Android's own AlarmManager (via expo-notifications)
 * with nothing recorded inside ZAO itself. That meant ZAO could not
 * list what it had promised to remind the person about, could not tell
 * the person "yes, that's still scheduled" or "that one silently failed
 * because notification permission was never granted," and could not
 * cancel a specific one without the person digging through the system
 * notification shade.
 *
 * The fix is a small ownership inversion: the `reminders` SQLite table
 * (src/db/database.js) is now the source of truth ZAO reads from and
 * reasons about. expo-notifications is used as the delivery mechanism
 * underneath it, not as the record itself - every write here updates
 * the DB row FIRST, then best-effort mirrors it into the OS scheduler.
 * If the OS-level call fails (permission denied, etc.) the DB row still
 * exists and says so, so ZAO can be honest about it instead of the
 * reminder just silently never firing with no trace anywhere.
 *
 * REPEAT DESIGN NOTE: rather than depending on expo-notifications'
 * repeating-trigger types (whose exact shape has shifted across SDK
 * versions), a repeating reminder is implemented as a chain of one-shot
 * DATE triggers: when occurrence N fires (or is caught by
 * reconcileReminders() below), occurrence N+1 is inserted as a brand
 * new row and scheduled. This is a few more DB rows over time, but it's
 * robust to SDK-version drift and keeps every occurrence individually
 * inspectable/cancelable, rather than one opaque "repeats forever" OS
 * registration ZAO could not easily reason about per-occurrence -
 * consistent with the rest of this table's "ZAO can see what it did"
 * goal. Only 'daily' and 'weekly' are supported - not a general RRULE -
 * matching the small, honest surface the rest of this app favors over a
 * general-purpose scheduler.
 */

import { v4 as uuidv4 } from 'uuid';
import * as Notifications from 'expo-notifications';
import {
  addReminder,
  setReminderOsId,
  getActiveReminders,
  getAllReminders,
  getReminder,
  markReminderFired,
  markReminderFailed,
  cancelReminderRecord,
  deleteReminder as deleteReminderRow,
} from '../../db/database';

const DAY_MS = 24 * 60 * 60 * 1000;
const REPEAT_STEP_MS = { daily: DAY_MS, weekly: 7 * DAY_MS };

let handlerInstalled = false;
let listenersInstalled = false;

/**
 * Configures how a delivered notification behaves while the app is in
 * the foreground, and wires the received/response listeners that keep
 * the `reminders` table in sync with what expo-notifications actually
 * delivers. Safe to call more than once - both installs are guarded.
 * Call once from App.js's startup effect, alongside initDatabase().
 */
export function initReminderListeners() {
  if (!handlerInstalled) {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: false,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    handlerInstalled = true;
  }

  if (!listenersInstalled) {
    const onDelivered = (event) => {
      const reminderId = event?.request?.content?.data?.reminderId;
      if (reminderId) handleReminderFired(reminderId).catch((err) => console.error('[Reminders] handleReminderFired (delivered) failed:', err));
    };
    // Covers both "delivered while the app was open" and "person tapped
    // the notification" - the latter can be the ONLY signal ZAO gets if
    // the app process was killed when it actually fired, so both are
    // wired to the same handler (handleReminderFired is idempotent - see
    // its own guard below - so getting both events for the same
    // reminder is harmless).
    Notifications.addNotificationReceivedListener(onDelivered);
    Notifications.addNotificationResponseReceivedListener((response) => onDelivered(response.notification));
    listenersInstalled = true;
  }
}

/** Rolls a past due-time forward to the next occurrence at/after `from`, for a reminder that's repeating and whose stored trigger_at has already passed (e.g. the app was closed when it should have fired). */
function rollForward(triggerAt, repeatRule, from = Date.now()) {
  const step = REPEAT_STEP_MS[repeatRule];
  if (!step) return triggerAt;
  let next = triggerAt;
  while (next < from) next += step;
  return next;
}

/** Best-effort mirror of one reminder row into the OS scheduler. Never throws - returns the notification identifier on success, or null (and marks the row 'failed') if permission is missing or the OS call errors, so a permission problem shows up as an honest status ZAO can report instead of a silent no-op. */
async function scheduleOsNotification(id, message, triggerAt) {
  try {
    const perms = await Notifications.getPermissionsAsync();
    let granted = perms.granted || perms.ios?.status === 3; // 3 = PROVISIONAL on iOS, still countable
    if (!granted) {
      const req = await Notifications.requestPermissionsAsync();
      granted = !!req.granted;
    }
    if (!granted) {
      await markReminderFailed(id);
      return { osNotificationId: null, warning: 'Notification permission was denied, so this won\'t actually alert - but ZAO still has it recorded.' };
    }

    const osNotificationId = await Notifications.scheduleNotificationAsync({
      content: { title: 'ZAO reminder', body: message, data: { reminderId: id } },
      trigger: { type: Notifications.SchedulableTriggerInputTypes?.DATE || 'date', date: new Date(triggerAt) },
    });
    await setReminderOsId(id, osNotificationId);
    return { osNotificationId, warning: null };
  } catch (err) {
    console.error('[Reminders] scheduleOsNotification failed:', err);
    await markReminderFailed(id);
    return { osNotificationId: null, warning: `Couldn't schedule the system notification (${err?.message || 'unknown error'}), but ZAO still has this reminder recorded.` };
  }
}

/**
 * Schedules a new reminder. `triggerAt` is an epoch-ms timestamp; for a
 * repeating reminder given a triggerAt already in the past, it's rolled
 * forward to the next valid occurrence rather than rejected.
 * @param {{message: string, triggerAt: number, repeatRule?: 'daily'|'weekly'|null, sourceConversationId?: string|null}} params
 */
export async function scheduleReminder({ message, triggerAt, repeatRule = null, sourceConversationId = null }) {
  if (!message || !message.trim()) {
    return { success: false, error: { message: 'A reminder needs a message.' }, data: null };
  }
  if (!Number.isFinite(triggerAt)) {
    return { success: false, error: { message: 'triggerAt must be a valid timestamp.' }, data: null };
  }

  const effectiveTriggerAt = repeatRule ? rollForward(triggerAt, repeatRule) : triggerAt;
  if (effectiveTriggerAt < Date.now() - 60000 && !repeatRule) {
    return { success: false, error: { message: 'That time is in the past.' }, data: null };
  }

  const id = uuidv4();
  const insert = await addReminder({ id, message: message.trim(), triggerAt: effectiveTriggerAt, repeatRule, sourceConversationId });
  if (!insert.success) {
    return { success: false, error: { message: insert.error }, data: null };
  }

  const osResult = await scheduleOsNotification(id, message.trim(), effectiveTriggerAt);

  return {
    success: true,
    data: {
      id,
      message: message.trim(),
      triggerAt: effectiveTriggerAt,
      repeatRule,
      osScheduled: !!osResult.osNotificationId,
      warning: osResult.warning,
    },
    error: null,
  };
}

/** Lists reminders ZAO knows about - includeCompleted=false (default) returns only still-pending ones, matching what "what have you got scheduled?" actually means; pass true for the full history including fired/cancelled/failed rows. */
export async function listReminders({ includeCompleted = false } = {}) {
  const result = includeCompleted ? await getAllReminders() : await getActiveReminders();
  if (!result.success) return { success: false, error: { message: result.error }, data: null };
  return {
    success: true,
    data: result.data.map((row) => ({
      id: row.id,
      message: row.message,
      triggerAt: row.trigger_at,
      repeatRule: row.repeat_rule,
      status: row.status,
      firedAt: row.fired_at || null,
    })),
    error: null,
  };
}

/** Cancels a reminder: best-effort cancels the OS-level notification (harmless no-op if it already failed to schedule or already fired), then always marks the row cancelled so ZAO's own record matches what the person asked for. */
export async function cancelReminder(id) {
  const existing = await getReminder(id);
  if (!existing.success || !existing.data) {
    return { success: false, error: { message: 'No reminder found with that id.' }, data: null };
  }
  if (existing.data.status !== 'scheduled') {
    return { success: false, error: { message: `That reminder is already ${existing.data.status}.` }, data: null };
  }

  if (existing.data.os_notification_id) {
    try {
      await Notifications.cancelScheduledNotificationAsync(existing.data.os_notification_id);
    } catch (err) {
      // Already delivered/expired on the OS side, or the handle is stale -
      // either way this is not a reason to leave ZAO's own record wrong.
      console.error('[Reminders] cancelScheduledNotificationAsync failed (continuing):', err);
    }
  }

  const result = await cancelReminderRecord(id);
  if (!result.success) return { success: false, error: { message: result.error }, data: null };
  return { success: true, data: { id }, error: null };
}

/**
 * Marks a reminder as fired and, if it repeats, schedules the next
 * occurrence as a new row. Idempotent: a reminder already out of
 * 'scheduled' status is left untouched, so getting both a "delivered"
 * and a "tapped" event for the same notification (or a reconciliation
 * pass re-checking one already handled) never double-advances a
 * repeating chain.
 */
export async function handleReminderFired(id) {
  const existing = await getReminder(id);
  if (!existing.success || !existing.data || existing.data.status !== 'scheduled') return { success: true, data: null, error: null };

  await markReminderFired(id);

  if (existing.data.repeat_rule) {
    const step = REPEAT_STEP_MS[existing.data.repeat_rule];
    const nextTriggerAt = rollForward(existing.data.trigger_at + (step || 0), existing.data.repeat_rule);
    await scheduleReminder({
      message: existing.data.message,
      triggerAt: nextTriggerAt,
      repeatRule: existing.data.repeat_rule,
      sourceConversationId: existing.data.source_conversation_id,
    });
  }

  return { success: true, data: { id }, error: null };
}

/**
 * Sweeps every 'scheduled' reminder whose trigger_at has already passed
 * without ZAO having heard a delivered/tapped event for it - the case
 * that mattered most for the original gap: previously, if the OS
 * silently failed to fire (permission revoked after scheduling, app
 * data cleared, etc.) or the person just never opened the app around
 * the right time, ZAO's own state still said "scheduled" forever with
 * no way to notice. Call once at app startup, after initReminderListeners().
 */
export async function reconcileReminders() {
  const active = await getActiveReminders();
  if (!active.success) return { success: false, error: { message: active.error } };

  const overdue = active.data.filter((row) => row.trigger_at < Date.now() - 60000);
  for (const row of overdue) {
    await handleReminderFired(row.id).catch((err) => console.error('[Reminders] reconcile handleReminderFired failed:', err));
  }
  return { success: true, error: null, data: { reconciledCount: overdue.length } };
}

/** Permanently forgets a reminder (any status) - for a future Settings "clear" action, distinct from cancelReminder which keeps history. */
export async function forgetReminder(id) {
  return deleteReminderRow(id);
}
