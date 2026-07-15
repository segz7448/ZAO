/**
 * ZAO - Browser Agent Picture-in-Picture Live View
 *
 * Wraps BrowserAgentView in a small floating window that stays on screen
 * (draggable, corner-anchored) while the person keeps chatting - this is
 * what makes "mount it small so I can see what it's doing live" and "give
 * it a task, then give it another one in the same conversation" both work:
 * the WebView itself never unmounts between tasks just because the person
 * looked away or the chat is in front of it, so cookies/session/current
 * page all survive across an entire AgentSession's lifetime, not just one
 * task.
 *
 * Each step also captures a still JPEG (react-native-view-shot) of this
 * small live view and persists it to app-private storage - step
 * snapshots rather than continuous video (Expo managed workflow has no
 * MediaProjection access without ejecting to bare native code).
 */

import React, { useRef, useState, useCallback, useEffect, forwardRef, useImperativeHandle } from 'react';
import { View, StyleSheet, PanResponder, Animated, Dimensions, TouchableOpacity, Text, ActivityIndicator } from 'react-native';
import { captureRef } from 'react-native-view-shot';
import * as FileSystem from 'expo-file-system';
import BrowserAgentView from './BrowserAgentView';

// Sized as a fraction of the actual screen rather than fixed pixels, so it
// scales sensibly across phone sizes instead of being a tiny fixed box.
// Landscape 4:3 is kept (full page width visible without scrolling
// sideways) but the box itself is much bigger than the old 200x150.
const SCREEN = Dimensions.get('window');
const PIP_WIDTH = Math.round(SCREEN.width * 0.62);
const PIP_HEIGHT = Math.round(PIP_WIDTH * 0.75); // 4:3
const EDGE_MARGIN = 12;

// documentDirectory, not cacheDirectory - meant for durable, on-device
// persistence rather than disposable temp files Android can clear under
// storage pressure. A person expecting "the screenshot it took" to
// actually sit on their phone needs it in durable app storage, matching
// the same documentDirectory pattern chatStore.js already uses for sent
// images.
const SNAPSHOT_DIR = `${FileSystem.documentDirectory}zao-agent-snapshots/`;

// PiP's default overview zoom - deliberately zoomed WAY out (not just
// "fit width") so the whole page is visible at a glance in a small box,
// matching how a real picture-in-picture preview is used ("what's it
// doing right now") rather than "read this text." Fullscreen always
// starts at a normal, readable 100% regardless of whatever the PiP was
// last zoomed to - the two display modes intentionally do NOT share a
// zoom level, since they're used for different things (overview vs.
// actually reading/interacting with the page).
const PIP_ZOOM_PERCENT = 35;
const FULLSCREEN_DEFAULT_ZOOM_PERCENT = 100;

const BrowserAgentPiP = forwardRef(function BrowserAgentPiP(props, ref) {
  const {
    visible = true,
    sessionId,
    conversationId = null,
    isRunning = false,
    fullScreen = false,
    onNavigationStateChange = () => {},
    onExpand = () => {},
  } = props;

  const browserViewRef = useRef(null);
  const pipContainerRef = useRef(null);
  const stepCounterRef = useRef(0);
  // Tracks which mode's zoom was last actively pushed to the shared
  // WebView, so the effect below only re-applies setZoom when the mode
  // actually flips (fullScreen true<->false), not on every unrelated
  // re-render.
  const lastZoomModeRef = useRef(null);

  const pan = useRef(
    new Animated.ValueXY({
      x: SCREEN.width - PIP_WIDTH - EDGE_MARGIN,
      y: EDGE_MARGIN * 6,
    })
  ).current;

  const [minimized, setMinimized] = useState(false);

  const panResponder = useRef(
    PanResponder.create({
      onStartShouldSetPanResponder: () => true,
      onPanResponderMove: Animated.event([null, { dx: pan.x, dy: pan.y }], { useNativeDriver: false }),
      onPanResponderRelease: (_, gesture) => {
        // Snap to nearest horizontal edge, like a real PiP window, so it
        // never sits awkwardly mid-screen over whatever's in the chat.
        const endX = gesture.moveX < SCREEN.width / 2 ? EDGE_MARGIN : SCREEN.width - PIP_WIDTH - EDGE_MARGIN;
        Animated.spring(pan, {
          toValue: { x: endX, y: pan.y._value },
          useNativeDriver: false,
        }).start();
      },
    })
  ).current;

  /**
   * Captures the current PiP frame and persists it as the next ordered
   * snapshot in this session, purely on-device. Called by the agent loop
   * after every action via the onStep callback passed into runTask() -
   * see how this ref is used from BrowserAgentScreen.js / wherever
   * AgentSession is created.
   */
  const captureStep = useCallback(
    async (stepInfo) => {
      if (!pipContainerRef.current || !sessionId) return;
      try {
        const dirInfo = await FileSystem.getInfoAsync(SNAPSHOT_DIR);
        if (!dirInfo.exists) {
          await FileSystem.makeDirectoryAsync(SNAPSHOT_DIR, { intermediates: true });
        }

        const tmpUri = await captureRef(pipContainerRef, {
          format: 'jpg',
          quality: 0.6, // step snapshots are a visual log, kept small
          result: 'tmpfile',
        });

        const stepIndex = stepCounterRef.current;
        stepCounterRef.current += 1;

        // captureRef's 'tmpfile' result writes to a system-managed temp
        // location that react-native-view-shot picks itself, NOT
        // SNAPSHOT_DIR - creating that directory above did nothing useful
        // on its own without this copy step, which is exactly why
        // snapshots weren't actually persisting to the phone before.
        const persistedUri = `${SNAPSHOT_DIR}${sessionId}_${String(stepIndex).padStart(4, '0')}.jpg`;
        await FileSystem.copyAsync({ from: tmpUri, to: persistedUri });
      } catch (err) {
        console.error('[BrowserAgentPiP] capture failed:', err);
      }
    },
    [sessionId]
  );

  useImperativeHandle(ref, () => ({
    getBrowserViewRef: () => browserViewRef,
    captureStep,
    resetStepCounter: () => {
      stepCounterRef.current = 0;
    },
  }));

  // Pushes the mode-appropriate zoom to the (single, shared) WebView every
  // time fullScreen flips - this is what makes the small view "zoomed out
  // so I can see everything" while fullscreen stays at a normal reading
  // zoom, even though both are the exact same WebView instance the whole
  // time. Only fires on an actual mode change (guarded by
  // lastZoomModeRef), so it doesn't fight with an explicit zoom the agent
  // or the person set later via BrowserAgentScreen's zoom control while
  // already in fullscreen.
  useEffect(() => {
    if (!browserViewRef.current) return;
    const mode = fullScreen ? 'full' : 'pip';
    if (lastZoomModeRef.current === mode) return;
    lastZoomModeRef.current = mode;
    const percent = fullScreen ? FULLSCREEN_DEFAULT_ZOOM_PERCENT : PIP_ZOOM_PERCENT;
    browserViewRef.current.setZoom(percent).catch(() => {});
  }, [fullScreen]);

  if (!visible) return null;

  // Full-screen mode: no PiP chrome (drag handle, minimize button), no
  // floating position - BrowserAgentScreen supplies its own address bar
  // and tab strip around this same mounted WebView instance. This is what
  // lets expanding/collapsing between the small live view and the full
  // browser screen be visually seamless with zero loss of page
  // state/cookies/in-progress navigation - it's one BrowserAgentView the
  // whole time, just resized, never unmounted and recreated.
  if (fullScreen) {
    return (
      <View ref={pipContainerRef} collapsable={false} style={StyleSheet.absoluteFill}>
        <BrowserAgentView
          ref={browserViewRef}
          onNavigationStateChange={onNavigationStateChange}
          initialZoomPercent={FULLSCREEN_DEFAULT_ZOOM_PERCENT}
        />
      </View>
    );
  }

  return (
    <Animated.View
      style={[
        styles.container,
        { transform: pan.getTranslateTransform() },
        minimized && styles.containerMinimized,
      ]}
      {...panResponder.panHandlers}
    >
      <View style={styles.header}>
        <TouchableOpacity style={styles.statusRow} onPress={onExpand} activeOpacity={0.7}>
          {isRunning ? <ActivityIndicator size="small" color="#fff" /> : null}
          <Text style={styles.headerText} numberOfLines={1}>
            {isRunning ? 'Agent working…' : 'Browser agent'}
          </Text>
        </TouchableOpacity>
        <TouchableOpacity onPress={() => setMinimized((m) => !m)} hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}>
          <Text style={styles.headerToggle}>{minimized ? '▢' : '—'}</Text>
        </TouchableOpacity>
      </View>

      {!minimized && (
        <View ref={pipContainerRef} collapsable={false} style={styles.viewportWrap}>
          <BrowserAgentView
            ref={browserViewRef}
            onNavigationStateChange={onNavigationStateChange}
            initialZoomPercent={PIP_ZOOM_PERCENT}
          />
        </View>
      )}
    </Animated.View>
  );
});

export default BrowserAgentPiP;

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
  containerMinimized: {
    height: 36,
  },
  header: {
    height: 36,
    paddingHorizontal: 10,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: '#262626',
  },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    flex: 1,
  },
  headerText: {
    color: '#fff',
    fontSize: 12,
    fontWeight: '600',
    flexShrink: 1,
  },
  headerToggle: {
    color: '#fff',
    fontSize: 14,
    paddingLeft: 8,
  },
  viewportWrap: {
    flex: 1,
  },
});
