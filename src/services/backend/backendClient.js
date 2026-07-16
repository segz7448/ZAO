/**
 * ZAO - Backend Client
 *
 * Replaces src/services/llama/llamaEngine.js. There is no on-device model
 * anymore - ZAO talks over HTTP to a Node server running in Termux on the
 * same device (see /server in the repo root), which itself wraps
 * llama-server running Qwen2.5-Coder-1.5B.
 *
 * DISCOVERY: no URL is ever entered in the app. The backend always runs at
 * http://127.0.0.1:8080 (same device, loopback) - see server/config.js for
 * the matching PORT. connectBackend()/checkBackendHealth() just poll that
 * fixed address.
 *
 * CONTRACT: sendMessage() keeps the exact same shape llamaEngine.js used -
 * { success, data: { content, toolCalls, raw }, error } - so
 * orchestrator.js, toolOrchestrator.js, agentLoop.js, and memoryEngine.js
 * need no changes beyond the import path and dropping the multi-model
 * concept (see config/localModels.js - there is now only one model key).
 */

const BACKEND_URL = 'http://127.0.0.1:8080';
const HEALTH_TIMEOUT_MS = 4 * 1000;
const COMPLETION_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes - CPU inference on a phone-hosted server is not instant

const ERROR_TYPES = {
  BACKEND_UNREACHABLE: 'BACKEND_UNREACHABLE',
  MODEL_LOADING: 'MODEL_LOADING',
  BAD_REQUEST: 'BAD_REQUEST',
  INFERENCE_ERROR: 'INFERENCE_ERROR',
  UNKNOWN: 'UNKNOWN',
};

function withTimeout(promise, ms, timeoutMessage) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Pings the Termux backend's /health endpoint. Used at app launch/foreground
 * and by Settings to show a live connection indicator - never throws.
 * @returns {Promise<{connected: boolean, ready: boolean, model: string|null}>}
 */
export async function checkBackendHealth() {
  try {
    const response = await withTimeout(
      fetch(`${BACKEND_URL}/health`),
      HEALTH_TIMEOUT_MS,
      'Health check timed out'
    );
    if (!response.ok) {
      return { connected: false, ready: false, model: null };
    }
    const json = await response.json();
    return {
      connected: true,
      ready: json.status === 'ready',
      model: json.model || null,
    };
  } catch (err) {
    return { connected: false, ready: false, model: null };
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
 * @param {object} options - { maxTokens, temperature, tools, toolChoice }
 * @returns {Promise<{success, data: {content, toolCalls, raw}|null, error}>}
 */
export async function sendMessage(history, modelKey, options = {}) {
  if (!Array.isArray(history) || history.length === 0) {
    return { success: false, data: null, error: { type: ERROR_TYPES.BAD_REQUEST, message: 'Empty conversation history' } };
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

  try {
    const response = await withTimeout(
      fetch(`${BACKEND_URL}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }),
      COMPLETION_TIMEOUT_MS,
      `Backend took longer than ${COMPLETION_TIMEOUT_MS / 1000}s to respond. Check the Termux session is still running.`
    );

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
          ? "Can't reach the ZAO backend. Make sure you've started it in Termux (./start.sh in the server folder)."
          : err?.message || 'Backend request failed.',
      },
    };
  }
}

export { ERROR_TYPES, BACKEND_URL };
