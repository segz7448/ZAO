/**
 * ZAO - Milestone Planner (Planning type 8/8)
 *
 * "How do I know I'm making real progress?" - a raw step count ("14/40
 * steps done") tells you activity, not progress: 14 setup steps and 14
 * substantive steps look identical in a step counter. Milestones group
 * steps into checkpoints that mean something - "database schema in
 * place," "auth flow working end-to-end," "first successful build" -
 * so a person glancing at PlanScreen.js sees meaningful progress instead
 * of a raw fraction, and so a long-running plan has natural points where
 * "are we still on track?" is a well-formed question.
 *
 * This mirrors how Claude, working through a large task, tends to
 * narrate progress in terms of what's actually been achieved ("the API
 * routes are wired up, now moving to the frontend") rather than a step
 * tally - milestones are that same idea made structural instead of just
 * a narration style.
 *
 * Milestones are computed AFTER dependencyPlanner.js has produced the
 * execution order (see planCoordinator.js's call sequence) - a milestone
 * boundary only makes sense once you know which step is actually last
 * among a meaningful group in run order, not before.
 */

import { v4 as uuidv4 } from 'uuid';
import * as llamaEngine from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';

const MILESTONE_SYSTEM_PROMPT = `You are ZAO's milestone planner. You're given an ordered list of execution steps for a plan. Group them into a small number of milestones - meaningful checkpoints, not just "step N done." A milestone should represent a real, describable state of progress a person would recognize as an achievement, not an arbitrary chunk boundary.

Rules:
- Every step must belong to exactly one milestone.
- Milestones must be in the same order as the steps (a milestone's steps must all come before the next milestone's steps in the list).
- Aim for roughly 2-6 milestones total - fewer for short plans, don't over-fragment.
- The LAST step of each milestone is its "completion point" - use its 0-based index from the list as targetStepIndex.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "milestones": [
    { "title": "short milestone name", "description": "what being at this checkpoint means", "targetStepIndex": 2 }
  ]
}`;

/**
 * @param {Array<{id: string, description: string}>} orderedSteps - steps already in their final execution order
 * @returns {Promise<{success: boolean, milestones: Array<{id, milestoneOrder, title, description, targetStepId}>, stepMilestoneMap: Map<string,string>, error: null}>}
 */
export async function planMilestones(orderedSteps) {
  if (!orderedSteps?.length) {
    return { success: true, milestones: [], stepMilestoneMap: new Map(), error: null };
  }

  // Trivial plans (1-2 steps) don't benefit from milestone decomposition -
  // the whole plan IS the milestone. Skip the model call entirely.
  if (orderedSteps.length <= 2) {
    const milestoneId = uuidv4();
    const milestone = {
      id: milestoneId,
      milestoneOrder: 0,
      title: 'Complete',
      description: 'All steps finished.',
      targetStepId: orderedSteps[orderedSteps.length - 1].id,
    };
    const stepMilestoneMap = new Map(orderedSteps.map((s) => [s.id, milestoneId]));
    return { success: true, milestones: [milestone], stepMilestoneMap, error: null };
  }

  const stepList = orderedSteps.map((s, i) => `${i}. ${s.description}`).join('\n');
  const history = [
    { role: 'system', content: MILESTONE_SYSTEM_PROMPT },
    { role: 'user', content: stepList },
  ];

  const modelResult = await llamaEngine.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
    maxTokens: 600,
    temperature: 0.2,
  });

  const parsed = modelResult.success && modelResult.data?.content ? safeParseMilestoneJson(modelResult.data.content) : null;
  const rawMilestones = Array.isArray(parsed?.milestones) ? parsed.milestones : null;

  if (!rawMilestones || rawMilestones.length === 0) {
    return fallbackEvenSplit(orderedSteps);
  }

  const sanitized = sanitizeMilestoneIndices(rawMilestones, orderedSteps.length);
  if (!sanitized) {
    return fallbackEvenSplit(orderedSteps);
  }

  const milestones = [];
  const stepMilestoneMap = new Map();
  let cursor = 0;

  sanitized.forEach((m, index) => {
    const milestoneId = uuidv4();
    milestones.push({
      id: milestoneId,
      milestoneOrder: index,
      title: m.title,
      description: m.description || '',
      targetStepId: orderedSteps[m.targetStepIndex].id,
    });
    for (; cursor <= m.targetStepIndex; cursor++) {
      stepMilestoneMap.set(orderedSteps[cursor].id, milestoneId);
    }
  });

  return { success: true, milestones, stepMilestoneMap, error: null };
}

/** Ensures targetStepIndex values are valid, strictly increasing, and the last one reaches the final step - if not, the model's grouping can't be trusted and the caller should fall back to an even split. */
function sanitizeMilestoneIndices(rawMilestones, stepCount) {
  const cleaned = [];
  let lastIndex = -1;
  for (const m of rawMilestones) {
    const idx = Number(m.targetStepIndex);
    if (!Number.isInteger(idx) || idx <= lastIndex || idx >= stepCount || !m.title) {
      return null;
    }
    cleaned.push({ title: m.title, description: m.description, targetStepIndex: idx });
    lastIndex = idx;
  }
  if (lastIndex !== stepCount - 1) return null; // last milestone must cover the final step
  return cleaned;
}

/** Deterministic fallback when the model's milestone grouping can't be used: splits steps into up to 4 roughly-even chunks, labeled generically. Keeps the milestone feature always-available even if the model call fails. */
function fallbackEvenSplit(orderedSteps) {
  const targetCount = Math.min(4, Math.max(1, Math.ceil(orderedSteps.length / 5)));
  const chunkSize = Math.ceil(orderedSteps.length / targetCount);
  const milestones = [];
  const stepMilestoneMap = new Map();

  for (let i = 0; i < targetCount; i++) {
    const endIndex = Math.min(orderedSteps.length, (i + 1) * chunkSize) - 1;
    if (endIndex < i * chunkSize) continue;
    const milestoneId = uuidv4();
    milestones.push({
      id: milestoneId,
      milestoneOrder: i,
      title: `Phase ${i + 1}`,
      description: '',
      targetStepId: orderedSteps[endIndex].id,
    });
    for (let s = i * chunkSize; s <= endIndex; s++) {
      stepMilestoneMap.set(orderedSteps[s].id, milestoneId);
    }
  }

  return { success: true, milestones, stepMilestoneMap, error: null };
}

function safeParseMilestoneJson(rawContent) {
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}
