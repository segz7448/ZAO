/**
 * ZAO - Message Long-Press Action Menu
 *
 * Long-pressing a message bubble (400-500ms) enlarges it slightly, dims/
 * blurs the rest of the conversation behind a full-screen overlay, and
 * shows a floating context menu anchored near the bubble. A haptic fires
 * on open. Tapping anywhere outside the menu dismisses it and restores the
 * conversation.
 *
 * Permissions: this menu is now used for USER messages only (Copy, Edit).
 * Assistant replies use the always-visible inline MessageActions row
 * rendered under each bubble instead (Copy, Share, Play/Read Aloud, Like,
 * Dislike, Regenerate) - see src/components/MessageActions.js. ChatScreen
 * only wires onLongPress for user bubbles, so in practice `message` here
 * is always role === 'user', but the assistant-row branch below is kept
 * (onReadAloud/onLike/onDislike/onRegenerate props) in case a long-press
 * menu is ever wanted for assistant messages again - it simply won't
 * render unless a caller passes those callbacks.
 *
 * This component owns ONLY the menu/overlay chrome and the Copy action
 * (clipboard is generic and safe to wire immediately). Edit is wired
 * through onEdit (ChatScreen owns composer state).
 */

import React, { useEffect, useRef, useState } from 'react';
import {
  Modal,
  View,
  Text,
  Pressable,
  StyleSheet,
  Animated,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import * as Haptics from 'expo-haptics';
import { BlurView } from 'expo-blur';
import { useTheme } from '../theme/useTheme';

const MENU_WIDTH = 260;
const ROW_HEIGHT = 56;

export default function MessageActionMenu({
  visible,
  message,
  anchor, // { x, y, width, height } of the pressed bubble, in screen coords
  screenWidth,
  screenHeight,
  onClose,
  onEdit, // (message) => void - only relevant for user messages
  onCopyToast, // (text) => void - lets the caller show its own toast
  onReadAloud, // optional - assistant only
  onLike, // optional - assistant only
  onDislike, // optional - assistant only
  onRegenerate, // optional - assistant only
}) {
  const theme = useTheme();
  const isUser = message?.role === 'user';

  const backdropOpacity = useRef(new Animated.Value(0)).current;
  const menuScale = useRef(new Animated.Value(0.95)).current;
  const menuOpacity = useRef(new Animated.Value(0)).current;
  const bubbleScale = useRef(new Animated.Value(1)).current;

  const [rendered, setRendered] = useState(visible);

  useEffect(() => {
    if (visible) {
      setRendered(true);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => {
        // Haptics can fail on some devices/emulators - never block the menu on it.
      });

      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.timing(menuOpacity, {
          toValue: 1,
          duration: 180,
          useNativeDriver: true,
        }),
        Animated.spring(menuScale, {
          toValue: 1,
          useNativeDriver: true,
          friction: 9,
          tension: 120,
        }),
        Animated.spring(bubbleScale, {
          toValue: 1.02,
          useNativeDriver: true,
          friction: 8,
        }),
      ]).start();
    } else if (rendered) {
      Animated.parallel([
        Animated.timing(backdropOpacity, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(menuOpacity, {
          toValue: 0,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(menuScale, {
          toValue: 0.95,
          duration: 150,
          useNativeDriver: true,
        }),
        Animated.timing(bubbleScale, {
          toValue: 1,
          duration: 150,
          useNativeDriver: true,
        }),
      ]).start(() => setRendered(false));
    }
  }, [visible]);

  if (!rendered || !message || !anchor) return null;

  const handleDismiss = () => {
    onClose();
  };

  const runAndClose = (fn) => {
    if (fn) fn(message);
    onClose();
  };

  const handleCopy = async () => {
    await Clipboard.setStringAsync(message.content || '');
    onCopyToast?.('Copied');
    onClose();
  };

  const handleEdit = () => {
    onEdit?.(message);
    onClose();
  };

  // Anchor the menu just below the bubble, clamped so it never runs off
  // either horizontal edge or the bottom of the screen.
  const menuTop = Math.min(
    anchor.y + anchor.height + 8,
    (screenHeight || 800) - 320
  );
  const idealLeft = isUser
    ? anchor.x + anchor.width - MENU_WIDTH
    : anchor.x;
  const menuLeft = Math.max(12, Math.min(idealLeft, (screenWidth || 400) - MENU_WIDTH - 12));

  const rows = isUser
    ? [
        { key: 'copy', icon: 'copy-outline', label: 'Copy', onPress: handleCopy },
        { key: 'edit', icon: 'create-outline', label: 'Edit', onPress: handleEdit },
      ]
    : [
        { key: 'copy', icon: 'copy-outline', label: 'Copy', onPress: handleCopy },
        onReadAloud && { key: 'read', icon: 'volume-medium-outline', label: 'Read Aloud', onPress: () => runAndClose(onReadAloud) },
        onLike && { key: 'like', icon: 'thumbs-up-outline', label: 'Like', onPress: () => runAndClose(onLike) },
        onDislike && { key: 'dislike', icon: 'thumbs-down-outline', label: 'Dislike', onPress: () => runAndClose(onDislike) },
        onRegenerate && { key: 'regenerate', icon: 'refresh-outline', label: 'Regenerate', onPress: () => runAndClose(onRegenerate) },
      ].filter(Boolean);

  return (
    <Modal visible={rendered} transparent animationType="none" onRequestClose={handleDismiss}>
      <Pressable style={StyleSheet.absoluteFill} onPress={handleDismiss}>
        <Animated.View style={[StyleSheet.absoluteFill, { opacity: backdropOpacity }]}>
          <BlurView
            intensity={24}
            tint={theme.mode === 'dark' ? 'dark' : 'light'}
            style={StyleSheet.absoluteFill}
          />
          <View style={[StyleSheet.absoluteFill, { backgroundColor: theme.overlay }]} />
        </Animated.View>

        {/* Enlarged, non-interactive echo of the pressed bubble, positioned
            exactly over the real one - the real bubble stays in the (now
            dimmed) list underneath; this is purely the "pop" visual. */}
        <Animated.View
          pointerEvents="none"
          style={[
            styles.bubbleGhost,
            {
              top: anchor.y,
              left: anchor.x,
              width: anchor.width,
              minHeight: anchor.height,
              backgroundColor: isUser ? theme.bubbleUser : theme.bubbleAssistant,
              transform: [{ scale: bubbleScale }],
            },
          ]}
        >
          <Text
            style={{
              color: isUser ? theme.bubbleUserText : theme.bubbleAssistantText,
              fontSize: 15,
              lineHeight: 21,
            }}
            numberOfLines={6}
          >
            {message.content}
          </Text>
        </Animated.View>

        <Animated.View
          style={[
            styles.menu,
            {
              top: menuTop,
              left: menuLeft,
              backgroundColor: theme.mode === 'dark' ? theme.surface : '#FFFFFF',
              opacity: menuOpacity,
              transform: [{ scale: menuScale }],
            },
          ]}
        >
          {rows.map((row, idx) => (
            <Pressable
              key={row.key}
              onPress={row.onPress}
              style={({ pressed }) => [
                styles.row,
                idx > 0 && { borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border },
                pressed && { backgroundColor: theme.surfaceAlt },
              ]}
            >
              <Ionicons name={row.icon} size={20} color={theme.textSecondary} style={styles.rowIcon} />
              <Text style={[styles.rowLabel, { color: theme.textPrimary }]}>{row.label}</Text>
            </Pressable>
          ))}
        </Animated.View>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  bubbleGhost: {
    position: 'absolute',
    borderRadius: 18,
    paddingVertical: 10,
    paddingHorizontal: 14,
    maxWidth: '82%',
  },
  menu: {
    position: 'absolute',
    width: MENU_WIDTH,
    borderRadius: 24,
    paddingHorizontal: 0,
    overflow: 'hidden',
    elevation: 12,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.18,
    shadowRadius: 16,
  },
  row: {
    height: ROW_HEIGHT,
    paddingHorizontal: 20,
    flexDirection: 'row',
    alignItems: 'center',
  },
  rowIcon: {
    marginRight: 16,
  },
  rowLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
});
