/**
 * ZAO - File Type Detection
 *
 * Central place that decides what KIND of file something is, based on
 * extension (and mime type when available from the picker). Every
 * extractor in this folder is keyed off these categories.
 */

export const FILE_CATEGORIES = {
  IMAGE: 'image',
  PDF: 'pdf',
  DOCX: 'docx',
  PPTX: 'pptx',
  ZIP: 'zip',
  CSV: 'csv',
  CODE: 'code',
  PLAIN_TEXT: 'plain_text',
  UNKNOWN: 'unknown',
};

const EXTENSION_MAP = {
  // Images
  jpg: FILE_CATEGORIES.IMAGE, jpeg: FILE_CATEGORIES.IMAGE, png: FILE_CATEGORIES.IMAGE,
  gif: FILE_CATEGORIES.IMAGE, webp: FILE_CATEGORIES.IMAGE, bmp: FILE_CATEGORIES.IMAGE,
  heic: FILE_CATEGORIES.IMAGE,

  // Documents
  pdf: FILE_CATEGORIES.PDF,
  docx: FILE_CATEGORIES.DOCX,
  pptx: FILE_CATEGORIES.PPTX,
  zip: FILE_CATEGORIES.ZIP,
  csv: FILE_CATEGORIES.CSV,

  // Code / structured text - all read as plain text but tagged separately
  // so the AI prompt can mention the language for better-formatted answers.
  js: FILE_CATEGORIES.CODE, jsx: FILE_CATEGORIES.CODE, ts: FILE_CATEGORIES.CODE,
  tsx: FILE_CATEGORIES.CODE, py: FILE_CATEGORIES.CODE, java: FILE_CATEGORIES.CODE,
  kt: FILE_CATEGORIES.CODE, c: FILE_CATEGORIES.CODE, cpp: FILE_CATEGORIES.CODE,
  h: FILE_CATEGORIES.CODE, cs: FILE_CATEGORIES.CODE, go: FILE_CATEGORIES.CODE,
  rs: FILE_CATEGORIES.CODE, rb: FILE_CATEGORIES.CODE, php: FILE_CATEGORIES.CODE,
  sql: FILE_CATEGORIES.CODE, html: FILE_CATEGORIES.CODE, css: FILE_CATEGORIES.CODE,
  json: FILE_CATEGORIES.CODE, yaml: FILE_CATEGORIES.CODE, yml: FILE_CATEGORIES.CODE,
  xml: FILE_CATEGORIES.CODE, sh: FILE_CATEGORIES.CODE, gradle: FILE_CATEGORIES.CODE,

  // Plain text
  txt: FILE_CATEGORIES.PLAIN_TEXT, md: FILE_CATEGORIES.PLAIN_TEXT,
  log: FILE_CATEGORIES.PLAIN_TEXT,
};

export function getFileExtension(fileName = '') {
  const match = fileName.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

export function categorizeFile(fileName, mimeType = '') {
  const ext = getFileExtension(fileName);
  if (EXTENSION_MAP[ext]) return EXTENSION_MAP[ext];

  // Fall back to mime type if extension is missing/unrecognized
  if (mimeType.startsWith('image/')) return FILE_CATEGORIES.IMAGE;
  if (mimeType === 'application/pdf') return FILE_CATEGORIES.PDF;
  if (mimeType === 'text/csv') return FILE_CATEGORIES.CSV;
  if (mimeType.startsWith('text/')) return FILE_CATEGORIES.PLAIN_TEXT;
  if (mimeType === 'application/zip' || mimeType === 'application/x-zip-compressed') return FILE_CATEGORIES.ZIP;

  return FILE_CATEGORIES.UNKNOWN;
}

/**
 * Rough size cap for how much extracted text we'll inject into a single
 * message's context. Very large files get truncated with a clear notice
 * rather than silently blowing up the model's context window or the
 * request payload.
 */
export const MAX_EXTRACTED_CHARS = 40000;

export function truncateWithNotice(text, maxChars = MAX_EXTRACTED_CHARS) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n\n[... content truncated, file was ${text.length.toLocaleString()} characters total ...]`;
}
