/**
 * ZAO Backend - PC file bridge route
 *
 * Originally this was READ-ONLY: a bridge for pulling PC-side build
 * artifacts (an APK, a bundle) down to the phone's own SAF folder after
 * terminal_pc_run_command produced them.
 *
 * Now that ZAO's whole workflow lives on the PC (no more phone/Termux
 * development - the phone is just the chat client), this route is also
 * the primary way the model writes actual project files: /pc-fs/write,
 * /pc-fs/mkdir, /pc-fs/edit, and /pc-fs/delete let it create a project
 * folder and every HTML/CSS/JS/component file directly on the PC's own
 * disk, in the same place terminal_pc_run_command already runs npm
 * install/build/serve - so a scaffolded project and the terminal that
 * builds/runs it are always looking at the same files. See
 * pcFilesystemTool.js on the app side.
 *
 * Every route here is restricted to PC_BRIDGE_ROOT (config.js); any path
 * that resolves outside of it (via ../, absolute paths, drive letters,
 * etc.) is rejected, since this server is reachable over LAN and the
 * public Cloudflare tunnel, not just 127.0.0.1.
 */

const fs = require('fs');
const path = require('path');

// 5MB is generous for source files (html/css/js/json/etc.) - if a write
// or edit needs more than that, something is probably wrong with the
// request (e.g. binary data sent as text) rather than this limit being
// too small for a real source file.
const MAX_WRITE_BYTES = 5 * 1024 * 1024;

function resolveInsideRoot(root, relativePath) {
  const cleaned = String(relativePath || '').replace(/^[/\\]+/, '');
  const resolved = path.resolve(root, cleaned);
  const normalizedRoot = path.resolve(root);
  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    return null; // path traversal attempt or escape outside root
  }
  return resolved;
}

const CHECKPOINT_DIR = '.zao-checkpoints';
const MAX_CHECKPOINTS = 100;
// Directories skipped when walking the tree for grep/glob - these are
// either huge (node_modules), noise (.git), or ZAO's own bookkeeping
// (.zao-checkpoints) that shouldn't show up as "project files".
const WALK_SKIP_DIRS = new Set(['node_modules', '.git', '.zao-checkpoints', 'dist', 'build', '.expo', '.next']);

function checkpointsDir(root) {
  return path.join(root, CHECKPOINT_DIR);
}

function readCheckpointsIndex(root) {
  const indexPath = path.join(checkpointsDir(root), 'index.json');
  if (!fs.existsSync(indexPath)) return [];
  try {
    return JSON.parse(fs.readFileSync(indexPath, 'utf8'));
  } catch {
    return [];
  }
}

function writeCheckpointsIndex(root, list) {
  fs.mkdirSync(checkpointsDir(root), { recursive: true });
  fs.writeFileSync(path.join(checkpointsDir(root), 'index.json'), JSON.stringify(list), 'utf8');
}

function newCheckpointId() {
  return `pcckpt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * Snapshots a file's (or, for a recursive folder delete, every file
 * under a folder's) state immediately BEFORE a mutating route changes
 * it, so pc_fs_rewind_checkpoint can put it back. Deliberately simple
 * and self-contained (no DB, just JSON + snapshot files under the
 * hidden .zao-checkpoints/ folder inside PC_BRIDGE_ROOT) rather than
 * mirroring the phone's SQLite-backed checkpointManager.js - this is a
 * lightweight undo net for the PC side, not a version control system.
 * Oldest entries are pruned past MAX_CHECKPOINTS (snapshot files removed
 * too) so this can't grow forever.
 */
function recordCheckpoint(root, entry) {
  const id = newCheckpointId();
  fs.mkdirSync(checkpointsDir(root), { recursive: true });

  const snapshotFileName = `${id}.json`;
  fs.writeFileSync(path.join(checkpointsDir(root), snapshotFileName), JSON.stringify(entry.snapshot), 'utf8');

  const index = readCheckpointsIndex(root);
  index.push({
    id,
    timestamp: Date.now(),
    operation: entry.operation,
    path: entry.path,
    newPath: entry.newPath || null,
    type: entry.type, // 'file' | 'folder'
  });

  while (index.length > MAX_CHECKPOINTS) {
    const dropped = index.shift();
    const droppedFile = path.join(checkpointsDir(root), `${dropped.id}.json`);
    if (fs.existsSync(droppedFile)) fs.unlinkSync(droppedFile);
  }

  writeCheckpointsIndex(root, index);
  return id;
}

function readSnapshot(root, id) {
  const snapshotPath = path.join(checkpointsDir(root), `${id}.json`);
  if (!fs.existsSync(snapshotPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  } catch {
    return null;
  }
}

/** Captures a single file's pre-mutation state for recordCheckpoint(). */
function captureFileState(target) {
  if (!fs.existsSync(target) || fs.statSync(target).isDirectory()) {
    return { existed: false, contentB64: null };
  }
  return { existed: true, contentB64: fs.readFileSync(target).toString('base64') };
}

/**
 * Captures every file under a folder before a recursive delete, so one
 * pc_fs_delete on a folder is one atomic checkpoint to rewind, not N
 * separate ones. Capped at 20MB total so a checkpoint of node_modules
 * (which should never be deleted through this tool anyway, but just in
 * case) can't balloon .zao-checkpoints/.
 */
function captureFolderState(target, root) {
  const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
  const files = [];
  let totalBytes = 0;
  let truncated = false;

  function walk(dir) {
    if (truncated) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (truncated) return;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (WALK_SKIP_DIRS.has(e.name)) continue;
        walk(full);
      } else {
        const size = fs.statSync(full).size;
        if (totalBytes + size > MAX_TOTAL_BYTES) {
          truncated = true;
          return;
        }
        totalBytes += size;
        files.push({
          relPath: path.relative(target, full).split(path.sep).join('/'),
          contentB64: fs.readFileSync(full).toString('base64'),
        });
      }
    }
  }
  walk(target);
  return { files, truncated };
}

/** Restores whatever a checkpoint captured, back to disk. */
function restoreSnapshot(root, entry, snapshot) {
  if (entry.type === 'folder') {
    const folderTarget = resolveInsideRoot(root, entry.path);
    fs.mkdirSync(folderTarget, { recursive: true });
    for (const f of snapshot.files || []) {
      const filePath = path.join(folderTarget, f.relPath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, Buffer.from(f.contentB64, 'base64'));
    }
    return;
  }

  // type === 'file'
  const target = resolveInsideRoot(root, entry.path);
  if (snapshot.existed) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, Buffer.from(snapshot.contentB64, 'base64'));
  } else if (fs.existsSync(target)) {
    // The mutation created something that didn't exist before - undo means removing it.
    fs.rmSync(target, { recursive: fs.statSync(target).isDirectory(), force: true });
  }

  // rename/move: also remove whatever landed at the new path, since the
  // content now lives back at entry.path instead.
  if (entry.newPath) {
    const newTarget = resolveInsideRoot(root, entry.newPath);
    if (newTarget && fs.existsSync(newTarget)) {
      fs.rmSync(newTarget, { recursive: fs.statSync(newTarget).isDirectory(), force: true });
    }
  }
}

/** Simple glob -> RegExp: `**` matches any depth, `*` matches within one path segment, `?` matches one character. Nothing fancier (no brace expansion, no character classes) - enough for "find files by name pattern" without pulling in a glob dependency. */
function globToRegExp(pattern) {
  let re = '';
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        re += '.*';
        i += 1;
        if (pattern[i + 1] === '/') i += 1;
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += `\\${c}`;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, 'i');
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

  // POST /pc-fs/mkdir  { path }
  // Creates a folder (and any missing parent folders) - the first step
  // of scaffolding a new project. No-ops (success) if it already exists,
  // same as `mkdir -p`, so the model doesn't need to check first.
  app.post('/pc-fs/mkdir', (req, res) => {
    const relPath = req.body?.path;
    if (!relPath) return res.status(400).json({ error: { message: 'path is required.' } });
    const target = resolveInsideRoot(root, relPath);
    if (!target) return res.status(400).json({ error: { message: 'Path is outside the allowed PC_BRIDGE_ROOT.' } });

    try {
      fs.mkdirSync(target, { recursive: true });
      log(`PC file bridge: mkdir ${target}`);
      res.json({ path: relPath });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // POST /pc-fs/write  { path, content, overwrite }
  // Creates (or overwrites) one text file, creating any missing parent
  // folders along the way - so "write file at
  // myproject/src/components/Header.js" works even if myproject/src/components
  // doesn't exist yet, without a separate mkdir call first. Refuses to
  // silently clobber an existing file unless overwrite:true is passed,
  // so an accidental duplicate write can't wipe out real work.
  app.post('/pc-fs/write', (req, res) => {
    const { path: relPath, content, overwrite } = req.body || {};
    if (!relPath) return res.status(400).json({ error: { message: 'path is required.' } });
    if (typeof content !== 'string') return res.status(400).json({ error: { message: 'content must be a string.' } });

    const byteLength = Buffer.byteLength(content, 'utf8');
    if (byteLength > MAX_WRITE_BYTES) {
      return res.status(413).json({
        error: { message: `Content is ${(byteLength / 1024 / 1024).toFixed(1)}MB, over the ${(MAX_WRITE_BYTES / 1024 / 1024).toFixed(0)}MB limit for a single write.` },
      });
    }

    const target = resolveInsideRoot(root, relPath);
    if (!target) return res.status(400).json({ error: { message: 'Path is outside the allowed PC_BRIDGE_ROOT.' } });

    try {
      const alreadyExists = fs.existsSync(target);
      if (alreadyExists && fs.statSync(target).isDirectory()) {
        return res.status(400).json({ error: { message: `${relPath} is already a folder.` } });
      }
      if (alreadyExists && !overwrite) {
        return res.status(409).json({ error: { message: `${relPath} already exists. Pass overwrite:true to replace it, or use /pc-fs/edit for a targeted change.` } });
      }
      const priorState = captureFileState(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, 'utf8');
      const checkpointId = recordCheckpoint(root, { operation: 'write', path: relPath, type: 'file', snapshot: priorState });
      log(`PC file bridge: wrote ${target} (${byteLength} bytes)`);
      res.json({ path: relPath, size: byteLength, created: !alreadyExists, checkpointId });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // POST /pc-fs/write-binary  { path, contentB64, overwrite }
  // Same contract as /pc-fs/write, but for binary content (images,
  // icons, favicons, generated assets) - takes base64 instead of a UTF-8
  // string so bytes round-trip exactly instead of getting corrupted by
  // text encoding.
  app.post('/pc-fs/write-binary', (req, res) => {
    const { path: relPath, contentB64, overwrite } = req.body || {};
    if (!relPath) return res.status(400).json({ error: { message: 'path is required.' } });
    if (typeof contentB64 !== 'string' || !contentB64.length) return res.status(400).json({ error: { message: 'contentB64 is required.' } });

    let buffer;
    try {
      buffer = Buffer.from(contentB64, 'base64');
    } catch {
      return res.status(400).json({ error: { message: 'contentB64 is not valid base64.' } });
    }
    if (buffer.length > MAX_WRITE_BYTES) {
      return res.status(413).json({
        error: { message: `Content is ${(buffer.length / 1024 / 1024).toFixed(1)}MB, over the ${(MAX_WRITE_BYTES / 1024 / 1024).toFixed(0)}MB limit for a single write.` },
      });
    }

    const target = resolveInsideRoot(root, relPath);
    if (!target) return res.status(400).json({ error: { message: 'Path is outside the allowed PC_BRIDGE_ROOT.' } });

    try {
      const alreadyExists = fs.existsSync(target);
      if (alreadyExists && fs.statSync(target).isDirectory()) {
        return res.status(400).json({ error: { message: `${relPath} is already a folder.` } });
      }
      if (alreadyExists && !overwrite) {
        return res.status(409).json({ error: { message: `${relPath} already exists. Pass overwrite:true to replace it.` } });
      }
      const priorState = captureFileState(target);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, buffer);
      const checkpointId = recordCheckpoint(root, { operation: 'write', path: relPath, type: 'file', snapshot: priorState });
      log(`PC file bridge: wrote binary ${target} (${buffer.length} bytes)`);
      res.json({ path: relPath, size: buffer.length, created: !alreadyExists, checkpointId });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // POST /pc-fs/edit  { path, oldString, newString, replaceAll }
  // Targeted find-and-replace against an existing text file - mirrors
  // fs_edit_file's contract (oldString must match exactly and, unless
  // replaceAll is set, uniquely) so a small change doesn't require
  // resending the whole file content.
  app.post('/pc-fs/edit', (req, res) => {
    const { path: relPath, oldString, newString, replaceAll } = req.body || {};
    if (!relPath) return res.status(400).json({ error: { message: 'path is required.' } });
    if (typeof oldString !== 'string' || !oldString.length) return res.status(400).json({ error: { message: 'oldString is required and cannot be empty.' } });
    if (typeof newString !== 'string') return res.status(400).json({ error: { message: 'newString must be a string.' } });

    const target = resolveInsideRoot(root, relPath);
    if (!target) return res.status(400).json({ error: { message: 'Path is outside the allowed PC_BRIDGE_ROOT.' } });
    if (!fs.existsSync(target)) return res.status(404).json({ error: { message: `${relPath} does not exist.` } });

    try {
      const stat = fs.statSync(target);
      if (stat.isDirectory()) return res.status(400).json({ error: { message: `${relPath} is a folder, not a file.` } });

      const current = fs.readFileSync(target, 'utf8');
      const occurrences = current.split(oldString).length - 1;
      if (occurrences === 0) {
        return res.status(400).json({ error: { message: 'oldString was not found in the file. Read the file first and copy the exact text.' } });
      }
      if (occurrences > 1 && !replaceAll) {
        return res.status(400).json({ error: { message: `oldString appears ${occurrences} times - it must be unique. Include more surrounding context, or pass replaceAll:true.` } });
      }

      const updated = replaceAll
        ? current.split(oldString).join(newString)
        : current.replace(oldString, newString);

      const byteLength = Buffer.byteLength(updated, 'utf8');
      if (byteLength > MAX_WRITE_BYTES) {
        return res.status(413).json({ error: { message: `Resulting file would be ${(byteLength / 1024 / 1024).toFixed(1)}MB, over the ${(MAX_WRITE_BYTES / 1024 / 1024).toFixed(0)}MB limit.` } });
      }

      const priorState = { existed: true, contentB64: Buffer.from(current, 'utf8').toString('base64') };
      fs.writeFileSync(target, updated, 'utf8');
      const checkpointId = recordCheckpoint(root, { operation: 'edit', path: relPath, type: 'file', snapshot: priorState });
      log(`PC file bridge: edited ${target} (${occurrences} replacement${occurrences === 1 ? '' : 's'})`);
      res.json({ path: relPath, replacements: replaceAll ? occurrences : 1, size: byteLength, checkpointId });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // POST /pc-fs/delete  { path }
  // Deletes a file, or a folder and everything in it. No trash/undo -
  // the model should only call this when it (or the person) is
  // confident about the path, same trust level as terminal_pc_run_command
  // running `rm`/`del` directly.
  app.post('/pc-fs/delete', (req, res) => {
    const relPath = req.body?.path;
    if (!relPath) return res.status(400).json({ error: { message: 'path is required.' } });
    const target = resolveInsideRoot(root, relPath);
    if (!target) return res.status(400).json({ error: { message: 'Path is outside the allowed PC_BRIDGE_ROOT.' } });
    if (target === path.resolve(root)) return res.status(400).json({ error: { message: 'Refusing to delete PC_BRIDGE_ROOT itself.' } });
    if (!fs.existsSync(target)) return res.status(404).json({ error: { message: `${relPath} does not exist.` } });

    try {
      const stat = fs.statSync(target);
      let checkpointId;
      if (stat.isDirectory()) {
        const { files, truncated } = captureFolderState(target, root);
        checkpointId = recordCheckpoint(root, { operation: 'delete', path: relPath, type: 'folder', snapshot: { files, truncated } });
      } else {
        const priorState = captureFileState(target);
        checkpointId = recordCheckpoint(root, { operation: 'delete', path: relPath, type: 'file', snapshot: priorState });
      }
      fs.rmSync(target, { recursive: stat.isDirectory(), force: true });
      log(`PC file bridge: deleted ${target}`);
      res.json({ path: relPath, wasDirectory: stat.isDirectory(), checkpointId });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // POST /pc-fs/rename  { path, newName }
  // Renames a file or folder within its current parent directory.
  app.post('/pc-fs/rename', (req, res) => {
    const { path: relPath, newName } = req.body || {};
    if (!relPath) return res.status(400).json({ error: { message: 'path is required.' } });
    if (!newName || /[/\\]/.test(newName)) return res.status(400).json({ error: { message: 'newName is required and must be a plain name, not a path.' } });

    const target = resolveInsideRoot(root, relPath);
    if (!target) return res.status(400).json({ error: { message: 'Path is outside the allowed PC_BRIDGE_ROOT.' } });
    if (!fs.existsSync(target)) return res.status(404).json({ error: { message: `${relPath} does not exist.` } });

    const newRelPath = path.join(path.dirname(relPath), newName).split(path.sep).join('/');
    const newTarget = resolveInsideRoot(root, newRelPath);
    if (!newTarget) return res.status(400).json({ error: { message: 'Resulting path is outside the allowed PC_BRIDGE_ROOT.' } });
    if (fs.existsSync(newTarget)) return res.status(409).json({ error: { message: `${newRelPath} already exists.` } });

    try {
      const stat = fs.statSync(target);
      const snapshot = stat.isDirectory() ? captureFolderState(target, root) : captureFileState(target);
      const checkpointId = recordCheckpoint(root, {
        operation: 'rename', path: relPath, newPath: newRelPath, type: stat.isDirectory() ? 'folder' : 'file', snapshot,
      });
      fs.renameSync(target, newTarget);
      log(`PC file bridge: renamed ${target} -> ${newTarget}`);
      res.json({ path: relPath, newPath: newRelPath, checkpointId });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // POST /pc-fs/move  { sourcePath, destinationFolderPath, keepOriginal }
  // Moves a file or folder into a different destination folder,
  // optionally leaving a copy behind at the source (keepOriginal - same
  // idea as filesystemTool.js's moveEntry on the phone).
  app.post('/pc-fs/move', (req, res) => {
    const { sourcePath, destinationFolderPath, keepOriginal } = req.body || {};
    if (!sourcePath) return res.status(400).json({ error: { message: 'sourcePath is required.' } });
    if (!destinationFolderPath && destinationFolderPath !== '') return res.status(400).json({ error: { message: 'destinationFolderPath is required (use "" for the project root).' } });

    const source = resolveInsideRoot(root, sourcePath);
    if (!source) return res.status(400).json({ error: { message: 'sourcePath is outside the allowed PC_BRIDGE_ROOT.' } });
    if (!fs.existsSync(source)) return res.status(404).json({ error: { message: `${sourcePath} does not exist.` } });

    const destFolder = resolveInsideRoot(root, destinationFolderPath);
    if (!destFolder) return res.status(400).json({ error: { message: 'destinationFolderPath is outside the allowed PC_BRIDGE_ROOT.' } });

    const fileName = path.basename(source);
    const newRelPath = path.join(destinationFolderPath, fileName).split(path.sep).join('/');
    const newTarget = resolveInsideRoot(root, newRelPath);
    if (!newTarget) return res.status(400).json({ error: { message: 'Resulting path is outside the allowed PC_BRIDGE_ROOT.' } });
    if (fs.existsSync(newTarget)) return res.status(409).json({ error: { message: `${newRelPath} already exists.` } });

    try {
      const stat = fs.statSync(source);
      const isDir = stat.isDirectory();
      const snapshot = isDir ? captureFolderState(source, root) : captureFileState(source);
      const checkpointId = recordCheckpoint(root, {
        operation: 'move', path: sourcePath, newPath: newRelPath, type: isDir ? 'folder' : 'file', snapshot,
      });

      fs.mkdirSync(destFolder, { recursive: true });
      if (keepOriginal) {
        fs.cpSync(source, newTarget, { recursive: isDir });
      } else {
        fs.renameSync(source, newTarget);
      }
      log(`PC file bridge: moved ${source} -> ${newTarget}${keepOriginal ? ' (kept original)' : ''}`);
      res.json({ sourcePath, newPath: newRelPath, keptOriginal: !!keepOriginal, checkpointId });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // GET /pc-fs/grep?query=...&path=...&caseSensitive=...&maxResults=...
  // Literal substring search across text files under path (default: the
  // whole project root) - finds where something is defined/used before
  // deciding what to pc_fs_edit_file. Skips node_modules/.git/build/etc
  // (WALK_SKIP_DIRS) and anything that looks binary.
  app.get('/pc-fs/grep', (req, res) => {
    const { query } = req.query || {};
    if (!query) return res.status(400).json({ error: { message: 'query is required.' } });
    const startPath = req.query?.path || '';
    const startTarget = resolveInsideRoot(root, startPath);
    if (!startTarget) return res.status(400).json({ error: { message: 'Path is outside the allowed PC_BRIDGE_ROOT.' } });
    if (!fs.existsSync(startTarget)) return res.status(404).json({ error: { message: `${startPath} does not exist.` } });

    const caseSensitive = req.query?.caseSensitive === 'true';
    const maxResults = Math.min(parseInt(req.query?.maxResults, 10) || 50, 200);
    const needle = caseSensitive ? query : query.toLowerCase();

    const matches = [];
    function walk(dir) {
      if (matches.length >= maxResults) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (matches.length >= maxResults) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (WALK_SKIP_DIRS.has(e.name)) continue;
          walk(full);
        } else {
          if (e.name.match(/\.(png|jpe?g|gif|webp|ico|zip|apk|woff2?|ttf|eot|mp4|mp3|pdf)$/i)) continue;
          let text;
          try {
            text = fs.readFileSync(full, 'utf8');
          } catch {
            continue; // unreadable/binary
          }
          const lines = text.split('\n');
          for (let i = 0; i < lines.length && matches.length < maxResults; i += 1) {
            const haystack = caseSensitive ? lines[i] : lines[i].toLowerCase();
            if (haystack.includes(needle)) {
              matches.push({ path: path.relative(root, full).split(path.sep).join('/'), lineNumber: i + 1, line: lines[i].trim().slice(0, 300) });
            }
          }
        }
      }
    }
    try {
      walk(startTarget);
      log(`PC file bridge: grep "${query}" under ${startTarget} - ${matches.length} match(es)`);
      res.json({ query, matches, truncated: matches.length >= maxResults });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // GET /pc-fs/glob?pattern=...&path=...
  // Finds files by name pattern (e.g. "**/*.test.js") under path
  // (default: the whole project root). See globToRegExp() above for
  // what's supported - *, **, ? only, no brace expansion.
  app.get('/pc-fs/glob', (req, res) => {
    const { pattern } = req.query || {};
    if (!pattern) return res.status(400).json({ error: { message: 'pattern is required.' } });
    const startPath = req.query?.path || '';
    const startTarget = resolveInsideRoot(root, startPath);
    if (!startTarget) return res.status(400).json({ error: { message: 'Path is outside the allowed PC_BRIDGE_ROOT.' } });
    if (!fs.existsSync(startTarget)) return res.status(404).json({ error: { message: `${startPath} does not exist.` } });

    const maxResults = 200;
    const regex = globToRegExp(pattern);
    const matches = [];
    function walk(dir) {
      if (matches.length >= maxResults) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const e of entries) {
        if (matches.length >= maxResults) return;
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          if (WALK_SKIP_DIRS.has(e.name)) continue;
          walk(full);
        } else {
          const relFromStart = path.relative(startTarget, full).split(path.sep).join('/');
          if (regex.test(relFromStart) || regex.test(e.name)) {
            matches.push(path.relative(root, full).split(path.sep).join('/'));
          }
        }
      }
    }
    try {
      walk(startTarget);
      log(`PC file bridge: glob "${pattern}" under ${startTarget} - ${matches.length} match(es)`);
      res.json({ pattern, matches, truncated: matches.length >= maxResults });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // GET /pc-fs/checkpoints?limit=20
  // Lists recent checkpoints (newest first) recorded by the write/edit/
  // delete/rename/move routes above.
  app.get('/pc-fs/checkpoints', (req, res) => {
    const limit = Math.min(parseInt(req.query?.limit, 10) || 20, MAX_CHECKPOINTS);
    try {
      const index = readCheckpointsIndex(root);
      const recent = index.slice(-limit).reverse();
      res.json({ checkpoints: recent });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });

  // POST /pc-fs/checkpoints/rewind  { checkpointId }
  // Restores whatever that checkpoint captured - the file's/folder's
  // exact prior content, or removes what a create/write introduced if
  // it didn't exist before. For rename/move, also removes whatever
  // currently sits at the new path. No redo - this is a one-way "put it
  // back", same as fs_rewind_folder_checkpoint on the phone.
  app.post('/pc-fs/checkpoints/rewind', (req, res) => {
    const checkpointId = req.body?.checkpointId;
    if (!checkpointId) return res.status(400).json({ error: { message: 'checkpointId is required.' } });

    try {
      const index = readCheckpointsIndex(root);
      const entry = index.find((c) => c.id === checkpointId);
      if (!entry) return res.status(404).json({ error: { message: `No checkpoint found with id ${checkpointId}.` } });

      const snapshot = readSnapshot(root, checkpointId);
      if (!snapshot) return res.status(404).json({ error: { message: `Checkpoint ${checkpointId}'s snapshot data is missing.` } });

      restoreSnapshot(root, entry, snapshot);
      log(`PC file bridge: rewound checkpoint ${checkpointId} (${entry.operation} ${entry.path})`);
      res.json({ checkpointId, path: entry.path, operation: entry.operation });
    } catch (err) {
      res.status(500).json({ error: { message: err.message } });
    }
  });
}

module.exports = { registerPcFilesRoute, resolveInsideRoot };
