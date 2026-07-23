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
 *
 * TOP FRAME: deliberately its own safe-area-padded, elevated card
 * (rounded bottom corners, shadow, a solid surface) rather than a thin
 * strip flush against the status bar/notch - the close button in
 * particular needed real breathing room above and around it rather than
 * sitting right at the very top edge. Only this chrome is safe-area
 * padded; the live view underneath (BrowserAgentPiP in fullScreen mode)
 * still extends full-bleed under the notch, same as before - this is a
 * card floating on top of it, not a container clipping it.
 */

import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/useTheme';

const ZOOM_STEP = 0.25;
const ZOOM_MIN = 0.25;
const ZOOM_MAX = 1;

export default function BrowserAgentScreen({ stream, isAgentRunning = false, awaitingHuman = false, zoom = 0.5, onZoomChange, onClose }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [taskText, setTaskText] = useState('');

  const handleSendTask = () => {
    if (!taskText.trim() || !stream) return;
    stream.runTask(taskText.trim());
    setTaskText('');
  };

  const handleCancel = () => {
    stream?.cancel();
  };

  const handleZoomOut = () => onZoomChange?.(Math.max(ZOOM_MIN, Math.round((zoom - ZOOM_STEP) * 100) / 100));
  const handleZoomIn = () => onZoomChange?.(Math.min(ZOOM_MAX, Math.round((zoom + ZOOM_STEP) * 100) / 100));

  return (
    <View style={styles.chromeStack} pointerEvents="box-none">
      <View
        style={[
          styles.topFrame,
          { backgroundColor: theme.surfaceAlt, borderBottomColor: theme.border, paddingTop: insets.top + 14 },
        ]}
      >
        <View style={styles.topFrameRow}>
          <View style={styles.titleGroup}>
            <View style={[styles.statusDot, isAgentRunning && styles.statusDotActive, awaitingHuman && styles.statusDotWaiting]} />
            <View style={styles.titleTextGroup}>
              <Text style={[styles.titleText, { color: theme.textPrimary }]} numberOfLines={1}>
                Browser Agent
              </Text>
              <Text style={[styles.statusText, { color: theme.textSecondary }]} numberOfLines={1}>
                {awaitingHuman ? 'Needs your input - see below' : isAgentRunning ? 'Browsing on your PC…' : 'Idle - ready for a task'}
              </Text>
            </View>
          </View>

          <TouchableOpacity
            onPress={onClose}
            hitSlop={10}
            style={[styles.closeBtn, { backgroundColor: theme.background }]}
            accessibilityRole="button"
            accessibilityLabel="Close browser agent"
          >
            <Ionicons name="close" size={20} color={theme.textPrimary} />
          </TouchableOpacity>
        </View>

        <View style={styles.topFrameControlsRow}>
          <View style={[styles.zoomControl, { backgroundColor: theme.background }]}>
            <TouchableOpacity onPress={handleZoomOut} hitSlop={8} disabled={zoom <= ZOOM_MIN} style={styles.zoomBtn}>
              <Ionicons name="remove" size={16} color={zoom <= ZOOM_MIN ? theme.textTertiary : theme.textPrimary} />
            </TouchableOpacity>
            <Text style={[styles.zoomLabel, { color: theme.textSecondary }]}>{Math.round(zoom * 100)}%</Text>
            <TouchableOpacity onPress={handleZoomIn} hitSlop={8} disabled={zoom >= ZOOM_MAX} style={styles.zoomBtn}>
              <Ionicons name="add" size={16} color={zoom >= ZOOM_MAX ? theme.textTertiary : theme.textPrimary} />
            </TouchableOpacity>
          </View>

          {isAgentRunning && (
            <TouchableOpacity onPress={handleCancel} hitSlop={8} style={[styles.stopBtn, { backgroundColor: theme.background }]}>
              <Ionicons name="stop-circle-outline" size={15} color="#DC2626" />
              <Text style={styles.stopBtnText}>Stop</Text>
            </TouchableOpacity>
          )}
        </View>
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
        <View style={[styles.taskBar, { backgroundColor: theme.surface, borderTopColor: theme.border, paddingBottom: Math.max(10, insets.bottom) }]}>
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
  topFrame: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomLeftRadius: 20,
    borderBottomRightRadius: 20,
    paddingHorizontal: 16,
    paddingBottom: 12,
    gap: 10,
    elevation: 6,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.12,
    shadowRadius: 6,
  },
  topFrameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  titleGroup: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    flex: 1,
    marginRight: 12,
  },
  titleTextGroup: {
    flex: 1,
  },
  titleText: {
    fontSize: 15,
    fontWeight: '700',
    letterSpacing: 0.2,
  },
  statusDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#9CA3AF',
  },
  statusDotActive: {
    backgroundColor: '#F59E0B',
  },
  statusDotWaiting: {
    backgroundColor: '#EF4444',
  },
  statusText: {
    fontSize: 12,
    fontWeight: '500',
    marginTop: 1,
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    alignItems: 'center',
    justifyContent: 'center',
  },
  topFrameControlsRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  zoomControl: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 8,
    paddingHorizontal: 4,
    paddingVertical: 4,
    gap: 2,
  },
  zoomBtn: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
  zoomLabel: {
    fontSize: 12,
    fontWeight: '600',
    minWidth: 38,
    textAlign: 'center',
  },
  stopBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 4,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
  },
  stopBtnText: {
    fontSize: 12,
    fontWeight: '700',
    color: '#DC2626',
  },
  taskBarWrap: {
    justifyContent: 'flex-end',
  },
  taskBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingTop: 10,
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
