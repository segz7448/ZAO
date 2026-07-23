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
 * @param {string} [userMessageText] - unused; there's no vision model so an
 * image can't be answered about contextually, and every other category
 * extracts its own text regardless of what the person typed alongside it.
 * Kept in the signature so callers don't need to change how they invoke this.
 * @returns {Promise<{
 *   success: boolean,
 *   category: string,
 *   categoryLabel: string,
 *   isImage: boolean,
 *   text: string | null,
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
        return processImage(uri, name);

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
              category, categoryLabel, isImage: false,
              text: result.success ? `${result.text}\n\n${ocrText}` : ocrText,
              truncated: false,
              error: null,
            };
          }
        }

        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.text : null,
          truncated: false,
          error: result.error || result.warning,
        };
      }

      case FILE_CATEGORY.DOCX: {
        const result = await extractDocxText(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.text : null,
          truncated: false,
          error: result.error,
        };
      }

      case FILE_CATEGORY.PPTX: {
        const result = await extractPptxText(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.text : null,
          truncated: false,
          error: result.error,
        };
      }

      case FILE_CATEGORY.ZIP: {
        const result = await extractZipContents(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.summary : null,
          truncated: result.truncated,
          error: result.error,
        };
      }

      case FILE_CATEGORY.CSV: {
        const result = await extractCsv(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.text : null,
          truncated: result.truncated,
          error: result.error,
        };
      }

      case FILE_CATEGORY.CODE_OR_TEXT: {
        const result = await extractPlainText(uri);
        return {
          success: result.success,
          category, categoryLabel, isImage: false,
          text: result.success ? result.text : null,
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
          text: null,
          truncated: false,
          error: `ZAO doesn't know how to read "${name}" yet. Supported: PDF, Word (.docx), ZIP, CSV, and text/code files.`,
        };
    }
  } catch (err) {
    console.error('[FileProcessor] processAttachedFile failed:', err);
    return {
      success: false,
      category: FILE_CATEGORY.UNKNOWN,
      categoryLabel: 'File',
      isImage: false,
      text: null,
      truncated: false,
      error: 'Something went wrong processing this file. Please try again.',
    };
  }
}

/**
 * Image handling: there's no vision model in ZAO (Gemini removed along
 * with every other cloud provider), so the model can't "see" the image
 * itself - only text that OCR (server-side, on the PC backend - see
 * server/ocr.js) can pull out of it. The image still attaches and
 * displays fine as a chat bubble regardless (see ChatScreen.js /
 * chatStore.js's copyAttachmentLocally) - OCR is strictly best-effort on
 * top of that: a screenshot of a document or a photo of a whiteboard gets
 * its text extracted, a photo of a sunset just attaches with no text,
 * same as before.
 */
async function processImage(uri, name) {
  const categoryLabel = getCategoryLabel(FILE_CATEGORY.IMAGE);
  const ocrText = await attemptOcr(uri, name);
  return {
    success: true,
    category: FILE_CATEGORY.IMAGE, categoryLabel, isImage: true,
    text: ocrText,
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
