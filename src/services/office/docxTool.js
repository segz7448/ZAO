/**
 * ZAO - DOCX Tool
 *
 * Creates Word documents using docx (docx-js) - a pure-JavaScript
 * library, same reasoning as pdfTool.js's use of pdf-lib: no Python
 * runtime exists on-device, so this is the JS-only equivalent of what
 * Claude's own sandbox would do with python-docx.
 *
 * HONEST LIMITATION: like pdfTool.js, this hasn't been runtime-verified
 * under Hermes specifically - docx-js is a well-established, pure-JS
 * library with no native dependencies, but "should work" isn't the same
 * as "confirmed working on a real device."
 *
 * SCOPE: intentionally simple - headings and paragraphs, matching the
 * same "the model writes content, the plugin generates files" scope as
 * pdfTool.js's createPdf. No tables, TOC, tracked changes, or template-
 * based editing - those would be a meaningfully larger effort (see
 * /mnt/skills/public/docx/SKILL.md's gotchas for how much surface area
 * full docx-js support actually has).
 *
 * Editing an EXISTING .docx is not supported here either - that requires
 * unzipping, parsing/patching word/document.xml, and rezipping (docx-js
 * cannot open existing files, only create new ones) - a separate, larger
 * effort than this pass covers.
 */

import { Document, Packer, Paragraph, TextRun, HeadingLevel, AlignmentType } from 'docx';
import { getOrCreateFileUriForTools } from '../filesystem/filesystemTool';
import * as FileSystem from 'expo-file-system/legacy';

/**
 * Creates a new .docx from structured content - ordered blocks of
 * headings and paragraphs, written by the model and turned into a real
 * Word document here.
 *
 * @param {Array<{heading?: string, headingLevel?: 1|2|3, text?: string}>} sections
 * @param {string} outputPath - relative to the granted filesystem folder, e.g. "reports/proposal.docx"
 * @param {object} options - { title }
 */
export async function createDocx(sections, outputPath, options = {}) {
  const { title } = options;

  try {
    const headingLevelMap = {
      1: HeadingLevel.HEADING_1,
      2: HeadingLevel.HEADING_2,
      3: HeadingLevel.HEADING_3,
    };

    const children = [];
    for (const section of sections) {
      if (section.heading) {
        children.push(
          new Paragraph({
            heading: headingLevelMap[section.headingLevel] || HeadingLevel.HEADING_1,
            children: [new TextRun({ text: section.heading, bold: true })],
          })
        );
      }
      if (section.text) {
        // Split on real paragraph breaks - the model should already be
        // sending separate sections rather than embedding \n, but this
        // is a defensive fallback so a single section with literal
        // newlines still renders as separate paragraphs rather than one
        // run with invisible line breaks (docx-js's own documented
        // gotcha: "never use \n").
        const paragraphs = section.text.split('\n').filter((p) => p.trim().length > 0);
        for (const para of paragraphs) {
          children.push(new Paragraph({ children: [new TextRun(para)], alignment: AlignmentType.LEFT }));
        }
      }
    }

    const doc = new Document({
      title: title || undefined,
      sections: [{ children }],
    });

    // Packer.toBase64String, not toBuffer() (needs Node's Buffer, not
    // available in Hermes) or toBlob() (needs a real browser Blob, only
    // partially/inconsistently polyfilled in React Native) - this is
    // docx-js's environment-agnostic output method, matching how
    // pdf-lib/pdfTool.js and pptxgenjs below all end up going through
    // base64 as the universal on-device serialization format.
    const base64 = await Packer.toBase64String(doc);
    const resolved = await getOrCreateFileUriForTools(
      outputPath,
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    );
    if (!resolved.success) return { success: false, data: null, error: resolved.error };

    await FileSystem.writeAsStringAsync(resolved.data.uri, base64, { encoding: FileSystem.EncodingType.Base64 });

    return { success: true, data: { path: outputPath }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Could not create Word document.' } };
  }
}
