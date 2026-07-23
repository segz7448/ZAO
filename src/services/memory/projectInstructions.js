/**
 * ZAO - Project Instructions ("ZAO.md")
 *
 * Claude Code's CLAUDE.md is a person-authored file, loaded fresh into
 * every session, that carries standing instructions a model shouldn't
 * have to re-derive or be re-told each time ("this repo uses pnpm not
 * npm", "always run the linter before committing", "the staging
 * branch is `dev`, never push straight to `main`"). ZAO had no
 * equivalent - every session started from zero except for whatever
 * memoryEngine.js had extracted as a SEMANTIC fact, which is written
 * BY the model from a conversation, not authored BY the person up
 * front, and isn't guaranteed to be loaded (extraction can miss
 * things; there's no single place to see or edit the standing rules).
 *
 * This module is that missing piece: one person-editable block of
 * markdown, stored in `user_preferences.project_instructions`
 * (src/db/database.js), surfaced in Settings for the person to write
 * and edit directly (not model-extracted), and injected as its own
 * system-role block at the front of every conversation - chat, tool
 * task, browsing, and hierarchical plan alike - the same way CLAUDE.md
 * is loaded regardless of which mode Claude Code ends up using.
 *
 * WHY A DB COLUMN, NOT A REAL FILE: Claude Code reads CLAUDE.md off
 * disk because it operates inside a real project directory. ZAO runs
 * as a phone app talking to a PC backend - there's no single
 * canonical "project root" on the phone to put a file in, and the
 * PC backend is a model server, not a place ZAO's frontend reads
 * config from. A single SQLite row is the on-device equivalent: one
 * durable, person-owned document, editable from Settings, with no
 * filesystem permissions dance.
 *
 * SIZE CAP: kept small on purpose (see MAX_INSTRUCTIONS_CHARS) - this
 * is standing rules, not a knowledge dump. A person who needs to store
 * a lot of reference material should use SEMANTIC memory (auto-facts)
 * or the filesystem/GitHub tools to keep an actual reference file the
 * tool orchestrator can read on demand, not this block.
 */

import { getPreferences, updatePreferences } from '../../db/database';

const MAX_INSTRUCTIONS_CHARS = 4000;

/**
 * @param {string} text
 * @returns {Promise<{ success: boolean, error: string|null, truncated: boolean }>}
 */
export async function setProjectInstructions(text) {
  const trimmed = (text || '').trim();
  const truncated = trimmed.length > MAX_INSTRUCTIONS_CHARS;
  const value = truncated ? trimmed.slice(0, MAX_INSTRUCTIONS_CHARS) : trimmed;

  const result = await updatePreferences({ project_instructions: value });
  return { success: result.success, error: result.error || null, truncated };
}

/**
 * @returns {Promise<string>} raw instructions text, '' if none set.
 */
export async function getProjectInstructions() {
  const prefs = await getPreferences();
  return prefs.data?.project_instructions || '';
}

/**
 * Builds the system-role block to prepend to a conversation. Returns
 * null (not an empty string) when nothing is set, so every call site
 * can do `if (block) history.unshift(block)` without an extra check.
 *
 * @returns {Promise<{ role: 'system', content: string } | null>}
 */
export async function getProjectInstructionsBlock() {
  const text = await getProjectInstructions();
  if (!text) return null;

  return {
    role: 'system',
    content: `The person has set the following standing instructions for every conversation. Follow them unless they conflict with the current request:\n\n${text}`,
  };
}
