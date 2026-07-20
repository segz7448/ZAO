/**
 * ZAO - Backend Client
 *
 * The backend now runs on the person's PC (see /server in the repo root)
 * instead of on-device in Termux - the PC has real CPU headroom for
 * Qwen2.5-Coder-3B and also hosts the Terminal/Filesystem/Office tools
 * against the person's actual PC filesystem.
 *
 * CONNECTION: unlike the old fixed 127.0.0.1:8080 setup, there's no single
 * address that always works, so the person configures this in Settings >
 * Backend Connection:
 *   - LAN mode: PC's local IP:port (e.g. http://192.168.1.42:8080) - used
 *     at home on the same WiFi.
 *   - Remote mode: a Cloudflare Quick Tunnel URL - used away from home.
 *     This ROTATES every time start.bat is re-run on the PC, so it needs
 *     to be re-pasted into Settings each time before it'll work.
 * The mode is a manual toggle (see preferencesStore.js), not
 * auto-detected. Every request also carries an Authorization: Bearer
 * <token> header matching AUTH_TOKEN in the PC's server/config.js, since
 * the backend is now reachable over LAN and the public internet rather
 * than just loopback.
 *
 * CONTRACT: sendMessage() keeps the same shape used throughout the app -
 * { success, data: { content, toolCalls, raw }, error } - so
 * orchestrator.js, toolOrchestrator.js, and memoryEngine.js need no
 * changes beyond whatever already imports this file. (The browser agent
 * doesn't call through here - see server/browserAgent.js, which talks to
 * llama-server directly on the PC.)
 */

import { usePreferencesStore } from '../../store/preferencesStore';
import { streamSSE } from '../../utils/sseClient';

const HEALTH_TIMEOUT_MS = 4 * 1000;
const COMPLETION_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes - PC CPU inference is faster than phone, but still not instant, and LAN/tunnel hops add latency
const TERMINAL_TIMEOUT_MS = 2 * 60 * 1000;

const ERROR_TYPES = {
  BACKEND_UNREACHABLE: 'BACKEND_UNREACHABLE',
  MODEL_LOADING: 'MODEL_LOADING',
  BAD_REQUEST: 'BAD_REQUEST',
  INFERENCE_ERROR: 'INFERENCE_ERROR',
  NOT_CONFIGURED: 'NOT_CONFIGURED',
  UNKNOWN: 'UNKNOWN',
};

/**
 * Resolves the active backend base URL + auth token from preferences,
 * based on the LAN/Remote toggle. Returns null for baseUrl if the active
 * mode hasn't been configured yet, so callers can show a clear
 * "not configured" error instead of a confusing network failure.
 */
function getActiveConnection() {
  const prefs = usePreferencesStore.getState().preferences || {};
  const mode = prefs.backend_mode || 'lan';
  const baseUrl = mode === 'remote' ? prefs.backend_remote_url : prefs.backend_lan_url;
  return {
    mode,
    baseUrl: baseUrl ? baseUrl.replace(/\/+$/, '') : null,
    token: prefs.backend_auth_token || null,
  };
}

function authHeaders(token) {
  return token ? { Authorization: `Bearer ${token}` } : {};
}

function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Pings the PC backend's /health endpoint on whichever connection (LAN or
 * Remote) is currently active. Used at app launch/foreground, by Settings
 * to show a live connection indicator, and by terminalRouter.js to decide
 * PC vs Termux terminal routing - never throws.
 * @returns {Promise<{connected: boolean, ready: boolean, model: string|null, mode: string, internetAvailable: boolean|null}>}
 */
export async function checkBackendHealth() {
  const { mode, baseUrl } = getActiveConnection();
  if (!baseUrl) {
    return { connected: false, ready: false, model: null, mode, internetAvailable: null };
  }
  try {
    const response = await withTimeout(
      fetch(`${baseUrl}/health`),
      HEALTH_TIMEOUT_MS,
      'Health check timed out'
    );
    if (!response.ok) {
      return { connected: false, ready: false, model: null, mode, internetAvailable: null };
    }
    const json = await response.json();
    return {
      connected: true,
      ready: json.status === 'ready',
      model: json.model || null,
      mode,
      // Whether the PC itself currently has internet access (distinct from
      // "is the PC backend reachable", which connected:true already
      // covers) - see server/index.js's refreshInternetStatus(). null
      // means the PC backend hasn't completed its first check yet.
      internetAvailable: typeof json.internetAvailable === 'boolean' ? json.internetAvailable : null,
    };
  } catch (err) {
    return { connected: false, ready: false, model: null, mode, internetAvailable: null };
  }
}

/**
 * Converts ZAO's internal message shape ({role, content, images?}) plus
 * any already-OpenAI-shaped tool messages (role: 'tool', or an assistant
 * message carrying tool_calls - see toolOrchestrator.js) into plain
 * {role, content} messages. Image attachments are dropped here - the
 * single text-only model has no vision support, callers should already
 * short-circuit before reaching this (see orchestrator.js).
 */
function toBackendMessage(message) {
  if (message.role === 'tool' || message.tool_calls) {
    return message;
  }
  const role = message.role === 'system' ? 'system' : message.role === 'assistant' ? 'assistant' : 'user';
  return { role, content: message.content || '' };
}

/**
 * @param {Array} history - internal message format history
 * @param {string} [modelKey] - kept for call-site compatibility with the old
 *   multi-model signature; ignored, since there is only one model now.
 * @param {object} options - { maxTokens, temperature, tools, toolChoice, onToken }
 * @param {function} [options.onToken] - if provided (and no `tools` are requested -
 *   see note below), the request streams via SSE (server/index.js's proxyToLlama
 *   already pipes llama-server's response through as-is, so this only needed the
 *   client side wired up - see sseClient.js's header for why XHR, not fetch).
 *   Called with the full accumulated content string after every chunk, so callers
 *   can just do `setState(text)` rather than concatenating themselves. The
 *   returned promise still resolves once at the end with the exact same
 *   { success, data: { content, toolCalls, raw }, error } shape as the
 *   non-streaming path, so this is purely additive - existing callers that don't
 *   pass onToken are unaffected.
 *   NOT used when `tools` are passed: llama-server streams tool_calls as
 *   incremental argument-string fragments (index/id/name/arguments split across
 *   multiple deltas), a different accumulation problem than plain content text -
 *   tool-calling callers (toolOrchestrator.js etc.) need the complete, parsed
 *   tool_calls array anyway, not a token-by-token render, so they keep using the
 *   plain non-streaming request below.
 * @returns {Promise<{success, data: {content, toolCalls, raw}|null, error}>}
 */
export async function sendMessage(history, modelKey, options = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return { success: false, data: null, error: { type: ERROR_TYPES.BAD_REQUEST, message: 'Empty conversation history' } };
  }

  const { mode, baseUrl, token } = getActiveConnection();
  if (!baseUrl) {
    return {
      success: false,
      data: null,
      error: {
        type: ERROR_TYPES.NOT_CONFIGURED,
        message: `No ${mode === 'remote' ? 'Remote (Cloudflare tunnel)' : 'LAN'} backend URL is set. Add it in Settings > Backend Connection.`,
      },
    };
  }

  const messages = history.map(toBackendMessage);

  const body = {
    messages,
    max_tokens: options.maxTokens || 1024,
    temperature: options.temperature ?? 0.7,
  };

  if (options.tools?.length) {
    body.tools = options.tools;
    body.tool_choice = options.toolChoice || 'auto';
  }

  const canStream = typeof options.onToken === 'function' && !body.tools;

  if (canStream) {
    return sendMessageStreaming(baseUrl, token, body, options.onToken, mode);
  }

  try {
    const response = await withTimeout(
      fetch(`${baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify(body),
      }),
      COMPLETION_TIMEOUT_MS,
      `Backend took longer than ${COMPLETION_TIMEOUT_MS / 1000}s to respond. Check that start.bat is still running on your PC.`
    );

    if (response.status === 401) {
      return { success: false, data: null, error: { type: ERROR_TYPES.BAD_REQUEST, message: 'Backend rejected the auth token. Check it matches AUTH_TOKEN in the PC\'s server/config.js.' } };
    }

    if (response.status === 503) {
      return { success: false, data: null, error: { type: ERROR_TYPES.MODEL_LOADING, message: 'The model is still loading on the backend. Try again in a moment.' } };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: `Backend returned an error (${response.status}): ${text.slice(0, 200)}` } };
    }

    const result = await response.json();
    const choice = result?.choices?.[0];
    const toolCalls = choice?.message?.tool_calls?.length ? choice.message.tool_calls : null;
    const responseText = choice?.message?.content || null;

    if (!responseText && !toolCalls) {
      return { success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: 'No content from backend.', raw: result } };
    }

    return {
      success: true,
      data: { content: responseText, toolCalls, raw: result },
      error: null,
    };
  } catch (err) {
    console.error('[BackendClient] sendMessage failed:', err);
    const isNetworkError = err?.message?.includes('Network request failed') || err?.message?.includes('timed out');
    return {
      success: false,
      data: null,
      error: {
        type: isNetworkError ? ERROR_TYPES.BACKEND_UNREACHABLE : ERROR_TYPES.UNKNOWN,
        message: isNetworkError
          ? `Can't reach the ZAO backend (${mode === 'remote' ? 'Remote' : 'LAN'} mode). Make sure start.bat is running on your PC${mode === 'remote' ? ' and the tunnel URL in Settings is current (it changes on every restart)' : ''}.`
          : err?.message || 'Backend request failed.',
      },
    };
  }
}

/**
 * The streaming half of sendMessage() above - split out because it needs a
 * genuinely different transport (XHR via sseClient.js, not fetch) rather
 * than just a different response-parsing branch. See sendMessage()'s
 * onToken JSDoc for the contract; this resolves with the exact same
 * { success, data, error } shape once the stream completes.
 * @param {string} baseUrl
 * @param {string|null} token
 * @param {object} body - already built by sendMessage(), mutated here to set stream: true
 * @param {(text: string) => void} onToken
 * @param {string} mode - 'lan' | 'remote', for error messages only
 */
function sendMessageStreaming(baseUrl, token, body, onToken, mode) {
  return new Promise((resolve) => {
    let accumulated = '';
    let lastRaw = null;
    let sawAnyContent = false;

    const { abort } = streamSSE({
      url: `${baseUrl}/v1/chat/completions`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
      body: JSON.stringify({ ...body, stream: true }),
      timeoutMs: COMPLETION_TIMEOUT_MS,
      onEvent: (event) => {
        lastRaw = event;
        // llama-server can emit a plain {error:{message}} frame instead of
        // a normal delta if generation fails mid-stream (out of context,
        // etc.) - surface it the same as a non-2xx response would.
        if (event?.error) {
          abort();
          resolve({
            success: false,
            data: null,
            error: { type: ERROR_TYPES.INFERENCE_ERROR, message: event.error.message || 'Backend returned an error mid-stream.', raw: event },
          });
          return;
        }
        const delta = event?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta.length > 0) {
          accumulated += delta;
          sawAnyContent = true;
          onToken(accumulated);
        }
      },
      onComplete: () => {
        if (!sawAnyContent) {
          resolve({ success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: 'No content from backend.', raw: lastRaw } });
          return;
        }
        resolve({
          success: true,
          data: { content: accumulated, toolCalls: null, raw: lastRaw },
          error: null,
        });
      },
      onError: (err) => {
        console.error('[BackendClient] sendMessage (streaming) failed:', err);
        const msg = err?.message || '';
        if (msg === 'HTTP 401') {
          resolve({ success: false, data: null, error: { type: ERROR_TYPES.BAD_REQUEST, message: 'Backend rejected the auth token. Check it matches AUTH_TOKEN in the PC\'s server/config.js.' } });
          return;
        }
        if (msg === 'HTTP 503') {
          resolve({ success: false, data: null, error: { type: ERROR_TYPES.MODEL_LOADING, message: 'The model is still loading on the backend. Try again in a moment.' } });
          return;
        }
        const isNetworkError = msg.includes('Network request failed') || msg === 'TIMEOUT';
        resolve({
          success: false,
          data: null,
          error: {
            type: isNetworkError ? ERROR_TYPES.BACKEND_UNREACHABLE : ERROR_TYPES.UNKNOWN,
            message: isNetworkError
              ? `Can't reach the ZAO backend (${mode === 'remote' ? 'Remote' : 'LAN'} mode). Make sure start.bat is running on your PC${mode === 'remote' ? ' and the tunnel URL in Settings is current (it changes on every restart)' : ''}.`
              : msg || 'Backend request failed.',
          },
        });
      },
    });
  });
}

/**
 * Runs a shell command on the PC via the backend's /terminal/run route.
 * See src/services/terminal/pcTerminalTool.js for the tool-calling wrapper
 * around this.
 * @param {string} command
 * @param {object} [options] - { cwd, timeoutMs }
 * @returns {Promise<{success, data: {exitCode, timedOut, stdout, stderr}|null, error}>}
 */
export async function runTerminalCommand(command, options = {}) {
  const { mode, baseUrl, token } = getActiveConnection();
  if (!baseUrl) {
    return {
      success: false,
      data: null,
      error: { type: ERROR_TYPES.NOT_CONFIGURED, message: `No ${mode === 'remote' ? 'Remote' : 'LAN'} backend URL is set. Add it in Settings > Backend Connection.` },
    };
  }

  try {
    const response = await withTimeout(
      fetch(`${baseUrl}/terminal/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({
          command,
          cwd: options.cwd,
          timeoutMs: options.timeoutMs || TERMINAL_TIMEOUT_MS,
          shell: options.shell || undefined,
        }),
      }),
      (options.timeoutMs || TERMINAL_TIMEOUT_MS) + 10000, // small buffer over the server's own timeout
      'Terminal command timed out waiting for a response.'
    );

    if (response.status === 401) {
      return { success: false, data: null, error: { type: ERROR_TYPES.BAD_REQUEST, message: 'Backend rejected the auth token.' } };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: `Terminal request failed (${response.status}): ${text.slice(0, 200)}` } };
    }

    const result = await response.json();
    return { success: true, data: result, error: null };
  } catch (err) {
    console.error('[BackendClient] runTerminalCommand failed:', err);
    const isNetworkError = err?.message?.includes('Network request failed') || err?.message?.includes('timed out');
    return {
      success: false,
      data: null,
      error: {
        type: isNetworkError ? ERROR_TYPES.BACKEND_UNREACHABLE : ERROR_TYPES.UNKNOWN,
        message: isNetworkError
          ? `Can't reach the ZAO backend (${mode === 'remote' ? 'Remote' : 'LAN'} mode) to run the command.`
          : err?.message || 'Terminal request failed.',
      },
    };
  }
}

/**
 * Lists a folder on the PC via the backend's /pc-fs/list route - the
 * "what did that npm install / build actually produce" step before
 * pulling a specific file down with readPcFile(). Path is relative to
 * server/config.js's PC_BRIDGE_ROOT.
 * @param {string} [relativePath]
 * @returns {Promise<{success, data: {path, entries: Array<{name, isDir, size}>}|null, error}>}
 */
export async function listPcDirectory(relativePath = '') {
  const { mode, baseUrl, token } = getActiveConnection();
  if (!baseUrl) {
    return {
      success: false,
      data: null,
      error: { type: ERROR_TYPES.NOT_CONFIGURED, message: `No ${mode === 'remote' ? 'Remote' : 'LAN'} backend URL is set. Add it in Settings > Backend Connection.` },
    };
  }
  try {
    const response = await withTimeout(
      fetch(`${baseUrl}/pc-fs/list?path=${encodeURIComponent(relativePath)}`, { headers: authHeaders(token) }),
      HEALTH_TIMEOUT_MS,
      'PC file listing timed out'
    );
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      return { success: false, data: null, error: { message: json?.error?.message || `PC returned ${response.status}.` } };
    }
    return { success: true, data: json, error: null };
  } catch (err) {
    const isNetworkError = err?.message?.includes('Network request failed') || err?.message?.includes('timed out');
    return {
      success: false,
      data: null,
      error: { type: isNetworkError ? ERROR_TYPES.BACKEND_UNREACHABLE : ERROR_TYPES.UNKNOWN, message: isNetworkError ? "Can't reach the PC backend to list files." : err?.message || 'PC file listing failed.' },
    };
  }
}

/**
 * Reads one file's bytes (base64) from the PC via the backend's
 * /pc-fs/read route - how a build artifact (an APK, a bundle) that
 * terminal_pc_run_command produced on the PC actually gets pulled onto
 * the phone. Pair with filesystemTool.writeBinaryFileFromBase64() to
 * save it into the phone's own SAF folder - see pcFilePullTool.js.
 * @param {string} relativePath - relative to PC_BRIDGE_ROOT
 * @returns {Promise<{success, data: {path, size, contentB64}|null, error}>}
 */
export async function readPcFile(relativePath) {
  const { mode, baseUrl, token } = getActiveConnection();
  if (!baseUrl) {
    return {
      success: false,
      data: null,
      error: { type: ERROR_TYPES.NOT_CONFIGURED, message: `No ${mode === 'remote' ? 'Remote' : 'LAN'} backend URL is set. Add it in Settings > Backend Connection.` },
    };
  }
  try {
    const response = await withTimeout(
      fetch(`${baseUrl}/pc-fs/read?path=${encodeURIComponent(relativePath)}`, { headers: authHeaders(token) }),
      TERMINAL_TIMEOUT_MS,
      'PC file read timed out'
    );
    const json = await response.json().catch(() => null);
    if (!response.ok) {
      return { success: false, data: null, error: { message: json?.error?.message || `PC returned ${response.status}.` } };
    }
    return { success: true, data: json, error: null };
  } catch (err) {
    const isNetworkError = err?.message?.includes('Network request failed') || err?.message?.includes('timed out');
    return {
      success: false,
      data: null,
      error: { type: isNetworkError ? ERROR_TYPES.BACKEND_UNREACHABLE : ERROR_TYPES.UNKNOWN, message: isNetworkError ? "Can't reach the PC backend to read the file." : err?.message || 'PC file read failed.' },
    };
  }
}

/**
 * Runs a live web search via the backend's /web/search route (DuckDuckGo
 * HTML results, no API key - see server/webSearch.js). This is what backs
 * both the "Web search" toggle in AttachmentSheet.js and the local coder
 * model's web_search tool (src/services/search/webSearchTool.js).
 * @param {string} query
 * @param {number} [maxResults]
 * @returns {Promise<{success, data: {query, results: Array<{title,url,snippet}>}|null, error}>}
 */
export async function runWebSearch(query, maxResults = 5) {
  const { mode, baseUrl, token } = getActiveConnection();
  if (!baseUrl) {
    return {
      success: false,
      data: null,
      error: { type: ERROR_TYPES.NOT_CONFIGURED, message: `No ${mode === 'remote' ? 'Remote' : 'LAN'} backend URL is set. Add it in Settings > Backend Connection.` },
    };
  }

  try {
    const response = await withTimeout(
      fetch(`${baseUrl}/web/search`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ query, maxResults }),
      }),
      WEB_SEARCH_TIMEOUT_MS,
      'Web search timed out waiting for a response.'
    );

    if (response.status === 401) {
      return { success: false, data: null, error: { type: ERROR_TYPES.BAD_REQUEST, message: 'Backend rejected the auth token.' } };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: `Search request failed (${response.status}): ${text.slice(0, 200)}` } };
    }

    const result = await response.json();
    if (!result.success) {
      return { success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: result?.error?.message || 'Search returned no results.' } };
    }

    return { success: true, data: { query: result.query, results: result.results || [] }, error: null };
  } catch (err) {
    console.error('[BackendClient] runWebSearch failed:', err);
    const isNetworkError = err?.message?.includes('Network request failed') || err?.message?.includes('timed out');
    return {
      success: false,
      data: null,
      error: {
        type: isNetworkError ? ERROR_TYPES.BACKEND_UNREACHABLE : ERROR_TYPES.UNKNOWN,
        message: isNetworkError ? `Could not reach the ${mode === 'remote' ? 'Remote' : 'LAN'} backend for search.` : (err?.message || 'Web search failed.'),
      },
    };
  }
}

const OCR_TIMEOUT_MS = 3 * 60 * 1000; // scanned multi-page PDFs are slow on CPU; small buffer over the server's own OCR_TIMEOUT_MS

/**
 * Runs OCR on a scanned PDF or an image via the backend's /ocr/extract
 * route (free/open-source Tesseract + PyMuPDF running in a Python
 * subprocess on the PC - see server/ocr.js). Used by fileProcessor.js as
 * a fallback when the local, pattern-matching PDF extractor
 * (src/files/pdfExtractor.js) finds no text, and to pull any readable
 * text out of a plain image attachment (there is no vision model in ZAO,
 * so this is the only way image text reaches the model at all).
 * @param {string} base64Data - raw file bytes, base64-encoded, no data-URI prefix
 * @param {string} fileName - only the extension matters (routes .pdf vs. image handling server-side)
 * @returns {Promise<{success, data: {text, pageCount, pagesProcessed}|null, error}>}
 */
export async function runOcrExtraction(base64Data, fileName) {
  const { mode, baseUrl, token } = getActiveConnection();
  if (!baseUrl) {
    return {
      success: false,
      data: null,
      error: { type: ERROR_TYPES.NOT_CONFIGURED, message: `No ${mode === 'remote' ? 'Remote' : 'LAN'} backend URL is set. Add it in Settings > Backend Connection.` },
    };
  }

  try {
    const response = await withTimeout(
      fetch(`${baseUrl}/ocr/extract`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ fileBase64: base64Data, fileName }),
      }),
      OCR_TIMEOUT_MS,
      'OCR timed out waiting for a response.'
    );

    if (response.status === 401) {
      return { success: false, data: null, error: { type: ERROR_TYPES.BAD_REQUEST, message: 'Backend rejected the auth token.' } };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: `OCR request failed (${response.status}): ${text.slice(0, 200)}` } };
    }

    const result = await response.json();
    if (!result.success) {
      return { success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: result.error || 'OCR found no readable text.' } };
    }

    return {
      success: true,
      data: { text: result.text, pageCount: result.pageCount, pagesProcessed: result.pagesProcessed },
      error: null,
    };
  } catch (err) {
    console.error('[BackendClient] runOcrExtraction failed:', err);
    const isNetworkError = err?.message?.includes('Network request failed') || err?.message?.includes('timed out');
    return {
      success: false,
      data: null,
      error: {
        type: isNetworkError ? ERROR_TYPES.BACKEND_UNREACHABLE : ERROR_TYPES.UNKNOWN,
        message: isNetworkError
          ? `Can't reach the ZAO backend (${mode === 'remote' ? 'Remote' : 'LAN'} mode) to run OCR.`
          : err?.message || 'OCR request failed.',
      },
    };
  }
}

const DATA_ANALYSIS_TIMEOUT_MS = 3 * 60 * 1000; // large CSVs can be slow to load/groupby; small buffer over the server's own DATA_TIMEOUT_MS

/**
 * Runs pandas-based analysis on an existing CSV/XLSX file via the
 * backend's /data/analyze route (Python subprocess on the PC - see
 * server/data.js, scripts/data_analyze.py). Used by
 * src/services/data/dataAnalysisTool.js as the model's data_analyze_file
 * tool - describe/head/filter/groupby against real tabular data, the
 * thing SheetJS (client-side, spreadsheet CREATION only) can't do.
 * @param {string} base64Data - raw file bytes, base64-encoded, no data-URI prefix
 * @param {string} fileName - extension matters (.csv/.tsv/.xlsx/.xls - routes which pandas reader is used server-side)
 * @param {object} options - { operation: 'describe'|'head'|'filter'|'groupby', sheet, n, filter, groupby } - see data_analyze.py's header for the full shape
 * @returns {Promise<{success, data: {shape, columns, dtypes, result}|null, error}>}
 */
export async function runDataAnalysis(base64Data, fileName, options = {}) {
  const { mode, baseUrl, token } = getActiveConnection();
  if (!baseUrl) {
    return {
      success: false,
      data: null,
      error: { type: ERROR_TYPES.NOT_CONFIGURED, message: `No ${mode === 'remote' ? 'Remote' : 'LAN'} backend URL is set. Add it in Settings > Backend Connection.` },
    };
  }

  try {
    const response = await withTimeout(
      fetch(`${baseUrl}/data/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders(token) },
        body: JSON.stringify({ fileBase64: base64Data, fileName, options }),
      }),
      DATA_ANALYSIS_TIMEOUT_MS,
      'Data analysis timed out waiting for a response.'
    );

    if (response.status === 401) {
      return { success: false, data: null, error: { type: ERROR_TYPES.BAD_REQUEST, message: 'Backend rejected the auth token.' } };
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      return { success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: `Data analysis request failed (${response.status}): ${text.slice(0, 200)}` } };
    }

    const result = await response.json();
    if (!result.success) {
      return { success: false, data: null, error: { type: ERROR_TYPES.INFERENCE_ERROR, message: result.error || 'Data analysis failed.' } };
    }

    return {
      success: true,
      data: { shape: result.shape, columns: result.columns, dtypes: result.dtypes, result: result.result },
      error: null,
    };
  } catch (err) {
    console.error('[BackendClient] runDataAnalysis failed:', err);
    const isNetworkError = err?.message?.includes('Network request failed') || err?.message?.includes('timed out');
    return {
      success: false,
      data: null,
      error: {
        type: isNetworkError ? ERROR_TYPES.BACKEND_UNREACHABLE : ERROR_TYPES.UNKNOWN,
        message: isNetworkError
          ? `Can't reach the ZAO backend (${mode === 'remote' ? 'Remote' : 'LAN'} mode) to run data analysis.`
          : err?.message || 'Data analysis request failed.',
      },
    };
  }
}

export { ERROR_TYPES };
