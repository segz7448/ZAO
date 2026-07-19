/**
 * ZAO - Step Detail Sheet
 *
 * The drill-down for one plan_steps row, matching the four-tier reveal
 * this was modeled on:
 *
 *   1. Thought process   -> step.reasoning (this view's top section,
 *                           collapsed under a "Thought process" label -
 *                           the WHY, distinct from the narration)
 *   2. Narration          -> step.description (already visible on
 *                           PlanScreen.js's checklist row before this
 *                           sheet is ever opened - repeated here for
 *                           context once the sheet is open)
 *   3. Step/action group   -> step.actions (this view's list - "N
 *                           action(s)" - one row per real tool-call
 *                           ATTEMPT for this step; more than one only
 *                           when recoveryPlanner.js retried it)
 *   4. Individual call detail -> tapping one action row drills one level
 *                           further into ITS real input_json/output_json -
 *                           the literal arguments sent and the literal
 *                           result returned, not a description of either
 *
 * Two-level internal navigation (list of actions -> one action's detail)
 * mirrors the reference screenshots' own Summary-sheet-within-a-sheet
 * pattern (tap "N steps" -> Summary list -> tap one row -> Input/Output),
 * kept as local view-state here rather than a full second modal so it
 * reads as one continuous drill-down rather than two separate popups.
 */

import React, { useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, Modal } from 'react-native';
import { Ionicons } from '@expo/vector-icons';

const ACTION_STATUS_ICON = {
  running: { name: 'sync', color: '#3B82F6' },
  done: { name: 'checkmark-circle', color: '#16A34A' },
  failed: { name: 'close-circle', color: '#DC2626' },
};

/** Pretty-prints a JSON string for display - falls back to the raw text if it isn't valid JSON (e.g. a plain error string), rather than crashing the sheet on unexpected content. */
function prettyJson(raw) {
  if (!raw) return '(none)';
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch (err) {
    return raw;
  }
}

/**
 * @param {object} step - a plan_steps row with `.actions` attached (from getPlan())
 * @param {boolean} visible
 * @param {() => void} onClose
 */
export default function StepDetailSheet({ step, visible, onClose, theme }) {
  const [openActionId, setOpenActionId] = useState(null);

  if (!step) return null;

  const actions = step.actions || [];
  const openAction = actions.find((a) => a.id === openActionId) || null;

  const handleClose = () => {
    setOpenActionId(null);
    onClose?.();
  };

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={handleClose}>
      <View style={styles.backdrop}>
        <View style={[styles.sheet, { backgroundColor: theme.background }]}>
          <View style={styles.grabberRow}>
            <View style={[styles.grabber, { backgroundColor: theme.border }]} />
          </View>

          <View style={styles.headerRow}>
            {openAction ? (
              <TouchableOpacity onPress={() => setOpenActionId(null)} hitSlop={8} style={styles.backBtn}>
                <Ionicons name="chevron-back" size={22} color={theme.textPrimary} />
              </TouchableOpacity>
            ) : (
              <View style={styles.backBtn} />
            )}
            <Text style={[styles.headerTitle, { color: theme.textPrimary }]} numberOfLines={1}>
              {openAction ? (openAction.label || openAction.tool_name || 'Tool call') : 'Step detail'}
            </Text>
            <TouchableOpacity onPress={handleClose} hitSlop={8} style={styles.closeBtn}>
              <Ionicons name="close" size={22} color={theme.textPrimary} />
            </TouchableOpacity>
          </View>

          <ScrollView contentContainerStyle={styles.content}>
            {openAction ? (
              <ActionDetail action={openAction} theme={theme} />
            ) : (
              <StepOverview step={step} actions={actions} theme={theme} onOpenAction={(id) => setOpenActionId(id)} />
            )}
          </ScrollView>
        </View>
      </View>
    </Modal>
  );
}

/** Tier 1 (reasoning) + tier 3 (action-group summary list) - what's shown before drilling into one specific action. */
function StepOverview({ step, actions, theme, onOpenAction }) {
  return (
    <>
      {step.reasoning ? (
        <View style={styles.section}>
          <View style={styles.sectionLabelRow}>
            <Ionicons name="time-outline" size={14} color={theme.textTertiary} />
            <Text style={[styles.sectionLabel, { color: theme.textTertiary }]}>Thought process</Text>
          </View>
          <Text style={[styles.reasoningText, { color: theme.textSecondary }]}>{step.reasoning}</Text>
        </View>
      ) : null}

      <View style={styles.section}>
        <View style={styles.sectionLabelRow}>
          <Ionicons name="chatbubble-outline" size={14} color={theme.textTertiary} />
          <Text style={[styles.sectionLabel, { color: theme.textTertiary }]}>What this step does</Text>
        </View>
        <Text style={[styles.narrationText, { color: theme.textPrimary }]}>{step.description}</Text>
      </View>

      <View style={styles.section}>
        <View style={styles.sectionLabelRow}>
          <Ionicons name="link-outline" size={14} color={theme.textTertiary} />
          <Text style={[styles.sectionLabel, { color: theme.textTertiary }]}>
            {actions.length} entr{actions.length === 1 ? 'y' : 'ies'} in this step's chain
          </Text>
        </View>
        {actions.length === 0 ? (
          <Text style={[styles.emptyText, { color: theme.textTertiary }]}>No tool call has run for this step yet.</Text>
        ) : (
          actions.map((action, index) => (
            <ChainEntry
              key={action.id}
              action={action}
              isLast={index === actions.length - 1}
              theme={theme}
              onOpen={() => action.entry_type !== 'reasoning' && onOpenAction(action.id)}
            />
          ))
        )}
      </View>
    </>
  );
}

/**
 * One link in a step's chain (see plan_step_actions' schema comment in
 * database.js) - either a real tool call (tappable, drills into tier 4's
 * input/output) or a reasoning bullet explaining what was concluded from
 * the call before it and what happens next (not tappable - there's no
 * input/output behind a thought). Connected to the next entry by a
 * vertical line, the same visual language riskClassifier-adjacent chains
 * use elsewhere in the reference trace (tool call -> reasoning -> tool
 * call -> ...).
 */
function ChainEntry({ action, isLast, theme, onOpen }) {
  const isReasoning = action.entry_type === 'reasoning';

  if (isReasoning) {
    return (
      <View style={styles.chainRow}>
        <View style={styles.chainIconCol}>
          <View style={[styles.reasoningDot, { backgroundColor: theme.textTertiary }]} />
          {!isLast && <View style={[styles.chainConnector, { backgroundColor: theme.border }]} />}
        </View>
        <Text style={[styles.chainReasoningText, { color: theme.textSecondary }]}>
          {action.reasoning_text || '(no reasoning recorded)'}
        </Text>
      </View>
    );
  }

  const iconInfo = ACTION_STATUS_ICON[action.status] || ACTION_STATUS_ICON.running;
  const toolIcon = toolIconFor(action.tool_name);

  return (
    <View style={styles.chainRow}>
      <View style={styles.chainIconCol}>
        <Ionicons name={toolIcon} size={16} color={theme.textTertiary} />
        {!isLast && <View style={[styles.chainConnector, { backgroundColor: theme.border }]} />}
      </View>
      <TouchableOpacity style={styles.chainToolTouchable} onPress={onOpen}>
        <Ionicons name={iconInfo.name} size={16} color={iconInfo.color} />
        <View style={styles.actionRowTextWrap}>
          <Text style={[styles.actionRowTitle, { color: theme.textPrimary }]} numberOfLines={1}>
            {action.label || action.tool_name || 'Tool call'}
          </Text>
          <Text style={[styles.actionRowSubtitle, { color: theme.textTertiary }]} numberOfLines={1}>
            {action.tool_name || 'unresolved tool'}
          </Text>
        </View>
        <Ionicons name="chevron-forward" size={16} color={theme.textTertiary} />
      </TouchableOpacity>
    </View>
  );
}

/** Picks a distinct icon by tool domain the same way the reference trace visually differentiates a bash-style call from a file-read call, rather than one fixed icon for every tool_call entry. */
function toolIconFor(toolName) {
  const name = (toolName || '').toLowerCase();
  if (name.startsWith('fs_') || name.includes('file')) return 'document-text-outline';
  if (name.startsWith('github_')) return 'logo-github';
  if (name.startsWith('terminal_') || name.includes('command') || name.includes('bash')) return 'terminal-outline';
  if (name.includes('browser')) return 'globe-outline';
  return 'construct-outline';
}

/** Tier 4 - the real input/output of one literal tool-call attempt. */
function ActionDetail({ action, theme }) {
  return (
    <>
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: theme.textTertiary }]}>Input</Text>
        <View style={[styles.codeBlock, { backgroundColor: theme.surfaceAlt }]}>
          <Text style={[styles.codeText, { color: theme.textPrimary }]} selectable>
            {prettyJson(action.input_json)}
          </Text>
        </View>
      </View>
      <View style={styles.section}>
        <Text style={[styles.sectionLabel, { color: theme.textTertiary }]}>Output</Text>
        <View style={[styles.codeBlock, { backgroundColor: theme.surfaceAlt }]}>
          <Text style={[styles.codeText, { color: theme.textPrimary }]} selectable>
            {action.status === 'running' ? '(still running…)' : prettyJson(action.output_json)}
          </Text>
        </View>
      </View>
    </>
  );
}

const styles = StyleSheet.create({
  backdrop: { flex: 1, backgroundColor: 'rgba(0,0,0,0.4)', justifyContent: 'flex-end' },
  sheet: { maxHeight: '85%', borderTopLeftRadius: 20, borderTopRightRadius: 20, paddingBottom: 24 },
  grabberRow: { alignItems: 'center', paddingVertical: 10 },
  grabber: { width: 36, height: 4, borderRadius: 2 },
  headerRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 10, paddingBottom: 10 },
  backBtn: { width: 34, alignItems: 'flex-start' },
  closeBtn: { width: 34, alignItems: 'flex-end' },
  headerTitle: { flex: 1, textAlign: 'center', fontSize: 16, fontWeight: '700' },
  content: { paddingHorizontal: 18, paddingBottom: 30 },
  section: { marginBottom: 20 },
  sectionLabelRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginBottom: 6 },
  sectionLabel: { fontSize: 12, fontWeight: '700', textTransform: 'uppercase', letterSpacing: 0.4 },
  reasoningText: { fontSize: 14, lineHeight: 20, fontStyle: 'italic' },
  narrationText: { fontSize: 15, lineHeight: 21 },
  emptyText: { fontSize: 13, fontStyle: 'italic' },
  actionRowTextWrap: { flex: 1 },
  actionRowTitle: { fontSize: 14, fontWeight: '600' },
  actionRowSubtitle: { fontSize: 11, marginTop: 1 },
  codeBlock: { borderRadius: 10, padding: 12 },
  codeText: { fontSize: 12, fontFamily: 'Menlo, Courier' },
  chainRow: { flexDirection: 'row', gap: 10 },
  chainIconCol: { alignItems: 'center', width: 16 },
  chainConnector: { width: 1.5, flex: 1, minHeight: 14, marginTop: 4 },
  reasoningDot: { width: 6, height: 6, borderRadius: 3, marginTop: 6 },
  chainReasoningText: { flex: 1, fontSize: 13, lineHeight: 19, fontStyle: 'italic', paddingBottom: 14 },
  chainToolTouchable: { flex: 1, flexDirection: 'row', alignItems: 'center', gap: 10, paddingBottom: 14 },
});
