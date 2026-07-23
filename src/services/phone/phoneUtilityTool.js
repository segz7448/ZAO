/**
 * ZAO - Phone Utility Tool
 *
 * Two small phone-native actions that don't belong in filesystemTool.js
 * (that's specifically SAF file operations) or pcFilesystemTool.js
 * (that's specifically the PC bridge):
 *
 *  - copyToClipboard(text): puts text straight on the phone's clipboard,
 *    so a generated snippet/command/link doesn't need to be manually
 *    long-pressed and selected out of a chat bubble.
 *  - shareFile(relativePath): hands an existing file (relative to the
 *    SAF folder granted in Settings > Filesystem) to Android's native
 *    share sheet - "send this to WhatsApp/Drive/email" - instead of it
 *    just sitting in the project folder until the person goes and finds
 *    it themselves.
 */

import * as Clipboard from 'expo-clipboard';
import * as Sharing from 'expo-sharing';
import { getExistingFileUriForTools } from '../filesystem/filesystemTool';

// Small, self-contained guess (not exported from filesystemTool.js, and
// not worth a shared module for six extensions) - only affects which
// apps Android's share sheet suggests as a good match, never blocks the
// share itself if the extension isn't recognized.
const MIME_TYPES = {
  html: 'text/html', css: 'text/css', js: 'text/javascript', json: 'application/json',
  txt: 'text/plain', md: 'text/markdown', pdf: 'application/pdf',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp',
  zip: 'application/zip', apk: 'application/vnd.android.package-archive',
  doc: 'application/msword', docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

function guessMimeType(relativePath) {
  const ext = relativePath.split('.').pop()?.toLowerCase();
  return MIME_TYPES[ext] || 'application/octet-stream';
}

/**
 * Copies text to the phone's clipboard.
 * @param {string} text
 * @returns {Promise<{success: boolean, data: {length: number}|null, error: object|null}>}
 */
export async function copyToClipboard(text) {
  if (typeof text !== 'string' || !text.length) {
    return { success: false, data: null, error: { message: 'text is required and cannot be empty.' } };
  }
  try {
    await Clipboard.setStringAsync(text);
    return { success: true, data: { length: text.length }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Failed to copy to clipboard.' } };
  }
}

/**
 * Opens Android's native share sheet for an existing file on the phone
 * (relative to the SAF folder granted in Settings > Filesystem) - lets
 * the person send it on to WhatsApp, Drive, email, etc. in one tap
 * instead of hunting it down in a file manager afterward.
 * @param {string} relativePath - relative to the granted folder, e.g. "myproject/dist/app-release.apk"
 * @returns {Promise<{success: boolean, data: {path: string}|null, error: object|null}>}
 */
export async function shareFile(relativePath) {
  if (!relativePath) {
    return { success: false, data: null, error: { message: 'relativePath is required.' } };
  }

  const available = await Sharing.isAvailableAsync().catch(() => false);
  if (!available) {
    return { success: false, data: null, error: { message: 'Sharing is not available on this device.' } };
  }

  const uriResult = await getExistingFileUriForTools(relativePath);
  if (!uriResult.success) {
    return { success: false, data: null, error: uriResult.error };
  }

  try {
    await Sharing.shareAsync(uriResult.data.uri, {
      mimeType: guessMimeType(relativePath),
      dialogTitle: relativePath.split('/').pop(),
    });
    return { success: true, data: { path: relativePath }, error: null };
  } catch (err) {
    // The person backing out of the share sheet also lands here on some
    // Android versions (rejected promise, not a thrown "cancelled"
    // error) - treat it as a soft failure rather than a real one.
    return { success: false, data: null, error: { message: err?.message || 'Share sheet was closed or failed to open.' } };
  }
}
