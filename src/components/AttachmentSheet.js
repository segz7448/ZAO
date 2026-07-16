/**
 * ZAO - Attachment Sheet
 *
 * Bottom sheet shown when the "+" button is tapped in the chat input bar.
 * Matches the reference layout: three square action tiles (Camera/Photos/
 * Files) up top, then a list of toggles below.
 *
 * Camera/Photos/Files are wired to onPress callbacks the parent screen
 * implements once file-handling is built (see README TODO) - for now they
 * can safely no-op or show "coming soon" without breaking this component.
 * Web search is UI-only for now (a visual toggle with no backing behavior
 * yet) - deliberately labeled so it's not mistaken for a working feature.
 */

import React from 'react';
import { Modal, View, Text, TouchableOpacity, StyleSheet, Pressable, Switch } from 'react-native';
import { Ionicons, MaterialIcons } from '@expo/vector-icons';
import { useTheme } from '../theme/useTheme';

function ActionTile({ icon, label, onPress, theme }) {
  return (
    <TouchableOpacity
      style={[styles.tile, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}
      onPress={onPress}
    >
      {icon}
      <Text style={[styles.tileLabel, { color: theme.textPrimary }]}>{label}</Text>
    </TouchableOpacity>
  );
}

function ToggleRow({ icon, label, value, onValueChange, theme, disabled = false, subtitle = null }) {
  return (
    <View style={[styles.toggleRow, disabled && { opacity: 0.5 }]}>
      <View style={styles.toggleIcon}>{icon}</View>
      <View style={{ flex: 1 }}>
        <Text style={[styles.toggleLabel, { color: theme.textPrimary }]}>{label}</Text>
        {subtitle && (
          <Text style={[styles.toggleSubtitle, { color: theme.textTertiary }]}>{subtitle}</Text>
        )}
      </View>
      <Switch
        value={value}
        onValueChange={disabled ? undefined : onValueChange}
        disabled={disabled}
        trackColor={{ false: theme.borderStrong, true: theme.brand }}
      />
    </View>
  );
}

export default function AttachmentSheet({
  visible,
  onClose,
  onCamera,
  onPhotos,
  onFiles,
  webSearchEnabled,
  onToggleWebSearch,
}) {
  const theme = useTheme();

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose} />
      <View style={[styles.sheet, { backgroundColor: theme.surface }]}>
        <View style={[styles.handle, { backgroundColor: theme.borderStrong }]} />

        <View style={styles.header}>
          <Text style={[styles.title, { color: theme.textPrimary }]}>Add to chat</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12}>
            <Ionicons name="close" size={20} color={theme.textSecondary} />
          </TouchableOpacity>
        </View>

        <View style={styles.tileRow}>
          <ActionTile
            icon={<Ionicons name="camera-outline" size={26} color={theme.textPrimary} style={styles.tileIcon} />}
            label="Camera"
            onPress={onCamera}
            theme={theme}
          />
          <ActionTile
            icon={<Ionicons name="image-outline" size={26} color={theme.textPrimary} style={styles.tileIcon} />}
            label="Photos"
            onPress={onPhotos}
            theme={theme}
          />
          <ActionTile
            icon={<MaterialIcons name="insert-drive-file" size={26} color={theme.textPrimary} style={styles.tileIcon} />}
            label="Files"
            onPress={onFiles}
            theme={theme}
          />
        </View>

        <View style={[styles.divider, { backgroundColor: theme.border }]} />

        <ToggleRow
          icon={<Ionicons name="globe-outline" size={18} color={theme.textSecondary} />}
          label="Web search"
          subtitle="Coming soon"
          value={webSearchEnabled}
          onValueChange={onToggleWebSearch}
          theme={theme}
          disabled
        />
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.4)',
  },
  sheet: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
  },
  handle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    alignSelf: 'center',
    marginBottom: 12,
  },
  header: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 16,
  },
  title: {
    fontSize: 17,
    fontWeight: '700',
  },
  tileRow: {
    flexDirection: 'row',
    gap: 12,
    marginBottom: 8,
  },
  tile: {
    flex: 1,
    aspectRatio: 1,
    borderRadius: 16,
    borderWidth: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  tileIcon: {
    marginBottom: 6,
  },
  tileLabel: {
    fontSize: 13,
    fontWeight: '600',
  },
  divider: {
    height: 1,
    marginVertical: 12,
  },
  toggleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
  },
  toggleIcon: {
    marginRight: 12,
    width: 24,
    alignItems: 'center',
  },
  toggleLabel: {
    fontSize: 15,
    fontWeight: '500',
  },
  toggleSubtitle: {
    fontSize: 12,
    marginTop: 1,
  },
});
