/**
 * ZAO - Browser Agent Stream Client
 *
 * Talks to the PC backend's WebSocket browser agent (see
 * server/browserStream.js and server/browserAgent.js) - the phone no
 * longer runs its own browser or decision loop (see agentLoop.js's
 * retirement note), it just connects to whichever backend URL is active
 * (LAN or Remote, same as everything else - see backendClient.js) and:
 *   - receives a live screenshot stream + action log to display
 *   - sends manual tap/type/key events when the person wants to drive the
 *     browser directly (CAPTCHAs, anything the model flagged with
 *     needsHuman)
 *
 * One BrowserAgentStream instance per app lifetime, same pattern as the
 * old AgentSession - created once, reused across tasks/screens so the
 * live PC-side session (and its history/current page) persists between
 * "give it a task, then give it a follow-up" without reconnecting.
 */

import { usePreferencesStore } from '../../store/preferencesStore';

function getActiveWsUrl() {
  const prefs = usePreferencesStore.getState().preferences || {};
  const mode = prefs.backend_mode || 'lan';
  const baseUrl = mode === 'remote' ? prefs.backend_remote_url : prefs.backend_lan_url;
  const token = prefs.backend_auth_token || '';
  if (!baseUrl) return null;
  // ws(s):// instead of http(s):// - same host/port, different scheme.
  const wsBase = baseUrl.replace(/^https:\/\//, 'wss://').replace(/^http:\/\//, 'ws://').replace(/\/+$/, '');
  return `${wsBase}/browser-agent/stream?token=${encodeURIComponent(token)}`;
}

const RECONNECT_DELAY_MS = 3000;

export class BrowserAgentStream {
  constructor() {
    this.ws = null;
    this.connected = false;
    this.running = false;
    this.awaitingHuman = false;
    this.humanReason = null;
    this.tabs = []; // [{tabId, url, title, active}] - kept in sync via 'status' messages, see BrowserAgentScreen.js's tab strip / address bar
    this._listeners = { frame: new Set(), status: new Set(), step: new Set(), taskResult: new Set(), connectionChange: new Set() };
    this._reconnectTimer = null;
    this._intentionalClose = false;
  }

  on(event, listener) {
    this._listeners[event]?.add(listener);
    return () => this._listeners[event]?.delete(listener);
  }

  _emit(event, payload) {
    this._listeners[event]?.forEach((l) => l(payload));
  }

  /** Opens the WebSocket connection. Safe to call again if already connected (no-ops). */
  connect() {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }
    const url = getActiveWsUrl();
    if (!url) {
      this._emit('connectionChange', { connected: false, error: 'No backend URL configured. Set it in Settings > Backend Connection.' });
      return;
    }

    this._intentionalClose = false;
    this.ws = new WebSocket(url);

    this.ws.onopen = () => {
      this.connected = true;
      this._emit('connectionChange', { connected: true, error: null });
    };

    this.ws.onmessage = (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch (err) {
        return;
      }
      switch (msg.type) {
        case 'frame':
          this._emit('frame', msg.data); // base64 jpeg
          break;
        case 'status':
          this.running = msg.running;
          this.awaitingHuman = msg.awaitingHuman;
          this.humanReason = msg.reason;
          this.tabs = msg.tabs || [];
          this._emit('status', msg);
          break;
        case 'step':
          this._emit('step', msg);
          break;
        case 'taskResult':
          this._emit('taskResult', msg);
          break;
        case 'error':
          this._emit('taskResult', { success: false, error: { message: msg.message } });
          break;
      }
    };

    this.ws.onclose = () => {
      this.connected = false;
      this._emit('connectionChange', { connected: false, error: null });
      if (!this._intentionalClose) {
        // PC backend restarted, network blip, etc. - retry rather than
        // leaving the person stuck with a dead session; runTask() calls
        // made while disconnected are queued naturally by the person just
        // retrying the button, so no request queue is needed here.
        this._reconnectTimer = setTimeout(() => this.connect(), RECONNECT_DELAY_MS);
      }
    };

    this.ws.onerror = () => {
      // onclose fires right after in every browser/RN WebSocket
      // implementation - no separate handling needed here beyond letting
      // that path run.
    };
  }

  disconnect() {
    this._intentionalClose = true;
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this.ws?.close();
  }

  _send(payload) {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }

  /** Starts a new autonomous task on the PC agent (fire-and-forget - use runTaskAwaitable for a Promise that resolves with the result). */
  runTask(task) {
    return this._send({ type: 'runTask', task });
  }

  /**
   * Same as runTask(), but returns a Promise resolving with the
   * taskResult payload - matches the old on-device AgentSession's
   * runTask() shape ({ success, answer, error, needsHuman, reason,
   * stepsUsed }) so orchestrator.js's existing call site
   * (agentSession.runTask(text, { onStep })) needs no changes beyond
   * passing this stream in as agentSession.
   * @param {string} task
   * @param {object} callbacks - { onStep(stepInfo) }
   */
  runTaskAwaitable(task, callbacks = {}) {
    const { onStep } = callbacks;
    return new Promise((resolve) => {
      const offStep = onStep ? this.on('step', onStep) : null;
      const offResult = this.on('taskResult', (result) => {
        offStep?.();
        offResult();
        resolve(result);
      });
      const sent = this._send({ type: 'runTask', task });
      if (!sent) {
        offStep?.();
        offResult();
        resolve({
          success: false,
          answer: null,
          error: { type: 'BACKEND_UNREACHABLE', message: 'Not connected to the PC backend. Check Settings > Backend Connection.' },
        });
      }
    });
  }

  /** Hands control back to the model after the person finishes manual intervention (e.g. solved a CAPTCHA). */
  resumeAfterHuman() {
    return this._send({ type: 'resumeAfterHuman' });
  }

  /** Stops the current task early. */
  cancel() {
    return this._send({ type: 'cancel' });
  }

  /** Manual tap on the live view - x/y relative to the streamed 412x915 viewport (see BrowserStreamView.js for the coordinate scaling). */
  manualClick(x, y) {
    return this._send({ type: 'manualClick', x, y });
  }

  /** Manual text input into whatever's focused on the page (tap the field first via manualClick). */
  manualType(text) {
    return this._send({ type: 'manualType', text });
  }

  /** Manual single key press (Enter, Tab, Backspace, etc.). */
  manualKey(key) {
    return this._send({ type: 'manualKey', key });
  }

  /** Address bar: navigate the active tab directly, without going through the model. Accepts a bare domain ("example.com") same as typing into a real browser's address bar - the PC side normalizes it into a full URL. */
  navigateTo(url) {
    return this._send({ type: 'navigateTo', url });
  }

  /** Tab strip: switch which tab is active. */
  switchTab(tabId) {
    return this._send({ type: 'switchTab', tabId });
  }

  /** Tab strip: "+" button. */
  newTab(url) {
    return this._send({ type: 'newTab', url });
  }

  /** Tab strip: "x" on a tab. */
  closeTab(tabId) {
    return this._send({ type: 'closeTab', tabId });
  }
}
