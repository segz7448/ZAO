/**
 * ZAO - Checkpoint Manager
 *
 * Every file-mutating filesystem tool call gets snapshotted BEFORE it
 * runs, independent of git - this works identically whether or not the
 * folder ZAO was granted access to (src/services/filesystem/filesystemTool.js)
 * has a .git in it at all, which most of ZAO's device-wide SAF folders
 * don't. Restoring ("Esc Esc" in Claude Code's terms) is exposed as
 * rewindToCheckpoint() in filesystemTool.js itself, not here - this
 * module only knows about the DB row, not SAF URIs, to avoid a circular
 * import (filesystemTool.js -> checkpointManager.js -> filesystemTool.js).
 *
 * Deliberately NOT git: a real git repo (when the PC terminal backend has
 * one - see worktrees.js) already has its own history, and nothing here
 * duplicates that. This is specifically for the much more common case in
 * ZAO - a plain folder with no version control - where a bad fs_edit_file
 * or fs_delete call would otherwise be unrecoverable.
 */

import { recordCheckpoint, getRecentCheckpoints, getCheckpointsForPath, getCheckpoint, markCheckpointsRewound } from '../../db/database';

function newCheckpointId() {
  return `ckpt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Snapshots a file's content (or its absence) immediately before a
 * mutating tool call touches it.
 *
 * @param {object} opts
 * @param {string} opts.path - relative path being mutated
 * @param {'create'|'edit'|'delete'|'rename'|'move'} opts.operation
 * @param {string|null} opts.previousContentB64 - the file's exact prior content, base64-encoded, or null if it didn't exist yet (a 'create' of a brand-new file)
 * @param {string|null} opts.previousPath - for rename/move, the path it lived at before
 * @param {string|null} opts.conversationId - which chat this happened in, for context in a future "checkpoints for this conversation" view
 */
export async function snapshot({ path, operation, previousContentB64 = null, previousPath = null, conversationId = null }) {
  const id = newCheckpointId();
  const result = await recordCheckpoint({
    id,
    conversationId,
    path,
    operation,
    previousContentB64,
    previousPath,
    existedBefore: previousContentB64 !== null || operation === 'delete' || operation === 'rename' || operation === 'move',
  });
  return result.success ? id : null;
}

/** Newest checkpoints across every path - the flat "rewind list" Settings > Checkpoints reads. */
export async function listRecent(limit = 50) {
  const result = await getRecentCheckpoints(limit);
  return result.data;
}

/** Undo history for one specific file. */
export async function listForPath(path) {
  const result = await getCheckpointsForPath(path);
  return result.data;
}

export async function get(checkpointId) {
  const result = await getCheckpoint(checkpointId);
  return result.data;
}

/** Call after a successful rewind so later checkpoints on the same path (now ahead of the restored content) aren't offered as "current" anymore. */
export async function markRewound(path, fromCreatedAt) {
  await markCheckpointsRewound(path, fromCreatedAt);
}
