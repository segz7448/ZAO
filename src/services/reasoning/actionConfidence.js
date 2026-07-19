/**
 * ZAO - Pre-Action Confidence Signal
 *
 * selfReflection.js's critique pass looks BACKWARD: it reviews an answer
 * already drafted. This module looks FORWARD: it runs immediately before
 * a tool call that is about to execute with no human in the loop, and
 * asks the model to rate its own confidence that the action is what the
 * person actually wants, correctly scoped, and safe to run unattended.
 *
 * "No human in the loop" is the specific trigger, not "any write tool" -
 * see toolOrchestrator.js's call site. In 'default' mode every WRITE_TOOL
 * already pauses for a person to approve, so a pre-action confidence
 * check there would just be noise in front of a confirmation card the
 * person is about to see anyway. This only fires for the modes where
 * permissionModes.js lets an action auto-run WITHOUT that pause
 * ('acceptEdits' for edits, 'auto'/'bypassPermissions' for everything) -
 * exactly the situations where the person has traded away the "ask
 * first" safety net and a confidence signal is the only thing standing
 * between them and finding out about a bad call after it already ran.
 *
 * Same architecture as selfReflection.js on purpose (small model, one
 * structured JSON call, fail open rather than block on a broken parse) -
 * this is a sibling pass, not a different subsystem.
 */

import * as backendClient from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';

const CONFIDENCE_SYSTEM_PROMPT = `An autonomous agent is about to run an action with NO human confirmation step - the permission mode in effect lets it proceed without asking first. Rate your confidence that this specific action is what the person actually wants, correctly scoped to their request, and safe to run unattended.
Respond with ONLY one JSON object, no markdown fences, no commentary:
{"confidence": "high" | "medium" | "low", "concern": "one short sentence on what's uncertain - empty string if high"}
Use "low" when the action could plausibly do something other than what the person intended: a guessed file/path/name/value the request never actually specified, an ambiguous target when more than one thing could be meant, or a destructive/hard-to-undo effect. Use "medium" for a reasonable but non-obvious inference the person would probably want a chance to sanity-check. Use "high" only for a direct, unambiguous, low-consequence execution of what was explicitly asked.`;

/**
 * @param {object} action
 * @param {string} action.userRequest - the original request that led to this tool call
 * @param {string} action.label - the human-readable description of the action (toolDef.label(args))
 * @param {string} action.toolName
 * @param {object} action.args
 * @returns {Promise<{confidence: 'high'|'medium'|'low', concern: string}>}
 */
export async function assessActionConfidence({ userRequest, label, toolName, args }) {
  const history = [
    { role: 'system', content: CONFIDENCE_SYSTEM_PROMPT },
    {
      role: 'user',
      content: `Original request: ${userRequest}\n\nAbout to run, unattended: ${label} (tool: ${toolName}, args: ${JSON.stringify(args)})`,
    },
  ];

  const result = await backendClient.sendMessage(history, MODEL_KEYS.QWEN25_CODER_3B, {
    maxTokens: 150,
    temperature: 0.1,
  });

  if (!result.success) {
    // A broken confidence check shouldn't silently vanish - fail to
    // 'medium' (visible, non-blocking) rather than 'high' (silent) or
    // 'low' (blocks a person's already-permitted auto mode over a
    // network hiccup that has nothing to do with the action itself).
    return { confidence: 'medium', concern: 'Could not run a confidence check before this action; proceeding without one.' };
  }

  const parsed = safeParseJson(result.data?.content);
  const confidence = ['high', 'medium', 'low'].includes(parsed?.confidence) ? parsed.confidence : 'medium';
  const concern = typeof parsed?.concern === 'string' ? parsed.concern.trim() : '';
  return { confidence, concern };
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
