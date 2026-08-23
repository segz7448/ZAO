/**
 * ZAO - File Artifact Card
 *
 * Rendered under an assistant bubble whenever messages.artifacts is set
 * (see src/db/database.js's artifacts migration comment, and
 * planStore.js's postArtifactsMessageIfAny) - one row per file a plan
 * run actually created on the PC backend. Same idea as Claude.ai
 * surfacing a finished artifact as a tappable file card in chat.
 *
 * IMPORTANT: every artifact.path here is relative to PC_BRIDGE_ROOT on
 * the PC backend (see the pcfiles/fs-file split in toolOrchestrator.js) -
 * the file is NOT yet anywhere on the phone. Tapping Download is what
 * actually makes it real on-device: pcFilePullTool.pullFile() reads the
 * bytes from the PC and writes them into the phone's own SAF-granted
 * folder (Settings > Filesystem) - the same mechanism the model's own
 * pc_pull_file tool call uses, just triggered by a direct tap here
 * instead. If no folder has been granted yet, the tap itself triggers
 * Android's system folder picker (filesystemTool.requestAccess()) -
 * this is a legitimate place to do that from since Android requires the
 * picker to originate from direct user interaction, and a button press
 * qualifies.
 */

import React, { useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as filesystemTool from '../services/filesystem/filesystemTool';
import { pullFile } from '../services/terminal/pcFilePullTool';

// Icon + short type label per extension - purely cosmetic, falls back to
// a generic document icon/label for anything not listed.
const EXTENSION_META = {
  pdf: { icon: 'document-text-outline', label: 'PDF' },
  doc: { icon: 'document-text-outline', label: 'Word' },
  docx: { icon: 'document-text-outline', label: 'Word' },
  xls: { icon: 'grid-outline', label: 'Excel' },
  xlsx: { icon: 'grid-outline', label: 'Excel' },
  csv: { icon: 'grid-outline', label: 'CSV' },
  ppt: { icon: 'easel-outline', label: 'PowerPoint' },
  pptx: { icon: 'easel-outline', label: 'PowerPoint' },
  zip: { icon: 'file-tray-full-outline', label: 'ZIP' },
  png: { icon: 'image-outline', label: 'Image' },
  jpg: { icon: 'image-outline', label: 'Image' },
  jpeg: { icon: 'image-outline', label: 'Image' },
  gif: { icon: 'image-outline', label: 'Image' },
  svg: { icon: 'image-outline', label: 'Image' },
  js: { icon: 'code-slash-outline', label: 'Code' },
  jsx: { icon: 'code-slash-outline', label: 'Code' },
  ts: { icon: 'code-slash-outline', label: 'Code' },
  tsx: { icon: 'code-slash-outline', label: 'Code' },
  json: { icon: 'code-slash-outline', label: 'JSON' },
  html: { icon: 'code-slash-outline', label: 'HTML' },
  css: { icon: 'code-slash-outline', label: 'CSS' },
  py: { icon: 'code-slash-outline', label: 'Python' },
  md: { icon: 'document-outline', label: 'Markdown' },
  txt: { icon: 'document-outline', label: 'Text' },
};
const DEFAULT_META = { icon: 'document-outline', label: 'File' };

function metaForPath(path) {
  const ext = (path || '').split('.').pop()?.toLowerCase();
  return EXTENSION_META[ext] || DEFAULT_META;
}

function fileNameForPath(path) {
  return (path || '').split('/').pop() || path;
}

/** One tappable row for a single artifact - own idle/downloading/done/error state, independent of any siblings in the same card. */
function ArtifactRow({ artifact, theme, onToast, isLast }) {
  const [status, setStatus] = useState('idle'); // idle | downloading | done | error
  const meta = metaForPath(artifact.path);
  const fileName = fileNameForPath(artifact.path);

  const handleDownload = async () => {
    if (status === 'downloading') return;
    setStatus('downloading');

    try {
      const granted = await filesystemTool.hasAccess();
      if (!granted) {
        // Must run from this direct tap - Android requires the folder
        // picker to originate from real user interaction, and this
        // TouchableOpacity press qualifies. See this file's header.
        const grant = await filesystemTool.requestAccess();
        if (!grant.success) {
          setStatus('error');
          onToast?.(grant.error?.message || 'Folder access was not granted.');
          return;
        }
      }

      const result = await pullFile(artifact.path, artifact.path);
      if (result.success) {
        setStatus('done');
        onToast?.(`Saved ${fileName} to your download folder`);
      } else {
        setStatus('error');
        onToast?.(result.error?.message || `Could not download ${fileName}.`);
      }
    } catch (err) {
      setStatus('error');
      onToast?.(err?.message || `Could not download ${fileName}.`);
    }
  };

  return (
    <TouchableOpacity
      style={[styles.row, { borderColor: theme.border }, isLast && styles.rowLast]}
      onPress={handleDownload}
      disabled={status === 'downloading'}
      activeOpacity={0.7}
    >
      <View style={[styles.rowIcon, { backgroundColor: theme.surfaceAlt }]}>
        <Ionicons name={meta.icon} size={20} color={theme.textSecondary} />
      </View>
      <View style={styles.rowInfo}>
        <Text style={[styles.rowName, { color: theme.textPrimary }]} numberOfLines={1}>{fileName}</Text>
        <Text style={[styles.rowType, { color: theme.textTertiary }]}>{meta.label}</Text>
      </View>
      {status === 'downloading' && <ActivityIndicator size="small" color={theme.textSecondary} />}
      {status === 'done' && <Ionicons name="checkmark-circle" size={20} color={theme.success || '#22C55E'} />}
      {status === 'error' && <Ionicons name="refresh-outline" size={20} color={theme.dangerText} />}
      {status === 'idle' && <Ionicons name="download-outline" size={20} color={theme.textSecondary} />}
    </TouchableOpacity>
  );
}

/**
 * @param {object} props
 * @param {Array<{path: string, toolName: string}>} props.artifacts
 * @param {object} props.theme - from useTheme()
 * @param {(text: string) => void} [props.onToast] - e.g. toastRef.current?.show
 */
export default function FileArtifactCard({ artifacts, theme, onToast }) {
  if (!Array.isArray(artifacts) || artifacts.length === 0) return null;

  return (
    <View style={[styles.card, { backgroundColor: theme.surface, borderColor: theme.border }]}>
      {artifacts.map((artifact, i) => (
        <ArtifactRow
          key={`${artifact.path}-${i}`}
          artifact={artifact}
          theme={theme}
          onToast={onToast}
          isLast={i === artifacts.length - 1}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginTop: 6,
    borderWidth: 1,
    borderRadius: 14,
    alignSelf: 'flex-start',
    maxWidth: '92%',
    overflow: 'hidden',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingVertical: 10,
    paddingHorizontal: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  rowLast: {
    borderBottomWidth: 0,
  },
  rowIcon: {
    width: 34,
    height: 34,
    borderRadius: 8,
    alignItems: 'center',
    justifyContent: 'center',
  },
  rowInfo: {
    flex: 1,
    minWidth: 0,
  },
  rowName: {
    fontSize: 14,
    fontWeight: '600',
  },
  rowType: {
    fontSize: 11,
    marginTop: 1,
  },
});
