/**
 * ZAO Backend - Browser Agent (Playwright)
 *
 * This is the "brain" AND "hands" now living together on the PC - it
 * replaces src/services/browserAgent/agentLoop.js + domBridge.js +
 * BrowserAgentView.js, which drove a WebView on the phone. Rationale
 * (from the Zenas conversation that led here): a phone WebView can't run
 * headless, can't hold multiple tabs in the background reliably, and a
 * screenshot+DOM round-trip over a WebView bridge is slower and more
 * fragile than Playwright reading/acting on the DOM natively in the same
 * process as the model call. The phone becomes the "eyes and hands
 * DISPLAY" - it watches a live stream and can tap/type back in for manual
 * intervention (CAPTCHAs etc.) - but the autonomous decision loop and the
 * actual browser both live here.
 *
 * SESSION MODEL: same as the old agentLoop.js - one AgentSession is a
 * resumable conversation (system prompt + every task + every
 * action/observation since creation), so a follow-up task in the same
 * chat sees everything that happened before and can act on "the repo I
 * just opened" without being told again. The browser's real state (the
 * actual Playwright page) persists automatically since it's the same
 * live browser context the whole time.
 *
 * ACTION VOCABULARY: identical to the old WebView version's, deliberately
 * - it was already a good fit for Playwright (DOM-element-id based
 * targeting maps directly onto Playwright's own selector model), and
 * keeping it unchanged means the model's existing behavior/training-free
 * "muscle memory" for this task shape carries over rather than needing to
 * relearn a new action set.
 *
 * HUMAN HANDOFF (CAPTCHAs, unexpected 2FA, anything needing a person):
 * the model can call needsHuman, which pauses the loop and flags the
 * session as awaiting manual control. While paused, the phone can send
 * real tap/type events over the WebSocket stream (see browserStream.js)
 * that get executed directly against the live Playwright page - the
 * person drives the browser themselves through the live view. Calling
 * resumeAfterHuman() hands control back to the model, which re-observes
 * the page (now however the person left it) and continues.
 */

const { chromium } = require('playwright');

const MAX_STEPS_PER_TASK = 25;
const FULL_STATE_LOOKBACK = 3;

const SYSTEM_PROMPT = `You are ZAO's browser agent, running on the person's PC via Playwright/Chromium.
The person can see a live view of the browser on their phone and can take
over manually at any point (e.g. to solve a CAPTCHA) - when they do, you'll
see the page state after they're done and should continue from there.

You can see the page's interactive elements (links, buttons, inputs,
selects) as a JSON list, each with a short id like "z3" - use that id to
act on it, never guess a selector.

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
{"action": "checkConsole", "limit": 50}
{"action": "newTab", "url": "https://..."}
{"action": "switchTab", "tabId": "tab_..."}
{"action": "closeTab", "tabId": "tab_..."}
{"action": "goBack"}
{"action": "download", "zaoId": "z4"}
{"action": "needsHuman", "reason": "..."}
{"action": "finish", "answer": "..."}

Rules:
- One action per turn. You'll see the result before deciding the next one.
- Use "finish" as soon as the task is genuinely done - don't keep poking the
  page afterward. Put the actual answer/result the user asked for in
  "answer", not just "done".
- Use "needsHuman" for CAPTCHAs, unexpected 2FA prompts, camera/webcam
  verification (you have no camera access), or anything that genuinely
  requires the person's own input - don't try to guess your way past
  these. The person can see the live browser on their phone and will take
  over, then hand control back to you.
- Use "download" for a link/button that triggers a file download - this
  waits for the download to complete and saves it, returning the saved
  path.
- Use "checkConsole" to see the active tab's captured browser console
  messages, page errors, and failed network requests - useful when
  debugging a page that isn't behaving as expected. You'll also see a
  short "N console error(s) since last step" note automatically after
  any action that produced new errors, even without asking - call
  checkConsole when you see that note if you need the actual details.
- If a page hasn't loaded yet or an element you expected isn't there, use
  waitForSelector or re-check the interactive elements rather than
  guessing an id that might not exist yet.
- Every reply must be exactly one valid JSON object and nothing else - no
  markdown fences, no explanation text outside the JSON.`;

// DOM extraction/interaction script, evaluated inside the page via
// page.evaluate() - conceptually the same job as the old domBridge.js,
// but far simpler since Playwright calls this directly rather than
// needing an injected postMessage bridge.
function extractInteractiveElementsInPage() {
  const selector = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="textbox"], [contenteditable="true"]';
  const nodes = document.querySelectorAll(selector);
  const out = [];
  let counter = 0;

  nodes.forEach((el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const style = window.getComputedStyle(el);
    if (style.visibility === 'hidden' || style.display === 'none') return;

    const zaoId = 'z' + counter++;
    el.setAttribute('data-zao-id', zaoId);

    const tag = el.tagName.toLowerCase();
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 120);

    const entry = { id: zaoId, tag, text };
    if (tag === 'input') {
      entry.inputType = el.getAttribute('type') || 'text';
      entry.value = (el.value || '').slice(0, 200);
    }
    if (tag === 'select') {
      entry.options = Array.from(el.options).map((o) => o.text);
      entry.value = el.value;
    }
    if (tag === 'a') {
      entry.href = el.getAttribute('href') || '';
    }
    out.push(entry);
  });
  return out;
}

let browserInstance = null;

async function getBrowser() {
  if (!browserInstance) {
    browserInstance = await chromium.launch({ headless: true });
  }
  return browserInstance;
}

/**
 * One resumable browser-agent session, mirroring the old AgentSession's
 * shape closely so callers (server/index.js's routes) have a familiar
 * surface. Holds one Playwright BrowserContext with potentially several
 * tabs (pages), same multi-tab model as before.
 */
class AgentSession {
  constructor(onFrame) {
    // SCRATCHPAD memory (src/services/memory/memoryTypes.js /
    // MEMORY_ARCHITECTURE.md): this run's in-process reasoning trail,
    // never persisted. See src/services/memory/scratchpad.js for the
    // shared shape this pattern is formalized as, for any future loop.
    this.history = [{ role: 'system', content: SYSTEM_PROMPT }];
    this.isRunning = false;
    this.awaitingHuman = false;
    this.humanReason = null;
    this.context = null;
    this.pages = new Map(); // tabId -> Page
    this.consoleLogs = new Map(); // tabId -> array of {type, text, ts} - rolling buffer, see _newTab
    this.activeTabId = null;
    this.onFrame = onFrame || (() => {}); // called with a screenshot buffer whenever the view changes - see browserStream.js
    this._tabCounter = 0;
    this._streamTimer = null;
  }

  async _ensureContext() {
    if (this.context) return;
    const browser = await getBrowser();
    this.context = await browser.newContext({ viewport: { width: 412, height: 915 } }); // phone-ish aspect ratio, matches what's actually being displayed
    await this._newTab('about:blank');
  }

  _makeTabId() {
    this._tabCounter += 1;
    return `tab_${Date.now()}_${this._tabCounter}`;
  }

  async _newTab(url) {
    const page = await this.context.newPage();
    const tabId = this._makeTabId();
    this.pages.set(tabId, page);
    this.activeTabId = tabId;
    this._attachConsoleCapture(tabId, page);
    if (url && url !== 'about:blank') {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
    }
    return tabId;
  }

  /**
   * CONSOLE ACCESS (not a devtools panel in the UI itself - the agent's
   * own eyes on it instead, per the "should have console like access
   * where my agent can have access to it" ask). Always capturing in the
   * background for every tab from the moment it's created - console
   * messages, uncaught page errors, and failed network requests - kept
   * as a small rolling buffer per tab (not persisted, cleared on tab
   * close) rather than surfaced anywhere by default. Two ways this
   * actually reaches the model:
   *   1. On request - the "checkConsole" action dumps the active tab's
   *      buffer verbatim.
   *   2. Automatically on error - _extractElements()'s observation
   *      (returned after every action) folds in a short "N console
   *      error(s) since last step" note whenever new ERROR-level
   *      entries or pageerrors showed up, WITHOUT dumping the full
   *      text - see _newConsoleErrorsSince(). This is the "surface only
   *      if something errors" behavior: enough for the model to notice
   *      and decide to call checkConsole for the details, not a wall of
   *      text on every single step.
   */
  _attachConsoleCapture(tabId, page) {
    const MAX_ENTRIES = 200;
    const log = [];
    this.consoleLogs.set(tabId, log);
    const push = (entry) => {
      log.push({ ...entry, ts: Date.now() });
      if (log.length > MAX_ENTRIES) log.shift();
    };
    page.on('console', (msg) => {
      push({ kind: 'console', type: msg.type(), text: msg.text() });
    });
    page.on('pageerror', (err) => {
      push({ kind: 'pageerror', type: 'error', text: err?.message || String(err) });
    });
    page.on('requestfailed', (req) => {
      push({ kind: 'requestfailed', type: 'error', text: `${req.method()} ${req.url()} - ${req.failure()?.errorText || 'failed'}` });
    });
  }

  /** Count of error-level console entries pushed after the given timestamp - used to decide whether to fold an error note into the next observation without dumping the full log. */
  _newConsoleErrorsSince(tabId, sinceTs) {
    const log = this.consoleLogs.get(tabId) || [];
    return log.filter((e) => e.ts > sinceTs && (e.type === 'error' || e.kind === 'pageerror' || e.kind === 'requestfailed')).length;
  }

  _activePage() {
    return this.pages.get(this.activeTabId);
  }

  /** Starts pushing screenshot frames to onFrame at ~2fps (0.5s) while active. Stops automatically when the task finishes. */
  _startStreaming() {
    if (this._streamTimer) return;
    this._streamTimer = setInterval(async () => {
      try {
        const page = this._activePage();
        if (!page) return;
        const buffer = await page.screenshot({ type: 'jpeg', quality: 60 });
        this.onFrame(buffer);
      } catch (err) {
        // Page mid-navigation or closed - skip this frame, not fatal.
      }
    }, 500);
  }

  _stopStreaming() {
    if (this._streamTimer) {
      clearInterval(this._streamTimer);
      this._streamTimer = null;
    }
  }

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

  _parseAction(rawContent) {
    const cleaned = rawContent.trim().replace(/^```json\s*|^```\s*|```$/g, '').trim();
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      return null;
    }
  }

  async _extractElements() {
    const page = this._activePage();
    if (!page) return [];
    return page.evaluate(extractInteractiveElementsInPage).catch(() => []);
  }

  async _getPageInfo() {
    const page = this._activePage();
    if (!page) return null;
    return { url: page.url(), title: await page.title().catch(() => '') };
  }

  async _findLocator(zaoId) {
    const page = this._activePage();
    return page.locator(`[data-zao-id="${zaoId}"]`).first();
  }

  async _executeAction(action) {
    await this._ensureContext();
    const page = this._activePage();

    switch (action.action) {
      case 'navigate':
        await page.goto(action.url, { waitUntil: 'domcontentloaded', timeout: 30000 });
        return this._extractElements();
      case 'click': {
        const loc = await this._findLocator(action.zaoId);
        await loc.click({ timeout: 8000 });
        await page.waitForTimeout(600);
        return this._extractElements();
      }
      case 'fill': {
        const loc = await this._findLocator(action.zaoId);
        await loc.fill(action.text || '', { timeout: 8000 });
        return this._extractElements();
      }
      case 'selectOption': {
        const loc = await this._findLocator(action.zaoId);
        await loc.selectOption(action.value, { timeout: 8000 });
        return this._extractElements();
      }
      case 'setChecked': {
        const loc = await this._findLocator(action.zaoId);
        if (action.checked) await loc.check({ timeout: 8000 });
        else await loc.uncheck({ timeout: 8000 });
        return this._extractElements();
      }
      case 'submitForm': {
        const loc = await this._findLocator(action.zaoId);
        await loc.evaluate((el) => el.closest('form')?.requestSubmit?.() || el.closest('form')?.submit?.());
        await page.waitForTimeout(1200);
        return this._extractElements();
      }
      case 'scrollTo': {
        if (action.zaoId) {
          const loc = await this._findLocator(action.zaoId);
          await loc.scrollIntoViewIfNeeded({ timeout: 8000 });
        } else {
          await page.evaluate((y) => window.scrollTo(0, y || 0), action.y || 0);
        }
        return this._extractElements();
      }
      case 'waitForSelector': {
        const found = await page
          .waitForSelector(action.selector, { timeout: action.timeoutMs || 8000 })
          .then(() => true)
          .catch(() => false);
        return { waitedFor: action.selector, found, elements: await this._extractElements() };
      }
      case 'extractPageText': {
        const text = await page.evaluate(() => (document.body ? document.body.innerText : '').replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim());
        return { pageText: text.slice(0, 8000) };
      }
      case 'extractTables': {
        const tables = await page.evaluate(() => {
          return Array.from(document.querySelectorAll('table')).map((t) =>
            Array.from(t.querySelectorAll('tr'))
              .map((r) => Array.from(r.querySelectorAll('td, th')).map((c) => (c.innerText || '').trim()))
              .filter((row) => row.length)
          ).filter((rows) => rows.length);
        });
        return { tables };
      }
      case 'checkConsole': {
        const log = this.consoleLogs.get(this.activeTabId) || [];
        const entries = log.slice(-(action.limit || 50)).map((e) => ({ type: e.kind === 'console' ? e.type : e.kind, text: e.text }));
        return { consoleLog: entries, totalCaptured: log.length };
      }
      case 'newTab': {
        const newTabId = await this._newTab(action.url || 'about:blank');
        return { newTabId, elements: await this._extractElements() };
      }
      case 'switchTab':
        if (this.pages.has(action.tabId)) this.activeTabId = action.tabId;
        return this._extractElements();
      case 'closeTab': {
        const page = this.pages.get(action.tabId);
        if (page) { await page.close().catch(() => {}); this.pages.delete(action.tabId); }
        this.consoleLogs.delete(action.tabId);
        if (this.activeTabId === action.tabId) {
          this.activeTabId = this.pages.keys().next().value || null;
        }
        return { closed: action.tabId, tabs: Array.from(this.pages.keys()) };
      }
      case 'goBack':
        await page.goBack({ timeout: 15000 }).catch(() => {});
        return this._extractElements();
      case 'download': {
        const loc = await this._findLocator(action.zaoId);
        const [download] = await Promise.all([page.waitForEvent('download', { timeout: 30000 }), loc.click()]);
        const path = require('path').join(require('os').homedir(), 'Downloads', download.suggestedFilename());
        await download.saveAs(path);
        return { downloaded: path };
      }
      default:
        throw new Error(`Unknown action: ${action.action}`);
    }
  }

  /**
   * Runs one task to completion (or until finish/needsHuman/step cap).
   * @param {string} taskText
   * @param {function} sendToModel - async (history) => { success, content, error } - the caller supplies this so this file doesn't need to know about backendClient/llama-server directly (see server/index.js's wiring)
   * @param {function} onStep - optional callback({ step, action }) for live progress/action-log UI
   */
  async runTask(taskText, sendToModel, onStep = null) {
    this.isRunning = true;
    this._startStreaming();
    try {
      return await this._runTaskInner(taskText, sendToModel, onStep);
    } finally {
      this.isRunning = false;
      this._stopStreaming();
    }
  }

  async _runTaskInner(taskText, sendToModel, onStep) {
    await this._ensureContext();
    const currentPage = await this._getPageInfo();
    const initialElements = await this._extractElements();

    this.history.push({
      role: 'user',
      content: `New task: ${taskText}\n\nCurrent page: ${currentPage ? currentPage.url : 'no page loaded yet'}\nInteractive elements:\n${JSON.stringify(initialElements)}`,
      __isObservation: true,
    });

    for (let step = 0; step < MAX_STEPS_PER_TASK; step++) {
      this._trimOldPageStates();

      const modelResult = await sendToModel(this.history);
      if (!modelResult.success) {
        return { success: false, answer: null, error: modelResult.error, stepsUsed: step };
      }

      this.history.push({ role: 'assistant', content: modelResult.content });

      const action = this._parseAction(modelResult.content);
      if (!action) {
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
        this.awaitingHuman = true;
        this.humanReason = action.reason || 'This step needs your input.';
        return {
          success: false,
          answer: null,
          needsHuman: true,
          reason: this.humanReason,
          error: { type: 'NEEDS_HUMAN', message: this.humanReason },
          stepsUsed: step + 1,
        };
      }

      const beforeActionTs = Date.now();
      let observation;
      try {
        observation = await this._executeAction(action);
      } catch (err) {
        observation = { error: err?.message || String(err) };
      }

      // Auto-surface, not auto-dump: note that new console/page errors
      // happened so the model can decide to call checkConsole, without
      // flooding every single observation with the full log text.
      const newErrorCount = this._newConsoleErrorsSince(this.activeTabId, beforeActionTs);
      if (newErrorCount > 0 && observation && typeof observation === 'object') {
        observation.consoleNote = `${newErrorCount} console error(s)/failed request(s) since last step - call checkConsole for details.`;
      }

      this.history.push({ role: 'user', content: JSON.stringify(observation), __isObservation: true });
    }

    return {
      success: false,
      answer: null,
      error: { type: 'MAX_STEPS_EXCEEDED', message: `Stopped after ${MAX_STEPS_PER_TASK} steps without finishing - the task may need breaking into smaller pieces.` },
      stepsUsed: MAX_STEPS_PER_TASK,
    };
  }

  /**
   * Called when the person finishes manually driving the browser
   * (post-CAPTCHA etc.) and wants control handed back to the model. Not a
   * new task - continues the SAME task/history, picking up from whatever
   * state the person left the page in.
   */
  async resumeAfterHuman(sendToModel, onStep = null) {
    this.awaitingHuman = false;
    this.humanReason = null;
    const elements = await this._extractElements();
    const pageInfo = await this._getPageInfo();
    this.history.push({
      role: 'user',
      content: `The person has finished manual control. Current page: ${pageInfo?.url}\nInteractive elements:\n${JSON.stringify(elements)}\nContinue the task.`,
      __isObservation: true,
    });
    // Re-enter the same step loop by treating this as a continuation - a
    // thin wrapper around _runTaskInner's loop body would duplicate a lot,
    // so this just re-runs runTask's outer bookkeeping with the history
    // already primed above (taskText isn't re-pushed since the priming
    // message above already captures "continue").
    this.isRunning = true;
    this._startStreaming();
    try {
      return await this._continueLoop(sendToModel, onStep);
    } finally {
      this.isRunning = false;
      this._stopStreaming();
    }
  }

  async _continueLoop(sendToModel, onStep) {
    for (let step = 0; step < MAX_STEPS_PER_TASK; step++) {
      this._trimOldPageStates();
      const modelResult = await sendToModel(this.history);
      if (!modelResult.success) {
        return { success: false, answer: null, error: modelResult.error, stepsUsed: step };
      }
      this.history.push({ role: 'assistant', content: modelResult.content });
      const action = this._parseAction(modelResult.content);
      if (!action) {
        this.history.push({ role: 'user', content: 'Your last reply was not valid JSON. Reply with exactly one JSON action object and nothing else.', __isObservation: true });
        continue;
      }
      onStep?.({ step, action });
      if (action.action === 'finish') {
        return { success: true, answer: action.answer || '', error: null, stepsUsed: step + 1 };
      }
      if (action.action === 'needsHuman') {
        this.awaitingHuman = true;
        this.humanReason = action.reason || 'This step needs your input.';
        return { success: false, answer: null, needsHuman: true, reason: this.humanReason, error: { type: 'NEEDS_HUMAN', message: this.humanReason }, stepsUsed: step + 1 };
      }
      let observation;
      try {
        observation = await this._executeAction(action);
      } catch (err) {
        observation = { error: err?.message || String(err) };
      }
      this.history.push({ role: 'user', content: JSON.stringify(observation), __isObservation: true });
    }
    return { success: false, answer: null, error: { type: 'MAX_STEPS_EXCEEDED', message: `Stopped after ${MAX_STEPS_PER_TASK} steps without finishing.` }, stepsUsed: MAX_STEPS_PER_TASK };
  }

  /** Manual tap, sent from the phone's live view while awaitingHuman (or any time - useful for nudging a stuck page too). Coordinates are relative to the streamed viewport (412x915). */
  async manualClick(x, y) {
    const page = this._activePage();
    if (!page) return;
    await page.mouse.click(x, y).catch(() => {});
  }

  /** Manual text input, sent from the phone's live view. Types into whatever element currently has focus (the person should tap the field first via manualClick). */
  async manualType(text) {
    const page = this._activePage();
    if (!page) return;
    await page.keyboard.type(text, { delay: 20 }).catch(() => {});
  }

  /** Manual key press (Enter, Tab, Backspace, etc.) from the phone's live view. */
  async manualKey(key) {
    const page = this._activePage();
    if (!page) return;
    await page.keyboard.press(key).catch(() => {});
  }

  /** Stops the current task early (person hit Cancel). Doesn't tear down the session/browser - a follow-up task can still reuse it. */
  cancel() {
    this._stopStreaming();
    this.isRunning = false;
  }

  /**
   * ADDRESS BAR + TABS (phone UI): these four methods are the direct,
   * person-driven equivalent of the model's own newTab/switchTab/
   * closeTab/navigate actions above - same underlying tab map, just
   * triggered by a tap on the phone instead of a model decision. Safe to
   * call whether or not a task is currently running (e.g. opening a new
   * tab mid-task), matching manualClick/manualType's existing "always
   * available, not just during awaitingHuman" behavior.
   */

  /** Every open tab's id + current url/title, active one flagged - what BrowserAgentScreen's tab strip renders. */
  async getTabsInfo() {
    const tabs = [];
    for (const [tabId, page] of this.pages.entries()) {
      tabs.push({
        tabId,
        url: page.url(),
        title: await page.title().catch(() => ''),
        active: tabId === this.activeTabId,
      });
    }
    return tabs;
  }

  /** Direct navigation from the address bar - normalizes a bare "example.com" into a full URL the same way a real browser's address bar does. */
  async navigateActiveTab(rawUrl) {
    await this._ensureContext();
    const page = this._activePage();
    if (!page || !rawUrl) return;
    const url = /^[a-z][a-z0-9+.-]*:\/\//i.test(rawUrl) ? rawUrl : `https://${rawUrl}`;
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
  }

  /** Tapping a tab in the strip. */
  async switchToTab(tabId) {
    if (this.pages.has(tabId)) this.activeTabId = tabId;
  }

  /** The "+" new-tab button. */
  async openNewTab(url) {
    await this._ensureContext();
    return this._newTab(url || 'about:blank');
  }

  /** The "x" on a tab in the strip. */
  async closeTabById(tabId) {
    const page = this.pages.get(tabId);
    if (page) await page.close().catch(() => {});
    this.pages.delete(tabId);
    this.consoleLogs.delete(tabId);
    if (this.activeTabId === tabId) {
      this.activeTabId = this.pages.keys().next().value || null;
    }
  }

  async destroy() {
    this._stopStreaming();
    for (const page of this.pages.values()) {
      await page.close().catch(() => {});
    }
    if (this.context) await this.context.close().catch(() => {});
    this.pages.clear();
    this.consoleLogs.clear();
    this.context = null;
  }
}

async function shutdownBrowser() {
  if (browserInstance) {
    await browserInstance.close().catch(() => {});
    browserInstance = null;
  }
}

module.exports = { AgentSession, shutdownBrowser, getBrowser };
