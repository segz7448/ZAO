/**
 * ZAO Backend - Data analysis route
 *
 * The Python-dependent "data connectivity" piece discussed alongside OCR:
 * xlsxTool.js (client-side) can only CREATE spreadsheets with SheetJS -
 * it has no way to actually analyze existing tabular data (filter,
 * group, real summary statistics), because that's what pandas is for,
 * and there's no Python runtime on the phone. Same fix as OCR: moved to
 * the PC backend, which already has Python for the Terminal tool's
 * python39/python311 commands.
 *
 * See scripts/data_analyze.py's own header for exact package names, the
 * one-time `pip install`, and why this deliberately does NOT expose
 * arbitrary pandas eval/exec (terminal_pc_run_command already covers
 * "I need real Python" - this is a bounded, structured alternative, not
 * a second copy of it under a different name).
 */

const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SCRIPT_PATH = path.join(__dirname, 'scripts', 'data_analyze.py');

/**
 * POST /data/analyze
 * body: { fileBase64: string, fileName: string, options: object }
 * fileName only needs a correct extension (.csv/.tsv/.xlsx/.xls) - see
 * data_analyze.py's load_dataframe() for exactly how each is read.
 * options is passed straight through to the script as JSON - see that
 * script's header for the operation/parameter shape (describe/head/
 * filter/groupby).
 */
function registerDataRoute(app, config, log) {
  app.post('/data/analyze', async (req, res) => {
    const fileBase64 = req.body?.fileBase64;
    const fileName = req.body?.fileName || 'upload.csv';
    const options = req.body?.options || {};

    if (!fileBase64 || typeof fileBase64 !== 'string') {
      return res.status(400).json({ error: { message: 'Missing "fileBase64" string in request body.' } });
    }

    let tempPath;
    try {
      const ext = path.extname(fileName) || '.csv';
      tempPath = path.join(os.tmpdir(), `zao-data-${crypto.randomUUID()}${ext}`);
      fs.writeFileSync(tempPath, Buffer.from(fileBase64, 'base64'));
    } catch (err) {
      return res.status(400).json({ error: { message: `Could not decode/write file for analysis: ${err.message}` } });
    }

    log(`Data analysis request: ${fileName} (${(fileBase64.length * 0.75 / 1024).toFixed(0)} KB decoded), operation=${options.operation || 'describe'}`);

    const child = spawn(config.PYTHON_BIN, [SCRIPT_PATH, tempPath, JSON.stringify(options)], {
      windowsHide: true,
      timeout: config.DATA_TIMEOUT_MS,
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
      log('Data analysis spawn error:', err.message);
      if (!res.headersSent) {
        res.status(500).json({
          error: {
            message: `Could not start Python for data analysis (${err.message}). Check PYTHON_BIN in config.js points to a real Python install with pandas/openpyxl installed.`,
          },
        });
      }
    });

    child.on('close', (code, signal) => {
      cleanup();
      if (res.headersSent) return;

      if (signal === 'SIGTERM') {
        return res.status(504).json({ error: { message: 'Data analysis timed out - the file may be too large for this operation.' } });
      }

      let parsed = null;
      try {
        parsed = JSON.parse(stdout.trim().split('\n').pop());
      } catch (err) {
        // Fall through to the error response below.
      }

      if (!parsed) {
        log('Data analysis script produced unparseable output:', stderr || stdout);
        return res.status(500).json({
          error: { message: `Data analysis script failed (exit ${code}): ${(stderr || stdout || 'no output').slice(0, 500)}` },
        });
      }

      res.json(parsed);
    });
  });
}

module.exports = { registerDataRoute };
