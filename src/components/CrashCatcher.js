/**
 * ZAO - Diagnostic Crash Catcher (temporary)
 *
 * Purpose: in a release build, an uncaught JS error normally force-closes
 * the app with no visible message at all - which is indistinguishable
 * from a native crash when you have no adb/logcat access. This wrapper
 * installs a global error handler BEFORE App (and everything App
 * imports) is loaded, and requires App inside a try/catch, so both
 * "crashed during module load" and "crashed at runtime" errors get
 * caught and shown as readable text on screen instead of closing the
 * app. Screenshot whatever shows up here - that's the real bug.
 *
 * This is meant to be temporary scaffolding for tracking down the
 * current crash, not a permanent part of the app.
 */

import React, { useEffect, useState } from 'react';
import { ScrollView, Text, StyleSheet, TouchableOpacity } from 'react-native';

let lastError = null;
let listeners = [];

function reportError(err) {
  lastError = err;
  listeners.forEach((listener) => listener());
}

// Installed at import time (before `require('../../App')` below runs),
// so this covers errors thrown while App's own module tree is being
// evaluated, not just errors thrown later during render.
const originalHandler = global.ErrorUtils?.getGlobalHandler?.();
if (global.ErrorUtils?.setGlobalHandler) {
  global.ErrorUtils.setGlobalHandler((error, isFatal) => {
    reportError({
      message: (error && error.message) || String(error),
      stack: (error && error.stack) || '(no stack available)',
      isFatal,
    });
    // Deliberately swallow fatal errors instead of forwarding them to
    // the original handler, which would terminate the app - we want
    // the error screen below to actually stay on screen so it can be
    // read/screenshotted. Non-fatal errors still get logged normally.
    if (!isFatal && originalHandler) originalHandler(error, isFatal);
  });
}

// Hermes-specific unhandled promise rejection tracking - a rejected
// promise with no .catch() doesn't go through ErrorUtils otherwise.
if (global.HermesInternal?.enablePromiseRejectionTracker) {
  global.HermesInternal.enablePromiseRejectionTracker({
    allRejections: true,
    onUnhandled: (id, error) => {
      reportError({
        message: (error && error.message) || String(error),
        stack: (error && error.stack) || '(no stack available)',
        isFatal: false,
        isPromiseRejection: true,
      });
    },
  });
}

let App = null;
let loadError = null;
try {
  // require (not a static import) so a throw during App.js's own
  // module evaluation - or anything it imports - lands in this catch
  // block instead of crashing before this component ever renders.
  App = require('../../App').default;
} catch (e) {
  loadError = { message: e?.message || String(e), stack: e?.stack || '(no stack available)' };
}

export default function CrashCatcher() {
  const [, forceUpdate] = useState(0);

  useEffect(() => {
    const listener = () => forceUpdate((n) => n + 1);
    listeners.push(listener);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  }, []);

  const shown = loadError || lastError;

  if (shown) {
    return (
      <ScrollView style={styles.container} contentContainerStyle={styles.content}>
        <Text style={styles.title}>
          {shown.isPromiseRejection ? 'Unhandled promise rejection' : 'ZAO crashed - here is why'}
        </Text>
        <Text style={styles.message}>{shown.message}</Text>
        <Text style={styles.stack}>{shown.stack}</Text>
        <TouchableOpacity
          style={styles.button}
          onPress={() => {
            lastError = null;
            forceUpdate((n) => n + 1);
          }}
        >
          <Text style={styles.buttonText}>Dismiss and retry</Text>
        </TouchableOpacity>
      </ScrollView>
    );
  }

  if (!App) {
    return null;
  }

  return <App />;
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#FEFCF8' },
  content: { padding: 20, paddingTop: 60 },
  title: { fontSize: 18, fontWeight: '700', color: '#1F2937', marginBottom: 12 },
  message: { fontSize: 14, color: '#B91C1C', marginBottom: 12, fontWeight: '600' },
  stack: { fontSize: 11, color: '#374151', fontFamily: 'monospace' },
  button: {
    marginTop: 20,
    backgroundColor: '#1F2937',
    paddingVertical: 12,
    paddingHorizontal: 18,
    borderRadius: 8,
    alignSelf: 'flex-start',
  },
  buttonText: { color: '#FFFFFF', fontWeight: '700' },
});
