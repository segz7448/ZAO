/**
 * ZAO - Project Decisions Log
 *
 * WHY THIS EXISTS: projectInstructions.js (ZAO.md) already covers
 * standing RULES a person writes up front ("this repo uses pnpm",
 * "always run the linter first") - one global block, since ZAO's phone
 * side has no single "project root" to put a per-project file in.
 *
 * This is a different, complementary thing: a per-PROJECT log of WHY
 * specific choices were made DURING the work - "used SQLite over a
 * flat JSON file because concurrent writes needed real locking", "kept
 * the auth check in middleware rather than each route because three
 * routes needed it and a fourth is coming" - the reasoning a person
 * (or a future session) would otherwise have to reconstruct by reading
 * commit history or asking "wait, why is this like this?" again.
 *
 * WHERE IT LIVES: a plain markdown file INSIDE the project folder
 * itself, on the PC's own disk (DECISIONS.md, at the project root) -
 * not a DB row, deliberately. Unlike ZAO.md's standing rules (global,
 * because there's no phone-side project root), a project's OWN
 * reasoning belongs WITH that project: it survives independently of
 * ZAO's local app data, travels with the project if it's ever moved or
 * shared, and is readable by anyone who opens the folder directly, not
 * just future ZAO sessions. This mirrors how a real engineering team
 * would keep a decisions log - alongside the code, in version control,
 * not buried in a tool's private database.
 *
 * FORMAT: append-only, dated entries - never rewrites or removes past
 * entries (recordDecision only ever adds), since a change in direction
 * is itself worth keeping ("originally used X, switched to Y because
 * Z" is more useful than silently deleting the X entry). Kept as plain
 * markdown, not JSON, specifically so a person can open and read it
 * like a normal file without needing ZAO to render it.
 */

import { readFile, createFile } from './pcFilesystemTool';

const DECISIONS_FILENAME = 'DECISIONS.md';
const MAX_LOG_CHARS = 20000; // generous for a real project's lifetime of decisions; see trimIfNeeded below for what happens past this

function decisionsPath(projectPath) {
  const base = (projectPath || '').replace(/[\\/]+$/, '');
  return base ? `${base}/${DECISIONS_FILENAME}` : DECISIONS_FILENAME;
}

/**
 * Appends one dated decision entry to the project's DECISIONS.md,
 * creating the file with a header if it doesn't exist yet.
 *
 * @param {object} args
 * @param {string} [args.projectPath] - project folder, relative to
 *   PC_BRIDGE_ROOT; omit for the PC's configured project root
 * @param {string} args.decision - what was decided/built (one line, e.g. "Used SQLite instead of a flat JSON file for the cache layer")
 * @param {string} args.reasoning - WHY - the part that actually gets lost otherwise
 * @param {string} [args.alternativesConsidered] - what else was considered and rejected, if relevant
 * @returns {Promise<{success, data, error}>}
 */
export async function recordDecision({ projectPath = null, decision, reasoning, alternativesConsidered = null } = {}) {
  if (!decision || !reasoning) {
    return { success: false, data: null, error: { message: 'Both decision and reasoning are required - a decision without its reasoning defeats the entire point of this log.' } };
  }

  const path = decisionsPath(projectPath);
  const existing = await readFile(path).catch(() => ({ success: false }));
  const existingContent = existing.success && typeof existing.data?.content === 'string' ? existing.data.content : null;

  const header = '# Project Decisions Log\n\nWhy things are built the way they are - appended to as the project evolves, never edited or removed, so past reasoning stays visible even after a later change.\n';
  const base = existingContent && existingContent.trim() ? existingContent : header;

  const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  const entryLines = [
    '',
    `## ${timestamp} - ${decision}`,
    '',
    reasoning,
  ];
  if (alternativesConsidered) {
    entryLines.push('', `**Considered and rejected:** ${alternativesConsidered}`);
  }
  entryLines.push('');

  let updated = `${base}${entryLines.join('\n')}`;
  updated = trimIfNeeded(updated, header);

  const writeResult = await createFile(path, updated, { overwrite: true });
  if (!writeResult.success) return { success: false, data: null, error: writeResult.error };

  return { success: true, data: { path, entryCount: countEntries(updated) }, error: null };
}

/**
 * Reads the project's decisions log as-is, for the model to check past
 * reasoning before making a related change ("did we already decide
 * against this approach, and why?").
 *
 * @param {object} args
 * @param {string} [args.projectPath]
 * @returns {Promise<{success, data: {path, content, exists}, error}>}
 */
export async function readDecisions({ projectPath = null } = {}) {
  const path = decisionsPath(projectPath);
  const result = await readFile(path).catch(() => ({ success: false }));
  if (!result.success) {
    return { success: true, data: { path, content: '', exists: false }, error: null };
  }
  return { success: true, data: { path, content: result.data.content, exists: true }, error: null };
}

/**
 * If the log grows past MAX_LOG_CHARS, drops the OLDEST entries (right
 * after the header) rather than the newest - recent reasoning is what a
 * current session actually needs; very old entries about
 * long-since-changed decisions matter least. Never silently truncates
 * mid-entry - always cuts at an entry boundary (a "## " heading line)
 * so what remains is always complete, readable entries.
 */
function trimIfNeeded(content, header) {
  if (content.length <= MAX_LOG_CHARS) return content;

  const entryStarts = [...content.matchAll(/\n(?=## )/g)].map((m) => m.index + 1);
  for (const cutPoint of entryStarts) {
    const candidate = header + content.slice(cutPoint);
    if (candidate.length <= MAX_LOG_CHARS) return candidate;
  }
  // Even dropping every entry but the last one is still too long (one
  // enormous entry) - keep it anyway rather than truncating mid-entry;
  // an oversized-but-complete log is more useful than a corrupted one.
  return content;
}

function countEntries(content) {
  return (content.match(/\n## /g) || []).length;
}
