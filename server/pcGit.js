/**
 * ZAO Backend - PC git route
 *
 * A dedicated, structured wrapper around git, instead of the model
 * building git shell strings for terminal_pc_run_command. Two real
 * reasons this exists rather than just "use the terminal":
 *
 *  1. NO SHELL QUOTING AT ALL - every git subcommand here runs through
 *     child_process.execFile('git', [...argsArray], { cwd }), never a
 *     shell string. Commit messages, branch names, anything with
 *     quotes/spaces/special characters just goes in as one array
 *     element - there's no cmd.exe/PowerShell/bash quoting dialect to
 *     get wrong. (This exact class of bug - a mobile keyboard's smart
 *     quotes mangling a shell command - bit an earlier ZAO project hard
 *     enough to be worth solving permanently for git specifically,
 *     rather than "be more careful with terminal_pc_run_command" every
 *     time.)
 *  2. STRUCTURED OUTPUT - /pc-git/status and /pc-git/log return parsed
 *     JSON (files changed, current branch, ahead/behind, commit list),
 *     not raw porcelain text the model has to re-parse itself every call.
 *
 * All operations are confined to PC_BRIDGE_ROOT via pcFiles.js's
 * resolveInsideRoot, same as every other PC route - `path` here is a
 * project folder relative to that root, not an arbitrary filesystem path.
 */

const { execFile } = require('child_process');
const fs = require('fs');
const { resolveInsideRoot } = require('./pcFiles');

const GIT_TIMEOUT_MS = 30000;

function runGit(args, cwd) {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, timeout: GIT_TIMEOUT_MS, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({
        exitCode: err ? (err.code ?? 1) : 0,
        stdout: stdout || '',
        stderr: stderr || (err && !stdout ? err.message : ''),
        timedOut: !!err?.killed,
      });
    });
  });
}

/** Parses `git status --porcelain=v1 -b` output into a structured shape. */
function parseStatus(stdout) {
  const lines = stdout.split('\n').filter(Boolean);
  const branchLine = lines.find((l) => l.startsWith('##')) || '';
  const files = lines.filter((l) => !l.startsWith('##')).map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));

  // "## main...origin/main [ahead 1, behind 2]" / "## main" (no upstream)
  // / "## No commits yet on main" (brand new repo, nothing committed yet)
  const noCommitsMatch = branchLine.match(/^## No commits yet on (\S+)/);
  const branchMatch = noCommitsMatch ? null : branchLine.match(/^## ([^.\s]+)(?:\.\.\.(\S+))?/);
  const aheadMatch = branchLine.match(/ahead (\d+)/);
  const behindMatch = branchLine.match(/behind (\d+)/);

  return {
    branch: noCommitsMatch?.[1] || branchMatch?.[1] || null,
    upstream: branchMatch?.[2] || null,
    ahead: aheadMatch ? parseInt(aheadMatch[1], 10) : 0,
    behind: behindMatch ? parseInt(behindMatch[1], 10) : 0,
    files,
    clean: files.length === 0,
  };
}

function registerPcGitRoute(app, config, log) {
  const root = config.PC_BRIDGE_ROOT;

  function resolveRepoPath(relPath, res) {
    const target = resolveInsideRoot(root, relPath || '');
    if (!target) {
      res.status(400).json({ error: { message: 'path is outside the allowed PC_BRIDGE_ROOT.' } });
      return null;
    }
    return target;
  }

  // POST /pc-git/init  { path }
  app.post('/pc-git/init', async (req, res) => {
    const cwd = resolveRepoPath(req.body?.path, res);
    if (!cwd) return;
    fs.mkdirSync(cwd, { recursive: true }); // spawn's cwd must already exist - git init is what's supposed to create the repo, not the folder
    const result = await runGit(['init'], cwd);
    log(`PC git: init ${cwd} (exit ${result.exitCode})`);
    res.json(result);
  });

  // GET /pc-git/status?path=...
  app.get('/pc-git/status', async (req, res) => {
    const cwd = resolveRepoPath(req.query?.path, res);
    if (!cwd) return;
    const result = await runGit(['status', '--porcelain=v1', '-b'], cwd);
    if (result.exitCode !== 0) return res.json(result);
    res.json({ ...result, parsed: parseStatus(result.stdout) });
  });

  // POST /pc-git/add  { path, files?: string[], all?: boolean }
  app.post('/pc-git/add', async (req, res) => {
    const cwd = resolveRepoPath(req.body?.path, res);
    if (!cwd) return;
    const { files, all } = req.body || {};
    const args = ['add', ...(all || !files?.length ? ['-A'] : files)];
    const result = await runGit(args, cwd);
    log(`PC git: add ${cwd} (${all || !files?.length ? 'all' : files.length + ' file(s)'}, exit ${result.exitCode})`);
    res.json(result);
  });

  // POST /pc-git/commit  { path, message, authorName?, authorEmail? }
  app.post('/pc-git/commit', async (req, res) => {
    const cwd = resolveRepoPath(req.body?.path, res);
    if (!cwd) return;
    const { message, authorName, authorEmail } = req.body || {};
    if (!message) return res.status(400).json({ error: { message: 'message is required.' } });

    const args = ['commit', '-m', message];
    if (authorName && authorEmail) args.push('--author', `${authorName} <${authorEmail}>`);
    const result = await runGit(args, cwd);
    log(`PC git: commit ${cwd} (exit ${result.exitCode})`);
    res.json(result);
  });

  // POST /pc-git/push  { path, remote?, branch?, setUpstream?, force? }
  app.post('/pc-git/push', async (req, res) => {
    const cwd = resolveRepoPath(req.body?.path, res);
    if (!cwd) return;
    const { remote = 'origin', branch, setUpstream, force } = req.body || {};
    const args = ['push'];
    if (setUpstream) args.push('-u');
    if (force) args.push('--force-with-lease');
    args.push(remote);
    if (branch) args.push(branch);
    const result = await runGit(args, cwd);
    log(`PC git: push ${cwd} -> ${remote}${branch ? `/${branch}` : ''} (exit ${result.exitCode})`);
    res.json(result);
  });

  // POST /pc-git/pull  { path, remote?, branch? }
  app.post('/pc-git/pull', async (req, res) => {
    const cwd = resolveRepoPath(req.body?.path, res);
    if (!cwd) return;
    const { remote = 'origin', branch } = req.body || {};
    const args = ['pull', remote];
    if (branch) args.push(branch);
    const result = await runGit(args, cwd);
    log(`PC git: pull ${cwd} from ${remote}${branch ? `/${branch}` : ''} (exit ${result.exitCode})`);
    res.json(result);
  });

  // POST /pc-git/checkout  { path, branch, create? }
  app.post('/pc-git/checkout', async (req, res) => {
    const cwd = resolveRepoPath(req.body?.path, res);
    if (!cwd) return;
    const { branch, create } = req.body || {};
    if (!branch) return res.status(400).json({ error: { message: 'branch is required.' } });
    const args = create ? ['checkout', '-b', branch] : ['checkout', branch];
    const result = await runGit(args, cwd);
    log(`PC git: checkout ${cwd} -> ${branch}${create ? ' (new)' : ''} (exit ${result.exitCode})`);
    res.json(result);
  });

  // POST /pc-git/remote-add  { path, name, url }
  // Adds a new remote, or updates the URL if one with that name already exists.
  app.post('/pc-git/remote-add', async (req, res) => {
    const cwd = resolveRepoPath(req.body?.path, res);
    if (!cwd) return;
    const { name, url } = req.body || {};
    if (!name || !url) return res.status(400).json({ error: { message: 'name and url are required.' } });

    let result = await runGit(['remote', 'add', name, url], cwd);
    if (result.exitCode !== 0 && /already exists/i.test(result.stderr)) {
      result = await runGit(['remote', 'set-url', name, url], cwd);
    }
    log(`PC git: remote-add ${cwd} ${name} -> ${url} (exit ${result.exitCode})`);
    res.json(result);
  });

  // GET /pc-git/log?path=...&limit=20
  app.get('/pc-git/log', async (req, res) => {
    const cwd = resolveRepoPath(req.query?.path, res);
    if (!cwd) return;
    const limit = Math.min(parseInt(req.query?.limit, 10) || 20, 200);
    // Unit-separator-delimited so a commit message containing a comma or
    // pipe can't break parsing.
    const result = await runGit(['log', `-n${limit}`, '--pretty=format:%H%x1f%h%x1f%an%x1f%ad%x1f%s', '--date=iso'], cwd);
    if (result.exitCode !== 0) return res.json(result);
    const commits = result.stdout.split('\n').filter(Boolean).map((line) => {
      const [hash, shortHash, author, date, subject] = line.split('\x1f');
      return { hash, shortHash, author, date, subject };
    });
    res.json({ ...result, commits });
  });

  // GET /pc-git/diff?path=...&staged=true
  app.get('/pc-git/diff', async (req, res) => {
    const cwd = resolveRepoPath(req.query?.path, res);
    if (!cwd) return;
    const args = ['diff'];
    if (req.query?.staged === 'true') args.push('--staged');
    const result = await runGit(args, cwd);
    res.json(result);
  });
}

module.exports = { registerPcGitRoute };
