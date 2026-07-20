/**
 * ZAO - Generated Image Viewer
 *
 * Full-screen modal opened by tapping an inline generated-image bubble in
 * chat (see ChatScreen.js MessageBubble). Shows the image at full size with
 * a single action: save it to the device gallery (see
 * src/utils/saveImageToGallery.js). Closing is a tap on the backdrop or the
 * close button - there's nothing else to do here, no edit/share menu, that
 * can come later if it's actually wanted.
 */

import React, { useState } from 'react';
import { Modal, View, Image, TouchableOpacity, Text, StyleSheet, ActivityIndicator, Dimensions } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { saveImageToGallery } from '../utils/saveImageToGallery';

const { width: SCREEN_WIDTH, height: SCREEN_HEIGHT } = Dimensions.get('window');

export default function ImageViewerModal({ visible, imageUri, onClose, onSaved, onSaveError }) {
  const [saving, setSaving] = useState(false);

  if (!imageUri) return null;

  const handleSave = async () => {
    if (saving) return;
    setSaving(true);
    const result = await saveImageToGallery(imageUri);
    setSaving(false);

    if (result.success) {
      onSaved?.();
    } else {
      onSaveError?.(result.error);
    }
  };

  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.backdrop}>
        <TouchableOpacity style={StyleSheet.absoluteFill} activeOpacity={1} onPress={onClose} />

        <Image source={{ uri: imageUri }} style={styles.fullImage} resizeMode="contain" />

        <TouchableOpacity style={styles.closeButton} onPress={onClose} hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}>
          <Ionicons name="close" size={28} color="#FFFFFF" />
        </TouchableOpacity>

        <TouchableOpacity
          style={styles.downloadButton}
          onPress={handleSave}
          disabled={saving}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          {saving ? (
            <ActivityIndicator size="small" color="#FFFFFF" />
          ) : (
            <Ionicons name="download-outline" size={20} color="#FFFFFF" />
          )}
          <Text style={styles.downloadText}>{saving ? 'Saving…' : 'Save to Photos'}</Text>
        </TouchableOpacity>
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.92)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  fullImage: {
    width: SCREEN_WIDTH,
    height: SCREEN_HEIGHT * 0.75,
  },
  closeButton: {
    position: 'absolute',
    top: 50,
    right: 20,
    padding: 4,
  },
  downloadButton: {
    position: 'absolute',
    bottom: 60,
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: 'rgba(255,255,255,0.15)',
    paddingVertical: 12,
    paddingHorizontal: 22,
    borderRadius: 24,
    gap: 8,
  },
  downloadText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '600',
    marginLeft: 6,
  },
});
