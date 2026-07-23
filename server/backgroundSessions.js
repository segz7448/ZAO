/**
 * ZAO Backend - Background Sessions
 *
 * WHAT THIS FIXES: every existing tool loop (toolOrchestrator.js's
 * runToolTask, backendBrain.js's hierarchical planner) runs IN THE PHONE
 * APP - the model call goes phone -> PC backend -> llama-server and back,
 * but the loop itself (which tool to call next, when to stop) is JS
 * running on the device. Close the app - or lock the phone, or lose
 * signal for a few minutes - and the loop dies with it, mid-task, even
 * though the actual work (a build, a multi-file refactor, a research
 * pass) was happening on the PC the whole time anyway.
 *
 * This module runs that same kind of loop ON THE PC ITSELF instead: the
 * phone starts a session with one prompt, the loop runs to completion
 * inside this Node process (independent of any phone connection), and the
 * phone comes back later - a minute or a day - and asks for the result.
 * The PC backend was always the thing doing the real work; this just
 * stops requiring the phone to stay open as the thing DRIVING it.
 *
 * TOOL SET: deliberately a subset of toolOrchestrator.js's full
 * TOOL_REGISTRY - only tools that make sense with no phone present at
 * all: PC filesystem (pc_fs_*), PC git, PC terminal, PC background
 * processes, web search, and web fetch. GitHub-via-API, the phone's own
 * SAF filesystem (fs_*), and phone-native actions (clipboard/share sheet)
 * are excluded - they either need a phone-side token/UI or a phone that's
 * physically present, neither of which a background session can assume.
 * This mirrors reality anyway: real coding/build/research work already
 * happens PC-side in ZAO's architecture (see toolOrchestrator.js's own
 * system prompt), so this covers the tasks actually worth backgrounding.
 *
 * REUSE, NOT REIMPLEMENTATION: PC filesystem/git/terminal calls loop back
 * over plain HTTP to this SAME server's own already-registered routes
 * (127.0.0.1:PORT, with the real AUTH_TOKEN) rather than duplicating
 * pcFiles.js/pcGit.js/terminal.js's logic - every checkpoint, syntax
 * check, and sandbox rule those routes already enforce for the phone
 * app's calls applies identically here. Process management and web
 * search/fetch call their modules' exported functions directly (no HTTP
 * hop needed - they already export plain reusable functions).
 *
 * PERSISTENCE: session state (status, log, final answer/error) is
 * written to a JSON file per session under server/data/sessions/ after
 * every step, so a session already in flight is still inspectable after
 * a server restart even though the LOOP itself can't resume mid-flight
 * across a real process restart (the loop is a live async function, not
 * a serialized state machine - the PC backend is expected to keep
 * running, same assumption every other long-lived feature here already
 * makes, e.g. processManager.js's tracked background processes not
 * surviving a restart either).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { runSearch } = require('./webSearch');
const { runFetch } = require('./webFetch');
const processManager = require('./processManager');

const SESSIONS_DIR = path.join(__dirname, 'data', 'sessions');
const MAX_SESSION_STEPS = 40;
const MAX_LOG_ENTRIES = 500; // ring-bounded per session, same reasoning as processManager.js's MAX_LOG_LINES

/** @type {Map<string, SessionRecord>} */
const sessions = new Map();
/** @type {Map<string, {cancelled: boolean}>} */
const cancelFlags = new Map();

/**
 * @typedef {Object} SessionRecord
 * @property {string} id
 * @property {string} prompt
 * @property {'running'|'completed'|'failed'|'stopped'} status
 * @property {number} createdAt
 * @property {number} updatedAt
 * @property {Array<{ts: number, text: string}>} log
 * @property {string|null} answer
 * @property {object|null} error
 * @property {number} stepCount
 */

function ensureSessionsDir() {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function sessionFilePath(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function persistSession(record) {
  try {
    ensureSessionsDir();
    fs.writeFileSync(sessionFilePath(record.id), JSON.stringify(record, null, 2));
  } catch {
    // Persistence is best-effort - an in-memory session still works fine
    // for the rest of this process's lifetime even if the write fails
    // (e.g. disk full); it just won't survive a restart.
  }
}

function loadPersistedSessions() {
  try {
    ensureSessionsDir();
    for (const file of fs.readdirSync(SESSIONS_DIR)) {
      if (!file.endsWith('.json')) continue;
      try {
        const record = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, file), 'utf-8'));
        // A session that was still "running" when the server last shut
        // down had its actual loop die with the process - reopening it
        // as running would be a lie the phone could poll forever. Mark
        // it interrupted-as-failed instead, with a clear reason, rather
        // than silently dropping its history.
        if (record.status === 'running') {
          record.status = 'failed';
          record.error = { message: 'The PC backend restarted while this session was still running.' };
          record.updatedAt = Date.now();
        }
        sessions.set(record.id, record);
      } catch {
        // Skip a corrupt/partial file rather than failing startup over it.
      }
    }
  } catch {
    // No sessions directory yet - nothing to load.
  }
}

function appendLog(record, text) {
  record.log.push({ ts: Date.now(), text });
  if (record.log.length > MAX_LOG_ENTRIES) record.log.splice(0, record.log.length - MAX_LOG_ENTRIES);
  record.updatedAt = Date.now();
}

function summarize(record) {
  const { id, prompt, status, createdAt, updatedAt, stepCount } = record;
  const lastLog = record.log[record.log.length - 1] || null;
  return { id, prompt, status, createdAt, updatedAt, stepCount, lastStep: lastLog?.text || null };
}

// ---------------------------------------------------------------------------
// Tool schemas + internal dispatch - a deliberately smaller set than
// toolOrchestrator.js's full TOOL_REGISTRY (see file header). `internalFetch`
// hits this same server's own routes over loopback with the real auth
// token, so pcFiles.js/pcGit.js/terminal.js's existing logic - checkpoints,
// syntax gating, sandboxing - runs exactly as it would for the phone app.
// ---------------------------------------------------------------------------

function internalBaseUrl(config) {
  return `http://127.0.0.1:${config.PORT}`;
}

async function internalFetch(config, method, routePath, body) {
  const url = `${internalBaseUrl(config)}${routePath}`;
  const response = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.AUTH_TOKEN}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return { success: false, data: null, error: data?.error || { message: `Request failed (${response.status}).` } };
  }
  return { success: true, data, error: null };
}

const BG_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'terminal_run',
      description: 'Runs a shell command on the PC (same auto-detected cmd/PowerShell/Git Bash/Python shell selection as the interactive terminal tool). Blocks until the command exits.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          shell: { type: 'string', enum: ['cmd', 'powershell', 'gitbash', 'python'] },
          hostAccess: { type: 'boolean', description: 'Set true only for something that needs the real PC beyond the project folder (Android SDK, emulator, Docker itself).' },
        },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_fs_scaffold_project',
      description: 'Creates a new project folder on the PC and writes every given file into it in one call.',
      parameters: {
        type: 'object',
        properties: {
          folderPath: { type: 'string' },
          files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
        },
        required: ['folderPath', 'files'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_fs_write_file',
      description: 'Creates or overwrites one text file on the PC.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_fs_edit_file',
      description: 'Replaces an exact, unique snippet of an existing text file on the PC with new text.',
      parameters: { type: 'object', properties: { path: { type: 'string' }, oldString: { type: 'string' }, newString: { type: 'string' }, replaceAll: { type: 'boolean' } }, required: ['path', 'oldString', 'newString'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_fs_read_file',
      description: "Reads an existing text file's content on the PC.",
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_fs_list',
      description: 'Lists a folder on the PC.',
      parameters: { type: 'object', properties: { path: { type: 'string' } } },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_fs_delete',
      description: 'Deletes a file or folder on the PC (checkpointed automatically).',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_fs_grep',
      description: 'Searches file contents for a literal string under a PC folder.',
      parameters: { type: 'object', properties: { query: { type: 'string' }, path: { type: 'string' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_git',
      description: 'Runs one git operation against a repo on the PC.',
      parameters: {
        type: 'object',
        properties: {
          op: { type: 'string', enum: ['init', 'status', 'add', 'commit', 'push', 'pull', 'checkout', 'remote_add', 'log', 'diff'] },
          path: { type: 'string' },
          message: { type: 'string', description: 'For commit' },
          files: { type: 'array', items: { type: 'string' }, description: 'For add' },
          all: { type: 'boolean', description: 'For add' },
          branch: { type: 'string', description: 'For push/pull/checkout' },
          create: { type: 'boolean', description: 'For checkout' },
          remote: { type: 'string', description: 'For push/pull' },
          name: { type: 'string', description: 'For remote_add' },
          url: { type: 'string', description: 'For remote_add' },
        },
        required: ['op', 'path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_process_start',
      description: 'Starts a long-running background process on the PC (a dev server, a watcher, a long build) and returns an id immediately.',
      parameters: { type: 'object', properties: { command: { type: 'string' }, label: { type: 'string' }, cwd: { type: 'string' } }, required: ['command'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_process_status',
      description: 'Checks a background process by id.',
      parameters: { type: 'object', properties: { processId: { type: 'string' } }, required: ['processId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_process_logs',
      description: 'Tails a background process\'s stdout/stderr by id.',
      parameters: { type: 'object', properties: { processId: { type: 'string' }, tail: { type: 'number' } }, required: ['processId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'pc_process_stop',
      description: 'Stops a background process by id.',
      parameters: { type: 'object', properties: { processId: { type: 'string' } }, required: ['processId'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Searches the live web and returns matching pages (title, URL, snippet).',
      parameters: { type: 'object', properties: { query: { type: 'string' }, maxResults: { type: 'integer' } }, required: ['query'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetches a specific URL and returns its readable text content.',
      parameters: { type: 'object', properties: { url: { type: 'string' } }, required: ['url'] },
    },
  },
];

async function dispatchTool(config, name, args) {
  switch (name) {
    case 'terminal_run':
      return internalFetch(config, 'POST', '/terminal/run', { command: args.command, shell: args.shell, hostAccess: !!args.hostAccess });
    case 'pc_fs_scaffold_project': {
      // pcFiles.js has no single scaffold route - write the folder's
      // files one at a time via the existing /pc-fs/write route instead
      // of adding a new server route just for this.
      const results = [];
      for (const file of args.files || []) {
        const r = await internalFetch(config, 'POST', '/pc-fs/write', { path: `${args.folderPath}/${file.path}`, content: file.content, overwrite: true });
        results.push({ path: file.path, success: r.success });
      }
      return { success: results.every((r) => r.success), data: { folderPath: args.folderPath, files: results }, error: results.some((r) => !r.success) ? { message: 'One or more files failed to write.' } : null };
    }
    case 'pc_fs_write_file':
      return internalFetch(config, 'POST', '/pc-fs/write', { path: args.path, content: args.content, overwrite: true });
    case 'pc_fs_edit_file':
      return internalFetch(config, 'POST', '/pc-fs/edit', { path: args.path, oldString: args.oldString, newString: args.newString, replaceAll: !!args.replaceAll });
    case 'pc_fs_read_file':
      return internalFetch(config, 'GET', `/pc-fs/read?path=${encodeURIComponent(args.path)}`);
    case 'pc_fs_list':
      return internalFetch(config, 'GET', `/pc-fs/list?path=${encodeURIComponent(args.path || '')}`);
    case 'pc_fs_delete':
      return internalFetch(config, 'POST', '/pc-fs/delete', { path: args.path });
    case 'pc_fs_grep':
      return internalFetch(config, 'GET', `/pc-fs/grep?query=${encodeURIComponent(args.query)}&path=${encodeURIComponent(args.path || '')}`);
    case 'pc_git': {
      const routeMap = {
        init: ['POST', '/pc-git/init', { path: args.path }],
        status: ['GET', `/pc-git/status?path=${encodeURIComponent(args.path)}`],
        add: ['POST', '/pc-git/add', { path: args.path, files: args.files, all: args.all }],
        commit: ['POST', '/pc-git/commit', { path: args.path, message: args.message }],
        push: ['POST', '/pc-git/push', { path: args.path, remote: args.remote, branch: args.branch }],
        pull: ['POST', '/pc-git/pull', { path: args.path, remote: args.remote, branch: args.branch }],
        checkout: ['POST', '/pc-git/checkout', { path: args.path, branch: args.branch, create: args.create }],
        remote_add: ['POST', '/pc-git/remote-add', { path: args.path, name: args.name, url: args.url }],
        log: ['GET', `/pc-git/log?path=${encodeURIComponent(args.path)}`],
        diff: ['GET', `/pc-git/diff?path=${encodeURIComponent(args.path)}`],
      };
      const entry = routeMap[args.op];
      if (!entry) return { success: false, data: null, error: { message: `Unknown git op: ${args.op}` } };
      return internalFetch(config, ...entry);
    }
    case 'pc_process_start': {
      const result = processManager.startProcess({ command: args.command, cwd: args.cwd || null, shell: null, config, log: () => {} });
      if (result.error) return { success: false, data: null, error: { message: result.error } };
      return { success: true, data: { processId: result.id, shellUsed: result.shellUsed }, error: null };
    }
    case 'pc_process_status': {
      const status = processManager.getStatus(args.processId);
      return status ? { success: true, data: status, error: null } : { success: false, data: null, error: { message: 'Unknown process id.' } };
    }
    case 'pc_process_logs': {
      const logs = processManager.getLogs(args.processId, { tail: args.tail });
      return logs ? { success: true, data: logs, error: null } : { success: false, data: null, error: { message: 'Unknown process id.' } };
    }
    case 'pc_process_stop': {
      const result = processManager.stopProcess(args.processId);
      if (result.error) return { success: false, data: null, error: { message: result.error } };
      return { success: true, data: result, error: null };
    }
    case 'web_search': {
      try {
        const { results } = await runSearch(args.query, Math.min(args.maxResults || 5, 10));
        return { success: true, data: { query: args.query, results }, error: null };
      } catch (err) {
        return { success: false, data: null, error: { message: err.message } };
      }
    }
    case 'web_fetch': {
      try {
        const result = await runFetch(args.url);
        return { success: true, data: result, error: null };
      } catch (err) {
        return { success: false, data: null, error: { message: err.message } };
      }
    }
    default:
      return { success: false, data: null, error: { message: `Unknown tool: ${name}` } };
  }
}

function toolLabel(name, args) {
  switch (name) {
    case 'terminal_run': return `Ran: ${args.command}`;
    case 'pc_fs_scaffold_project': return `Created project ${args.folderPath} (${(args.files || []).length} files)`;
    case 'pc_fs_write_file': return `Wrote ${args.path}`;
    case 'pc_fs_edit_file': return `Edited ${args.path}`;
    case 'pc_fs_read_file': return `Read ${args.path}`;
    case 'pc_fs_list': return `Listed ${args.path || '(root)'}`;
    case 'pc_fs_delete': return `Deleted ${args.path}`;
    case 'pc_fs_grep': return `Searched for "${args.query}"`;
    case 'pc_git': return `git ${args.op} (${args.path})`;
    case 'pc_process_start': return `Started background process: ${args.command}`;
    case 'pc_process_status': return `Checked process ${args.processId}`;
    case 'pc_process_logs': return `Read logs for ${args.processId}`;
    case 'pc_process_stop': return `Stopped process ${args.processId}`;
    case 'web_search': return `Searched the web: "${args.query}"`;
    case 'web_fetch': return `Fetched ${args.url}`;
    default: return name;
  }
}

/**
 * The loop itself - same ReAct shape as toolOrchestrator.js's
 * runToolTask, just running here instead of in the phone app, with the
 * smaller BG_TOOL_SCHEMAS tool set, and reporting progress into the
 * session's persisted log instead of an onStep callback to a live chat
 * screen.
 */
async function runSessionLoop(config, sendToolCall, record) {
  const systemPrompt = `You are ZAO working on a long-running background task with no person watching in real time - they started this and will check back later, possibly much later. Work the task through to a real, finished conclusion using the available tools (PC terminal, PC filesystem, PC git, PC background processes, web search, web fetch) rather than stopping partway to ask a question you have no way to get answered right now - make the most reasonable assumption, note it in your final answer, and keep going. When genuinely finished (or genuinely blocked in a way no assumption can resolve), give a clear, complete final answer summarizing exactly what was done and where things ended up.`;

  const history = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: record.prompt },
  ];

  for (let i = 0; i < MAX_SESSION_STEPS; i++) {
    if (cancelFlags.get(record.id)?.cancelled) {
      record.status = 'stopped';
      appendLog(record, 'Session stopped by request.');
      persistSession(record);
      return;
    }

    const modelResult = await sendToolCall(history, BG_TOOL_SCHEMAS);

    if (!modelResult.success) {
      record.status = 'failed';
      record.error = modelResult.error;
      appendLog(record, `Model error: ${modelResult.error?.message || 'unknown error'}`);
      persistSession(record);
      return;
    }

    const { content, toolCalls } = modelResult;

    if (!toolCalls || toolCalls.length === 0) {
      record.status = 'completed';
      record.answer = content;
      appendLog(record, 'Finished.');
      persistSession(record);
      return;
    }

    history.push({ role: 'assistant', content: content || null, tool_calls: toolCalls });

    for (const call of toolCalls) {
      const toolName = call.function.name;
      let args;
      try {
        args = JSON.parse(call.function.arguments || '{}');
      } catch {
        history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify({ success: false, error: 'Could not parse tool arguments as JSON.' }) });
        continue;
      }

      const result = await dispatchTool(config, toolName, args).catch((err) => ({ success: false, data: null, error: { message: err.message } }));
      history.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });

      record.stepCount += 1;
      appendLog(record, result.success ? toolLabel(toolName, args) : `Failed: ${toolLabel(toolName, args)} - ${result.error?.message || 'error'}`);
      persistSession(record);
    }
  }

  record.status = 'failed';
  record.error = { type: 'MAX_STEPS_EXCEEDED', message: `Stopped after ${MAX_SESSION_STEPS} tool calls without finishing.` };
  appendLog(record, 'Stopped: too many steps without finishing.');
  persistSession(record);
}

function registerSessionRoutes(app, config, log, sendToolCall) {
  loadPersistedSessions();

  // POST /sessions/start  body: { prompt: string }
  // Returns immediately with the new session's id and 'running' status -
  // the actual loop keeps going in this Node process after the response
  // is sent, independent of the phone connection that started it.
  app.post('/sessions/start', (req, res) => {
    const prompt = req.body?.prompt;
    if (!prompt || typeof prompt !== 'string' || !prompt.trim()) {
      return res.status(400).json({ error: { message: 'Missing "prompt" string in request body.' } });
    }

    const id = crypto.randomUUID();
    const record = {
      id,
      prompt: prompt.trim(),
      status: 'running',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      log: [],
      answer: null,
      error: null,
      stepCount: 0,
    };
    sessions.set(id, record);
    cancelFlags.set(id, { cancelled: false });
    persistSession(record);
    log(`Background session started: ${id} - "${record.prompt.slice(0, 80)}"`);

    // Fire-and-forget - deliberately not awaited, so this HTTP response
    // returns immediately and the loop runs independently.
    runSessionLoop(config, sendToolCall, record).catch((err) => {
      record.status = 'failed';
      record.error = { message: err.message || 'Session crashed unexpectedly.' };
      appendLog(record, `Crashed: ${err.message}`);
      persistSession(record);
    });

    return res.status(202).json({ success: true, session: summarize(record) });
  });

  // GET /sessions - list every known session, newest first
  app.get('/sessions', (req, res) => {
    const list = Array.from(sessions.values())
      .sort((a, b) => b.createdAt - a.createdAt)
      .map(summarize);
    res.json({ success: true, sessions: list });
  });

  // GET /sessions/:id - full detail including the step log and final answer
  app.get('/sessions/:id', (req, res) => {
    const record = sessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: { message: 'Unknown session id.' } });
    res.json({ success: true, session: record });
  });

  // POST /sessions/:id/stop - requests cancellation before the next tool step
  app.post('/sessions/:id/stop', (req, res) => {
    const record = sessions.get(req.params.id);
    if (!record) return res.status(404).json({ error: { message: 'Unknown session id.' } });
    if (record.status !== 'running') {
      return res.json({ success: true, session: summarize(record) });
    }
    const flag = cancelFlags.get(req.params.id) || { cancelled: false };
    flag.cancelled = true;
    cancelFlags.set(req.params.id, flag);
    log(`Background session stop requested: ${req.params.id}`);
    res.json({ success: true, session: summarize(record) });
  });
}

module.exports = { registerSessionRoutes };
