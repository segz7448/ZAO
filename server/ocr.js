/**
 * ZAO Backend - OCR route
 *
 * pdfExtractor.js's own comments (client-side) are explicit that scanned/
 * image-based PDFs "would need real OCR - not built here" - there's no
 * good pure-JS OCR for React Native. This is that missing piece, moved to
 * where it actually belongs: the PC backend, which has real CPU and a
 * Python install already used for the Terminal tool's python39/python311
 * commands.
 *
 * Free/open-source tools only, no paid OCR API:
 *   - Tesseract (via the pytesseract wrapper) does the actual OCR.
 *   - PyMuPDF rasterizes PDF pages to images for Tesseract to read.
 * See scripts/ocr_extract.py's own header for exact package names and the
 * one-time `pip install` needed.
 *
 * The app sends the file as base64 (same pattern the rest of the app
 * already uses for attachments - see fileProcessor.js) rather than a
 * multipart upload, so this route needs no extra Express middleware
 * beyond the express.json({ limit: '25mb' }) already set up in index.js.
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SCRIPT_PATH = path.join(__dirname, 'scripts', 'ocr_extract.py');

/**
 * POST /ocr/extract
 * body: { fileBase64: string, fileName: string }
 * fileName only needs a correct extension (.pdf vs anything else) - the
 * actual bytes are what get OCR'd, the name is just used to pick the PDF
 * vs. plain-image code path in ocr_extract.py.
 */
function registerOcrRoute(app, config, log) {
  app.post('/ocr/extract', async (req, res) => {
    const fileBase64 = req.body?.fileBase64;
    const fileName = req.body?.fileName || 'upload';

    if (!fileBase64 || typeof fileBase64 !== 'string') {
      return res.status(400).json({ error: { message: 'Missing "fileBase64" string in request body.' } });
    }

    let tempPath;
    try {
      const ext = path.extname(fileName) || '.bin';
      tempPath = path.join(os.tmpdir(), `zao-ocr-${crypto.randomUUID()}${ext}`);
      fs.writeFileSync(tempPath, Buffer.from(fileBase64, 'base64'));
    } catch (err) {
      return res.status(400).json({ error: { message: `Could not decode/write file for OCR: ${err.message}` } });
    }

    log(`OCR request: ${fileName} (${(fileBase64.length * 0.75 / 1024).toFixed(0)} KB decoded)`);

    const child = spawn(config.PYTHON_BIN, [SCRIPT_PATH, tempPath], {
      windowsHide: true,
      timeout: config.OCR_TIMEOUT_MS,
    });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });

    const cleanup = () => {
      fs.unlink(tempPath, () => {}); // best-effort, ignore errors
    };

    child.on('error', (err) => {
      cleanup();
      log('OCR spawn error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Could not start Python for OCR (${err.message}). Check PYTHON_BIN in config.js points to a real Python install with pytesseract/pymupdf/pillow installed.`,
          },
        });
      }
    });

    child.on('close', (code, signal) => {
      cleanup();
      if (res.headersSent) return;

      if (signal === 'SIGTERM') {
        return res.status(504).json({ error: { message: 'OCR timed out - the file may be too large or have too many pages.' } });
      }

      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim().split('\n').pop());
      } catch (err) {
        // Fall through to the error response below.
      }

      if (!parsed) {
        log('OCR script produced unparseable output:', stderr || stdout);
        return res.status(500).json({
          error: { message: `OCR script failed (exit ${code}): ${(stderr || stdout || 'no output').slice(0, 500)}` },
        });
      }

      res.json(parsed);
    });
  });
}

module.exports = { registerOcrRoute };
