/**
 * ZAO - Strategic Planner (Planning Hierarchy, level 1 of 4)
 *
 *   Strategic planner  <-- you are here
 *   Project planner
 *   Task planner
 *   Execution planner
 *
 * This is Goal Planning (planning type 1/8): turning the person's raw
 * request into a single source of truth for "what does done actually
 * mean here?" before anything else gets decided. Every other planner in
 * this folder works underneath a strategic plan, even when that plan is
 * a thin one-node wrapper around a simple request.
 *
 * WHAT THIS MIRRORS ABOUT HOW CLAUDE PLANS:
 * Before decomposing a task, a careful agent first restates the goal in
 * its own words and asks "how will I know I'm actually done, not just
 * busy?" - vague success criteria is one of the most common causes of an
 * agent doing real work that doesn't satisfy the actual request. This
 * planner forces that restatement into a `success_criteria` string that
 * gets stored on the plans row and carried down to every child plan, so
 * a Task or Execution planner three levels deep can still check its work
 * against the original intent instead of drifting into "technically did
 * something" territory.
 *
 * This planner does NOT decide *how* to do the work - that's Project/
 * Task/Execution's job. It only decides: what is the goal, what does
 * success look like, and is this big enough to need the full hierarchy
 * or should it collapse straight to one execution plan.
 */

import { v4 as uuidv4 } from 'uuid';
import * as llamaEngine from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import { PLANNING_TYPES, PLAN_LEVELS, shouldDecompose } from './planTypes';

const STRATEGIC_SYSTEM_PROMPT = `You are ZAO's strategic planner - the first thing that looks at a person's request before any work happens.

Your only job: read the request and produce a JSON object describing the GOAL, not the steps to achieve it. Do not list tool calls, file names, or commands here - that happens later, in other planning stages.

Respond with ONLY a JSON object, no markdown fences, no commentary, in exactly this shape:
{
  "goalSummary": "one-sentence restatement of what the person actually wants, in your own words",
  "successCriteria": "a concrete, checkable description of what 'done' looks like - specific enough that someone could look at the end result and say yes/no, not 'the app works well'",
  "scope": "small | medium | large - small: one clear unit of work with no real sub-parts. medium: a handful of related pieces that still form one coherent deliverable. large: multiple distinct deliverables or phases that each deserve their own tracking.",
  "majorDeliverables": ["short phrase for each distinct deliverable/phase - empty array if scope is 'small'"]
}`;

/**
 * Builds the top-level Strategic plan node. Always creates exactly one
 * plans row at level='strategic', plan_type='goal' - the root of
 * whatever hierarchy (if any) gets built under it. Uses the fast local
 * gate in shouldDecompose() first so trivial requests skip the model
 * call entirely for the "should I decompose" question; the model is
 * still asked for goalSummary/successCriteria either way since those
 * are useful even for a one-step plan.
 *
 * @param {string} goalText - the person's raw request
 * @param {object} context - { conversationId }
 * @returns {Promise<{success: boolean, strategicPlan: object|null, error: object|null}>}
 *   strategicPlan shape: { id, goal, successCriteria, scope, majorDeliverables, level: 'strategic', planType: 'goal' }
 */
export async function planGoal(goalText, context = {}) {
  const { conversationId = null } = context;
  const localGate = shouldDecompose(goalText);

  const history = [
    { role: 'system', content: STRATEGIC_SYSTEM_PROMPT },
    { role: 'user', content: goalText },
  ];

  const modelResult = await llamaEngine.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
    maxTokens: 512,
    temperature: 0.2,
  });

  let parsed = null;
  if (modelResult.success && modelResult.data?.content) {
    parsed = safeParseGoalJson(modelResult.data.content);
  }

  // Fall back to the cheap local heuristic if the model call failed or
  // returned something unparseable - a strategic plan should never be a
  // hard blocker just because JSON parsing hiccuped once.
  const goalSummary = parsed?.goalSummary || goalText;
  const successCriteria = parsed?.successCriteria || `The request "${goalText}" is fully carried out with no pending or failed steps.`;
  const scope = parsed?.scope && ['small', 'medium', 'large'].includes(parsed.scope) ? parsed.scope : (localGate.decompose ? 'medium' : 'small');
  const majorDeliverables = Array.isArray(parsed?.majorDeliverables) ? parsed.majorDeliverables.filter(Boolean) : [];

  const decompose = scope !== 'small' && (majorDeliverables.length > 0 || localGate.decompose);

  const strategicPlan = {
    id: uuidv4(),
    conversationId,
    goal: goalSummary,
    rawGoal: goalText,
    successCriteria,
    scope,
    majorDeliverables,
    decompose,
    level: PLAN_LEVELS.STRATEGIC,
    planType: PLANNING_TYPES.GOAL,
  };

  return { success: true, strategicPlan, error: null };
}

function safeParseGoalJson(rawContent) {
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}
