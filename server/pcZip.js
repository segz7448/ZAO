/**
 * ZAO Backend - PC zip/extract route
 *
 * Packages an existing PC project folder into a real .zip (for handing
 * to the person, or as a build artifact pc_pull_file can bring to the
 * phone), and unpacks an existing .zip on the PC (a downloaded
 * starter/template, or something the person dropped into the project
 * folder) - the PC-side counterpart to fs_zip/fs_extract_zip on the
 * phone (src/services/filesystem/filesystemTool.js).
 *
 * Uses jszip (already a dependency for the phone's on-device PDF/DOCX
 * extractors) rather than shelling out to a platform zip binary - one
 * implementation instead of "zip on posix, PowerShell's
 * Compress-Archive on Windows, and hoping both produce compatible
 * output".
 *
 * Same PC_BRIDGE_ROOT confinement as pcFiles.js - resolveInsideRoot is
 * imported from there rather than reimplemented, since a path-traversal
 * bug fixed in one place should stay fixed everywhere.
 */

const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');
const { resolveInsideRoot } = require('./pcFiles');

const MAX_ZIP_INPUT_BYTES = 100 * 1024 * 1024; // 100MB - generous for a real project, not for node_modules
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', '.zao-checkpoints', 'dist', 'build', '.expo', '.next']);

function collectFiles(dir, baseDir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (WALK_SKIP_DIRS.has(e.name)) continue;
      collectFiles(full, baseDir, out);
    } else {
      out.push({ full, relPath: path.relative(baseDir, full).split(path.sep).join('/') });
    }
  }
}

function registerPcZipRoute(app, config, log) {
  const root = config.PC_BRIDGE_ROOT;

  // POST /pc-fs/zip  { folderPath, zipPath }
  // Zips an entire folder (skipping node_modules/.git/.zao-checkpoints/
  // dist/build, same list pcFiles.js's grep/glob use) into a real .zip
  // file at zipPath. Creates any missing parent folders for zipPath.
  app.post('/pc-fs/zip', async (req, res) => {
    const { folderPath, zipPath } = req.body || {};
    if (!folderPath) return res.status(400).json({ error: { message: 'folderPath is required.' } });
    if (!zipPath) return res.status(400).json({ error: { message: 'zipPath is required.' } });

    const folderTarget = resolveInsideRoot(root, folderPath);
    if (!folderTarget) return res.status(400).json({ error: { message: 'folderPath is outside the allowed PC_BRIDGE_ROOT.' } });
    if (!fs.existsSync(folderTarget)) return res.status(404).json({ error: { message: `${folderPath} does not exist.` } });
    if (!fs.statSync(folderTarget).isDirectory()) return res.status(400).json({ error: { message: `${folderPath} is a file, not a folder.` } });

    const zipTarget = resolveInsideRoot(root, zipPath);
    if (!zipTarget) return res.status(400).json({ error: { message: 'zipPath is outside the allowed PC_BRIDGE_ROOT.' } });

    try {
      const files = [];
      collectFiles(folderTarget, folderTarget, files);

      let totalBytes = 0;
      for (const f of files) totalBytes += fs.statSync(f.full).size;
      if (totalBytes > MAX_ZIP_INPUT_BYTES) {
        return res.status(413).json({ error: { message: `${folderPath} is ${(totalBytes / 1024 / 1024).toFixed(0)}MB before compression, over the ${(MAX_ZIP_INPUT_BYTES / 1024 / 1024).toFixed(0)}MB limit. Exclude large assets/build output first.` } });
      }

      const zip = new JSZip();
      for (const f of files) {
        zip.file(f.relPath, fs.readFileSync(f.full));
      }
      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });

      fs.mkdirSync(path.dirname(zipTarget), { recursive: true });
      fs.writeFileSync(zipTarget, buffer);
      log(`PC zip: zipped ${folderTarget} -> ${zipTarget} (${files.length} files, ${buffer.length} bytes)`);
      res.json({ zipPath, fileCount: files.length, size: buffer.length });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // POST /pc-fs/extract-zip  { zipPath, destinationFolderPath }
  // Unpacks an existing .zip on the PC into destinationFolderPath,
  // creating it (and any nested folders the archive needs) as it goes.
  app.post('/pc-fs/extract-zip', async (req, res) => {
    const { zipPath, destinationFolderPath } = req.body || {};
    if (!zipPath) return res.status(400).json({ error: { message: 'zipPath is required.' } });
    if (destinationFolderPath === undefined) return res.status(400).json({ error: { message: 'destinationFolderPath is required (use "" for the project root).' } });

    const zipTarget = resolveInsideRoot(root, zipPath);
    if (!zipTarget) return res.status(400).json({ error: { message: 'zipPath is outside the allowed PC_BRIDGE_ROOT.' } });
    if (!fs.existsSync(zipTarget)) return res.status(404).json({ error: { message: `${zipPath} does not exist.` } });

    const destTarget = resolveInsideRoot(root, destinationFolderPath);
    if (!destTarget) return res.status(400).json({ error: { message: 'destinationFolderPath is outside the allowed PC_BRIDGE_ROOT.' } });

    try {
      const buffer = fs.readFileSync(zipTarget);
      const zip = await JSZip.loadAsync(buffer);

      let fileCount = 0;
      const entries = Object.values(zip.files);
      for (const entry of entries) {
        if (entry.dir) continue;
        // Guard against a zip-slip entry (e.g. "../../evil.js") landing
        // outside destTarget, same confinement resolveInsideRoot already
        // enforces for every other route.
        const entryTarget = resolveInsideRoot(root, path.join(destinationFolderPath, entry.name));
        if (!entryTarget) continue; // skip anything that would escape the root instead of failing the whole extract
        // eslint-disable-next-line no-await-in-loop -- entries must be written in order for zip-slip guarding to stay simple; extraction is not a hot path
        const content = await entry.async('nodebuffer');
        fs.mkdirSync(path.dirname(entryTarget), { recursive: true });
        fs.writeFileSync(entryTarget, content);
        fileCount += 1;
      }

      log(`PC zip: extracted ${zipTarget} -> ${destTarget} (${fileCount} files)`);
      res.json({ destinationFolderPath, fileCount });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });
}

module.exports = { registerPcZipRoute };
