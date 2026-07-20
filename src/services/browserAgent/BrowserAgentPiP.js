/**
 * ZAO - Browser Agent Picture-in-Picture Live View
 *
 * Wraps BrowserStreamView (the live PC screenshot stream + tap capture)
 * in a small floating window that stays on screen (draggable,
 * corner-anchored) while the person keeps chatting. Same chrome/UX
 * pattern as the original WebView-based version - drag, minimize, expand
 * to full screen - just displaying the PC's live browser instead of an
 * on-device one. See browserAgentStream.js for the actual WebSocket
 * connection this displays, and server/browserAgent.js for the PC-side
 * Playwright session driving it.
 *
 * No step-snapshot capture here anymore (the old version used
 * react-native-view-shot to screenshot its own WebView after each step) -
 * the PC already sends real screenshots directly over the stream, so
 * there's nothing left to re-capture on the phone side.
 */

import React, { useRef, useState } from 'react';
import { View, StyleSheet, PanResponder, Animated, Dimensions, TouchableOpacity, Text, ActivityIndicator, TextInput } from 'react-native';
import BrowserStreamView from './BrowserStreamView';

const SCREEN = Dimensions.get('window');
const PIP_WIDTH = Math.round(SCREEN.width * 0.62);
const PIP_HEIGHT = Math.round(PIP_WIDTH * (915 / 412)); // matches the streamed viewport's aspect ratio
const EDGE_MARGIN = 12;

const BrowserAgentPiP = React.forwardRef(function BrowserAgentPiP(props, ref) {
  const {
    visible = true,
    stream, // BrowserAgentStream instance, connected by the parent (App.js)
    isRunning = false,
    awaitingHuman = false,
    humanReason = null,
    fullScreen = false,
    frameBase64 = null,
    connected = false,
    connectionError = null,
    onExpand = () => {},
    onResumeAfterHuman = () => {},
  } = props;

  const pan = useRef(
    new Animated.ValueXY({
      x: SCREEN.width - PIP_WIDTH - EDGE_MARGIN,
      y: EDGE_MARGIN * 6,
    })
  ).current;

  const [minimized, setMinimized] = useState(false);
  const [manualText, setManualText] = useState('');

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, gesture) => {
        const endX = gesture.moveX < SCREEN.width / 2 ? EDGE_MARGIN : SCREEN.width - PIP_WIDTH - EDGE_MARGIN;
        Animated.spring(pan, { toValue: { x: endX, y: pan.y._value }, useNativeDriver: false }).start();
      },
    })
  ).current;

  React.useImperativeHandle(ref, () => ({}));

  const handleSendManualText = () => {
    if (!manualText.trim()) return;
    stream?.manualType(manualText);
    setManualText('');
  };

  if (!visible) return null;

  // Full-screen mode: no PiP chrome - BrowserAgentScreen supplies its own
  // header/controls around this same stream view.
  if (fullScreen) {
    return (
      <View style={StyleSheet.absoluteFill}>
        <BrowserStreamView frameBase64={frameBase64} stream={stream} interactive={awaitingHuman} connected={connected} connectionError={connectionError} isRunning={isRunning} />
        {awaitingHuman && (
          <ManualControlBar
            reason={humanReason}
            text={manualText}
            onChangeText={setManualText}
            onSend={handleSendManualText}
            onKey={(key) => stream?.manualKey(key)}
            onDone={onResumeAfterHuman}
          />
        )}
      </View>
    );
  }

  return (
    <Animated.View
      style={[styles.container, { transform: pan.getTranslateTransform() }, minimized && styles.containerMinimized]}
      {...panResponder.panHandlers}
    >
      <View style={styles.header}>
        <TouchableOpacity style={styles.statusRow} onPress={onExpand} activeOpacity={0.7}>
          {isRunning ? <ActivityIndicator size="small" color="#fff" /> : null}
          <Text style={styles.headerText} numberOfLines={1}>
            {awaitingHuman ? 'Needs your input - tap to open' : isRunning ? 'Agent working…' : 'Browser agent'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setMinimized((m) => !m)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.headerToggle}>{minimized ? '▢' : '—'}</Text>
        </TouchableOpacity>
      </View>

      {!minimized && (
        <View style={styles.viewportWrap}>
          <BrowserStreamView frameBase64={frameBase64} stream={stream} interactive={false} connected={connected} connectionError={connectionError} isRunning={isRunning} />
        </View>
      )}
    </Animated.View>
  );
});

export default BrowserAgentPiP;

/** Shown in full-screen mode while the agent is paused waiting for the person to take over - a reason banner, a text field + send for typing into whatever's focused, an Enter key shortcut, and a "Done, continue" button that hands control back to the model. */
function ManualControlBar({ reason, text, onChangeText, onSend, onKey, onDone }) {
  return (
    <View style={styles.manualBar}>
      <Text style={styles.manualReason} numberOfLines={2}>{reason || 'This needs your input.'}</Text>
      <View style={styles.manualInputRow}>
        <TextInput
          style={styles.manualInput}
          value={text}
          onChangeText={onChangeText}
          placeholder="Type here, then tap Send or the field on screen"
          placeholderTextColor="#888"
          onSubmitEditing={() => onKey('Enter')}
        />
        <TouchableOpacity style={styles.manualBtn} onPress={onSend}>
          <Text style={styles.manualBtnText}>Send</Text>
        </TouchableOpacity>
      </View>
      <TouchableOpacity style={styles.manualDoneBtn} onPress={onDone}>
        <Text style={styles.manualDoneBtnText}>Done - hand back to agent</Text>
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    width: PIP_WIDTH,
    height: PIP_HEIGHT,
    borderRadius: 12,
    overflow: 'hidden',
    backgroundColor: '#1a1a1a',
    elevation: 8,
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.35,
    shadowRadius: 6,
    zIndex: 999,
  },
  containerMinimized: { height: 36 },
  header: {
    height: 36,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#262626',
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 6, flex: 1 },
  headerText: { color: '#fff', fontSize: 12, fontWeight: '600', flexShrink: 1 },
  headerToggle: { color: '#fff', fontSize: 14, paddingLeft: 8 },
  viewportWrap: { flex: 1 },
  manualBar: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: '#1a1a1acc',
    padding: 12,
    gap: 8,
  },
  manualReason: { color: '#fbbf24', fontSize: 13, fontWeight: '600' },
  manualInputRow: { flexDirection: 'row', gap: 8 },
  manualInput: {
    flex: 1,
    backgroundColor: '#262626',
    color: '#fff',
    borderRadius: 8,
    paddingHorizontal: 12,
    paddingVertical: 8,
  },
  manualBtn: { backgroundColor: '#3b82f6', borderRadius: 8, paddingHorizontal: 16, justifyContent: 'center' },
  manualBtnText: { color: '#fff', fontWeight: '600' },
  manualDoneBtn: { backgroundColor: '#16a34a', borderRadius: 8, paddingVertical: 10, alignItems: 'center' },
  manualDoneBtnText: { color: '#fff', fontWeight: '700' },
});
