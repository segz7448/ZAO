/**
 * ZAO - Tree of Thought (ToT) / branching search
 *
 * Generates several genuinely different candidate approaches to a
 * request, has the model critique them against each other, and either
 * commits to the strongest one or - if every candidate is judged
 * weak - backtracks and regenerates once with that feedback folded in.
 *
 * Kept to two model calls in the common case (generate, then
 * critique+select) and three in the backtrack case, rather than one
 * call per branch - a literal N-branch ToT would be N+ round trips
 * against a single local 3B model over LAN/tunnel, which is too slow
 * for a chat reply. This is the same trade planning/executionPlanner.js
 * makes: real branching structure, without pretending phone-plus-PC
 * latency doesn't exist.
 *
 * Used for requests where more than one reasonable approach exists and
 * picking badly on the first line of reasoning would matter - see
 * reasoningRouter.js for the routing signal.
 */

import * as backendClient from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import { withSystemPrompt } from './chainOfThought';

const BRANCH_COUNT = 3;

const GENERATE_SYSTEM_PROMPT = `Propose ${BRANCH_COUNT} genuinely different ways to approach this request - different strategies, not minor rewordings of the same idea. Respond with ONLY one JSON object, no markdown fences, no commentary:
{"branches": [{"approach": "short name for this approach", "reasoning": "the actual reasoning/steps for this approach, concrete enough to judge", "answer": "the final answer this approach leads to"}]}
Each branch's "answer" must be a complete, standalone, person-facing answer to the original request - not a summary of the approach.`;

const EVALUATE_SYSTEM_PROMPT = `You are given several candidate approaches to the same request, each with its own reasoning and answer. Critique them against each other and pick the strongest one. Respond with ONLY one JSON object, no markdown fences, no commentary:
{"critiques": ["one line per branch on its strength/weakness, same order as given"], "bestIndex": 0, "allWeak": false, "whyBest": "one or two sentences on why this branch won"}
Set "allWeak": true only if every branch has a real, specific flaw (factually wrong, misses a stated constraint, incomplete) - not merely "could be more detailed."`;

/**
 * @param {Array<{role, content}>} history
 * @param {string} messageText - the raw request, used to re-anchor the evaluator call
 * @returns {Promise<{success: boolean, content: string, trace: object|null, error: object|null}>}
 */
export async function runTreeOfThought(history, messageText) {
  const branchResult = await generateBranches(history);
  if (!branchResult.success) {
    return { success: false, content: '', trace: null, error: branchResult.error };
  }

  let branches = branchResult.branches;
  if (branches.length === 0) {
    return { success: false, content: '', trace: null, error: { type: 'UNKNOWN', message: 'No reasoning branches were generated.' } };
  }

  let evalResult = await evaluateBranches(messageText, branches);
  let backtracked = false;

  if (evalResult.success && evalResult.allWeak) {
    // One backtrack: regenerate branches with the critique folded in as
    // a hint, then evaluate again. If this second pass also fails or is
    // still weak, proceed with its best answer anyway rather than
    // looping indefinitely - the person still gets an answer.
    backtracked = true;
    const critiqueHint = `Previous attempt's approaches were judged weak for these reasons: ${evalResult.critiques.join(' | ')}. Avoid the same issues this time.`;
    const retryHistory = withSystemPrompt(history, critiqueHint);
    const retryBranches = await generateBranches(retryHistory);
    if (retryBranches.success && retryBranches.branches.length > 0) {
      branches = retryBranches.branches;
      evalResult = await evaluateBranches(messageText, branches);
    }
  }

  if (!evalResult.success) {
    // Evaluation failed outright - fall back to the first branch rather
    // than losing the whole turn.
    const fallback = branches[0];
    return {
      success: true,
      content: fallback.answer,
      trace: { branches, critiques: null, chosenIndex: 0, backtracked, note: 'Evaluator call failed; used the first branch.' },
      error: null,
    };
  }

  const chosenIndex = Number.isInteger(evalResult.bestIndex) && branches[evalResult.bestIndex]
    ? evalResult.bestIndex
    : 0;
  const chosen = branches[chosenIndex];

  return {
    success: true,
    content: chosen.answer,
    trace: {
      branches,
      critiques: evalResult.critiques,
      chosenIndex,
      whyBest: evalResult.whyBest,
      backtracked,
    },
    error: null,
  };
}

async function generateBranches(history) {
  const augmented = withSystemPrompt(history, GENERATE_SYSTEM_PROMPT);
  const result = await backendClient.sendMessage(augmented, MODEL_KEYS.QWEN25_CODER_3B, {
    maxTokens: 1400,
    temperature: 0.9, // higher than CoT's 0.7 - branches need to actually differ from each other
  });

  if (!result.success) return { success: false, branches: [], error: result.error };

  const parsed = safeParseJson(result.data?.content);
  const branches = Array.isArray(parsed?.branches)
    ? parsed.branches.filter((b) => b && typeof b.answer === 'string' && b.answer.trim()).slice(0, BRANCH_COUNT)
    : [];

  return { success: branches.length > 0, branches, error: branches.length === 0 ? { type: 'UNKNOWN', message: 'Could not parse reasoning branches.' } : null };
}

async function evaluateBranches(messageText, branches) {
  const branchSummaries = branches
    .map((b, i) => `Branch ${i} ("${b.approach}"):\nReasoning: ${b.reasoning}\nAnswer: ${b.answer}`)
    .join('\n\n');

  const evalHistory = [
    { role: 'system', content: EVALUATE_SYSTEM_PROMPT },
    { role: 'user', content: `Original request: ${messageText}\n\n${branchSummaries}` },
  ];

  const result = await backendClient.sendMessage(evalHistory, MODEL_KEYS.QWEN25_CODER_3B, {
    maxTokens: 500,
    temperature: 0.2, // evaluation should be consistent, not creative
  });

  if (!result.success) return { success: false, error: result.error };

  const parsed = safeParseJson(result.data?.content);
  if (!parsed) return { success: false, error: { type: 'UNKNOWN', message: 'Could not parse branch evaluation.' } };

  return {
    success: true,
    critiques: Array.isArray(parsed.critiques) ? parsed.critiques : [],
    bestIndex: parsed.bestIndex,
    allWeak: !!parsed.allWeak,
    whyBest: parsed.whyBest || '',
    error: null,
  };
}

function safeParseJson(rawContent) {
  if (!rawContent) return null;
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    return JSON.parse(cleaned);
  } catch (err) {
    return null;
  }
}
