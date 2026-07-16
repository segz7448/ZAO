/**
 * ZAO - Browser Agent DOM Bridge
 *
 * This is JavaScript that runs INSIDE the page loaded in the WebView (via
 * injectedJavaScript / injectJavaScript), not inside React Native. It has
 * no access to anything in this app except what it sends back over
 * `window.ReactNativeWebView.postMessage`.
 *
 * Everything here is deliberately small and dependency-free - it has to
 * survive being stringified and injected into arbitrary third-party pages,
 * so it can't import anything and must tolerate hostile/broken pages
 * (missing APIs, CSP, weird shadow DOMs, etc.) without throwing and
 * breaking the page it's injected into.
 *
 * Message shape sent back to RN (always JSON-stringified):
 *   { bridgeId: string, type: string, payload: any }
 *
 * bridgeId lets BrowserAgentView.js match an async response to the request
 * that triggered it (see the request/response pattern in runBridgeCommand
 * below), since injectJavaScript() is fire-and-forget from RN's side - the
 * only way back is postMessage.
 */

/**
 * The full bootstrap script, returned as a string ready for
 * WebView's `injectedJavaScriptBeforeContentLoaded` prop. Runs once, early,
 * before the page's own scripts - defines `window.__zaoBridge` with all the
 * primitives, then individual commands are dispatched into it later via
 * injectJavaScript() calls that look like: window.__zaoBridge.run(id, cmd, args)
 */
export function getBridgeBootstrapScript() {
  return `
(function () {
  if (window.__zaoBridge) { return true; }

  function post(bridgeId, type, payload) {
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({ bridgeId, type, payload }));
    } catch (e) {
      // postMessage itself failing means we can't report the error either -
      // nothing further to do.
    }
  }

  // Returns a short, LLM-friendly description of visible interactive
  // elements on the page: links, buttons, inputs, selects, textareas, and
  // anything with role=button/link. Deliberately NOT a full DOM/HTML dump -
  // that would blow past any reasonable token budget on real-world pages
  // and bury the handful of elements that actually matter. Each element
  // gets a stable-for-this-load '__zaoId' data attribute so a later command
  // can target it precisely instead of re-matching by text.
  function extractInteractiveElements() {
    var selector = 'a, button, input, select, textarea, [role="button"], [role="link"], [role="checkbox"], [role="textbox"], [contenteditable="true"]';
    var nodes = document.querySelectorAll(selector);
    var out = [];
    var counter = 0;

    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      var rect = el.getBoundingClientRect();
      // Skip elements with no visible box (display:none, zero-size, or
      // detached) - they can't be meaningfully interacted with and only add
      // noise the agent would otherwise have to reason around.
      if (rect.width === 0 || rect.height === 0) { continue; }
      var style = window.getComputedStyle(el);
      if (style.visibility === 'hidden' || style.display === 'none') { continue; }

      var zaoId = 'z' + (counter++);
      el.setAttribute('data-zao-id', zaoId);

      var tag = el.tagName.toLowerCase();
      var text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim().slice(0, 120);

      var entry = { id: zaoId, tag: tag, text: text };
      if (tag === 'input') {
        entry.inputType = el.getAttribute('type') || 'text';
        entry.value = (el.value || '').slice(0, 200);
      }
      if (tag === 'select') {
        var opts = [];
        for (var o = 0; o < el.options.length; o++) {
          opts.push(el.options[o].text);
        }
        entry.options = opts;
        entry.value = el.value;
      }
      if (tag === 'a') {
        entry.href = el.getAttribute('href') || '';
      }
      out.push(entry);
    }
    return out;
  }

  // Extracts readable body text, collapsed and truncated - used for the
  // "read this page" / summarization case where the agent needs prose
  // content rather than a list of controls.
  function extractPageText(maxChars) {
    var text = document.body ? document.body.innerText : '';
    text = text.replace(/[ \\t]+/g, ' ').replace(/\\n{3,}/g, '\\n\\n').trim();
    return text.slice(0, maxChars || 8000);
  }

  // Extracts every <table> on the page as arrays of row-cell-text arrays -
  // covers "read this table" / price-comparison / spec-sheet tasks without
  // needing the agent to parse raw HTML.
  function extractTables() {
    var tables = document.querySelectorAll('table');
    var out = [];
    for (var t = 0; t < tables.length; t++) {
      var rows = tables[t].querySelectorAll('tr');
      var rowsOut = [];
      for (var r = 0; r < rows.length; r++) {
        var cells = rows[r].querySelectorAll('td, th');
        var cellsOut = [];
        for (var c = 0; c < cells.length; c++) {
          cellsOut.push((cells[c].innerText || '').trim());
        }
        if (cellsOut.length) { rowsOut.push(cellsOut); }
      }
      if (rowsOut.length) { out.push(rowsOut); }
    }
    return out;
  }

  function findByZaoId(zaoId) {
    return document.querySelector('[data-zao-id="' + zaoId + '"]');
  }

  // Dispatches real mouse events rather than calling .click() directly -
  // some sites (React/Vue SPAs especially) attach listeners that only fire
  // on genuine pointer events, not the synthetic click .click() produces.
  function simulateClick(el) {
    var rect = el.getBoundingClientRect();
    var x = rect.left + rect.width / 2;
    var y = rect.top + rect.height / 2;
    ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click'].forEach(function (type) {
      var ev;
      try {
        ev = new MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, view: window });
      } catch (e) {
        ev = document.createEvent('MouseEvent');
        ev.initMouseEvent(type, true, true, window, 1, 0, 0, x, y, false, false, false, false, 0, null);
      }
      el.dispatchEvent(ev);
    });
  }

  // Sets an input/textarea's value the way a real keystroke would - plain
  // assignment to .value does NOT notify React/Vue's controlled-component
  // state, so this uses the native value setter + dispatches 'input' and
  // 'change' so frameworks pick up the change.
  function simulateFill(el, text) {
    var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    var setter = Object.getOwnPropertyDescriptor(proto, 'value') && Object.getOwnPropertyDescriptor(proto, 'value').set;
    if (setter) {
      setter.call(el, text);
    } else {
      el.value = text;
    }
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  }

  function waitForSelector(selector, timeoutMs) {
    return new Promise(function (resolve) {
      var start = Date.now();
      (function poll() {
        var el = document.querySelector(selector);
        if (el) { resolve(true); return; }
        if (Date.now() - start > timeoutMs) { resolve(false); return; }
        setTimeout(poll, 200);
      })();
    });
  }

  // Command dispatch table. Every command returns a plain value (or a
  // Promise resolving to one) - run() below wraps it in the postMessage
  // envelope and catches thrown errors so a single bad command can't crash
  // the bridge for the rest of the session.
  var commands = {
    extractInteractiveElements: function () { return extractInteractiveElements(); },
    extractPageText: function (args) { return extractPageText(args && args.maxChars); },
    extractTables: function () { return extractTables(); },
    getPageInfo: function () {
      return { url: window.location.href, title: document.title, readyState: document.readyState };
    },
    click: function (args) {
      var el = findByZaoId(args.zaoId);
      if (!el) { throw new Error('Element not found: ' + args.zaoId); }
      simulateClick(el);
      return true;
    },
    fill: function (args) {
      var el = findByZaoId(args.zaoId);
      if (!el) { throw new Error('Element not found: ' + args.zaoId); }
      simulateFill(el, args.text || '');
      return true;
    },
    selectOption: function (args) {
      var el = findByZaoId(args.zaoId);
      if (!el) { throw new Error('Element not found: ' + args.zaoId); }
      el.value = args.value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    setChecked: function (args) {
      var el = findByZaoId(args.zaoId);
      if (!el) { throw new Error('Element not found: ' + args.zaoId); }
      el.checked = !!args.checked;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    },
    submitForm: function (args) {
      var el = findByZaoId(args.zaoId);
      var form = el ? el.closest('form') : null;
      if (!form) { throw new Error('No form found for: ' + args.zaoId); }
      if (typeof form.requestSubmit === 'function') {
        form.requestSubmit();
      } else {
        form.submit();
      }
      return true;
    },
    scrollTo: function (args) {
      var el = args.zaoId ? findByZaoId(args.zaoId) : null;
      if (el) {
        el.scrollIntoView({ block: 'center' });
      } else {
        window.scrollTo(0, args.y || 0);
      }
      return true;
    },
    waitForSelector: function (args) {
      return waitForSelector(args.selector, args.timeoutMs || 8000);
    },
    // Sets the page's zoom via the viewport meta's initial-scale, the only
    // zoom mechanism that plays nicely with Android WebView's own touch/
    // layout handling (a CSS transform: scale() on <html>/<body> instead
    // desyncs tap coordinates from what's visually rendered, breaking
    // click()/fill() for anything off the top-left corner). percent is a
    // whole number like 35 or 100 - 35 means "shrink the page to 35% so
    // more of it is visible at once," matching how a person would describe
    // it ("zoom out to 35%"), not the raw CSS scale factor (0.35).
    setZoom: function (args) {
      var percent = args && typeof args.percent === 'number' ? args.percent : 100;
      var scale = Math.max(0.1, Math.min(3, percent / 100));
      var meta = document.querySelector('meta[name="viewport"]');
      if (!meta) {
        meta = document.createElement('meta');
        meta.name = 'viewport';
        document.head.appendChild(meta);
      }
      meta.content = 'width=device-width, initial-scale=' + scale + ', maximum-scale=3, user-scalable=yes';
      return { appliedPercent: Math.round(scale * 100) };
    },
    runScript: function (args) {
      // Deliberately the most powerful and most dangerous command - lets
      // the agent run arbitrary JS in the page for edge cases the fixed
      // command set above doesn't cover. new Function (not eval) so it
      // runs in a fresh scope without direct closure access to this
      // bridge's internals.
      var fn = new Function(args.script);
      return fn();
    },
  };

  window.__zaoBridge = {
    run: function (bridgeId, commandName, args) {
      var fn = commands[commandName];
      if (!fn) {
        post(bridgeId, 'error', 'Unknown bridge command: ' + commandName);
        return;
      }
      try {
        var result = fn(args || {});
        if (result && typeof result.then === 'function') {
          result.then(function (value) {
            post(bridgeId, 'result', value);
          }).catch(function (err) {
            post(bridgeId, 'error', String(err && err.message ? err.message : err));
          });
        } else {
          post(bridgeId, 'result', result);
        }
      } catch (err) {
        post(bridgeId, 'error', String(err && err.message ? err.message : err));
      }
    },
  };

  // Fires once so BrowserAgentView.js knows the bridge is alive and it's
  // safe to start sending run() commands (rather than racing page load).
  post('__init__', 'ready', { url: window.location.href });

  true; // WebView injectedJavaScript* requires the script to return a value
})();
`;
}

/**
 * Builds the small injectJavaScript() snippet that invokes one bridge
 * command with a given bridgeId + args. BrowserAgentView.js calls this
 * every time it needs to run a command against the currently-loaded page.
 */
export function buildBridgeCommand(bridgeId, commandName, args) {
  const safeArgs = JSON.stringify(args || {});
  const safeId = JSON.stringify(bridgeId);
  const safeCmd = JSON.stringify(commandName);
  return `
(function () {
  if (window.__zaoBridge) {
    window.__zaoBridge.run(${safeId}, ${safeCmd}, ${safeArgs});
  } else {
    // Bridge not ready yet (bootstrap script hasn't run on this page yet,
    // e.g. straight after a navigation) - report back immediately instead
    // of silently doing nothing, so the caller's pending promise doesn't
    // hang until timeout.
    try {
      window.ReactNativeWebView.postMessage(JSON.stringify({ bridgeId: ${safeId}, type: 'error', payload: 'Bridge not ready' }));
    } catch (e) {}
  }
  true;
})();
`;
}
