import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  StyleSheet,
  ActivityIndicator,
  Alert,
  Animated,
  Dimensions,
  Image,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import * as DocumentPicker from 'expo-document-picker';
import { Ionicons } from '@expo/vector-icons';
import { useChatStore } from '../store/chatStore';
import { usePreferencesStore } from '../store/preferencesStore';
import AttachmentSheet from '../components/AttachmentSheet';
import MarkdownText from '../components/MarkdownText';
import MessageActionMenu from '../components/MessageActionMenu';
import MessageActions from '../components/MessageActions';
import Toast from '../components/Toast';
import ImageViewerModal from '../components/ImageViewerModal';
import { ACTIVE_MODEL } from '../config/localModels';
import { useTheme } from '../theme/useTheme';

// Long-press threshold per spec: 400-500ms. 450ms sits in the middle of
// that range - long enough to not fire on a slightly slow tap, short
// enough to still feel responsive. Long-press now only applies to user
// bubbles (Copy/Edit) - assistant replies use the always-visible inline
// action row below instead (see MessageActions.js).
const LONG_PRESS_DURATION_MS = 450;

function MessageBubble({ message, theme, onLongPress, onImagePress, actionsProps }) {
  const isUser = message.role === 'user';
  const textColor = isUser ? theme.bubbleUserText : theme.bubbleAssistantText;
  const bubbleRef = useRef(null);

  const handleLongPress = () => {
    // Measure the bubble's on-screen position at the moment of the press
    // (not on mount) so the anchor is accurate even after scrolling.
    bubbleRef.current?.measureInWindow((x, y, width, height) => {
      onLongPress(message, { x, y, width, height });
    });
  };

  return (
    <View style={[styles.bubbleRow, isUser ? styles.bubbleRowUser : styles.bubbleRowAssistant]}>
      <View style={isUser ? styles.bubbleColUser : styles.bubbleColAssistant}>
        <TouchableOpacity
          ref={bubbleRef}
          activeOpacity={0.85}
          delayLongPress={LONG_PRESS_DURATION_MS}
          onLongPress={isUser ? handleLongPress : undefined}
          style={[
            styles.bubble,
            { backgroundColor: isUser ? theme.bubbleUser : theme.bubbleAssistant },
            message.is_error && {
              backgroundColor: theme.dangerSoft,
              borderWidth: 1,
              borderColor: theme.dangerBorder,
            },
            message.local_image_path && styles.bubbleImagePadding,
          ]}
        >
          {message.local_image_path && (
            // Image bubble - the person's own attached photo (see
            // copyAttachmentLocally in chatStore.js), stored as a local
            // file:// URI. Tapping opens the full-screen viewer with a
            // download-to-gallery action (see ImageViewerModal.js).
            <TouchableOpacity activeOpacity={0.9} onPress={() => onImagePress?.(message.local_image_path)}>
              <Image
                source={{ uri: message.local_image_path }}
                style={styles.generatedImage}
                resizeMode="cover"
              />
            </TouchableOpacity>
          )}
          {isUser ? (
            // User messages are rendered as plain text - no reason to parse
            // markdown out of what the person typed themselves. Skipped
            // entirely for image-only sends (no caption typed), same as
            // the assistant's image-only case below.
            !!message.content && (
              <Text
                style={[
                  { color: textColor, fontSize: 15, lineHeight: 21 },
                  message.local_image_path && styles.bubbleTextAfterImage,
                ]}
              >
                {message.content}
              </Text>
            )
          ) : message.local_image_path ? null : (
            <MarkdownText
              content={message.content}
              textColor={message.is_error ? theme.dangerText : textColor}
              codeBackground={theme.mode === 'dark' ? '#0D0D0D' : '#00000010'}
              codeTextColor={textColor}
              borderColor={theme.borderStrong}
            />
          )}
          <View style={styles.bubbleFooter}>
            {!isUser && message.model_family && !message.is_error && (
              <Text style={[styles.modelTag, { color: theme.textTertiary }]}>
                {ACTIVE_MODEL.label}
              </Text>
            )}
            {isUser && message.edited_at && (
              <Text style={[styles.editedTag, { color: theme.bubbleUserText }]}>
                Edited
              </Text>
            )}
          </View>
        </TouchableOpacity>

        {/* Always-visible inline action row under assistant replies (not
            errors - regenerating/liking/reading a plain error message
            doesn't make sense). See MessageActions.js. */}
        {!isUser && !message.is_error && (
          <MessageActions message={message} {...actionsProps} />
        )}
      </View>
    </View>
  );
}

function getGreeting() {
  const hour = new Date().getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

/**
 * Turns one raw AgentStep (from the Browser Router backend - see
 * browser-router/app/agent.py's AgentStep) into a short, friendly label
 * for the live typing-indicator area, e.g. "Searching..." or "Opening
 * github.com...". Falls back to a generic label for step kinds/tool names
 * this hasn't been taught a friendly phrasing for, rather than showing the
 * raw backend detail string (which is deliberately verbose/technical -
 * useful for debugging, not for a live progress UI).
 */
function formatBrowsingStepLabel(step) {
  if (!step) return 'Browsing…';

  if (step.kind === 'tool_call') {
    const toolName = (step.detail || '').split('(')[0];
    const urlMatch = step.detail.match(/"url":\s*"([^"]+)"/);
    const host = urlMatch ? urlMatch[1].replace(/^https?:\/\//, '').split('/')[0] : null;

    switch (toolName) {
      case 'search': return 'Searching…';
      case 'open_url': return host ? `Opening ${host}…` : 'Opening page…';
      case 'click': return 'Clicking…';
      case 'type_text': return 'Typing…';
      case 'scroll': return 'Scrolling…';
      case 'screenshot': return 'Taking a screenshot…';
      case 'download_file': return 'Downloading file…';
      case 'go_back': return 'Going back…';
      default: return 'Browsing…';
    }
  }

  if (step.kind === 'thinking') return 'Reviewing results…';
  if (step.kind === 'error') return 'Retrying…';
  if (step.kind === 'tool_result') return 'Reading page…';

  return 'Browsing…';
}

export default function ChatScreen({ onOpenSidebar, userName = 'there' }) {
  const theme = useTheme();
  const {
    messages, isSending, error,
    browsingSteps, browsingScreenshot,
    sendMessage, clearError, editMessage,
    regenerateMessage, setFeedback,
  } = useChatStore();
  const { preferences, loadPreferences, setBrowserAccessEnabled } = usePreferencesStore();

  const [inputText, setInputText] = useState('');
  const [attachmentVisible, setAttachmentVisible] = useState(false);
  const [webSearchEnabled, setWebSearchEnabled] = useState(false);
  const [pendingAttachment, setPendingAttachment] = useState(null); // { uri, name, mimeType, size }
  const listRef = useRef(null);

  // Long-press message action menu - user messages only now (Copy/Edit,
  // see MessageActionMenu.js). Assistant replies use the always-visible
  // inline MessageActions row instead. activeMessage + anchor together
  // drive the overlay; editingMessageId swaps the composer into "Save" mode.
  const [activeMessage, setActiveMessage] = useState(null);
  const [menuAnchor, setMenuAnchor] = useState(null);
  const [editingMessageId, setEditingMessageId] = useState(null);
  const [viewerImageUri, setViewerImageUri] = useState(null);
  const toastRef = useRef(null);
  const { width: screenWidth, height: screenHeight } = Dimensions.get('window');

  // Inline assistant-message action state: which message (if any) is
  // currently being regenerated, keyed by message id so the row only shows
  // a spinner on the one that's actually busy, not every bubble.
  const [regeneratingMessageId, setRegeneratingMessageId] = useState(null);

  const handleBubbleLongPress = (message, anchor) => {
    setActiveMessage(message);
    setMenuAnchor(anchor);
  };

  const closeActionMenu = () => {
    setActiveMessage(null);
    setMenuAnchor(null);
  };

  const handleEditRequest = (message) => {
    // Pull the message back into the composer, cursor at the end (default
    // TextInput behavior when setting value programmatically), swap Send
    // for Save. The message stays in the list underneath - visually there
    // isn't a way for a user message list item to be removed and re-added
    // as they type without odd flicker, so instead it's just no longer
    // sent again on Save; editMessage() updates it in place by id, then
    // deletes everything after it and asks the AI to respond again.
    setInputText(message.content || '');
    setEditingMessageId(message.id);
  };

  const handleCancelEdit = () => {
    setEditingMessageId(null);
    setInputText('');
  };

  const handleSaveEdit = async () => {
    if (!editingMessageId) return;
    const trimmed = inputText.trim();
    if (!trimmed) return;
    // editMessage() saves the new content, deletes everything after this
    // message, and re-runs the AI on the truncated conversation - the
    // composer clears immediately, isSending (from the store) drives the
    // "Thinking…" indicator while the fresh reply comes back.
    setEditingMessageId(null);
    setInputText('');
    const result = await editMessage(editingMessageId, trimmed);
    if (!result.success) {
      Alert.alert('Could not save edit', 'Please try again.');
    }
  };

  const handleLikeMessage = (message) => setFeedback(message.id, 'like');
  const handleDislikeMessage = (message) => setFeedback(message.id, 'dislike');

  const handleRegenerateMessage = async (message) => {
    setRegeneratingMessageId(message.id);
    try {
      const result = await regenerateMessage(message.id);
      if (!result.success) {
        Alert.alert('Could not regenerate', 'Please try again.');
      }
    } finally {
      setRegeneratingMessageId(null);
    }
  };

  // Composer action-button state machine: voice mode (mic + black voice
  // button) when the input is empty, send mode (orange send button) as
  // soon as any text is present. Driven by a single Animated value so the
  // two states cross-fade/scale instead of ever being visible together.
  const hasText = inputText.trim().length > 0 || !!pendingAttachment;
  const composerAnim = useRef(new Animated.Value(0)).current; // 0 = voice mode, 1 = send mode

  useEffect(() => {
    Animated.timing(composerAnim, {
      toValue: hasText ? 1 : 0,
      duration: 180,
      useNativeDriver: true,
    }).start();
  }, [hasText]);

  useEffect(() => {
    loadPreferences();
  }, []);

  useEffect(() => {
    if (messages.length > 0) {
      requestAnimationFrame(() => listRef.current?.scrollToEnd({ animated: true }));
    }
  }, [messages.length]);

  const handleSend = async () => {
    if ((!inputText.trim() && !pendingAttachment) || isSending) return;
    const text = inputText;
    const attachment = pendingAttachment;
    setInputText('');
    setPendingAttachment(null);
    await sendMessage(text, attachment);
  };

  const handleCamera = async () => {
    setAttachmentVisible(false);
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Camera access needed', 'Enable camera access in your phone settings to take a photo.');
      return;
    }
    const result = await ImagePicker.launchCameraAsync({ quality: 0.7, base64: false });
    if (!result.canceled && result.assets?.[0]) {
      const asset = result.assets[0];
      setPendingAttachment({
        uri: asset.uri,
        name: asset.fileName || `photo_${Date.now()}.jpg`,
        mimeType: asset.mimeType || 'image/jpeg',
        size: asset.fileSize,
      });
    }
  };

  const handlePhotos = async () => {
    setAttachmentVisible(false);
    const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
    if (!permission.granted) {
      Alert.alert('Photo access needed', 'Enable photo library access in your phone settings to attach an image.');
      return;
    }
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.7,
    });
    if (!result.canceled && result.assets?.[0]) {
      const asset = result.assets[0];
      setPendingAttachment({
        uri: asset.uri,
        name: asset.fileName || `image_${Date.now()}.jpg`,
        mimeType: asset.mimeType || 'image/jpeg',
        size: asset.fileSize,
      });
    }
  };

  const handleFiles = async () => {
    setAttachmentVisible(false);
    const result = await DocumentPicker.getDocumentAsync({
      type: '*/*',
      copyToCacheDirectory: true,
    });
    if (!result.canceled && result.assets?.[0]) {
      const asset = result.assets[0];
      setPendingAttachment({
        uri: asset.uri,
        name: asset.name,
        mimeType: asset.mimeType || 'application/octet-stream',
        size: asset.size,
      });
    }
  };

  return (
    <KeyboardAvoidingView
      style={[styles.container, { backgroundColor: theme.background }]}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={90}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={onOpenSidebar} hitSlop={12} style={styles.headerIconButton}>
          <Ionicons name="menu-outline" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
      </View>

      {error && (
        <TouchableOpacity
          style={[styles.errorBanner, { backgroundColor: theme.dangerSoft }]}
          onPress={clearError}
        >
          <Text style={[styles.errorBannerText, { color: theme.dangerText }]}>{error}</Text>
        </TouchableOpacity>
      )}

      <FlatList
        ref={listRef}
        data={messages}
        keyExtractor={(item) => item.id}
        renderItem={({ item }) => (
          <MessageBubble
            message={item}
            theme={theme}
            onLongPress={handleBubbleLongPress}
            onImagePress={setViewerImageUri}
            actionsProps={{
              onCopyToast: (text) => toastRef.current?.show(text),
              onLike: handleLikeMessage,
              onDislike: handleDislikeMessage,
              onRegenerate: handleRegenerateMessage,
              isRegenerating: regeneratingMessageId === item.id,
            }}
          />
        )}
        contentContainerStyle={styles.messageList}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Ionicons name="sparkles" size={36} color={theme.brand} style={styles.brandMark} />
            <Text style={[styles.emptyTitle, { color: theme.textPrimary }]}>
              {getGreeting()}, {userName}
            </Text>
          </View>
        }
      />

      {isSending && (
        <View style={styles.typingIndicator}>
          {browsingSteps.length > 0 ? (
            <View style={styles.browsingProgress}>
              {browsingScreenshot ? (
                <Image
                  source={{ uri: `data:image/jpeg;base64,${browsingScreenshot}` }}
                  style={styles.browsingScreenshot}
                  resizeMode="cover"
                />
              ) : (
                <ActivityIndicator size="small" color={theme.textTertiary} />
              )}
              <Text
                style={[styles.typingText, { color: theme.textTertiary }]}
                numberOfLines={1}
              >
                {formatBrowsingStepLabel(browsingSteps[browsingSteps.length - 1])}
              </Text>
            </View>
          ) : (
            <>
              <ActivityIndicator size="small" color={theme.textTertiary} />
              <Text style={[styles.typingText, { color: theme.textTertiary }]}>Thinking…</Text>
            </>
          )}
        </View>
      )}

      {pendingAttachment && (
        <View style={[styles.attachmentPreview, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}>
          {pendingAttachment.mimeType?.startsWith('image/') ? (
            <Image
              source={{ uri: pendingAttachment.uri }}
              style={styles.attachmentPreviewThumb}
              resizeMode="cover"
            />
          ) : (
            <Ionicons name="attach-outline" size={16} color={theme.textPrimary} style={styles.attachmentPreviewIcon} />
          )}
          <Text style={[styles.attachmentPreviewText, { color: theme.textPrimary }]} numberOfLines={1}>
            {pendingAttachment.name}
          </Text>
          <TouchableOpacity onPress={() => setPendingAttachment(null)} hitSlop={8}>
            <Ionicons name="close" size={16} color={theme.textTertiary} />
          </TouchableOpacity>
        </View>
      )}

      {editingMessageId && (
        <View style={[styles.attachmentPreview, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}>
          <Ionicons name="create-outline" size={16} color={theme.textPrimary} style={styles.attachmentPreviewIcon} />
          <Text style={[styles.attachmentPreviewText, { color: theme.textPrimary }]} numberOfLines={1}>
            Editing message
          </Text>
          <TouchableOpacity onPress={handleCancelEdit} hitSlop={8}>
            <Ionicons name="close" size={16} color={theme.textTertiary} />
          </TouchableOpacity>
        </View>
      )}

      <View style={[styles.inputBar, { borderTopColor: theme.border, backgroundColor: theme.surface }]}>
        <TouchableOpacity
          style={[styles.plusButton, { backgroundColor: theme.surfaceAlt }]}
          onPress={() => setAttachmentVisible(true)}
        >
          <Ionicons name="add" size={22} color={theme.textPrimary} />
        </TouchableOpacity>

        <TouchableOpacity
          style={[
            styles.browserToggle,
            { backgroundColor: theme.surfaceAlt },
            preferences.browser_access_enabled && styles.browserToggleActive,
          ]}
          onPress={() => setBrowserAccessEnabled(!preferences.browser_access_enabled)}
          hitSlop={4}
          accessibilityRole="button"
          accessibilityState={{ selected: !!preferences.browser_access_enabled }}
          accessibilityLabel={
            preferences.browser_access_enabled
              ? 'Browser access on. Tap to turn off.'
              : 'Browser access off. Tap to turn on.'
          }
        >
          <Ionicons
            name="globe-outline"
            size={20}
            color={preferences.browser_access_enabled ? '#D97757' : theme.textTertiary}
          />
        </TouchableOpacity>

        <TextInput
          style={[styles.textInput, { color: theme.textPrimary }]}
          value={inputText}
          onChangeText={setInputText}
          placeholder="Chat with ZAO…"
          placeholderTextColor={theme.textTertiary}
          multiline
          maxLength={8000}
        />

        {/* Fixed-size slot that holds the send button, so the composer
            never reflows when it appears/disappears. */}
        <View style={styles.actionSlot}>
          {/* Send-mode control: single orange circular send button. Only
              rendered (and interactive) once there is text or an attachment. */}
          <Animated.View
            pointerEvents={hasText ? 'auto' : 'none'}
            style={[
              styles.sendButtonWrap,
              {
                opacity: composerAnim,
                transform: [
                  { scale: composerAnim.interpolate({ inputRange: [0, 1], outputRange: [0.7, 1] }) },
                ],
              },
            ]}
          >
            {editingMessageId ? (
              // Edit mode: Send is replaced with an explicit Save action
              // (per spec) - Saving updates the original message in place
              // via editMessage() rather than sending a new one.
              <TouchableOpacity
                style={[styles.sendButton, { backgroundColor: theme.mode === 'dark' ? '#F3F4F6' : '#111111' }]}
                onPress={handleSaveEdit}
                disabled={!hasText}
              >
                <Ionicons name="checkmark" size={22} color={theme.mode === 'dark' ? '#111111' : '#FFFFFF'} />
              </TouchableOpacity>
            ) : (
              <TouchableOpacity
                style={[
                  styles.sendButton,
                  { backgroundColor: '#D97757' },
                  isSending && { opacity: 0.6 },
                ]}
                onPress={handleSend}
                disabled={!hasText || isSending}
              >
                <Ionicons name="arrow-up" size={20} color="#FFFFFF" />
              </TouchableOpacity>
            )}
          </Animated.View>
        </View>
      </View>

      <AttachmentSheet
        visible={attachmentVisible}
        onClose={() => setAttachmentVisible(false)}
        onCamera={handleCamera}
        onPhotos={handlePhotos}
        onFiles={handleFiles}
        webSearchEnabled={webSearchEnabled}
        onToggleWebSearch={setWebSearchEnabled}
      />

      {/* Long-press context menu - user messages only now (Copy/Edit).
          Assistant replies use the always-visible inline MessageActions
          row rendered under each bubble instead (Copy/Share/Play/Like/
          Dislike/Regenerate) - see MessageActions.js. MessageBubble only
          wires onLongPress for user bubbles, so `activeMessage` here will
          never actually be an assistant message. */}
      <MessageActionMenu
        visible={!!activeMessage}
        message={activeMessage}
        anchor={menuAnchor}
        screenWidth={screenWidth}
        screenHeight={screenHeight}
        onClose={closeActionMenu}
        onEdit={handleEditRequest}
        onCopyToast={(text) => toastRef.current?.show(text)}
      />
      <Toast ref={toastRef} />

      <ImageViewerModal
        visible={!!viewerImageUri}
        imageUri={viewerImageUri}
        onClose={() => setViewerImageUri(null)}
        onSaved={() => toastRef.current?.show('Saved to Photos')}
        onSaveError={(message) => toastRef.current?.show(message || 'Could not save image')}
      />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 16,
    paddingVertical: 10,
  },
  headerIconButton: {
    padding: 4,
  },
  messageList: {
    paddingVertical: 16,
    flexGrow: 1,
  },
  emptyState: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingTop: 100,
    paddingHorizontal: 16,
  },
  brandMark: {
    marginBottom: 12,
  },
  emptyTitle: {
    fontSize: 26,
    fontWeight: '600',
  },
  bubbleRow: {
    marginBottom: 10,
    flexDirection: 'row',
  },
  bubbleRowUser: {
    justifyContent: 'flex-end',
    marginRight: 16,
  },
  bubbleRowAssistant: {
    justifyContent: 'flex-start',
    marginLeft: 16,
    marginRight: 16,
  },
  bubbleColUser: {
    maxWidth: '78%',
    alignItems: 'flex-end',
  },
  bubbleColAssistant: {
    width: '90%',
    alignItems: 'flex-start',
  },
  bubble: {
    maxWidth: '100%',
    borderRadius: 18,
    paddingVertical: 10,
    paddingHorizontal: 14,
  },
  generatedImage: {
    width: 260,
    height: 260,
    borderRadius: 12,
  },
  bubbleImagePadding: {
    padding: 4,
  },
  bubbleTextAfterImage: {
    marginTop: 8,
    marginHorizontal: 6,
  },
  bubbleFooter: {
    flexDirection: 'row',
  },
  modelTag: {
    fontSize: 11,
    marginTop: 4,
    fontWeight: '600',
  },
  editedTag: {
    fontSize: 11,
    marginTop: 4,
    fontWeight: '600',
    opacity: 0.6,
  },
  switchChip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'center',
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 14,
    marginTop: 8,
  },
  switchChipIcon: {
    marginRight: 6,
  },
  switchChipText: {
    fontSize: 12,
    fontWeight: '600',
  },
  errorBanner: {
    paddingVertical: 8,
    paddingHorizontal: 16,
  },
  errorBannerText: {
    fontSize: 13,
    textAlign: 'center',
  },
  typingIndicator: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 20,
    paddingBottom: 6,
  },
  typingText: {
    marginLeft: 8,
    fontSize: 13,
  },
  browsingProgress: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  browsingScreenshot: {
    width: 28,
    height: 28,
    borderRadius: 6,
  },
  attachmentPreview: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginHorizontal: 12,
    marginBottom: 6,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 10,
    borderWidth: 1,
  },
  attachmentPreviewIcon: {
    marginRight: 6,
  },
  attachmentPreviewThumb: {
    width: 28,
    height: 28,
    borderRadius: 6,
    marginRight: 8,
  },
  attachmentPreviewText: {
    fontSize: 13,
    fontWeight: '500',
    flex: 1,
    marginRight: 8,
  },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    paddingHorizontal: 10,
    paddingVertical: 10,
    borderTopWidth: 1,
  },
  plusButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 6,
  },
  browserToggle: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: 8,
    opacity: 0.55, // dull/inactive by default
  },
  browserToggleActive: {
    opacity: 1, // "glows" when on - full opacity + tinted icon + soft glow ring
    backgroundColor: 'rgba(217, 119, 87, 0.16)',
    shadowColor: '#D97757',
    shadowOpacity: 0.7,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 0 },
    elevation: 4,
  },
  textInput: {
    flex: 1,
    fontSize: 15,
    maxHeight: 100,
    paddingVertical: 8,
    paddingHorizontal: 8,
  },
  actionSlot: {
    marginLeft: 6,
    width: 46,
    height: 46,
    justifyContent: 'center',
  },
  sendButtonWrap: {
    position: 'absolute',
    right: 0,
  },
  sendButton: {
    width: 46,
    height: 46,
    borderRadius: 23,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
