/**
 * ZAO - Browser Agent View
 *
 * Wraps one or more react-native-webview instances behind a single
 * imperative ref API, so the agent loop (and the visible browser screen)
 * can drive real on-device browsing without either of them needing to know
 * WebView's own quirky imperative API or how multi-tab state is kept.
 *
 * Multi-tab model: every open tab is a real, separately-mounted <WebView>.
 * Only the active tab is rendered visibly (others sit with
 * position:absolute + opacity:0 + pointerEvents:'none') rather than being
 * unmounted - unmounting would drop that tab's cookies/session/JS state,
 * defeating the point of "work across several tabs simultaneously." This
 * does mean N tabs = N live WebViews in memory, so callers should close
 * tabs they're done with rather than accumulating them indefinitely.
 *
 * This file deliberately knows NOTHING about Qwen, task planning, or the
 * chat UI - it's a pure browser-automation primitive. agentLoop.js (Stage
 * 2) is the layer that decides *what* to click/fill/read; this is just the
 * *how*.
 */

import React, { forwardRef, useImperativeHandle, useRef, useState, useCallback } from 'react';
import { View, StyleSheet } from 'react-native';
import { WebView } from 'react-native-webview';
import { getBridgeBootstrapScript, buildBridgeCommand } from './domBridge';

// Bridge commands should normally resolve in well under a second (they're
// synchronous DOM queries in almost every case). This ceiling exists only
// to stop a hung/hostile page from leaving the agent loop waiting forever
// on a single step.
const BRIDGE_COMMAND_TIMEOUT_MS = 15_000;

let tabIdCounter = 0;
function makeTabId() {
  tabIdCounter += 1;
  return `tab_${Date.now()}_${tabIdCounter}`;
}

const BrowserAgentView = forwardRef(function BrowserAgentView(props, ref) {
  const {
    initialUrl = 'https://www.google.com',
    onNavigationStateChange = () => {},
    onFileDownload = () => {},
    // Zoom percent applied to every tab in THIS BrowserAgentView instance.
    // Callers that want independent zoom for PiP vs full-screen (they
    // share one WebView, so "different concentration" between the two
    // display modes has to be applied as an active command, not baked
    // into the initial page load) should call the imperative setZoom()
    // below instead of relying on this prop after mount - this prop only
    // sets the zoom NEW tabs start at.
    initialZoomPercent = 100,
  } = props;

  const [tabs, setTabs] = useState(() => [{ id: makeTabId(), url: initialUrl }]);
  const [activeTabId, setActiveTabId] = useState(() => tabs[0].id);

  // Tracks each tab's last-applied zoom so a fresh page load (which resets
  // the injected viewport meta back to 100%) can be re-zoomed to whatever
  // was last set for that tab, and so switching tabs doesn't lose a
  // per-tab zoom choice.
  const zoomByTab = useRef({ [tabs[0].id]: initialZoomPercent });

  // webviewRefs and pendingBridgeCalls are keyed by tabId so commands are
  // always routed to the right tab's underlying native WebView, even when
  // it isn't the currently-visible one (e.g. "read the price on tab 2
  // while tab 1 stays open").
  const webviewRefs = useRef({}); // tabId -> WebView ref
  const pendingBridgeCalls = useRef({}); // bridgeId -> { resolve, reject, timeoutHandle }
  const bridgeCallCounter = useRef(0);

  const getActiveWebviewRef = useCallback(() => webviewRefs.current[activeTabId], [activeTabId]);

  /**
   * Sends one command to a tab's DOM bridge and returns a Promise for its
   * result. This is the single choke point every higher-level action
   * (navigate/click/fill/extract/etc.) in the imperative API below runs
   * through, so timeout + error handling only needs to live in one place.
   */
  const runBridgeCommand = useCallback((tabId, commandName, args) => {
    return new Promise((resolve, reject) => {
      const webviewRef = webviewRefs.current[tabId];
      if (!webviewRef || !webviewRef.current) {
        reject(new Error(`No active WebView for tab ${tabId}`));
        return;
      }

      bridgeCallCounter.current += 1;
      const bridgeId = `bc_${bridgeCallCounter.current}`;

      const timeoutHandle = setTimeout(() => {
        delete pendingBridgeCalls.current[bridgeId];
        reject(new Error(`Bridge command "${commandName}" timed out`));
      }, BRIDGE_COMMAND_TIMEOUT_MS);

      pendingBridgeCalls.current[bridgeId] = { resolve, reject, timeoutHandle };

      webviewRef.current.injectJavaScript(buildBridgeCommand(bridgeId, commandName, args));
    });
  }, []);

  /**
   * Handles every postMessage coming out of any tab's page context -
   * either a bridge command result/error (resolves the matching pending
   * promise) or the one-time 'ready' ping the bootstrap script sends after
   * it installs itself on a fresh page load.
   */
  const handleMessage = useCallback((tabId, event) => {
    let parsed;
    try {
      parsed = JSON.parse(event.nativeEvent.data);
    } catch (err) {
      return; // Not one of ours - some pages postMessage their own stuff.
    }

    const { bridgeId, type, payload } = parsed;
    if (bridgeId === '__init__') {
      return; // Bridge-ready ping - nothing to resolve, just informational.
    }

    const pending = pendingBridgeCalls.current[bridgeId];
    if (!pending) {
      return; // Already timed out, or a stray/duplicate message - drop it.
    }

    clearTimeout(pending.timeoutHandle);
    delete pendingBridgeCalls.current[bridgeId];

    if (type === 'error') {
      pending.reject(new Error(payload));
    } else {
      pending.resolve(payload);
    }
  }, []);

  useImperativeHandle(ref, () => ({
    // --- Navigation -------------------------------------------------------
    navigate(url, tabId = activeTabId) {
      const normalizedUrl = /^https?:\/\//i.test(url) ? url : `https://${url}`;
      setTabs((prev) => prev.map((t) => (t.id === tabId ? { ...t, url: normalizedUrl } : t)));
    },
    goBack(tabId = activeTabId) {
      webviewRefs.current[tabId]?.current?.goBack();
    },
    goForward(tabId = activeTabId) {
      webviewRefs.current[tabId]?.current?.goForward();
    },
    reload(tabId = activeTabId) {
      webviewRefs.current[tabId]?.current?.reload();
    },
    stopLoading(tabId = activeTabId) {
      webviewRefs.current[tabId]?.current?.stopLoading();
    },

    // --- Tabs ---------------------------------------------------------------
    newTab(url = 'about:blank') {
      const id = makeTabId();
      zoomByTab.current[id] = initialZoomPercent;
      setTabs((prev) => [...prev, { id, url }]);
      setActiveTabId(id);
      return id;
    },
    closeTab(tabId) {
      delete webviewRefs.current[tabId];
      delete zoomByTab.current[tabId];
      setTabs((prev) => {
        const next = prev.filter((t) => t.id !== tabId);
        if (activeTabId === tabId && next.length > 0) {
          setActiveTabId(next[next.length - 1].id);
        }
        return next;
      });
    },
    switchTab(tabId) {
      setActiveTabId(tabId);
    },
    listTabs() {
      return tabs.map((t) => ({ id: t.id, url: t.url, active: t.id === activeTabId }));
    },
    getActiveTabId() {
      return activeTabId;
    },

    // --- DOM reading/interaction (delegates to the bridge) ------------------
    extractInteractiveElements(tabId = activeTabId) {
      return runBridgeCommand(tabId, 'extractInteractiveElements', {});
    },
    extractPageText(maxChars, tabId = activeTabId) {
      return runBridgeCommand(tabId, 'extractPageText', { maxChars });
    },
    extractTables(tabId = activeTabId) {
      return runBridgeCommand(tabId, 'extractTables', {});
    },
    getPageInfo(tabId = activeTabId) {
      return runBridgeCommand(tabId, 'getPageInfo', {});
    },
    click(zaoId, tabId = activeTabId) {
      return runBridgeCommand(tabId, 'click', { zaoId });
    },
    fill(zaoId, text, tabId = activeTabId) {
      return runBridgeCommand(tabId, 'fill', { zaoId, text });
    },
    selectOption(zaoId, value, tabId = activeTabId) {
      return runBridgeCommand(tabId, 'selectOption', { zaoId, value });
    },
    setChecked(zaoId, checked, tabId = activeTabId) {
      return runBridgeCommand(tabId, 'setChecked', { zaoId, checked });
    },
    submitForm(zaoId, tabId = activeTabId) {
      return runBridgeCommand(tabId, 'submitForm', { zaoId });
    },
    scrollTo(args, tabId = activeTabId) {
      return runBridgeCommand(tabId, 'scrollTo', args);
    },
    waitForSelector(selector, timeoutMs, tabId = activeTabId) {
      return runBridgeCommand(tabId, 'waitForSelector', { selector, timeoutMs });
    },
    runScript(script, tabId = activeTabId) {
      return runBridgeCommand(tabId, 'runScript', { script });
    },

    // --- Zoom -----------------------------------------------------------
    // percent: whole number like 35 (very zoomed out, good for an
    // overview) or 100 (normal). Applies immediately to the given tab (or
    // active tab) and is remembered so the NEXT page load in that tab
    // re-applies it automatically, rather than snapping back to 100% the
    // moment the agent navigates somewhere new.
    setZoom(percent, tabId = activeTabId) {
      zoomByTab.current[tabId] = percent;
      return runBridgeCommand(tabId, 'setZoom', { percent });
    },
    getZoom(tabId = activeTabId) {
      return zoomByTab.current[tabId] || 100;
    },
  }), [activeTabId, tabs, runBridgeCommand]);

  return (
    <View style={styles.container}>
      {tabs.map((tab) => {
        if (!webviewRefs.current[tab.id]) {
          webviewRefs.current[tab.id] = React.createRef();
        }
        const isActive = tab.id === activeTabId;
        return (
          <View
            key={tab.id}
            style={isActive ? styles.activeLayer : styles.hiddenLayer}
            pointerEvents={isActive ? 'auto' : 'none'}
          >
            <WebView
              ref={webviewRefs.current[tab.id]}
              source={{ uri: tab.url }}
              injectedJavaScriptBeforeContentLoaded={getBridgeBootstrapScript()}
              // Fixes "zoomed in from the start, can't see the other side"
              // in the small PiP view: without these, Android's WebView
              // renders the page at its natural desktop-class width (from
              // the desktop UA below) and only crops to the container size
              // rather than scaling the whole page down to fit it.
              // scalesPageToFit + a small initial injected viewport meta
              // makes the full page width visible immediately, both in
              // the small PiP and the full-screen view - same WebView
              // instance either way, so this doesn't need separate
              // handling for each display mode.
              scalesPageToFit
              injectedJavaScript={`
                (function() {
                  var meta = document.querySelector('meta[name="viewport"]');
                  if (!meta) {
                    meta = document.createElement('meta');
                    meta.name = 'viewport';
                    document.head.appendChild(meta);
                  }
                  var scale = ${(zoomByTab.current[tab.id] || initialZoomPercent) / 100};
                  meta.content = 'width=device-width, initial-scale=' + scale + ', maximum-scale=3, user-scalable=yes';
                })();
                true;
              `}
              onMessage={(event) => handleMessage(tab.id, event)}
              onLoadEnd={() => {
                // Re-applies this tab's remembered zoom after every full
                // page load. The viewport meta injected above via
                // injectedJavaScript only runs once per WebView mount, not
                // on every subsequent in-tab navigation (clicking a link,
                // the agent calling navigate()) - without this, a tab
                // zoomed out for an overview would snap back to 100% the
                // instant it moved to a new page.
                const zoom = zoomByTab.current[tab.id];
                if (zoom && zoom !== 100) {
                  runBridgeCommand(tab.id, 'setZoom', { percent: zoom }).catch(() => {});
                }
              }}
              onNavigationStateChange={(navState) => {
                setTabs((prev) => prev.map((t) => (t.id === tab.id ? { ...t, url: navState.url } : t)));
                if (isActive) {
                  onNavigationStateChange(navState);
                }
              }}
              onFileDownload={({ nativeEvent }) => onFileDownload(nativeEvent, tab.id)}
              // Real desktop-class UA rather than the default Android
              // WebView UA - many sites (including most login/dashboard
              // flows the agent needs) serve a stripped-down mobile
              // experience or outright reject unrecognized mobile UAs,
              // and Site A/B behavior needs to match what a human tester
              // would actually see for tasks like "verify buttons work."
              userAgent="Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
              javaScriptEnabled
              domStorageEnabled
              sharedCookiesEnabled
              thirdPartyCookiesEnabled
              startInLoadingState
              setSupportMultipleWindows={false}
              // Downloads: Android's native download flow via the system
              // DownloadManager - onFileDownload above fires with the URL
              // so the app can track completion (Stage 3 covers actually
              // wiring this to expo-file-system).
              allowFileAccess
              allowsBackForwardNavigationGestures
            />
          </View>
        );
      })}
    </View>
  );
});

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  activeLayer: {
    flex: 1,
  },
  hiddenLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    opacity: 0,
  },
});

export default BrowserAgentView;
