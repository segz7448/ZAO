import React, { useState, useEffect } from 'react';
import {
  View,
  Text,
  TouchableOpacity,
  TextInput,
  ScrollView,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Modal,
  FlatList,
  Switch,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Clipboard from 'expo-clipboard';
import { usePreferencesStore } from '../store/preferencesStore';
import { useThemeStore } from '../store/themeStore';
import { useTheme } from '../theme/useTheme';
import { checkBackendHealth } from '../services/backend/backendClient';
import {
  getUsageCounts,
  getRecentUsageEvents,
  getAllMemories,
  updateMemory,
  deactivateMemory,
  hardDeleteMemory,
  clearAllMemories,
  getRecentCheckpoints,
  getHooks,
  createHook,
  setHookEnabled,
  deleteHook,
  getWorktreeSessions,
} from '../db/database';
import { ACTIVE_MODEL } from '../config/localModels';
import { rewindToCheckpoint } from '../services/filesystem/filesystemTool';
import { closeWorktreeSession } from '../services/execution/worktrees';
import { getRecentSpans } from '../services/execution/telemetry';
import { PERMISSION_MODES } from '../services/execution/permissionModes';
import { listReminders, cancelReminder, forgetReminder } from '../services/reminders/reminderService';
import { BRAIN_ARCHITECTURES, BRAIN_ARCHITECTURE_LABELS, ZAO_BRAIN_PROFILE } from '../services/brain/brainTypes';
import { MEMORY_TYPES, ZAO_MEMORY_PROFILE } from '../services/memory/memoryTypes';

function GithubCredentialsSection({ status, onSaveUsername, onSaveToken, onRemove, theme }) {
  const [usernameValue, setUsernameValue] = useState(status.username || '');
  const [tokenValue, setTokenValue] = useState('');
  const [editing, setEditing] = useState(false);
  const [testing, setTesting] = useState(false);

  const handleTestAndSave = async () => {
    if (!usernameValue.trim() || !tokenValue.trim()) return;
    setTesting(true);
    try {
      const { verifyToken } = await import('../services/github/githubTool');
      const result = await verifyToken(tokenValue.trim());
      if (result.valid) {
        // Save the username the person typed, not result.username, in
        // case they're intentionally managing repos under an
        // organization they belong to rather than their own login - the
        // token verification just confirms the token itself works, not
        // that this exact string has to match the token owner's login.
        await onSaveUsername(usernameValue.trim());
        await onSaveToken(tokenValue.trim());
        setEditing(false);
        setTokenValue('');
        Alert.alert('Connected', `GitHub token verified (authenticated as ${result.username}).`);
      } else {
        Alert.alert(
          'Connection failed',
          result.error?.message || 'Could not verify this token. Check it and try again.'
        );
      }
    } catch (err) {
      Alert.alert('Error', 'Something went wrong testing this token. Please try again.');
    } finally {
      setTesting(false);
    }
  };

  const handleRemove = () => {
    Alert.alert(
      'Remove GitHub access?',
      'This removes your GitHub username and token. The local coder model won\'t be able to create repos, commit, or push until you add them again.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Remove', style: 'destructive', onPress: onRemove },
      ]
    );
  };

  return (
    <View style={styles.keyRow}>
      <View style={styles.keyRowHeader}>
        <Text style={[styles.keyLabel, { color: theme.textPrimary }]}>GitHub</Text>
        <View style={[styles.statusPill, { backgroundColor: status.configured ? '#DCFCE7' : theme.surfaceAlt }]}>
          <Text style={[styles.statusPillText, { color: status.configured ? '#166534' : theme.textSecondary }]}>
            {status.configured ? `Connected · ${status.username}` : 'Not set'}
          </Text>
        </View>
      </View>

      {editing ? (
        <View>
          <TextInput
            style={[styles.keyInput, { borderColor: theme.borderStrong, color: theme.textPrimary }]}
            value={usernameValue}
            onChangeText={setUsernameValue}
            placeholder="GitHub username"
            placeholderTextColor={theme.textTertiary}
            autoCapitalize="none"
            autoCorrect={false}
          />
          <TextInput
            style={[styles.keyInput, { borderColor: theme.borderStrong, color: theme.textPrimary, marginTop: 8 }]}
            value={tokenValue}
            onChangeText={setTokenValue}
            placeholder="Personal access token (repo scope)"
            placeholderTextColor={theme.textTertiary}
            secureTextEntry
            autoCapitalize="none"
            autoCorrect={false}
          />
          <View style={styles.keyRowButtons}>
            <TouchableOpacity
              style={styles.keySecondaryBtn}
              onPress={() => { setEditing(false); setTokenValue(''); setUsernameValue(status.username || ''); }}
            >
              <Text style={[styles.keySecondaryBtnText, { color: theme.textSecondary }]}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[
                styles.keyPrimaryBtn,
                { backgroundColor: theme.accent },
                (!usernameValue.trim() || !tokenValue.trim() || testing) && { backgroundColor: theme.borderStrong },
              ]}
              onPress={handleTestAndSave}
              disabled={!usernameValue.trim() || !tokenValue.trim() || testing}
            >
              {testing
                ? <ActivityIndicator size="small" color={theme.textInverse} />
                : <Text style={[styles.keyPrimaryBtnText, { color: theme.textInverse }]}>Test & Save</Text>}
            </TouchableOpacity>
          </View>
        </View>
      ) : (
        <View style={styles.keyRowButtons}>
          {status.configured && (
            <TouchableOpacity style={styles.keySecondaryBtn} onPress={handleRemove}>
              <Text style={[styles.keyRemoveBtnText, { color: theme.danger }]}>Remove</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity style={styles.keyEditBtn} onPress={() => setEditing(true)}>
            <Text style={[styles.keyEditBtnText, { color: theme.info }]}>
              {status.configured ? 'Update' : 'Connect GitHub'}
            </Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function FilesystemAccessSection({ preferences, theme }) {
  const [requesting, setRequesting] = useState(false);
  const grantFilesystemAccess = usePreferencesStore((s) => s.grantFilesystemAccess);

  const granted = !!preferences?.filesystem_saf_uri;

  const handleGrantAccess = async () => {
    setRequesting(true);
    try {
      // grantFilesystemAccess() (preferencesStore.js) both requests the
      // SAF permission AND reloads the store afterward, so `preferences`
      // here (and the "Granted" pill below) update immediately instead of
      // only reflecting the new URI after the app is restarted.
      const result = await grantFilesystemAccess();
      if (!result.success) {
        Alert.alert('Access not granted', result.error?.message || 'Folder access was not granted.');
      }
    } catch (err) {
      Alert.alert('Error', 'Something went wrong requesting folder access.');
    } finally {
      setRequesting(false);
    }
  };

  return (
    <View style={styles.keyRow}>
      <View style={styles.keyRowHeader}>
        <Text style={[styles.keyLabel, { color: theme.textPrimary }]}>Device folder access</Text>
        <View style={[styles.statusPill, { backgroundColor: granted ? '#DCFCE7' : theme.surfaceAlt }]}>
          <Text style={[styles.statusPillText, { color: granted ? '#166534' : theme.textSecondary }]}>
            {granted ? 'Granted' : 'Not granted'}
          </Text>
        </View>
      </View>
      <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 4 }]}>
        {granted
          ? 'ZAO can create, move, rename, delete, zip, and extract files inside the folder you granted. Grant a different folder anytime below.'
          : 'Android requires granting access to a specific folder before ZAO can manage files on your device (create, move, rename, delete, zip, extract). This is a one-time system permission - pick a folder like Download to give ZAO room to work in.'}
      </Text>
      <TouchableOpacity
        style={[styles.keyEditBtn, { marginTop: 12 }]}
        onPress={handleGrantAccess}
        disabled={requesting}
      >
        {requesting
          ? <ActivityIndicator size="small" color={theme.info} />
          : <Text style={[styles.keyEditBtnText, { color: theme.info }]}>{granted ? 'Change folder' : 'Grant folder access'}</Text>}
      </TouchableOpacity>
    </View>
  );
}

/**
 * Termux terminal setup section - the lightweight/fallback terminal that
 * runs directly on the phone (see termuxTerminalTool.js), used
 * automatically when the PC backend is unreachable or offline, and for
 * small fast tasks even when the PC is available (see terminalRouter.js
 * and toolOrchestrator.js for how the model chooses between this and the
 * PC terminal). This is separate from the PC backend connection above -
 * both can be set up independently, and only this one needs anything
 * done on the phone itself.
 */
function TerminalSetupSection({ theme }) {
  const [termuxInstalled, setTermuxInstalled] = useState(null); // null = unknown, true/false once checked
  const [checking, setChecking] = useState(false);

  const checkStatus = async () => {
    setChecking(true);
    try {
      const { isTermuxInstalled } = await import('../services/terminal/termuxTerminalTool');
      const result = await isTermuxInstalled();
      setTermuxInstalled(result);
    } catch (err) {
      setTermuxInstalled(null);
    } finally {
      setChecking(false);
    }
  };

  useEffect(() => {
    checkStatus();
  }, []);

  const handleOpenTermux = async () => {
    try {
      const { openTermuxForSetup } = await import('../services/terminal/termuxTerminalTool');
      const result = await openTermuxForSetup();
      if (!result.success) {
        Alert.alert('Could not open Termux', result.error?.message || 'Termux may not be installed.');
      }
    } catch (err) {
      Alert.alert('Error', 'Something went wrong opening Termux.');
    }
  };

  const handleCopySetupCommand = async () => {
    try {
      const { getSetupCommand } = await import('../services/terminal/termuxTerminalTool');
      const command = getSetupCommand();
      await Clipboard.setStringAsync(command);
      Alert.alert(
        'Copied',
        'Paste this into Termux and hit enter, once. After that, ZAO can dispatch commands to Termux (Android will still show a one-time permission prompt the first time).'
      );
    } catch (err) {
      Alert.alert('Error', 'Could not copy the setup command.');
    }
  };

  const statusPillStyle =
    termuxInstalled === true
      ? { backgroundColor: '#D1FAE5', textColor: '#065F46', label: 'Termux found - run setup command below' }
      : termuxInstalled === false
      ? { backgroundColor: '#FEE2E2', textColor: '#991B1B', label: 'Termux not installed' }
      : { backgroundColor: '#FEF3C7', textColor: '#92400E', label: 'Checking...' };

  return (
    <View style={styles.keyRow}>
      <View style={styles.keyRowHeader}>
        <Text style={[styles.keyLabel, { color: theme.textPrimary }]}>Termux (lightweight / fallback)</Text>
        <View style={[styles.statusPill, { backgroundColor: statusPillStyle.backgroundColor }]}>
          <Text style={[styles.statusPillText, { color: statusPillStyle.textColor }]}>{statusPillStyle.label}</Text>
        </View>
      </View>
      <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 4 }]}>
        ZAO's second terminal, running directly on this phone. Used automatically when the PC backend above is unreachable or offline, and for small fast tasks (git pull, quick npm install, simple scripts) even when the PC is available. One-time setup, per device: paste one command into Termux, accept one Android permission prompt, and ZAO's agent can use it freely after that.
      </Text>

      {termuxInstalled === false ? (
        <TouchableOpacity style={[styles.keyEditBtn, { marginTop: 12 }]} onPress={handleOpenTermux}>
          <Text style={[styles.keyEditBtnText, { color: theme.info }]}>Install Termux (opens F-Droid/GitHub link)</Text>
        </TouchableOpacity>
      ) : (
        <>
          <TouchableOpacity style={[styles.keyEditBtn, { marginTop: 12 }]} onPress={handleCopySetupCommand}>
            <Text style={[styles.keyEditBtnText, { color: theme.info }]}>Copy one-time setup command</Text>
          </TouchableOpacity>
          <TouchableOpacity style={[styles.keyEditBtn, { marginTop: 8 }]} onPress={handleOpenTermux}>
            <Text style={[styles.keyEditBtnText, { color: theme.info }]}>Open Termux</Text>
          </TouchableOpacity>
        </>
      )}

      {checking ? null : (
        <TouchableOpacity onPress={checkStatus} style={{ marginTop: 8 }}>
          <Text style={[styles.helperText, { color: theme.textSecondary, textDecorationLine: 'underline' }]}>Re-check status</Text>
        </TouchableOpacity>
      )}
    </View>
  );
}

/**
 * Backend connection section - the backend now runs on the person's PC
 * (see /server in the repo root, started via start.bat) instead of
 * on-device in Termux. This section covers everything needed to reach it:
 *   - LAN / Remote toggle (manual, not auto-detected - see
 *     backendClient.js for why)
 *   - LAN URL: the PC's local IP:port, e.g. http://192.168.1.42:8080
 *   - Remote URL: the Cloudflare Quick Tunnel URL shown in the PC's
 *     "ZAO Cloudflare Tunnel" window on startup. This ROTATES every time
 *     start.bat is re-run (free *.trycloudflare.com URL, not a permanent
 *     named tunnel), so it needs re-pasting here each time before Remote
 *     mode will work again.
 *   - Auth token: must match AUTH_TOKEN in the PC's server/config.js.
 * Also covers the PC terminal tool, which runs through this same
 * connection (cmd.exe on the PC via /terminal/run). The phone's Termux
 * terminal is a separate fallback/lightweight tool - see
 * TerminalSetupSection above for its own one-time setup.
 */
function BackendConnectionSection({ preferences, theme }) {
  const setBackendMode = usePreferencesStore((s) => s.setBackendMode);
  const setBackendLanUrl = usePreferencesStore((s) => s.setBackendLanUrl);
  const setBackendRemoteUrl = usePreferencesStore((s) => s.setBackendRemoteUrl);
  const setBackendAuthToken = usePreferencesStore((s) => s.setBackendAuthToken);

  const savedMode = preferences?.backend_mode || 'lan';
  // Local "draft" mode - lets the person pick LAN or Remote and fill in
  // its fields before anything is written to the store/DB. Only Save
  // commits it. Re-syncs from the saved value whenever it changes
  // underneath us (e.g. preferences reload).
  const [mode, setMode] = useState(savedMode);
  const [lanUrlValue, setLanUrlValue] = useState(preferences?.backend_lan_url || '');
  const [remoteUrlValue, setRemoteUrlValue] = useState(preferences?.backend_remote_url || '');
  const [tokenValue, setTokenValue] = useState(preferences?.backend_auth_token || '');
  const [status, setStatus] = useState({ connected: false, ready: false, model: null });
  const [checking, setChecking] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setMode(savedMode);
    setLanUrlValue(preferences?.backend_lan_url || '');
    setRemoteUrlValue(preferences?.backend_remote_url || '');
    setTokenValue(preferences?.backend_auth_token || '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preferences?.backend_mode, preferences?.backend_lan_url, preferences?.backend_remote_url, preferences?.backend_auth_token]);

  const check = async () => {
    setChecking(true);
    const result = await checkBackendHealth();
    setStatus(result);
    setChecking(false);
  };

  useEffect(() => {
    check();
  }, [savedMode, preferences?.backend_lan_url, preferences?.backend_remote_url]);

  // Anything unsaved? Compares the draft against what's actually
  // persisted, so the Save button only lights up when there's something
  // to commit and "Check again" always reflects the last SAVED settings,
  // not whatever's mid-edit in the boxes.
  const isDirty =
    mode !== savedMode ||
    (mode === 'lan' ? lanUrlValue.trim() !== (preferences?.backend_lan_url || '') : remoteUrlValue.trim() !== (preferences?.backend_remote_url || '')) ||
    tokenValue.trim() !== (preferences?.backend_auth_token || '');

  const handleSave = async () => {
    setSaving(true);
    await setBackendMode(mode);
    if (mode === 'lan') {
      // Let people type a bare IP:port - no need to remember the http://
      // prefix. If they do include a scheme (http:// or https://), leave
      // it alone.
      let url = lanUrlValue.trim();
      if (url && !/^https?:\/\//i.test(url)) url = `http://${url}`;
      await setBackendLanUrl(url);
    } else {
      await setBackendRemoteUrl(remoteUrlValue.trim());
    }
    await setBackendAuthToken(tokenValue.trim());
    setSaving(false);
    check();
  };

  const pillColor = status.ready ? '#DCFCE7' : status.connected ? '#FEF3C7' : '#FEE2E2';
  const pillTextColor = status.ready ? '#166534' : status.connected ? '#92400E' : '#991B1B';
  const pillLabel = checking
    ? 'Checking…'
    : status.ready
    ? `Connected · ${status.model || ACTIVE_MODEL.label}`
    : status.connected
    ? 'Connected · model loading'
    : 'Not connected';

  return (
    <View style={styles.keyRow}>
      <View style={styles.keyRowHeader}>
        <Text style={[styles.keyLabel, { color: theme.textPrimary }]}>PC backend</Text>
        {checking ? (
          <ActivityIndicator size="small" color={theme.textTertiary} />
        ) : (
          <View style={[styles.statusPill, { backgroundColor: pillColor }]}>
            <Text style={[styles.statusPillText, { color: pillTextColor }]}>{pillLabel}</Text>
          </View>
        )}
      </View>

      {/* Single either/or picker - LAN or Remote, never both at once. */}
      <View style={{ flexDirection: 'row', marginTop: 12, gap: 8 }}>
        <TouchableOpacity
          onPress={() => setMode('lan')}
          style={{
            flex: 1,
            paddingVertical: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: mode === 'lan' ? theme.info : theme.borderStrong,
            backgroundColor: mode === 'lan' ? theme.info + '20' : 'transparent',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: mode === 'lan' ? theme.info : theme.textSecondary, fontWeight: mode === 'lan' ? '600' : '400' }}>
            LAN (home WiFi)
          </Text>
        </TouchableOpacity>
        <TouchableOpacity
          onPress={() => setMode('remote')}
          style={{
            flex: 1,
            paddingVertical: 10,
            borderRadius: 8,
            borderWidth: 1,
            borderColor: mode === 'remote' ? theme.info : theme.borderStrong,
            backgroundColor: mode === 'remote' ? theme.info + '20' : 'transparent',
            alignItems: 'center',
          }}
        >
          <Text style={{ color: mode === 'remote' ? theme.info : theme.textSecondary, fontWeight: mode === 'remote' ? '600' : '400' }}>
            Remote (internet)
          </Text>
        </TouchableOpacity>
      </View>

      {mode === 'lan' ? (
        <>
          <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 8 }]}>
            Your PC's local IP and port, e.g. 192.168.1.42:8080. Use this on the same WiFi as your PC.
          </Text>
          <TextInput
            style={[styles.keyInput, { borderColor: theme.borderStrong, color: theme.textPrimary, marginTop: 8 }]}
            placeholder="192.168.1.42:8080"
            placeholderTextColor={theme.textTertiary}
            value={lanUrlValue}
            onChangeText={setLanUrlValue}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </>
      ) : (
        <>
          <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 8 }]}>
            The tunnel URL shown in the "ZAO Cloudflare Tunnel" window when you run start.bat on your PC. This changes every time start.bat restarts - re-paste it here before using Remote mode away from home.
          </Text>
          <TextInput
            style={[styles.keyInput, { borderColor: theme.borderStrong, color: theme.textPrimary, marginTop: 8 }]}
            placeholder="https://random-words-1234.trycloudflare.com"
            placeholderTextColor={theme.textTertiary}
            value={remoteUrlValue}
            onChangeText={setRemoteUrlValue}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </>
      )}

      <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 12 }]}>
        Auth token - must match AUTH_TOKEN in the PC's server/config.js.
      </Text>
      <TextInput
        style={[styles.keyInput, { borderColor: theme.borderStrong, color: theme.textPrimary, marginTop: 8 }]}
        placeholder="Shared secret token"
        placeholderTextColor={theme.textTertiary}
        value={tokenValue}
        onChangeText={setTokenValue}
        autoCapitalize="none"
        autoCorrect={false}
        secureTextEntry
      />

      <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 12 }]}>
        {status.ready
          ? 'Chat, coding, reasoning, and the Terminal tool are all running on Qwen2.5 Coder 3B and cmd.exe on your PC.'
          : status.connected
          ? 'The backend is reachable but the model is still loading - this can take a bit longer on first start. Check again shortly.'
          : "ZAO couldn't reach the PC backend with these settings. Make sure start.bat is running on your PC and the URL/token above are correct."}
      </Text>

      <View style={{ flexDirection: 'row', marginTop: 12, gap: 16, alignItems: 'center' }}>
        <TouchableOpacity
          style={[styles.keyEditBtn, { opacity: isDirty ? 1 : 0.4 }]}
          onPress={handleSave}
          disabled={!isDirty || saving}
        >
          <Text style={[styles.keyEditBtnText, { color: theme.info }]}>{saving ? 'Saving…' : 'Save'}</Text>
        </TouchableOpacity>
        <TouchableOpacity style={styles.keyEditBtn} onPress={check} disabled={checking}>
          <Text style={[styles.keyEditBtnText, { color: theme.info }]}>Check again</Text>
        </TouchableOpacity>
      </View>
      {isDirty && (
        <Text style={[styles.helperText, { color: theme.textTertiary, marginTop: 6, fontSize: 12 }]}>
          Unsaved changes - tap Save to apply.
        </Text>
      )}
    </View>
  );
}

function MemorySection({ preferences, onToggle, theme }) {
  const [modalVisible, setModalVisible] = useState(false);
  const [memories, setMemories] = useState([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editingText, setEditingText] = useState('');

  const memoryEnabled = preferences?.memory_enabled !== false;

  const loadMemories = async () => {
    setLoading(true);
    const result = await getAllMemories();
    setMemories(result.success ? result.data.filter((m) => m.is_active) : []);
    setLoading(false);
  };

  const openModal = async () => {
    setModalVisible(true);
    await loadMemories();
  };

  const handleSaveEdit = async (id) => {
    const trimmed = editingText.trim();
    if (!trimmed) return;
    await updateMemory(id, { content: trimmed });
    setEditingId(null);
    setEditingText('');
    await loadMemories();
  };

  const handleForget = async (id) => {
    await deactivateMemory(id);
    await loadMemories();
  };

  /**
   * Permanent delete (hardDeleteMemory) - distinct from handleForget's
   * soft deactivateMemory above. "Forget" keeps the row (is_active=0) so
   * upsertMemoryByContent's similarity check still has something to
   * compare a re-extracted duplicate against; this actually removes the
   * row, no undo, for when the person wants no trace of it at all (e.g.
   * something sensitive got picked up by accident). Confirmed separately
   * from "Forget" since the two have real different consequences.
   */
  const handleHardDelete = (id) => {
    Alert.alert(
      'Delete this memory?',
      'This removes it completely, right now - unlike "Forget", there\'s no trace kept at all. This can\'t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            await hardDeleteMemory(id);
            await loadMemories();
          },
        },
      ]
    );
  };

  const handleClearAll = () => {
    Alert.alert(
      'Clear all memories?',
      'This permanently deletes everything ZAO remembers about you. This can\'t be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Clear all',
          style: 'destructive',
          onPress: async () => {
            await clearAllMemories();
            await loadMemories();
          },
        },
      ]
    );
  };

  return (
    <View style={styles.keyRow}>
      <View style={styles.keyRowHeader}>
        <Text style={[styles.keyLabel, { color: theme.textPrimary }]}>Remember things about me</Text>
        <Switch
          value={memoryEnabled}
          onValueChange={onToggle}
          trackColor={{ false: theme.surfaceAlt, true: theme.info }}
        />
      </View>
      <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 4 }]}>
        {memoryEnabled
          ? 'ZAO automatically picks up durable facts from your conversations (name, preferences, ongoing projects) and brings them into future chats, so you don\'t have to repeat yourself. Stored only on this device.'
          : 'Off - ZAO won\'t learn or recall anything about you across conversations. Memories already stored stay saved until you clear them below.'}
      </Text>
      <TouchableOpacity style={[styles.keyEditBtn, { marginTop: 12 }]} onPress={openModal}>
        <Text style={[styles.keyEditBtnText, { color: theme.info }]}>Manage memories</Text>
      </TouchableOpacity>

      <Modal visible={modalVisible} animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: theme.background, paddingTop: 56 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12 }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: theme.textPrimary }}>Memory</Text>
            <TouchableOpacity onPress={() => setModalVisible(false)}>
              <Ionicons name="close" size={26} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator size="large" color={theme.info} style={{ marginTop: 40 }} />
          ) : memories.length === 0 ? (
            <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40, paddingHorizontal: 20 }}>
              Nothing saved yet. As you chat with ZAO, things worth remembering will show up here.
            </Text>
          ) : (
            <FlatList
              data={memories}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
              renderItem={({ item }) => (
                <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textSecondary, marginBottom: 6, textTransform: 'uppercase' }}>
                    {item.category || 'general'}
                  </Text>
                  {editingId === item.id ? (
                    <>
                      <TextInput
                        value={editingText}
                        onChangeText={setEditingText}
                        multiline
                        style={{ color: theme.textPrimary, fontSize: 15, borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 8, marginBottom: 8 }}
                      />
                      <View style={{ flexDirection: 'row', gap: 16 }}>
                        <TouchableOpacity onPress={() => handleSaveEdit(item.id)}>
                          <Text style={{ color: theme.info, fontWeight: '600' }}>Save</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => { setEditingId(null); setEditingText(''); }}>
                          <Text style={{ color: theme.textSecondary }}>Cancel</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  ) : (
                    <>
                      <Text style={{ color: theme.textPrimary, fontSize: 15, marginBottom: 10 }}>{item.content}</Text>
                      <View style={{ flexDirection: 'row', gap: 20 }}>
                        <TouchableOpacity onPress={() => { setEditingId(item.id); setEditingText(item.content); }}>
                          <Text style={{ color: theme.info, fontWeight: '600' }}>Edit</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => handleForget(item.id)}>
                          <Text style={{ color: '#DC2626', fontWeight: '600' }}>Forget</Text>
                        </TouchableOpacity>
                        <TouchableOpacity onPress={() => handleHardDelete(item.id)}>
                          <Text style={{ color: '#DC2626', fontWeight: '600', textDecorationLine: 'underline' }}>Delete permanently</Text>
                        </TouchableOpacity>
                      </View>
                    </>
                  )}
                </View>
              )}
            />
          )}

          {memories.length > 0 && (
            <TouchableOpacity
              style={{ marginHorizontal: 20, marginBottom: 24, paddingVertical: 12, alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: '#DC2626' }}
              onPress={handleClearAll}
            >
              <Text style={{ color: '#DC2626', fontWeight: '700' }}>Clear all memories</Text>
            </TouchableOpacity>
          )}
        </View>
      </Modal>
    </View>
  );
}

/**
 * Gives ZAO's prospective memory (src/services/reminders/reminderService.js)
 * the in-app view MEMORY_ARCHITECTURE.md originally called out as missing:
 * previously the only place a scheduled reminder was visible at all was
 * the system notification shade. Mirrors MemorySection's shape above -
 * a summary row + "Manage" opens a modal list - since this is the same
 * kind of "let the person see and edit ZAO's own persisted state" screen.
 */
function RemindersSection({ theme }) {
  const [modalVisible, setModalVisible] = useState(false);
  const [reminders, setReminders] = useState([]);
  const [loading, setLoading] = useState(false);

  const loadReminders = async () => {
    setLoading(true);
    const result = await listReminders({ includeCompleted: true });
    setReminders(result.success ? result.data : []);
    setLoading(false);
  };

  const openModal = async () => {
    setModalVisible(true);
    await loadReminders();
  };

  const handleCancel = async (id) => {
    await cancelReminder(id);
    await loadReminders();
  };

  const handleForget = async (id) => {
    await forgetReminder(id);
    await loadReminders();
  };

  const activeCount = reminders.filter((r) => r.status === 'scheduled').length;

  const STATUS_STYLE = {
    scheduled: { label: 'Scheduled', color: theme.info },
    fired: { label: 'Delivered', color: theme.textSecondary },
    cancelled: { label: 'Cancelled', color: theme.textSecondary },
    failed: { label: 'Failed to schedule', color: '#DC2626' },
  };

  return (
    <View style={styles.keyRow}>
      <Text style={[styles.keyLabel, { color: theme.textPrimary }]}>Reminders</Text>
      <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 4 }]}>
        Anything ZAO has scheduled to remind you about later, kept in ZAO's own records - inspectable and cancelable here even if the system notification never fires.
      </Text>
      <TouchableOpacity style={[styles.keyEditBtn, { marginTop: 12 }]} onPress={openModal}>
        <Text style={[styles.keyEditBtnText, { color: theme.info }]}>
          Manage reminders{activeCount > 0 ? ` (${activeCount} active)` : ''}
        </Text>
      </TouchableOpacity>

      <Modal visible={modalVisible} animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: theme.background, paddingTop: 56 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12 }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: theme.textPrimary }}>Reminders</Text>
            <TouchableOpacity onPress={() => setModalVisible(false)}>
              <Ionicons name="close" size={26} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator size="large" color={theme.info} style={{ marginTop: 40 }} />
          ) : reminders.length === 0 ? (
            <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40, paddingHorizontal: 20 }}>
              Nothing here yet. Ask ZAO to remind you about something and it'll show up here.
            </Text>
          ) : (
            <FlatList
              data={reminders}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
              renderItem={({ item }) => {
                const statusInfo = STATUS_STYLE[item.status] || { label: item.status, color: theme.textSecondary };
                return (
                  <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginBottom: 6 }}>
                      <Text style={{ fontSize: 11, fontWeight: '700', color: statusInfo.color, textTransform: 'uppercase' }}>
                        {statusInfo.label}{item.repeatRule ? ` \u00b7 ${item.repeatRule}` : ''}
                      </Text>
                    </View>
                    <Text style={{ color: theme.textPrimary, fontSize: 15, marginBottom: 6 }}>{item.message}</Text>
                    <Text style={{ color: theme.textSecondary, fontSize: 13, marginBottom: 10 }}>
                      {new Date(item.triggerAt).toLocaleString()}
                    </Text>
                    <View style={{ flexDirection: 'row', gap: 20 }}>
                      {item.status === 'scheduled' && (
                        <TouchableOpacity onPress={() => handleCancel(item.id)}>
                          <Text style={{ color: '#DC2626', fontWeight: '600' }}>Cancel</Text>
                        </TouchableOpacity>
                      )}
                      {item.status !== 'scheduled' && (
                        <TouchableOpacity onPress={() => handleForget(item.id)}>
                          <Text style={{ color: theme.textSecondary, fontWeight: '600' }}>Remove</Text>
                        </TouchableOpacity>
                      )}
                    </View>
                  </View>
                );
              }}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

const PERMISSION_MODE_INFO = {
  default: { label: 'Default', subtitle: 'Safe tools run free; edits and risky terminal commands need confirmation' },
  acceptEdits: { label: 'Accept edits', subtitle: 'File edits/creates/moves auto-run; deletes and terminal commands still confirm' },
  plan: { label: 'Plan', subtitle: 'Read-only - ZAO can look around and propose a plan, but nothing gets written or run' },
  auto: { label: 'Auto', subtitle: "Every edit and risky terminal command auto-runs. Catastrophic commands (rm -rf /, etc.) still can't run, in any mode" },
  bypassPermissions: { label: 'Bypass permissions', subtitle: 'Same as Auto today - kept as its own mode in case it needs to diverge later' },
};

function PermissionModeSection({ preferences, onSetMode, theme }) {
  const current = preferences?.permission_mode || 'default';
  return (
    <View>
      {PERMISSION_MODES.map((mode, i) => (
        <React.Fragment key={mode}>
          {i > 0 && <View style={[styles.divider, { backgroundColor: theme.border }]} />}
          <RadioOption
            label={PERMISSION_MODE_INFO[mode].label}
            subtitle={PERMISSION_MODE_INFO[mode].subtitle}
            selected={current === mode}
            onPress={() => onSetMode(mode)}
            theme={theme}
          />
        </React.Fragment>
      ))}
    </View>
  );
}

function CheckpointsSection({ theme }) {
  const [modalVisible, setModalVisible] = useState(false);
  const [checkpoints, setCheckpoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [restoringId, setRestoringId] = useState(null);

  const load = async () => {
    setLoading(true);
    const result = await getRecentCheckpoints(50);
    setCheckpoints(result.success ? result.data : []);
    setLoading(false);
  };

  const openModal = async () => {
    setModalVisible(true);
    await load();
  };

  const handleRestore = (checkpoint) => {
    Alert.alert(
      'Restore this file?',
      `This overwrites the current contents of ${checkpoint.path} with what it was before this ${checkpoint.operation}. This can't be undone.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          style: 'destructive',
          onPress: async () => {
            setRestoringId(checkpoint.id);
            const result = await rewindToCheckpoint(checkpoint.id);
            setRestoringId(null);
            if (!result.success) {
              Alert.alert('Could not restore', result.error?.message || 'Unknown error');
            }
            await load();
          },
        },
      ]
    );
  };

  return (
    <View style={styles.keyRow}>
      <Text style={[styles.helperText, { color: theme.textSecondary }]}>
        Every file edit ZAO makes is snapshotted first, so you can undo it later even without git.
      </Text>
      <TouchableOpacity style={[styles.keyEditBtn, { marginTop: 12 }]} onPress={openModal}>
        <Text style={[styles.keyEditBtnText, { color: theme.info }]}>View recent checkpoints</Text>
      </TouchableOpacity>

      <Modal visible={modalVisible} animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: theme.background, paddingTop: 56 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12 }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: theme.textPrimary }}>Checkpoints</Text>
            <TouchableOpacity onPress={() => setModalVisible(false)}>
              <Ionicons name="close" size={26} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>
          {loading ? (
            <ActivityIndicator size="large" color={theme.info} style={{ marginTop: 40 }} />
          ) : checkpoints.length === 0 ? (
            <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40, paddingHorizontal: 20 }}>
              No file edits have been snapshotted yet.
            </Text>
          ) : (
            <FlatList
              data={checkpoints}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
              renderItem={({ item }) => (
                <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textSecondary, marginBottom: 6, textTransform: 'uppercase' }}>
                    {item.operation} · {new Date(item.created_at).toLocaleString()}
                  </Text>
                  <Text style={{ color: theme.textPrimary, fontSize: 14, marginBottom: 10 }} numberOfLines={2}>{item.path}</Text>
                  <TouchableOpacity onPress={() => handleRestore(item)} disabled={restoringId === item.id}>
                    {restoringId === item.id ? (
                      <ActivityIndicator size="small" color={theme.info} />
                    ) : (
                      <Text style={{ color: '#DC2626', fontWeight: '600' }}>Restore</Text>
                    )}
                  </TouchableOpacity>
                </View>
              )}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

function HooksSection({ theme }) {
  const [modalVisible, setModalVisible] = useState(false);
  const [hooks, setHooks] = useState([]);
  const [loading, setLoading] = useState(false);
  const [showAddForm, setShowAddForm] = useState(false);
  const [newEvent, setNewEvent] = useState('PreToolUse');
  const [newMatcher, setNewMatcher] = useState('*');
  const [newCommand, setNewCommand] = useState('');
  const [newBackend, setNewBackend] = useState('termux');

  const load = async () => {
    setLoading(true);
    const result = await getHooks();
    setHooks(result.success ? result.data : []);
    setLoading(false);
  };

  const openModal = async () => {
    setModalVisible(true);
    await load();
  };

  const handleAdd = async () => {
    if (!newCommand.trim()) return;
    await createHook({
      id: `hook_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      event: newEvent,
      matcher: newMatcher.trim() || '*',
      command: newCommand.trim(),
      backend: newBackend,
    });
    setNewCommand('');
    setShowAddForm(false);
    await load();
  };

  const handleDelete = (id) => {
    Alert.alert('Delete this hook?', 'It will stop running immediately.', [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: async () => { await deleteHook(id); await load(); } },
    ]);
  };

  return (
    <View style={styles.keyRow}>
      <Text style={[styles.helperText, { color: theme.textSecondary }]}>
        Real shell commands ZAO runs automatically at specific points - before/after a tool call, or once when a session starts. A PreToolUse hook can block the call it fires on.
      </Text>
      <TouchableOpacity style={[styles.keyEditBtn, { marginTop: 12 }]} onPress={openModal}>
        <Text style={[styles.keyEditBtnText, { color: theme.info }]}>Manage hooks</Text>
      </TouchableOpacity>

      <Modal visible={modalVisible} animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: theme.background, paddingTop: 56 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12 }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: theme.textPrimary }}>Hooks</Text>
            <TouchableOpacity onPress={() => setModalVisible(false)}>
              <Ionicons name="close" size={26} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>

          {loading ? (
            <ActivityIndicator size="large" color={theme.info} style={{ marginTop: 40 }} />
          ) : (
            <FlatList
              data={hooks}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 20 }}
              ListEmptyComponent={<Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40 }}>No hooks configured yet.</Text>}
              renderItem={({ item }) => (
                <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textSecondary, textTransform: 'uppercase' }}>
                      {item.event} · {item.backend}
                    </Text>
                    <Switch
                      value={!!item.enabled}
                      onValueChange={(val) => setHookEnabled(item.id, val).then(load)}
                      trackColor={{ false: theme.surfaceAlt, true: theme.info }}
                    />
                  </View>
                  <Text style={{ color: theme.textPrimary, fontSize: 13, marginBottom: 4 }}>matcher: {item.matcher}</Text>
                  <Text style={{ color: theme.textPrimary, fontSize: 14, fontFamily: 'monospace', marginBottom: 10 }}>{item.command}</Text>
                  <TouchableOpacity onPress={() => handleDelete(item.id)}>
                    <Text style={{ color: '#DC2626', fontWeight: '600' }}>Delete</Text>
                  </TouchableOpacity>
                </View>
              )}
            />
          )}

          {showAddForm ? (
            <View style={{ paddingHorizontal: 20, paddingBottom: 24, borderTopWidth: StyleSheet.hairlineWidth, borderTopColor: theme.border, paddingTop: 16 }}>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                {['PreToolUse', 'PostToolUse', 'SessionStart'].map((ev) => (
                  <TouchableOpacity key={ev} onPress={() => setNewEvent(ev)} style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: newEvent === ev ? theme.accent : theme.border }}>
                    <Text style={{ color: newEvent === ev ? theme.accent : theme.textSecondary, fontSize: 12 }}>{ev}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <View style={{ flexDirection: 'row', gap: 8, marginBottom: 8 }}>
                {['termux', 'pc'].map((b) => (
                  <TouchableOpacity key={b} onPress={() => setNewBackend(b)} style={{ paddingVertical: 6, paddingHorizontal: 10, borderRadius: 8, borderWidth: 1, borderColor: newBackend === b ? theme.accent : theme.border }}>
                    <Text style={{ color: newBackend === b ? theme.accent : theme.textSecondary, fontSize: 12 }}>{b}</Text>
                  </TouchableOpacity>
                ))}
              </View>
              <TextInput
                value={newMatcher}
                onChangeText={setNewMatcher}
                placeholder="Matcher (tool name or *)"
                placeholderTextColor={theme.textTertiary}
                style={{ color: theme.textPrimary, fontSize: 14, borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10, marginBottom: 8 }}
              />
              <TextInput
                value={newCommand}
                onChangeText={setNewCommand}
                placeholder="Shell command to run"
                placeholderTextColor={theme.textTertiary}
                style={{ color: theme.textPrimary, fontSize: 14, borderWidth: 1, borderColor: theme.border, borderRadius: 8, padding: 10, marginBottom: 12 }}
              />
              <View style={{ flexDirection: 'row', gap: 16 }}>
                <TouchableOpacity onPress={handleAdd}><Text style={{ color: theme.info, fontWeight: '600' }}>Save hook</Text></TouchableOpacity>
                <TouchableOpacity onPress={() => setShowAddForm(false)}><Text style={{ color: theme.textSecondary }}>Cancel</Text></TouchableOpacity>
              </View>
            </View>
          ) : (
            <TouchableOpacity
              style={{ marginHorizontal: 20, marginBottom: 24, paddingVertical: 12, alignItems: 'center', borderRadius: 10, borderWidth: 1, borderColor: theme.accent }}
              onPress={() => setShowAddForm(true)}
            >
              <Text style={{ color: theme.accent, fontWeight: '700' }}>Add hook</Text>
            </TouchableOpacity>
          )}
        </View>
      </Modal>
    </View>
  );
}

function WorktreesSection({ theme }) {
  const [modalVisible, setModalVisible] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    const result = await getWorktreeSessions('active');
    setSessions(result.success ? result.data : []);
    setLoading(false);
  };

  const openModal = async () => {
    setModalVisible(true);
    await load();
  };

  const handleClose = (session) => {
    Alert.alert(
      `Close "${session.branch}"?`,
      session.backend === 'pc_git_worktree'
        ? 'Was this branch already merged? If not, closing without merging just stops tracking it here - the branch itself is untouched either way.'
        : 'This stops tracking the session here. The GitHub branch itself is untouched.',
      [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Merged', onPress: async () => { await closeWorktreeSession(session, { merged: true }); await load(); } },
        { text: 'Not merged', style: 'destructive', onPress: async () => { await closeWorktreeSession(session, { merged: false }); await load(); } },
      ]
    );
  };

  return (
    <View style={styles.keyRow}>
      <Text style={[styles.helperText, { color: theme.textSecondary }]}>
        Parallel sessions on different branches - each one gets its own isolated chat conversation, so work on one doesn't step on another.
      </Text>
      <TouchableOpacity style={[styles.keyEditBtn, { marginTop: 12 }]} onPress={openModal}>
        <Text style={[styles.keyEditBtnText, { color: theme.info }]}>View active worktrees</Text>
      </TouchableOpacity>

      <Modal visible={modalVisible} animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: theme.background, paddingTop: 56 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12 }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: theme.textPrimary }}>Worktrees</Text>
            <TouchableOpacity onPress={() => setModalVisible(false)}>
              <Ionicons name="close" size={26} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>
          {loading ? (
            <ActivityIndicator size="large" color={theme.info} style={{ marginTop: 40 }} />
          ) : sessions.length === 0 ? (
            <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40, paddingHorizontal: 20 }}>
              No active worktree sessions. Ask ZAO to split off a new branch to work on in parallel and it'll show up here.
            </Text>
          ) : (
            <FlatList
              data={sessions}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
              renderItem={({ item }) => (
                <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                  <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textSecondary, marginBottom: 6, textTransform: 'uppercase' }}>
                    {item.backend} {item.repo ? `· ${item.owner}/${item.repo}` : ''}
                  </Text>
                  <Text style={{ color: theme.textPrimary, fontSize: 15, marginBottom: 10 }}>{item.branch}</Text>
                  <TouchableOpacity onPress={() => handleClose(item)}>
                    <Text style={{ color: theme.info, fontWeight: '600' }}>Close</Text>
                  </TouchableOpacity>
                </View>
              )}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

function AuditTrailSection({ preferences, onSetOtelEndpoint, theme }) {
  const [modalVisible, setModalVisible] = useState(false);
  const [spans, setSpans] = useState([]);
  const [loading, setLoading] = useState(false);
  const [otelValue, setOtelValue] = useState(preferences?.otel_export_endpoint || '');

  const load = async () => {
    setLoading(true);
    const result = await getRecentSpans(100);
    setSpans(result || []);
    setLoading(false);
  };

  const openModal = async () => {
    setModalVisible(true);
    await load();
  };

  return (
    <View style={styles.keyRow}>
      <Text style={[styles.helperText, { color: theme.textSecondary }]}>
        A record of every tool call ZAO makes - what ran, with what, and whether it succeeded. Local-only unless you set an export endpoint below.
      </Text>
      <TouchableOpacity style={[styles.keyEditBtn, { marginTop: 12 }]} onPress={openModal}>
        <Text style={[styles.keyEditBtnText, { color: theme.info }]}>View recent activity</Text>
      </TouchableOpacity>

      <View style={{ marginTop: 16 }}>
        <Text style={[styles.keyLabel, { color: theme.textPrimary, marginBottom: 6 }]}>OTel export endpoint (optional)</Text>
        <TextInput
          value={otelValue}
          onChangeText={setOtelValue}
          onBlur={() => onSetOtelEndpoint(otelValue.trim() || null)}
          placeholder="https://your-collector.example.com/v1/traces"
          placeholderTextColor={theme.textTertiary}
          autoCapitalize="none"
          autoCorrect={false}
          style={[styles.keyInput, { color: theme.textPrimary, borderColor: theme.border }]}
        />
      </View>

      <Modal visible={modalVisible} animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: theme.background, paddingTop: 56 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12 }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: theme.textPrimary }}>Agent activity</Text>
            <TouchableOpacity onPress={() => setModalVisible(false)}>
              <Ionicons name="close" size={26} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>
          {loading ? (
            <ActivityIndicator size="large" color={theme.info} style={{ marginTop: 40 }} />
          ) : spans.length === 0 ? (
            <Text style={{ color: theme.textSecondary, textAlign: 'center', marginTop: 40, paddingHorizontal: 20 }}>
              Nothing logged yet - this fills in as ZAO makes tool calls.
            </Text>
          ) : (
            <FlatList
              data={spans}
              keyExtractor={(item) => item.id}
              contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}
              renderItem={({ item }) => (
                <View style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                  <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: theme.textSecondary, textTransform: 'uppercase' }}>
                      {new Date(item.started_at).toLocaleString()}
                    </Text>
                    <Text style={{ fontSize: 11, fontWeight: '700', color: item.status === 'error' ? '#DC2626' : item.status === 'running' ? theme.textTertiary : '#16A34A' }}>
                      {item.status}
                    </Text>
                  </View>
                  <Text style={{ color: theme.textPrimary, fontSize: 14, marginTop: 4 }}>{item.tool_name || item.name}</Text>
                  {item.error_message ? <Text style={{ color: '#DC2626', fontSize: 12, marginTop: 4 }}>{item.error_message}</Text> : null}
                </View>
              )}
            />
          )}
        </View>
      </Modal>
    </View>
  );
}

function SectionHeader({ title, theme }) {
  return <Text style={[styles.sectionHeader, { color: theme.textTertiary }]}>{title}</Text>;
}

/**
 * "About ZAO" - Settings-level home for brainTypes.js's ZAO_BRAIN_PROFILE
 * and memoryTypes.js's MEMORY_TYPES/ZAO_MEMORY_PROFILE. Both files were
 * written as documentation-as-code for exactly this ("kept for any future
 * About ZAO's architecture settings panel" - see brainTypes.js's own
 * ZAO_BRAIN_PROFILE comment) but neither was ever actually imported
 * anywhere, unlike their sibling reasoningTypes.js (which already powers
 * ChatScreen.js's per-reply reasoning chip). Deliberately a static
 * reference panel rather than a per-message chip like reasoning's: brain
 * architecture and memory mechanisms don't vary turn-to-turn the way
 * which reasoning strategy handled one specific reply does - there's one
 * fixed answer for "how is ZAO built," not one per message.
 */
function ArchitectureSection({ theme }) {
  const [modalVisible, setModalVisible] = useState(false);

  const brainEntries = Object.keys(BRAIN_ARCHITECTURES).map((key) => {
    const value = BRAIN_ARCHITECTURES[key];
    return { value, label: BRAIN_ARCHITECTURE_LABELS[value], profile: ZAO_BRAIN_PROFILE[value] };
  });
  const memoryEntries = Object.values(MEMORY_TYPES).map((type) => ({
    ...type,
    summary: ZAO_MEMORY_PROFILE[type.key === 'working_memory_compaction' ? 'workingMemoryCompaction' : type.key === 'context_window' ? 'contextWindow' : type.key],
  }));

  return (
    <View style={styles.keyRow}>
      <Text style={[styles.helperText, { color: theme.textSecondary }]}>
        How ZAO's model is put to work, and what it remembers about you and how.
      </Text>
      <TouchableOpacity style={[styles.keyEditBtn, { marginTop: 12 }]} onPress={() => setModalVisible(true)}>
        <Text style={[styles.keyEditBtnText, { color: theme.info }]}>About ZAO's architecture</Text>
      </TouchableOpacity>

      <Modal visible={modalVisible} animationType="slide" onRequestClose={() => setModalVisible(false)}>
        <View style={{ flex: 1, backgroundColor: theme.background, paddingTop: 56 }}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingHorizontal: 20, marginBottom: 12 }}>
            <Text style={{ fontSize: 20, fontWeight: '700', color: theme.textPrimary }}>About ZAO</Text>
            <TouchableOpacity onPress={() => setModalVisible(false)}>
              <Ionicons name="close" size={26} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>
          <ScrollView contentContainerStyle={{ paddingHorizontal: 20, paddingBottom: 40 }}>
            <Text style={{ fontSize: 13, fontWeight: '700', color: theme.textTertiary, textTransform: 'uppercase', marginBottom: 10 }}>
              Brain architecture
            </Text>
            {brainEntries.map((entry) => (
              <View key={entry.value} style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: theme.textPrimary, marginBottom: 4 }}>
                  {entry.label} {entry.profile?.implemented ? '' : '(not used by ZAO)'}
                </Text>
                <Text style={{ fontSize: 13, color: theme.textSecondary }}>
                  {entry.profile?.implemented ? entry.profile.where : entry.profile?.reason}
                </Text>
              </View>
            ))}

            <Text style={{ fontSize: 13, fontWeight: '700', color: theme.textTertiary, textTransform: 'uppercase', marginTop: 8, marginBottom: 10 }}>
              Memory
            </Text>
            {memoryEntries.map((entry) => (
              <View key={entry.key} style={{ borderWidth: 1, borderColor: theme.border, borderRadius: 12, padding: 14, marginBottom: 10 }}>
                <Text style={{ fontSize: 15, fontWeight: '600', color: theme.textPrimary, marginBottom: 4 }}>{entry.label}</Text>
                <Text style={{ fontSize: 13, color: theme.textSecondary }}>{entry.summary || entry.definition}</Text>
              </View>
            ))}
          </ScrollView>
        </View>
      </Modal>
    </View>
  );
}

function BrowserAgentSection({ preferences, theme }) {
  return (
    <View style={styles.keyRow}>
      <View style={styles.keyRowHeader}>
        <Text style={[styles.keyLabel, { color: theme.textPrimary }]}>On-device browser agent</Text>
        <View style={[styles.statusPill, { backgroundColor: preferences.browser_access_enabled ? '#DCFCE7' : theme.surfaceAlt }]}>
          <Text style={[styles.statusPillText, { color: preferences.browser_access_enabled ? '#166534' : theme.textSecondary }]}>
            {preferences.browser_access_enabled ? 'On' : 'Off'}
          </Text>
        </View>
      </View>
      <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 4 }]}>
        No setup needed here - there's no backend to configure anymore. Turn
        this on or off anytime with the globe button in the chat composer.
        A small live view of the browser appears while it's on, so you can
        watch (or take over) whatever ZAO is doing.
      </Text>
    </View>
  );
}


function RadioOption({ label, subtitle, selected, onPress, theme }) {
  return (
    <TouchableOpacity style={styles.modeOption} onPress={onPress}>
      <View style={styles.modeOptionLeft}>
        <View
          style={[
            styles.radio,
            { borderColor: theme.borderStrong },
            selected && { borderColor: theme.accent, backgroundColor: theme.accent },
          ]}
        />
        <View>
          <Text style={[styles.modeTitle, { color: theme.textPrimary }]}>{label}</Text>
          {subtitle ? <Text style={[styles.modeSubtitle, { color: theme.textTertiary }]}>{subtitle}</Text> : null}
        </View>
      </View>
    </TouchableOpacity>
  );
}

function UsageModal({ visible, onClose, theme }) {
  const [loading, setLoading] = useState(true);
  const [counts, setCounts] = useState({});
  const [backendStatus, setBackendStatus] = useState({ connected: false, ready: false, model: null });
  const [recentEvents, setRecentEvents] = useState([]);
  const [devModeExpanded, setDevModeExpanded] = useState(false);

  useEffect(() => {
    if (!visible) return;
    (async () => {
      setLoading(true);
      try {
        const [countsResult, recentResult, backendResult] = await Promise.all([
          getUsageCounts(),
          getRecentUsageEvents(15),
          checkBackendHealth(),
        ]);
        setCounts(countsResult.data || {});
        setRecentEvents(recentResult.data || []);
        setBackendStatus(backendResult);
      } finally {
        setLoading(false);
      }
    })();
  }, [visible]);

  const totalFileEvents = (counts.file_created || 0) + (counts.github_push || 0);

  return (
    <Modal visible={visible} animationType="slide" onRequestClose={onClose}>
      <View style={[styles.modalContainer, { backgroundColor: theme.background }]}>
        <View style={styles.modalHeader}>
          <Text style={[styles.modalTitle, { color: theme.textPrimary }]}>Usage</Text>
          <TouchableOpacity onPress={onClose} hitSlop={12}>
            <Ionicons name="close" size={24} color={theme.textPrimary} />
          </TouchableOpacity>
        </View>

        {loading ? (
          <View style={styles.usageLoadingBox}>
            <ActivityIndicator size="small" color={theme.textTertiary} />
          </View>
        ) : (
          <ScrollView style={styles.container}>
            <SectionHeader title="Backend" theme={theme} />
            <View style={[styles.card, { backgroundColor: theme.surface }]}>
              <View style={styles.usageHealthRow}>
                <View style={[styles.healthDot, { backgroundColor: backendStatus.ready ? '#22C55E' : backendStatus.connected ? '#F59E0B' : '#EF4444' }]} />
                <Text style={[styles.usageRowLabel, { color: theme.textPrimary, flex: 1 }]}>{ACTIVE_MODEL.label}</Text>
                <Text style={[styles.helperText, { color: theme.textTertiary }]}>
                  {backendStatus.ready ? 'Ready' : backendStatus.connected ? 'Loading' : 'Not connected'}
                </Text>
              </View>
              <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 8 }]}>
                Runs on your PC's backend over LAN or the Cloudflare tunnel - no third-party API call, no rate limit, no per-call cost. Manage in Settings &gt; Backend Connection.
              </Text>
            </View>

            <SectionHeader title="Activity" theme={theme} />
            <View style={[styles.card, { backgroundColor: theme.surface }]}>
              <UsageRow label="Browser sessions" value={counts.browser_session || 0} theme={theme} />
              <UsageRow label="GitHub pushes" value={counts.github_push || 0} theme={theme} />
              <UsageRow label="Repos created" value={counts.github_repo_created || 0} theme={theme} />
              <UsageRow label="Files created" value={totalFileEvents} theme={theme} last />
            </View>


            <TouchableOpacity
              style={[styles.card, { backgroundColor: theme.surface, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }]}
              onPress={() => setDevModeExpanded((v) => !v)}
            >
              <Text style={[styles.keyLabel, { color: theme.textPrimary }]}>Developer Mode</Text>
              <Ionicons name={devModeExpanded ? 'chevron-up' : 'chevron-down'} size={18} color={theme.textSecondary} />
            </TouchableOpacity>

            {devModeExpanded && (
              <View style={[styles.card, { backgroundColor: theme.surface }]}>
                <Text style={[styles.helperText, { color: theme.textSecondary, marginBottom: 8 }]}>
                  Most recent tool/model calls, newest first:
                </Text>
                {recentEvents.length === 0 ? (
                  <Text style={[styles.helperText, { color: theme.textSecondary }]}>Nothing logged yet.</Text>
                ) : (
                  recentEvents.map((event) => (
                    <View key={event.id} style={styles.usageEventRow}>
                      <Text style={[styles.usageEventType, { color: theme.info }]}>{event.event_type}</Text>
                      {event.detail ? (
                        <Text style={[styles.helperText, { color: theme.textPrimary }]} numberOfLines={1}>{event.detail}</Text>
                      ) : null}
                      <Text style={[styles.helperText, { color: theme.textTertiary }]}>
                        {new Date(event.created_at).toLocaleTimeString()}
                      </Text>
                    </View>
                  ))
                )}
              </View>
            )}
          </ScrollView>
        )}
      </View>
    </Modal>
  );
}

function UsageRow({ label, value, theme, last = false }) {
  return (
    <View style={[styles.usageRow, !last && { borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.border }]}>
      <Text style={[styles.usageRowLabel, { color: theme.textPrimary }]}>{label}</Text>
      <Text style={[styles.usageRowValue, { color: theme.textSecondary }]}>{value}</Text>
    </View>
  );
}

export default function SettingsScreen({ onOpenSidebar }) {
  const theme = useTheme();
  const {
    preferences, apiKeyStatus, loadPreferences,
    setApiKey, removeApiKey, setGithubUsername,
    setMemoryEnabled, setPermissionMode, setOtelExportEndpoint,
  } = usePreferencesStore();
  const { themePreference, loadThemePreference, setThemePreference } = useThemeStore();

  const [usageModalVisible, setUsageModalVisible] = useState(false);

  useEffect(() => {
    loadPreferences();
    loadThemePreference();
  }, []);

  return (
    <>
    <ScrollView
      style={[styles.container, { backgroundColor: theme.background }]}
      contentContainerStyle={{ paddingBottom: 40 }}
    >
      <View style={styles.header}>
        {onOpenSidebar && (
          <TouchableOpacity onPress={onOpenSidebar} hitSlop={12} style={styles.headerIconButton}>
            <Ionicons name="menu-outline" size={24} color={theme.textPrimary} />
          </TouchableOpacity>
        )}
        <Text style={[styles.headerTitle, { color: theme.textPrimary }]}>Settings</Text>
      </View>

      <SectionHeader title="Appearance" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <RadioOption
          label="Auto"
          subtitle="Follows your phone's system setting"
          selected={themePreference === 'auto'}
          onPress={() => setThemePreference('auto')}
          theme={theme}
        />
        <View style={[styles.divider, { backgroundColor: theme.border }]} />
        <RadioOption
          label="Light"
          selected={themePreference === 'light'}
          onPress={() => setThemePreference('light')}
          theme={theme}
        />
        <View style={[styles.divider, { backgroundColor: theme.border }]} />
        <RadioOption
          label="Dark"
          selected={themePreference === 'dark'}
          onPress={() => setThemePreference('dark')}
          theme={theme}
        />
      </View>

      <SectionHeader title="Usage" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <TouchableOpacity
          style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }}
          onPress={() => setUsageModalVisible(true)}
        >
          <Text style={[styles.keyLabel, { color: theme.textPrimary }]}>View usage & activity</Text>
          <Ionicons name="chevron-forward" size={18} color={theme.textSecondary} />
        </TouchableOpacity>
      </View>

      <SectionHeader title="Backend Connection" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <BackendConnectionSection preferences={preferences} theme={theme} />
      </View>

      <SectionHeader title="Termux Terminal" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <TerminalSetupSection theme={theme} />
      </View>

      <SectionHeader title="GitHub" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <GithubCredentialsSection
          status={apiKeyStatus.github}
          onSaveUsername={setGithubUsername}
          onSaveToken={(token) => setApiKey('github', token)}
          onRemove={() => removeApiKey('github')}
          theme={theme}
        />
        <Text style={[styles.helperText, { color: theme.textTertiary }]}>
          GitHub needs your own Personal Access Token since repo actions have to happen under your account. Generate one at github.com/settings/tokens with the "repo" scope.
        </Text>
      </View>

      <SectionHeader title="Browser Agent" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <BrowserAgentSection preferences={preferences} theme={theme} />
        <Text style={[styles.helperText, { color: theme.textTertiary }]}>
          Lets ZAO actually browse the live web on your device — search, open pages, log in, click, fill forms, and read content — using a real on-device browser, driven by the Qwen2.5 Coder model acting as an agent. No server, no tunnel, nothing to host yourself.
        </Text>
      </View>


      <SectionHeader title="Filesystem" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <FilesystemAccessSection preferences={preferences} theme={theme} />
      </View>

      <SectionHeader title="Memory" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <MemorySection preferences={preferences} onToggle={setMemoryEnabled} theme={theme} />
      </View>

      <SectionHeader title="Reminders" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <RemindersSection theme={theme} />
      </View>

      <SectionHeader title="Permissions" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <PermissionModeSection preferences={preferences} onSetMode={setPermissionMode} theme={theme} />
      </View>

      <SectionHeader title="Checkpoints" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <CheckpointsSection theme={theme} />
      </View>

      <SectionHeader title="Hooks" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <HooksSection theme={theme} />
      </View>

      <SectionHeader title="Worktrees" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <WorktreesSection theme={theme} />
      </View>

      <SectionHeader title="Agent Activity" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <AuditTrailSection preferences={preferences} onSetOtelEndpoint={setOtelExportEndpoint} theme={theme} />
      </View>

      <SectionHeader title="About ZAO" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <ArchitectureSection theme={theme} />
      </View>
    </ScrollView>

    <UsageModal
      visible={usageModalVisible}
      onClose={() => setUsageModalVisible(false)}
      theme={theme}
    />
    </>
  );
}

const styles = StyleSheet.create({
  usageLoadingBox: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
  },
  usageBigNumber: {
    fontSize: 32,
    fontWeight: '700',
  },
  usageRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: 10,
  },
  usageRowLabel: {
    fontSize: 14,
  },
  usageRowValue: {
    fontSize: 14,
    fontWeight: '600',
  },
  usageHealthRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  healthDot: {
    width: 8,
    height: 8,
    borderRadius: 4,
  },
  usageEventRow: {
    paddingVertical: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: 'rgba(128,128,128,0.15)',
    gap: 2,
  },
  usageEventType: {
    fontSize: 11,
    fontWeight: '700',
    textTransform: 'uppercase',
  },
  syncResultBox: {
    marginTop: 12,
    padding: 10,
    borderRadius: 8,
    borderWidth: StyleSheet.hairlineWidth,
    gap: 4,
  },
  syncResultLine: {
    fontSize: 12,
  },
  container: {
    flex: 1,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 8,
  },
  headerIconButton: {
    padding: 4,
    marginRight: 12,
  },
  headerTitle: {
    fontSize: 20,
    fontWeight: '700',
  },
  sectionHeader: {
    fontSize: 13,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginTop: 20,
    marginBottom: 8,
  },
  card: {
    borderRadius: 16,
    padding: 4,
  },
  modeOption: {
    paddingVertical: 14,
    paddingHorizontal: 12,
  },
  modeOptionLeft: {
    flexDirection: 'row',
    alignItems: 'center',
  },
  radio: {
    width: 18,
    height: 18,
    borderRadius: 9,
    borderWidth: 2,
    marginRight: 12,
  },
  modeTitle: {
    fontSize: 15,
    fontWeight: '600',
  },
  modeSubtitle: {
    fontSize: 13,
    marginTop: 1,
  },
  divider: {
    height: 1,
    marginHorizontal: 12,
  },
  subLabel: {
    fontSize: 13,
    fontWeight: '600',
    paddingHorizontal: 12,
    paddingTop: 12,
    marginBottom: 8,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    paddingHorizontal: 8,
    gap: 8,
  },
  familyChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: 16,
    marginBottom: 4,
  },
  familyChipText: {
    fontSize: 13,
    fontWeight: '600',
  },
  keyRow: {
    padding: 12,
  },
  keyRowHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: 8,
  },
  keyLabel: {
    fontSize: 15,
    fontWeight: '600',
  },
  statusPill: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 10,
  },
  statusPillText: {
    fontSize: 11,
    fontWeight: '700',
  },
  keyInput: {
    borderWidth: 1,
    borderRadius: 10,
    paddingHorizontal: 12,
    paddingVertical: 10,
    fontSize: 14,
    marginBottom: 8,
  },
  keyRowButtons: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: 8,
  },
  keySecondaryBtn: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  keySecondaryBtnText: {
    fontWeight: '600',
    fontSize: 13,
  },
  keyRemoveBtnText: {
    fontWeight: '600',
    fontSize: 13,
  },
  keyPrimaryBtn: {
    paddingHorizontal: 16,
    paddingVertical: 8,
    borderRadius: 10,
    minWidth: 100,
    alignItems: 'center',
  },
  keyPrimaryBtnText: {
    fontWeight: '700',
    fontSize: 13,
  },
  keyEditBtn: {
    alignSelf: 'flex-start',
  },
  keyEditBtnText: {
    fontWeight: '600',
    fontSize: 13,
  },
  helperText: {
    fontSize: 12,
    padding: 12,
    lineHeight: 17,
  },
  voiceSelectRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 12,
  },
  manageVoicesRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingTop: 14,
    gap: 6,
  },
  manageVoicesText: {
    fontWeight: '600',
    fontSize: 13,
  },
  modalContainer: {
    flex: 1,
    paddingTop: 50,
  },
  modalHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 20,
    paddingBottom: 16,
  },
  modalTitle: {
    fontSize: 18,
    fontWeight: '700',
  },
  voiceRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: 12,
    paddingHorizontal: 20,
    borderBottomWidth: 1,
  },
  voiceRowLeft: {
    flexDirection: 'row',
    alignItems: 'center',
    flex: 1,
  },
  previewButton: {
    padding: 4,
    marginLeft: 8,
  },
});
