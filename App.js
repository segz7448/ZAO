import React, { useEffect, useState, useRef } from 'react';
import { View, Text, StyleSheet, StatusBar, ActivityIndicator, Alert } from 'react-native';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import ErrorBoundary from './src/components/ErrorBoundary';
import ChatScreen from './src/screens/ChatScreen';
import SettingsScreen from './src/screens/SettingsScreen';
import BrowserAgentScreen from './src/screens/BrowserAgentScreen';
import BrowserAgentPiP from './src/services/browserAgent/BrowserAgentPiP';
import { AgentSession } from './src/services/browserAgent/agentLoop';
import SidebarDrawer from './src/components/SidebarDrawer';
import { initDatabase } from './src/db/database';
import { useChatStore } from './src/store/chatStore';
import { usePreferencesStore } from './src/store/preferencesStore';
import { useThemeStore } from './src/store/themeStore';
import { useTheme, useResolvedThemeMode } from './src/theme/useTheme';

function AppShell() {
  const theme = useTheme();
  const resolvedMode = useResolvedThemeMode();
  const [dbReady, setDbReady] = useState(false);
  const [dbError, setDbError] = useState(null);
  const [screen, setScreen] = useState('chat'); // 'chat' | 'settings' | 'browserAgent'
  const [sidebarVisible, setSidebarVisible] = useState(false);
  const [browserAgentUrl, setBrowserAgentUrl] = useState(null);
  const [isAgentRunning, setIsAgentRunning] = useState(false);

  const {
    conversationId, conversations,
    loadConversationList, loadConversation, startNewConversation, deleteConversation,
    setAgentSession,
  } = useChatStore();
  const { loadThemePreference } = useThemeStore();
  const { preferences, loadPreferences } = usePreferencesStore();

  // One BrowserAgentPiP instance for the whole app lifetime - this is the
  // "zero server" on-device browser: a single real WebView (held inside
  // BrowserAgentPiP, referenced here only for imperative calls like
  // getBrowserViewRef) that survives screen changes, chat switches, and
  // repeated browsing tasks in the same conversation. See
  // src/services/browserAgent/agentLoop.js's AgentSession docstring for
  // why a single persistent instance (rather than one per task) is what
  // makes "give it a task, then give it a follow-up in the same
  // conversation" actually work - the second task picks up on whatever
  // page/session state the first one left behind.
  const pipRef = useRef(null);
  const agentSessionRef = useRef(null);

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
    })();
  }, []);

  // Creates the one AgentSession for the app's lifetime once the PiP's
  // underlying BrowserAgentView has actually mounted, and registers it
  // into chatStore so sendMessage/editMessage/regenerateMessage can all
  // pass the same session into the orchestrator (see chatStore.js's
  // setAgentSession - the store can't hold a React ref directly itself).
  // Only created if browser access is enabled at all; if the person turns
  // it on later, this effect re-runs and creates it then.
  const [pipMounted, setPipMounted] = useState(false);

  useEffect(() => {
    if (!preferences?.browser_access_enabled || !pipRef.current || agentSessionRef.current) {
      return;
    }
    const browserViewRef = pipRef.current.getBrowserViewRef();
    agentSessionRef.current = new AgentSession(browserViewRef, pipRef);
    setAgentSession(agentSessionRef.current);
    const unsubscribe = agentSessionRef.current.onRunningChange(setIsAgentRunning);
    return unsubscribe;
    // pipMounted is a dummy dependency with no real value read - its only
    // purpose is forcing this effect to re-run the instant BrowserAgentPiP
    // actually mounts and sets pipRef.current, since that ref is still
    // null on this component's very first render (refs aren't reactive by
    // themselves) and preferences/dbReady alone won't necessarily change
    // again afterward to re-trigger this check.
  }, [preferences?.browser_access_enabled, dbReady, pipMounted]);

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

  // Called by ChatScreen (or the PiP's tap-to-expand) to show the
  // full-screen browser chrome. This does NOT create a new browser - it
  // just swaps BrowserAgentPiP's own display mode to fullScreen, so it's
  // the exact same WebView, mid-navigation state and all, just resized.
  const handleOpenBrowserAgent = (url) => {
    if (url && pipRef.current) {
      pipRef.current.getBrowserViewRef().current?.navigate(url);
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
        <View style={styles.screenContainer}>
          {screen === 'chat' && (
            <ChatScreen onOpenSidebar={() => setSidebarVisible(true)} onOpenBrowserAgent={handleOpenBrowserAgent} />
          )}
          {screen === 'settings' && (
            <SettingsScreen onOpenSidebar={() => setSidebarVisible(true)} />
          )}
        </View>
      </SafeAreaView>

      {/* The single persistent BrowserAgentPiP instance - rendered exactly
          once, at this stable position in the tree, for the entire app
          lifetime once browser access is turned on. It is NEVER rendered
          a second time anywhere else and never conditionally
          mounted/unmounted based on `screen` - only its `fullScreen` prop
          changes, which resizes/repositions the same underlying
          BrowserAgentView rather than tearing it down and recreating it.
          This is what preserves cookies/current page/in-progress
          AgentSession state across expanding to full screen and back, and
          across separate browsing tasks given later in the same
          conversation. Rendered here (outside SafeAreaView, above the
          chrome overlay below in JSX order) so full-screen mode isn't
          clipped by safe-area edges and paints underneath the chrome. */}
      {!!preferences?.browser_access_enabled && (
        <BrowserAgentPiP
          ref={(instance) => {
            pipRef.current = instance;
            if (instance && !pipMounted) setPipMounted(true);
          }}
          visible
          fullScreen={screen === 'browserAgent'}
          sessionId={agentSessionRef.current ? conversationId || 'no-conversation' : null}
          conversationId={conversationId}
          isRunning={isAgentRunning}
          onExpand={() => setScreen('browserAgent')}
        />
      )}

      {/* Full-screen browser chrome (address bar, tabs, back/forward) -
          drawn as chrome ONLY, layered on top of the BrowserAgentPiP
          above (later in JSX order = painted on top) since it does not
          contain or render its own copy of the browser view - browserRef
          here just lets its controls (address bar submit, tab switch,
          etc.) act on the same live WebView the PiP already owns. */}
      {/* Rendered once and kept mounted for the app's lifetime (same
          pattern as BrowserAgentPiP above), only hidden via pointerEvents
          + a conditional wrapper style rather than being unmounted when
          `screen` leaves 'browserAgent'. BrowserAgentScreen keeps its own
          local state (address bar text, tab strip) - unmounting it every
          time the person backed out reset that chrome to
          google.com/no-tabs on reopen, even though the underlying WebView
          (owned by the persistent BrowserAgentPiP) never actually lost its
          page. Conditionally mounting only the *rendering*, not the
          component itself, fixes that without changing anything about how
          the shared WebView/session works. */}
      {!!preferences?.browser_access_enabled && (
        <View
          style={screen === 'browserAgent' ? StyleSheet.absoluteFill : styles.offscreen}
          pointerEvents={screen === 'browserAgent' ? 'box-none' : 'none'}
        >
          <BrowserAgentScreen
            browserRef={pipRef.current?.getBrowserViewRef() || { current: null }}
            initialUrl={browserAgentUrl}
            isAgentRunning={isAgentRunning}
            onClose={handleCloseBrowserAgent}
          />
        </View>
      )}

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
