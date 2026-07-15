/**
 * ZAO - On-Device Text Extraction
 *
 * Plain text/code files and CSVs are extracted entirely on-device - no
 * server round-trip needed, since expo-file-system can read UTF-8 text
 * directly and papaparse is pure JS.
 */

import * as FileSystem from 'expo-file-system/legacy';
import Papa from 'papaparse';

const MAX_CHARS = 50000; // same cap as the server-side PDF/DOCX extractor, for consistency

/**
 * Reads a plain text or code file directly from its local URI.
 * @returns {Promise<{success: boolean, text: string, truncated: boolean, error: string|null}>}
 */
export async function extractPlainText(localUri) {
  try {
    const content = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.UTF8,
    });
    const truncated = content.length > MAX_CHARS;
    return {
      success: true,
      text: truncated ? content.slice(0, MAX_CHARS) : content,
      truncated,
      error: null,
    };
  } catch (err) {
    console.error('[TextExtraction] extractPlainText failed:', err);
    return {
      success: false,
      text: '',
      truncated: false,
      error: 'Could not read this file as text. It may be binary or corrupted.',
    };
  }
}

/**
 * Parses a CSV file and converts it into a readable text table the model
 * can reason over - papaparse handles quoting/escaping edge cases that a
 * naive split(',') would get wrong.
 */
export async function extractCsv(localUri) {
  try {
    const raw = await FileSystem.readAsStringAsync(localUri, {
      encoding: FileSystem.EncodingType.UTF8,
    });

    const parsed = Papa.parse(raw.trim(), { skipEmptyLines: true });
    if (parsed.errors?.length > 0 && parsed.data.length === 0) {
      return {
        success: false,
        text: '',
        truncated: false,
        error: 'Could not parse this CSV file - it may be malformed.',
      };
    }

    const rows = parsed.data;
    const rowCount = rows.length;
    const colCount = rows[0]?.length || 0;

    // Render as a simple aligned text table rather than raw CSV - easier
    // for a model to read column relationships from, and avoids ambiguity
    // around quoting that raw CSV text can introduce.
    const preview = rows.slice(0, 200); // cap preview rows, note if truncated
    const tableText = preview.map((row) => row.join(' | ')).join('\n');
    const truncated = rowCount > 200;

    const summary = `CSV file: ${rowCount} rows, ${colCount} columns.${truncated ? ` Showing first 200 rows.` : ''}\n\n${tableText}`;

    return {
      success: true,
      text: summary.length > MAX_CHARS ? summary.slice(0, MAX_CHARS) : summary,
      truncated: truncated || summary.length > MAX_CHARS,
      error: null,
    };
  } catch (err) {
    console.error('[TextExtraction] extractCsv failed:', err);
    return {
      success: false,
      text: '',
      truncated: false,
      error: 'Could not read this CSV file.',
    };
  }
}
