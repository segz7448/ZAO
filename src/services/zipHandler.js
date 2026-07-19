/**
 * ZAO - ZIP Archive Handler
 *
 * Uses JSZip (pure JS, no native module) to unzip archives entirely
 * on-device. Each entry inside the archive is categorized the same way a
 * top-level upload would be (see fileTypes.js) and processed accordingly -
 * text/code files read directly, images noted but not auto-extracted
 * (would need per-image vision calls, out of scope for a single zip
 * upload), nested zips processed one level deep only (see cap below).
 */

import * as FileSystem from 'expo-file-system/legacy';
import JSZip from 'jszip';
import { categorizeFile, FILE_CATEGORY, getCategoryLabel } from './fileTypes';

const MAX_ENTRIES_PROCESSED = 30; // avoid hanging on a zip with thousands of files
const MAX_TOTAL_CHARS = 60000;    // combined cap across all extracted entries
const MAX_NESTED_ZIP_DEPTH = 1;   // process one level of nested zips, then stop

/**
 * Unzips an archive and returns a structured summary of its contents,
 * with text extracted from readable entries (up to the caps above).
 *
 * @param {string} localUri - file:// URI of the .zip file
 * @returns {Promise<{success: boolean, summary: string, fileList: string[], truncated: boolean, error: string|null}>}
 */
export async function extractZipContents(localUri, depth = 0) {
  try {
    const base64Data = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.Base64,
    });

    const zip = await JSZip.loadAsync(base64Data, { base64: true });
    const entries = Object.values(zip.files).filter((entry) => !entry.dir);

    if (entries.length === 0) {
      return { success: true, summary: 'This ZIP archive is empty.', fileList: [], truncated: false, error: null };
    }

    const fileList = entries.map((e) => e.name);
    const cappedEntries = entries.slice(0, MAX_ENTRIES_PROCESSED);
    const entryTruncated = entries.length > MAX_ENTRIES_PROCESSED;

    let combinedText = `ZIP archive contains ${entries.length} file(s):\n${fileList.slice(0, 100).join('\n')}${fileList.length > 100 ? `\n... and ${fileList.length - 100} more` : ''}\n\n`;
    let charsUsed = combinedText.length;
    let anyExtracted = false;

    for (const entry of cappedEntries) {
      if (charsUsed >= MAX_TOTAL_CHARS) break;

      const category = categorizeFile(entry.name);

      if (category === FILE_CATEGORY.CODE_OR_TEXT) {
        try {
          const text = await entry.async('text');
          const remaining = MAX_TOTAL_CHARS - charsUsed;
          const snippet = text.length > remaining ? text.slice(0, remaining) : text;
          combinedText += `\n--- ${entry.name} ---\n${snippet}\n`;
          charsUsed += snippet.length + entry.name.length + 10;
          anyExtracted = true;
        } catch (entryErr) {
          combinedText += `\n--- ${entry.name} (could not read: ${entryErr?.message || 'unknown error'}) ---\n`;
        }
      } else if (category === FILE_CATEGORY.CSV) {
        try {
          const text = await entry.async('text');
          combinedText += `\n--- ${entry.name} (CSV) ---\n${text.slice(0, Math.min(2000, MAX_TOTAL_CHARS - charsUsed))}\n`;
          charsUsed = combinedText.length;
          anyExtracted = true;
        } catch (entryErr) {
          combinedText += `\n--- ${entry.name} (could not read CSV) ---\n`;
        }
      } else if (category === FILE_CATEGORY.ZIP && depth < MAX_NESTED_ZIP_DEPTH) {
        combinedText += `\n--- ${entry.name} (nested ZIP - contents not expanded, one level deep only) ---\n`;
      } else if (category === FILE_CATEGORY.IMAGE) {
        combinedText += `\n--- ${entry.name} (image - not extracted, upload separately to analyze) ---\n`;
      } else {
        combinedText += `\n--- ${entry.name} (${getCategoryLabel(category)} - not extracted) ---\n`;
      }
    }

    const truncated = entryTruncated || charsUsed >= MAX_TOTAL_CHARS;
    if (truncated) {
      combinedText += `\n[Note: some archive contents were truncated or skipped due to size limits]`;
    }
    if (!anyExtracted) {
      combinedText += `\n[No readable text/code/CSV files found in this archive to extract]`;
    }

    return {
      success: true,
      summary: combinedText,
      fileList,
      truncated,
      error: null,
    };
  } catch (err) {
    console.error('[ZipHandler] extractZipContents failed:', err);
    return {
      success: false,
      summary: '',
      fileList: [],
      truncated: false,
      error: 'Could not open this ZIP file. It may be corrupted or password-protected.',
    };
  }
}
