/**
 * ZAO - Plan Screen
 *
 * Checklist view of a plan (see src/store/planStore.js, src/db/database.js's
 * Plans section). Phase 2: the planning layer is now hierarchical
 * (Strategic -> Project -> Task -> Execution, see
 * src/services/planning/planTypes.js) and every step can carry a
 * milestone, so this screen renders three things Phase 1 didn't have -
 * a milestone progress strip, a "blocked" step state (a dependency
 * failed/was skipped), and, when a hierarchical plan is loaded via
 * planStore's activePlanTree, a per-task section grouping instead of one
 * flat list. A simple plan (no project/task layer, no milestones) still
 * renders exactly as Phase 1's flat checklist did - all of this is
 * additive and only shows when the data is actually there.
 */

import React, { useEffect, useState } from 'react';
import { View, Text, ScrollView, StyleSheet, TouchableOpacity, ActivityIndicator } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { usePlanStore } from '../store/planStore';
import { useTheme } from '../theme/useTheme';
import StepDetailSheet from './StepDetailSheet';

const STEP_STATUS_ICON = {
  pending: { name: 'ellipse-outline', color: null }, // color resolved from theme at render time
  running: { name: 'sync', color: '#3B82F6' },
  awaiting_approval: { name: 'alert-circle', color: '#F59E0B' },
  done: { name: 'checkmark-circle', color: '#16A34A' },
  failed: { name: 'close-circle', color: '#DC2626' },
  skipped: { name: 'remove-circle-outline', color: null },
  blocked: { name: 'lock-closed', color: '#9CA3AF' },
};

const DOMAIN_LABEL = {
  coding: 'Coding',
  terminal: 'Terminal',
  files: 'Files',
  browser: 'Browser',
  github: 'GitHub',
  planning: 'Planning',
};

const PLAN_STATUS_LABEL = {
  planning: 'Planning…',
  running: 'In progress',
  awaiting_approval: 'Needs your approval',
  paused: 'Paused',
  recovering: 'Recovering from a failed step…',
  completed: 'Completed',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

const MILESTONE_STATUS_ICON = {
  pending: { name: 'ellipse-outline', color: null },
  in_progress: { name: 'time', color: '#3B82F6' },
  reached: { name: 'checkmark-circle', color: '#16A34A' },
  missed: { name: 'close-circle', color: '#DC2626' },
};

export default function PlanScreen({ planId, onClose, onApproveStep, onRejectStep, onCancelPlan, onAcceptCheckpoint, onDismissCheckpoint, onStartPlan }) {
  const theme = useTheme();
  const { activePlan, isLoading, loadPlan } = usePlanStore();
  const [detailStep, setDetailStep] = useState(null); // tapped step for StepDetailSheet's drill-down, or null when the sheet is closed

  useEffect(() => {
    if (planId) loadPlan(planId);
  }, [planId]);

  if (isLoading && !activePlan) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <ActivityIndicator size="large" color={theme.textSecondary} />
      </View>
    );
  }

  if (!activePlan) {
    return (
      <View style={[styles.center, { backgroundColor: theme.background }]}>
        <Text style={{ color: theme.textSecondary }}>No plan found.</Text>
        <TouchableOpacity onPress={onClose} style={{ marginTop: 16 }}>
          <Text style={{ color: theme.info }}>Close</Text>
        </TouchableOpacity>
      </View>
    );
  }

  const { goal, status, steps = [], milestones = [], checkpoint_pending, checkpoint_reason } = activePlan;
  const doneCount = steps.filter((s) => s.status === 'done').length;
  const awaitingStep = steps.find((s) => s.status === 'awaiting_approval');
  // Plan Mode's pre-run state: the plan was proposed and paused
  // (backendBrain.js's runHierarchicalPlan sets awaiting_approval on
  // every leaf right after building it, before anything runs) and
  // nothing has actually started yet - no step is individually
  // awaiting_approval (that only happens once the executor hits a
  // risky step mid-run) and none are done or running. Distinct from
  // `awaitingStep` above, which is a step-level pause during a run
  // already underway.
  const isAwaitingStart = status === 'awaiting_approval'
    && !awaitingStep
    && steps.length > 0
    && steps.every((s) => s.status === 'pending');
  const reachedMilestoneCount = milestones.filter((m) => m.status === 'reached').length;
  // Re-look-up the tapped step by id against the current steps array
  // each render, rather than holding the stale object captured at tap
  // time - activePlan refreshes as actions run (see planStore.js's
  // refreshActivePlan()), and StepDetailSheet should show live status/
  // actions, not a snapshot from the moment it was opened.
  const freshDetailStep = detailStep ? steps.find((s) => s.id === detailStep.id) || null : null;

  return (
    <View style={[styles.container, { backgroundColor: theme.background }]}>
      <View style={[styles.header, { borderBottomColor: theme.border }]}>
        <TouchableOpacity onPress={onClose} hitSlop={8}>
          <Ionicons name="chevron-back" size={24} color={theme.textPrimary} />
        </TouchableOpacity>
        <View style={styles.headerTextWrap}>
          <Text style={[styles.headerGoal, { color: theme.textPrimary }]} numberOfLines={2}>{goal}</Text>
          <Text style={[styles.headerStatus, { color: theme.textSecondary }]}>
            {PLAN_STATUS_LABEL[status] || status} · {doneCount}/{steps.length} steps done
            {milestones.length > 0 ? ` · ${reachedMilestoneCount}/${milestones.length} milestones` : ''}
          </Text>
        </View>
        {(status === 'running' || status === 'awaiting_approval' || status === 'paused' || status === 'recovering') && (
          <TouchableOpacity onPress={() => onCancelPlan?.(activePlan.id)} hitSlop={8}>
            <Text style={[styles.cancelText, { color: theme.textSecondary }]}>Stop</Text>
          </TouchableOpacity>
        )}
      </View>

      {milestones.length > 0 && <MilestoneStrip milestones={milestones} theme={theme} />}

      <ScrollView contentContainerStyle={styles.list}>
        {steps.map((step, index) => (
          <StepRow
            key={step.id}
            step={step}
            index={index}
            isLast={index === steps.length - 1}
            theme={theme}
            onApprove={() => onApproveStep?.(step, step.plan_id || activePlan.id)}
            onReject={() => onRejectStep?.(step, step.plan_id || activePlan.id)}
            onOpenDetail={() => setDetailStep(step)}
          />
        ))}
      </ScrollView>

      {isAwaitingStart && (
        <View style={[styles.approvalBar, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
          <Text style={[styles.approvalReason, { color: theme.textPrimary }]} numberOfLines={4}>
            Nothing has run yet - review the steps above, then start the plan or cancel it.
          </Text>
          <View style={styles.approvalButtons}>
            <TouchableOpacity
              style={[styles.approvalBtn, styles.rejectBtn]}
              onPress={() => onCancelPlan?.(activePlan.id)}
            >
              <Text style={styles.rejectBtnText}>Cancel</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.approvalBtn, styles.approveBtn]}
              onPress={() => onStartPlan?.(activePlan.id)}
            >
              <Text style={styles.approveBtnText}>Start plan</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {awaitingStep && (
        <View style={[styles.approvalBar, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
          <Text style={[styles.approvalReason, { color: theme.textPrimary }]} numberOfLines={3}>
            {awaitingStep.risk_reason || 'This step needs your approval before it runs.'}
          </Text>
          <View style={styles.approvalButtons}>
            <TouchableOpacity
              style={[styles.approvalBtn, styles.rejectBtn]}
              onPress={() => onRejectStep?.(awaitingStep, awaitingStep.plan_id || activePlan.id)}
            >
              <Text style={styles.rejectBtnText}>Skip this step</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.approvalBtn, styles.approveBtn]}
              onPress={() => onApproveStep?.(awaitingStep, awaitingStep.plan_id || activePlan.id)}
            >
              <Text style={styles.approveBtnText}>Approve & run</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      {!awaitingStep && !!checkpoint_pending && (
        <View style={[styles.checkpointBar, { backgroundColor: theme.surface, borderTopColor: theme.border }]}>
          <View style={styles.checkpointHeaderRow}>
            <Ionicons name="flag" size={16} color="#3B82F6" />
            <Text style={[styles.checkpointTitle, { color: theme.textPrimary }]}>Checkpoint suggested</Text>
          </View>
          <Text style={[styles.approvalReason, { color: theme.textSecondary }]} numberOfLines={4}>
            {checkpoint_reason || 'A good amount has changed since the last checkpoint - worth verifying before continuing.'}
          </Text>
          <View style={styles.approvalButtons}>
            <TouchableOpacity
              style={[styles.approvalBtn, styles.rejectBtn]}
              onPress={() => onDismissCheckpoint?.(activePlan.checkpoint_plan_id || activePlan.id)}
            >
              <Text style={styles.rejectBtnText}>Continue without checkpoint</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.approvalBtn, styles.approveBtn]}
              onPress={() => onAcceptCheckpoint?.(activePlan.checkpoint_plan_id || activePlan.id)}
            >
              <Text style={styles.approveBtnText}>Mark checkpoint & continue</Text>
            </TouchableOpacity>
          </View>
        </View>
      )}

      <StepDetailSheet
        step={freshDetailStep}
        visible={!!freshDetailStep}
        onClose={() => setDetailStep(null)}
        theme={theme}
      />
    </View>
  );
}

/**
 * Horizontal strip of milestone dots above the step checklist -
 * milestonePlanner.js's output made visible. Tapping isn't wired to
 * anything yet (purely a progress-at-a-glance strip); each dot's label
 * is the milestone title, truncated, with the connecting line colored to
 * show reached vs not-yet-reached.
 */
function MilestoneStrip({ milestones, theme }) {
  return (
    <View style={[styles.milestoneStrip, { borderBottomColor: theme.border }]}>
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.milestoneStripContent}>
        {milestones.map((milestone, index) => {
          const iconInfo = MILESTONE_STATUS_ICON[milestone.status] || MILESTONE_STATUS_ICON.pending;
          const iconColor = iconInfo.color || theme.textTertiary;
          const isLast = index === milestones.length - 1;
          return (
            <View key={milestone.id} style={styles.milestoneItem}>
              <View style={styles.milestoneDotRow}>
                <Ionicons name={iconInfo.name} size={16} color={iconColor} />
                {!isLast && (
                  <View
                    style={[
                      styles.milestoneConnector,
                      { backgroundColor: milestone.status === 'reached' ? '#16A34A' : theme.border },
                    ]}
                  />
                )}
              </View>
              <Text style={[styles.milestoneLabel, { color: theme.textSecondary }]} numberOfLines={1}>
                {milestone.title}
              </Text>
            </View>
          );
        })}
      </ScrollView>
    </View>
  );
}

function StepRow({ step, index, isLast, theme, onApprove, onReject, onOpenDetail }) {
  const iconInfo = STEP_STATUS_ICON[step.status] || STEP_STATUS_ICON.pending;
  const iconColor = iconInfo.color || theme.textTertiary;
  const isDimmed = step.status === 'pending' || step.status === 'skipped' || step.status === 'blocked';
  const isSubtask = !!step.subtask_of_step_id;

  let details = null;
  try {
    details = step.details_json ? JSON.parse(step.details_json) : null;
  } catch (err) {
    details = null;
  }
  const subtaskLabel = details?.subtask;

  const actionCount = (step.actions || []).filter((a) => a.entry_type !== 'reasoning').length; // hint shows real tool-call count, not reasoning-chain entries

  return (
    <TouchableOpacity
      activeOpacity={0.7}
      onPress={onOpenDetail}
      style={[styles.stepRow, isSubtask && styles.stepRowIndented]}
    >
      <View style={styles.stepIconCol}>
        <Ionicons name={iconInfo.name} size={20} color={iconColor} />
        {!isLast && <View style={[styles.stepConnector, { backgroundColor: theme.border }]} />}
      </View>
      <View style={styles.stepContent}>
        <View style={styles.stepTopRow}>
          <Text style={[styles.stepDomainTag, { color: theme.textTertiary, backgroundColor: theme.surfaceAlt }]}>
            {DOMAIN_LABEL[step.domain] || step.domain}
          </Text>
          {subtaskLabel ? (
            <Text style={[styles.subtaskTag, { color: theme.textTertiary }]} numberOfLines={1}>· {subtaskLabel}</Text>
          ) : null}
          {step.is_risky ? <Ionicons name="warning" size={13} color="#F59E0B" style={{ marginLeft: 6 }} /> : null}
        </View>
        <Text
          style={[styles.stepDescription, { color: isDimmed ? theme.textTertiary : theme.textPrimary }]}
          numberOfLines={3}
        >
          {step.description}
        </Text>
        {step.status === 'failed' && step.error_message ? (
          <Text style={[styles.stepError, { color: '#DC2626' }]} numberOfLines={3}>{step.error_message}</Text>
        ) : null}
        {step.status === 'blocked' ? (
          <Text style={[styles.stepError, { color: theme.textTertiary }]} numberOfLines={2}>
            Blocked: {step.error_message || 'a dependency for this step did not complete.'}
          </Text>
        ) : null}
        {(step.reasoning || actionCount > 0) ? (
          <View style={styles.stepDetailHintRow}>
            {step.reasoning ? <Ionicons name="time-outline" size={12} color={theme.textTertiary} /> : null}
            {actionCount > 0 ? (
              <Text style={[styles.stepDetailHintText, { color: theme.textTertiary }]}>
                {actionCount} call{actionCount === 1 ? '' : 's'}
              </Text>
            ) : null}
            <Ionicons name="chevron-forward" size={12} color={theme.textTertiary} />
          </View>
        ) : null}
      </View>
    </TouchableOpacity>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 10,
    paddingHorizontal: 14,
    paddingTop: 14,
    paddingBottom: 12,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  headerTextWrap: { flex: 1 },
  headerGoal: { fontSize: 16, fontWeight: '700' },
  headerStatus: { fontSize: 12, marginTop: 3 },
  cancelText: { fontSize: 13, fontWeight: '600', paddingTop: 2 },
  list: { padding: 14, paddingBottom: 40 },
  milestoneStrip: {
    borderBottomWidth: StyleSheet.hairlineWidth,
    paddingVertical: 10,
  },
  milestoneStripContent: { paddingHorizontal: 14, alignItems: 'flex-start' },
  milestoneItem: { alignItems: 'center', width: 84 },
  milestoneDotRow: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  milestoneConnector: { flex: 1, height: 1.5, marginLeft: 4 },
  milestoneLabel: { fontSize: 10, marginTop: 4, textAlign: 'center' },
  stepRow: { flexDirection: 'row', gap: 10 },
  stepRowIndented: { marginLeft: 20 },
  stepIconCol: { alignItems: 'center', width: 20 },
  stepConnector: { width: 1.5, flex: 1, minHeight: 18, marginTop: 4 },
  stepContent: { flex: 1, paddingBottom: 18 },
  stepTopRow: { flexDirection: 'row', alignItems: 'center', marginBottom: 4 },
  subtaskTag: { fontSize: 11, marginLeft: 4 },
  stepDetailHintRow: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 6 },
  stepDetailHintText: { fontSize: 11 },
  stepDomainTag: {
    fontSize: 10,
    fontWeight: '700',
    textTransform: 'uppercase',
    letterSpacing: 0.4,
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 4,
    overflow: 'hidden',
  },
  stepDescription: { fontSize: 14, lineHeight: 19 },
  stepError: { fontSize: 12, marginTop: 4 },
  approvalBar: {
    padding: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  approvalReason: { fontSize: 13, fontWeight: '600' },
  approvalButtons: { flexDirection: 'row', gap: 10 },
  approvalBtn: { flex: 1, paddingVertical: 11, borderRadius: 10, alignItems: 'center' },
  rejectBtn: { backgroundColor: '#F3F4F6' },
  rejectBtnText: { color: '#374151', fontWeight: '600', fontSize: 13 },
  approveBtn: { backgroundColor: '#16A34A' },
  approveBtnText: { color: '#fff', fontWeight: '700', fontSize: 13 },
  checkpointBar: {
    padding: 14,
    borderTopWidth: StyleSheet.hairlineWidth,
    gap: 10,
  },
  checkpointHeaderRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  checkpointTitle: { fontSize: 14, fontWeight: '700' },
});
