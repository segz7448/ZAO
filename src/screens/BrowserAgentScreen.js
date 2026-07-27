/**
 * ZAO - Browser Agent Screen
 *
 * Full-screen view of the PC's live Playwright browser agent (see
 * server/browserAgent.js, server/browserStream.js,
 * src/services/browserAgent/browserAgentStream.js).
 *
 * MINIMAL CHROME over the live view: the old top card (title/status, tab
 * strip, zoom +/- controls, a Stop button, and an on-screen "X" close
 * button) is gone - only a small floating address bar remains at the
 * top (tap to type a URL, same as before), plus the task input bar at
 * the bottom. The live PC browser view (BrowserAgentPiP in fullScreen
 * mode, a persistent sibling rendered in App.js) fills the entire
 * screen behind both.
 *
 * LEAVING THIS SCREEN: no on-screen close button anymore - the
 * Android hardware/gesture back button is now the only way out (see the
 * BackHandler effect below), same as leaving any other full-screen
 * Android view. iOS has no hardware back button/gesture-back
 * equivalent to hook here, so onClose is also exposed as a prop for a
 * parent that wants to wire a platform-appropriate gesture there - see
 * App.js for what actually calls it on Android (BackHandler) today.
 *
 * Tab switching and zoom adjustment still exist as real, working
 * capabilities (browserAgentStream.js's switchTab/newTab/closeTab, and
 * App.js's browserFullScreenZoom) - only their on-screen controls were
 * removed. If either needs to come back as UI later, it has to be
 * re-added deliberately; nothing about the underlying plumbing was
 * touched by this change.
 */

import React, { useState, useEffect } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, ActivityIndicator, KeyboardAvoidingView, Platform, BackHandler } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/useTheme';

export default function BrowserAgentScreen({ stream, isAgentRunning = false, awaitingHuman = false, tabs = [], zoom = 0.5, onZoomChange, onClose }) {
  const theme = useTheme();
  const insets = useSafeAreaInsets();
  const [taskText, setTaskText] = useState('');
  const [addressText, setAddressText] = useState('');
  const [editingAddress, setEditingAddress] = useState(false);

  const activeTab = tabs.find((t) => t.active) || tabs[0] || null;
  const displayedUrl = editingAddress ? addressText : (activeTab?.url && activeTab.url !== 'about:blank' ? activeTab.url : '');

  const handleAddressFocus = () => {
    setAddressText(activeTab?.url && activeTab.url !== 'about:blank' ? activeTab.url : '');
    setEditingAddress(true);
  };

  const handleAddressSubmit = () => {
    if (addressText.trim()) stream?.navigateTo(addressText.trim());
    setEditingAddress(false);
  };

  // Hardware/gesture back button closes this screen (back to chat) -
  // the only way to leave now that the on-screen "X" is gone. Returning
  // true tells RN this screen consumed the back press, so the OS
  // doesn't also fall through to its default behavior (e.g. backgrounding
  // the app) on top of onClose already firing.
  useEffect(() => {
    if (Platform.OS !== 'android') return undefined;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      onClose?.();
      return true;
    });
    return () => sub.remove();
  }, [onClose]);

  const handleSendTask = () => {
    if (!taskText.trim() || !stream) return;
    stream.runTask(taskText.trim());
    setTaskText('');
  };

  return (
    <View style={styles.chromeStack} pointerEvents="box-none">
      {/* Floating address bar only - no card, no title, no tabs/zoom/
          stop button around it, just this one element safe-area padded
          at the top. Tap to edit and navigate the active tab directly;
          shows the real current URL the rest of the time. */}
      <TouchableOpacity
        activeOpacity={editingAddress ? 1 : 0.7}
        onPress={editingAddress ? undefined : handleAddressFocus}
        style={[
          styles.addressBar,
          { backgroundColor: theme.surface, borderColor: theme.border, marginTop: insets.top + 8 },
        ]}
      >
        <Ionicons name="lock-closed-outline" size={12} color={theme.textTertiary} style={styles.addressLockIcon} />
        {editingAddress ? (
          <TextInput
            style={[styles.addressInput, { color: theme.textPrimary }]}
            value={addressText}
            onChangeText={setAddressText}
            onSubmitEditing={handleAddressSubmit}
            onBlur={() => setEditingAddress(false)}
            autoFocus
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="Search or enter address"
            placeholderTextColor={theme.textTertiary}
            returnKeyType="go"
            selectTextOnFocus
          />
        ) : (
          <Text style={[styles.addressText, { color: displayedUrl ? theme.textSecondary : theme.textTertiary }]} numberOfLines={1}>
            {displayedUrl || 'No page loaded yet'}
          </Text>
        )}
      </TouchableOpacity>

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
  addressBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    marginHorizontal: 14,
    paddingHorizontal: 10,
    paddingVertical: 8,
    elevation: 4,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.1,
    shadowRadius: 4,
  },
  addressLockIcon: {
    opacity: 0.8,
  },
  addressText: {
    flex: 1,
    fontSize: 13,
  },
  addressInput: {
    flex: 1,
    fontSize: 13,
    padding: 0,
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
