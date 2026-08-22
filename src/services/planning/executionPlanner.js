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
- domain: one of "coding", "terminal", "files", "browser", "github", "time", "search", "test"
- description: plain-language description of what this step does (shown to the person as the narration line - distinct from reasoning, which is shown separately as the step's collapsed "thought process")
- action: the specific action/tool-call name this step maps to - your best guess at the real tool, the executor will resolve the exact function. Common ones: "fs_create_file", "github_commit_files", "terminal_pc_run_command", "pc_fs_create_folder", "time_get_current" (the real current date/time - see below), "web_search" (a live web query), "web_fetch" (retrieve one specific URL's content), "pc_run_tests" (runs the project's real test suite - see below)
- target: the file path / repo / URL / command this step acts on. For "time_get_current", put a timezone name or city here if one was asked for (e.g. "Asia/Tokyo", "Lagos"), or omit for local/device time. For "web_search", put the search query here. For "pc_log_decision", put the one-line decision summary here (e.g. "Used SQLite instead of a flat JSON file for the cache layer").
- content: REQUIRED whenever action is "fs_create_file" - the FULL, complete, working text to write into that file (real code/config/text, not a placeholder or a description of what it should contain). For "pc_log_decision", put the WHY - the actual reasoning behind the decision named in target - here instead (this step reuses fs_create_file's target=path/content=text shape as target=decision/content=reasoning, rather than needing its own separate fields). Omit this field entirely for every other action.
- dependsOnStepIndex: 0-based index of another step in THIS list that must finish first, if any - omit if this step has no same-list prerequisite (it may still depend on something from an earlier task; that's handled separately)

CRITICAL - never answer these from memory/guessing, always plan a real tool step instead: any question about the actual current date, current time (in any timezone), or "what day is it" -> a "time_get_current" step (domain "time"). Training data goes stale the moment it's trained, so a model has no way to actually know today's date without checking - guessing a plausible-looking date is exactly the failure this step exists to prevent. Any question needing current/live information the model's training can't have (weather, news, prices, current events, "is X still true") -> a "web_search" step (domain "search"). Reading one specific known URL's content -> "web_fetch".

TESTING: whenever a task involves writing or changing real source code in a project that has (or should have) tests - not a one-off script, not a plain text/config file - plan a "pc_run_tests" step (domain "test") as the LAST step, after the file-writing steps, depending on them via dependsOnStepIndex. This turns "write code" into "write code, then verify it actually works" instead of stopping the moment files are written. Skip this for: a brand new project with no tests yet to run (there's nothing to check), a single config/content-only edit with no logic change, or a task that was never about code (a folder, a PDF, a spreadsheet).

RECORDING WHY: if this task involves a real design/implementation choice (one library/approach over another, a non-obvious structure for a real reason), add a "pc_log_decision" step (domain "files", since it's a file write under the hood) after the relevant coding steps, so that reasoning survives in the project's own DECISIONS.md rather than being lost once this plan finishes. Skip it for routine, self-explanatory work.

RISKY MULTI-FILE CHANGES: pc_fs_preview_changes takes a "changes" array as its argument, which this step schema has no field for (target/content are both single strings, not a list of {path, type, oldString, newString} objects) - so it can't be planned as a step here the way pc_run_tests or pc_log_decision can. It still exists and works correctly when called directly (see toolOrchestrator.js's own system prompt, which has full native support for array-shaped tool arguments) - if a task in THIS pipeline involves several files changing together for the same reason, the safer option available at this level is simply ordering the edit steps so a person can review each one's diff as it's produced (pc_fs_edit_file's response already includes a real diff - see that tool), rather than planning a preview step that can't actually be filled in correctly here.

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

    const modelResult = await llamaEngine.sendMessage(history, MODEL_KEYS.QWEN3_CODER_30B_A3B, {
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
        plannerFailed: !!s.plannerFailed,
      });
    });
  }

  return allSteps;
}

export function normalizeDomain(domain) {
  const valid = ['coding', 'terminal', 'files', 'browser', 'github', 'time', 'search', 'test'];
  return valid.includes(domain) ? domain : 'terminal';
}

/**
 * Last-resort fallback for when the model call for this unit failed
 * outright OR its response couldn't be parsed as JSON even after
 * safeParseStepsJson's balanced-object extraction - genuinely rare now
 * that extraction handles commentary-wrapped JSON, but still possible
 * (backend unreachable, a truncated/cut-off response, malformed JSON
 * that never balances).
 *
 * Deliberately an HONEST failing step, not a plausible-looking one - a
 * PREVIOUS version of this returned {action: null, target: null}, which
 * silently became a terminal_pc_run_command call with no actual command
 * once normalizeActionGuess() filled the domain default in - it ran
 * (or errored) with nothing real to do, while the model still generated
 * a plausible "done" summary afterward with no indication anything had
 * gone wrong. That's the exact "claims it's done but it isn't" /
 * "explains how instead of doing it" failure this was traced back to.
 * Setting noRetry+forceFailed here instead means planExecutor.js sees a
 * REAL failure and either retries the whole unit through
 * recoveryPlanner.js or surfaces it to the person - never silently
 * proceeds as if something happened.
 */
export function fallbackStepForUnit(unit, task) {
  return {
    domain: 'terminal',
    description: unit.title || task.title,
    action: null,
    target: null,
    dependsOnStepIndex: null,
    plannerFailed: true, // planExecutor.js checks this and fails the step honestly rather than attempting a hollow tool call
  };
}

export function safeParseStepsJson(rawContent) {
  const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    // A 3B model reliably wraps the JSON in commentary despite being
    // told not to ("Here's the plan: {...}", or trailing explanation
    // after it) - failing the whole parse here is exactly what produces
    // fallbackStepForUnit()'s null-action, null-target placeholder step,
    // which silently does nothing useful while the model still writes a
    // plausible-sounding "done" summary afterward - the "claims it's
    // done but it isn't" / "gives me instructions instead of doing it"
    // failure this was traced back to. Extract the largest {...} block
    // in the response and retry before giving up. Steps arrays can be
    // long, so this needs to find a balanced-brace object, not just the
    // first '{...}' (a naive single-level match truncates at the first
    // nested step's closing brace).
    const extracted = extractBalancedJsonObject(cleaned);
    if (!extracted) return null;
    try {
      const parsed = JSON.parse(extracted);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (innerErr) {
      return null;
    }
  }
}

/**
 * Finds the first balanced {...} block in a string - unlike a simple
 * /\{[^{}]*\}/ regex (fine for a flat, single-level object like
 * chatGroundingBackstop.js's classifier response), this needs to handle
 * a NESTED object - {"steps": [{...}, {...}]} - where naive non-nesting
 * regex would truncate at the first inner step's closing brace instead
 * of capturing the whole thing.
 */
export function extractBalancedJsonObject(text) {
  const start = text.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === '{') depth++;
    else if (text[i] === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null; // never balanced - truncated/malformed response
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
