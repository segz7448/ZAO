/**
 * ZAO Backend - Diff Formatting
 *
 * WHY THIS EXISTS: pcFiles.js's /pc-fs/edit and /pc-fs/delete handlers
 * already have BOTH the before and after content in memory at the
 * moment of every change (the "prior state" they already snapshot for
 * checkpoint rollback) - this module turns that into an actual, human-
 * readable diff instead of leaving that information unused once the
 * write completes. Two consumers:
 *   1. Every single-file edit gets `diff` in its response (cheap, and
 *      useful even for a small change).
 *   2. pcFiles.js's /pc-fs/preview-changes route (called from the phone
 *      via pcFilesystemTool.js's previewChanges(), registered as the
 *      pc_fs_preview_changes tool) calls this same formatter to build a
 *      combined diff summary across several proposed files - the
 *      "diff preview before a risky multi-file edit" feature - by
 *      reading each file's current content first and diffing it
 *      against the proposed new content, all before anything is written.
 *
 * Uses the `diff` npm package (Myers diff algorithm) rather than a
 * hand-rolled line-diff - a correct diff implementation is exactly the
 * kind of thing worth using a small, proven library for instead of
 * reinventing, and it adds no real weight to this server.
 */

const { diffLines } = require('diff');

const MAX_DIFF_CHARS = 6000; // keeps a single file's diff readable in a chat reply; a change this large is better summarized as "N lines changed" than shown in full

/**
 * @param {string} before - file content before the change ('' for a new file)
 * @param {string} after - file content after the change ('' for a deleted file)
 * @param {string} label - the file path, used as the diff's header
 * @returns {{ unified: string, linesAdded: number, linesRemoved: number, truncated: boolean }}
 */
function formatDiff(before, after, label) {
  const changes = diffLines(before || '', after || '');
  let linesAdded = 0;
  let linesRemoved = 0;
  const parts = [`--- ${label} (before)`, `+++ ${label} (after)`];

  for (const change of changes) {
    const lines = change.value.split('\n').filter((l, i, arr) => !(i === arr.length - 1 && l === ''));
    if (change.added) {
      linesAdded += lines.length;
      for (const line of lines) parts.push(`+ ${line}`);
    } else if (change.removed) {
      linesRemoved += lines.length;
      for (const line of lines) parts.push(`- ${line}`);
    } else {
      // Unchanged context - show at most 2 lines around a change rather
      // than the whole untouched middle of a large file, so the diff
      // stays focused on what actually changed.
      const contextLines = lines.length > 4 ? [...lines.slice(0, 2), `  ... (${lines.length - 4} unchanged lines) ...`, ...lines.slice(-2)] : lines;
      for (const line of contextLines) parts.push(`  ${line}`);
    }
  }

  let unified = parts.join('\n');
  let truncated = false;
  if (unified.length > MAX_DIFF_CHARS) {
    unified = `${unified.slice(0, MAX_DIFF_CHARS)}\n... (diff truncated - ${linesAdded} lines added, ${linesRemoved} lines removed total)`;
    truncated = true;
  }

  return { unified, linesAdded, linesRemoved, truncated };
}

module.exports = { formatDiff };
