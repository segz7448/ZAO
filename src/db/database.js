/**
 * ZAO - Local SQLite Database Layer
 *
 * Design principles:
 * - Every function wraps its DB calls in try/catch. Nothing throws uncaught.
 * - Every function returns a consistent shape: { success, data, error }
 * - Callers should always check `success` before using `data`.
 * - This is the ONLY datastore. Everything lives here, on-device - no
 *   cloud sync, no external database.
 */

import * as SQLite from 'expo-sqlite';
import * as SecureStore from 'expo-secure-store';

const DB_NAME = 'zao.db';
let dbInstance = null;

/**
 * Get (or lazily open) the database connection.
 * Never throws - returns null on failure, caller must handle.
 */
async function getDb() {
  if (dbInstance) return dbInstance;
  try {
    dbInstance = await SQLite.openDatabaseAsync(DB_NAME);
    return dbInstance;
  } catch (err) {
    console.error('[DB] Failed to open database:', err);
    dbInstance = null;
    return null;
  }
}

/**
 * Initialize schema. Safe to call every app start - uses IF NOT EXISTS everywhere.
 * Returns { success, error }
 */
export async function initDatabase() {
  try {
    const db = await getDb();
    if (!db) {
      return { success: false, error: 'DB_OPEN_FAILED' };
    }

    await db.execAsync(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS conversations (
        id TEXT PRIMARY KEY NOT NULL,
        title TEXT DEFAULT 'New Conversation',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        last_provider TEXT,
        last_model TEXT
      );

      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
        content TEXT NOT NULL,
        provider TEXT,
        model TEXT,
        model_family TEXT,
        token_count INTEGER DEFAULT 0,
        created_at INTEGER NOT NULL,
        is_error INTEGER DEFAULT 0,
        edited_at INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS model_health (
        model_key TEXT PRIMARY KEY NOT NULL,
        provider TEXT NOT NULL,
        model_id TEXT NOT NULL,
        status TEXT DEFAULT 'unknown',
        avg_response_ms INTEGER DEFAULT 0,
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        consecutive_failures INTEGER DEFAULT 0,
        quota_remaining INTEGER,
        last_checked_at INTEGER,
        last_success_at INTEGER,
        cooldown_until INTEGER DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS user_preferences (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        -- ai_mode / manual_default_model / manual_limit_behavior columns were
        -- dropped from app logic - routing is now fully automatic with no
        -- manual override, and there's only one model (see
        -- src/config/localModels.js). Columns intentionally NOT removed
        -- from schema to avoid a migration on existing installs; they're
        -- simply unused now.
        ai_mode TEXT DEFAULT 'auto',
        manual_default_model TEXT DEFAULT 'gemini',
        manual_limit_behavior TEXT DEFAULT 'ask',
        theme_preference TEXT DEFAULT 'auto',
        browser_access_enabled INTEGER DEFAULT 0,
        github_username TEXT,
        filesystem_saf_uri TEXT,
        memory_enabled INTEGER DEFAULT 1,
        updated_at INTEGER
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        provider TEXT PRIMARY KEY NOT NULL,
        key_value TEXT, -- always NULL now; kept for schema stability. Actual
                        -- secret lives in expo-secure-store, see getApiKey/
                        -- storeApiKey/deleteApiKey below for why.
        is_user_provided INTEGER DEFAULT 0,
        updated_at INTEGER
      );

      -- Usage/Developer Mode dashboard (Settings > Usage) - one row per
      -- tool call or model call, written by usageLog.js's logUsageEvent().
      -- event_type is a short category ('github_push', 'file_created',
      -- 'file_deleted', 'file_modified', 'file_browsed', 'browser_session',
      -- etc. - see toolOrchestrator.js's eventTypeForTool()), detail is a
      -- short human-readable label
      -- for Developer Mode's step trace, and metadata is a JSON string for
      -- anything category-specific (cost estimate, step count, key
      -- source) that doesn't need its own column.
      CREATE TABLE IF NOT EXISTS usage_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        event_type TEXT NOT NULL,
        detail TEXT,
        metadata TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_usage_log_type_date
        ON usage_log (event_type, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_messages_conversation
        ON messages (conversation_id, created_at);

      CREATE INDEX IF NOT EXISTS idx_conversations_updated
        ON conversations (updated_at DESC);

      -- Long-term memory bank (Settings > Memory) - the equivalent of what
      -- Claude/ChatGPT call "memory": durable facts about the person,
      -- extracted from past conversations, that get re-injected as context
      -- into every NEW conversation so ZAO doesn't start from zero each
      -- time. This is intentionally separate from the messages table (full
      -- conversation history, scoped to one conversation only) - a memory
      -- is a short, standalone fact ("User lives in Lagos") that survives
      -- across every conversation, forever, until edited/deleted.
      --
      -- category is a loose label ('personal', 'work', 'preference',
      -- 'project') used only for grouping in the Settings UI - it has no
      -- effect on retrieval logic (memoryEngine.js currently loads ALL
      -- active memories rather than filtering by category).
      --
      -- source_conversation_id is kept for traceability ("where did ZAO
      -- learn this?") but is nullable and ON DELETE SET NULL - deleting the
      -- conversation a memory came from should never delete the memory
      -- itself, since the fact may still be true long after that chat is gone.
      --
      -- is_active supports soft-delete: user-facing "forget this" in the
      -- Memory settings screen sets is_active=0 rather than a hard DELETE,
      -- so the extraction pass won't immediately re-learn a fact the
      -- person deliberately asked ZAO to forget.
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY NOT NULL,
        content TEXT NOT NULL,
        category TEXT DEFAULT 'general',
        source_conversation_id TEXT,
        is_active INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (source_conversation_id) REFERENCES conversations (id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_memories_active
        ON memories (is_active, updated_at DESC);

      -- Procedural memory bank (see src/services/memory/proceduralMemory.js) -
      -- "how to do X" recipes, distinct from the memories table above
      -- (which stores facts, not methods). Written once a hierarchical plan
      -- (src/services/planning/) finishes successfully: task_signature is a
      -- normalized keyword fingerprint of the goal it solved, steps_json is
      -- the ordered list of {domain, description} steps that worked, and
      -- use_count/last_used_at let a simple recency+frequency ranking pick
      -- the best match when several procedures could apply to a new goal.
      -- This is genuinely separate from the plans tables below - a plan
      -- row is one specific run tied to one conversation; a procedure is the
      -- reusable pattern distilled out of a run that succeeded, kept even
      -- after the plan/conversation it came from is deleted.
      CREATE TABLE IF NOT EXISTS procedures (
        id TEXT PRIMARY KEY NOT NULL,
        task_signature TEXT NOT NULL,
        goal_summary TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        source_plan_id TEXT,
        use_count INTEGER DEFAULT 1,
        created_at INTEGER NOT NULL,
        last_used_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_procedures_last_used
        ON procedures (last_used_at DESC);

      -- Prospective memory store (see src/services/reminders/reminderService.js) -
      -- previously ZAO had NO internal record of reminders/follow-ups it
      -- scheduled: the OS's own alarm/notification system was the only
      -- copy, so ZAO couldn't list, inspect, or reason about what it had
      -- promised to remind the person about. This table is now the
      -- ZAO-owned source of truth; the OS scheduler (Android AlarmManager,
      -- via expo-notifications) mirrors it, rather than being the only
      -- copy. os_notification_id is expo-notifications' own scheduling
      -- handle, kept so a cancel can reach into the OS layer too - NULL if
      -- the OS-level schedule call failed (e.g. notification permission
      -- denied), in which case ZAO still knows the reminder exists and can
      -- say so honestly, even though it won't actually fire. repeat_rule
      -- is intentionally a small closed set (NULL/'daily'/'weekly'), not a
      -- full RRULE - matches the small, honest surface the rest of this
      -- app favors over a general-purpose scheduler.
      CREATE TABLE IF NOT EXISTS reminders (
        id TEXT PRIMARY KEY NOT NULL,
        message TEXT NOT NULL,
        trigger_at INTEGER NOT NULL,
        repeat_rule TEXT,
        status TEXT NOT NULL DEFAULT 'scheduled' CHECK (status IN ('scheduled', 'fired', 'cancelled', 'failed')),
        os_notification_id TEXT,
        source_conversation_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        fired_at INTEGER,
        FOREIGN KEY (source_conversation_id) REFERENCES conversations (id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_reminders_status
        ON reminders (status, trigger_at);

      -- Background PC processes (see server/processManager.js,
      -- src/services/terminal/pcProcessTool.js) - a dev server or other
      -- long-lived command started with pc_process_start. This table is
      -- what lets processWatcherTask.js notice a tracked process crashed
      -- or exited while the app was closed/backgrounded and fire exactly
      -- one local notification for it (notified flips to 1 right after),
      -- rather than re-notifying on every poll. id is the PC-side process
      -- id returned by /process/start, not a ZAO-generated one.
      CREATE TABLE IF NOT EXISTS background_processes (
        id TEXT PRIMARY KEY NOT NULL,
        label TEXT NOT NULL,
        command TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'exited', 'killed', 'error')),
        exit_code INTEGER,
        notified INTEGER NOT NULL DEFAULT 0,
        source_conversation_id TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        FOREIGN KEY (source_conversation_id) REFERENCES conversations (id) ON DELETE SET NULL
      );

      CREATE INDEX IF NOT EXISTS idx_background_processes_status
        ON background_processes (status, notified);

      -- Feedback pattern bank (see src/services/memory/feedbackMemory.js) -
      -- closes the loop on the thumbs-down button: messages.feedback (see
      -- migration below) records a single like/dislike on one message, but
      -- nothing previously read that column back or looked for repeated
      -- complaints. Every time a message is disliked, the exchange is
      -- distilled into a short "avoid this" instruction and stored here;
      -- pattern_signature is a token-overlap fingerprint (same heuristic as
      -- memories/procedures) used to detect "this is basically the same
      -- complaint again" and bump occurrence_count instead of piling up
      -- near-duplicate rows. occurrence_count is what makes this
      -- aggregation rather than a 1:1 log: a pattern that's only fired once
      -- is far weaker evidence than one that's fired five times, and the
      -- guidance injected into the prompt is ranked accordingly.
      CREATE TABLE IF NOT EXISTS feedback_patterns (
        id TEXT PRIMARY KEY NOT NULL,
        pattern_signature TEXT NOT NULL,
        description TEXT NOT NULL,
        example_snippet TEXT,
        occurrence_count INTEGER DEFAULT 1,
        source_message_id TEXT,
        created_at INTEGER NOT NULL,
        last_seen_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_feedback_patterns_ranking
        ON feedback_patterns (occurrence_count DESC, last_seen_at DESC);

      -- Planning layer (see src/services/planning/) - a plan is a
      -- multi-step task broken down by a domain planner (coding, terminal,
      -- files, browser) before execution starts, persisted so progress
      -- survives an app restart and shows as a checklist (see
      -- PlanScreen.js). One plan can span multiple domains - each step
      -- carries its own domain tag so the executor knows which existing
      -- tool/loop (terminal, filesystem, browser agent, etc.) to hand it
      -- to.
      --
      -- Phase 2 (hierarchical planning, see src/services/planning/):
      -- a plans row is now one node in a 4-level hierarchy -
      -- Strategic -> Project -> Task -> Execution - rather than always
      -- being the top-level thing. 'level' says which layer this node
      -- lives at, 'parent_plan_id' links it up to the node that spawned
      -- it, and 'plan_type' says which of the 8 planning types produced
      -- it (goal, project, task, dependency, resource, recovery,
      -- execution, milestone). A simple one-shot request still produces
      -- a single 'execution' level plan with no parent, same as Phase 1 -
      -- the hierarchy only grows as deep as a goal actually needs.
      CREATE TABLE IF NOT EXISTS plans (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT,
        goal TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'planning' CHECK (status IN ('planning', 'running', 'awaiting_approval', 'paused', 'completed', 'failed', 'cancelled', 'recovering')),
        level TEXT NOT NULL DEFAULT 'execution' CHECK (level IN ('strategic', 'project', 'task', 'execution')),
        plan_type TEXT NOT NULL DEFAULT 'execution' CHECK (plan_type IN ('goal', 'project', 'task', 'dependency', 'resource', 'recovery', 'execution', 'milestone')),
        parent_plan_id TEXT,
        parent_step_id TEXT,
        success_criteria TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        FOREIGN KEY (conversation_id) REFERENCES conversations (id) ON DELETE SET NULL,
        FOREIGN KEY (parent_plan_id) REFERENCES plans (id) ON DELETE CASCADE,
        FOREIGN KEY (parent_step_id) REFERENCES plan_steps (id) ON DELETE SET NULL
      );

      CREATE TABLE IF NOT EXISTS plan_steps (
        id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL,
        step_order INTEGER NOT NULL,
        domain TEXT NOT NULL CHECK (domain IN ('coding', 'terminal', 'files', 'browser', 'github', 'planning')),
        description TEXT NOT NULL,
        action TEXT,
        target TEXT,
        details_json TEXT,
        depends_on_step_id TEXT,
        depends_on_step_ids TEXT,
        milestone_id TEXT,
        resource_tag TEXT,
        subtask_of_step_id TEXT,
        is_risky INTEGER NOT NULL DEFAULT 0,
        risk_reason TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'running', 'awaiting_approval', 'done', 'failed', 'skipped', 'blocked')),
        result_json TEXT,
        error_message TEXT,
        retry_count INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER,
        completed_at INTEGER,
        FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
        FOREIGN KEY (depends_on_step_id) REFERENCES plan_steps (id) ON DELETE SET NULL,
        FOREIGN KEY (subtask_of_step_id) REFERENCES plan_steps (id) ON DELETE CASCADE
      );

      -- Milestones are checkpoints along a plan, not steps themselves -
      -- milestonePlanner.js assigns a subset of steps to each milestone
      -- (via plan_steps.milestone_id) so progress can be reported as
      -- "3 of 5 milestones reached" instead of just a step count, which
      -- reads better for long multi-phase goals.
      CREATE TABLE IF NOT EXISTS plan_milestones (
        id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL,
        milestone_order INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'reached', 'missed')),
        target_step_id TEXT,
        reached_at INTEGER,
        FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
        FOREIGN KEY (target_step_id) REFERENCES plan_steps (id) ON DELETE SET NULL
      );

      -- Resource requirements a plan needs before/while it runs - not
      -- files or tools, but preconditions like "GitHub account
      -- connected", "PC backend reachable", "OPENROUTER_API_KEY set".
      -- resourcePlanner.js populates this at plan-creation time;
      -- executionPlanner.js checks it before starting a step so a
      -- missing resource surfaces as a clear blocker instead of a
      -- confusing mid-run tool failure.
      CREATE TABLE IF NOT EXISTS plan_resources (
        id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('credential', 'connection', 'tool', 'permission', 'disk_space', 'other')),
        label TEXT NOT NULL,
        is_available INTEGER,
        checked_at INTEGER,
        details_json TEXT,
        FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
      );

      -- One row per recovery attempt after a step fails -
      -- recoveryPlanner.js's output. Keeps a visible trail of "what
      -- failed, what we tried instead" rather than silently retrying.
      CREATE TABLE IF NOT EXISTS plan_recovery_attempts (
        id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL,
        step_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        strategy TEXT NOT NULL CHECK (strategy IN ('retry', 'retry_with_backoff', 'alternate_approach', 'skip_and_continue', 'ask_person', 'abort_plan')),
        reasoning TEXT,
        outcome TEXT CHECK (outcome IN ('pending', 'succeeded', 'failed', 'abandoned')),
        created_at INTEGER NOT NULL,
        resolved_at INTEGER,
        FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE,
        FOREIGN KEY (step_id) REFERENCES plan_steps (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_plan_steps_plan
        ON plan_steps (plan_id, step_order);

      CREATE INDEX IF NOT EXISTS idx_plans_status
        ON plans (status, updated_at DESC);

      CREATE INDEX IF NOT EXISTS idx_plans_parent
        ON plans (parent_plan_id);

      CREATE INDEX IF NOT EXISTS idx_plan_milestones_plan
        ON plan_milestones (plan_id, milestone_order);

      CREATE INDEX IF NOT EXISTS idx_plan_resources_plan
        ON plan_resources (plan_id);

      -- Checkpoint balancing (src/services/planning/checkpointBalancer.js) -
      -- not a planning TYPE like the 8 above, but a running BALANCE check
      -- across whatever steps have already completed: how much unverified
      -- change has piled up since the last pause. Mirrors an agent that,
      -- after a long unattended run of successful steps, proactively
      -- suggests "let's checkpoint here before going further" rather than
      -- only ever pausing when a single step is individually risky
      -- (that's still riskClassifier.js's job - this is a separate,
      -- cumulative concern). One row per suggestion made, whether the
      -- person acted on it or dismissed it, so the history is visible
      -- (e.g. "3 checkpoints so far" in PlanScreen.js) instead of only
      -- ever showing the most recent one.
      CREATE TABLE IF NOT EXISTS plan_checkpoints (
        id TEXT PRIMARY KEY NOT NULL,
        plan_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        steps_covered INTEGER NOT NULL DEFAULT 0,
        files_covered_json TEXT,
        domains_covered_json TEXT,
        risky_steps_covered INTEGER NOT NULL DEFAULT 0,
        pressure_score REAL NOT NULL DEFAULT 0,
        reason TEXT,
        resolution TEXT NOT NULL DEFAULT 'pending' CHECK (resolution IN ('pending', 'accepted', 'dismissed')),
        resolved_at INTEGER,
        FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_plan_checkpoints_plan
        ON plan_checkpoints (plan_id, created_at DESC);

      -- The four-tier trace model (src/services/planning/, see
      -- README.md's "Planning system" section for the full writeup):
      --   1. Thought process  -> plan_steps.reasoning (this step's WHY,
      --      distinct from its narration)
      --   2. Narration        -> plan_steps.description (the WHAT, shown
      --      as the plain-language line in PlanScreen.js)
      --   3. Step grouping    -> plan_steps themselves, grouped under a
      --      parent plan/task (already existed pre-this-table)
      --   4. Individual tool-call detail -> plan_step_actions (THIS
      --      table) - one row per REAL literal tool invocation attempt
      --      for a step, with the actual input sent and actual output
      --      received. A step that succeeds on the first try has exactly
      --      one row here; a step that failed and got retried by
      --      recoveryPlanner.js has one row per attempt, each
      --      independently inspectable - so "how many times did this
      --      actually run, and what happened each time" is answered by
      --      this table, not just plan_steps.retry_count's bare number.
      -- Every OTHER planning concern added later (deeper reasoning
      -- chains, memory lookups feeding into a step, etc.) should log
      -- itself the same way: a real record of what actually happened,
      -- attached to the step it happened under - not just a narration
      -- string. See README.md for the extension contract.
      -- entry_type distinguishes two kinds of row in this table, both
      -- ordered together by action_order into ONE interleaved chain per
      -- step - a real tool call followed by the reasoning that explains
      -- what happens next, followed by the next real tool call, and so
      -- on (tool_call -> reasoning -> tool_call -> reasoning -> ...).
      -- This is what makes a step's trace a CHAIN rather than a flat
      -- list of independent attempts: a 'reasoning' row sits between two
      -- 'tool_call' rows and explains the link between them (e.g.
      -- recoveryPlanner.js's decision reasoning, logged right before the
      -- retry it justifies actually runs). 'tool_call' rows use
      -- tool_name/label/input_json/output_json/status/started_at/
      -- completed_at as before; 'reasoning' rows use only reasoning_text
      -- and are always immediately 'done' (a thought doesn't have a
      -- running state).
      CREATE TABLE IF NOT EXISTS plan_step_actions (
        id TEXT PRIMARY KEY NOT NULL,
        step_id TEXT NOT NULL,
        plan_id TEXT NOT NULL,
        action_order INTEGER NOT NULL DEFAULT 0,
        entry_type TEXT NOT NULL DEFAULT 'tool_call' CHECK (entry_type IN ('tool_call', 'reasoning')),
        tool_name TEXT,
        label TEXT,
        input_json TEXT,
        output_json TEXT,
        reasoning_text TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
        started_at INTEGER,
        completed_at INTEGER,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (step_id) REFERENCES plan_steps (id) ON DELETE CASCADE,
        FOREIGN KEY (plan_id) REFERENCES plans (id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_plan_step_actions_step
        ON plan_step_actions (step_id, action_order ASC);

      CREATE INDEX IF NOT EXISTS idx_plan_step_actions_plan
        ON plan_step_actions (plan_id);

      CREATE INDEX IF NOT EXISTS idx_plan_recovery_step
        ON plan_recovery_attempts (step_id, attempt_number);
    `);

    // Migration: hierarchical planning columns (level, plan_type,
    // parent_plan_id, parent_step_id, success_criteria on `plans`;
    // depends_on_step_ids, milestone_id, resource_tag, subtask_of_step_id,
    // retry_count on `plan_steps`) were added when the single-level Phase 1
    // plan model grew into the Strategic -> Project -> Task -> Execution
    // hierarchy (see src/services/planning/). Existing Phase 1 rows are
    // untouched by ADD COLUMN and simply default to level='execution',
    // plan_type='execution', parent_plan_id=NULL - i.e. they keep behaving
    // exactly as flat top-level plans, which is what they already were.
    for (const migrationSql of [
      `ALTER TABLE plans ADD COLUMN level TEXT NOT NULL DEFAULT 'execution';`,
      `ALTER TABLE plans ADD COLUMN plan_type TEXT NOT NULL DEFAULT 'execution';`,
      `ALTER TABLE plans ADD COLUMN parent_plan_id TEXT;`,
      `ALTER TABLE plans ADD COLUMN parent_step_id TEXT;`,
      `ALTER TABLE plans ADD COLUMN success_criteria TEXT;`,
      `ALTER TABLE plan_steps ADD COLUMN depends_on_step_ids TEXT;`,
      `ALTER TABLE plan_steps ADD COLUMN milestone_id TEXT;`,
      `ALTER TABLE plan_steps ADD COLUMN resource_tag TEXT;`,
      `ALTER TABLE plan_steps ADD COLUMN subtask_of_step_id TEXT;`,
      `ALTER TABLE plan_steps ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;`,
    ]) {
      try {
        await db.execAsync(migrationSql);
      } catch (migrationErr) {
        // Expected on any install that already has this column - not an error.
      }
    }

    // Migration: checkpoint-balancing columns on `plans` -
    // checkpointBalancer.js's running state. last_checkpoint_at defaults
    // to NULL and is treated as "use created_at" by
    // checkpointBalancer.js's code, so an existing plan with no
    // checkpoint history yet behaves exactly as if it had just started
    // accumulating pressure from its own creation time.
    for (const migrationSql of [
      `ALTER TABLE plans ADD COLUMN last_checkpoint_at INTEGER;`,
      `ALTER TABLE plans ADD COLUMN checkpoint_pending INTEGER NOT NULL DEFAULT 0;`,
      `ALTER TABLE plans ADD COLUMN checkpoint_reason TEXT;`,
    ]) {
      try {
        await db.execAsync(migrationSql);
      } catch (migrationErr) {
        // Expected on any install that already has this column - not an error.
      }
    }

    // Migration: plan_steps.reasoning - the "thought process" tier of the
    // four-tier trace model (see README.md's "Planning system" section
    // and plan_step_actions' comment above). Distinct from `description`
    // (the narration a person reads) - this is the internal WHY, shown
    // collapsed above the narration the same way a reasoning trace
    // precedes what an agent says out loud.
    try {
      await db.execAsync(`ALTER TABLE plan_steps ADD COLUMN reasoning TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: plan_step_actions.entry_type / reasoning_text - upgrades
    // the table from "flat list of tool-call attempts" to "interleaved
    // chain of tool_call and reasoning rows" (see the table's schema
    // comment above). Existing rows created before this migration are
    // all real tool-call attempts, so they default correctly to
    // entry_type='tool_call' with reasoning_text left NULL.
    for (const migrationSql of [
      `ALTER TABLE plan_step_actions ADD COLUMN entry_type TEXT NOT NULL DEFAULT 'tool_call';`,
      `ALTER TABLE plan_step_actions ADD COLUMN reasoning_text TEXT;`,
    ]) {
      try {
        await db.execAsync(migrationSql);
      } catch (migrationErr) {
        // Expected on any install that already has this column - not an error.
      }
    }

    // Migration: theme_preference column was added after the initial schema.
    // ALTER TABLE ADD COLUMN fails if the column already exists, so this is
    // wrapped separately and swallows that specific failure - CREATE TABLE
    // IF NOT EXISTS above won't add columns to an already-existing table on
    // devices upgrading from an earlier version of the app.
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN theme_preference TEXT DEFAULT 'auto';`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: edited_at column was added after the initial schema, to
    // support the long-press "Edit" action on a user's own message (see
    // updateMessage() below). Same swallow-on-already-exists pattern as above.
    try {
      await db.execAsync(`ALTER TABLE messages ADD COLUMN edited_at INTEGER;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: feedback column added to support the inline Like/Dislike
    // buttons under assistant replies (see setMessageFeedback() below).
    // Values: NULL (no feedback), 'like', 'dislike'. A 'dislike' also
    // feeds src/services/memory/feedbackMemory.js's aggregation (see the
    // feedback_patterns table above) - this column is the raw per-message
    // record, feedback_patterns is what's actually read back into prompts.
    try {
      await db.execAsync(`ALTER TABLE messages ADD COLUMN feedback TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: browser_router_url added for the Internet Router feature -
    // stores the Cloudflare Tunnel URL of the user's self-hosted browser-
    // automation backend (see src/services/browserRouter/client.js). The
    // auth token that pairs with this URL is NOT stored here - it lives in
    // the same SecureStore-backed api_keys table as provider keys, under
    // provider name 'browser_router' (see storeApiKey/getApiKey below).
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN browser_router_url TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: browser_access_enabled added for the composer bar's globe
    // toggle - lets the person explicitly turn live internet/browsing
    // access on or off, independent of whether a Browser Router backend
    // happens to be configured. Persisted (not just in-memory) so the
    // toggle "remembers" the last state the person left it in across app
    // restarts, same pattern as every other user_preferences flag. Stored
    // as INTEGER 0/1 (SQLite has no native boolean) and coerced to a JS
    // boolean in getPreferences() below.
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN browser_access_enabled INTEGER DEFAULT 0;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: permission_mode added for Execution/Safety (see
    // src/services/execution/permissionModes.js) - the single source of
    // truth for which of ZAO's five permission modes
    // (default/acceptEdits/plan/auto/bypassPermissions) every tool call
    // gets gated against. Defaults to 'auto' - every create/edit/delete
    // action just runs without a confirmation prompt, on the reasoning
    // that ZAO's own file/git backups (see the backup system this
    // depends on) make an unwanted change cheap to undo, so gating on
    // approval up front isn't worth the friction. Explicit product
    // decision, not the cautious default you'd normally pick for a new
    // column - if that backup coverage ever changes, revisit this.
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN permission_mode TEXT DEFAULT 'auto';`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: flip any existing row still sitting on the OLD default
    // ('default', i.e. confirm-before-risky-things) over to 'auto', so
    // installs that already had this column before the change above
    // don't keep the old prompting behavior forever. A person who
    // deliberately chose 'default' again after this update runs would
    // re-set it themselves; this only catches rows that never got an
    // explicit choice.
    try {
      await db.execAsync(`UPDATE user_preferences SET permission_mode = 'auto' WHERE permission_mode = 'default';`);
    } catch (migrationErr) {
      // Non-fatal - worst case an existing install keeps asking for approval until manually switched in Settings.
    }

    // Migration: otel_export_endpoint added so telemetry.js (see that
    // file's header) can optionally forward spans to a real OTLP/HTTP
    // collector the person points it at. Null means "local-only", the
    // default - nothing ever leaves the device unless this is set.
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN otel_export_endpoint TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // ---------- Execution / Safety tables ----------
    // See src/services/execution/ for the modules that read/write these -
    // persistence for: permission modes (column above, no table needed),
    // checkpoints, hooks, subagents (no persistence needed - see
    // subagentManager.js header), telemetry, and worktree sessions.

    // Edit checkpoints - one row per file-mutating tool call
    // (fs_create_file/fs_edit_file/fs_delete/fs_rename/fs_move), captured
    // BEFORE the mutation happens, independent of git (works with or
    // without a .git repo present - most ZAO filesystem-tool use has
    // neither). previous_content_b64 is NULL for a brand-new file
    // (nothing existed before - rewinding just deletes it); for every
    // other operation it's the exact prior byte content, base64-encoded
    // the same way renameEntry/moveEntry already read binary content
    // elsewhere in this file, so images/zips/APKs checkpoint safely too.
    await db.execAsync(`
      CREATE TABLE IF NOT EXISTS edit_checkpoints (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT,
        path TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('create', 'edit', 'delete', 'rename', 'move')),
        previous_content_b64 TEXT,
        previous_path TEXT,
        existed_before INTEGER NOT NULL DEFAULT 1,
        rewound INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_edit_checkpoints_path
        ON edit_checkpoints (path, created_at DESC);

      CREATE INDEX IF NOT EXISTS idx_edit_checkpoints_created
        ON edit_checkpoints (created_at DESC);

      -- Folder checkpoints - one BATCH per destructive/overwriting
      -- folder-level operation (fs_delete on a directory,
      -- fs_replace_folder), independent of edit_checkpoints (which is
      -- strictly per-file). folder_checkpoints is the batch header;
      -- folder_checkpoint_entries has one row per file that existed
      -- under root_path at snapshot time, each with its own base64
      -- content, so the whole folder can be restored atomically -
      -- "delete this folder and go back to how it looked before" -
      -- rather than one file at a time.
      CREATE TABLE IF NOT EXISTS folder_checkpoints (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT,
        root_path TEXT NOT NULL,
        operation TEXT NOT NULL CHECK (operation IN ('delete', 'replace')),
        file_count INTEGER NOT NULL DEFAULT 0,
        rewound INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_folder_checkpoints_created
        ON folder_checkpoints (created_at DESC);

      CREATE TABLE IF NOT EXISTS folder_checkpoint_entries (
        id TEXT PRIMARY KEY NOT NULL,
        batch_id TEXT NOT NULL,
        relative_path TEXT NOT NULL,
        content_b64 TEXT,
        is_dir INTEGER NOT NULL DEFAULT 0,
        FOREIGN KEY (batch_id) REFERENCES folder_checkpoints(id)
      );

      CREATE INDEX IF NOT EXISTS idx_folder_checkpoint_entries_batch
        ON folder_checkpoint_entries (batch_id);

      -- Hooks - lifecycle interception, matching Claude Code's
      -- PreToolUse/PostToolUse/SessionStart shape. 'command' is a real
      -- shell command run through the terminal tool ZAO already has
      -- (pcTerminalTool.js) - no new execution surface,
      -- just a new trigger for the existing one. matcher is a tool-name
      -- pattern ('*' = every tool, 'fs_*' = every filesystem tool, or an
      -- exact name) that hooksEngine.js tests against the tool actually
      -- being called. \`backend\` is kept (rather than dropped) because
      -- SQLite can't drop a CHECK constraint via ALTER TABLE - existing
      -- installs get their legacy 'termux' rows normalized to 'pc' by a
      -- data migration below (see MIGRATIONS), and every new hook is
      -- created with 'pc' from here on.
      CREATE TABLE IF NOT EXISTS hooks (
        id TEXT PRIMARY KEY NOT NULL,
        event TEXT NOT NULL CHECK (event IN ('SessionStart', 'PreToolUse', 'PostToolUse')),
        matcher TEXT NOT NULL DEFAULT '*',
        command TEXT NOT NULL,
        backend TEXT NOT NULL DEFAULT 'pc' CHECK (backend IN ('termux', 'pc')),
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_hooks_event
        ON hooks (event, enabled);

      -- Agent actions - the audit/logging trail SYSTEM_COMPONENTS.md
      -- flagged as ZAO's one fully-missing piece. Deliberately a superset
      -- of usage_log (which stays for the lightweight Settings > Usage
      -- dashboard counts) - this is the queryable, per-call record with
      -- real span timing that telemetry.js (OpenTelemetry-shaped:
      -- trace_id/span_id/status) reads and writes. session_id groups
      -- every action from one runToolTask()/runExecutionPlan() call
      -- together, and parent_span_id lets a subagent's actions nest
      -- visibly under the tool call that spawned it (see
      -- subagentManager.js).
      CREATE TABLE IF NOT EXISTS agent_actions (
        id TEXT PRIMARY KEY NOT NULL,
        trace_id TEXT NOT NULL,
        span_id TEXT NOT NULL,
        parent_span_id TEXT,
        session_id TEXT,
        conversation_id TEXT,
        name TEXT NOT NULL,
        tool_name TEXT,
        attributes_json TEXT,
        status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'ok', 'error', 'blocked')),
        error_message TEXT,
        started_at INTEGER NOT NULL,
        ended_at INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_agent_actions_trace
        ON agent_actions (trace_id, started_at);

      CREATE INDEX IF NOT EXISTS idx_agent_actions_session
        ON agent_actions (session_id, started_at DESC);

      -- Worktree sessions - ZAO's analog of Claude Code worktrees. Pairs a
      -- real 'git worktree' checkout (when the PC terminal backend is
      -- reachable) or a plain GitHub branch (phone-only) with its OWN
      -- forked conversation (forkConversation(), already existed
      -- pre-this-feature) so each parallel branch of work gets an
      -- isolated chat context too, not just an isolated directory.
      CREATE TABLE IF NOT EXISTS worktree_sessions (
        id TEXT PRIMARY KEY NOT NULL,
        conversation_id TEXT NOT NULL,
        source_conversation_id TEXT,
        owner TEXT,
        repo TEXT,
        branch TEXT NOT NULL,
        base_branch TEXT,
        local_path TEXT,
        backend TEXT NOT NULL DEFAULT 'github' CHECK (backend IN ('github', 'pc_git_worktree')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'merged', 'removed')),
        created_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_worktree_sessions_status
        ON worktree_sessions (status, created_at DESC);
    `);

    // Migration: ZAO's on-device Termux terminal was removed entirely -
    // pcTerminalTool.js (routed through the person's PC backend) is now
    // the only terminal ZAO has. hooks.backend can't have 'termux'
    // dropped from its CHECK constraint (SQLite has no ALTER TABLE ...
    // DROP CONSTRAINT), so instead this just normalizes any hook rows an
    // existing install already created with backend='termux' over to
    // 'pc' - hooksEngine.js only knows how to run hooks through
    // pcTerminalTool.js now, so a stale 'termux' row would otherwise
    // silently never run.
    try {
      await db.execAsync(`UPDATE hooks SET backend = 'pc' WHERE backend = 'termux';`);
    } catch (migrationErr) {
      // Expected on a fresh install with no hooks table rows yet - not an error.
    }

    // Migration: github_username added for the GitHub tool (the local
    // coder model's repo/commit/push/PR/release plugin - see
    // src/services/github/githubTool.js). The Personal Access Token itself
    // goes through the same secure api_keys/SecureStore mechanism
    // (provider: 'github'), but the username isn't a secret - it's needed
    // alongside the token for every API call (owner/repo paths), so it's
    // just a normal preference rather than adding a whole extra column to
    // the api_keys table for one provider's non-secret metadata.
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN github_username TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: filesystem_saf_uri added for the Filesystem tool (Qwen3
    // Coder's create/move/rename/delete/zip/extract plugin - see
    // src/services/filesystem/filesystemTool.js). Modern Android (10+)
    // blocks apps from touching arbitrary paths under
    // /storage/emulated/0/ via plain file paths (Scoped Storage) - the
    // only working mechanism is the Storage Access Framework, where the
    // person grants access to a folder ONCE through a system picker, and
    // the app is handed back a persistent content:// URI it can use going
    // forward. This column stores that URI so the grant only needs to
    // happen once ever, not every app launch.
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN filesystem_saf_uri TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: memory_enabled added for the long-term Memory feature (see
    // src/services/memory/memoryEngine.js and the `memories` table above).
    // Defaults to 1 (on) - memory is opt-out, not opt-in, matching how
    // Claude/ChatGPT ship it, but the person can flip it off entirely in
    // Settings > Memory, which stops both context injection and new
    // extraction without deleting memories already stored.
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN memory_enabled INTEGER DEFAULT 1;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: local_image_path added to support inline image bubbles in
    // chat. Originally used for both user-attached photos AND
    // FLUX-generated images (see chatStore.js's copyAttachmentLocally);
    // FLUX/image generation has since been removed entirely (Hugging
    // Face-only, no replacement) so this column is now used only for
    // user-attached photos. Stores a local file:// URI under the app's
    // document directory - the actual bytes never touch SQLite itself.
    // NULL for every normal text message.
    try {
      await db.execAsync(`ALTER TABLE messages ADD COLUMN local_image_path TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: backend connection settings, added when the backend moved
    // from on-device Termux to running on the person's PC (see
    // src/services/backend/backendClient.js and server/ in the repo root).
    // Unlike the old Termux setup there's no single fixed loopback address
    // that always works, so the person needs to configure how the phone
    // reaches the PC:
    //   - backend_mode: 'lan' or 'remote' - manual toggle (Settings), not
    //     auto-detected, since LAN vs the Cloudflare Quick Tunnel need
    //     different URLs and there's no reliable way to guess which
    //     network the phone is currently on.
    //   - backend_lan_url: PC's local IP:port, e.g. http://192.168.1.42:8080
    //     - stable as long as the PC's LAN IP doesn't change.
    //   - backend_remote_url: the Cloudflare Quick Tunnel URL. This ROTATES
    //     every time start.bat is re-run on the PC (it's a free
    //     *.trycloudflare.com URL, not a permanent named tunnel - that
    //     would require owning a domain), so the person has to paste a
    //     fresh value in here each time before using Remote mode.
    //   - backend_auth_token: shared secret sent as `Authorization: Bearer
    //     <token>` on every request. Required because the PC backend is
    //     bound to 0.0.0.0 and reachable over LAN and the public tunnel,
    //     not just 127.0.0.1 like the old Termux version - must match
    //     AUTH_TOKEN in the PC's server/config.js exactly.
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN backend_mode TEXT DEFAULT 'lan';`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN backend_lan_url TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN backend_remote_url TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN backend_auth_token TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: plan_id added to messages so an assistant reply that was
    // produced by the hierarchical planning system (src/services/brain/
    // backendBrain.js -> planCoordinator.js/planExecutor.js, wired in via
    // src/utils/orchestrator.js) can be linked back to the plan it came
    // from. NULL for every ordinary chat/tool-orchestrator reply - this is
    // only set on the one assistant message that announces "I've broken
    // this into a plan…", so ChatScreen.js can render a "View Plan" chip
    // on that specific bubble that opens PlanScreen.js at this id. Not a
    // foreign key (ON DELETE CASCADE would silently blank out chat history
    // if a plan is ever pruned) - just an informational pointer.
    try {
      await db.execAsync(`ALTER TABLE messages ADD COLUMN plan_id TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: reasoning_type / reasoning_trace added to messages so an
    // assistant reply can carry which reasoning strategy produced it (see
    // src/services/reasoning/reasoningTypes.js's taxonomy -
    // chain_of_thought, tree_of_thought, react, self_reflection,
    // deductive, inductive, abductive, analogical, hybrid_symbolic_plan)
    // and, where applicable, the actual trace (branches considered,
    // critique, etc.) behind it. reasoning_trace is stored as a JSON
    // string, same convention as details_json on plan_steps - parsed only
    // where displayed (ChatScreen.js's reasoning chip), never queried
    // into. Both NULL for messages sent before this migration.
    try {
      await db.execAsync(`ALTER TABLE messages ADD COLUMN reasoning_type TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }
    try {
      await db.execAsync(`ALTER TABLE messages ADD COLUMN reasoning_trace TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: clock_data column added to support a live ClockWidget
    // (src/components/ClockWidget.js) on replies where the model called
    // time_get_current (src/services/toolOrchestrator.js /
    // src/services/time/timeTool.js) - JSON text like
    // {"timezone":"Asia/Tokyo","label":"Tokyo"} ("timezone": null means
    // device local time), NULL for every ordinary reply. Same
    // swallow-on-already-exists pattern as the migrations above.
    try {
      await db.execAsync(`ALTER TABLE messages ADD COLUMN clock_data TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: pending_confirmation added to messages so a reply where
    // the flat tool loop (src/services/toolOrchestrator.js) refused a
    // terminal command specifically because it needs human confirmation
    // (commandSafety.js's RISKY tier, gated via
    // src/services/execution/permissionModes.js) can carry that refusal
    // as structured data, not just a sentence buried in the reply text.
    // JSON text like {"toolName":"terminal_pc_run_command","args":{"command":"..."},"reason":"..."}
    // - NULL for every ordinary reply, and cleared back to NULL (see
    // clearPendingConfirmation below) once the person approves or
    // dismisses the card ChatScreen.js renders for it. Same
    // swallow-on-already-exists pattern as every migration above.
    try {
      await db.execAsync(`ALTER TABLE messages ADD COLUMN pending_confirmation TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: rolling_summary / rolling_summary_covers_at added for
    // working-memory context-window compaction (see
    // src/services/memory/workingMemory.js). A long conversation can't
    // just be sent in full to a small on-device/PC-served model forever -
    // rolling_summary holds a running plain-text summary of everything
    // BEFORE rolling_summary_covers_at (a message created_at timestamp);
    // only messages AFTER that boundary are still sent to the model
    // verbatim. Both are NULL until a conversation first crosses the
    // history budget - short conversations never touch this at all.
    try {
      await db.execAsync(`ALTER TABLE conversations ADD COLUMN rolling_summary TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }
    try {
      await db.execAsync(`ALTER TABLE conversations ADD COLUMN rolling_summary_covers_at INTEGER;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: project_instructions (src/services/memory/projectInstructions.js,
    // ZAO's CLAUDE.md equivalent - person-authored standing instructions
    // loaded into every conversation) and auto_memory_notes
    // (src/services/memory/autoMemoryNotes.js, ZAO's MEMORY.md equivalent -
    // short agent-written operational learnings, capped and loaded the
    // same way). Both single-row columns on user_preferences, same
    // reasoning as rolling_summary above: added post-launch, so ALTER
    // rather than a fresh CREATE TABLE column list.
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN project_instructions TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN auto_memory_notes TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Ensure a default preferences row exists
    await db.runAsync(
      `INSERT OR IGNORE INTO user_preferences (id, ai_mode, theme_preference, updated_at) VALUES (1, 'auto', 'auto', ?)`,
      [Date.now()]
    );

    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] initDatabase failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_DB_INIT_ERROR' };
  }
}

// ---------- Conversations ----------

export async function createConversation(id, title = 'New Conversation') {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };

    const now = Date.now();
    await db.runAsync(
      `INSERT INTO conversations (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)`,
      [id, title, now, now]
    );
    return { success: true, data: { id, title, created_at: now, updated_at: now }, error: null };
  } catch (err) {
    console.error('[DB] createConversation failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

export async function getConversations(limit = 50) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };

    const rows = await db.getAllAsync(
      `SELECT * FROM conversations ORDER BY updated_at DESC LIMIT ?`,
      [limit]
    );
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getConversations failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

export async function updateConversationMeta(id, { title, last_provider, last_model }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };

    const fields = [];
    const values = [];
    if (title !== undefined) { fields.push('title = ?'); values.push(title); }
    if (last_provider !== undefined) { fields.push('last_provider = ?'); values.push(last_provider); }
    if (last_model !== undefined) { fields.push('last_model = ?'); values.push(last_model); }
    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    await db.runAsync(
      `UPDATE conversations SET ${fields.join(', ')} WHERE id = ?`,
      values
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] updateConversationMeta failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function deleteConversation(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };

    await db.runAsync(`DELETE FROM messages WHERE conversation_id = ?`, [id]);
    await db.runAsync(`DELETE FROM conversations WHERE id = ?`, [id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] deleteConversation failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/**
 * Forks a conversation into a brand-new one that starts from an
 * independent copy of the source's context - Claude Code's session
 * fork/resume, where a new session gets its own copy of context rather
 * than sharing live state with the session it branched from. Useful
 * for "try a risky next step without touching the conversation I
 * already have", or resuming a long conversation as a fresh session
 * once its rolling_summary has absorbed everything before the branch
 * point, so the new session starts lighter than a full transcript copy.
 *
 * Copies the rolling_summary (see workingMemory.js) forward as-is, and
 * copies messages either in full or only those at/before
 * `upToCreatedAt` (so "fork from this point" and "fork from the very
 * start" are both one call). Does NOT copy plan_id/reasoning_trace
 * linkage on messages that pointed at a plan row - those stay owned by
 * the source conversation's plan, since a forked message referencing a
 * plan that only the original conversation has permission to mutate
 * would be misleading.
 *
 * @param {string} sourceId
 * @param {string} newId
 * @param {object} [options]
 * @param {string} [options.title] - defaults to "<source title> (fork)"
 * @param {number} [options.upToCreatedAt] - only copy messages with
 *   created_at <= this value; omit to copy every message.
 * @returns {Promise<{ success: boolean, data: { id: string } | null, error: string|null }>}
 */
export async function forkConversation(sourceId, newId, { title, upToCreatedAt } = {}) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };

    const source = await db.getFirstAsync(`SELECT * FROM conversations WHERE id = ?`, [sourceId]);
    if (!source) return { success: false, error: 'SOURCE_NOT_FOUND', data: null };

    const now = Date.now();
    const forkTitle = title || `${source.title || 'Conversation'} (fork)`;

    await db.runAsync(
      `INSERT INTO conversations (id, title, created_at, updated_at, rolling_summary, rolling_summary_covers_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [newId, forkTitle, now, now, source.rolling_summary || null, source.rolling_summary_covers_at || null]
    );

    const messages = upToCreatedAt
      ? await db.getAllAsync(`SELECT * FROM messages WHERE conversation_id = ? AND created_at <= ? ORDER BY created_at ASC`, [sourceId, upToCreatedAt])
      : await db.getAllAsync(`SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC`, [sourceId]);

    for (const m of messages) {
      await db.runAsync(
        `INSERT INTO messages
          (id, conversation_id, role, content, provider, model, model_family, token_count, created_at, is_error, local_image_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [`${newId}_${m.id}`, newId, m.role, m.content, m.provider, m.model, m.model_family, m.token_count, m.created_at, m.is_error, m.local_image_path]
      );
    }

    return { success: true, data: { id: newId }, error: null };
  } catch (err) {
    console.error('[DB] forkConversation failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

// ---------- Messages ----------

export async function addMessage(message) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };

    const {
      id, conversation_id, role, content,
      provider = null, model = null, model_family = null,
      token_count = 0, is_error = false,
      local_image_path = null,
      plan_id = null,
      reasoning_type = null,
      reasoning_trace = null,
      clock_data = null,
      pending_confirmation = null,
    } = message;
    const now = Date.now();
    // reasoning_trace can arrive as an object (chainOfThought.js's plain
    // string trace, or treeOfThought.js's {branches, critiques, ...}
    // object) - stored as JSON text either way, same as plan_steps'
    // details_json, so SQLite never has to deal with a nested value.
    const reasoning_trace_json = reasoning_trace != null
      ? (typeof reasoning_trace === 'string' ? reasoning_trace : JSON.stringify(reasoning_trace))
      : null;
    // pending_confirmation arrives as a plain object from
    // buildAssistantMessageFromResult (chatStore.js) - stored as JSON
    // text, same convention as reasoning_trace/clock_data above.
    const pending_confirmation_json = pending_confirmation != null
      ? (typeof pending_confirmation === 'string' ? pending_confirmation : JSON.stringify(pending_confirmation))
      : null;

    await db.runAsync(
      `INSERT INTO messages
        (id, conversation_id, role, content, provider, model, model_family, token_count, created_at, is_error, local_image_path, plan_id, reasoning_type, reasoning_trace, clock_data, pending_confirmation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, conversation_id, role, content, provider, model, model_family, token_count, now, is_error ? 1 : 0, local_image_path, plan_id, reasoning_type, reasoning_trace_json, clock_data, pending_confirmation_json]
    );

    await db.runAsync(
      `UPDATE conversations SET updated_at = ? WHERE id = ?`,
      [now, conversation_id]
    );

    return { success: true, data: { ...message, created_at: now }, error: null };
  } catch (err) {
    console.error('[DB] addMessage failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/**
 * Updates an existing message's content in place (used by the long-press
 * "Edit" action on a user's own message - see MessageActionMenu.js /
 * chatStore.editMessage). Stamps edited_at so the UI can show an "Edited"
 * label; does NOT touch role/provider/model fields, and does not re-run
 * the AI response - that's the caller's job if it wants a fresh reply.
 */
export async function updateMessage(id, content) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };

    const now = Date.now();
    await db.runAsync(
      `UPDATE messages SET content = ?, edited_at = ? WHERE id = ?`,
      [content, now, id]
    );

    return { success: true, data: { id, content, edited_at: now }, error: null };
  } catch (err) {
    console.error('[DB] updateMessage failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/**
 * Clears messages.pending_confirmation back to NULL - called once the
 * person taps Approve or Dismiss on the confirmation card ChatScreen.js
 * renders for a message carrying one (see the pending_confirmation
 * migration comment above), so the card doesn't linger or re-trigger on
 * a later render of the same message.
 */
export async function clearPendingConfirmation(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`UPDATE messages SET pending_confirmation = NULL WHERE id = ?`, [id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] clearPendingConfirmation failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/**
 * Deletes every message in a conversation created strictly after
 * `afterCreatedAt` (a created_at timestamp), excluding the message that
 * timestamp belongs to. Used by chatStore.editMessage() to truncate the
 * conversation when an earlier user message is edited and
 * resent - everything downstream of the edit is discarded before the AI
 * is asked to respond again, and by chatStore.regenerateMessage() to drop
 * a stale assistant reply (and anything after it) before generating a
 * fresh one.
 */
export async function deleteMessagesAfter(conversationId, afterCreatedAt) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `DELETE FROM messages WHERE conversation_id = ? AND created_at > ?`,
      [conversationId, afterCreatedAt]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] deleteMessagesAfter failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/**
 * Deletes a single message by id. Used to remove a stale assistant reply
 * before regenerating it (regenerateMessage() re-creates a new row rather
 * than reusing the old id, since provider/model/timing all change).
 */
export async function deleteMessage(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`DELETE FROM messages WHERE id = ?`, [id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] deleteMessage failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/**
 * Sets (or clears) like/dislike feedback on an assistant message. Passing
 * null clears it (used when tapping an already-active like/dislike button
 * again to toggle it off).
 */
export async function setMessageFeedback(id, feedback) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };
    await db.runAsync(`UPDATE messages SET feedback = ? WHERE id = ?`, [feedback, id]);
    return { success: true, data: { id, feedback }, error: null };
  } catch (err) {
    console.error('[DB] setMessageFeedback failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/**
 * Cheap aggregate counts of raw per-message feedback - {like, dislike}.
 * Not used to build prompt guidance (see feedback_patterns below for
 * that); this is for a future Settings display ("12 likes, 3 dislikes")
 * and for feedbackMemory.js's cap-enforcement logging.
 */
export async function getFeedbackStats() {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: { like: 0, dislike: 0 } };
    const rows = await db.getAllAsync(
      `SELECT feedback, COUNT(*) as count FROM messages WHERE feedback IS NOT NULL GROUP BY feedback`
    );
    const data = { like: 0, dislike: 0 };
    for (const row of rows) {
      if (row.feedback === 'like' || row.feedback === 'dislike') data[row.feedback] = row.count;
    }
    return { success: true, data, error: null };
  } catch (err) {
    console.error('[DB] getFeedbackStats failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: { like: 0, dislike: 0 } };
  }
}

/**
 * See feedback_patterns table comment above the schema for the shape.
 * All CRUD here mirrors addProcedure/getAllProcedures/bumpProcedureUsage/
 * deleteProcedure below - same aggregate-and-rank-by-recency-and-count
 * shape, just for "avoid this" guidance distilled from dislikes instead
 * of "do this" recipes distilled from successful plans.
 */
export async function addFeedbackPattern({ id, patternSignature, description, exampleSnippet = null, sourceMessageId = null }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO feedback_patterns (id, pattern_signature, description, example_snippet, source_message_id, occurrence_count, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, patternSignature, description, exampleSnippet, sourceMessageId, now, now]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] addFeedbackPattern failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getAllFeedbackPatterns(limit = 300) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(
      `SELECT * FROM feedback_patterns ORDER BY occurrence_count DESC, last_seen_at DESC LIMIT ?`,
      [limit]
    );
    return { success: true, data: rows, error: null };
  } catch (err) {
    console.error('[DB] getAllFeedbackPatterns failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

/** Reinforces an existing pattern (another dislike matched it) rather than inserting a near-duplicate row. */
export async function bumpFeedbackPattern(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `UPDATE feedback_patterns SET occurrence_count = occurrence_count + 1, last_seen_at = ? WHERE id = ?`,
      [Date.now(), id]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] bumpFeedbackPattern failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/** Permanently removes a learned feedback pattern - not currently exposed in any Settings UI, kept for parity with deleteProcedure/hardDeleteMemory and for a future "Settings > Feedback patterns" screen. */
export async function deleteFeedbackPattern(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`DELETE FROM feedback_patterns WHERE id = ?`, [id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] deleteFeedbackPattern failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getMessages(conversationId, limit = 200) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };

    const rows = await db.getAllAsync(
      `SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT ?`,
      [conversationId, limit]
    );
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getMessages failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

// ---------- Model Health ----------

export async function upsertModelHealth(modelKey, patch) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };

    const existing = await db.getFirstAsync(
      `SELECT * FROM model_health WHERE model_key = ?`,
      [modelKey]
    );

    if (!existing) {
      await db.runAsync(
        `INSERT INTO model_health
          (model_key, provider, model_id, status, avg_response_ms, success_count, failure_count, consecutive_failures, quota_remaining, last_checked_at, last_success_at, cooldown_until)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          modelKey,
          patch.provider || 'unknown',
          patch.model_id || modelKey,
          patch.status || 'unknown',
          patch.avg_response_ms || 0,
          patch.success_count || 0,
          patch.failure_count || 0,
          patch.consecutive_failures || 0,
          patch.quota_remaining ?? null,
          patch.last_checked_at || Date.now(),
          patch.last_success_at || null,
          patch.cooldown_until || 0,
        ]
      );
    } else {
      const merged = { ...existing, ...patch };
      await db.runAsync(
        `UPDATE model_health SET
          provider = ?, model_id = ?, status = ?, avg_response_ms = ?,
          success_count = ?, failure_count = ?, consecutive_failures = ?,
          quota_remaining = ?, last_checked_at = ?, last_success_at = ?, cooldown_until = ?
         WHERE model_key = ?`,
        [
          merged.provider, merged.model_id, merged.status, merged.avg_response_ms,
          merged.success_count, merged.failure_count, merged.consecutive_failures,
          merged.quota_remaining ?? null, merged.last_checked_at, merged.last_success_at,
          merged.cooldown_until, modelKey,
        ]
      );
    }
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] upsertModelHealth failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getAllModelHealth() {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM model_health`);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getAllModelHealth failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

// ---------- Usage Log (Settings > Usage / Developer Mode) ----------

/**
 * Records one usage event - called from the tool orchestrator and
 * orchestrator.js after every tool call / model call completes. Never
 * throws or blocks the calling code on failure (logging usage should
 * never be able to break an actual task) - failures are swallowed after
 * a console.error, same as recordCallResult in healthMonitor.js.
 *
 * @param {string} eventType - short category, e.g. 'github_push', 'file_created', 'file_deleted', 'browser_session'
 * @param {string} [detail] - short human-readable label, e.g. "Pushed to segz7448/ZAO"
 * @param {object} [metadata] - anything category-specific (cost, step count, key source)
 */
export async function logUsageEvent(eventType, detail = null, metadata = null) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `INSERT INTO usage_log (event_type, detail, metadata, created_at) VALUES (?, ?, ?, ?)`,
      [eventType, detail, metadata ? JSON.stringify(metadata) : null, Date.now()]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] logUsageEvent failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/**
 * Returns event counts grouped by type, optionally within a date range -
 * this is what the Usage dashboard's summary cards (Images Generated: 27,
 * GitHub Pushes: 8, etc.) actually read from.
 */
export async function getUsageCounts(sinceTimestamp = 0) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: {} };
    const rows = await db.getAllAsync(
      `SELECT event_type, COUNT(*) as count FROM usage_log WHERE created_at >= ? GROUP BY event_type`,
      [sinceTimestamp]
    );
    const counts = {};
    for (const row of rows || []) counts[row.event_type] = row.count;
    return { success: true, data: counts, error: null };
  } catch (err) {
    console.error('[DB] getUsageCounts failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: {} };
  }
}

/**
 * Returns the most recent N usage events in full (not just counts) - for
 * Developer Mode's step-by-step trace of what the last task actually did.
 */
export async function getRecentUsageEvents(limit = 20) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM usage_log ORDER BY created_at DESC LIMIT ?`, [limit]);
    return {
      success: true,
      data: (rows || []).map((r) => ({ ...r, metadata: r.metadata ? JSON.parse(r.metadata) : null })),
      error: null,
    };
  } catch (err) {
    console.error('[DB] getRecentUsageEvents failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

// ---------- User Preferences ----------

const DEFAULT_PREFS_ROW = {
  theme_preference: 'auto',
  browser_access_enabled: false,
  github_username: null,
  filesystem_saf_uri: null,
  memory_enabled: true,
  backend_mode: 'lan',
  backend_lan_url: null,
  backend_remote_url: null,
  backend_auth_token: null,
  permission_mode: 'auto',
  otel_export_endpoint: null,
};

export async function getPreferences() {
  try {
    const db = await getDb();
    if (!db) {
      return { success: false, error: 'DB_OPEN_FAILED', data: DEFAULT_PREFS_ROW };
    }
    const row = await db.getFirstAsync(`SELECT * FROM user_preferences WHERE id = 1`);
    // SQLite has no native boolean - browser_access_enabled/memory_enabled
    // come back as 0/1. Coerce to real JS booleans here so every consumer
    // (store, ChatScreen, orchestrator, memoryEngine) can just check
    // `preferences.memory_enabled` without re-deriving truthiness each time.
    const data = row
      ? { ...row, browser_access_enabled: !!row.browser_access_enabled, memory_enabled: !!row.memory_enabled }
      : DEFAULT_PREFS_ROW;
    return {
      success: true,
      data,
      error: null,
    };
  } catch (err) {
    console.error('[DB] getPreferences failed:', err);
    return {
      success: false,
      error: err?.message || 'UNKNOWN_ERROR',
      data: DEFAULT_PREFS_ROW,
    };
  }
}

export async function updatePreferences(patch) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };

    const fields = [];
    const values = [];
    for (const key of ['theme_preference', 'browser_access_enabled', 'github_username', 'filesystem_saf_uri', 'memory_enabled', 'project_instructions', 'auto_memory_notes', 'permission_mode', 'otel_export_endpoint', 'backend_mode', 'backend_lan_url', 'backend_remote_url', 'backend_auth_token']) {
      if (patch[key] !== undefined) {
        // SQLite has no native boolean column type - store true/false as 1/0.
        const value = (key === 'browser_access_enabled' || key === 'memory_enabled') ? (patch[key] ? 1 : 0) : patch[key];
        fields.push(`${key} = ?`);
        values.push(value);
      }
    }
    if (fields.length === 0) return { success: true, error: null };

    fields.push('updated_at = ?');
    values.push(Date.now());

    await db.runAsync(
      `UPDATE user_preferences SET ${fields.join(', ')} WHERE id = 1`,
      values
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] updatePreferences failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ---------- API Keys (user-provided) ----------
// Chat/coding/reasoning run through the single PC-hosted backend (see
// src/services/backend/backendClient.js) - no API key at all. This table
// is now only used for the one remaining credential: the GitHub Personal
// Access Token (provider: 'github', see src/services/github/githubTool.js).
//
// SECURITY: the actual key VALUE is stored in expo-secure-store, which uses
// Android Keystore (hardware-backed encryption on most devices) rather than
// plain SQLite. The api_keys table below only stores non-sensitive metadata
// (which provider has a key, whether it's user-provided, when it changed) -
// never the key itself. This split lets Settings/status UI keep reading from
// SQLite as before (fast, synchronous-feeling) while the sensitive value
// lives in secure storage.
//
// SecureStore keys can't contain most special characters, so we prefix with
// a fixed namespace and use the provider name directly (already alphanumeric).

function secureKeyName(provider) {
  return `zao_apikey_${provider}`;
}

export async function storeApiKey(provider, keyValue, isUserProvided = true) {
  try {
    // Write the actual secret to secure storage first. If this fails, we
    // deliberately don't touch the metadata table, so status displays never
    // claim a key is configured when it isn't actually stored anywhere.
    await SecureStore.setItemAsync(secureKeyName(provider), keyValue);

    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `INSERT INTO api_keys (provider, key_value, is_user_provided, updated_at)
       VALUES (?, NULL, ?, ?)
       ON CONFLICT(provider) DO UPDATE SET key_value = NULL,
         is_user_provided = excluded.is_user_provided, updated_at = excluded.updated_at`,
      [provider, isUserProvided ? 1 : 0, Date.now()]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] storeApiKey failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getApiKey(provider) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };
    const row = await db.getFirstAsync(`SELECT * FROM api_keys WHERE provider = ?`, [provider]);
    if (!row) return { success: true, data: null, error: null };

    // Metadata row exists - fetch the actual secret from secure storage.
    let keyValue = null;
    try {
      keyValue = await SecureStore.getItemAsync(secureKeyName(provider));
    } catch (secureErr) {
      console.error('[DB] SecureStore read failed for', provider, secureErr);
      // Fall through with keyValue = null rather than throwing - a metadata
      // row with no retrievable secret should look like "not configured"
      // to callers, not crash the app.
    }

    return { success: true, data: { ...row, key_value: keyValue }, error: null };
  } catch (err) {
    console.error('[DB] getApiKey failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

export async function deleteApiKey(provider) {
  try {
    // Remove the secret first, then the metadata row. If secure delete
    // fails, we still remove the metadata row so the UI doesn't show a
    // "configured" state pointing at a value we couldn't clear - but we
    // surface the secure-store failure so it's not silently swallowed.
    let secureError = null;
    try {
      await SecureStore.deleteItemAsync(secureKeyName(provider));
    } catch (err) {
      secureError = err?.message || 'SECURE_DELETE_FAILED';
      console.error('[DB] SecureStore delete failed for', provider, err);
    }

    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`DELETE FROM api_keys WHERE provider = ?`, [provider]);

    return { success: true, error: secureError };
  } catch (err) {
    console.error('[DB] deleteApiKey failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ============================================================================
// LONG-TERM MEMORY (Settings > Memory) - see the `memories` table comment in
// initDatabase() above for the full design rationale. This is the local,
// on-device equivalent of "memory" in Claude/ChatGPT: durable facts about
// the person, persisted here, re-injected into every new conversation by
// src/services/memory/memoryEngine.js (buildMemoryContextBlock). Nothing in
// this file talks to any LLM or network - it's a pure SQLite CRUD layer,
// same as every other table in this file.
// ============================================================================

/**
 * Inserts a brand-new memory. Callers (memoryEngine.js) are expected to have
 * already decided this is worth storing - this function does no dedup/merge
 * logic itself, it just writes the row. Use upsertMemoryByContent below if
 * you want "add or refresh timestamp" semantics instead.
 */
export async function addMemory({ id, content, category = 'general', sourceConversationId = null }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO memories (id, content, category, source_conversation_id, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, ?)`,
      [id, content, category, sourceConversationId, now, now]
    );
    return { success: true, data: { id, content, category, source_conversation_id: sourceConversationId, is_active: 1, created_at: now, updated_at: now }, error: null };
  } catch (err) {
    console.error('[DB] addMemory failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/**
 * Returns every active memory, most recently updated first. This is what
 * memoryEngine.js loads to build the context block injected into a new
 * conversation's system prompt - deliberately unfiltered/unpaginated since
 * the whole point is the model sees the full bank at once (same as how
 * Claude's own userMemories block works), and a personal on-device memory
 * bank is expected to stay in the hundreds of rows, not thousands.
 */
export async function getActiveMemories() {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(
      `SELECT * FROM memories WHERE is_active = 1 ORDER BY updated_at DESC`
    );
    return { success: true, data: rows, error: null };
  } catch (err) {
    console.error('[DB] getActiveMemories failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

/**
 * Every memory including soft-deleted ones - used only by the Settings >
 * Memory screen if it ever wants a "recently forgotten" section. Normal
 * app flow (context injection) should always use getActiveMemories above.
 */
export async function getAllMemories() {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM memories ORDER BY updated_at DESC`);
    return { success: true, data: rows, error: null };
  } catch (err) {
    console.error('[DB] getAllMemories failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

/**
 * Edits a memory's text in place (Settings > Memory > tap to edit), or
 * reassigns its category. Bumps updated_at so it resurfaces at the top of
 * the recency-ordered list, same as a human editing a note would expect.
 */
export async function updateMemory(id, { content, category } = {}) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };

    const fields = [];
    const values = [];
    if (content !== undefined) { fields.push('content = ?'); values.push(content); }
    if (category !== undefined) { fields.push('category = ?'); values.push(category); }
    if (fields.length === 0) return { success: true, error: null };

    fields.push('updated_at = ?');
    values.push(Date.now());
    values.push(id);

    await db.runAsync(`UPDATE memories SET ${fields.join(', ')} WHERE id = ?`, values);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] updateMemory failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/**
 * Soft-delete: sets is_active=0 rather than removing the row. This is what
 * "Forget this" in Settings > Memory calls - keeping the row (rather than a
 * hard DELETE) means if the same fact gets re-extracted by accident later,
 * upsertMemoryByContent's similarity check still has something to compare
 * against. Use hardDeleteMemory below if the person wants it gone for good
 * (e.g. they typed something sensitive and want no trace of it at all).
 */
export async function deactivateMemory(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`UPDATE memories SET is_active = 0, updated_at = ? WHERE id = ?`, [Date.now(), id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] deactivateMemory failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/** Permanently removes a memory row. No undo - see deactivateMemory for the soft version. */
export async function hardDeleteMemory(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`DELETE FROM memories WHERE id = ?`, [id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] hardDeleteMemory failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/** Wipes the entire memory bank - Settings > Memory > "Clear all memories", behind a confirmation dialog in the UI. */
export async function clearAllMemories() {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`DELETE FROM memories`);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] clearAllMemories failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ---------- Plans (src/services/planning/) ----------
//
// A plan is a multi-step task a domain planner (coding, terminal, files,
// browser) broke down before execution started. Persisted so PlanScreen.js
// can show live checklist progress and so a plan survives the app being
// closed mid-task - the person can come back later and see exactly where
// it left off, resume, or approve a step that was waiting on them.

/**
 * Creates one plan node. In the Phase 1 world every plan was implicitly
 * top-level; now a plan can be a Strategic goal-plan, a Project plan
 * under it, a Task plan under that, or a leaf Execution plan - see
 * src/services/planning/planHierarchy.js for the orchestration that
 * actually builds a tree of these. level/planType default to
 * 'execution' so any old caller that just does
 * createPlan(id, { conversationId, goal }) keeps producing exactly the
 * flat, single-level plan it used to.
 */
export async function createPlan(id, { conversationId = null, goal, level = 'execution', planType = 'execution', parentPlanId = null, parentStepId = null, successCriteria = null }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };

    const now = Date.now();
    await db.runAsync(
      `INSERT INTO plans (id, conversation_id, goal, status, level, plan_type, parent_plan_id, parent_step_id, success_criteria, created_at, updated_at)
       VALUES (?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?, ?)`,
      [id, conversationId, goal, level, planType, parentPlanId, parentStepId, successCriteria, now, now]
    );
    return {
      success: true,
      data: { id, conversation_id: conversationId, goal, status: 'planning', level, plan_type: planType, parent_plan_id: parentPlanId, parent_step_id: parentStepId, success_criteria: successCriteria, created_at: now, updated_at: now },
      error: null,
    };
  } catch (err) {
    console.error('[DB] createPlan failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/**
 * Inserts every step for a plan in one go, right after a domain planner
 * finishes breaking the goal down (before any step has started running).
 * @param {string} planId
 * @param {Array<{id, stepOrder, domain, description, action, target, details, dependsOnStepId, dependsOnStepIds, milestoneId, resourceTag, subtaskOfStepId, isRisky, riskReason}>} steps
 */
export async function insertPlanSteps(planId, steps) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };

    for (const step of steps) {
      await db.runAsync(
        `INSERT INTO plan_steps (id, plan_id, step_order, domain, description, reasoning, action, target, details_json, depends_on_step_id, depends_on_step_ids, milestone_id, resource_tag, subtask_of_step_id, is_risky, risk_reason, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
        [
          step.id,
          planId,
          step.stepOrder,
          step.domain,
          step.description,
          step.reasoning || null,
          step.action || null,
          step.target || null,
          step.details ? JSON.stringify(step.details) : null,
          step.dependsOnStepId || null,
          step.dependsOnStepIds && step.dependsOnStepIds.length ? step.dependsOnStepIds.join(',') : null,
          step.milestoneId || null,
          step.resourceTag || null,
          step.subtaskOfStepId || null,
          step.isRisky ? 1 : 0,
          step.riskReason || null,
        ]
      );
    }
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] insertPlanSteps failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getPlan(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };

    const plan = await db.getFirstAsync(`SELECT * FROM plans WHERE id = ?`, [id]);
    if (!plan) return { success: true, data: null, error: null };

    const steps = await db.getAllAsync(`SELECT * FROM plan_steps WHERE plan_id = ? ORDER BY step_order ASC`, [id]);
    const milestones = await db.getAllAsync(`SELECT * FROM plan_milestones WHERE plan_id = ? ORDER BY milestone_order ASC`, [id]);
    const resources = await db.getAllAsync(`SELECT * FROM plan_resources WHERE plan_id = ?`, [id]);
    const childPlans = await db.getAllAsync(`SELECT * FROM plans WHERE parent_plan_id = ? ORDER BY created_at ASC`, [id]);

    // One query for every real tool-call attempt across all of this
    // plan's steps (tier 4 of the trace model - see plan_step_actions'
    // schema comment), then grouped in JS by step_id rather than one
    // query per step - keeps getPlan() at a fixed number of round trips
    // regardless of how many steps or retry attempts a plan has.
    const allActions = await db.getAllAsync(`SELECT * FROM plan_step_actions WHERE plan_id = ? ORDER BY step_id, action_order ASC`, [id]);
    const actionsByStepId = new Map();
    for (const action of allActions || []) {
      if (!actionsByStepId.has(action.step_id)) actionsByStepId.set(action.step_id, []);
      actionsByStepId.get(action.step_id).push(action);
    }
    const stepsWithActions = (steps || []).map((step) => ({ ...step, actions: actionsByStepId.get(step.id) || [] }));

    return { success: true, data: { ...plan, steps: stepsWithActions, milestones: milestones || [], resources: resources || [], childPlans: childPlans || [] }, error: null };
  } catch (err) {
    console.error('[DB] getPlan failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/**
 * Walks the whole plan tree rooted at id - the strategic plan, every
 * project under it, every task under each project, every execution plan
 * under each task - each with its own steps attached. Used by
 * PlanScreen.js when rendering a multi-level plan as nested sections
 * instead of a flat checklist, and by planHierarchy.js's progress rollup.
 */
export async function getPlanTree(rootId) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };

    async function loadNode(id) {
      const result = await getPlan(id);
      if (!result.success || !result.data) return null;
      const node = result.data;
      const children = [];
      for (const child of node.childPlans) {
        const childNode = await loadNode(child.id);
        if (childNode) children.push(childNode);
      }
      node.children = children;
      return node;
    }

    const tree = await loadNode(rootId);
    return { success: true, data: tree, error: null };
  } catch (err) {
    console.error('[DB] getPlanTree failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/** Plans list for PlanScreen.js's history view - most recently updated first, so an in-progress or just-finished plan surfaces at the top. */
export async function getPlans(limit = 50) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };

    const rows = await db.getAllAsync(`SELECT * FROM plans ORDER BY updated_at DESC LIMIT ?`, [limit]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getPlans failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

/** Any plan not yet in a terminal state (completed/failed/cancelled) - used on app launch to check "was something left running/paused when the app closed?" */
export async function getActivePlans() {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };

    const rows = await db.getAllAsync(
      `SELECT * FROM plans WHERE status IN ('planning', 'running', 'awaiting_approval', 'paused') ORDER BY updated_at DESC`
    );
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getActivePlans failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

export async function updatePlanStatus(id, status, { completedAt } = {}) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };

    await db.runAsync(
      `UPDATE plans SET status = ?, updated_at = ?, completed_at = ? WHERE id = ?`,
      [status, Date.now(), completedAt || null, id]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] updatePlanStatus failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/**
 * Updates one step's status/result as the executor works through a plan.
 * Also bumps the parent plan's updated_at so plan lists sort correctly
 * without a separate call. retryCount is set explicitly (not
 * auto-incremented in SQL) so recoveryPlanner.js stays the single place
 * that decides "this counts as another attempt."
 */
export async function updatePlanStep(stepId, planId, { status, result, errorMessage, startedAt, completedAt, retryCount, description }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };

    const fields = [];
    const values = [];
    if (status !== undefined) { fields.push('status = ?'); values.push(status); }
    if (result !== undefined) { fields.push('result_json = ?'); values.push(result ? JSON.stringify(result) : null); }
    if (errorMessage !== undefined) { fields.push('error_message = ?'); values.push(errorMessage); }
    if (startedAt !== undefined) { fields.push('started_at = ?'); values.push(startedAt); }
    if (completedAt !== undefined) { fields.push('completed_at = ?'); values.push(completedAt); }
    if (retryCount !== undefined) { fields.push('retry_count = ?'); values.push(retryCount); }
    // description - only set by recoveryPlanner.js's ALTERNATE_APPROACH
    // strategy (see planExecutor.js's handleStepFailure), to actually
    // change what gets retried rather than silently re-running the exact
    // same failing instruction. Every other caller updates status/result/
    // errorMessage only and leaves this undefined.
    if (description !== undefined) { fields.push('description = ?'); values.push(description); }
    values.push(stepId);

    if (fields.length > 0) {
      await db.runAsync(`UPDATE plan_steps SET ${fields.join(', ')} WHERE id = ?`, values);
    }
    await db.runAsync(`UPDATE plans SET updated_at = ? WHERE id = ?`, [Date.now(), planId]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] updatePlanStep failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function deletePlan(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`DELETE FROM plans WHERE id = ?`, [id]); // plan_steps/plan_milestones/plan_resources/plan_recovery_attempts and child plans cascade via FOREIGN KEY ... ON DELETE CASCADE
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] deletePlan failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ---------- Plan hierarchy helpers ----------

/** Walks parent_plan_id up to the root - used to find "the" strategic/top plan from any descendant, e.g. to know which plan to show when a deep task plan's step fires a notification. */
export async function getPlanAncestors(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const ancestors = [];
    let current = await db.getFirstAsync(`SELECT * FROM plans WHERE id = ?`, [id]);
    while (current && current.parent_plan_id) {
      const parent = await db.getFirstAsync(`SELECT * FROM plans WHERE id = ?`, [current.parent_plan_id]);
      if (!parent) break;
      ancestors.push(parent);
      current = parent;
    }
    return { success: true, data: ancestors, error: null };
  } catch (err) {
    console.error('[DB] getPlanAncestors failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

/** Direct children of a plan node (e.g. a Project plan's Task plans) without their steps - cheap listing for a tree/outline view. */
export async function getChildPlans(parentPlanId) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM plans WHERE parent_plan_id = ? ORDER BY created_at ASC`, [parentPlanId]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getChildPlans failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

// ---------- Milestones (src/services/planning/milestonePlanner.js) ----------

export async function insertPlanMilestones(planId, milestones) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    for (const m of milestones) {
      await db.runAsync(
        `INSERT INTO plan_milestones (id, plan_id, milestone_order, title, description, status, target_step_id)
         VALUES (?, ?, ?, ?, ?, 'pending', ?)`,
        [m.id, planId, m.milestoneOrder, m.title, m.description || null, m.targetStepId || null]
      );
    }
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] insertPlanMilestones failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function updateMilestoneStatus(milestoneId, status, { reachedAt } = {}) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `UPDATE plan_milestones SET status = ?, reached_at = ? WHERE id = ?`,
      [status, reachedAt || null, milestoneId]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] updateMilestoneStatus failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getPlanMilestones(planId) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM plan_milestones WHERE plan_id = ? ORDER BY milestone_order ASC`, [planId]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getPlanMilestones failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

// ---------- Resources (src/services/planning/resourcePlanner.js) ----------

export async function insertPlanResources(planId, resources) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    for (const r of resources) {
      await db.runAsync(
        `INSERT INTO plan_resources (id, plan_id, resource_type, label, is_available, checked_at, details_json)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [r.id, planId, r.resourceType, r.label, r.isAvailable === undefined || r.isAvailable === null ? null : (r.isAvailable ? 1 : 0), r.checkedAt || null, r.details ? JSON.stringify(r.details) : null]
      );
    }
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] insertPlanResources failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function updateResourceAvailability(resourceId, isAvailable, details = null) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `UPDATE plan_resources SET is_available = ?, checked_at = ?, details_json = ? WHERE id = ?`,
      [isAvailable ? 1 : 0, Date.now(), details ? JSON.stringify(details) : null, resourceId]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] updateResourceAvailability failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getPlanResources(planId) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM plan_resources WHERE plan_id = ?`, [planId]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getPlanResources failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

// ---------- Recovery attempts (src/services/planning/recoveryPlanner.js) ----------

export async function insertRecoveryAttempt(attempt) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO plan_recovery_attempts (id, plan_id, step_id, attempt_number, strategy, reasoning, outcome, created_at, resolved_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, NULL)`,
      [attempt.id, attempt.planId, attempt.stepId, attempt.attemptNumber, attempt.strategy, attempt.reasoning || null, now]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] insertRecoveryAttempt failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function resolveRecoveryAttempt(attemptId, outcome) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `UPDATE plan_recovery_attempts SET outcome = ?, resolved_at = ? WHERE id = ?`,
      [outcome, Date.now(), attemptId]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] resolveRecoveryAttempt failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getRecoveryAttempts(stepId) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM plan_recovery_attempts WHERE step_id = ? ORDER BY attempt_number ASC`, [stepId]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getRecoveryAttempts failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

// ---------- Checkpoint balancing (src/services/planning/checkpointBalancer.js) ----------

/**
 * Records a new checkpoint suggestion and flips the plan's
 * checkpoint_pending flag on - called by checkpointBalancer.js via
 * planExecutor.js right after a step completes, if accumulated
 * pressure crossed the threshold. Does NOT touch last_checkpoint_at -
 * that only moves once the person actually accepts the checkpoint (see
 * resolveCheckpointSuggestion), so a dismissed suggestion doesn't reset
 * the pressure clock.
 */
export async function recordCheckpointSuggestion(planId, { id, stepsCovered, filesCovered, domainsCovered, riskySteps, pressureScore, reason }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO plan_checkpoints (id, plan_id, created_at, steps_covered, files_covered_json, domains_covered_json, risky_steps_covered, pressure_score, reason, resolution)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [id, planId, now, stepsCovered, JSON.stringify(filesCovered || []), JSON.stringify(domainsCovered || []), riskySteps || 0, pressureScore || 0, reason || null]
    );
    await db.runAsync(`UPDATE plans SET checkpoint_pending = 1, checkpoint_reason = ? WHERE id = ?`, [reason || null, planId]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] recordCheckpointSuggestion failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/**
 * Resolves the plan's current pending checkpoint. 'accepted' moves
 * last_checkpoint_at to now, resetting checkpointBalancer.js's pressure
 * clock to zero going forward. 'dismissed' clears the pending flag
 * WITHOUT moving last_checkpoint_at, so the same accumulated pressure
 * (plus whatever runs after) will very likely trigger another
 * suggestion soon - dismissing is "not now", not "never ask again".
 */
export async function resolveCheckpointSuggestion(planId, resolution) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    const now = Date.now();

    const latest = await db.getFirstAsync(
      `SELECT id FROM plan_checkpoints WHERE plan_id = ? AND resolution = 'pending' ORDER BY created_at DESC LIMIT 1`,
      [planId]
    );
    if (latest) {
      await db.runAsync(`UPDATE plan_checkpoints SET resolution = ?, resolved_at = ? WHERE id = ?`, [resolution, now, latest.id]);
    }

    if (resolution === 'accepted') {
      await db.runAsync(`UPDATE plans SET checkpoint_pending = 0, checkpoint_reason = NULL, last_checkpoint_at = ? WHERE id = ?`, [now, planId]);
    } else {
      await db.runAsync(`UPDATE plans SET checkpoint_pending = 0, checkpoint_reason = NULL WHERE id = ?`, [planId]);
    }
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] resolveCheckpointSuggestion failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getPlanCheckpoints(planId) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM plan_checkpoints WHERE plan_id = ? ORDER BY created_at DESC`, [planId]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getPlanCheckpoints failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

// ---------- Step actions - tier 4 of the trace model (src/services/planning/planExecutor.js) ----------

/**
 * Logs the START of one real tool-call attempt for a step - called by
 * planExecutor.js immediately BEFORE invoking the tool, with the actual
 * arguments about to be sent, so the record exists even if the call
 * itself throws or hangs. action_order auto-increments per step (0 for
 * the first attempt, 1 for a retry, etc.) so a step recovered via
 * recoveryPlanner.js ends up with one row per attempt, all independently
 * inspectable - not just overwritten.
 * @returns {Promise<{success: boolean, actionId: string|null, error: string|null}>}
 */
export async function startStepAction(id, { stepId, planId, toolName, label, input }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, actionId: null, error: 'DB_OPEN_FAILED' };

    const countRow = await db.getFirstAsync(`SELECT COUNT(*) as count FROM plan_step_actions WHERE step_id = ?`, [stepId]);
    const actionOrder = countRow?.count || 0;
    const now = Date.now();

    await db.runAsync(
      `INSERT INTO plan_step_actions (id, step_id, plan_id, action_order, tool_name, label, input_json, status, started_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'running', ?, ?)`,
      [id, stepId, planId, actionOrder, toolName || null, label || null, input ? JSON.stringify(input) : null, now, now]
    );
    return { success: true, actionId: id, error: null };
  } catch (err) {
    console.error('[DB] startStepAction failed:', err);
    return { success: false, actionId: null, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/** Logs the REAL outcome of a tool-call attempt already started via startStepAction() - the actual output (or error) the tool returned, not a description of it. */
export async function completeStepAction(actionId, { status, output, error }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `UPDATE plan_step_actions SET status = ?, output_json = ?, completed_at = ? WHERE id = ?`,
      [status, JSON.stringify(error ? { error } : (output ?? null)), Date.now(), actionId]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] completeStepAction failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getStepActions(stepId) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM plan_step_actions WHERE step_id = ? ORDER BY action_order ASC`, [stepId]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getStepActions failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

/**
 * Logs a REASONING link in a step's chain - the "why" that sits between
 * two real tool calls (e.g. recoveryPlanner.js's decision reasoning,
 * logged right before the retry attempt it justifies actually runs).
 * Shares the same action_order sequence as startStepAction() (both
 * count existing plan_step_actions rows for the step), so reasoning and
 * tool_call rows interleave in true chronological order when read back
 * by action_order - a 'reasoning' row between two 'tool_call' rows reads
 * as "here's what was concluded from the call before, here's what
 * happens next", the same chain shape a live agent trace shows. Always
 * inserted as immediately 'done' - a thought doesn't have a running
 * state the way a tool call does.
 */
export async function logStepReasoning(id, { stepId, planId, reasoningText }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };

    const countRow = await db.getFirstAsync(`SELECT COUNT(*) as count FROM plan_step_actions WHERE step_id = ?`, [stepId]);
    const actionOrder = countRow?.count || 0;
    const now = Date.now();

    await db.runAsync(
      `INSERT INTO plan_step_actions (id, step_id, plan_id, action_order, entry_type, reasoning_text, status, started_at, completed_at, created_at)
       VALUES (?, ?, ?, ?, 'reasoning', ?, 'done', ?, ?, ?)`,
      [id, stepId, planId, actionOrder, reasoningText || null, now, now, now]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] logStepReasoning failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ---------- Working memory / rolling summary (src/services/memory/workingMemory.js) ----------
//
// A conversation's rolling_summary/rolling_summary_covers_at pair (columns
// added to `conversations` above) let workingMemory.js compact a long
// chat's context-window footprint: everything up to the covered timestamp
// collapses into one summary paragraph, everything after is still sent
// to the model verbatim.

/** Reads the current rolling summary state for one conversation, or nulls if it's never been compacted. */
export async function getRollingSummary(conversationId) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };
    const row = await db.getFirstAsync(
      `SELECT rolling_summary, rolling_summary_covers_at FROM conversations WHERE id = ?`,
      [conversationId]
    );
    return { success: true, data: row || { rolling_summary: null, rolling_summary_covers_at: null }, error: null };
  } catch (err) {
    console.error('[DB] getRollingSummary failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/** Overwrites a conversation's rolling summary and the timestamp boundary it now covers (workingMemory.js recomputes the whole summary text each time it extends it, rather than trying to append-patch prose). */
export async function setRollingSummary(conversationId, { summary, coversAt }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `UPDATE conversations SET rolling_summary = ?, rolling_summary_covers_at = ? WHERE id = ?`,
      [summary, coversAt, conversationId]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] setRollingSummary failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ---------- Retrieval memory (src/services/memory/retrievalMemory.js) ----------
//
// Cross-conversation recall: unlike getMessages() above (one conversation
// at a time, for rendering ChatScreen), this pulls a bounded window of
// recent messages across EVERY conversation so retrievalMemory.js's
// local BM25-lite scorer has a pool to search when the person references
// something from a past, closed conversation.

/** Bounded pool of recent messages across all conversations, newest first, for retrievalMemory.js to score against a query - NOT scoped to one conversation_id like getMessages(). limit is a hard cap on rows scanned (keeps this cheap on a phone even after months of history). */
export async function getRecentMessagesAcrossConversations(limit = 3000) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(
      `SELECT m.id, m.conversation_id, m.role, m.content, m.created_at, c.title as conversation_title
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
       WHERE m.role IN ('user', 'assistant') AND length(m.content) > 0
       ORDER BY m.created_at DESC
       LIMIT ?`,
      [limit]
    );
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getRecentMessagesAcrossConversations failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

// ---------- Procedural memory (src/services/memory/proceduralMemory.js) ----------
//
// "How to do X" recipes distilled from hierarchical plans
// (src/services/planning/) that completed successfully. See the
// `procedures` table comment above the schema for the shape.

/** Stores a new learned procedure. */
export async function addProcedure({ id, taskSignature, goalSummary, steps, sourcePlanId = null }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO procedures (id, task_signature, goal_summary, steps_json, source_plan_id, use_count, created_at, last_used_at)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      [id, taskSignature, goalSummary, JSON.stringify(steps || []), sourcePlanId, now, now]
    );
    return { success: true, data: { id }, error: null };
  } catch (err) {
    console.error('[DB] addProcedure failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/** Every stored procedure, most recently used first - proceduralMemory.js's findSimilarProcedure() scores these locally against a new goal. Bounded to a sane cap so this never becomes an unbounded table scan on a phone after years of use. */
export async function getAllProcedures(limit = 300) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM procedures ORDER BY last_used_at DESC LIMIT ?`, [limit]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getAllProcedures failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

/** Marks an existing procedure as reused - bumps use_count and last_used_at so it ranks higher next time instead of piling up near-duplicate rows for the same recurring task. */
export async function bumpProcedureUsage(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`UPDATE procedures SET use_count = use_count + 1, last_used_at = ? WHERE id = ?`, [Date.now(), id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] bumpProcedureUsage failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/** Permanently removes a learned procedure - not currently exposed in any Settings UI, kept for parity with the memories table's hardDelete and for a future "Settings > Learned procedures" screen. */
export async function deleteProcedure(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`DELETE FROM procedures WHERE id = ?`, [id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] deleteProcedure failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ============================================================
// Reminders / prospective memory - see
// src/services/reminders/reminderService.js for the layer that also
// talks to expo-notifications; this is just the ZAO-owned record of
// what's been scheduled, independent of whether the OS-level alarm
// actually exists.
// ============================================================

/** Records a new reminder. osNotificationId is usually filled in by a follow-up setReminderOsId call once expo-notifications confirms the OS-level schedule - a row can legitimately exist here with osNotificationId still null (schedule call pending or failed) since the point of this table is that ZAO knows about the reminder either way. */
export async function addReminder({ id, message, triggerAt, repeatRule = null, sourceConversationId = null, osNotificationId = null }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO reminders (id, message, trigger_at, repeat_rule, status, os_notification_id, source_conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'scheduled', ?, ?, ?, ?)`,
      [id, message, triggerAt, repeatRule, osNotificationId, sourceConversationId, now, now]
    );
    return { success: true, data: { id }, error: null };
  } catch (err) {
    console.error('[DB] addReminder failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/** Attaches (or clears, on a failed schedule) the expo-notifications handle to an already-inserted reminder row. */
export async function setReminderOsId(id, osNotificationId) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`UPDATE reminders SET os_notification_id = ?, updated_at = ? WHERE id = ?`, [osNotificationId, Date.now(), id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] setReminderOsId failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/** Every reminder still pending (not fired/cancelled/failed), soonest first - this is what makes ZAO able to actually inspect and reason about its own scheduled follow-ups instead of only the device's notification shade knowing. */
export async function getActiveReminders() {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM reminders WHERE status = 'scheduled' ORDER BY trigger_at ASC`);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getActiveReminders failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

/** Every reminder regardless of status, most recently created first - backs a future/Settings "reminders" list the way getAllMemories backs the Memory section. */
export async function getAllReminders(limit = 200) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM reminders ORDER BY created_at DESC LIMIT ?`, [limit]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getAllReminders failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

export async function getReminder(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };
    const row = await db.getFirstAsync(`SELECT * FROM reminders WHERE id = ?`, [id]);
    return { success: true, data: row || null, error: null };
  } catch (err) {
    console.error('[DB] getReminder failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/** Marks a reminder as delivered. For a repeating reminder, reminderService.js re-inserts the next occurrence separately rather than reusing this row, so status transitions stay one-directional (scheduled -> fired) instead of bouncing a row back to 'scheduled' in place. */
export async function markReminderFired(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    const now = Date.now();
    await db.runAsync(`UPDATE reminders SET status = 'fired', fired_at = ?, updated_at = ? WHERE id = ?`, [now, now, id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] markReminderFired failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/** Marks a reminder cancelled - reminderService.js calls this AFTER it successfully (or harmlessly-no-op'd) cancels the OS-level notification, so a cancelled row here always means the OS side was at least attempted, never silently orphaned. */
export async function cancelReminderRecord(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`UPDATE reminders SET status = 'cancelled', updated_at = ? WHERE id = ?`, [Date.now(), id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] cancelReminderRecord failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/** Marks a reminder as failed to schedule (e.g. notification permission denied) - distinct from 'cancelled' (person's choice) so a future "reminders" view can tell the two apart and the person knows to check permissions rather than thinking they cancelled something they didn't. */
export async function markReminderFailed(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`UPDATE reminders SET status = 'failed', updated_at = ? WHERE id = ?`, [Date.now(), id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] markReminderFailed failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/** Permanently removes a reminder row - for a Settings-level "clear" action, distinct from cancelReminderRecord which keeps history (mirrors hardDeleteMemory vs. deactivateMemory). */
export async function deleteReminder(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`DELETE FROM reminders WHERE id = ?`, [id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] deleteReminder failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ============================================================
// Background PC processes - see server/processManager.js (PC-side
// process itself) and src/services/terminal/pcProcessTool.js /
// src/services/background/processWatcherTask.js (this is the
// ZAO-owned record of which PC process ids are worth watching for a
// "finished" notification, independent of the PC's own in-memory
// state, which is lost on a backend restart).
// ============================================================

/** Records a new tracked background process right after pc_process_start successfully launches it on the PC. */
export async function addBackgroundProcess({ id, label, command, sourceConversationId = null }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO background_processes (id, label, command, status, notified, source_conversation_id, created_at, updated_at)
       VALUES (?, ?, ?, 'running', 0, ?, ?, ?)`,
      [id, label, command, sourceConversationId, now, now]
    );
    return { success: true, data: { id }, error: null };
  } catch (err) {
    console.error('[DB] addBackgroundProcess failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

/** Every process still 'running' per ZAO's own record, or finished but not yet notified about - what processWatcherTask.js polls on each wakeup. */
export async function getTrackedBackgroundProcesses() {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(
      `SELECT * FROM background_processes WHERE status = 'running' OR notified = 0 ORDER BY created_at ASC`
    );
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getTrackedBackgroundProcesses failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

/** Every tracked process regardless of status, most recent first - backs a future Settings/status list the way getAllReminders does for reminders. */
export async function getAllBackgroundProcesses(limit = 200) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM background_processes ORDER BY created_at DESC LIMIT ?`, [limit]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getAllBackgroundProcesses failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

/** Updates ZAO's own record of a process's status (running/exited/killed/error) + exit code - called by pc_process_stop right after a manual stop, and by processWatcherTask.js when it notices a status change on the PC. */
export async function updateBackgroundProcessStatus(id, status, exitCode = null) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `UPDATE background_processes SET status = ?, exit_code = ?, updated_at = ? WHERE id = ?`,
      [status, exitCode, Date.now(), id]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] updateBackgroundProcessStatus failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/** Marks a finished process as already notified about, so processWatcherTask.js's next poll doesn't fire a second local notification for the same completion. */
export async function markBackgroundProcessNotified(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`UPDATE background_processes SET notified = 1, updated_at = ? WHERE id = ?`, [Date.now(), id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] markBackgroundProcessNotified failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ============================================================
// Execution / Safety - see src/services/execution/ for the modules
// that call these.
// ============================================================

// ---------- Edit checkpoints ----------

export async function recordCheckpoint({ id, conversationId = null, path, operation, previousContentB64 = null, previousPath = null, existedBefore = true }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `INSERT INTO edit_checkpoints (id, conversation_id, path, operation, previous_content_b64, previous_path, existed_before, rewound, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)`,
      [id, conversationId, path, operation, previousContentB64, previousPath, existedBefore ? 1 : 0, Date.now()]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] recordCheckpoint failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getRecentCheckpoints(limit = 50) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM edit_checkpoints WHERE rewound = 0 ORDER BY created_at DESC LIMIT ?`, [limit]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getRecentCheckpoints failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

export async function getCheckpointsForPath(path) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM edit_checkpoints WHERE path = ? ORDER BY created_at DESC`, [path]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getCheckpointsForPath failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

export async function getCheckpoint(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };
    const row = await db.getFirstAsync(`SELECT * FROM edit_checkpoints WHERE id = ?`, [id]);
    return { success: true, data: row || null, error: null };
  } catch (err) {
    console.error('[DB] getCheckpoint failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

export async function markCheckpointsRewound(path, fromCreatedAt) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`UPDATE edit_checkpoints SET rewound = 1 WHERE path = ? AND created_at >= ?`, [path, fromCreatedAt]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] markCheckpointsRewound failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ---------- Folder checkpoints (batch, whole-directory) ----------
// Mirrors edit_checkpoints' shape/conventions above, but one row per
// batch (folder_checkpoints) plus one row per file swept into it
// (folder_checkpoint_entries) - see checkpointManager.snapshotFolder()
// and filesystemTool.rewindFolderCheckpoint() for how these get written
// and restored.

export async function recordFolderCheckpoint({ id, conversationId = null, rootPath, operation, entries }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    const now = Date.now();
    await db.runAsync(
      `INSERT INTO folder_checkpoints (id, conversation_id, root_path, operation, file_count, rewound, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)`,
      [id, conversationId, rootPath, operation, entries.length, now]
    );
    for (const entry of entries) {
      await db.runAsync(
        `INSERT INTO folder_checkpoint_entries (id, batch_id, relative_path, content_b64, is_dir) VALUES (?, ?, ?, ?, ?)`,
        [`${id}_${entry.relativePath}`.slice(0, 500), id, entry.relativePath, entry.contentB64 || null, entry.isDir ? 1 : 0]
      );
    }
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] recordFolderCheckpoint failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

/** Newest folder-checkpoint batches - the "restore whole folder" list Settings > Checkpoints reads. */
export async function getRecentFolderCheckpoints(limit = 20) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM folder_checkpoints WHERE rewound = 0 ORDER BY created_at DESC LIMIT ?`, [limit]);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getRecentFolderCheckpoints failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

export async function getFolderCheckpoint(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: null };
    const batch = await db.getFirstAsync(`SELECT * FROM folder_checkpoints WHERE id = ?`, [id]);
    if (!batch) return { success: true, data: null, error: null };
    const entries = await db.getAllAsync(`SELECT * FROM folder_checkpoint_entries WHERE batch_id = ?`, [id]);
    return { success: true, data: { ...batch, entries: entries || [] }, error: null };
  } catch (err) {
    console.error('[DB] getFolderCheckpoint failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: null };
  }
}

export async function markFolderCheckpointRewound(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`UPDATE folder_checkpoints SET rewound = 1 WHERE id = ?`, [id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] markFolderCheckpointRewound failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ---------- Hooks ----------

export async function getHooks(event = null) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = event
      ? await db.getAllAsync(`SELECT * FROM hooks WHERE event = ? AND enabled = 1 ORDER BY created_at ASC`, [event])
      : await db.getAllAsync(`SELECT * FROM hooks ORDER BY event, created_at ASC`);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getHooks failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

export async function createHook({ id, event, matcher = '*', command, backend = 'pc' }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `INSERT INTO hooks (id, event, matcher, command, backend, enabled, created_at) VALUES (?, ?, ?, ?, ?, 1, ?)`,
      [id, event, matcher, command, backend, Date.now()]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] createHook failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function setHookEnabled(id, enabled) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`UPDATE hooks SET enabled = ? WHERE id = ?`, [enabled ? 1 : 0, id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] setHookEnabled failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function deleteHook(id) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`DELETE FROM hooks WHERE id = ?`, [id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] deleteHook failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

// ---------- Agent actions (telemetry spans) ----------

export async function startAgentAction({ id, traceId, spanId, parentSpanId = null, sessionId = null, conversationId = null, name, toolName = null, attributes = null }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `INSERT INTO agent_actions (id, trace_id, span_id, parent_span_id, session_id, conversation_id, name, tool_name, attributes_json, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?)`,
      [id, traceId, spanId, parentSpanId, sessionId, conversationId, name, toolName, attributes ? JSON.stringify(attributes) : null, Date.now()]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] startAgentAction failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function endAgentAction(id, { status = 'ok', errorMessage = null, attributes = null } = {}) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    if (attributes) {
      const existing = await db.getFirstAsync(`SELECT attributes_json FROM agent_actions WHERE id = ?`, [id]);
      const merged = { ...(existing?.attributes_json ? JSON.parse(existing.attributes_json) : {}), ...attributes };
      await db.runAsync(`UPDATE agent_actions SET status = ?, error_message = ?, attributes_json = ?, ended_at = ? WHERE id = ?`, [status, errorMessage, JSON.stringify(merged), Date.now(), id]);
    } else {
      await db.runAsync(`UPDATE agent_actions SET status = ?, error_message = ?, ended_at = ? WHERE id = ?`, [status, errorMessage, Date.now(), id]);
    }
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] endAgentAction failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getAgentActionsForSession(sessionId) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM agent_actions WHERE session_id = ? ORDER BY started_at ASC`, [sessionId]);
    return {
      success: true,
      data: (rows || []).map((r) => ({ ...r, attributes_json: r.attributes_json ? JSON.parse(r.attributes_json) : null })),
      error: null,
    };
  } catch (err) {
    console.error('[DB] getAgentActionsForSession failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

export async function getRecentAgentActions(limit = 100) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = await db.getAllAsync(`SELECT * FROM agent_actions ORDER BY started_at DESC LIMIT ?`, [limit]);
    return {
      success: true,
      data: (rows || []).map((r) => ({ ...r, attributes_json: r.attributes_json ? JSON.parse(r.attributes_json) : null })),
      error: null,
    };
  } catch (err) {
    console.error('[DB] getRecentAgentActions failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

// ---------- Worktree sessions ----------

export async function createWorktreeSession({ id, conversationId, sourceConversationId = null, owner = null, repo = null, branch, baseBranch = null, localPath = null, backend = 'github' }) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(
      `INSERT INTO worktree_sessions (id, conversation_id, source_conversation_id, owner, repo, branch, base_branch, local_path, backend, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?)`,
      [id, conversationId, sourceConversationId, owner, repo, branch, baseBranch, localPath, backend, Date.now()]
    );
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] createWorktreeSession failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}

export async function getWorktreeSessions(status = 'active') {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED', data: [] };
    const rows = status
      ? await db.getAllAsync(`SELECT * FROM worktree_sessions WHERE status = ? ORDER BY created_at DESC`, [status])
      : await db.getAllAsync(`SELECT * FROM worktree_sessions ORDER BY created_at DESC`);
    return { success: true, data: rows || [], error: null };
  } catch (err) {
    console.error('[DB] getWorktreeSessions failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR', data: [] };
  }
}

export async function updateWorktreeSessionStatus(id, status) {
  try {
    const db = await getDb();
    if (!db) return { success: false, error: 'DB_OPEN_FAILED' };
    await db.runAsync(`UPDATE worktree_sessions SET status = ? WHERE id = ?`, [status, id]);
    return { success: true, error: null };
  } catch (err) {
    console.error('[DB] updateWorktreeSessionStatus failed:', err);
    return { success: false, error: err?.message || 'UNKNOWN_ERROR' };
  }
}
