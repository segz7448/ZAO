import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, StatusBar, ActivityIndicator, Alert, TouchableOpacity } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import ErrorBoundary from './src/components/ErrorBoundary';
import ChatScreen from './src/screens/ChatScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import BrowserAgentScreen from './src/screens/BrowserAgentScreen';
import PlanScreen from './src/screens/PlanScreen';
import BrowserAgentPiP from './src/services/browserAgent/BrowserAgentPiP';
import { BrowserAgentStream } from './src/services/browserAgent/browserAgentStream';
import SidebarDrawer from './src/components/SidebarDrawer';
import { initDatabase } from './src/db/database';
import { registerBackgroundPlanTask } from './src/services/background/backgroundPlanTask';
import { registerProcessWatcherTask, startForegroundProcessWatch } from './src/services/background/processWatcherTask';
import { initReminderListeners, reconcileReminders } from './src/services/reminders/reminderService';
import { runSessionStartHooks } from './src/services/execution/hooksEngine';
import { useChatStore } from './src/store/chatStore';
import { usePreferencesStore } from './src/store/preferencesStore';
import { usePlanStore } from './src/store/planStore';
import { useThemeStore } from './src/store/themeStore';
import { useTheme, useResolvedThemeMode } from './src/theme/useTheme';

function AppShell() {
  const theme = useTheme();
  const resolvedMode = useResolvedThemeMode();
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState(null);
  const [screen, setScreen] = useState('chat'); // 'chat' | 'settings' | 'browserAgent' | 'plan'
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [isAgentRunning, setIsAgentRunning] = useState(false);
  // Which plan PlanScreen.js is currently showing - set when a chat reply
  // carries a plan_id (see ChatScreen.js's "View Plan" chip) or when a
  // resumable plan from a previous session is opened.
  const [activePlanId, setActivePlanId] = useState(null);

  const {
    conversationId, conversations,
    loadConversationList, loadConversation, startNewConversation, deleteConversation,
    setAgentSession,
  } = useChatStore();
  const { loadThemePreference } = useThemeStore();
  const { preferences, loadPreferences } = usePreferencesStore();
  const {
    approveStep: approvePlanStep, rejectStep: rejectPlanStep,
    acceptCheckpoint: acceptPlanCheckpoint, dismissCheckpoint: dismissPlanCheckpoint,
    startPlan: startPlanAction,
    resumablePlans, autoResumingPlanIds, loadActivePlansOnLaunch, dismissResumablePlan,
  } = usePlanStore();

  // One BrowserAgentStream connection for the whole app lifetime - talks
  // to the Playwright agent running on the person's PC (see
  // server/browserAgent.js, server/browserStream.js) over a WebSocket.
  // The phone itself no longer runs a browser or a decision loop; this is
  // purely a live connection + display, which is what makes "give it a
  // task, then give it a follow-up in the same conversation" work - the
  // PC-side session's page/history state persists across separate tasks
  // the whole time this connection stays open, same continuity guarantee
  // the old on-device AgentSession gave, just held on the PC instead of
  // in this phone's memory.
  const streamRef = useRef(null);
  if (!streamRef.current) {
    streamRef.current = new BrowserAgentStream();
  }
  const [frameBase64, setFrameBase64] = useState(null);
  const [awaitingHuman, setAwaitingHuman] = useState(false);
  const [humanReason, setHumanReason] = useState(null);
  // Full-screen browser zoom, owned here since it's shared between
  // BrowserAgentPiP (renders the actually-zoomed stream) and
  // BrowserAgentScreen (renders the +/- controls that change it) - two
  // sibling components, neither a parent of the other. Starts at 50% on
  // every launch, not wherever a previous session left it.
  const [browserFullScreenZoom, setBrowserFullScreenZoom] = useState(0.5);
  const [streamConnected, setStreamConnected] = useState(false);
  const [streamConnectionError, setStreamConnectionError] = useState(null);

  useEffect(() => {
    (async () => {
      const result = await initDatabase();
      if (result.success) {
        setDbReady(true);
      } else {
        // Even if DB init fails, let the user into the app - individual
        // screens handle missing-DB gracefully rather than blocking entirely.
        console.error('[App] DB init failed:', result.error);
        setDbError(result.error);
        setDbReady(true);
      }
      await loadThemePreference();
      await loadPreferences();
      await loadConversationList();
      // Surfaces any plan left running/paused/awaiting-approval when the
      // app was last closed (src/store/planStore.js's
      // loadActivePlansOnLaunch) - previously tracked correctly in SQLite
      // but never checked, so an interrupted plan just silently vanished
      // from view. Renders as the resume banner below, above ChatScreen.
      await loadActivePlansOnLaunch();
      // Real background continuation for a plan that was still 'running'
      // when the app last closed (see backgroundPlanTask.js's header for
      // exactly what this can and can't guarantee) - registration is
      // idempotent and safe to call on every launch.
      registerBackgroundPlanTask();
      // "Task finished" notifications for pc_process_start-launched
      // background processes (dev servers, long builds) - see
      // processWatcherTask.js's header for exactly what the OS-level
      // background task can and can't guarantee; startForegroundProcessWatch
      // covers the same ground with a near-instant poll while the app is
      // actually open.
      registerProcessWatcherTask();
      startForegroundProcessWatch();
      // Prospective memory (src/services/reminders/reminderService.js) -
      // wire the notification handler/listeners up first, then sweep any
      // reminder that was due while the app was closed (or whose OS-level
      // schedule silently never fired) so ZAO's own record never says
      // "scheduled" for something that has already come and gone.
      initReminderListeners();
      reconcileReminders().catch((err) => console.error('[App] reconcileReminders failed:', err));
      // SessionStart hooks (src/services/execution/hooksEngine.js) - runs
      // once per app launch, after the DB (and therefore any registered
      // hooks) is actually readable. Fire-and-forget: a SessionStart hook
      // failing shouldn't block the person from getting into the app.
      runSessionStartHooks().catch((err) => console.error('[App] SessionStart hooks failed:', err));
    })();
  }, []);

  // Connects the BrowserAgentStream once, at launch, and keeps it
  // connected for the whole app lifetime - registers it into chatStore
  // so sendMessage/editMessage/regenerateMessage can all pass the same
  // connection into the orchestrator (see chatStore.js's
  // setAgentSession). Live frame/status events update local state here
  // so BrowserAgentPiP/BrowserAgentScreen re-render with the latest
  // stream. browserAgentStream.js's own reconnect-on-close handling
  // covers network blips and PC backend restarts.
  //
  // DELIBERATELY NOT gated behind preferences.browser_access_enabled:
  // that preference defaults to false for every install, and
  // orchestrator.js's runBrowsingHandler only flips it to true the
  // first time a browsing-classified message actually finds a live
  // agentSession to use - which never happens if connecting the session
  // in the first place is ALSO waiting on that same preference already
  // being true. That was a real chicken-and-egg deadlock: nothing could
  // ever set the flag, because nothing would connect until the flag was
  // already set. Connecting unconditionally here is what actually makes
  // orchestrator.js's "the request itself is the consent" design work -
  // the preference is purely a synced-after-the-fact display value now,
  // never a precondition for the connection existing.
  useEffect(() => {
    const stream = streamRef.current;
    setAgentSession(stream);
    stream.connect();

    const offStatus = stream.on('status', (s) => {
      setIsAgentRunning(s.running);
      setAwaitingHuman(s.awaitingHuman);
      setHumanReason(s.reason);
    });
    const offFrame = stream.on('frame', (data) => setFrameBase64(data));
    const offConnection = stream.on('connectionChange', ({ connected, error }) => {
      setStreamConnected(connected);
      setStreamConnectionError(error || null);
      if (!connected) setFrameBase64(null); // stale frame would look "live" even though the session behind it is gone
    });

    return () => {
      offStatus();
      offFrame();
      offConnection();
    };
  }, []);

  // Re-attempts the connection whenever the backend connection settings
  // themselves change - the common first-run case is: launch the app
  // (no LAN/Remote URL set yet, so the effect above's connect() attempt
  // fails immediately with "no backend URL configured" and gives up),
  // THEN go to Settings > Backend Connection and actually type one in.
  // Without this, nothing would ever retry until the next full app
  // restart even though the person just fixed the exact thing that was
  // missing. connect() itself already no-ops safely if a connection is
  // already open/connecting, so this is safe to fire on every
  // preferences change, not just the first one.
  useEffect(() => {
    if (preferences?.backend_lan_url || preferences?.backend_remote_url) {
      streamRef.current.connect();
    }
  }, [preferences?.backend_mode, preferences?.backend_lan_url, preferences?.backend_remote_url, preferences?.backend_auth_token]);

  const handleNewChat = async () => {
    setSidebarVisible(false);
    setScreen('chat');
    await startNewConversation();
  };

  const handleSelectConversation = async (id) => {
    setSidebarVisible(false);
    setScreen('chat');
    await loadConversation(id);
  };

  const handleOpenSettings = () => {
    setSidebarVisible(false);
    setScreen('settings');
  };

  // Opens PlanScreen.js at a given plan id - called from ChatScreen.js's
  // "View Plan" chip (a reply produced by the hierarchical planning
  // system, see src/services/brain/backendBrain.js) or from a resumable
  // plan surfaced at launch (planStore.js's loadActivePlansOnLaunch).
  const handleOpenPlan = (planId) => {
    setActivePlanId(planId);
    setScreen('plan');
  };

  const handleClosePlan = () => {
    setScreen('chat');
  };

  const handleCancelPlan = (planId) => {
    usePlanStore.getState().cancelPlan(planId);
  };

  // Called by ChatScreen (or the PiP's tap-to-expand) to show the
  // full-screen browser agent view. This does NOT create a new connection -
  // it just swaps BrowserAgentPiP's own display mode to fullScreen, so
  // it's the exact same stream, mid-task state and all, just resized. If a
  // starting url was given (e.g. "open X and do Y"), it's sent as a task
  // rather than a direct navigation - there's no raw "go to this URL" call
  // anymore since the PC agent drives its own navigation.
  const handleOpenBrowserAgent = (url) => {
    if (url) {
      streamRef.current.runTask(`Go to ${url}`);
    }
    setScreen('browserAgent');
  };

  const handleCloseBrowserAgent = () => {
    setScreen('chat');
  };

  const handleDeleteConversation = (conversation) => {
    Alert.alert(
      'Delete conversation?',
      `"${conversation.title || 'New Conversation'}" will be permanently deleted.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => deleteConversation(conversation.id),
        },
      ]
    );
  };

  if (!dbReady) {
    return (
      <SafeAreaView style={[styles.loadingContainer, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.textPrimary} />
        <Text style={[styles.loadingText, { color: theme.textTertiary }]}>Starting ZAO…</Text>
      </SafeAreaView>
    );
  }

  return (
    <>
      <StatusBar barStyle={theme.statusBarStyle} backgroundColor={theme.background} />
      <SafeAreaView style={[styles.container, { backgroundColor: theme.background }]} edges={['top']}>
        {dbError && (
          <View style={[styles.dbErrorBanner, { backgroundColor: '#FEF3C7' }]}>
            <Text style={styles.dbErrorText}>
              Local storage had trouble starting. Some features may not save properly.
            </Text>
          </View>
        )}
        {/* Resume banner - only ever shown on the chat screen, and only
            for plans loadActivePlansOnLaunch() found still in a
            non-terminal state from a previous app session. Tapping opens
            PlanScreen at that plan; the X dismisses just this banner for
            the rest of the session (see planStore.js's
            dismissResumablePlan - doesn't touch the plan's own status,
            so it's still reachable later from Plan History). */}
        {/* Plans genuinely awaiting a human decision (awaiting_approval /
            paused) still show the tap-to-open banner above. Plans merely
            'running' when the app closed don't need a decision, so
            loadActivePlansOnLaunch() (planStore.js) resumes them
            automatically instead - this is just a visible "here's what's
            happening" indicator for that, not a control. */}
        {screen === 'chat' && autoResumingPlanIds.length > 0 && (
          <View style={[styles.resumeBanner, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}>
            <View style={styles.resumeBannerContent}>
              <Text style={[styles.resumeBannerTitle, { color: theme.textPrimary }]} numberOfLines={1}>
                Resuming {autoResumingPlanIds.length > 1 ? `${autoResumingPlanIds.length} plans` : 'a plan'} from before the app closed…
              </Text>
              <Text style={[styles.resumeBannerSubtitle, { color: theme.textTertiary }]}>
                It'll pause automatically if it hits anything needing your approval.
              </Text>
            </View>
          </View>
        )}

        {screen === 'chat' && resumablePlans.length > 0 && (
          <View style={[styles.resumeBanner, { backgroundColor: theme.surfaceAlt, borderColor: theme.border }]}>
            <TouchableOpacity
              style={styles.resumeBannerContent}
              onPress={() => handleOpenPlan(resumablePlans[0].id)}
              activeOpacity={0.7}
            >
              <Text style={[styles.resumeBannerTitle, { color: theme.textPrimary }]} numberOfLines={1}>
                Resume plan: {resumablePlans[0].goal || 'Untitled plan'}
              </Text>
              <Text style={[styles.resumeBannerSubtitle, { color: theme.textTertiary }]}>
                {resumablePlans.length > 1
                  ? `Left ${resumablePlans[0].status} - ${resumablePlans.length - 1} more waiting`
                  : `Left ${resumablePlans[0].status} when the app last closed`}
              </Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={styles.resumeBannerDismiss}
              onPress={() => dismissResumablePlan(resumablePlans[0].id)}
            >
              <Text style={[styles.resumeBannerDismissText, { color: theme.textTertiary }]}>✕</Text>
            </TouchableOpacity>
          </View>
        )}

        <View style={styles.screenContainer}>
          {screen === 'chat' && (
            <ChatScreen
              onOpenSidebar={() => setSidebarVisible(true)}
              onOpenBrowserAgent={handleOpenBrowserAgent}
              onOpenPlan={handleOpenPlan}
              browserAgentActive={screen === 'browserAgent' || isAgentRunning || awaitingHuman}
            />
          )}
          {screen === 'settings' && (
            <SettingsScreen onOpenSidebar={() => setSidebarVisible(true)} />
          )}
          {screen === 'plan' && (
            <PlanScreen
              planId={activePlanId}
              onClose={handleClosePlan}
              onApproveStep={(step, stepPlanId) => approvePlanStep(step, stepPlanId || activePlanId)}
              onRejectStep={(step, stepPlanId) => rejectPlanStep(step, stepPlanId || activePlanId)}
              onCancelPlan={handleCancelPlan}
              onAcceptCheckpoint={(checkpointPlanId) => acceptPlanCheckpoint(checkpointPlanId)}
              onDismissCheckpoint={(checkpointPlanId) => dismissPlanCheckpoint(checkpointPlanId)}
              onStartPlan={(planId) => startPlanAction(planId)}
            />
          )}
        </View>
      </SafeAreaView>

      {/* The single persistent BrowserAgentPiP instance - rendered exactly
          once, at this stable position in the tree, mounted for the
          entire app lifetime (NOT conditional on
          preferences.browser_access_enabled - see the connection effect
          above for why that preference can no longer gate anything: it
          only ever becomes true AFTER a browsing task has already run
          once, so gating rendering on it meant a person's very first
          browsing task ran completely invisibly - no live view, and
          critically no way to see or respond to a needsHuman/CAPTCHA
          prompt. `visible` below controls whether it's actually shown,
          separately from whether it's mounted, so there's still no
          floating clutter for someone who's never touched browsing:
          it appears once there's something to see (a task running or
          awaiting input), once the person's explicitly opened the full
          screen, or once browsing has been used before). Only its
          `fullScreen` prop changes after that (resizing/repositioning
          the same live stream display), never conditionally mounted/
          unmounted based on `screen`. This is what keeps a single
          WebSocket connection (and the PC-side Playwright session/
          history it's attached to) alive across expanding to full
          screen and back, and across separate browsing tasks given
          later in the same conversation. Rendered here (outside
          SafeAreaView, above the chrome overlay below in JSX order) so
          full-screen mode isn't clipped by safe-area edges and paints
          underneath the chrome. */}
      <BrowserAgentPiP
        visible={isAgentRunning || awaitingHuman || screen === 'browserAgent' || !!preferences?.browser_access_enabled}
        stream={streamRef.current}
        fullScreen={screen === 'browserAgent'}
        fullScreenZoom={browserFullScreenZoom}
        isRunning={isAgentRunning}
        awaitingHuman={awaitingHuman}
        humanReason={humanReason}
        frameBase64={frameBase64}
        connected={streamConnected}
        connectionError={streamConnectionError}
        onExpand={() => setScreen('browserAgent')}
        onResumeAfterHuman={() => streamRef.current.resumeAfterHuman()}
      />

      {/* Full-screen browser chrome (status strip, task input) - drawn as
          chrome ONLY, layered on top of the BrowserAgentPiP above (later
          in JSX order = painted on top) since it does not render its own
          copy of the live view - it shares the same stream connection the
          PiP already owns. Rendered once and kept mounted for the app's
          lifetime unconditionally (same reasoning as BrowserAgentPiP
          above - gating this on browser_access_enabled meant tapping
          through to the full-screen view before that flag was ever set
          rendered nothing at all), only hidden via pointerEvents + a
          conditional wrapper style rather than being unmounted when
          `screen` leaves 'browserAgent', so any in-progress typed task
          text isn't lost on a quick back-and-forth. */}
      <View
        style={screen === 'browserAgent' ? StyleSheet.absoluteFill : styles.offscreen}
        pointerEvents={screen === 'browserAgent' ? 'box-none' : 'none'}
      >
        <BrowserAgentScreen
          stream={streamRef.current}
          isAgentRunning={isAgentRunning}
          awaitingHuman={awaitingHuman}
          zoom={browserFullScreenZoom}
          onZoomChange={setBrowserFullScreenZoom}
          onClose={handleCloseBrowserAgent}
        />
      </View>

      <SidebarDrawer
        visible={sidebarVisible}
        onClose={() => setSidebarVisible(false)}
        conversations={conversations}
        activeConversationId={conversationId}
        onSelectConversation={handleSelectConversation}
        onNewChat={handleNewChat}
        onOpenSettings={handleOpenSettings}
        onDeleteConversation={handleDeleteConversation}
      />
    </>
  );
}

export default function App() {
  return (
    <ErrorBoundary>
      <SafeAreaProvider>
        <AppShell />
      </SafeAreaProvider>
    </ErrorBoundary>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
  },
  loadingContainer: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  loadingText: {
    marginTop: 12,
    fontSize: 14,
  },
  screenContainer: {
    flex: 1,
  },
  dbErrorBanner: {
    paddingVertical: 6,
    paddingHorizontal: 16,
  },
  dbErrorText: {
    fontSize: 12,
    color: '#92400E',
    textAlign: 'center',
  },
  resumeBanner: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: 12,
    marginTop: 8,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 12,
    borderWidth: 1,
  },
  resumeBannerContent: {
    flex: 1,
  },
  resumeBannerTitle: {
    fontSize: 13,
    fontWeight: '700',
  },
  resumeBannerSubtitle: {
    fontSize: 12,
    marginTop: 2,
  },
  resumeBannerDismiss: {
    paddingLeft: 12,
    paddingVertical: 4,
  },
  resumeBannerDismissText: {
    fontSize: 16,
    fontWeight: '600',
  },
  // Keeps BrowserAgentScreen mounted (so its address-bar/tab-strip state
  // survives) while visually and interactively out of the way when the
  // person isn't looking at it. Off-screen rather than opacity:0 so it
  // never intercepts touches meant for the chat screen underneath.
  offscreen: {
    position: 'absolute',
    top: -10000,
    left: 0,
    width: 1,
    height: 1,
    overflow: 'hidden',
  },
});
