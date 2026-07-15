/**
 * ZAO - Inline Message Action Row
 *
 * Always-visible row of small icon buttons under each assistant reply:
 * Copy, Share, Like, Dislike, Regenerate. Replaces the old long-press modal
 * for assistant messages (user messages keep long-press > Copy/Edit, see
 * MessageActionMenu.js) - this matches the persistent-row pattern used by
 * most modern chat apps rather than requiring a long-press to discover the
 * actions at all.
 *
 * This component owns Copy and Share directly (both generic/safe). Like,
 * Dislike, and Regenerate are driven by props from ChatScreen.js, which
 * owns feedback persistence and regeneration logic.
 */

import React from 'react';
import { View, Text, Pressable, StyleSheet, ActivityIndicator, Share } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { useTheme } from '../theme/useTheme';

const ICON_SIZE = 15;
const HIT_SLOP = { top: 6, bottom: 6, left: 6, right: 6 };

function ActionButton({ icon, active, activeColor, onPress, color, disabled, loading }) {
  const theme = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      hitSlop={HIT_SLOP}
      style={({ pressed }) => [
        styles.button,
        pressed && !disabled && { opacity: 0.5 },
        disabled && { opacity: 0.4 },
      ]}
    >
      {loading ? (
        <ActivityIndicator size="small" color={color || theme.textTertiary} />
      ) : (
        <Ionicons
          name={icon}
          size={ICON_SIZE}
          color={active ? (activeColor || theme.brand) : (color || theme.textTertiary)}
        />
      )}
    </Pressable>
  );
}

export default function MessageActions({
  message,
  onCopyToast, // (text) => void
  onLike, // (message) => void
  onDislike, // (message) => void
  onRegenerate, // (message) => void
  isRegenerating, // bool - true while this message is being regenerated
}) {
  const theme = useTheme();

  const handleCopy = async () => {
    await Clipboard.setStringAsync(message.content || '');
    onCopyToast?.('Copied');
  };

  const handleShare = async () => {
    try {
      await Share.share({ message: message.content || '' });
    } catch (err) {
      // User cancelling the share sheet throws on some platforms - not an error.
    }
  };

  return (
    <View style={styles.row}>
      <ActionButton icon="copy-outline" onPress={handleCopy} />
      <ActionButton icon="share-outline" onPress={handleShare} />
      <ActionButton
        icon={message.feedback === 'like' ? 'thumbs-up' : 'thumbs-up-outline'}
        active={message.feedback === 'like'}
        onPress={() => onLike?.(message)}
      />
      <ActionButton
        icon={message.feedback === 'dislike' ? 'thumbs-down' : 'thumbs-down-outline'}
        active={message.feedback === 'dislike'}
        activeColor={theme.danger}
        onPress={() => onDislike?.(message)}
      />
      <ActionButton
        icon="refresh-outline"
        onPress={() => onRegenerate?.(message)}
        loading={isRegenerating}
        disabled={isRegenerating}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 6,
    marginLeft: 2,
  },
  button: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
