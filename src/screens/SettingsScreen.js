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
} from '../db/database';
import { ACTIVE_MODEL } from '../config/localModels';

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

function TerminalSetupSection({ theme }) {
  const [termuxInstalled, setTermuxInstalled] = useState(null); // null = unknown, true/false once checked
  const [checking, setChecking] = useState(false);

  const checkStatus = async () => {
    setChecking(true);
    try {
      const { isTermuxInstalled } = await import('../services/terminal/terminalTool');
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
      const { openTermuxForSetup } = await import('../services/terminal/terminalTool');
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
      const { getSetupCommand } = await import('../services/terminal/terminalTool');
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
        <Text style={[styles.keyLabel, { color: theme.textPrimary }]}>Terminal (Termux)</Text>
        <View style={[styles.statusPill, { backgroundColor: statusPillStyle.backgroundColor }]}>
          <Text style={[styles.statusPillText, { color: statusPillStyle.textColor }]}>{statusPillStyle.label}</Text>
        </View>
      </View>
      <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 4 }]}>
        Real shell commands (npm install, pip install, gradlew, etc.) need Termux to actually run them - Android itself gives no app, ZAO included, a shell of its own. This is a one-time setup, per device: paste one command into Termux, accept one Android permission prompt, and ZAO's agent can use the terminal freely after that.
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
 * Backend connection section - shows whether the Termux server (see
 * /server in the repo root) is currently reachable at 127.0.0.1:8080 and
 * whether Qwen2.5-Coder-3B has finished loading. There is nothing to
 * configure here - no URL to type, no key to add. The only actual "setup"
 * step is starting the backend in Termux (./start.sh); this section just
 * reflects whatever checkBackendHealth() finds right now, plus a manual
 * refresh since there's no persistent connection to watch for changes.
 */
function BackendConnectionSection({ theme }) {
  const [status, setStatus] = useState({ connected: false, ready: false, model: null });
  const [checking, setChecking] = useState(true);

  const check = async () => {
    setChecking(true);
    const result = await checkBackendHealth();
    setStatus(result);
    setChecking(false);
  };

  useEffect(() => {
    check();
  }, []);

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
        <Text style={[styles.keyLabel, { color: theme.textPrimary }]}>Termux backend</Text>
        {checking ? (
          <ActivityIndicator size="small" color={theme.textTertiary} />
        ) : (
          <View style={[styles.statusPill, { backgroundColor: pillColor }]}>
            <Text style={[styles.statusPillText, { color: pillTextColor }]}>{pillLabel}</Text>
          </View>
        )}
      </View>
      <Text style={[styles.helperText, { color: theme.textSecondary, marginTop: 4 }]}>
        {status.ready
          ? "Chat, coding, and reasoning are all running on Qwen2.5 Coder, served from Termux on this device. Nothing else to set up."
          : status.connected
          ? "The backend is running but the model is still loading - this can take 30-90 seconds after starting it. Give it a moment and check again."
          : "ZAO couldn't reach the backend at 127.0.0.1:8080. Open Termux and run ./start.sh in the server folder, then check again here."}
      </Text>
      <TouchableOpacity style={[styles.keyEditBtn, { marginTop: 12 }]} onPress={check} disabled={checking}>
        <Text style={[styles.keyEditBtnText, { color: theme.info }]}>Check again</Text>
      </TouchableOpacity>
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

function SectionHeader({ title, theme }) {
  return <Text style={[styles.sectionHeader, { color: theme.textTertiary }]}>{title}</Text>;
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
                Runs entirely on this device via a Termux server - no network call, no rate limit, no per-call cost. Manage in Settings &gt; Termux backend.
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
    setMemoryEnabled,
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

      <SectionHeader title="Termux backend" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <BackendConnectionSection theme={theme} />
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

      <SectionHeader title="Terminal" theme={theme} />
      <View style={[styles.card, { backgroundColor: theme.surface }]}>
        <TerminalSetupSection theme={theme} />
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
