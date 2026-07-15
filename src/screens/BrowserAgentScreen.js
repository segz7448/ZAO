/**
 * ZAO - Browser Agent Screen
 *
 * The full-screen navigation chrome (address bar, back/forward/reload, tab
 * strip) around the on-device browser. This does NOT own its own
 * BrowserAgentView instance anymore - `browserRef` is passed in from
 * wherever the persistent BrowserAgentPiP lives (App.js), so expanding to
 * full screen and shrinking back to the small live PiP view are the exact
 * same WebView/session the whole time: cookies, current page, and an
 * in-progress AgentSession task all carry over seamlessly either way,
 * rather than this screen silently being a second, independent browser.
 *
 * Stage 1 scope: navigation chrome wired end-to-end so it's independently
 * testable. Stage 2 (agentLoop.js) now drives this same shared browser
 * programmatically via the local coder model's plan/act/observe loop - see
 * src/services/browserAgent/agentLoop.js and BrowserAgentPiP.js.
 */

import React, { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Platform,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useTheme } from '../theme/useTheme';

export default function BrowserAgentScreen({ browserRef, initialUrl, isAgentRunning = false, onClose }) {
  const theme = useTheme();

  const [addressText, setAddressText] = useState(initialUrl || 'https://www.google.com');
  const [currentUrl, setCurrentUrl] = useState(initialUrl || 'https://www.google.com');
  const [loading, setLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [tabs, setTabs] = useState([]);
  const [activeTabId, setActiveTabId] = useState(null);
  const [zoomPercent, setZoomPercent] = useState(100);

  const handleSetZoom = (percent) => {
    setZoomPercent(percent);
    browserRef.current?.setZoom(percent);
  };

  const refreshTabs = useCallback(() => {
    if (browserRef.current) {
      setTabs(browserRef.current.listTabs());
      setActiveTabId(browserRef.current.getActiveTabId());
    }
  }, [browserRef]);

  // The shared BrowserAgentView is mounted once at the App level (inside
  // BrowserAgentPiP) and keeps running whether or not this full-screen
  // chrome is currently visible. Pull its current state in on mount (and
  // whenever this screen re-opens) instead of waiting for a fresh
  // navigation event, since the agent may have already navigated
  // somewhere while this screen was closed.
  useEffect(() => {
    if (initialUrl) {
      setAddressText(initialUrl);
      setCurrentUrl(initialUrl);
    }
    refreshTabs();
  }, [initialUrl, refreshTabs]);

  const handleNavigationStateChange = useCallback((navState) => {
    setCurrentUrl(navState.url);
    setAddressText(navState.url);
    setLoading(navState.loading);
    setCanGoBack(navState.canGoBack);
    setCanGoForward(navState.canGoForward);
    refreshTabs();
  }, [refreshTabs]);

  const handleSubmitAddress = () => {
    browserRef.current?.navigate(addressText.trim());
  };

  const handleNewTab = () => {
    browserRef.current?.newTab('https://www.google.com');
    refreshTabs();
  };

  const handleCloseTab = (tabId) => {
    if (tabs.length <= 1) { return; } // Always keep at least one tab open.
    browserRef.current?.closeTab(tabId);
    refreshTabs();
  };

  const handleSwitchTab = (tabId) => {
    browserRef.current?.switchTab(tabId);
    refreshTabs();
  };

  return (
    <View style={styles.chromeStack} pointerEvents="box-none">
      {/* Status strip - live once the agent loop is actually driving this
          browser (isAgentRunning, passed down from the same AgentSession
          the PiP uses), otherwise a simple mode indicator. */}
      <View style={[styles.statusStrip, { backgroundColor: theme.surfaceAlt, borderBottomColor: theme.border }]}>
        <View style={[styles.statusDot, isAgentRunning && styles.statusDotActive]} />
        <Text style={[styles.statusText, { color: theme.textSecondary }]} numberOfLines={1}>
          {isAgentRunning ? 'ZAO is browsing · tap to take over anytime' : 'On-device browser · you can take over anytime'}
        </Text>
        <TouchableOpacity onPress={onClose} hitSlop={8}>
          <Ionicons name="close" size={22} color={theme.textSecondary} />
        </TouchableOpacity>
      </View>

      {/* Tab strip - only shown once more than one tab is open, keeps the
          chrome minimal for the common single-tab case. */}
      {tabs.length > 1 && (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          style={[styles.tabStrip, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}
        >
          {tabs.map((tab) => (
            <TouchableOpacity
              key={tab.id}
              style={[
                styles.tabChip,
                { backgroundColor: tab.id === activeTabId ? theme.surfaceAlt : 'transparent', borderColor: theme.border },
              ]}
              onPress={() => handleSwitchTab(tab.id)}
            >
              <Text style={[styles.tabChipText, { color: theme.textPrimary }]} numberOfLines={1}>
                {(() => {
                  try { return new URL(tab.url).hostname.replace('www.', ''); }
                  catch (e) { return tab.url; }
                })()}
              </Text>
              <TouchableOpacity onPress={() => handleCloseTab(tab.id)} hitSlop={6} style={styles.tabCloseBtn}>
                <Ionicons name="close" size={14} color={theme.textTertiary} />
              </TouchableOpacity>
            </TouchableOpacity>
          ))}
        </ScrollView>
      )}

      {/* Address bar + nav controls */}
      <View style={[styles.navBar, { backgroundColor: theme.surface, borderBottomColor: theme.border }]}>
        <TouchableOpacity
          onPress={() => browserRef.current?.goBack()}
          disabled={!canGoBack}
          hitSlop={8}
          style={styles.navBtn}
        >
          <Ionicons name="chevron-back" size={22} color={canGoBack ? theme.textPrimary : theme.textTertiary} />
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => browserRef.current?.goForward()}
          disabled={!canGoForward}
          hitSlop={8}
          style={styles.navBtn}
        >
          <Ionicons name="chevron-forward" size={22} color={canGoForward ? theme.textPrimary : theme.textTertiary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => browserRef.current?.reload()} hitSlop={8} style={styles.navBtn}>
          <Ionicons name="refresh" size={19} color={theme.textPrimary} />
        </TouchableOpacity>

        <View style={[styles.addressField, { backgroundColor: theme.surfaceAlt }]}>
          {loading
            ? <ActivityIndicator size="small" color={theme.textTertiary} style={styles.addressIcon} />
            : <Ionicons name="lock-closed" size={13} color={theme.textTertiary} style={styles.addressIcon} />}
          <TextInput
            style={[styles.addressInput, { color: theme.textPrimary }]}
            value={addressText}
            onChangeText={setAddressText}
            onSubmitEditing={handleSubmitAddress}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType={Platform.OS === 'ios' ? 'url' : 'default'}
            returnKeyType="go"
            placeholder="Search or enter address"
            placeholderTextColor={theme.textTertiary}
          />
        </View>

        <TouchableOpacity onPress={handleNewTab} hitSlop={8} style={styles.navBtn}>
          <Ionicons name="add" size={22} color={theme.textPrimary} />
        </TouchableOpacity>

        {/* Zoom controls - fullscreen defaults to 100% (normal reading
            size) and is independent of the small preview's always-zoomed-
            out overview, since the two views are used for different
            things. Tapping these (or the agent being told "zoom to X%")
            re-applies live via BrowserAgentView's setZoom(). */}
        <TouchableOpacity
          onPress={() => handleSetZoom(Math.max(25, zoomPercent - 15))}
          hitSlop={8}
          style={styles.navBtn}
        >
          <Ionicons name="remove-circle-outline" size={20} color={theme.textPrimary} />
        </TouchableOpacity>
        <TouchableOpacity onPress={() => handleSetZoom(100)} hitSlop={8}>
          <Text style={[styles.zoomLabel, { color: theme.textSecondary }]}>{zoomPercent}%</Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => handleSetZoom(Math.min(200, zoomPercent + 15))}
          hitSlop={8}
          style={styles.navBtn}
        >
          <Ionicons name="add-circle-outline" size={20} color={theme.textPrimary} />
        </TouchableOpacity>
      </View>

      {/* No BrowserAgentView (and no opaque background) below this point -
          this component is chrome bars stacked at the top only. The
          actual browser content visible underneath is the single
          persistent BrowserAgentPiP (fullScreen mode), rendered as a
          sibling at a lower position in App.js's tree so it paints first
          and shows through the empty space below these bars. */}
    </View>
  );
}

const styles = StyleSheet.create({
  chromeStack: {
    // No flex:1, no background color - this is a chrome-bars-only overlay
    // stacked at the top of whatever space it's given (App.js positions
    // it via absoluteFill + pointerEvents box-none), leaving everything
    // below transparent so the persistent BrowserAgentPiP (fullScreen
    // mode, rendered as a sibling underneath) shows through untouched.
  },
  statusStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 8,
  },
  statusDot: {
    width: 7,
    height: 7,
    borderRadius: 3.5,
    backgroundColor: '#22C55E',
  },
  statusDotActive: {
    backgroundColor: '#F59E0B',
  },
  statusText: {
    flex: 1,
    fontSize: 12,
    fontWeight: '500',
  },
  tabStrip: {
    flexDirection: 'row',
    paddingHorizontal: 8,
    paddingVertical: 6,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  tabChip: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: StyleSheet.hairlineWidth,
    borderRadius: 8,
    paddingHorizontal: 10,
    paddingVertical: 6,
    marginRight: 6,
    maxWidth: 140,
    gap: 6,
  },
  tabChipText: {
    fontSize: 12,
    flexShrink: 1,
  },
  tabCloseBtn: {
    marginLeft: 2,
  },
  navBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  navBtn: {
    padding: 6,
  },
  addressField: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: 10,
    paddingHorizontal: 10,
    paddingVertical: 7,
    marginHorizontal: 4,
  },
  addressIcon: {
    marginRight: 6,
  },
  addressInput: {
    flex: 1,
    fontSize: 14,
    padding: 0,
  },
  zoomLabel: {
    fontSize: 12,
    fontWeight: '600',
    paddingHorizontal: 4,
    minWidth: 34,
    textAlign: 'center',
  },
});
