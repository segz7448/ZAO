/**
 * ZAO - Office Document Extractors (DOCX, PPTX)
 *
 * Both .docx and .pptx are ZIP archives containing XML. Rather than pull in
 * a heavy native docx/pptx parsing library, we use jszip (pure JS, no
 * native code - safe given our Gradle history) to open the archive and a
 * lightweight regex-based XML text stripper to pull out the readable text.
 *
 * This won't preserve formatting, tables, or images - it extracts the text
 * content, which is what matters for "read this document and tell me
 * about it" style requests. If richer structure is ever needed, that's a
 * bigger follow-up (e.g. rendering slide layouts), not something to bolt
 * on here.
 */

import JSZip from 'jszip';
import * as FileSystem from 'expo-file-system';

/**
 * Strips XML tags and decodes common entities, leaving just the text
 * content. Word/PowerPoint XML wraps each run of text in <w:t> or <a:t>
 * tags - we specifically extract those rather than naively stripping ALL
 * tags, since that also captures unwanted metadata/formatting attribute text.
 */
function extractTextFromXml(xml, tagPattern) {
  const matches = [...xml.matchAll(tagPattern)];
  return matches
    .map((m) => m[1])
    .join(' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * @param {string} fileUri - local file:// URI
 * @returns {Promise<{success: boolean, text: string, error: string|null}>}
 */
export async function extractDocxText(fileUri) {
  try {
    const base64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const zip = await JSZip.loadAsync(base64, { base64: true });

    const documentXmlFile = zip.file('word/document.xml');
    if (!documentXmlFile) {
      return { success: false, text: '', error: 'This file doesn\'t look like a valid .docx (missing word/document.xml)' };
    }

    const xml = await documentXmlFile.async('string');
    // Word wraps each text run in <w:t>...</w:t>
    const text = extractTextFromXml(xml, /<w:t[^>]*>([^<]*)<\/w:t>/g);

    // Paragraphs are marked with <w:p> - insert line breaks at paragraph
    // boundaries for readability rather than one giant run-on string.
    const withParagraphBreaks = xml
      .split(/<\/w:p>/)
      .map((para) => extractTextFromXml(para, /<w:t[^>]*>([^<]*)<\/w:t>/g))
      .filter((p) => p.length > 0)
      .join('\n');

    return { success: true, text: withParagraphBreaks || text, error: null };
  } catch (err) {
    console.error('[DocxExtractor] failed:', err);
    return { success: false, text: '', error: 'Could not read this .docx file. It may be corrupted or password-protected.' };
  }
}

/**
 * @param {string} fileUri - local file:// URI
 * @returns {Promise<{success: boolean, text: string, error: string|null}>}
 */
export async function extractPptxText(fileUri) {
  try {
    const base64 = await FileSystem.readAsStringAsync(fileUri, {
      encoding: FileSystem.EncodingType.Base64,
    });
    const zip = await JSZip.loadAsync(base64, { base64: true });

    // Slides live at ppt/slides/slide1.xml, slide2.xml, etc. - collect and
    // sort numerically so output follows presentation order, not whatever
    // order the zip happens to list files in.
    const slideFiles = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => {
        const numA = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
        const numB = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
        return numA - numB;
      });

    if (slideFiles.length === 0) {
      return { success: false, text: '', error: 'This file doesn\'t look like a valid .pptx (no slides found)' };
    }

    const slideTexts = [];
    for (let i = 0; i < slideFiles.length; i++) {
      const xml = await zip.file(slideFiles[i]).async('string');
      // PowerPoint wraps text runs in <a:t>...</a:t>
      const text = extractTextFromXml(xml, /<a:t[^>]*>([^<]*)<\/a:t>/g);
      slideTexts.push(`--- Slide ${i + 1} ---\n${text || '(no text on this slide)'}`);
    }

    return { success: true, text: slideTexts.join('\n\n'), error: null };
  } catch (err) {
    console.error('[PptxExtractor] failed:', err);
    return { success: false, text: '', error: 'Could not read this .pptx file. It may be corrupted or password-protected.' };
  }
}
