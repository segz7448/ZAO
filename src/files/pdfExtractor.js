/**
 * ZAO - PDF Text Extraction (basic, honest limitations documented below)
 *
 * HONEST LIMITATION: there is no good pure-JS, native-dependency-free PDF
 * parser for React Native. The real options are heavy native libraries
 * (another Gradle risk after everything already fought through) or a
 * server-side extraction service (out of scope for an offline-first app).
 *
 * This extractor uses a pragmatic middle ground: PDFs store text content
 * inside "stream" objects using a semi-readable encoding, and simple,
 * non-scanned, non-encrypted PDFs (most text-based PDFs: reports, articles,
 * generated documents) can have their text pulled out via pattern matching
 * on the raw bytes, without fully implementing the PDF spec.
 *
 * What this WILL work reasonably well on:
 * - Simple text-based PDFs (most reports, articles, exported documents)
 *
 * What this will NOT work on:
 * - Scanned/image-based PDFs (needs real OCR, which this pattern-matching
 *   approach can't do)
 * - PDFs with unusual compression or encryption
 * - Complex layouts (multi-column, heavy tables) - text order may be jumbled
 *
 * When extraction yields suspiciously little text relative to file size,
 * we say so explicitly (via `warning`) rather than silently returning a
 * poor result - fileProcessor.js uses that signal, plus outright
 * `success: false`, to fall back to real server-side OCR (free/open-source
 * Tesseract + PyMuPDF running on the PC backend - see server/ocr.js)
 * rather than presenting either of those as a dead end.
 */

import * as FileSystem from 'expo-file-system';

function decodePdfString(raw) {
  return raw
    .replace(/\\n/g, '\n')
    .replace(/\\r/g, '')
    .replace(/\\t/g, '\t')
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/**
 * @param {string} fileUri - local file:// URI
 * @returns {Promise<{success: boolean, text: string, warning: string|null, error: string|null}>}
 */
export async function extractPdfText(fileUri) {
  try {
    const raw = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    const textPieces = [];

    // Pattern 1: literal strings before a Tj/TJ text-showing operator, e.g. (Hello) Tj
    const tjPattern = /\(((?:[^()\\]|\\.)*)\)\s*Tj/g;
    let match;
    while ((match = tjPattern.exec(raw)) !== null) {
      textPieces.push(decodePdfString(match[1]));
    }

    // Pattern 2: TJ arrays, e.g. [(Hello) -250 (World)] TJ
    const tjArrayPattern = /\[((?:[^\[\]]|\\.)*)\]\s*TJ/g;
    while ((match = tjArrayPattern.exec(raw)) !== null) {
      const arrayContent = match[1];
      const stringPattern = /\(((?:[^()\\]|\\.)*)\)/g;
      let strMatch;
      const lineWords = [];
      while ((strMatch = stringPattern.exec(arrayContent)) !== null) {
        lineWords.push(decodePdfString(strMatch[1]));
      }
      if (lineWords.length > 0) textPieces.push(lineWords.join(''));
    }

    const combinedText = textPieces.join('\n').trim();

    if (combinedText.length === 0) {
      return {
        success: false,
        text: '',
        warning: null,
        error: 'Could not extract readable text from this PDF directly. It may be a scanned/image-based PDF, encrypted, or use an unsupported internal format.',
      };
    }

    // Heuristic: if the file is large but we extracted very little text,
    // warn rather than presenting a possibly-broken result as complete.
    let warning = null;
    if (raw.length > 50000 && combinedText.length < 200) {
      warning = 'This PDF is large but very little text could be extracted - it may be partially scanned/image-based, or use a format this basic extractor doesn\'t fully support. The extracted text below may be incomplete.';
    }

    return { success: true, text: combinedText, warning, error: null };
  } catch (err) {
    console.error('[PdfExtractor] failed:', err);
    return {
      success: false,
      text: '',
      warning: null,
      error: 'Could not read this PDF file.',
    };
  }
}
