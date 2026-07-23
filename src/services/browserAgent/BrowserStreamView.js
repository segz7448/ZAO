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
 *
 * ZOOM: `zoom` scales the displayed frame down within its container
 * (1 = fills the container edge-to-edge via "contain" fit; 0.5 = shown
 * at half that size, centered, with visible margin around it) - purely
 * a DISPLAY transform, not an actual page zoom on the PC's Playwright
 * viewport, so the real page content/layout is unaffected. Tap
 * coordinates are computed directly from the same fit+zoom math used to
 * size the image (computeFitBox below) rather than a CSS transform, so
 * a tap is either correctly rescaled into the PC's fixed viewport
 * coordinates or - if it lands in the now-visible margin outside the
 * zoomed-out frame - simply ignored instead of landing on the wrong
 * element.
 */

import React, { useRef, useState, useCallback } from 'react';
import { View, Image, Text, StyleSheet, PanResponder } from 'react-native';

// Must match server/browserAgent.js's AgentSession context viewport
// exactly - manual tap coordinates are computed relative to this, then
// scaled to whatever size this component is actually rendered at on the
// phone.
const STREAM_VIEWPORT = { width: 412, height: 915 };

/** "contain" fit of STREAM_VIEWPORT within {width, height}, then scaled by zoom - the exact box the <Image> is rendered at and taps are measured against. */
function computeFitBox(containerWidth, containerHeight, zoom) {
  const containerAspect = containerWidth / containerHeight;
  const viewportAspect = STREAM_VIEWPORT.width / STREAM_VIEWPORT.height;

  let fitWidth;
  let fitHeight;
  if (containerAspect > viewportAspect) {
    fitHeight = containerHeight;
    fitWidth = fitHeight * viewportAspect;
  } else {
    fitWidth = containerWidth;
    fitHeight = fitWidth / viewportAspect;
  }

  const width = fitWidth * zoom;
  const height = fitHeight * zoom;
  return {
    width,
    height,
    offsetX: (containerWidth - width) / 2,
    offsetY: (containerHeight - height) / 2,
  };
}

/**
 * @param {object} props
 * @param {string|null} props.frameBase64 - latest JPEG frame, base64-encoded (no data: prefix)
 * @param {import('./browserAgentStream').BrowserAgentStream} props.stream - the connected stream client, for sending manual taps
 * @param {boolean} props.interactive - whether taps should actually be sent (true while awaitingHuman; false while the agent is autonomously working, so an accidental tap doesn't fight the model mid-task)
 * @param {boolean} [props.connected] - whether the WebSocket to the PC is currently open
 * @param {string|null} [props.connectionError] - human-readable reason the connection isn't open, if known
 * @param {boolean} [props.isRunning] - whether a task is actively running on the PC session right now
 * @param {number} [props.zoom] - 0-1 display scale, see header. Defaults to 1 (fill the container) for any caller that doesn't pass one, so existing usage is unaffected.
 */
export default function BrowserStreamView({ frameBase64, stream, interactive = false, connected = false, connectionError = null, isRunning = false, zoom = 1 }) {
  const [layoutSize, setLayoutSize] = useState({ width: STREAM_VIEWPORT.width, height: STREAM_VIEWPORT.height });

  const onLayout = useCallback((e) => {
    const { width, height } = e.nativeEvent.layout;
    if (width > 0 && height > 0) setLayoutSize({ width, height });
  }, []);

  const fitBox = computeFitBox(layoutSize.width, layoutSize.height, zoom);

  const handleTap = useCallback(
    (locationX, locationY) => {
      if (!interactive || !stream) return;
      const box = computeFitBox(layoutSize.width, layoutSize.height, zoom);
      const imgX = locationX - box.offsetX;
      const imgY = locationY - box.offsetY;
      // Outside the visible (possibly zoomed-out) frame entirely - e.g. a
      // tap in the letterboxed margin at 50% zoom - there's nothing there
      // to click, so don't send a coordinate that would land on whatever
      // happens to be at that scaled-up position instead.
      if (imgX < 0 || imgY < 0 || imgX > box.width || imgY > box.height) return;

      const scaleX = STREAM_VIEWPORT.width / box.width;
      const scaleY = STREAM_VIEWPORT.height / box.height;
      stream.manualClick(Math.round(imgX * scaleX), Math.round(imgY * scaleY));
    },
    [interactive, stream, layoutSize, zoom]
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
        <View
          style={{
            position: 'absolute',
            left: fitBox.offsetX,
            top: fitBox.offsetY,
            width: fitBox.width,
            height: fitBox.height,
          }}
        >
          <Image
            source={{ uri: `data:image/jpeg;base64,${frameBase64}` }}
            style={StyleSheet.absoluteFill}
            resizeMode="contain"
          />
        </View>
      ) : (
        <View style={[StyleSheet.absoluteFill, styles.placeholder]}>
          <Text style={styles.placeholderText}>
            {!connected
              ? connectionError || "Can't reach the PC backend - check Settings > Backend Connection"
              : isRunning
              ? 'Connecting to the live view…'
              : "Connected - waiting for a task. Type one below and tap Send."}
          </Text>
        </View>
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
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 20,
  },
  placeholderText: {
    color: '#999',
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 18,
  },
});
