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
      -- event_type is a short category ('github_push', 'image_generated',
      -- 'file_created', 'browser_session', 'openrouter_call',
      -- 'huggingface_call', etc.), detail is a short human-readable label
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
    `);

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
    // Values: NULL (no feedback), 'like', 'dislike'.
    try {
      await db.execAsync(`ALTER TABLE messages ADD COLUMN feedback TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: tts_voice_identifier/tts_speech_rate columns added when
    // Read Aloud moved from HF-hosted TTS models to the device's native
    // Android TTS engine (see src/services/tts/androidTts.js). NULL
    // tts_voice_identifier means "use the system default voice".
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN tts_voice_identifier TEXT;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN tts_speech_rate REAL DEFAULT 1.0;`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }

    // Migration: voice_mode_activation added for the full-screen Voice Mode
    // conversation UI (see VoiceModeScreen.js) - 'hands_free' listens
    // continuously and auto-detects when the user stops talking;
    // 'push_to_talk' requires holding the mic button down.
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN voice_mode_activation TEXT DEFAULT 'hands_free';`);
    } catch (migrationErr) {
      // Expected on any install that already has this column - not an error.
    }
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN tts_voice_preset TEXT;`);
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

    // Migration: github_username added for the GitHub tool (the local
    // coder model's repo/commit/push/PR/release plugin - see
    // src/services/github/githubTool.js). The Personal Access Token itself
    // goes through the same secure api_keys/SecureStore mechanism as the
    // Hugging Face key used for Whisper
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

    // Migration: model_folder_saf_uri added for local model import (see
    // src/services/llama/modelImportTool.js). ZAO's chat/coding/reasoning
    // models are now local GGUF files run via llama.rn instead of
    // OpenRouter/Hugging Face - the person grants SAF access ONCE to the
    // folder those files live in (e.g. an SD card path like
    // /storage/XXXX-XXXX/Model/, not reachable via a plain file path), and
    // this column stores that persistent content:// URI so the grant only
    // needs to happen once ever. This is deliberately a separate column
    // from filesystem_saf_uri above - the person may grant a completely
    // different folder for general file operations vs. where their model
    // files live, and conflating the two would silently break whichever
    // feature was granted second.
    try {
      await db.execAsync(`ALTER TABLE user_preferences ADD COLUMN model_folder_saf_uri TEXT;`);
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

    // Migration: supabase_image_path added alongside local_image_path -
    // tracks the storage_path once the same image has been uploaded to the
    // 'zao-files' Supabase bucket in the background (see
    // src/storage/fileStorage.js uploadFile()). NULL until that upload
    // succeeds; the local image still displays fine before then.
    try {
      await db.execAsync(`ALTER TABLE messages ADD COLUMN supabase_image_path TEXT;`);
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
    } = message;
    const now = Date.now();

    await db.runAsync(
      `INSERT INTO messages
        (id, conversation_id, role, content, provider, model, model_family, token_count, created_at, is_error, local_image_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, conversation_id, role, content, provider, model, model_family, token_count, now, is_error ? 1 : 0, local_image_path]
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
 * @param {string} eventType - short category, e.g. 'github_push', 'image_generated', 'file_created', 'browser_session', 'openrouter_call', 'huggingface_call'
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
    for (const key of ['theme_preference', 'browser_access_enabled', 'github_username', 'filesystem_saf_uri', 'memory_enabled']) {
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
// Chat/coding/reasoning run through the single Termux-hosted backend (see
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
