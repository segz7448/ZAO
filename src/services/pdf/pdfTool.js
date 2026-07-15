/**
 * ZAO - PDF Tool
 *
 * Create, merge, and split PDFs using pdf-lib - a pure-JavaScript library
 * (no native/Node-specific APIs), which is what makes it usable at all
 * inside Expo/React Native's Hermes JS engine. This is genuinely
 * different from how Claude itself handles PDFs in its own sandbox
 * (pypdf, a Python library) - there is no Python runtime on-device, so
 * this tool is built entirely on pdf-lib instead.
 *
 * HONEST LIMITATION, stated plainly: pdf-lib's compatibility with Hermes
 * specifically has not been runtime-verified here - it's documented as
 * "any JavaScript environment" and is widely used in React Native
 * projects in practice, but this module hasn't been tested on a real
 * device. If pdf-lib hits an unsupported JS feature under Hermes, the
 * error will surface clearly through the try/catch below rather than
 * fail silently, but this is real-device-testing territory, not
 * something verifiable from a sandbox alone.
 *
 * OCR IS NOT INCLUDED HERE - reading text out of a scanned/image-based
 * PDF is a fundamentally different problem (computer vision, not PDF
 * structure manipulation) and needs a vision-capable model. ZAO doesn't
 * have one right now - vision/OCR (previously Qwen2.5-VL via Hugging
 * Face) was removed along with the rest of the cloud model stack, with
 * no local or cloud replacement set up yet. Flagging this honestly rather
 * than pretending create/merge/split covers it - OCR would be its own,
 * separate effort once a vision-capable model is available again.
 *
 * Output files are written through the Filesystem tool
 * (src/services/filesystem/filesystemTool.js) rather than duplicating
 * SAF file-writing logic here - this module only builds the PDF bytes.
 */

import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import * as FileSystem from 'expo-file-system/legacy';
import { getOrCreateFileUriForTools, getExistingFileUriForTools } from '../filesystem/filesystemTool';
import { bytesToBase64, base64ToBytes } from '../shared/base64Utils';

const { StorageAccessFramework } = FileSystem;

const PAGE_SIZES = {
  a4: [595.28, 841.89],
  letter: [612, 792],
};

/**
 * Creates a new PDF from a simple structured content description - plain
 * paragraphs of text laid out top-to-bottom, wrapping at the page width,
 * starting a new page automatically when one fills up. This is
 * intentionally simple (no tables, images, or complex layout) since the
 * model writes the content and this just needs to turn it into a real
 * PDF - see src/services/toolOrchestrator.js's docstring on "the model
 * writes content, the plugin generates files."
 *
 * @param {Array<{heading?: string, text?: string}>} sections - ordered content blocks
 * @param {string} outputPath - path relative to the granted filesystem folder, e.g. "reports/pitch.pdf"
 * @param {object} options - { pageSize: 'a4'|'letter', title }
 */
export async function createPdf(sections, outputPath, options = {}) {
  const { pageSize = 'a4', title } = options;

  try {
    const pdfDoc = await PDFDocument.create();
    if (title) pdfDoc.setTitle(title);

    const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
    const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

    const [pageWidth, pageHeight] = PAGE_SIZES[pageSize] || PAGE_SIZES.a4;
    const margin = 50;
    const maxTextWidth = pageWidth - margin * 2;
    const bodySize = 11;
    const headingSize = 16;
    const lineHeight = 16;

    let page = pdfDoc.addPage([pageWidth, pageHeight]);
    let cursorY = pageHeight - margin;

    function ensureSpace(neededHeight) {
      if (cursorY - neededHeight < margin) {
        page = pdfDoc.addPage([pageWidth, pageHeight]);
        cursorY = pageHeight - margin;
      }
    }

    // Greedy word-wrap using pdf-lib's own font metrics, so wrapping
    // matches this exact font/size rather than guessing a fixed
    // characters-per-line number that would be wrong for most content.
    function wrapText(text, useFont, size) {
      const words = text.split(/\s+/);
      const lines = [];
      let currentLine = '';

      for (const word of words) {
        const candidate = currentLine ? `${currentLine} ${word}` : word;
        if (useFont.widthOfTextAtSize(candidate, size) <= maxTextWidth) {
          currentLine = candidate;
        } else {
          if (currentLine) lines.push(currentLine);
          currentLine = word;
        }
      }
      if (currentLine) lines.push(currentLine);
      return lines;
    }

    for (const section of sections) {
      if (section.heading) {
        const lines = wrapText(section.heading, boldFont, headingSize);
        ensureSpace(lines.length * (lineHeight + 6) + 10);
        for (const line of lines) {
          page.drawText(line, { x: margin, y: cursorY, size: headingSize, font: boldFont, color: rgb(0.1, 0.1, 0.1) });
          cursorY -= lineHeight + 6;
        }
        cursorY -= 6; // extra gap after a heading
      }

      if (section.text) {
        const lines = wrapText(section.text, font, bodySize);
        for (const line of lines) {
          ensureSpace(lineHeight);
          page.drawText(line, { x: margin, y: cursorY, size: bodySize, font, color: rgb(0.15, 0.15, 0.15) });
          cursorY -= lineHeight;
        }
        cursorY -= 10; // gap between sections
      }
    }

    const pdfBytes = await pdfDoc.save();
    const saveResult = await writePdfBytes(pdfBytes, outputPath);
    if (!saveResult.success) return saveResult;

    return { success: true, data: { path: outputPath, pageCount: pdfDoc.getPageCount() }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Could not create PDF.' } };
  }
}

/**
 * Merges multiple existing PDFs (paths relative to the granted
 * filesystem folder) into one, in the given order.
 */
export async function mergePdfs(inputPaths, outputPath) {
  try {
    const mergedDoc = await PDFDocument.create();

    for (const inputPath of inputPaths) {
      const bytes = await readPdfBytes(inputPath);
      if (!bytes.success) return bytes;

      const sourceDoc = await PDFDocument.load(bytes.data);
      const copiedPages = await mergedDoc.copyPages(sourceDoc, sourceDoc.getPageIndices());
      copiedPages.forEach((page) => mergedDoc.addPage(page));
    }

    const mergedBytes = await mergedDoc.save();
    const saveResult = await writePdfBytes(mergedBytes, outputPath);
    if (!saveResult.success) return saveResult;

    return { success: true, data: { path: outputPath, pageCount: mergedDoc.getPageCount(), mergedFrom: inputPaths.length }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Could not merge PDFs.' } };
  }
}

/**
 * Splits one PDF into multiple output files, either one file per page
 * (if ranges is omitted) or one file per given page range.
 *
 * @param {string} inputPath
 * @param {string} outputFolderPath - folder (relative to the granted directory) to write split files into
 * @param {Array<{start: number, end: number, name: string}>} [ranges] - 1-indexed, inclusive page ranges with an output filename each. If omitted, splits into one PDF per page.
 */
export async function splitPdf(inputPath, outputFolderPath, ranges = null) {
  try {
    const bytes = await readPdfBytes(inputPath);
    if (!bytes.success) return bytes;

    const sourceDoc = await PDFDocument.load(bytes.data);
    const totalPages = sourceDoc.getPageCount();

    const effectiveRanges = ranges || Array.from({ length: totalPages }, (_, i) => ({
      start: i + 1,
      end: i + 1,
      name: `page_${i + 1}.pdf`,
    }));

    const outputs = [];
    for (const range of effectiveRanges) {
      const newDoc = await PDFDocument.create();
      const pageIndices = [];
      for (let p = range.start; p <= range.end; p++) {
        if (p < 1 || p > totalPages) {
          return { success: false, data: null, error: { message: `Page ${p} does not exist - this PDF has ${totalPages} pages.` } };
        }
        pageIndices.push(p - 1);
      }

      const copiedPages = await newDoc.copyPages(sourceDoc, pageIndices);
      copiedPages.forEach((page) => newDoc.addPage(page));

      const newBytes = await newDoc.save();
      const outputPath = `${outputFolderPath}/${range.name}`;
      const saveResult = await writePdfBytes(newBytes, outputPath);
      if (!saveResult.success) return saveResult;

      outputs.push(outputPath);
    }

    return { success: true, data: { outputFiles: outputs, totalPages }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Could not split PDF.' } };
  }
}

// --- Internal byte read/write helpers, bridging into the Filesystem
// tool's SAF access rather than duplicating it ---

async function readPdfBytes(relativePath) {
  const resolved = await getExistingFileUriForTools(relativePath);
  if (!resolved.success) return { success: false, data: null, error: resolved.error };

  try {
    const base64 = await FileSystem.readAsStringAsync(resolved.data.uri, { encoding: FileSystem.EncodingType.Base64 });
    return { success: true, data: base64ToBytes(base64), error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not read ${relativePath}.` } };
  }
}

async function writePdfBytes(bytes, relativePath) {
  const resolved = await getOrCreateFileUriForTools(relativePath, 'application/pdf');
  if (!resolved.success) return { success: false, data: null, error: resolved.error };

  try {
    const base64 = bytesToBase64(bytes);
    await FileSystem.writeAsStringAsync(resolved.data.uri, base64, { encoding: FileSystem.EncodingType.Base64 });
    return { success: true, data: null, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not write ${relativePath}.` } };
  }
}

