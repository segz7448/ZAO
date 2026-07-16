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
import { getPreferences, updatePreferences } from '../../db/database';

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

  const resolved = await resolveUri(relativePath, baseDirUri, { createIntermediateDirs: true });
  if (!resolved.success) return { success: false, data: null, error: { message: resolved.error } };

  try {
    const fileUri = await StorageAccessFramework.createFileAsync(resolved.dirUri, resolved.fileName, guessMimeType(resolved.fileName));
    await FileSystem.writeAsStringAsync(fileUri, content, { encoding: FileSystem.EncodingType.UTF8 });
    return { success: true, data: { path: relativePath, uri: fileUri }, error: null };
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
 * Deletes a file or folder at a path relative to the granted directory.
 */
export async function deleteEntry(relativePath) {
  const baseDirUri = await getGrantedDirUri();
  if (!baseDirUri) return requireAccessError();

  const entryUri = await findEntryUri(relativePath, baseDirUri);
  if (!entryUri) {
    return { success: false, data: null, error: { message: `${relativePath} does not exist.` } };
  }

  try {
    await StorageAccessFramework.deleteAsync(entryUri);
    return { success: true, data: { path: relativePath }, error: null };
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
    const newUri = await StorageAccessFramework.createFileAsync(resolved.dirUri, newName, guessMimeType(newName));
    await FileSystem.writeAsStringAsync(newUri, content, { encoding: FileSystem.EncodingType.Base64 });
    await StorageAccessFramework.deleteAsync(entryUri);

    const newRelativePath = relativePath.split('/').slice(0, -1).concat(newName).join('/');
    return { success: true, data: { oldPath: relativePath, newPath: newRelativePath }, error: null };
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
    const newUri = await StorageAccessFramework.createFileAsync(destResolved.dirUri, fileName, guessMimeType(fileName));
    await FileSystem.writeAsStringAsync(newUri, content, { encoding: FileSystem.EncodingType.Base64 });

    if (!keepOriginal) {
      await StorageAccessFramework.deleteAsync(sourceUri);
    }

    return {
      success: true,
      data: { sourcePath, destinationPath: `${destinationFolderPath}/${fileName}`, copied: keepOriginal },
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
