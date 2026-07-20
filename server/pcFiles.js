/**
 * ZAO Backend - PC file bridge route
 *
 * The PC backend and the phone are two SEPARATE filesystems: the phone
 * app only ever writes into the one SAF folder you granted it
 * (src/services/filesystem/filesystemTool.js) - it has no visibility
 * into anything terminal_pc_run_command creates on the PC's own disk.
 * So when a command like `npm install` or `gradlew assembleRelease` runs
 * on the PC and produces files there (node_modules, a built APK, a
 * bundle, whatever), those files just sit on the PC. Nothing copies them
 * to the phone automatically.
 *
 * This route is the bridge: it lets the app ask the PC "what's in this
 * folder" and "give me this specific file's bytes", so the model can
 * pull a build artifact (e.g. the finished .apk) down and save it into
 * the phone's SAF folder with the existing fs_create_file tool - see
 * pcFilePullTool.js on the app side.
 *
 * Deliberately NOT a general file-browser: reads are restricted to
 * PC_BRIDGE_ROOT (config.js) and any path that resolves outside of it
 * (via ../, absolute paths, etc.) is rejected, since this server is
 * reachable over LAN and the public Cloudflare tunnel, not just
 * 127.0.0.1.
 */

const fs = require('fs');
const path = require('path');

function resolveInsideRoot(root, relativePath) {
  const cleaned = String(relativePath || '').replace(/^[/\\]+/, '');
  const resolved = path.resolve(root, cleaned);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    return null; // path traversal attempt or escape outside root
  }
  return resolved;
}

function registerPcFilesRoute(app, config, log) {
  const root = config.PC_BRIDGE_ROOT;

  // GET /pc-fs/list?path=some/subfolder
  app.get('/pc-fs/list', (req, res) => {
    const target = resolveInsideRoot(root, req.query?.path || '');
    if (!target) return res.status(400).json({ error: { message: 'Path is outside the allowed PC_BRIDGE_ROOT.' } });
    if (!fs.existsSync(target)) return res.status(404).json({ error: { message: `${target} does not exist.` } });

    try {
      const stat = fs.statSync(target);
      if (!stat.isDirectory()) {
        return res.status(400).json({ error: { message: `${target} is a file, not a folder - use /pc-fs/read instead.` } });
      }
      const entries = fs.readdirSync(target, { withFileTypes: true }).map((e) => {
        const entryPath = path.join(target, e.name);
        const entryStat = fs.statSync(entryPath);
        return { name: e.name, isDir: e.isDirectory(), size: e.isDirectory() ? null : entryStat.size };
      });
      log(`PC file bridge: listed ${target} (${entries.length} entries)`);
      res.json({ path: req.query?.path || '', entries });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // GET /pc-fs/read?path=some/build/app-release.apk
  // Returns base64 content - fine for reasonable build artifacts (APKs,
  // bundles, zips); not meant for huge files given this goes over one
  // HTTP response with no chunking/streaming.
  app.get('/pc-fs/read', (req, res) => {
    const target = resolveInsideRoot(root, req.query?.path || '');
    if (!target) return res.status(400).json({ error: { message: 'Path is outside the allowed PC_BRIDGE_ROOT.' } });
    if (!fs.existsSync(target)) return res.status(404).json({ error: { message: `${target} does not exist.` } });

    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) {
        return res.status(400).json({ error: { message: `${target} is a folder, not a file - use /pc-fs/list instead.` } });
      }
      if (stat.size > config.PC_BRIDGE_MAX_FILE_BYTES) {
        return res.status(413).json({
          error: { message: `${target} is ${(stat.size / 1024 / 1024).toFixed(1)}MB, over the ${(config.PC_BRIDGE_MAX_FILE_BYTES / 1024 / 1024).toFixed(0)}MB limit for a single pull. Zip it first, or raise ZAO_PC_BRIDGE_MAX_FILE_MB.` },
        });
      }
      const contentB64 = fs.readFileSync(target, { encoding: 'base64' });
      log(`PC file bridge: read ${target} (${stat.size} bytes)`);
      res.json({ path: req.query?.path || '', size: stat.size, contentB64 });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });
}

module.exports = { registerPcFilesRoute };
