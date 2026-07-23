/**
 * ZAO - PC Filesystem Tool
 *
 * Real file operations (create folder, write file, targeted edit, read,
 * delete, list) against the PC's own disk, via the backend's /pc-fs/*
 * routes (server/pcFiles.js) - NOT the phone's on-device SAF storage
 * (see filesystem/filesystemTool.js, which is the older on-device tool).
 *
 * WHY THIS EXISTS: ZAO's development workflow now lives entirely on the
 * PC (no more phone/Termux dev) - terminal_pc_run_command already runs
 * npm/build/serve commands there. Before this file, the only way to
 * create source files was fs_create_file, which wrote into the phone's
 * SAF folder - a completely different machine terminal_pc_run_command
 * can't see. That split meant a scaffolded project and the terminal
 * building it were never looking at the same files. This tool writes
 * directly into PC_BRIDGE_ROOT (server/config.js) instead, so everything
 * - scaffolding, editing, and running/building - happens in one place.
 *
 * All paths are relative to PC_BRIDGE_ROOT, same as pcFilePullTool.js's
 * listDirectory/pullFile.
 */

import {
  writePcFile, mkdirPc, editPcFile, deletePcEntry, listPcDirectory, readPcFile,
  renamePcEntry, movePcEntry, writeBinaryPcFile, grepPc, globPc, listPcCheckpoints, rewindPcCheckpoint,
  zipPcFolder, extractPcZip,
} from '../backend/backendClient';
import { base64ToUtf8 } from '../shared/base64Utils';

/**
 * Creates a project folder (and any missing parent folders) on the PC.
 * The usual first step for any multi-file coding request - see
 * scaffoldProject() below for creating a folder plus its files in one
 * call.
 * @param {string} path - relative to PC_BRIDGE_ROOT, e.g. "my-landing-page"
 */
export async function createFolder(path) {
  const result = await mkdirPc(path);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Creates (or overwrites, if overwrite:true) one text file on the PC,
 * creating any missing parent folders along the way - so writing
 * "myproject/src/components/Header.js" works even before
 * "myproject/src/components" exists yet.
 * @param {string} path - relative to PC_BRIDGE_ROOT
 * @param {string} content
 * @param {{overwrite?: boolean}} [options]
 */
export async function createFile(path, content, options = {}) {
  const result = await writePcFile(path, content, options);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Convenience for a whole multi-file project in one call: creates the
 * project folder, then writes every given file into it. This is the
 * shape a "build me a landing page with HTML/CSS/JS" request should
 * normally use, rather than one mkdir + N separate createFile calls.
 * @param {string} folderPath - relative to PC_BRIDGE_ROOT
 * @param {Array<{path: string, content: string}>} files - paths relative to folderPath
 * @returns {Promise<{success: boolean, data: {folderPath, written: string[], failed: Array<{path, error}>}|null, error: object|null}>}
 */
export async function scaffoldProject(folderPath, files) {
  const folderResult = await createFolder(folderPath);
  if (!folderResult.success) return { success: false, data: null, error: folderResult.error };

  const written = [];
  const failed = [];
  for (const file of files || []) {
    const fullPath = `${folderPath}/${file.path}`.replace(/\/+/g, '/');
    // eslint-disable-next-line no-await-in-loop -- files must land in a
    // predictable order for a project scaffold, and this only ever runs
    // for one project at a time, not in a hot loop.
    const result = await createFile(fullPath, file.content, { overwrite: true });
    if (result.success) {
      written.push(fullPath);
    } else {
      failed.push({ path: fullPath, error: result.error?.message || 'Write failed' });
    }
  }

  return {
    success: failed.length === 0,
    data: { folderPath, written, failed },
    error: failed.length > 0 ? { message: `${failed.length} of ${files?.length || 0} file(s) failed to write.` } : null,
  };
}

/**
 * Makes a precise, targeted change to one existing text file on the PC -
 * oldString must match the file's current content exactly and uniquely
 * (or replaceAll must be passed). Prefer this over createFile with
 * overwrite:true when only part of a file needs to change.
 * @param {string} path - relative to PC_BRIDGE_ROOT
 * @param {string} oldString
 * @param {string} newString
 * @param {{replaceAll?: boolean}} [options]
 */
export async function editFile(path, oldString, newString, options = {}) {
  const result = await editPcFile(path, oldString, newString, options);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Deletes a file, or a folder and everything in it, on the PC. No
 * undo - same trust level as a terminal rm/del.
 * @param {string} path - relative to PC_BRIDGE_ROOT
 */
export async function deleteEntry(path) {
  const result = await deletePcEntry(path);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Lists a folder on the PC. Same underlying call as
 * pcFilePullTool.listDirectory() - kept here too so every PC filesystem
 * operation has one consistent home for the model to reason about.
 * @param {string} [path] - relative to PC_BRIDGE_ROOT; omit for PC_BRIDGE_ROOT itself
 */
export async function listFolder(path = '') {
  const result = await listPcDirectory(path);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Reads a text file's content from the PC, decoded from the /pc-fs/read
 * route's base64 payload back to a plain UTF-8 string - use this before
 * editFile() so oldString is copied from the file's real current
 * content, not guessed.
 * @param {string} path - relative to PC_BRIDGE_ROOT
 */
export async function readFile(path) {
  const result = await readPcFile(path);
  if (!result.success) return { success: false, data: null, error: result.error };
  const content = base64ToUtf8(result.data.contentB64);
  return { success: true, data: { path: result.data.path, size: result.data.size, content }, error: null };
}

/**
 * Renames a file or folder on the PC within its current parent folder.
 * @param {string} path - relative to PC_BRIDGE_ROOT
 * @param {string} newName - plain name, not a path
 */
export async function renameEntry(path, newName) {
  const result = await renamePcEntry(path, newName);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Moves a file or folder on the PC into a different destination folder.
 * @param {string} sourcePath - relative to PC_BRIDGE_ROOT
 * @param {string} destinationFolderPath - relative to PC_BRIDGE_ROOT ("" for the root itself)
 * @param {{keepOriginal?: boolean}} [options]
 */
export async function moveEntry(sourcePath, destinationFolderPath, options = {}) {
  const result = await movePcEntry(sourcePath, destinationFolderPath, options);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Creates (or, with overwrite:true, replaces) one binary file on the PC -
 * the createFile() counterpart for images/icons/generated assets that
 * aren't UTF-8 text. Content must already be base64-encoded.
 * @param {string} path - relative to PC_BRIDGE_ROOT
 * @param {string} contentB64
 * @param {{overwrite?: boolean}} [options]
 */
export async function writeBinaryFile(path, contentB64, options = {}) {
  const result = await writeBinaryPcFile(path, contentB64, options);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Literal substring search across text files on the PC - finds where
 * something is defined/used before deciding what to editFile().
 * @param {string} query
 * @param {{path?: string, caseSensitive?: boolean, maxResults?: number}} [options]
 */
export async function grep(query, options = {}) {
  const result = await grepPc(query, options);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Finds files on the PC by name pattern (e.g. "**\/*.test.js").
 * @param {string} pattern
 * @param {{path?: string}} [options]
 */
export async function glob(pattern, options = {}) {
  const result = await globPc(pattern, options);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Lists recent PC filesystem checkpoints (newest first) - each one was
 * recorded automatically right before a write/edit/delete/rename/move
 * mutated something, so an earlier state can be restored with
 * rewindCheckpoint().
 * @param {{limit?: number}} [options]
 */
export async function listCheckpoints(options = {}) {
  const result = await listPcCheckpoints(options);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Restores whatever a PC filesystem checkpoint captured - the file's/
 * folder's exact prior content, or removes what a create introduced if
 * it didn't exist before. No redo.
 * @param {string} checkpointId
 */
export async function rewindCheckpoint(checkpointId) {
  const result = await rewindPcCheckpoint(checkpointId);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Zips an entire folder on the PC into a real .zip file - skips
 * node_modules/.git/.zao-checkpoints/dist/build automatically. Handy
 * for packaging a finished project to hand to the person, or before
 * pc_pull_file brings it down to the phone.
 * @param {string} folderPath - relative to PC_BRIDGE_ROOT
 * @param {string} zipPath - relative to PC_BRIDGE_ROOT, e.g. "myproject.zip"
 */
export async function zipFolder(folderPath, zipPath) {
  const result = await zipPcFolder(folderPath, zipPath);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Unpacks an existing .zip on the PC into a destination folder (a
 * downloaded starter/template, or something the person dropped into the
 * project folder).
 * @param {string} zipPath - relative to PC_BRIDGE_ROOT
 * @param {string} destinationFolderPath - relative to PC_BRIDGE_ROOT ("" for the root itself)
 */
export async function extractZip(zipPath, destinationFolderPath) {
  const result = await extractPcZip(zipPath, destinationFolderPath);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}
