/**
 * ZAO - Feedback Memory ("avoid this pattern" loop)
 *
 * The thumbs-up/thumbs-down buttons under an assistant reply
 * (MessageActions.js -> ChatScreen.js -> chatStore.js's setFeedback())
 * persisted a like/dislike onto the message row (messages.feedback in
 * src/db/database.js) and stopped there. Nothing ever read that column
 * back - a dislike changed the icon color and nothing else. Tapping
 * dislike ten times on ten different replies for the same underlying
 * reason (too verbose, made up a fact, over-apologized, whatever) had
 * zero effect on message eleven.
 *
 * This module closes that loop, the same shape as proceduralMemory.js
 * closes the "successful plan -> reusable recipe" loop:
 *
 *   1. recordDislikeFeedback() - fire-and-forget, called right after a
 *      message is marked disliked. Distills the disliked exchange down
 *      to one short, general "avoid ..." instruction (a local model
 *      call, same pattern as memoryEngine.js's extractMemoriesFromTurn)
 *      and stores it in the feedback_patterns table. If a very similar
 *      instruction is already stored, the existing row is reinforced
 *      (occurrence_count += 1) instead of duplicated - this is the
 *      AGGREGATION step: five separate "too verbose" dislikes become one
 *      pattern with occurrence_count 5, not five identical rows nobody
 *      ranks.
 *   2. getFeedbackGuidanceMessage() - reads the highest-signal patterns
 *      (ranked by occurrence_count, then recency) and returns them as a
 *      system message, the same shape memoryEngine.js's
 *      getMemorySystemMessage() returns. chatStore.js's assembleHistory()
 *      injects it into every new prompt, right alongside the semantic
 *      memory block.
 *
 * Likes are intentionally NOT distilled into a mirror-image "reinforce"
 * pattern here. A dislike is evidence something concrete went wrong and
 * generalizes to an instruction ("avoid X"); a like just means a reply
 * was fine, which doesn't generalize into a useful instruction the same
 * way - "keep doing whatever you were already doing" is not an
 * actionable prompt addition, and manufacturing one would mostly add
 * prompt-bloat with no signal. Raw like/dislike counts are still
 * queryable via getFeedbackStats() in database.js for a future Settings
 * display.
 */

import { v4 as uuidv4 } from 'uuid';
import * as llamaEngine from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import {
  getAllFeedbackPatterns,
  addFeedbackPattern,
  bumpFeedbackPattern,
  deleteFeedbackPattern,
} from '../../db/database';

// Same model used for semantic-memory extraction (memoryEngine.js) - a
// local, no-per-call-cost model, so there's no reason to reserve a
// separate one just for this.
const DISTILL_MODEL_KEY = MODEL_KEYS.QWEN25_CODER_3B;

// Hard ceiling on distinct stored patterns, mirroring
// memoryEngine.js's MAX_ACTIVE_MEMORIES - keeps the injected guidance
// block bounded rather than growing unboundedly over months of use.
const MAX_FEEDBACK_PATTERNS = 100;

// How many of the top-ranked patterns actually get injected into a
// prompt. Kept small and deliberately lower than MAX_FEEDBACK_PATTERNS -
// this is meant to be a short, high-signal "watch out for these" list,
// not a full dump of every dislike ever recorded.
const MAX_PATTERNS_IN_PROMPT = 8;

// Below this, a matched pattern is treated as coincidental overlap
// rather than "the same complaint again" - same overlap-ratio heuristic
// used by memoryEngine.js's findLikelySupersededMemory and
// proceduralMemory.js's findSimilarProcedure.
const DEDUP_OVERLAP_RATIO = 0.55;

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'to', 'of', 'in', 'on', 'for', 'with', 'and',
  'or', 'my', 'me', 'i', 'it', 'be', 'do', 'does', 'not', 'this', 'that', 'avoid', 'response',
  'reply', 'answer', 'assistant', 'zao',
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

function buildSignature(description) {
  return Array.from(tokenize(description)).sort().join(' ');
}

/**
 * Finds the best-matching already-stored pattern for a newly-distilled
 * description, by token overlap. Returns null if nothing clears the
 * dedup bar - better to store a slightly-redundant new pattern than to
 * silently merge two genuinely different complaints into one.
 */
function findSimilarPattern(existingPatterns, description) {
  const newTokens = tokenize(description);
  if (newTokens.size === 0) return null;

  let best = null;
  let bestRatio = 0;
  for (const pattern of existingPatterns) {
    const existingTokens = tokenize(pattern.description);
    let overlap = 0;
    for (const t of newTokens) if (existingTokens.has(t)) overlap += 1;
    const ratio = overlap / Math.min(newTokens.size, existingTokens.size || 1);
    if (ratio > bestRatio) {
      bestRatio = ratio;
      best = pattern;
    }
  }
  return bestRatio >= DEDUP_OVERLAP_RATIO ? best : null;
}

function safeParseDescription(text) {
  if (!text) return null;
  // The distillation prompt asks for one plain line, but models
  // sometimes wrap it in quotes/fences/a leading "Avoid:" anyway -
  // strip that defensively rather than storing noisy junk.
  let cleaned = text
    .replace(/```/g, '')
    .trim()
    .replace(/^["'\-*\s]+|["'\-*\s]+$/g, '')
    .replace(/^avoid\s*:?\s*/i, '')
    .trim();
  if (!cleaned || cleaned.length < 8 || cleaned.length > 200) return null;
  // A model that couldn't find anything general to say sometimes
  // answers with something like "none" / "n/a" - treat that as no
  // extraction rather than storing it as a pattern.
  if (/^(none|n\/a|nothing|no pattern)\.?$/i.test(cleaned)) return null;
  return cleaned;
}

/**
 * Runs the oldest/weakest-first prune pass if the stored pattern count
 * is over MAX_FEEDBACK_PATTERNS. "Weakest" here means lowest
 * occurrence_count then oldest last_seen_at, so a pattern that's
 * genuinely recurring survives a cap-driven prune even if it's not the
 * most recent one.
 */
async function enforcePatternCap() {
  const result = await getAllFeedbackPatterns();
  if (!result.success || result.data.length <= MAX_FEEDBACK_PATTERNS) return;

  // getAllFeedbackPatterns() already orders by occurrence_count DESC,
  // last_seen_at DESC, so the weakest entries are at the end - the same
  // "slice off the tail" approach memoryEngine.js's enforceMemoryCap()
  // uses for updated_at-ordered memories.
  const overflowCount = result.data.length - MAX_FEEDBACK_PATTERNS;
  const toRemove = result.data.slice(-overflowCount);
  for (const pattern of toRemove) {
    await deleteFeedbackPattern(pattern.id);
  }
}

/**
 * Fire-and-forget: called by chatStore.js's setFeedback() right after a
 * message is marked 'dislike'. Distills the exchange into one general
 * "avoid ..." instruction and stores/reinforces it. Never throws to the
 * caller - a failed or slow distillation call should never make tapping
 * the dislike button feel broken or slow.
 *
 * @param {string} userText - the user's message that led to the disliked reply
 * @param {string} assistantText - the disliked assistant reply itself
 * @param {string} messageId - id of the disliked message, for provenance
 */
export async function recordDislikeFeedback(userText, assistantText, messageId) {
  try {
    if (!assistantText || !assistantText.trim()) return { success: true, recorded: false };

    const distillPrompt = `A person just gave a thumbs-down to an AI assistant's reply below. Your job is to write ONE short, general instruction (under 15 words) describing what the assistant should avoid doing, so it doesn't repeat this mistake in future, unrelated conversations.

Rules:
- Be GENERAL, not specific to this one topic - e.g. "avoid overly long responses when a short answer would do" not "avoid explaining photosynthesis in detail".
- Focus on the STYLE, STRUCTURE, TONE, or BEHAVIOR of the reply - not its subject matter.
- If nothing general can be said (the dislike could be about a fact being wrong, which isn't a repeatable pattern), respond with exactly: none

User said:
${(userText || '').slice(0, 800)}

Assistant replied:
${assistantText.slice(0, 1200)}

Respond with ONLY the instruction (no quotes, no preamble, no "Avoid:" prefix needed but fine either way), or exactly "none".`;

    const result = await llamaEngine.sendMessage(
      [{ role: 'user', content: distillPrompt }],
      DISTILL_MODEL_KEY,
      { maxTokens: 60, temperature: 0.2 }
    );

    if (!result.success || !result.data?.content) return { success: true, recorded: false };

    const description = safeParseDescription(result.data.content);
    if (!description) return { success: true, recorded: false };

    const existingResult = await getAllFeedbackPatterns();
    const existingPatterns = existingResult.success ? existingResult.data : [];
    const match = findSimilarPattern(existingPatterns, description);

    if (match) {
      await bumpFeedbackPattern(match.id);
    } else {
      await addFeedbackPattern({
        id: uuidv4(),
        patternSignature: buildSignature(description),
        description,
        exampleSnippet: assistantText.slice(0, 300),
        sourceMessageId: messageId,
      });
      await enforcePatternCap();
    }

    return { success: true, recorded: true };
  } catch (err) {
    console.error('[FeedbackMemory] recordDislikeFeedback failed:', err);
    return { success: false, recorded: false };
  }
}

/**
 * Builds the system-message text listing the highest-signal "avoid
 * this" patterns, ranked by occurrence_count (how many times a similar
 * dislike has been seen) then recency. Returns null if nothing's been
 * learned yet, same null-means-omit convention as
 * memoryEngine.js's buildMemoryContextBlock().
 */
export async function buildFeedbackGuidanceBlock() {
  const result = await getAllFeedbackPatterns(MAX_PATTERNS_IN_PROMPT);
  if (!result.success || !result.data || result.data.length === 0) return null;

  const lines = result.data
    .slice(0, MAX_PATTERNS_IN_PROMPT)
    .map((p) => `- ${p.description}`)
    .join('\n');

  return (
    `The person has given "thumbs down" feedback on past replies that shared the patterns below ` +
    `(more repeats = stronger signal, but even one is worth heeding). Apply this guidance ` +
    `naturally - don't mention feedback, ratings, or this list to the person unless asked.\n\n${lines}`
  );
}

/**
 * Convenience wrapper for chatStore.js: returns the guidance block as a
 * ready-to-inject { role: 'system', content } message, or null.
 */
export async function getFeedbackGuidanceMessage() {
  const block = await buildFeedbackGuidanceBlock();
  if (!block) return null;
  return { role: 'system', content: block };
}
