/**
 * ZAO - Browser Agent Loop (Stage 2)
 *
 * This is the "brain" that decides what to click/fill/read inside the
 * on-device browser (BrowserAgentView.js is the "hands" - the how). It
 * replaces the old server-based Internet Router (src/services/browserRouter/
 * client.js), which sent tasks to a self-hosted FastAPI + Qwen3 backend the
 * user had to run and tunnel to their phone. The reasoning model (Qwen2.5
 * Coder) is served by a small Termux-hosted backend on the same device
 * (src/services/backend/backendClient.js) - no OpenRouter, no Hugging
 * Face, no cloud call - but the actual browser it controls is the
 * visible WebView already wired into App.js / BrowserAgentScreen.js.
 *
 * SESSION MODEL - this is the part that makes "give it a task, let it
 * finish, then give it a follow-up task and have it continue from where the
 * browser currently is" work: an AgentSession is a stateful object, not a
 * one-shot function. Its `history` array is a real running conversation
 * (system prompt + every task + every action/observation pair since the
 * session was created), so a second call to runTask() on the same session
 * sees everything that happened in the first one - the model can act on
 * "the repo I just opened" or "the form I already filled halfway" without
 * being told again. The browser's actual state (whatever page/tab is open)
 * persists automatically since it's the same live BrowserAgentView the
 * whole time - the session object doesn't need to snapshot or restore it.
 *
 * WHY A RUNNING CONVERSATION (vs. a fresh call per step): a fresh call each
 * step would only ever see the current DOM snapshot, with no memory of what
 * it already tried. Real tasks ("log in, then check the latest build") need
 * the model to remember it already typed the username before it types the
 * password, or that a previous click didn't do what it expected and it
 * should try something else instead of repeating the same action forever.
 * The tradeoff is growing context length - trimOldPageStates() below keeps
 * this bounded by summarizing away full extractInteractiveElements() dumps
 * from steps that are no longer the current page, while keeping the
 * plan/action/short-observation trail intact so the model still remembers
 * *what it did*, just not the full stale DOM every single time.
 *
 * STOPPING CONDITION: the model signals it's done itself (a `finish` action
 * with a plain-language answer), which is what makes "wait for a new task in
 * the same conversation" possible - the loop simply returns control back to
 * the caller rather than being torn down. MAX_STEPS_PER_TASK is a hard
 * safety cap under that, for a runaway task that never calls finish (a
 * confused loop clicking the same element repeatedly, a page that never
 * settles, etc.) - it stops the *current task*, not the session, so the
 * person can still give a follow-up task afterward.
 */

import * as llamaEngine from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';

const MAX_STEPS_PER_TASK = 25;
// Steps older than this many turns back get their full page-state payload
// collapsed to a one-line summary (see trimOldPageStates) - keeps context
// bounded on long multi-task sessions without losing the action history.
const FULL_STATE_LOOKBACK = 3;

const SYSTEM_PROMPT = `You are ZAO's on-device browser agent. You control a real browser on the
user's phone through a fixed set of actions. You can see the page's
interactive elements (links, buttons, inputs, selects) as a JSON list, each
with a short id like "z3" - use that id to act on it, never guess a
selector.

Respond with ONLY a single JSON object, no other text, matching one of:

{"action": "navigate", "url": "https://..."}
{"action": "click", "zaoId": "z3"}
{"action": "fill", "zaoId": "z5", "text": "..."}
{"action": "selectOption", "zaoId": "z2", "value": "..."}
{"action": "setChecked", "zaoId": "z7", "checked": true}
{"action": "submitForm", "zaoId": "z5"}
{"action": "scrollTo", "zaoId": "z9"}
{"action": "waitForSelector", "selector": "css-selector", "timeoutMs": 8000}
{"action": "extractPageText"}
{"action": "extractTables"}
{"action": "newTab", "url": "https://..."}
{"action": "switchTab", "tabId": "tab_..."}
{"action": "closeTab", "tabId": "tab_..."}
{"action": "goBack"}
{"action": "setZoom", "percent": 100}
{"action": "needsHuman", "reason": "..."}
{"action": "finish", "answer": "..."}

Rules:
- One action per turn. You'll see the result before deciding the next one.
- Use "finish" as soon as the task is genuinely done - don't keep poking the
  page afterward. Put the actual answer/result the user asked for in
  "answer", not just "done".
- Use "needsHuman" for CAPTCHAs, unexpected 2FA prompts, or anything that
  genuinely requires the person's own input - don't try to guess your way
  past these.
- Use "setZoom" when the person explicitly asks to zoom in/out to a
  specific percentage (e.g. "zoom to 60%"). Don't change zoom on your own
  otherwise - the person's default view (zoomed out in the small preview,
  normal size in full screen) is intentional.
- If a page hasn't loaded yet or an element you expected isn't there, use
  waitForSelector or re-check the interactive elements rather than
  guessing an id that might not exist yet.
- Every reply must be exactly one valid JSON object and nothing else - no
  markdown fences, no explanation text outside the JSON.`;

/**
 * One resumable browser-agent conversation. Create once when the user
 * turns on browser access / opens the browser agent screen; call
 * runTask() every time they give it something to do. The same instance
 * should be reused across tasks within one chat session so follow-ups
 * ("now open the second result") have the history to act on.
 */
export class AgentSession {
  /**
   * @param {React.RefObject} browserViewRef - ref to a mounted BrowserAgentView's imperative handle
   * @param {React.RefObject|null} pipRef - ref to a mounted BrowserAgentPiP, if step-by-step
   *   local snapshot recording is wanted for this session (optional -
   *   pass null to run without recording, e.g. in a test/dev context)
   */
  constructor(browserViewRef, pipRef = null) {
    this.browserViewRef = browserViewRef;
    this.pipRef = pipRef;
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }];
    // Plain boolean, not React state - App.js polls this via
    // getIsRunning()/an onRunningChange subscriber below to drive the PiP's
    // "Agent working…" indicator, since AgentSession itself is a plain
    // class, not a component.
    this.isRunning = false;
    this._runningListeners = new Set();
  }

  onRunningChange(listener) {
    this._runningListeners.add(listener);
    return () => this._runningListeners.delete(listener);
  }

  _setRunning(value) {
    this.isRunning = value;
    this._runningListeners.forEach((l) => l(value));
  }

  /**
   * Collapses full extractInteractiveElements()/page-text dumps from
   * earlier steps down to a one-line marker once they're more than
   * FULL_STATE_LOOKBACK steps old, so a long multi-task session doesn't
   * grow context without bound. The action the model took and its
   * short result are left untouched either way - only the bulky raw page
   * observation gets trimmed.
   */
  _trimOldPageStates() {
    const observationIndices = this.history
      .map((m, i) => (m.role === 'user' && m.__isObservation ? i : -1))
      .filter((i) => i !== -1);

    const cutoff = observationIndices.length - FULL_STATE_LOOKBACK;
    for (let k = 0; k < cutoff; k++) {
      const idx = observationIndices[k];
      if (!this.history[idx].__trimmed) {
        this.history[idx] = {
          role: 'user',
          content: '[earlier page state omitted - see the action taken next]',
          __isObservation: true,
          __trimmed: true,
        };
      }
    }
  }

  async _callModel() {
    // Calls the Qwen2.5 Coder model on the Termux backend directly - no
    // cloud cascade, since there's one model with no rate limit and
    // nothing to fall back to.
    const modelResult = await llamaEngine.sendMessage(this.history, MODEL_KEYS.QWEN25_CODER_3B, {
      maxTokens: 1024,
      temperature: 0.2, // low - this is structured action selection, not creative writing
    });

    if (!modelResult.success) {
      return { success: false, error: modelResult.error };
    }
    return {
      success: true,
      content: modelResult.data.content,
      provider: 'local',
    };
  }

  _parseAction(rawContent) {
    // Models occasionally wrap JSON in a code fence despite instructions -
    // strip that defensively rather than failing the whole step over it.
    const cleaned = rawContent.trim().replace(/^```json\s*|^```\s*|```$/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      return null;
    }
  }

  async _executeAction(action) {
    const view = this.browserViewRef.current;
    if (!view) {
      throw new Error('Browser view is not mounted');
    }

    switch (action.action) {
      case 'navigate':
        view.navigate(action.url);
        // Navigation is async from the WebView's side (no immediate DOM to
        // read) - a short settle delay here is simpler and more reliable
        // than trying to key off onNavigationStateChange for this one case.
        await new Promise((r) => setTimeout(r, 1500));
        return view.extractInteractiveElements();
      case 'click':
        await view.click(action.zaoId);
        await new Promise((r) => setTimeout(r, 800)); // let click-triggered nav/DOM changes settle
        return view.extractInteractiveElements();
      case 'fill':
        await view.fill(action.zaoId, action.text);
        return view.extractInteractiveElements();
      case 'selectOption':
        await view.selectOption(action.zaoId, action.value);
        return view.extractInteractiveElements();
      case 'setChecked':
        await view.setChecked(action.zaoId, action.checked);
        return view.extractInteractiveElements();
      case 'submitForm':
        await view.submitForm(action.zaoId);
        await new Promise((r) => setTimeout(r, 1500));
        return view.extractInteractiveElements();
      case 'scrollTo':
        await view.scrollTo({ zaoId: action.zaoId });
        return view.extractInteractiveElements();
      case 'waitForSelector':
        const found = await view.waitForSelector(action.selector, action.timeoutMs || 8000);
        return { waitedFor: action.selector, found, elements: await view.extractInteractiveElements() };
      case 'extractPageText':
        return { pageText: await view.extractPageText(6000) };
      case 'extractTables':
        return { tables: await view.extractTables() };
      case 'newTab':
        const newTabId = view.newTab(action.url || 'about:blank');
        await new Promise((r) => setTimeout(r, 1500));
        return { newTabId, elements: await view.extractInteractiveElements() };
      case 'switchTab':
        view.switchTab(action.tabId);
        return view.extractInteractiveElements();
      case 'closeTab':
        view.closeTab(action.tabId);
        return { closed: action.tabId, tabs: view.listTabs() };
      case 'goBack':
        view.goBack();
        await new Promise((r) => setTimeout(r, 1000));
        return view.extractInteractiveElements();
      case 'setZoom':
        return await view.setZoom(action.percent);
      default:
        throw new Error(`Unknown action: ${action.action}`);
    }
  }

  /**
   * Runs one task to completion (or until it hits finish/needsHuman/the
   * step cap). Safe to call again on the same session afterward for a
   * follow-up task - the browser stays on whatever page the previous task
   * left it on, and the model still has the full history to reason from.
   *
   * @param {string} taskText - what the user asked for
   * @param {object} callbacks - { onStep(stepInfo), onScreenshot(base64) } - both optional, for live progress UI
   */
  async runTask(taskText, callbacks = {}) {
    const { onStep } = callbacks;
    this._setRunning(true);
    try {
      return await this._runTaskInner(taskText, onStep);
    } finally {
      this._setRunning(false);
    }
  }

  async _runTaskInner(taskText, onStep) {
    const view = this.browserViewRef.current;
    const currentPage = view ? await view.getPageInfo().catch(() => null) : null;
    const initialElements = view ? await view.extractInteractiveElements().catch(() => []) : [];

    this.history.push({
      role: 'user',
      content: `New task: ${taskText}\n\nCurrent page: ${currentPage ? currentPage.url : 'no page loaded yet'}\nInteractive elements:\n${JSON.stringify(initialElements)}`,
      __isObservation: true,
    });

    for (let step = 0; step < MAX_STEPS_PER_TASK; step++) {
      this._trimOldPageStates();

      const modelResult = await this._callModel();
      if (!modelResult.success) {
        return {
          success: false,
          answer: null,
          error: modelResult.error,
          stepsUsed: step,
        };
      }

      this.history.push({ role: 'assistant', content: modelResult.content });

      const action = this._parseAction(modelResult.content);
      if (!action) {
        // Model didn't return parseable JSON - tell it so via the
        // conversation itself rather than failing the task outright; it
        // can usually self-correct on the next turn.
        this.history.push({
          role: 'user',
          content: 'Your last reply was not valid JSON. Reply with exactly one JSON action object and nothing else.',
          __isObservation: true,
        });
        continue;
      }

      onStep?.({ step, action });

      if (action.action === 'finish') {
        return { success: true, answer: action.answer || '', error: null, stepsUsed: step + 1 };
      }

      if (action.action === 'needsHuman') {
        return {
          success: false,
          answer: null,
          needsHuman: true,
          reason: action.reason || 'This step needs your input.',
          error: { type: 'NEEDS_HUMAN', message: action.reason || 'This step needs your input.' },
          stepsUsed: step + 1,
        };
      }

      let observation;
      try {
        observation = await this._executeAction(action);
      } catch (err) {
        observation = { error: err?.message || String(err) };
      }

      // Step-by-step recording: one snapshot per executed action, saved
      // to on-device storage under this session's id. Skipped for
      // finish/needsHuman above since those return before this point and
      // don't change the page - the snapshot right after the prior action
      // already shows the end state.
      if (this.pipRef?.current) {
        try {
          Promise.resolve(this.pipRef.current.captureStep({ step, action })).catch(() => {});
        } catch (_) {
          // captureStep itself threw synchronously - recording is
          // best-effort and should never break the actual task.
        }
      }

      this.history.push({
        role: 'user',
        content: JSON.stringify(observation),
        __isObservation: true,
      });
    }

    return {
      success: false,
      answer: null,
      error: { type: 'MAX_STEPS_EXCEEDED', message: `Stopped after ${MAX_STEPS_PER_TASK} steps without finishing - the task may need breaking into smaller pieces.` },
      stepsUsed: MAX_STEPS_PER_TASK,
    };
  }
}
