/**
 * ZAO - Browser Stream View
 *
 * Displays the PC's live browser-agent screenshot stream and turns taps
 * on it into manual-control events sent back over the WebSocket (see
 * browserAgentStream.js) - this is the phone's "eyes and hands DISPLAY"
 * described in the architecture: it shows what the PC's Playwright
 * browser is doing and lets the person tap/type into it directly (for
 * CAPTCHAs etc.), but runs no decision loop of its own.
 *
 * Replaces the old BrowserAgentView.js (which wrapped a real
 * react-native-webview) - there is no WebView here at all, just an
 * <Image> re-rendered on every incoming frame plus a transparent
 * touch-capture layer on top of it.
 */

import React, { useRef, useState, useCallback } from 'react';
import { View, Image, StyleSheet, PanResponder } from 'react-native';

// Must match server/browserAgent.js's AgentSession context viewport
// exactly - manual tap coordinates are computed relative to this, then
// scaled to whatever size this component is actually rendered at on the
// phone.
const STREAM_VIEWPORT = { width: 412, height: 915 };

/**
 * @param {object} props
 * @param {string|null} props.frameBase64 - latest JPEG frame, base64-encoded (no data: prefix)
 * @param {import('./browserAgentStream').BrowserAgentStream} props.stream - the connected stream client, for sending manual taps
 * @param {boolean} props.interactive - whether taps should actually be sent (true while awaitingHuman; false while the agent is autonomously working, so an accidental tap doesn't fight the model mid-task)
 */
export default function BrowserStreamView({ frameBase64, stream, interactive = false }) {
  const [layoutSize, setLayoutSize] = useState({ width: STREAM_VIEWPORT.width, height: STREAM_VIEWPORT.height });

  const onLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setLayoutSize({ width, height });
  }, []);

  const handleTap = useCallback(
    (locationX, locationY) => {
      if (!interactive || !stream) return;
      // Scale from however big this component is actually rendered on
      // screen back to the PC's fixed streamed viewport, so a tap in the
      // corner of a large full-screen view still lands on the right
      // element in Playwright's much smaller virtual viewport.
      const scaleX = STREAM_VIEWPORT.width / layoutSize.width;
      const scaleY = STREAM_VIEWPORT.height / layoutSize.height;
      stream.manualClick(Math.round(locationX * scaleX), Math.round(locationY * scaleY));
    },
    [interactive, stream, layoutSize]
  );

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderRelease: (e) => {
        const { locationX, locationY } = e.nativeEvent;
        handleTap(locationX, locationY);
      },
    })
  ).current;

  return (
    <View style={styles.container} onLayout={onLayout}>
      {frameBase64 ? (
        <Image
          source={{ uri: `data:image/jpeg;base64,${frameBase64}` }}
          style={StyleSheet.absoluteFill}
          resizeMode="contain"
        />
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.placeholder]} />
      )}
      {/* Transparent touch-capture layer - only actually forwards taps to the PC when interactive is true, but always present so onLayout has a stable measurement surface. */}
      <View style={StyleSheet.absoluteFill} {...panResponder.panHandlers} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#000',
    overflow: 'hidden',
  },
  placeholder: {
    backgroundColor: '#1a1a1a',
  },
});
