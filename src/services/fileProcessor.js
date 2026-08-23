/**
 * ZAO - File Processing Orchestrator
 *
 * Single entry point the UI calls for any attached file, regardless of
 * type. Routes to the right extractor (fileTypes.js decides which),
 * normalizes every extractor's result into one shape, and never throws -
 * matching the same contract as the AI orchestrator (utils/orchestrator.js).
 */

import * as FileSystem from 'expo-file-system';
import { categorizeFile, FILE_CATEGORY, getCategoryLabel } from './fileTypes';
import { extractPlainText, extractCsv } from './textExtraction';
import { extractZipContents } from './zipHandler';
import { extractPdfText } from '../files/pdfExtractor';
import { extractDocxText, extractPptxText } from '../files/officeExtractors';
import { runOcrExtraction } from './backend/backendClient';

/**
 * Runs OCR (free/open-source Tesseract + PyMuPDF, on the PC backend - see
 * server/ocr.js) on a file and returns plain extracted text, or null if
 * OCR wasn't possible for any reason (backend unreachable, no text found,
 * OCR dependencies not installed on the PC, etc). Never throws - OCR is
 * always a best-effort fallback, not something that should break file
 * attachment if it fails.
 */
async function attemptOcr(uri, name) {
  try {
    const base64Data = await FileSystem.readAsStringAsync(uri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const result = await runOcrExtraction(base64Data, name);
    return result.success && result.data?.text ? result.data.text : null;
  } catch (err) {
    console.error('[FileProcessor] OCR attempt failed:', err);
    return null;
  }
}

/**
 * @param {object} file - { uri, name, mimeType, size }
 * @param {string} [userMessageText] - unused; every category extracts its
 * own text/media regardless of what the person typed alongside it. Kept
 * in the signature so callers don't need to change how they invoke this.
 * @returns {Promise<{
 *   success: boolean,
 *   category: string,
 *   categoryLabel: string,
 *   isImage: boolean,
 *   isVideo: boolean,
 *   text: string | null,
 *   base64: string | null,
 *   mimeType: string | null,
 *   truncated: boolean,
 *   error: string | null,
 * }>}
 */
export async function processAttachedFile(file, userMessageText = '') {
  const { uri, name, mimeType } = file;

  try {
    const category = categorizeFile(name, mimeType);
    const categoryLabel = getCategoryLabel(category);

    switch (category) {
      case FILE_CATEGORY.IMAGE:
        return processImage(uri, name, mimeType);

      case FILE_CATEGORY.VIDEO:
        return processVideo(uri, name, mimeType);

      case FILE_CATEGORY.PDF: {
        const result = await extractPdfText(uri);

        // The local extractor is pattern-matching, not a real PDF parser -
        // it can't read scanned/image-based PDFs at all (result.success:
        // false) and flags a low text-to-filesize ratio as a warning
        // (likely partially scanned). Either case is exactly what OCR is
        // for, so fall back to it rather than surfacing a dead end.
        if (!result.success || result.warning) {
          const ocrText = await attemptOcr(uri, name);
          if (ocrText) {
            return {
              success: true,
              category, categoryLabel, isImage: false, isVideo: false,
              text: result.success ? `${result.text}\n\n${ocrText}` : ocrText,
              base64: null, mimeType: null,
              truncated: false,
              error: null,
            };
          }
        }

        return {
          success: result.success,
          category, categoryLabel, isImage: false, isVideo: false,
          text: result.success ? result.text : null,
          base64: null, mimeType: null,
          truncated: false,
          error: result.error || result.warning,
        };
      }

      case FILE_CATEGORY.DOCX: {
        const result = await extractDocxText(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false, isVideo: false,
          text: result.success ? result.text : null,
          base64: null, mimeType: null,
          truncated: false,
          error: result.error,
        };
      }

      case FILE_CATEGORY.PPTX: {
        const result = await extractPptxText(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false, isVideo: false,
          text: result.success ? result.text : null,
          base64: null, mimeType: null,
          truncated: false,
          error: result.error,
        };
      }

      case FILE_CATEGORY.ZIP: {
        const result = await extractZipContents(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false, isVideo: false,
          text: result.success ? result.summary : null,
          base64: null, mimeType: null,
          truncated: result.truncated,
          error: result.error,
        };
      }

      case FILE_CATEGORY.CSV: {
        const result = await extractCsv(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false, isVideo: false,
          text: result.success ? result.text : null,
          base64: null, mimeType: null,
          truncated: result.truncated,
          error: result.error,
        };
      }

      case FILE_CATEGORY.CODE_OR_TEXT: {
        const result = await extractPlainText(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false, isVideo: false,
          text: result.success ? result.text : null,
          base64: null, mimeType: null,
          truncated: result.truncated,
          error: result.error,
        };
      }

      default:
        return {
          success: false,
          category: FILE_CATEGORY.UNKNOWN,
          categoryLabel: 'File',
          isImage: false,
          isVideo: false,
          text: null,
          base64: null, mimeType: null,
          truncated: false,
          error: `ZAO doesn't know how to read "${name}" yet. Supported: images, video, PDF, Word (.docx), ZIP, CSV, and text/code files.`,
        };
    }
  } catch (err) {
    console.error('[FileProcessor] processAttachedFile failed:', err);
    return {
      success: false,
      category: FILE_CATEGORY.UNKNOWN,
      categoryLabel: 'File',
      isImage: false,
      isVideo: false,
      text: null,
      base64: null, mimeType: null,
      truncated: false,
      error: 'Something went wrong processing this file. Please try again.',
    };
  }
}

// Base64 inflates raw bytes by ~33%, and this all rides in one JSON body
// (server/config.js's MAX_JSON_BODY_MB, currently 80MB) alongside the rest
// of the chat history - 20MB raw keeps a single video attachment
// comfortably inside that even with history attached, without needing
// chunked upload. If someone hits this, the fix is "trim the clip or
// lower the resolution," not raising this further - OpenRouter's own
// request-size ceiling is the real wall behind this one.
const MAX_VIDEO_BYTES = 20 * 1024 * 1024;

/**
 * Video handling: Ox Alpha (via OpenRouter) has real video understanding,
 * so - unlike every other attachment type here - there's no text
 * extraction step at all. The whole file is base64-encoded and sent
 * straight to the model as a `video_url` content part (see
 * chatStore.js's buildMultimodalContent()), which is the same shape
 * OpenRouter documents for video input. No OCR (server/ocr.js is
 * image/PDF only, not frame-sampling), no thumbnail generation - the chat
 * bubble shows a plain "[video attached]" note rather than an inline
 * preview (MessageBubble.js was never taught to render video).
 */
async function processVideo(uri, name, mimeType) {
  const categoryLabel = getCategoryLabel(FILE_CATEGORY.VIDEO);
  try {
    const info = await FileSystem.getInfoAsync(uri, { size: true });
    if (info.exists && info.size > MAX_VIDEO_BYTES) {
      const mb = (info.size / (1024 * 1024)).toFixed(1);
      const maxMb = (MAX_VIDEO_BYTES / (1024 * 1024)).toFixed(0);
      return {
        success: false,
        category: FILE_CATEGORY.VIDEO, categoryLabel, isImage: false, isVideo: true,
        text: null, base64: null, mimeType: null,
        truncated: false,
        error: `This video is ${mb}MB - ZAO can currently send videos up to ${maxMb}MB. Try a shorter clip or a lower resolution.`,
      };
    }
    const base64 = await FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 });
    return {
      success: true,
      category: FILE_CATEGORY.VIDEO, categoryLabel, isImage: false, isVideo: true,
      text: null,
      base64,
      mimeType: mimeType || 'video/mp4',
      truncated: false,
      error: null,
    };
  } catch (err) {
    console.error('[FileProcessor] processVideo failed:', err);
    return {
      success: false,
      category: FILE_CATEGORY.VIDEO, categoryLabel, isImage: false, isVideo: true,
      text: null, base64: null, mimeType: null,
      truncated: false,
      error: 'Could not read this video file. Please try again.',
    };
  }
}

/**
 * Image handling: Ox Alpha (via OpenRouter) has real vision, so the model
 * actually sees the image now - fileProcessor returns the base64 bytes
 * alongside the extracted OCR text (server-side, free/open-source
 * Tesseract - see server/ocr.js), and chatStore.js's
 * buildMultimodalContent() attaches the image itself as an `image_url`
 * content part on the outbound message. OCR is kept running too, not
 * replaced - it's a cheap, reliable supplement for pulling exact text out
 * of a screenshot or document photo (useful for search/precision even
 * when vision alone would "read" it approximately), and it costs nothing
 * extra since it already ran server-side before the vision change.
 */
async function processImage(uri, name, mimeType) {
  const categoryLabel = getCategoryLabel(FILE_CATEGORY.IMAGE);
  const [ocrText, base64] = await Promise.all([
    attemptOcr(uri, name),
    FileSystem.readAsStringAsync(uri, { encoding: FileSystem.EncodingType.Base64 }).catch((err) => {
      console.error('[FileProcessor] Reading image base64 failed:', err);
      return null;
    }),
  ]);
  return {
    success: true,
    category: FILE_CATEGORY.IMAGE, categoryLabel, isImage: true, isVideo: false,
    text: ocrText,
    base64,
    mimeType: mimeType || 'image/jpeg',
    truncated: false,
    error: null,
  };
}

/**
 * Formats an extraction result into the text block that gets prepended to
 * the user's message before sending to the AI orchestrator. Kept separate
 * from processAttachedFile so the chat store controls exactly how/where
 * this gets inserted into the conversation.
 */
export function formatFileContextBlock(fileName, result) {
  if (!result.success) {
    return null; // caller should show result.error to the user instead
  }
  const truncationNote = result.truncated ? ' (content truncated due to length)' : '';
  return `[Attached file: ${fileName} - ${result.categoryLabel}${truncationNote}]\n\n${result.text}`;
}
