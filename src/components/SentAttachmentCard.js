/**
 * ZAO - Sent Attachment Card
 *
 * Rendered inside a USER message bubble whenever message.local_attachment_path
 * is set (see chatStore.js's sendMessage() and the local_attachment_path/
 * attachment_kind/attachment_name migration in src/db/database.js). This is
 * the video/generic-file counterpart to the existing image bubble
 * (message.local_image_path, handled directly in MessageBubble/ChatScreen.js)
 * - previously only images got a persistent visual in the chat; a picked
 * video or file would send fine to the model but then vanish from the UI,
 * leaving only the injected "[The user attached a video...]" text note. This
 * card is what makes "whatever I attach stays visible in chat" true for
 * every attachment type, not just photos.
 *
 * No video-playback library is bundled (no expo-av/expo-video), so a video
 * attachment renders as a tappable card with a play-icon badge rather than
 * an inline player - tapping opens it in the device's own video player via
 * expo-sharing's share sheet (same mechanism phoneUtilityTool.js already
 * uses), which is the lowest-risk way to give a "watch it" affordance
 * without adding a new native dependency.
 */

import React from 'react';
import { View, Text, TouchableOpacity, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Sharing from 'expo-sharing';

const EXTENSION_META = {
  pdf: { icon: 'document-text-outline', label: 'PDF' },
  doc: { icon: 'document-text-outline', label: 'Word' },
  docx: { icon: 'document-text-outline', label: 'Word' },
  xls: { icon: 'grid-outline', label: 'Excel' },
  xlsx: { icon: 'grid-outline', label: 'Excel' },
  csv: { icon: 'grid-outline', label: 'CSV' },
  ppt: { icon: 'easel-outline', label: 'PowerPoint' },
  pptx: { icon: 'easel-outline', label: 'PowerPoint' },
  zip: { icon: 'file-tray-full-outline', label: 'ZIP archive' },
  js: { icon: 'code-slash-outline', label: 'Code' },
  jsx: { icon: 'code-slash-outline', label: 'Code' },
  ts: { icon: 'code-slash-outline', label: 'Code' },
  tsx: { icon: 'code-slash-outline', label: 'Code' },
  json: { icon: 'code-slash-outline', label: 'JSON' },
  html: { icon: 'code-slash-outline', label: 'HTML' },
  css: { icon: 'code-slash-outline', label: 'CSS' },
  py: { icon: 'code-slash-outline', label: 'Python' },
  md: { icon: 'document-outline', label: 'Markdown' },
  txt: { icon: 'document-outline', label: 'Text' },
};
const DEFAULT_FILE_META = { icon: 'document-outline', label: 'File' };

function metaFor(kind, name) {
  if (kind === 'video') return { icon: 'videocam-outline', label: 'Video' };
  const ext = (name || '').split('.').pop()?.toLowerCase();
  return EXTENSION_META[ext] || DEFAULT_FILE_META;
}

/**
 * @param {object} props
 * @param {string} props.localPath - file:// URI (message.local_attachment_path)
 * @param {'video'|'file'} props.kind - message.attachment_kind
 * @param {string} props.name - message.attachment_name
 * @param {object} props.theme - from useTheme()
 * @param {(text: string) => void} [props.onToast]
 */
export default function SentAttachmentCard({ localPath, kind, name, theme, onToast }) {
  if (!localPath) return null;
  const meta = metaFor(kind, name);

  const handlePress = async () => {
    try {
      const available = await Sharing.isAvailableAsync();
      if (!available) {
        onToast?.('Nothing on this device can open this file.');
        return;
      }
      await Sharing.shareAsync(localPath);
    } catch (err) {
      onToast?.(err?.message || 'Could not open this file.');
    }
  };

  return (
    <TouchableOpacity
      style={[styles.card, { backgroundColor: theme.surfaceAlt || theme.surface, borderColor: theme.border }]}
      onPress={handlePress}
      activeOpacity={0.75}
    >
      <View style={[styles.iconWrap, { backgroundColor: theme.surface }]}>
        <Ionicons name={meta.icon} size={22} color={theme.textSecondary} />
        {kind === 'video' && (
          <View style={styles.playBadge}>
            <Ionicons name="play" size={10} color="#fff" />
          </View>
        )}
      </View>
      <View style={styles.info}>
        <Text style={[styles.name, { color: theme.textPrimary }]} numberOfLines={1}>
          {name || meta.label}
        </Text>
        <Text style={[styles.type, { color: theme.textTertiary }]}>{meta.label} · Tap to open</Text>
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    paddingVertical: 10,
    paddingHorizontal: 12,
    marginBottom: 6,
    minWidth: 200,
  },
  iconWrap: {
    width: 38,
    height: 38,
    borderRadius: 10,
    alignItems: 'center',
    justifyContent: 'center',
  },
  playBadge: {
    position: 'absolute',
    bottom: -2,
    right: -2,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: '#000',
    alignItems: 'center',
    justifyContent: 'center',
  },
  info: {
    flex: 1,
    minWidth: 0,
  },
  name: {
    fontSize: 14,
    fontWeight: '600',
  },
  type: {
    fontSize: 11,
    marginTop: 1,
  },
});
