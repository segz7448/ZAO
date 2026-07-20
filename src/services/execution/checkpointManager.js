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
 *
 * FOLDER (BATCH) CHECKPOINTS - added alongside the per-file checkpoints
 * above. A single fs_delete or fs_replace_folder on a directory now
 * snapshots EVERY file under it as one batch (see snapshotFolder()
 * below), so "delete the latest folder and go back to the last
 * checkpoint" is one atomic restore (rewindFolderCheckpoint() in
 * filesystemTool.js) instead of hunting down N individual per-file
 * checkpoints. Same non-git, same "caller does the SAF walk, this module
 * just persists rows" split as the per-file path.
 */

import {
  recordCheckpoint, getRecentCheckpoints, getCheckpointsForPath, getCheckpoint, markCheckpointsRewound,
  recordFolderCheckpoint, getRecentFolderCheckpoints, getFolderCheckpoint, markFolderCheckpointRewound,
} from '../../db/database';

function newCheckpointId() {
  return `ckpt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function newFolderCheckpointId() {
  return `fckpt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
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

// ---------------------------------------------------------------------------
// Folder (batch) checkpoints
// ---------------------------------------------------------------------------
// Same "checkpoint BEFORE the mutation" idea as snapshot() above, but for
// a whole directory at once - one batch id covers every file that
// existed under a root path right before a folder-level delete/replace,
// so a single rewindFolderCheckpoint(id) call in filesystemTool.js can
// restore the entire tree atomically instead of one file at a time.
// Like snapshot(), this module never walks the filesystem itself - the
// caller (filesystemTool.js, which already has SAF access) collects
// {relativePath, contentB64, isDir} for every entry under the root and
// hands the finished list here to persist.

/**
 * @param {object} opts
 * @param {string} opts.rootPath - the folder path (relative to the granted dir) being deleted/replaced
 * @param {'delete'|'replace'} opts.operation
 * @param {Array<{relativePath: string, contentB64: string|null, isDir: boolean}>} opts.entries - every file/folder found under rootPath, snapshotted BEFORE the mutation
 * @param {string|null} opts.conversationId
 * @returns {Promise<string|null>} the batch checkpoint id, or null on failure
 */
export async function snapshotFolder({ rootPath, operation, entries, conversationId = null }) {
  const id = newFolderCheckpointId();
  const result = await recordFolderCheckpoint({ id, conversationId, rootPath, operation, entries });
  return result.success ? id : null;
}

/** Newest folder-checkpoint batches - the "restore whole folder" list Settings > Checkpoints reads. */
export async function listRecentFolders(limit = 20) {
  const result = await getRecentFolderCheckpoints(limit);
  return result.data;
}

/** One batch, with all of its entries attached, for an actual restore. */
export async function getFolder(batchId) {
  const result = await getFolderCheckpoint(batchId);
  return result.data;
}

/** Call after a successful folder-level restore so it isn't offered again. */
export async function markFolderRewound(batchId) {
  await markFolderCheckpointRewound(batchId);
}
