/**
 * ZAO - File Type Detection
 *
 * Single place that maps a file's extension/mime type to how it should be
 * processed. Every other file-handling module (pdfExtractor,
 * officeExtractors, etc.) reads from this rather than re-implementing
 * extension checks.
 */

export const FILE_CATEGORY = {
  IMAGE: 'image',           // sent directly to vision-capable models
  PDF: 'pdf',               // extracted server-side via edge function
  DOCX: 'docx',             // extracted server-side via edge function
  ZIP: 'zip',               // unzipped on-device, each entry processed recursively
  CSV: 'csv',               // parsed on-device with papaparse, converted to readable text
  CODE_OR_TEXT: 'text',     // read directly as UTF-8 text on-device
  UNKNOWN: 'unknown',       // no extraction available - user is told plainly
};

const IMAGE_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'heic', 'bmp'];
const TEXT_EXTENSIONS = [
  'txt', 'md', 'markdown', 'json', 'yaml', 'yml', 'xml', 'html', 'css',
  'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'kt', 'c', 'cpp', 'h', 'cs',
  'go', 'rs', 'rb', 'php', 'sh', 'sql', 'log', 'ini', 'toml', 'env',
  'gradle', 'properties', 'swift', 'dart', 'lua',
];

export function getFileExtension(fileName = '') {
  const match = fileName.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : '';
}

export function categorizeFile(fileName, mimeType = '') {
  const ext = getFileExtension(fileName);

  if (IMAGE_EXTENSIONS.includes(ext) || mimeType.startsWith('image/')) {
    return FILE_CATEGORY.IMAGE;
  }
  if (ext === 'pdf' || mimeType === 'application/pdf') {
    return FILE_CATEGORY.PDF;
  }
  if (ext === 'docx' || mimeType.includes('wordprocessingml')) {
    return FILE_CATEGORY.DOCX;
  }
  if (ext === 'zip' || mimeType === 'application/zip') {
    return FILE_CATEGORY.ZIP;
  }
  if (ext === 'csv' || mimeType === 'text/csv') {
    return FILE_CATEGORY.CSV;
  }
  if (TEXT_EXTENSIONS.includes(ext) || mimeType.startsWith('text/')) {
    return FILE_CATEGORY.CODE_OR_TEXT;
  }
  return FILE_CATEGORY.UNKNOWN;
}

/**
 * Human-readable label for a category, used in UI (attachment chips,
 * "processing..." messages).
 */
export function getCategoryLabel(category) {
  const labels = {
    [FILE_CATEGORY.IMAGE]: 'Image',
    [FILE_CATEGORY.PDF]: 'PDF',
    [FILE_CATEGORY.DOCX]: 'Word document',
    [FILE_CATEGORY.ZIP]: 'ZIP archive',
    [FILE_CATEGORY.CSV]: 'Spreadsheet',
    [FILE_CATEGORY.CODE_OR_TEXT]: 'Text file',
    [FILE_CATEGORY.UNKNOWN]: 'File',
  };
  return labels[category] || 'File';
}

/**
 * pptx is intentionally NOT categorized as extractable yet - see README TODO.
 * It falls through to UNKNOWN rather than silently mis-processing as a ZIP
 * (a .pptx IS technically a zip container, but presenting its raw XML parts
 * to a model isn't useful without real slide-content parsing).
 */
export function isPptx(fileName, mimeType = '') {
  const ext = getFileExtension(fileName);
  return ext === 'pptx' || mimeType.includes('presentationml');
}
