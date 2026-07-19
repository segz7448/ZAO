/**
 * ZAO - Browser Agent Screen
 *
 * Full-screen view of the PC's live Playwright browser agent (see
 * server/browserAgent.js, server/browserStream.js,
 * src/services/browserAgent/browserAgentStream.js). Replaces the old
 * address-bar-and-tab-strip chrome around an on-device WebView - that
 * whole interaction model doesn't map onto Playwright, since navigation
 * is either autonomous (the model decides where to go) or manual-via-tap
 * on the live stream (CAPTCHA handoff etc.), never "type a URL and hit
 * go" as the primary way of driving it.
 *
 * This screen is chrome ONLY, same as the version it replaces - the
 * actual live view (BrowserAgentPiP in fullScreen mode) is a persistent
 * sibling rendered once in App.js, so collapsing back to the small PiP
 * and expanding to this full screen never loses the PC-side session's
 * state.
 */

import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/useTheme';

export default function BrowserAgentScreen({ stream, isAgentRunning = false, awaitingHuman = false, onClose }) {
  const theme = useTheme();
  const [taskText, setTaskText] = useState('');

  const handleSendTask = () => {
    if (!taskText.trim() || !stream) return;
    stream.runTask(taskText.trim());
    setTaskText('');
  };

  const handleCancel = () => {
    stream?.cancel();
  };

  return (
    <View style={styles.chromeStack} pointerEvents="box-none">
      <View style={[styles.statusStrip, { backgroundColor: theme.surfaceAlt, borderBottomColor: theme.border }]}>
        <View style={[styles.statusDot, isAgentRunning && styles.statusDotActive, awaitingHuman && styles.statusDotWaiting]} />
        <Text style={[styles.statusText, { color: theme.textSecondary }]} numberOfLines={1}>
          {awaitingHuman
            ? 'Needs your input - see below'
            : isAgentRunning
            ? 'ZAO is browsing on your PC…'
            : 'PC browser agent - idle'}
        </Text>
        {isAgentRunning && (
          <TouchableOpacity onPress={handleCancel} hitSlop={8} style={styles.cancelBtn}>
            <Text style={[styles.cancelBtnText, { color: theme.textSecondary }]}>Stop</Text>
          </TouchableOpacity>
        )}
        <TouchableOpacity onPress={onClose} hitSlop={8}>
          <Ionicons name="close" size={22} color={theme.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* No live view rendered here - the persistent BrowserAgentPiP
          (fullScreen mode, rendered as a sibling underneath in App.js)
          shows through the transparent space below this chrome, same
          layering pattern as the version this replaces. The task input
          below floats on top of it. */}

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={styles.taskBarWrap}
        pointerEvents="box-none"
      >
        <View style={[styles.taskBar, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
          {isAgentRunning ? (
            <View style={styles.runningRow}>
              <ActivityIndicator size="small" color={theme.textSecondary} />
              <Text style={[styles.runningText, { color: theme.textSecondary }]}>Working on it…</Text>
            </View>
          ) : (
            <>
              <TextInput
                style={[styles.taskInput, { color: theme.textPrimary, backgroundColor: theme.surfaceAlt }]}
                value={taskText}
                onChangeText={setTaskText}
                onSubmitEditing={handleSendTask}
                placeholder="Tell it what to do, e.g. 'open github.com and search llama.cpp android'"
                placeholderTextColor={theme.textTertiary}
                returnKeyType="go"
              />
              <TouchableOpacity onPress={handleSendTask} hitSlop={8} style={styles.sendBtn}>
                <Ionicons name="arrow-up-circle" size={30} color={theme.info} />
              </TouchableOpacity>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}

const styles = StyleSheet.create({
  chromeStack: {
    flex: 1,
    justifyContent: 'space-between',
  },
  statusStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#9CA3AF',
  },
  statusDotActive: {
    backgroundColor: '#F59E0B',
  },
  statusDotWaiting: {
    backgroundColor: '#EF4444',
  },
  statusText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '500',
  },
  cancelBtn: {
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  cancelBtnText: {
    fontSize: 12,
    fontWeight: '600',
  },
  taskBarWrap: {
    justifyContent: 'flex-end',
  },
  taskBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  taskInput: {
    flex: 1,
    fontSize: 14,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  sendBtn: {
    padding: 2,
  },
  runningRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 4,
  },
  runningText: {
    fontSize: 13,
    fontWeight: '500',
  },
});
