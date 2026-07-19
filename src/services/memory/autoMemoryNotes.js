/**
 * ZAO - Auto Memory Notes ("MEMORY.md" equivalent)
 *
 * Claude Code lets the model itself write short learnings to
 * MEMORY.md mid-session ("this project's tests need `pnpm test`, not
 * `npm test`" / "the API key lives in .env.local, not .env") - and
 * loads the first 200 lines / 25KB of it back in at the start of
 * every future session, capped so it never grows into a second
 * context window.
 *
 * ZAO already has SEMANTIC memory (src/services/memory/memoryEngine.js
 * + the `memories` table) - but that's specifically FACTS ABOUT THE
 * PERSON ("lives in Lagos", "prefers dark mode"), extracted from
 * conversation content. It's the wrong shape for what this module is
 * for: short operational notes the AGENT learns about ITS OWN work -
 * which tool call failed and why, a quirk of the person's GitHub org,
 * a command that needed a flag last time. Mixing the two would
 * pollute memoryEngine.js's person-facts with agent scratch-notes and
 * vice versa, so this is a deliberately separate, smaller store.
 *
 * Stored as one capped block of newline-separated notes in
 * `user_preferences.auto_memory_notes` (src/db/database.js) - a
 * single row, not a table, because this never needs to be queried or
 * joined, only loaded whole and trimmed from the front when it grows
 * past the cap (oldest notes drop first, same as Claude Code
 * discarding old MEMORY.md lines over the 200-line/25KB limit).
 *
 * WHO WRITES TO IT: any route (toolOrchestrator.js's tool loop,
 * backendBrain.js's hierarchical plan, agentLoop.js's verify step) can
 * call recordAutoMemoryNote() when it notices something worth
 * remembering for next time. This module doesn't decide WHAT'S worth
 * noting - callers do - it only owns storage, capping, and retrieval.
 */

import { getPreferences, updatePreferences } from '../../db/database';

const MAX_NOTES_CHARS = 25 * 1024; // 25KB, matching Claude Code's MEMORY.md cap
const MAX_NOTES_LINES = 200;

/**
 * Appends one note, then trims from the front (oldest first) if the
 * combined text is over either cap.
 *
 * @param {string} note - a single short learning, no newlines ideally
 *   (embedded newlines are flattened to spaces so line-counting stays
 *   meaningful for the cap).
 * @returns {Promise<{ success: boolean, error: string|null }>}
 */
export async function recordAutoMemoryNote(note) {
  const clean = (note || '').trim().replace(/\s*\n\s*/g, ' ');
  if (!clean) return { success: true, error: null };

  const prefs = await getPreferences();
  const existing = prefs.data?.auto_memory_notes || '';
  const stamped = `- ${clean}`;

  let lines = existing ? existing.split('\n').filter(Boolean) : [];
  lines.push(stamped);

  while (lines.length > MAX_NOTES_LINES || lines.join('\n').length > MAX_NOTES_CHARS) {
    lines.shift();
    if (lines.length === 0) break;
  }

  const result = await updatePreferences({ auto_memory_notes: lines.join('\n') });
  return { success: result.success, error: result.error || null };
}

/**
 * @returns {Promise<string>} raw notes text, '' if none yet.
 */
export async function getAutoMemoryNotes() {
  const prefs = await getPreferences();
  return prefs.data?.auto_memory_notes || '';
}

/**
 * @returns {Promise<{ role: 'system', content: string } | null>}
 */
export async function getAutoMemoryBlock() {
  const text = await getAutoMemoryNotes();
  if (!text) return null;

  return {
    role: 'system',
    content: `Things you've learned from past sessions about how to work on this person's projects/tools (your own operational notes, not facts about them):\n\n${text}`,
  };
}

export async function clearAutoMemoryNotes() {
  const result = await updatePreferences({ auto_memory_notes: '' });
  return { success: result.success, error: result.error || null };
}
