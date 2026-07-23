/**
 * ZAO - Filesystem Tool
 *
 * Real device-wide file operations (create, move, rename, delete, zip,
 * extract) under /storage/emulated/0/ - not just the app's own private
 * sandbox. This is a plugin behind the chat interface: the person never
 * sees a "file manager" screen for this - the local coder model decides when a
 * request needs it and calls these functions directly (see
 * src/services/toolOrchestrator.js).
 *
 * WHY STORAGE ACCESS FRAMEWORK (SAF), NOT PLAIN FILE PATHS: modern
 * Android (10+) blocks apps from reading/writing arbitrary paths under
 * /storage/emulated/0/ via normal file APIs - this is Android's Scoped
 * Storage restriction, not a limitation ZAO's code could route around.
 * The only working mechanism for genuine device-wide access is SAF: the
 * person grants access to a folder ONCE through Android's own system
 * picker (see requestAccess() below), and the app receives a persistent
 * content:// URI it can use going forward - stored in
 * preferences.filesystem_saf_uri (src/db/database.js) so this only ever
 * needs to happen once, not on every app launch.
 *
 * PRACTICAL IMPLICATION: every path this tool works with is relative to
 * whichever folder the person granted (e.g. granting the root Download
 * folder means paths like "myproject/App.js" resolve under
 * Download/myproject/App.js) - it is NOT unrestricted root filesystem
 * access, since Android itself doesn't allow that to any app, ZAO
 * included. If the person wants access to a different top-level folder
 * later, they re-grant via the same picker in Settings.
 */

import * as FileSystem from 'expo-file-system/legacy';
import JSZip from 'jszip';
import { getPreferences, updatePreferences, getCheckpoint } from '../../db/database';
import * as checkpointManager from '../execution/checkpointManager';
import * as syntaxCheck from '../execution/syntaxCheck';

// Directories never worth syntax-checking as part of a whole-project scan
// (checkProjectSyntax below) - vendored/generated/build output the model
// didn't write and shouldn't be asked to fix, and in node_modules' case,
// walking it would make the scan slow for no benefit.
const PROJECT_SCAN_EXCLUDE_RE = /(^|\/)(node_modules|\.git|android|ios|build|dist|\.expo|\.expo-shared)(\/|$)/;

const { StorageAccessFramework } = FileSystem;

// Used whenever a file is (re)created via StorageAccessFramework.createFileAsync
// - createFile/renameEntry/moveEntry all need a real MIME type, not a
// hardcoded 'text/plain', since this tool handles binary files (images,
// zips, APKs, etc.) just as often as text ones. Falls back to a generic
// binary type for anything unrecognized, which is always safe even if
// not maximally descriptive.
const MIME_TYPES = {
  txt: 'text/plain', md: 'text/markdown', json: 'application/json',
  js: 'text/javascript', jsx: 'text/javascript', ts: 'text/typescript', tsx: 'text/typescript',
  html: 'text/html', css: 'text/css', csv: 'text/csv', xml: 'application/xml',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  pdf: 'application/pdf', zip: 'application/zip', apk: 'application/vnd.android.package-archive',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  mp3: 'audio/mpeg', mp4: 'video/mp4', wav: 'audio/wav',
};

function guessMimeType(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

async function getGrantedDirUri() {
  const prefsResult = await getPreferences();
  return prefsResult?.data?.filesystem_saf_uri || null;
}

/**
 * Triggers Android's system folder picker so the person can grant access
 * to a real device folder (e.g. the whole Download folder, or a specific
 * project folder). Only needs to be called once - the returned URI is
 * persisted automatically. Must be called from a user-initiated action
 * (a button tap), not silently from a background tool call - Android
 * requires the picker to originate from direct user interaction.
 */
export async function requestAccess() {
  try {
    const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permission.granted) {
      return { success: false, data: null, error: { message: 'Folder access was not granted.' } };
    }
    await updatePreferences({ filesystem_saf_uri: permission.directoryUri });
    return { success: true, data: { directoryUri: permission.directoryUri }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Could not request folder access.' } };
  }
}

export async function hasAccess() {
  const uri = await getGrantedDirUri();
  return !!uri;
}

/**
 * Public entry point for OTHER tool modules (PDF, Office, etc.) that need
 * to write their own binary output through the same granted SAF
 * directory, without duplicating the path-resolution/permission-checking
 * logic in this file. Returns a real content:// URI ready for
 * FileSystem.writeAsStringAsync - the caller is responsible for encoding
 * (base64 for binary formats like PDF/DOCX/XLSX/PPTX).
 *
 * @param {string} relativePath - e.g. "reports/pitch.pdf"
 * @param {string} mimeType - used when the file doesn't exist yet and needs creating
 */
export async function getOrCreateFileUriForTools(relativePath, mimeType = 'application/octet-stream') {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const resolved = await resolveUri(relativePath, baseDirUri, { createIntermediateDirs: true });
  if (!resolved.success) return { success: false, data: null, error: { message: resolved.error } };

  try {
    const existingEntries = await StorageAccessFramework.readDirectoryAsync(resolved.dirUri).catch(() => []);
    const existingMatch = existingEntries.find((uri) => decodeURIComponent(uri).endsWith(`/${resolved.fileName}`));
    const fileUri = existingMatch || await StorageAccessFramework.createFileAsync(resolved.dirUri, resolved.fileName, mimeType);
    return { success: true, data: { uri: fileUri }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not prepare ${relativePath} for writing.` } };
  }
}

/**
 * Public entry point for reading an EXISTING file's URI, for other tool
 * modules that need to load a file's bytes (e.g. mergePdfs/splitPdf
 * reading a source PDF).
 */
export async function getExistingFileUriForTools(relativePath) {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const entryUri = await findEntryUri(relativePath, baseDirUri);
  if (!entryUri) {
    return { success: false, data: null, error: { message: `${relativePath} does not exist.` } };
  }
  return { success: true, data: { uri: entryUri }, error: null };
}

function requireAccessError() {
  return {
    success: false,
    data: null,
    error: {
      message: 'No folder access granted yet. Open Settings > Filesystem and grant access to a folder first.',
    },
  };
}

/**
 * Resolves a relative path (e.g. "myproject/src/App.js") to a full SAF
 * URI under the granted directory. SAF doesn't work with plain path
 * strings the way normal filesystem APIs do - every level needs its own
 * content:// URI, built up one path segment at a time.
 */
async function resolveUri(relativePath, baseDirUri, { createIntermediateDirs = false } = {}) {
  const segments = relativePath.split('/').filter(Boolean);
  let currentDirUri = baseDirUri;

  for (let i = 0; i < segments.length - 1; i++) {
    const existing = await StorageAccessFramework.readDirectoryAsync(currentDirUri).catch(() => []);
    const match = existing.find((uri) => decodeURIComponent(uri).endsWith(`/${segments[i]}`));

    if (match) {
      currentDirUri = match;
    } else if (createIntermediateDirs) {
      currentDirUri = await StorageAccessFramework.makeDirectoryAsync(currentDirUri, segments[i]);
    } else {
      return { success: false, error: `Folder "${segments[i]}" does not exist.` };
    }
  }

  return { success: true, dirUri: currentDirUri, fileName: segments[segments.length - 1] };
}

/**
 * Creates a new file with the given text content at a path relative to
 * the granted folder, creating any missing intermediate folders along
 * the way (e.g. "myproject/src/App.js" creates myproject/ and
 * myproject/src/ if they don't already exist).
 */
export async function createFile(relativePath, content) {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  // SYNTAX / JSX CHECK - fails closed, before anything else touches disk.
  // Every .js/.jsx/.mjs/.cjs/.ts/.tsx/.json write is parsed with the real
  // parser (syntaxCheck.js) first; a broken file is refused outright, the
  // same way Claude Code's own Write tool won't save unparseable code. No
  // checkpoint is even taken on failure, since nothing changed.
  if (syntaxCheck.isCheckableFile(relativePath)) {
    const check = syntaxCheck.checkSyntax(relativePath, content);
    if (!check.valid) {
      return {
        success: false,
        data: null,
        error: { message: syntaxCheck.formatSyntaxErrors(relativePath, check), syntaxErrors: check.errors },
      };
    }
  }

  const resolved = await resolveUri(relativePath, baseDirUri, { createIntermediateDirs: true });
  if (!resolved.success) return { success: false, data: null, error: { message: resolved.error } };

  // Checkpoint BEFORE the write - covers the "create" landing on top of
  // something that already existed at that path (a re-create/overwrite),
  // not just genuinely brand-new files. previousContentB64 comes back
  // null for a real brand-new file, which checkpointManager.snapshot()
  // records correctly as "nothing existed before."
  const previousContentB64 = await readEntryBase64IfExists(relativePath, baseDirUri);
  const checkpointId = await checkpointManager.snapshot({ path: relativePath, operation: 'create', previousContentB64 });

  try {
    const fileUri = await StorageAccessFramework.createFileAsync(resolved.dirUri, resolved.fileName, guessMimeType(resolved.fileName));
    await FileSystem.writeAsStringAsync(fileUri, content, { encoding: FileSystem.EncodingType.UTF8 });
    return { success: true, data: { path: relativePath, uri: fileUri, checkpointId }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not create ${relativePath}.` } };
  }
}

/**
 * Creates a folder (and any missing intermediate folders) at a path
 * relative to the granted directory.
 */
export async function createFolder(relativePath) {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const segments = relativePath.split('/').filter(Boolean);
  let currentDirUri = baseDirUri;

  try {
    for (const segment of segments) {
      const existing = await StorageAccessFramework.readDirectoryAsync(currentDirUri).catch(() => []);
      const match = existing.find((uri) => decodeURIComponent(uri).endsWith(`/${segment}`));
      currentDirUri = match || (await StorageAccessFramework.makeDirectoryAsync(currentDirUri, segment));
    }
    return { success: true, data: { path: relativePath, uri: currentDirUri }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not create folder ${relativePath}.` } };
  }
}

/**
 * Resolves a relative FOLDER path (not a file) to its SAF directory URI,
 * creating intermediate folders along the way if requested. This is
 * resolveUri()'s directory-only counterpart - resolveUri expects the last
 * path segment to be a filename, which isn't the right shape when the
 * thing being resolved is itself a destination folder (move/zip/extract
 * targets, or a plain folder listing).
 */
async function resolveDirUri(relativeFolderPath, baseDirUri, { createIntermediateDirs = false } = {}) {
  const segments = relativeFolderPath.split('/').filter(Boolean);
  let currentDirUri = baseDirUri;

  for (const segment of segments) {
    const existing = await StorageAccessFramework.readDirectoryAsync(currentDirUri).catch(() => []);
    const match = existing.find((uri) => decodeURIComponent(uri).endsWith(`/${segment}`));

    if (match) {
      currentDirUri = match;
    } else if (createIntermediateDirs) {
      currentDirUri = await StorageAccessFramework.makeDirectoryAsync(currentDirUri, segment);
    } else {
      return { success: false, error: `Folder "${segment}" does not exist.` };
    }
  }

  return { success: true, dirUri: currentDirUri };
}

async function findEntryUri(relativePath, baseDirUri) {
  const resolved = await resolveUri(relativePath, baseDirUri);
  if (!resolved.success) return null;

  const entries = await StorageAccessFramework.readDirectoryAsync(resolved.dirUri).catch(() => []);
  return entries.find((uri) => decodeURIComponent(uri).endsWith(`/${resolved.fileName}`)) || null;
}

/**
 * Reads a file's exact current content as base64 for checkpointManager.js
 * to snapshot BEFORE a mutating call overwrites/removes it - base64
 * because this has to round-trip any file type (binary included), same
 * reasoning as renameEntry/moveEntry's own base64 reads below. Returns
 * null (not an error) when the entry doesn't exist yet, which
 * checkpointManager.snapshot() treats as "this was a brand-new file."
 */
async function readEntryBase64IfExists(relativePath, baseDirUri) {
  const entryUri = await findEntryUri(relativePath, baseDirUri);
  if (!entryUri) return null;
  try {
    return await FileSystem.readAsStringAsync(entryUri, { encoding: FileSystem.EncodingType.Base64 });
  } catch {
    return null;
  }
}

/**
 * Writes base64 content directly to a binary file - the counterpart to
 * createFile() (which is UTF8 text only) for anything that's actually
 * bytes: an APK/bundle pulled from the PC file bridge (see
 * pcFilePullTool.js), an image, a zip, etc. Same checkpoint-before-write
 * safety as createFile, minus the syntax-check gate (binary content
 * can't be parsed as JS/JSON anyway).
 *
 * @param {string} relativePath
 * @param {string} contentB64 - base64-encoded bytes
 * @param {string} [mimeType]
 */
export async function writeBinaryFileFromBase64(relativePath, contentB64, mimeType = 'application/octet-stream') {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const previousContentB64 = await readEntryBase64IfExists(relativePath, baseDirUri);
  const checkpointId = await checkpointManager.snapshot({ path: relativePath, operation: 'create', previousContentB64 });

  const prepared = await getOrCreateFileUriForTools(relativePath, mimeType);
  if (!prepared.success) return prepared;

  try {
    await FileSystem.writeAsStringAsync(prepared.data.uri, contentB64, { encoding: FileSystem.EncodingType.Base64 });
    return { success: true, data: { path: relativePath, uri: prepared.data.uri, checkpointId }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not write ${relativePath}.` } };
  }
}

/**
 * Deletes a file or folder at a path relative to the granted directory.
 *
 * Folders get a BATCH checkpoint instead of the usual per-file one: every
 * file under the folder is snapshotted (base64 content, relative path)
 * BEFORE anything is deleted, as one folder_checkpoints row via
 * checkpointManager.snapshotFolder(). That's what makes "delete the
 * latest folder and go back to the last checkpoint" one atomic call
 * (rewindFolderCheckpoint() below) instead of restoring N separate
 * per-file checkpoints by hand. A plain file delete is unchanged - still
 * the lightweight per-file snapshot() path.
 */
export async function deleteEntry(relativePath) {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const entryUri = await findEntryUri(relativePath, baseDirUri);
  if (!entryUri) {
    return { success: false, data: null, error: { message: `${relativePath} does not exist.` } };
  }

  const info = await FileSystem.getInfoAsync(entryUri).catch(() => null);

  if (info?.isDirectory) {
    // Recursively collect every file under this folder, base64-encoded,
    // before anything is touched. walkFiles() only returns files (not
    // empty subfolders) - that's fine, since recreating a file with
    // createIntermediateDirs rebuilds its parent folders automatically.
    const files = await walkFiles(entryUri, relativePath);
    const entries = [];
    for (const file of files) {
      const contentB64 = await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.Base64 }).catch(() => null);
      entries.push({ relativePath: file.relativePath, contentB64, isDir: false });
    }

    const folderCheckpointId = await checkpointManager.snapshotFolder({ rootPath: relativePath, operation: 'delete', entries });

    try {
      await StorageAccessFramework.deleteAsync(entryUri);
      return { success: true, data: { path: relativePath, folderCheckpointId, fileCount: entries.length }, error: null };
    } catch (err) {
      return { success: false, data: null, error: { message: err?.message || `Could not delete folder ${relativePath}.` } };
    }
  }

  const previousContentB64 = await readEntryBase64IfExists(relativePath, baseDirUri);
  const checkpointId = await checkpointManager.snapshot({ path: relativePath, operation: 'delete', previousContentB64 });

  try {
    await StorageAccessFramework.deleteAsync(entryUri);
    return { success: true, data: { path: relativePath, checkpointId }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not delete ${relativePath}.` } };
  }
}

/**
 * Renames a file or folder in place (same parent directory, new name).
 * SAF has no native "rename" primitive for a URI directly on every
 * Android version, so this reads the content, creates a new entry with
 * the new name, and deletes the old one - functionally identical to a
 * rename from the person's perspective, at the cost of an extra
 * read/write for the file's actual content.
 */
export async function renameEntry(relativePath, newName) {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const resolved = await resolveUri(relativePath, baseDirUri);
  if (!resolved.success) return { success: false, data: null, error: { message: resolved.error } };

  const entryUri = await findEntryUri(relativePath, baseDirUri);
  if (!entryUri) {
    return { success: false, data: null, error: { message: `${relativePath} does not exist.` } };
  }

  try {
    // base64, not UTF8 - this function handles any file type (images,
    // zips, APKs, not just plain text), and reading/writing binary
    // content as UTF8 corrupts it (multi-byte sequences that aren't valid
    // UTF8 get mangled or dropped). base64 round-trips any byte content
    // safely regardless of what the file actually contains.
    const content = await FileSystem.readAsStringAsync(entryUri, { encoding: FileSystem.EncodingType.Base64 });
    const newRelativePath = relativePath.split('/').slice(0, -1).concat(newName).join('/');
    const checkpointId = await checkpointManager.snapshot({ path: newRelativePath, operation: 'rename', previousContentB64: content, previousPath: relativePath });

    const newUri = await StorageAccessFramework.createFileAsync(resolved.dirUri, newName, guessMimeType(newName));
    await FileSystem.writeAsStringAsync(newUri, content, { encoding: FileSystem.EncodingType.Base64 });
    await StorageAccessFramework.deleteAsync(entryUri);

    return { success: true, data: { oldPath: relativePath, newPath: newRelativePath, checkpointId }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not rename ${relativePath}.` } };
  }
}

/**
 * Moves (or copies, if keepOriginal is true) a file to a different
 * folder within the granted directory. Same underlying mechanism as
 * renameEntry - SAF has no native move primitive, so this is
 * read-then-write-then-optionally-delete.
 */
export async function moveEntry(sourcePath, destinationFolderPath, { keepOriginal = false } = {}) {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const sourceUri = await findEntryUri(sourcePath, baseDirUri);
  if (!sourceUri) {
    return { success: false, data: null, error: { message: `${sourcePath} does not exist.` } };
  }

  const destResolved = await resolveDirUri(destinationFolderPath, baseDirUri, { createIntermediateDirs: true });
  if (!destResolved.success) return { success: false, data: null, error: { message: destResolved.error } };

  const fileName = sourcePath.split('/').filter(Boolean).pop();

  try {
    // base64, not UTF8 - same reasoning as renameEntry above: this
    // function moves/copies any file type, and UTF8 read/write would
    // corrupt binary content.
    const content = await FileSystem.readAsStringAsync(sourceUri, { encoding: FileSystem.EncodingType.Base64 });
    const destinationPath = `${destinationFolderPath}/${fileName}`;
    // Only checkpointed when the move actually removes the source
    // (keepOriginal=false, i.e. a real move) - a copy leaves the
    // original untouched, so there's nothing there to need a rewind for.
    const checkpointId = keepOriginal
      ? null
      : await checkpointManager.snapshot({ path: destinationPath, operation: 'move', previousContentB64: content, previousPath: sourcePath });

    const newUri = await StorageAccessFramework.createFileAsync(destResolved.dirUri, fileName, guessMimeType(fileName));
    await FileSystem.writeAsStringAsync(newUri, content, { encoding: FileSystem.EncodingType.Base64 });

    if (!keepOriginal) {
      await StorageAccessFramework.deleteAsync(sourceUri);
    }

    return {
      success: true,
      data: { sourcePath, destinationPath, copied: keepOriginal, checkpointId },
      error: null,
    };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not move ${sourcePath}.` } };
  }
}

/**
 * Recursively reads every file under a folder (relative to the granted
 * directory) and packages them into a single .zip file, written back
 * into the granted directory at zipOutputPath.
 */
export async function zipFolder(folderPath, zipOutputPath) {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const resolved = await resolveDirUri(folderPath, baseDirUri);
  if (!resolved.success) return { success: false, data: null, error: { message: resolved.error } };

  const zip = new JSZip();

  async function addDirToZip(dirUri, zipFolderObj) {
    const entries = await StorageAccessFramework.readDirectoryAsync(dirUri);
    for (const entryUri of entries) {
      const name = decodeURIComponent(entryUri).split('/').pop();
      const info = await FileSystem.getInfoAsync(entryUri).catch(() => null);
      if (info?.isDirectory) {
        await addDirToZip(entryUri, zipFolderObj.folder(name));
      } else {
        const content = await FileSystem.readAsStringAsync(entryUri, { encoding: FileSystem.EncodingType.Base64 });
        zipFolderObj.file(name, content, { base64: true });
      }
    }
  }

  try {
    await addDirToZip(resolved.dirUri, zip);
    const zipBase64 = await zip.generateAsync({ type: 'base64' });

    const outResolved = await resolveUri(zipOutputPath, baseDirUri, { createIntermediateDirs: true });
    if (!outResolved.success) return { success: false, data: null, error: { message: outResolved.error } };

    const zipUri = await StorageAccessFramework.createFileAsync(outResolved.dirUri, outResolved.fileName, 'application/zip');
    await FileSystem.writeAsStringAsync(zipUri, zipBase64, { encoding: FileSystem.EncodingType.Base64 });

    return { success: true, data: { zipPath: zipOutputPath }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Could not create ZIP archive.' } };
  }
}

/**
 * Extracts a .zip file (relative to the granted directory) into a
 * destination folder, recreating its internal folder structure.
 */
export async function extractZip(zipPath, destinationFolderPath) {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const zipUri = await findEntryUri(zipPath, baseDirUri);
  if (!zipUri) {
    return { success: false, data: null, error: { message: `${zipPath} does not exist.` } };
  }

  try {
    const base64Data = await FileSystem.readAsStringAsync(zipUri, { encoding: FileSystem.EncodingType.Base64 });
    const zip = await JSZip.loadAsync(base64Data, { base64: true });

    const destResolved = await resolveDirUri(destinationFolderPath, baseDirUri, { createIntermediateDirs: true });
    if (!destResolved.success) return { success: false, data: null, error: { message: destResolved.error } };

    // Cache of already-created folder URIs within this extraction, keyed
    // by their path from the zip root - avoids re-resolving/re-creating
    // the same intermediate folder for every file inside it.
    const dirUriCache = { '': destResolved.dirUri };

    async function getOrCreateDir(path) {
      if (dirUriCache[path]) return dirUriCache[path];
      const parentPath = path.split('/').slice(0, -1).join('/');
      const name = path.split('/').pop();
      const parentUri = await getOrCreateDir(parentPath);
      const dirUri = await StorageAccessFramework.makeDirectoryAsync(parentUri, name);
      dirUriCache[path] = dirUri;
      return dirUri;
    }

    let extractedCount = 0;
    for (const [entryPath, entry] of Object.entries(zip.files)) {
      if (entry.dir) continue;
      const parentPath = entryPath.split('/').slice(0, -1).join('/');
      const fileName = entryPath.split('/').pop();
      const parentDirUri = await getOrCreateDir(parentPath);

      const content = await entry.async('base64');
      const fileUri = await StorageAccessFramework.createFileAsync(parentDirUri, fileName, 'application/octet-stream');
      await FileSystem.writeAsStringAsync(fileUri, content, { encoding: FileSystem.EncodingType.Base64 });
      extractedCount++;
    }

    return { success: true, data: { destinationFolderPath, filesExtracted: extractedCount }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not extract ${zipPath}.` } };
  }
}

// File extensions readFile/grep/glob treat as text - anything else is
// skipped (grep/glob) or rejected with a clear error (readFile), since
// reading binary content (images, zips, APKs) as UTF8 would corrupt/
// garble it rather than produce anything useful for the model to read.
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'json', 'js', 'jsx', 'ts', 'tsx', 'html', 'htm', 'css', 'scss',
  'csv', 'xml', 'yml', 'yaml', 'py', 'java', 'kt', 'kts', 'c', 'cc', 'cpp', 'h', 'hpp',
  'cs', 'go', 'rs', 'rb', 'php', 'sh', 'bat', 'ps1', 'sql', 'gradle', 'properties', 'env',
  'gitignore', 'log', 'ini', 'toml', 'cfg', 'swift', 'dart', 'vue', 'svelte',
]);

function isTextFile(fileName) {
  const ext = fileName.split('.').pop()?.toLowerCase();
  return TEXT_EXTENSIONS.has(ext);
}

/**
 * Recursively walks the granted directory (or a subfolder of it),
 * yielding { relativePath, name, uri } for every FILE found (folders are
 * descended into, not yielded themselves). Shared by grep()/globFiles()
 * so both search operations use one consistent, depth-first walk instead
 * of two slightly different ones.
 */
async function walkFiles(dirUri, relativePrefix) {
  const files = [];
  const entries = await StorageAccessFramework.readDirectoryAsync(dirUri).catch(() => []);

  for (const entryUri of entries) {
    const name = decodeURIComponent(entryUri).split('/').pop();
    const entryRelativePath = relativePrefix ? `${relativePrefix}/${name}` : name;
    const info = await FileSystem.getInfoAsync(entryUri).catch(() => null);

    if (info?.isDirectory) {
      files.push(...(await walkFiles(entryUri, entryRelativePath)));
    } else if (info) {
      files.push({ relativePath: entryRelativePath, name, uri: entryUri });
    }
  }

  return files;
}

/**
 * Reads a text file's content, optionally restricted to a 1-indexed line
 * range - the Read equivalent for this device-filesystem tool. Content
 * comes back with line numbers prefixed (matching how Claude Code's own
 * Read tool presents file content), since that's what lets the model
 * refer back to "line 42" unambiguously in a later fs_edit_file call.
 *
 * @param {string} relativePath
 * @param {{startLine?: number, endLine?: number}} [range] - 1-indexed, inclusive. Omit both to read the whole file.
 */
export async function readFile(relativePath, range = {}) {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  if (!isTextFile(relativePath)) {
    return { success: false, data: null, error: { message: `${relativePath} doesn't look like a text file - readFile only supports text content.` } };
  }

  const entryUri = await findEntryUri(relativePath, baseDirUri);
  if (!entryUri) {
    return { success: false, data: null, error: { message: `${relativePath} does not exist.` } };
  }

  try {
    const content = await FileSystem.readAsStringAsync(entryUri, { encoding: FileSystem.EncodingType.UTF8 });
    const allLines = content.split('\n');
    const totalLines = allLines.length;

    const startLine = Math.max(1, range.startLine || 1);
    const endLine = Math.min(totalLines, range.endLine || totalLines);
    const selected = allLines.slice(startLine - 1, endLine);

    const numbered = selected.map((line, i) => `${startLine + i}\t${line}`).join('\n');

    return {
      success: true,
      data: { path: relativePath, content: numbered, totalLines, startLine, endLine },
      error: null,
    };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not read ${relativePath}.` } };
  }
}

/**
 * Searches file CONTENTS for a regex pattern across every text file
 * under a folder (recursively) - the Grep equivalent. Returns one entry
 * per matching line, capped at maxResults so a broad pattern over a big
 * folder can't return an unbounded response.
 *
 * @param {string} pattern - regex pattern (no delimiters), e.g. "TODO|FIXME"
 * @param {{path?: string, caseSensitive?: boolean, maxResults?: number}} [options]
 */
export async function grep(pattern, options = {}) {
  const { path: searchPath = '', caseSensitive = false, maxResults = 100 } = options;
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  let startDirUri = baseDirUri;
  if (searchPath) {
    const resolved = await resolveDirUri(searchPath, baseDirUri);
    if (!resolved.success) return { success: false, data: null, error: { message: resolved.error } };
    startDirUri = resolved.dirUri;
  }

  let regex;
  try {
    regex = new RegExp(pattern, caseSensitive ? 'g' : 'gi');
  } catch (err) {
    return { success: false, data: null, error: { message: `Invalid pattern: ${err.message}` } };
  }

  try {
    const files = await walkFiles(startDirUri, searchPath);
    const matches = [];

    for (const file of files) {
      if (matches.length >= maxResults) break;
      if (!isTextFile(file.name)) continue;

      const content = await FileSystem.readAsStringAsync(file.uri, { encoding: FileSystem.EncodingType.UTF8 }).catch(() => null);
      if (content == null) continue;

      const lines = content.split('\n');
      for (let i = 0; i < lines.length && matches.length < maxResults; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          matches.push({ path: file.relativePath, line: i + 1, text: lines[i].trim().slice(0, 300) });
        }
      }
    }

    return { success: true, data: { pattern, matches, truncated: matches.length >= maxResults }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Grep search failed.' } };
  }
}

/**
 * Converts a simple glob pattern (*, **, ?) to a RegExp. Deliberately
 * minimal - no {a,b} brace expansion or [abc] character classes - since
 * this tool only needs to cover the common "find files by
 * name/extension" case (**\/*.js, src/**\/*.test.js), not be a full
 * glob implementation.
 */
function globToRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        out += '.*';
        i++;
        if (glob[i + 1] === '/') i++; // ** / also swallows the following slash
      } else {
        out += '[^/]*';
      }
    } else if (c === '?') {
      out += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`);
}

/**
 * Finds files by NAME pattern (not content) - the Glob equivalent.
 * Matches relative paths against a glob pattern like "**\/*.test.js" or
 * "src/*.json". Sorted so the most recently relevant results are easy to
 * scan (alphabetical - there's no reliable mtime through SAF to sort by
 * recency instead).
 *
 * @param {string} pattern - glob pattern, e.g. "**\/*.js"
 * @param {{path?: string, maxResults?: number}} [options]
 */
export async function globFiles(pattern, options = {}) {
  const { path: searchPath = '', maxResults = 200 } = options;
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  let startDirUri = baseDirUri;
  if (searchPath) {
    const resolved = await resolveDirUri(searchPath, baseDirUri);
    if (!resolved.success) return { success: false, data: null, error: { message: resolved.error } };
    startDirUri = resolved.dirUri;
  }

  let regex;
  try {
    regex = globToRegExp(pattern);
  } catch (err) {
    return { success: false, data: null, error: { message: `Invalid pattern: ${err.message}` } };
  }

  try {
    const files = await walkFiles(startDirUri, searchPath);
    const matched = files
      .map((f) => f.relativePath)
      .filter((p) => regex.test(p))
      .sort()
      .slice(0, maxResults);

    return { success: true, data: { pattern, paths: matched, truncated: matched.length >= maxResults }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Glob search failed.' } };
  }
}

/**
 * Precise, diff-based single-file edit - the Edit equivalent. Replaces
 * one exact occurrence of oldString with newString (unless replaceAll is
 * set), refusing to guess when oldString appears zero times (nothing to
 * anchor to) or more than once (ambiguous - which one?) so this can't
 * silently make the wrong change the way a blind "rewrite the whole
 * file" approach could. Always read the file (readFile, above) shortly
 * before calling this, so oldString is copied from real current content
 * rather than guessed from memory.
 *
 * @param {string} relativePath
 * @param {string} oldString - exact text to find (include enough surrounding context to be unique)
 * @param {string} newString - replacement text
 * @param {{replaceAll?: boolean}} [options]
 */
export async function editFile(relativePath, oldString, newString, options = {}) {
  const { replaceAll = false } = options;
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  if (oldString === newString) {
    return { success: false, data: null, error: { message: 'oldString and newString are identical - nothing to change.' } };
  }

  const entryUri = await findEntryUri(relativePath, baseDirUri);
  if (!entryUri) {
    return { success: false, data: null, error: { message: `${relativePath} does not exist.` } };
  }

  try {
    const content = await FileSystem.readAsStringAsync(entryUri, { encoding: FileSystem.EncodingType.UTF8 });
    const occurrences = content.split(oldString).length - 1;

    if (occurrences === 0) {
      return { success: false, data: null, error: { message: `oldString was not found in ${relativePath}. Re-read the file to get its exact current content before editing.` } };
    }
    if (occurrences > 1 && !replaceAll) {
      return { success: false, data: null, error: { message: `oldString appears ${occurrences} times in ${relativePath} - it must be unique, or pass replaceAll: true to change every occurrence.` } };
    }

    const updated = replaceAll
      ? content.split(oldString).join(newString)
      : content.replace(oldString, newString);

    // SYNTAX / JSX CHECK - checks the file's RESULTING content (after the
    // replace, not the diff in isolation - a perfectly valid snippet can
    // still land somewhere that breaks the surrounding file). Fails
    // closed: on a syntax error nothing is written and no checkpoint is
    // taken, exactly like createFile above.
    if (syntaxCheck.isCheckableFile(relativePath)) {
      const check = syntaxCheck.checkSyntax(relativePath, updated);
      if (!check.valid) {
        return {
          success: false,
          data: null,
          error: { message: syntaxCheck.formatSyntaxErrors(relativePath, check), syntaxErrors: check.errors },
        };
      }
    }

    const previousContentB64 = await FileSystem.readAsStringAsync(entryUri, { encoding: FileSystem.EncodingType.Base64 });
    const checkpointId = await checkpointManager.snapshot({ path: relativePath, operation: 'edit', previousContentB64 });

    await FileSystem.writeAsStringAsync(entryUri, updated, { encoding: FileSystem.EncodingType.UTF8 });

    return { success: true, data: { path: relativePath, occurrencesReplaced: replaceAll ? occurrences : 1, checkpointId }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not edit ${relativePath}.` } };
  }
}

/**
 * Runs the real syntax/JSX check (syntaxCheck.js) against a file already
 * on disk, standalone - createFile/editFile above already run this
 * automatically before every write, so this is for checking a file the
 * model didn't just write itself: after an external change, before
 * telling the person a file is ready, or as part of checkProjectSyntax
 * below. Non-code files (skipped by isCheckableFile) come back
 * { valid: true, skipped: true } rather than an error - checking them was
 * never meaningful in the first place.
 */
export async function checkFileSyntax(relativePath) {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  if (!syntaxCheck.isCheckableFile(relativePath)) {
    return { success: true, data: { path: relativePath, valid: true, skipped: true, errors: [] }, error: null };
  }

  const entryUri = await findEntryUri(relativePath, baseDirUri);
  if (!entryUri) {
    return { success: false, data: null, error: { message: `${relativePath} does not exist.` } };
  }

  try {
    const content = await FileSystem.readAsStringAsync(entryUri, { encoding: FileSystem.EncodingType.UTF8 });
    const result = syntaxCheck.checkSyntax(relativePath, content);
    return { success: true, data: { path: relativePath, ...result }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not check ${relativePath}.` } };
  }
}

/**
 * Recursively syntax/JSX-checks every checkable code file
 * (.js/.jsx/.mjs/.cjs/.ts/.tsx/.json) under a folder, skipping
 * node_modules/.git/android/ios/build/dist/.expo (PROJECT_SCAN_EXCLUDE_RE
 * above) - vendored or generated output isn't the model's to fix, and
 * walking node_modules would make this slow for no benefit.
 *
 * This is what backs BOTH the fs_check_project_syntax tool (the model
 * calling it directly, e.g. "make sure everything's clean before I run
 * this") AND projectRunGate.js's automatic pre-run gate in front of
 * terminal_pc_run_command - see that file's
 * header for the one real caveat (it checks the SAF-granted folder on
 * the phone, which may or may not be the exact folder a PC-backend
 * command actually runs against).
 *
 * @param {string} [relativePath] - folder to scan; '' scans the whole granted root
 */
export async function checkProjectSyntax(relativePath = '') {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  let startDirUri = baseDirUri;
  if (relativePath) {
    const resolved = await resolveDirUri(relativePath, baseDirUri);
    if (!resolved.success) return { success: false, data: null, error: { message: resolved.error } };
    startDirUri = resolved.dirUri;
  }

  try {
    const allFiles = await walkFiles(startDirUri, relativePath);
    const checkable = allFiles.filter(
      (f) => syntaxCheck.isCheckableFile(f.relativePath) && !PROJECT_SCAN_EXCLUDE_RE.test(f.relativePath)
    );

    const failures = [];
    for (const f of checkable) {
      try {
        const content = await FileSystem.readAsStringAsync(f.uri, { encoding: FileSystem.EncodingType.UTF8 });
        const result = syntaxCheck.checkSyntax(f.relativePath, content);
        if (!result.valid) failures.push({ path: f.relativePath, errors: result.errors });
      } catch (err) {
        failures.push({ path: f.relativePath, errors: [{ line: null, column: null, message: err?.message || 'Could not read file.' }] });
      }
    }

    return {
      success: true,
      data: { path: relativePath, filesChecked: checkable.length, valid: failures.length === 0, failures },
      error: null,
    };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Project syntax check failed.' } };
  }
}

/**
 * Lists the contents of a folder relative to the granted directory - not
 * one of the person's originally-requested capabilities, but included
 * since the local coder model will frequently need to check what's already there
 * before deciding what to create/move/rename.
 */
export async function listFolder(relativePath = '') {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  try {
    let dirUri = baseDirUri;
    if (relativePath) {
      const resolved = await resolveDirUri(relativePath, baseDirUri);
      if (!resolved.success) return { success: false, data: null, error: { message: resolved.error } };
      dirUri = resolved.dirUri;
    }

    const entries = await StorageAccessFramework.readDirectoryAsync(dirUri);
    const names = entries.map((uri) => decodeURIComponent(uri).split('/').pop());
    return { success: true, data: { path: relativePath, entries: names }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not list ${relativePath || '(root)'}.` } };
  }
}

/**
 * Restores the file state recorded by one checkpoint (checkpointManager.js /
 * edit_checkpoints table) - the actual "Esc Esc rewind" action. Lives here
 * rather than in checkpointManager.js so that module never needs to know
 * about SAF URIs (see that file's header for why). Handles all five
 * checkpointed operations:
 *   - create: previousContentB64 null -> the file didn't exist before, so
 *     rewinding deletes it. Non-null -> it overwrote something, so
 *     rewinding restores that prior content.
 *   - edit:   always overwrite with previousContentB64.
 *   - delete: the file no longer exists at all - rewinding recreates it
 *     from previousContentB64.
 *   - rename/move: the file now lives at `path`; rewinding recreates it
 *     at previousPath with the same content and removes it from `path`.
 */
export async function rewindToCheckpoint(checkpointId) {
  const checkpointResult = await getCheckpoint(checkpointId);
  const checkpoint = checkpointResult.data;
  if (!checkpoint) {
    return { success: false, data: null, error: { message: 'Checkpoint not found.' } };
  }

  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const { path, operation, previous_content_b64: previousContentB64, previous_path: previousPath } = checkpoint;

  try {
    if (operation === 'create' && !previousContentB64) {
      const entryUri = await findEntryUri(path, baseDirUri);
      if (entryUri) await StorageAccessFramework.deleteAsync(entryUri);
    } else if (operation === 'delete' || (operation === 'create' && previousContentB64)) {
      const resolved = await resolveUri(path, baseDirUri, { createIntermediateDirs: true });
      if (!resolved.success) return { success: false, data: null, error: { message: resolved.error } };
      const fileUri = await StorageAccessFramework.createFileAsync(resolved.dirUri, resolved.fileName, guessMimeType(resolved.fileName));
      await FileSystem.writeAsStringAsync(fileUri, previousContentB64, { encoding: FileSystem.EncodingType.Base64 });
    } else if (operation === 'edit') {
      const entryUri = await findEntryUri(path, baseDirUri);
      if (!entryUri) return { success: false, data: null, error: { message: `${path} no longer exists - cannot rewind an edit on a file that's been deleted since.` } };
      await FileSystem.writeAsStringAsync(entryUri, previousContentB64, { encoding: FileSystem.EncodingType.Base64 });
    } else if (operation === 'rename' || operation === 'move') {
      const currentUri = await findEntryUri(path, baseDirUri);
      const resolved = await resolveUri(previousPath, baseDirUri, { createIntermediateDirs: true });
      if (!resolved.success) return { success: false, data: null, error: { message: resolved.error } };
      const fileUri = await StorageAccessFramework.createFileAsync(resolved.dirUri, resolved.fileName, guessMimeType(resolved.fileName));
      await FileSystem.writeAsStringAsync(fileUri, previousContentB64, { encoding: FileSystem.EncodingType.Base64 });
      if (currentUri) await StorageAccessFramework.deleteAsync(currentUri);
    }

    await checkpointManager.markRewound(path, checkpoint.created_at);
    return { success: true, data: { checkpointId, path, operation }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not rewind checkpoint ${checkpointId}.` } };
  }
}

/**
 * Restores an entire folder in one shot, from a folder_checkpoints batch
 * recorded by deleteEntry() right before a directory delete (see above).
 * This is the "delete the latest folder and go back to the last
 * checkpoint" operation: every file that existed under the folder gets
 * recreated with its exact prior content, rebuilding the whole tree -
 * not just one file.
 *
 * Note: this restores the files as they were AT THAT CHECKPOINT. If the
 * folder was deleted and then something new was created at the same path
 * afterward, this will overwrite that newer content - by design, the
 * same "going back in time" trade-off a per-file rewind already has.
 *
 * @param {string} folderCheckpointId
 */
export async function rewindFolderCheckpoint(folderCheckpointId) {
  const batch = await checkpointManager.getFolder(folderCheckpointId);
  if (!batch) {
    return { success: false, data: null, error: { message: 'Folder checkpoint not found.' } };
  }

  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const restored = [];
  const failed = [];

  for (const entry of batch.entries) {
    if (entry.is_dir) continue; // walkFiles() never recorded bare dirs - files rebuild their own parents
    if (entry.content_b64 == null) continue; // nothing to restore this file to
    try {
      const resolved = await resolveUri(entry.relative_path, baseDirUri, { createIntermediateDirs: true });
      if (!resolved.success) { failed.push(entry.relative_path); continue; }
      const fileUri = await StorageAccessFramework.createFileAsync(resolved.dirUri, resolved.fileName, guessMimeType(resolved.fileName));
      await FileSystem.writeAsStringAsync(fileUri, entry.content_b64, { encoding: FileSystem.EncodingType.Base64 });
      restored.push(entry.relative_path);
    } catch {
      failed.push(entry.relative_path);
    }
  }

  await checkpointManager.markFolderRewound(folderCheckpointId);

  return {
    success: failed.length === 0,
    data: { rootPath: batch.root_path, restoredCount: restored.length, failedCount: failed.length, failed },
    error: failed.length ? { message: `${failed.length} file(s) could not be restored: ${failed.join(', ')}` } : null,
  };
}

/** Newest folder-checkpoint batches, for a "restore whole folder" list in Settings > Checkpoints. */
export async function listFolderCheckpoints(limit = 20) {
  return checkpointManager.listRecentFolders(limit);
}
