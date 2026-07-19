/**
 * ZAO - Self-Reflection / Self-Critique
 *
 * A second pass over another strategy's draft answer: the model
 * reviews its own prior output against the original request, flags
 * anything wrong/incomplete/unclear, and revises if it found something
 * worth fixing. This is layered ON TOP of chain-of-thought,
 * tree-of-thought, or an inference-mode answer - it's not a standalone
 * strategy reasoningRouter.js routes to directly.
 *
 * Gated automatically by reasoningEngine.js's shouldAutoReflect() - not
 * a person-facing setting. It's a full extra model round trip, so it
 * only runs when the reply itself gives a reason to double-check it:
 * a correctness-sensitive strategy (deductive, abductive), content that
 * looks like code or a calculation, or the person explicitly asking to
 * verify/double-check something. Tree-of-thought's own evaluator step
 * already gives it a built-in critique pass, so reasoningEngine.js
 * never layers this on top of ToT specifically, to avoid two critique
 * passes back to back.
 */

import * as backendClient from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';

const CRITIQUE_SYSTEM_PROMPT = `You are reviewing a draft answer to a request, checking for real problems - factual errors, missed constraints from the request, logical gaps, or incompleteness. Don't invent nitpicks; a correct, complete, reasonably clear answer should pass. Respond with ONLY one JSON object, no markdown fences, no commentary:
{"verdict": "pass" | "revise", "issues": ["specific issue, if any - empty array if verdict is pass"]}`;

const REVISE_SYSTEM_PROMPT = `Revise the draft answer to fix the specific issues listed, while keeping everything that was already correct and good. Respond with ONLY the revised, person-facing answer - no preamble, no "here's the revised answer", no markdown fences, no explanation of what changed.`;

/**
 * @param {string} messageText - the original request
 * @param {string} draftAnswer - the answer produced by whichever strategy ran first
 * @returns {Promise<{success: boolean, content: string, trace: object|null, error: object|null}>}
 */
export async function runSelfReflection(messageText, draftAnswer) {
  if (!draftAnswer || !draftAnswer.trim()) {
    return { success: true, content: draftAnswer, trace: null, error: null };
  }

  const critiqueHistory = [
    { role: 'system', content: CRITIQUE_SYSTEM_PROMPT },
    { role: 'user', content: `Original request: ${messageText}\n\nDraft answer: ${draftAnswer}` },
  ];

  const critiqueResult = await backendClient.sendMessage(critiqueHistory, MODEL_KEYS.QWEN25_CODER_3B, {
    maxTokens: 400,
    temperature: 0.2,
  });

  if (!critiqueResult.success) {
    // A failed critique call shouldn't cost the person the draft answer
    // they already have - surface it unchanged.
    return { success: true, content: draftAnswer, trace: null, error: null };
  }

  const parsed = safeParseJson(critiqueResult.data?.content);
  const verdict = parsed?.verdict === 'revise' ? 'revise' : 'pass';
  const issues = Array.isArray(parsed?.issues) ? parsed.issues.filter(Boolean) : [];

  if (verdict === 'pass' || issues.length === 0) {
    return { success: true, content: draftAnswer, trace: { verdict: 'pass', issues: [], revised: false }, error: null };
  }

  const reviseHistory = [
    { role: 'system', content: REVISE_SYSTEM_PROMPT },
    { role: 'user', content: `Original request: ${messageText}\n\nDraft answer: ${draftAnswer}\n\nIssues to fix: ${issues.join(' | ')}` },
  ];

  const reviseResult = await backendClient.sendMessage(reviseHistory, MODEL_KEYS.QWEN25_CODER_3B, {
    maxTokens: 1024,
    temperature: 0.5,
  });

  if (!reviseResult.success || !reviseResult.data?.content?.trim()) {
    return { success: true, content: draftAnswer, trace: { verdict: 'revise', issues, revised: false, note: 'Revision call failed; kept the draft.' }, error: null };
  }

  return {
    success: true,
    content: reviseResult.data.content.trim(),
    trace: { verdict: 'revise', issues, revised: true },
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
