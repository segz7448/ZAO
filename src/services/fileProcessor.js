/**
 * ZAO - File Processing Orchestrator
 *
 * Single entry point the UI calls for any attached file, regardless of
 * type. Routes to the right extractor (fileTypes.js decides which),
 * normalizes every extractor's result into one shape, and never throws -
 * matching the same contract as the AI orchestrator (utils/orchestrator.js).
 */

import { categorizeFile, FILE_CATEGORY, getCategoryLabel, isPptx } from './fileTypes';
import { extractPlainText, extractCsv } from './textExtraction';
import { extractZipContents } from './zipHandler';
import { extractPdfText } from '../files/pdfExtractor';
import { extractDocxText } from '../files/officeExtractors';

/**
 * @param {object} file - { uri, name, mimeType, size }
 * @param {string} [userMessageText] - unused for images now (vision removed); kept in the
 * signature so callers don't need to change how they invoke this.
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
    if (isPptx(name, mimeType)) {
      return {
        success: false,
        category: 'pptx',
        categoryLabel: 'PowerPoint presentation',
        isImage: false,
        text: null,
        truncated: false,
        error: 'PowerPoint (.pptx) reading isn\'t supported yet in ZAO - it needs dedicated slide-parsing that hasn\'t been built. PDF, Word, ZIP, CSV, and text/code files all work.',
      };
    }

    const category = categorizeFile(name, mimeType);
    const categoryLabel = getCategoryLabel(category);

    switch (category) {
      case FILE_CATEGORY.IMAGE:
        return processImage(uri, userMessageText);

      case FILE_CATEGORY.PDF: {
        const result = await extractPdfText(uri);
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
 * with every other cloud provider) - an attached image can't be "read" by
 * the AI. It still attaches and displays fine as a chat bubble though
 * (see ChatScreen.js / chatStore.js's copyAttachmentLocally) - this just
 * signals to chatStore that no text extraction happened, so it can attach
 * the image without trying to summarize its contents.
 */
async function processImage() {
  const categoryLabel = getCategoryLabel(FILE_CATEGORY.IMAGE);
  return {
    success: true,
    category: FILE_CATEGORY.IMAGE, categoryLabel, isImage: true,
    text: null, truncated: false,
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
