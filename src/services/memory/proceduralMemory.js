/**
 * ZAO - Procedural Memory ("how to do X" recipes)
 *
 * The taxonomy notes procedural memory "isn't really separable in an
 * LLM; it's folded into parametric memory" - true for the model's raw
 * ability to write code or plan in general. But ZAO's hierarchical
 * planner (src/services/planning/) produces something a base model
 * doesn't have on its own: a concrete, ordered, tool-level sequence
 * that worked for THIS person's THIS setup (their repo layout, their
 * folder conventions, their GitHub flow) - and that's worth persisting
 * outside the model's weights, the same way a person jots down "here's
 * the exact steps that worked last time" instead of re-deriving them.
 *
 * This module is intentionally lightweight: it does NOT try to be a
 * general skill-learning system. It stores the step list from one
 * successful run, keyed by a keyword fingerprint of the goal, and
 * offers a cheap token-overlap lookup so a future similar goal can be
 * planned with "here's what worked last time" as a hint rather than
 * starting from zero. Two independent producers/consumers share this
 * one bank: src/services/brain/backendBrain.js (hierarchical planner -
 * reads via withProceduralHint, src/services/planning/planExecutor.js
 * writes via recordProcedure on a completed plan) and
 * src/services/toolOrchestrator.js's flat ReAct loop (runToolTask -
 * reads via withProceduralHintReported and writes via recordProcedure
 * itself once a task finishes, since there's no separate executor
 * module for that path). A procedure recorded by one path can be
 * matched and reused by the other - the bank doesn't care which loop
 * produced it, only whether the new goal resembles it.
 */

import { v4 as uuidv4 } from 'uuid';
import { addProcedure, getAllProcedures, bumpProcedureUsage } from '../../db/database';

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for', 'with', 'and',
  'or', 'my', 'me', 'i', 'please', 'this', 'that', 'it', 'be', 'do', 'make', 'create', 'want',
]);

function tokenize(text) {
  return new Set(
    (text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

/** Builds the keyword-fingerprint string stored as task_signature - just a stable, sorted join of the goal's significant tokens, used only for a quick display/debug label, not the actual matching (matching uses overlap scoring below, not exact signature equality). */
function buildSignature(goalText) {
  return Array.from(tokenize(goalText)).sort().join(' ');
}

/**
 * Distills a completed run's steps down to {domain, description} pairs
 * (dropping raw tool output/results - a procedure records the APPROACH,
 * not the specific data any one run happened to produce) and stores it.
 * Fire-and-forget: never throws, never delays the caller's own response
 * to the person. Two call sites: planExecutor.js, right after a
 * hierarchical plan finishes with status COMPLETED; and
 * toolOrchestrator.js's runToolTask, right after the flat ReAct loop
 * finishes with a final answer and at least one successful tool call -
 * source_plan_id is simply null for the latter, since a flat-loop run
 * has no plan row to point back to.
 *
 * @param {string} goalText
 * @param {Array<{domain, description}>} steps
 * @param {string|null} sourcePlanId
 */
export async function recordProcedure(goalText, steps, sourcePlanId) {
  try {
    if (!goalText || !Array.isArray(steps) || steps.length === 0) return;

    const distilledSteps = steps
      .filter((s) => s && s.description)
      .map((s) => ({ domain: s.domain || 'general', description: s.description }));
    if (distilledSteps.length === 0) return;

    // If a near-identical procedure already exists, reinforce it
    // (bump use_count) instead of storing a near-duplicate row - this
    // keeps the bank from filling up with 10 slightly-worded variants
    // of "create a GitHub repo and push a folder to it".
    const existing = await findSimilarProcedure(goalText, { minOverlapRatio: 0.7 });
    if (existing) {
      await bumpProcedureUsage(existing.id);
      return;
    }

    await addProcedure({
      id: uuidv4(),
      taskSignature: buildSignature(goalText),
      goalSummary: goalText.slice(0, 300),
      steps: distilledSteps,
      sourcePlanId,
    });
  } catch (err) {
    console.error('[ProceduralMemory] recordProcedure failed:', err);
  }
}

/**
 * Finds the best-matching stored procedure for a new goal, by token
 * overlap (same cheap, on-device, no-embedding heuristic used
 * elsewhere in this project - see memoryEngine.js's
 * findLikelySupersededMemory). Returns null if nothing clears the
 * overlap bar - a weak/coincidental match is worse than no hint at all,
 * since it could steer the planner toward an irrelevant approach.
 *
 * @param {string} goalText
 * @param {{ minOverlapRatio?: number }} options
 * @returns {Promise<{ id, goal_summary, steps: Array } | null>}
 */
export async function findSimilarProcedure(goalText, { minOverlapRatio = 0.45 } = {}) {
  try {
    const queryTokens = tokenize(goalText);
    if (queryTokens.size === 0) return null;

    const result = await getAllProcedures();
    if (!result.success || result.data.length === 0) return null;

    let best = null;
    let bestRatio = 0;
    for (const proc of result.data) {
      const procTokens = tokenize(proc.goal_summary);
      let overlap = 0;
      for (const t of queryTokens) if (procTokens.has(t)) overlap += 1;
      const ratio = overlap / Math.min(queryTokens.size, procTokens.size || 1);
      if (ratio > bestRatio) {
        bestRatio = ratio;
        best = proc;
      }
    }

    if (!best || bestRatio < minOverlapRatio) return null;

    let steps = [];
    try { steps = JSON.parse(best.steps_json) || []; } catch { steps = []; }

    return { id: best.id, goal_summary: best.goal_summary, steps };
  } catch (err) {
    console.error('[ProceduralMemory] findSimilarProcedure failed:', err);
    return null;
  }
}

/**
 * Core lookup + hint-text builder shared by withProceduralHint (below)
 * and withProceduralHintReported. Bumps the matched procedure's
 * use_count when a hint is actually handed back to a caller - distinct
 * from recordProcedure's own internal dedup bump above, which only
 * fires when a NEW run happens to resemble an existing procedure
 * closely enough to be treated as a duplicate. Before this, use_count
 * only ever reflected "recorded again," never "actually reused as a
 * hint" - callers could ask for a hint 50 times and the count would
 * never move unless a full duplicate run also got recorded. Harmless
 * either way (use_count is only read for recency/frequency ranking,
 * nothing keys off an exact value), but now it reflects real usage.
 */
async function buildProceduralHint(goalText) {
  const match = await findSimilarProcedure(goalText);
  if (!match) return { text: goalText, applied: false, match: null };

  await bumpProcedureUsage(match.id).catch(() => {});

  const stepList = match.steps
    .slice(0, 8)
    .map((s, i) => `${i + 1}. [${s.domain}] ${s.description}`)
    .join('\n');
  const text = `${goalText}\n\n(For reference: a similar past task - "${match.goal_summary}" - was completed successfully using this approach. Reuse it if it genuinely fits this new goal; adapt or ignore it if it doesn't:\n${stepList})`;
  return { text, applied: true, match };
}

/**
 * Convenience for backendBrain.js: given a new goal, returns that goal
 * text UNCHANGED if no relevant procedure is found, or the goal text
 * with a short "here's what worked before" hint appended if one is -
 * this is intentionally folded straight into the goal string (rather
 * than threaded as a new parameter through
 * planCoordinator/strategicPlanner/etc.) so procedural memory plugs in
 * at exactly one call site without touching the planning pipeline's
 * internals.
 */
export async function withProceduralHint(goalText) {
  const { text } = await buildProceduralHint(goalText);
  return text;
}

/**
 * Same lookup as withProceduralHint, but also reports back WHETHER a
 * match was applied and a short summary of what it matched, instead of
 * silently folding it into the string. For toolOrchestrator.js's flat
 * ReAct loop (runToolTask) - previously that loop never called into
 * procedural memory at all, so it never checked "have I solved
 * something like this before" the way the hierarchical planner already
 * did via withProceduralHint. This variant lets that call site also
 * surface the reuse in its own live "✓ ..." checklist (onStep) rather
 * than the hint being invisible to the person.
 */
export async function withProceduralHintReported(goalText) {
  const { text, applied, match } = await buildProceduralHint(goalText);
  return { text, applied, matchSummary: match?.goal_summary || null };
}
