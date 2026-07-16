/**
 * ZAO - ZIP Archive Handling
 *
 * Uses react-native-zip-archive (native, but well-established and
 * Expo-compatible) to actually unzip files to disk - this is what lets ZAO
 * "unzip a folder and read what's inside" rather than just listing entries
 * without content, which jszip alone would limit us to for large archives.
 *
 * Flow: unzip to a scratch directory under FileSystem.cacheDirectory ->
 * walk the resulting file tree -> for each file, run it through the same
 * per-file extraction used for direct uploads (recursive, so a zip
 * containing a docx and some code files gets both extracted sensibly) ->
 * clean up the scratch directory afterward.
 */

import { unzip, zip as zipArchive } from 'react-native-zip-archive';
import * as FileSystem from 'expo-file-system';
import { categorizeFile, FILE_CATEGORIES, truncateWithNotice } from './fileTypes';

const SCRATCH_DIR = `${FileSystem.cacheDirectory}zao-zip-scratch/`;

async function listFilesRecursive(dirUri, relativePath = '') {
  const entries = await FileSystem.readDirectoryAsync(dirUri);
  let results = [];

  for (const entry of entries) {
    const entryUri = `${dirUri}${entry}`;
    const relPath = relativePath ? `${relativePath}/${entry}` : entry;
    const info = await FileSystem.getInfoAsync(entryUri);

    if (info.isDirectory) {
      const nested = await listFilesRecursive(`${entryUri}/`, relPath);
      results = results.concat(nested);
    } else {
      results.push({ uri: entryUri, relativePath: relPath, size: info.size });
    }
  }
  return results;
}

/**
 * Unzips an archive, extracts readable text from every text-like file
 * inside (skipping binaries it can't meaningfully read), and returns a
 * combined summary. Cleans up its scratch directory when done, success or
 * failure, so repeated zip uploads don't accumulate disk usage.
 *
 * @param {string} zipUri - local file:// URI of the .zip
 * @returns {Promise<{success: boolean, text: string, fileList: string[], error: string|null}>}
 */
export async function extractZipContents(zipUri) {
  const extractDir = `${SCRATCH_DIR}${Date.now()}/`;

  try {
    await FileSystem.makeDirectoryAsync(extractDir, { intermediates: true });
    await unzip(zipUri, extractDir);

    const files = await listFilesRecursive(extractDir);
    const fileList = files.map((f) => f.relativePath);

    // Cap how many files we actually read content from - a zip with
    // thousands of files would otherwise take forever and blow past any
    // reasonable context size. We still report the full file list.
    const MAX_FILES_TO_READ = 30;
    const sections = [`Archive contains ${files.length} file(s):`, fileList.map((f) => `  - ${f}`).join('\n')];

    let readCount = 0;
    for (const file of files) {
      if (readCount >= MAX_FILES_TO_READ) {
        sections.push(`\n[... ${files.length - MAX_FILES_TO_READ} more file(s) not read, limit reached ...]`);
        break;
      }

      const category = categorizeFile(file.relativePath);
      const isReadable = [
        FILE_CATEGORIES.PLAIN_TEXT, FILE_CATEGORIES.CODE, FILE_CATEGORIES.CSV,
      ].includes(category);

      if (!isReadable) continue; // skip binaries, images, nested archives for now

      try {
        const content = await FileSystem.readAsStringAsync(file.uri, {
          encoding: FileSystem.EncodingType.UTF8,
        });
        sections.push(`\n--- ${file.relativePath} ---\n${truncateWithNotice(content, 5000)}`);
        readCount += 1;
      } catch (readErr) {
        // Individual unreadable file shouldn't fail the whole zip - note it
        // and move on.
        sections.push(`\n--- ${file.relativePath} ---\n[could not read this file as text]`);
      }
    }

    return { success: true, text: sections.join('\n'), fileList, error: null };
  } catch (err) {
    console.error('[ZipExtractor] failed:', err);
    return { success: false, text: '', fileList: [], error: 'Could not unzip this file. It may be corrupted, encrypted, or in an unsupported archive format.' };
  } finally {
    // Always clean up the scratch directory, even on failure.
    try {
      await FileSystem.deleteAsync(extractDir, { idempotent: true });
    } catch (cleanupErr) {
      console.error('[ZipExtractor] scratch cleanup failed:', cleanupErr);
    }
  }
}

/**
 * Creates a zip archive from a directory. Not currently wired into any UI
 * flow, but available for a future "export this conversation's generated
 * files as a zip" feature - kept here since it's the natural counterpart
 * to extractZipContents and uses the same library.
 */
export async function createZipFromDirectory(sourceDirUri, outputZipPath) {
  try {
    const resultPath = await zipArchive(sourceDirUri, outputZipPath);
    return { success: true, path: resultPath, error: null };
  } catch (err) {
    console.error('[ZipExtractor] createZipFromDirectory failed:', err);
    return { success: false, path: null, error: 'Could not create the zip archive.' };
  }
}
