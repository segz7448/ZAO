/**
 * ZAO - Task Planner (Planning Hierarchy, level 3 of 4)
 *
 *   Strategic planner
 *   Project planner
 *   Task planner       <-- you are here
 *   Execution planner
 *
 * This is Task Planning (planning type 3/8): "converts goals into
 * tasks" - the part of the hierarchy that turns a project-sized (or,
 * for a 'small'-scope goal with no project layer, goal-sized) piece of
 * work into a list of concrete, individually-completable tasks, each
 * with its own subtasks where a task is still too coarse to hand
 * straight to the execution planner.
 *
 * Each task this produces becomes a plans row with level='task',
 * plan_type='task', parent_plan_id = the project plan's id (or the
 * strategic plan's id directly, for a 'small'-scope goal with no
 * project layer). executionPlanner.js then runs once per task,
 * per subtask.
 *
 * SUBTASKS: modeled as plain objects nested under a task rather than
 * their own plans rows - a subtask isn't independently resumable or
 * status-tracked the way a task is, it's just this task planner being
 * honest that "task" and "single execution step" aren't always the same
 * granularity. executionPlanner.js flattens task.subtasks (if present)
 * into its step list; if a task has no subtasks, the task itself is the
 * unit executionPlanner.js expands into steps.
 */

import { v4 as uuidv4 } from 'uuid';
import * as llamaEngine from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import { PLANNING_TYPES, PLAN_LEVELS } from './planTypes';

const TASK_SYSTEM_PROMPT = `You are ZAO's task planner. You're given one project-level (or goal-level, if there's no project layer) piece of work. Break it into concrete TASKS - each one a self-contained unit of work that could be handed to someone and completed without needing the other tasks to already be done first (unless a real dependency exists - that's fine, just note it).

If a task is still coarse enough that it has clearly separate parts (e.g. "set up the database" = create schema + write migrations + seed test data), give it "subtasks" - short, ordered sub-steps within that one task. Most tasks won't need subtasks; only add them when the task genuinely has distinct internal parts.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "tasks": [
    {
      "title": "short task name",
      "description": "1-2 sentences on what this task involves",
      "dependsOnTaskTitles": ["title of another task in this same list that must finish first - omit or empty array if none"],
      "subtasks": ["short subtask description", "another subtask description"]
    }
  ]
}`;

/**
 * @param {object} parentPlan - a project plan (from projectPlanner.js) or, for a 'small'/no-project-layer goal, the strategic plan itself. Needs { id, title|goal, description|successCriteria }.
 * @returns {Promise<{success: boolean, taskPlans: Array<object>, error: object|null}>}
 *   Each entry: { id, title, description, subtasks: string[], dependsOnTaskTitles: string[], level: 'task', planType: 'task', parentPlanId }
 */
export async function planTasks(parentPlan) {
  const contextLabel = parentPlan.title || parentPlan.goal;
  const contextDetail = parentPlan.description || parentPlan.successCriteria || '';

  const history = [
    { role: 'system', content: TASK_SYSTEM_PROMPT },
    { role: 'user', content: `Piece of work: ${contextLabel}\nDetail: ${contextDetail}` },
  ];

  const modelResult = await llamaEngine.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
    maxTokens: 900,
    temperature: 0.25,
  });

  const parsed = modelResult.success && modelResult.data?.content ? safeParseTaskJson(modelResult.data.content) : null;
  const rawTasks = Array.isArray(parsed?.tasks) && parsed.tasks.length ? parsed.tasks : [{ title: contextLabel, description: contextDetail, subtasks: [], dependsOnTaskTitles: [] }];

  const taskPlans = rawTasks.map((task) => ({
    id: uuidv4(),
    title: task.title || contextLabel,
    description: task.description || '',
    subtasks: Array.isArray(task.subtasks) ? task.subtasks.filter(Boolean) : [],
    dependsOnTaskTitles: Array.isArray(task.dependsOnTaskTitles) ? task.dependsOnTaskTitles.filter(Boolean) : [],
    level: PLAN_LEVELS.TASK,
    planType: PLANNING_TYPES.TASK,
    parentPlanId: parentPlan.id,
  }));

  // Resolve dependsOnTaskTitles (human-readable, from the model) into
  // dependsOnTaskId (a real id within this batch) now that every task in
  // the batch has an id - dependencyPlanner.js consumes dependsOnTaskId,
  // not the title, so this is the one place title->id resolution needs
  // to happen.
  const titleToId = new Map(taskPlans.map((t) => [normalizeTitle(t.title), t.id]));
  for (const task of taskPlans) {
    task.dependsOnTaskIds = task.dependsOnTaskTitles
      .map((title) => titleToId.get(normalizeTitle(title)))
      .filter((id) => id && id !== task.id);
  }

  return { success: true, taskPlans, error: null };
}

function normalizeTitle(title) {
  return (title || '').trim().toLowerCase();
}

function safeParseTaskJson(rawContent) {
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}
