/**
 * ZAO - Execution Planner (Planning Hierarchy, level 4 of 4)
 *
 *   Strategic planner
 *   Project planner
 *   Task planner
 *   Execution planner  <-- you are here
 *
 * This is Execution Planning (planning type 7/8) - the bottom of the
 * hierarchy, and the ONLY layer that produces literal, tool-callable
 * steps (plan_steps rows with a domain/action/target the executor can
 * actually run). Every layer above this one deals in intent and
 * grouping; this is where intent becomes a concrete "call fs_create_file
 * with this path and this content" instruction.
 *
 * Responsibilities, matching the brief exactly:
 *   - "Converts goals into tasks"      -> delegates to taskPlanner.js one level up; this module converts a TASK (or subtask) into literal steps
 *   - "Creates execution order"        -> delegates to dependencyPlanner.js's resolveExecutionOrder()
 *   - "Handles dependencies"           -> delegates to dependencyPlanner.js's computeDependencyAssignments()
 *   - "Creates subtasks"               -> consumes taskPlanner.js's subtasks array, expanding each into its own steps in order
 *
 * WHAT THIS MIRRORS ABOUT CLAUDE'S OWN EXECUTION-TIME PLANNING:
 * once Claude has decided what needs to happen, it doesn't dump an
 * unordered bag of tool calls - it sequences them so each call has what
 * it needs from the ones before it, classifies which ones are safe to
 * just run vs need a pause for confirmation (mirrored here by
 * riskClassifier.js, reused unchanged from Phase 1), and keeps the
 * granularity of each step small enough that a failure is easy to
 * localize and recover from (see recoveryPlanner.js) rather than one
 * giant unrecoverable operation.
 */

import { v4 as uuidv4 } from 'uuid';
import * as llamaEngine from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import { classifyStep } from './riskClassifier';
import { planDependencies } from './dependencyPlanner';

const EXECUTION_SYSTEM_PROMPT = `You are ZAO's execution planner. You're given one concrete unit of work (a task or subtask). Break it into the literal, ordered tool-call steps needed to accomplish it - this is the lowest level of planning, one level above actually calling the tools.

Each step must specify:
- reasoning: ONE short sentence of WHY this step is needed right now - the internal rationale, not what a person would read as a status update (e.g. "Need the current file contents before editing them, or the replace will target stale text.")
- domain: one of "coding", "terminal", "files", "browser", "github"
- description: plain-language description of what this step does (shown to the person as the narration line - distinct from reasoning, which is shown separately as the step's collapsed "thought process")
- action: the specific action/tool-call name this step maps to (e.g. "fs_create_file", "github_commit_files", "terminal_run_command") - your best guess at the real tool, the executor will resolve the exact function
- target: the file path / repo / URL / command this step acts on
- content: REQUIRED whenever action is "fs_create_file" - the FULL, complete, working text to write into that file (real code/config/text, not a placeholder or a description of what it should contain). Omit this field entirely for every other action.
- dependsOnStepIndex: 0-based index of another step in THIS list that must finish first, if any - omit if this step has no same-list prerequisite (it may still depend on something from an earlier task; that's handled separately)

Keep each step small enough that if it fails on its own, the failure is easy to localize - don't bundle unrelated actions into one step. A step whose action is "fs_create_file" is USELESS without real content - never emit one without it.

Respond with ONLY a JSON object, no markdown fences, no commentary:
{
  "steps": [
    { "reasoning": "...", "domain": "files", "description": "...", "action": "fs_create_file", "target": "path/to/file", "content": "...full file text...", "dependsOnStepIndex": null }
  ]
}`;

/**
 * Expands one task (with optional subtasks) into a flat list of raw step
 * objects, IN ORDER, via one or more model calls - one call per subtask
 * if subtasks exist (each subtask gets its own focused expansion, which
 * produces more reliable tool-call granularity than asking the model to
 * plan several subtasks worth of steps at once), or one call for the
 * task itself if it has no subtasks.
 *
 * @param {object} task - a task plan (from taskPlanner.js), or a plain { title, description } for a goal with no task layer at all
 * @returns {Promise<Array<{description, domain, action, target, localDependsOnIndex}>>}
 */
async function expandTaskToRawSteps(task) {
  const units = task.subtasks?.length ? task.subtasks.map((s) => ({ title: s, isSubtask: true })) : [{ title: task.title, description: task.description, isSubtask: false }];

  const allSteps = [];

  for (const unit of units) {
    const promptContent = unit.isSubtask
      ? `Parent task: ${task.title}\nSubtask: ${unit.title}`
      : `Task: ${unit.title}\n${unit.description || ''}`;

    const history = [
      { role: 'system', content: EXECUTION_SYSTEM_PROMPT },
      { role: 'user', content: promptContent },
    ];

    const modelResult = await llamaEngine.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
      maxTokens: 2000,
      temperature: 0.2,
    });

    const parsed = modelResult.success && modelResult.data?.content ? safeParseStepsJson(modelResult.data.content) : null;
    const rawSteps = Array.isArray(parsed?.steps) && parsed.steps.length ? parsed.steps : [fallbackStepForUnit(unit, task)];

    // Resolve each unit's internal dependsOnStepIndex (local to this
    // unit's own steps array) into an offset within allSteps, since
    // multiple units' steps are about to be concatenated.
    const offset = allSteps.length;
    rawSteps.forEach((s, localIndex) => {
      allSteps.push({
        description: s.description || unit.title,
        reasoning: s.reasoning || null,
        domain: normalizeDomain(s.domain),
        action: s.action || null,
        target: s.target || null,
        content: typeof s.content === 'string' ? s.content : null,
        subtaskTitle: unit.isSubtask ? unit.title : null,
        localDependsOnIndex: Number.isInteger(s.dependsOnStepIndex) ? offset + s.dependsOnStepIndex : null,
      });
    });
  }

  return allSteps;
}

function normalizeDomain(domain) {
  const valid = ['coding', 'terminal', 'files', 'browser', 'github'];
  return valid.includes(domain) ? domain : 'terminal';
}

function fallbackStepForUnit(unit, task) {
  return {
    domain: 'terminal',
    description: unit.title || task.title,
    action: null,
    target: null,
    dependsOnStepIndex: null,
  };
}

function safeParseStepsJson(rawContent) {
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

/**
 * Full execution planning pass for one task: expand to raw steps, wire
 * cross-task dependencies (if this task depends on other tasks, its
 * first step inherits that as an additional dependency once the caller
 * tells us which step id(s) those tasks' plans ended on - see
 * crossTaskDependencyStepIds), resolve intra-task order via
 * dependencyPlanner.js, and risk-classify every step via
 * riskClassifier.js (unchanged from Phase 1 - still the single source of
 * truth for "does this need approval").
 *
 * @param {object} task - task plan from taskPlanner.js
 * @param {string[]} crossTaskDependencyStepIds - real plan_steps ids (already persisted) this task's first step should also depend on, resolved by planCoordinator.js from taskPlanner.js's dependsOnTaskIds
 * @returns {Promise<{success: boolean, steps: Array<object>, error: object|null}>}
 *   Each step: { id, description, domain, action, target, dependsOnStepId, dependsOnStepIds, subtaskOfStepId, isRisky, riskReason } - NOT yet given a stepOrder; that's assigned once this task's steps are merged with sibling tasks' steps at the plan level (see planCoordinator.js)
 */
export async function planExecution(task, crossTaskDependencyStepIds = []) {
  const rawSteps = await expandTaskToRawSteps(task);

  if (rawSteps.length === 0) {
    return { success: true, steps: [], error: null };
  }

  // Assign real ids up front so local index-based dependencies can be
  // resolved into id-based ones before handing off to dependencyPlanner.js.
  const idBySteps = rawSteps.map(() => uuidv4());

  const dependencyNodes = rawSteps.map((step, index) => ({
    id: idBySteps[index],
    dependsOnIds: step.localDependsOnIndex !== null && step.localDependsOnIndex !== index
      ? [idBySteps[step.localDependsOnIndex]]
      : [],
  }));

  // The first node in the chain also inherits any cross-task
  // dependencies passed in - this is how "Task B depends on Task A"
  // (from taskPlanner.js) actually threads through to real step ids at
  // the execution level, without every step in Task B needing to know
  // about Task A explicitly.
  if (crossTaskDependencyStepIds.length && dependencyNodes.length) {
    dependencyNodes[0].dependsOnIds = [...dependencyNodes[0].dependsOnIds, ...crossTaskDependencyStepIds];
  }

  const depResult = planDependencies(dependencyNodes);
  if (!depResult.success) {
    return { success: false, steps: [], error: { type: 'DEPENDENCY_RESOLUTION_FAILED', message: depResult.error } };
  }

  const steps = rawSteps.map((step, index) => {
    const id = idBySteps[index];
    const assignment = depResult.assignments.get(id) || { directDependsOnId: null, allDependsOnIds: [] };
    const risk = classifyStep({ domain: step.domain, action: step.action, target: step.target, details: {} });

    return {
      id,
      description: step.description,
      reasoning: step.reasoning,
      domain: step.domain,
      action: step.action,
      target: step.target,
      subtaskTitle: step.subtaskTitle,
      dependsOnStepId: assignment.directDependsOnId,
      dependsOnStepIds: assignment.allDependsOnIds,
      isRisky: risk.risky,
      riskReason: risk.reason,
    };
  });

  // Reorder the final array to match the resolved topological order
  // rather than the model's original (pre-dependency-fix) order, so
  // step_order assigned later by planCoordinator.js already respects
  // every dependency.
  const stepsById = new Map(steps.map((s) => [s.id, s]));
  const orderedSteps = depResult.orderedIds.map((id) => stepsById.get(id)).filter(Boolean);

  return { success: true, steps: orderedSteps, error: null };
}
