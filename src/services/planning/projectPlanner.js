/**
 * ZAO - Project Planner (Planning Hierarchy, level 2 of 4)
 *
 *   Strategic planner
 *   Project planner    <-- you are here
 *   Task planner
 *   Execution planner
 *
 * This is Project Planning (planning type 2/8): taking the Strategic
 * plan's `majorDeliverables` and turning each one into its own plan
 * node - something big enough to track independently (its own status,
 * its own progress) but still not broken down into runnable steps yet.
 *
 * Only called when strategicPlanner.js decided the goal's `scope` is
 * 'medium' or 'large' and produced a non-empty majorDeliverables list.
 * A 'small'-scope goal skips this planner (and taskPlanner.js) entirely
 * and goes straight to executionPlanner.js - mirrors how Claude doesn't
 * write a project charter for a one-line fix.
 *
 * Each project plan this produces becomes a plans row with
 * level='project', plan_type='project', parent_plan_id = the strategic
 * plan's id. taskPlanner.js then runs once per project plan produced
 * here.
 */

import { v4 as uuidv4 } from 'uuid';
import * as llamaEngine from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import { PLANNING_TYPES, PLAN_LEVELS } from './planTypes';

const PROJECT_SYSTEM_PROMPT = `You are ZAO's project planner. You're given one major deliverable that's part of a larger goal, plus the overall goal for context. Break this ONE deliverable down into its own short scope - still not individual steps, just what this piece of work actually covers and how you'd know it's finished.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "title": "short name for this project piece",
  "description": "1-3 sentences on what this project covers",
  "successCriteria": "concrete, checkable definition of this project piece being done",
  "estimatedTaskCount": 2
}
estimatedTaskCount is your rough guess (1-8) at how many distinct tasks this project will break into - used only as a planning hint, not enforced.`;

/**
 * @param {object} strategicPlan - output of strategicPlanner.planGoal()
 * @returns {Promise<{success: boolean, projectPlans: Array<object>, error: object|null}>}
 *   Each entry: { id, title, description, successCriteria, estimatedTaskCount, level: 'project', planType: 'project', parentPlanId }
 */
export async function planProjects(strategicPlan) {
  if (!strategicPlan?.decompose || !strategicPlan.majorDeliverables?.length) {
    return { success: true, projectPlans: [], error: null };
  }

  const projectPlans = [];

  for (const deliverable of strategicPlan.majorDeliverables) {
    const history = [
      { role: 'system', content: PROJECT_SYSTEM_PROMPT },
      {
        role: 'user',
        content: `Overall goal: ${strategicPlan.goal}\nOverall success criteria: ${strategicPlan.successCriteria}\n\nThis deliverable: ${deliverable}`,
      },
    ];

    const modelResult = await llamaEngine.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
      maxTokens: 400,
      temperature: 0.2,
    });

    const parsed = modelResult.success && modelResult.data?.content ? safeParseProjectJson(modelResult.data.content) : null;

    projectPlans.push({
      id: uuidv4(),
      title: parsed?.title || deliverable,
      description: parsed?.description || deliverable,
      successCriteria: parsed?.successCriteria || `${deliverable} is fully in place and consistent with the overall goal.`,
      estimatedTaskCount: clampTaskCount(parsed?.estimatedTaskCount),
      level: PLAN_LEVELS.PROJECT,
      planType: PLANNING_TYPES.PROJECT,
      parentPlanId: strategicPlan.id,
    });
  }

  return { success: true, projectPlans, error: null };
}

function clampTaskCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 3;
  return Math.max(1, Math.min(8, Math.round(n)));
}

function safeParseProjectJson(rawContent) {
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}
