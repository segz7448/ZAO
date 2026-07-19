/**
 * ZAO - PPTX Tool
 *
 * Creates PowerPoint presentations using pptxgenjs - a pure-JavaScript
 * library, same reasoning as the other Office/PDF tools in this suite.
 *
 * HONEST LIMITATION: same as pdfTool.js/docxTool.js/xlsxTool.js -
 * pptxgenjs's behavior under Hermes specifically hasn't been
 * runtime-verified here.
 *
 * SCOPE: title slides + bullet/text slides only - no charts, images, or
 * icons. This matches the simpler scope of the other Office tools ("the
 * model writes content, the plugin generates files") and deliberately
 * avoids the much larger surface area covered in
 * /mnt/skills/public/pptx/SKILL.md's gotchas around native charts, icon
 * rendering via react-icons/sharp, and template-based editing - all of
 * which assume tooling (Python, sharp's native image processing) that
 * doesn't exist on-device.
 *
 * A few of that skill's documented gotchas are real file-corruption
 * risks regardless of scope, so they're baked into this tool directly
 * rather than left for the local coder model to accidentally violate:
 *   - hex colors must never include '#' or an alpha channel
 *   - shadow offsets must never be negative
 *   - layout must be set before slides are added
 *   - bullets use bullet:true, never a literal "•" character
 */

import PptxGenJS from 'pptxgenjs';
import { getOrCreateFileUriForTools } from '../filesystem/filesystemTool';
import * as FileSystem from 'expo-file-system/legacy';

const LAYOUTS = {
  standard: 'LAYOUT_4x3', // 10" x 7.5"
  widescreen: 'LAYOUT_16x9', // 10" x 5.625"
  wide: 'LAYOUT_WIDE', // 13.3" x 7.5"
};

/**
 * Strips a leading '#' and truncates to 6 hex digits - pptxgenjs
 * corrupts the file on '#FF0000' or an 8-digit hex with baked-in alpha,
 * per the documented gotcha. Called on every color value this tool
 * accepts so a model-provided "#ff0000" or similar never reaches
 * pptxgenjs unsanitized.
 */
function sanitizeHex(hex, fallback = '000000') {
  if (!hex) return fallback;
  const cleaned = hex.replace('#', '').slice(0, 6);
  return /^[0-9a-fA-F]{6}$/.test(cleaned) ? cleaned : fallback;
}

/**
 * Creates a new .pptx from an ordered list of slides.
 *
 * @param {Array<object>} slides - each slide is one of:
 *   { type: 'title', title: string, subtitle?: string }
 *   { type: 'content', title: string, bullets?: string[], text?: string, notes?: string }
 * @param {string} outputPath - relative to the granted filesystem folder, e.g. "pitch.pptx"
 * @param {object} options - { layout: 'standard'|'widescreen'|'wide' (default widescreen), accentColor: hex without '#' }
 */
export async function createPptx(slides, outputPath, options = {}) {
  const { layout = 'widescreen', accentColor = '2563EB' } = options;
  const safeAccent = sanitizeHex(accentColor, '2563EB');

  try {
    // "One new pptxgen() per output file - never reuse an instance" is a
    // documented gotcha; this function creates exactly one and only
    // exports it once, so that constraint holds naturally.
    const pres = new PptxGenJS();
    // Layout MUST be set before any addSlide() call, or the default
    // LAYOUT_16x9 dimensions apply regardless of what's requested here -
    // coordinates past the actual canvas edge are silently written but
    // never rendered, not clamped or errored.
    pres.layout = LAYOUTS[layout] || LAYOUTS.widescreen;

    for (const slideSpec of slides) {
      const slide = pres.addSlide();

      if (slideSpec.type === 'title') {
        slide.addText(slideSpec.title, {
          x: 0.5, y: 2.0, w: '90%', h: 1.2,
          fontSize: 36, bold: true, align: 'center', color: '1F2937',
        });
        if (slideSpec.subtitle) {
          slide.addText(slideSpec.subtitle, {
            x: 0.5, y: 3.3, w: '90%', h: 0.8,
            fontSize: 18, align: 'center', color: safeAccent,
          });
        }
      } else {
        slide.addText(slideSpec.title || '', {
          x: 0.5, y: 0.4, w: '90%', h: 0.8,
          fontSize: 26, bold: true, color: '1F2937',
        });

        if (slideSpec.bullets?.length) {
          // bullet: true on each item (never a literal "•" - that
          // renders a double bullet), breakLine: true on every item
          // except the last, per the documented gotcha.
          const bulletItems = slideSpec.bullets.map((line, i) => ({
            text: line,
            options: {
              bullet: true,
              breakLine: i < slideSpec.bullets.length - 1,
              paraSpaceAfter: 8,
              fontSize: 16,
              color: '374151',
            },
          }));
          slide.addText(bulletItems, { x: 0.5, y: 1.4, w: '90%', h: 5.0 });
        } else if (slideSpec.text) {
          slide.addText(slideSpec.text, {
            x: 0.5, y: 1.4, w: '90%', h: 5.0,
            fontSize: 16, color: '374151',
          });
        }
      }

      if (slideSpec.notes) {
        // Speaker notes go through addNotes, plain text, once per slide -
        // never as a text box placed on the slide itself.
        slide.addNotes(slideSpec.notes);
      }
    }

    // write({ outputType: 'base64' }) - the universal on-device
    // serialization format used consistently across pdfTool.js/
    // docxTool.js/xlsxTool.js, since it writes cleanly through
    // expo-file-system without needing Node's Buffer or a browser Blob.
    const base64 = await pres.write({ outputType: 'base64' });

    const resolved = await getOrCreateFileUriForTools(
      outputPath,
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    );
    if (!resolved.success) return { success: false, data: null, error: resolved.error };

    await FileSystem.writeAsStringAsync(resolved.data.uri, base64, { encoding: FileSystem.EncodingType.Base64 });

    return { success: true, data: { path: outputPath, slideCount: slides.length }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Could not create presentation.' } };
  }
}
