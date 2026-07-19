/**
 * ZAO - Working Memory (context-window management)
 *
 * This is the "context window" memory type from the taxonomy in
 * memoryTypes.js: the literal token/character budget available in a
 * single model call. Before this module existed, chatStore.js sent the
 * ENTIRE message history for a conversation to the backend on every
 * turn (see the three `history = ...map(...)` call sites it used to
 * build inline) - fine for a short chat, but a long-running conversation
 * (which is exactly what ZAO is built for - one person, one assistant,
 * used daily) would eventually either overflow the model's n_ctx or
 * silently push earlier turns out of context in a way nothing tracked.
 *
 * The fix is the same one every long-lived chat product uses: keep the
 * most recent messages verbatim (the model reasons best over exact
 * recent wording) and compress everything older into one running prose
 * summary, extended incrementally as the conversation grows rather than
 * recomputed from scratch every time. That summary is persisted per
 * conversation (see rolling_summary / rolling_summary_covers_at columns
 * in src/db/database.js) so re-opening a long-closed conversation
 * doesn't require re-summarizing months of history in one shot.
 *
 * This module owns ONLY the budgeting/compaction decision. It does not
 * decide what goes in the system prompt beyond the summary itself -
 * memoryEngine.js's semantic-memory block and retrievalMemory.js's
 * recalled snippets are separate system messages layered in by
 * chatStore.js, in a fixed order (see buildFullHistory there).
 */

import * as llamaEngine from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import { getRollingSummary, setRollingSummary } from '../../db/database';

// Character budget for the RAW (uncompressed) portion of history sent to
// the model. This is deliberately conservative and character-based, not
// token-based - a phone/PC-served small model doesn't warrant a real
// tokenizer dependency just for this estimate, and ~4 chars/token is a
// safe-enough approximation for the "should I compact yet?" decision.
// Tune this down if a smaller-context model is ever the default (see
// src/config/localModels.js).
const RAW_HISTORY_CHAR_BUDGET = 16000;

// Always keep at least this many of the most recent messages verbatim,
// regardless of the char budget - a plan-review or multi-step coding
// conversation needs its last few exchanges intact even if they happen
// to be long, since that's exactly the context the model needs most.
const MIN_RAW_MESSAGES_KEPT = 8;

// Below this raw-history size, don't bother compacting at all - most
// conversations never get here, and this keeps the vast majority of
// chats exactly as fast as before this module existed.
const COMPACTION_THRESHOLD_CHARS = 20000;

const SUMMARY_MODEL_KEY = MODEL_KEYS.QWEN25_CODER_3B;

function estimateChars(messages) {
  return messages.reduce((sum, m) => sum + (m.content?.length || 0), 0);
}

/**
 * Builds the exact `history` array to send to the model for this turn:
 * [rolling-summary system message if one exists or was just built,
 *  ...raw recent messages]. Falls back to sending everything verbatim
 * (today's behavior) if compaction isn't needed, isn't possible (no
 * conversationId), or the summarization call itself fails - working
 * memory is a performance/safety net, never something that should make
 * a chat turn fail outright.
 *
 * @param {string|null} conversationId
 * @param {Array<{role, content, created_at}>} allMessages - full history for this conversation, oldest first, INCLUDING the new user message
 * @returns {Promise<Array<{role, content}>>}
 */
export async function buildWorkingHistory(conversationId, allMessages) {
  try {
    if (!Array.isArray(allMessages) || allMessages.length === 0) return [];

    const totalChars = estimateChars(allMessages);
    if (totalChars <= COMPACTION_THRESHOLD_CHARS || !conversationId) {
      return allMessages.map((m) => ({ role: m.role, content: m.content }));
    }

    const existing = await getRollingSummary(conversationId);
    const coversAt = existing.success ? existing.data?.rolling_summary_covers_at || 0 : 0;
    const priorSummary = existing.success ? existing.data?.rolling_summary || '' : '';

    // Split at MIN_RAW_MESSAGES_KEPT from the end first, then keep
    // walking backward while the raw tail is still under budget - this
    // is why it's "at least MIN_RAW_MESSAGES_KEPT, more if they fit"
    // rather than a fixed count.
    let rawStartIdx = Math.max(0, allMessages.length - MIN_RAW_MESSAGES_KEPT);
    while (rawStartIdx > 0 && estimateChars(allMessages.slice(rawStartIdx)) < RAW_HISTORY_CHAR_BUDGET) {
      rawStartIdx -= 1;
    }
    if (estimateChars(allMessages.slice(rawStartIdx)) > RAW_HISTORY_CHAR_BUDGET) {
      rawStartIdx += 1; // stepped one too far back - back off
    }

    const olderMessages = allMessages.slice(0, rawStartIdx);
    const rawTail = allMessages.slice(rawStartIdx);

    if (olderMessages.length === 0) {
      // Nothing old enough to summarize yet (the tail alone already
      // covers everything) - just send it all raw.
      return allMessages.map((m) => ({ role: m.role, content: m.content }));
    }

    // Only the messages not already folded into priorSummary need
    // summarizing - this is what makes it a ROLLING summary (cheap,
    // incremental) rather than re-summarizing the whole conversation
    // every single time it grows.
    const newlyCoveredMessages = olderMessages.filter((m) => (m.created_at || 0) > coversAt);
    const summary = newlyCoveredMessages.length > 0
      ? await extendSummary(priorSummary, newlyCoveredMessages)
      : priorSummary;

    if (summary) {
      const newCoversAt = olderMessages[olderMessages.length - 1]?.created_at || coversAt;
      await setRollingSummary(conversationId, { summary, coversAt: newCoversAt });
      return [
        { role: 'system', content: `Summary of earlier conversation (older messages, condensed to save space - treat as background context, not verbatim quotes):\n${summary}` },
        ...rawTail.map((m) => ({ role: m.role, content: m.content })),
      ];
    }

    // Summarization failed - fail open by sending everything raw rather
    // than silently dropping the older half of the conversation.
    return allMessages.map((m) => ({ role: m.role, content: m.content }));
  } catch (err) {
    console.error('[WorkingMemory] buildWorkingHistory failed, falling back to full history:', err);
    return allMessages.map((m) => ({ role: m.role, content: m.content }));
  }
}

/** Runs one local model call to fold `newMessages` into `priorSummary`, producing a single updated paragraph. Returns null (not throws) on failure so the caller can fail open. */
async function extendSummary(priorSummary, newMessages) {
  try {
    const transcript = newMessages
      .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${(m.content || '').slice(0, 800)}`)
      .join('\n');

    const prompt = priorSummary
      ? `Here is a running summary of an ongoing conversation so far:\n${priorSummary}\n\nUpdate it to also account for this next part of the conversation:\n${transcript}\n\nRespond with ONLY the updated summary paragraph (plain text, no preamble, no markdown) - concise, third person, factual, preserving anything a person would need to remember to keep the conversation coherent (decisions made, tasks in progress, names/numbers mentioned).`
      : `Summarize this part of a conversation in one concise paragraph, third person, factual, preserving anything a person would need to remember to keep the conversation coherent (decisions made, tasks in progress, names/numbers mentioned):\n${transcript}\n\nRespond with ONLY the summary paragraph, no preamble, no markdown.`;

    const result = await llamaEngine.sendMessage(
      [{ role: 'user', content: prompt }],
      SUMMARY_MODEL_KEY,
      { maxTokens: 400, temperature: 0.2 }
    );

    if (!result.success || !result.data?.content) return priorSummary || null;
    return result.data.content.trim();
  } catch (err) {
    console.error('[WorkingMemory] extendSummary failed:', err);
    return priorSummary || null;
  }
}

// Re-exported for tests/diagnostics (e.g. a future Settings > Developer
// Mode panel showing "context usage this turn").
export const _internals = { estimateChars, RAW_HISTORY_CHAR_BUDGET, COMPACTION_THRESHOLD_CHARS, MIN_RAW_MESSAGES_KEPT };
