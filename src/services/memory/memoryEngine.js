/**
 * ZAO - Long-Term Memory Engine
 *
 * This gives ZAO the same kind of persistent, cross-conversation memory
 * Claude/ChatGPT have: durable facts about the person (name, preferences,
 * projects, ongoing context) that are extracted from conversations as they
 * happen and automatically re-injected into every future conversation,
 * without the person ever having to repeat themselves.
 *
 * Three mechanisms:
 *   1. buildMemoryContextBlock() - reads all active memories from SQLite
 *      (src/db/database.js) and formats them into a system message,
 *      injected at the front of `history` for every new conversation.
 *   2. extractMemoriesFromTurn() - after each assistant reply, fires a
 *      background call to the Termux backend that looks at the latest
 *      exchange and decides whether it contains a durable fact worth
 *      remembering. Runs fire-and-forget (never blocks the chat UI) and
 *      fails silently - memory extraction is a nice-to-have, never
 *      something that should make a chat response feel slower or riskier.
 *   3. detectExplicitMemoryCommand() - a fast, local (no LLM call) pattern
 *      match for direct commands like "remember this", "add this to your
 *      memory", "don't forget...", "forget that I...". Unlike #2, this is
 *      deterministic and immediate: if the person explicitly asks ZAO to
 *      remember or forget something, it must actually happen, synchronously,
 *      before ZAO even replies - not "maybe, if the background extraction
 *      model judges it worth it later."
 *
 * Storage is 100% local (SQLite via src/db/database.js) - nothing about a
 * person's memories ever leaves the device except in the outbound prompt
 * sent to whichever model they're chatting with, exactly like the rest of
 * their conversation history already does.
 */

import { v4 as uuidv4 } from 'uuid';
import * as llamaEngine from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import {
  getActiveMemories,
  addMemory,
  updateMemory,
  deactivateMemory,
} from '../../db/database';

// Extraction now runs on Qwen3-4B, the same local general-purpose model
// used for normal chat (see src/config/localModels.js). There's no
// separate "cheap model" concern anymore - it's a local llama.rn call with
// no per-call cost, so reusing Qwen3-4B rather than maintaining a second
// resident model just for extraction is the simpler and more
// memory-friendly choice on a phone. Gemma 4 (OpenRouter) is gone.
const EXTRACTION_MODEL_KEY = MODEL_KEYS.QWEN25_CODER_3B;

// Hard ceiling on how many active memories are kept at once. Once exceeded,
// the oldest-updated memories are soft-deleted first - keeps the injected
// context block bounded (a phone-hosted assistant shouldn't grow an
// unbounded prompt prefix over months of daily use) while still giving a
// "large capacity" bank - far more headroom than a person will realistically
// accumulate in casual use.
const MAX_ACTIVE_MEMORIES = 500;

// Below this many characters in a user+assistant turn, don't even bother
// calling the extraction model - greetings and one-word replies are never
// going to contain a durable fact, and this saves a network call.
const MIN_TURN_LENGTH_FOR_EXTRACTION = 12;

// ============================================================================
// EXPLICIT MEMORY COMMANDS - "remember this", "add this to your memory",
// "don't forget to save this", "forget that I...", etc. Matched locally
// with regex (no LLM call, no network) so it's instant and 100% reliable -
// if the person explicitly asks ZAO to remember or forget something, that
// must actually happen every single time, not "probably, if the background
// extraction model agrees it's worth it."
//
// Patterns are intentionally broad (leading TRIGGER phrase, optional
// filler like "to" or "that", then the actual content) since real phrasing
// varies a lot: "remember this: I'm vegetarian", "please remember that I
// prefer dark mode", "add this to your memory - my flight is on the 14th",
// "don't forget to save this to your memory, my API key rotates monthly".
// ============================================================================

// Ordered roughly most-specific-first. Each regex captures the payload
// (the actual fact) in its last capturing group. Case-insensitive, 's' flag
// so '.' matches newlines (people sometimes paste multi-line context after
// the trigger phrase).
const REMEMBER_PATTERNS = [
  /^(?:please\s+)?(?:don'?t forget to\s+)?(?:remember|memorize)(?:\s+that)?(?:\s+this)?\s*[:\-,]?\s*(.+)$/is,
  /^(?:please\s+)?add\s+this\s+to\s+(?:your\s+)?memory\s*[:\-,]?\s*(.+)$/is,
  /^(?:please\s+)?save\s+this\s+to\s+(?:your\s+)?memory\s*[:\-,]?\s*(.+)$/is,
  /^(?:please\s+)?(?:don'?t forget to\s+)?save\s+(?:this|that)\s+(?:to|in)\s+(?:your\s+)?memory\s*[:\-,]?\s*(.+)$/is,
  /^(?:please\s+)?keep\s+(?:this|that)\s+in\s+mind\s*[:\-,]?\s*(.+)$/is,
];

const FORGET_PATTERNS = [
  /^(?:please\s+)?forget(?:\s+that)?\s*[:\-,]?\s*(.+)$/is,
];

/**
 * Checks whether a raw user message opens with an explicit "remember this"
 * / "forget that" style command, and if so extracts the payload.
 *
 * Deliberately only matches near the START of the message (with optional
 * "please"/"don't forget to" filler) rather than searching anywhere in the
 * text - a message like "remind me why remembering this matters" should
 * NOT be treated as a memory command just because it contains the word
 * "remember" partway through.
 *
 * @returns {{ type: 'remember'|'forget', payload: string } | null}
 */
export function detectExplicitMemoryCommand(userText) {
  const trimmed = (userText || '').trim();
  if (!trimmed) return null;

  for (const pattern of REMEMBER_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match && match[1] && match[1].trim().length > 0) {
      return { type: 'remember', payload: match[1].trim() };
    }
  }

  for (const pattern of FORGET_PATTERNS) {
    const match = trimmed.match(pattern);
    if (match && match[1] && match[1].trim().length > 0) {
      return { type: 'forget', payload: match[1].trim() };
    }
  }

  return null;
}

/**
 * Handles a detected 'remember' command: stores the payload as a memory
 * immediately (no LLM call, no "is this worth it" judgment - the person
 * asked directly, so it's saved verbatim, lightly cleaned up). If it looks
 * like it updates an existing memory (same heuristic as background
 * extraction), that memory is updated in place instead of duplicated.
 *
 * Returns a short confirmation string ZAO can use as/prepend to its reply,
 * mirroring how Claude confirms "Got it, I'll remember that" rather than
 * silently storing it with no acknowledgement.
 */
export async function handleRememberCommand(payload, conversationId) {
  try {
    // Strip a leading "that " left over from phrasing like "remember that
    // I'm vegetarian" after the trigger-word capture above.
    let content = payload.replace(/^that\s+/i, '').trim();
    if (content.length > 500) content = content.slice(0, 500); // guard against a runaway paste

    const existingResult = await getActiveMemories();
    const existingMemories = existingResult.success ? existingResult.data : [];
    const superseded = findLikelySupersededMemory(existingMemories, content);

    if (superseded) {
      await updateMemory(superseded.id, { content });
    } else {
      await addMemory({ id: uuidv4(), content, category: 'general', sourceConversationId: conversationId });
    }
    await enforceMemoryCap();

    return { success: true, confirmation: `Got it — I'll remember that.` };
  } catch (err) {
    console.error('[MemoryEngine] handleRememberCommand failed:', err);
    return { success: false, confirmation: null };
  }
}

/**
 * Handles a detected 'forget' command: finds the best-matching active
 * memory to the payload and soft-deletes it (see deactivateMemory in
 * database.js). If nothing matches well enough, tells the person plainly
 * rather than silently doing nothing or guessing at the wrong memory.
 */
export async function handleForgetCommand(payload) {
  try {
    const existingResult = await getActiveMemories();
    const existingMemories = existingResult.success ? existingResult.data : [];
    const match = findLikelySupersededMemory(existingMemories, payload);

    if (!match) {
      return { success: true, matched: false, confirmation: `I don't have anything saved that matches that, so there's nothing to forget.` };
    }

    await deactivateMemory(match.id);
    return { success: true, matched: true, confirmation: `Done — I've forgotten that.` };
  } catch (err) {
    console.error('[MemoryEngine] handleForgetCommand failed:', err);
    return { success: false, matched: false, confirmation: null };
  }
}

/**
 * Formats all active memories into a system-message string, styled the
 * same way Claude's own memory block is described to it: plain prose
 * grouped loosely by category, presented as background knowledge rather
 * than a database dump. Returns null if there are no memories yet, so
 * callers can skip adding an empty system message.
 */
export async function buildMemoryContextBlock() {
  const result = await getActiveMemories();
  if (!result.success || !result.data || result.data.length === 0) {
    return null;
  }

  const byCategory = {};
  for (const m of result.data) {
    const cat = m.category || 'general';
    if (!byCategory[cat]) byCategory[cat] = [];
    byCategory[cat].push(m.content);
  }

  const sections = Object.entries(byCategory)
    .map(([cat, items]) => `${cat}:\n${items.map((i) => `- ${i}`).join('\n')}`)
    .join('\n\n');

  return (
    `The following are things you (ZAO) remember about the person from past conversations. ` +
    `Use them naturally when relevant - don't mention that you're "recalling memory" or list ` +
    `them back verbatim unless asked. Never let them override what the person is directly ` +
    `telling you right now.\n\n${sections}`
  );
}

/**
 * Convenience wrapper for chatStore/orchestrator: returns the memory block
 * as a ready-to-prepend { role: 'system', content } message, or null.
 */
export async function getMemorySystemMessage() {
  const block = await buildMemoryContextBlock();
  if (!block) return null;
  return { role: 'system', content: block };
}

function safeParseJsonArray(text) {
  if (!text) return [];
  // Models sometimes wrap JSON in ```json fences despite instructions -
  // strip those defensively rather than failing the whole extraction.
  const cleaned = text.replace(/```json/gi, '').replace(/```/g, '').trim();
  try {
    const parsed = JSON.parse(cleaned);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/**
 * Looks at active memories and returns any whose `content` appears to
 * describe the same real-world fact as `newContent` (e.g. an old city vs a
 * new city) so extraction can update-in-place instead of piling up
 * contradictory rows. This is a cheap heuristic (shared significant word
 * overlap), not a semantic embedding search - on-device, no-network
 * similarity is the goal here, not perfect recall.
 */
function findLikelySupersededMemory(existingMemories, newContent) {
  const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'user', 'their', 'they', 'has', 'have', 'and', 'to', 'of', 'in', 'on', 'for', 'with']);
  const tokenize = (s) =>
    new Set(
      s
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, '')
        .split(/\s+/)
        .filter((w) => w.length > 2 && !stopWords.has(w))
    );

  const newTokens = tokenize(newContent);
  if (newTokens.size === 0) return null;

  let best = null;
  let bestOverlap = 0;
  for (const mem of existingMemories) {
    const existingTokens = tokenize(mem.content);
    let overlap = 0;
    for (const t of newTokens) {
      if (existingTokens.has(t)) overlap += 1;
    }
    const overlapRatio = overlap / Math.min(newTokens.size, existingTokens.size || 1);
    if (overlapRatio > 0.5 && overlap > bestOverlap) {
      bestOverlap = overlap;
      best = mem;
    }
  }
  return best;
}

/**
 * Runs the oldest-first soft-delete pass if the active memory count is
 * over MAX_ACTIVE_MEMORIES. Keeps the bank bounded without the person
 * having to manually prune it.
 */
async function enforceMemoryCap() {
  const result = await getActiveMemories();
  if (!result.success || result.data.length <= MAX_ACTIVE_MEMORIES) return;

  const overflowCount = result.data.length - MAX_ACTIVE_MEMORIES;
  // getActiveMemories returns updated_at DESC, so the oldest are at the end.
  const toRemove = result.data.slice(-overflowCount);
  for (const mem of toRemove) {
    await deactivateMemory(mem.id);
  }
}

/**
 * Fire-and-forget: examines the latest user+assistant exchange and stores
 * any durable fact it finds. Never throws, never surfaces an error to the
 * caller - callers should invoke this without awaiting (or await + ignore
 * the result) so a slow/failed extraction call never delays the chat UI.
 *
 * @param {string} userText - the person's message this turn
 * @param {string} assistantText - ZAO's reply this turn
 * @param {string} conversationId - for source_conversation_id traceability
 */
export async function extractMemoriesFromTurn(userText, assistantText, conversationId) {
  try {
    if (!userText || userText.trim().length < MIN_TURN_LENGTH_FOR_EXTRACTION) {
      return { success: true, extracted: 0 };
    }

    const existingResult = await getActiveMemories();
    const existingMemories = existingResult.success ? existingResult.data : [];
    const existingSummary = existingMemories.slice(0, 60).map((m) => `- [${m.category}] ${m.content}`).join('\n') || '(none yet)';

    const extractionPrompt = `You extract durable, worth-remembering facts about a person from one chat exchange, for a long-term memory system (like Claude or ChatGPT's memory).

Extract a fact ONLY if it's:
- Personal/durable (name, location, job, relationships, long-running projects, strong preferences, recurring context)
- Likely still true weeks or months from now
- NOT already covered by an existing memory below (unless it UPDATES one)

Do NOT extract:
- One-off questions, small talk, or anything task-specific to just this message
- Anything already known (see existing memories below)
- Sensitive data like passwords, private keys, or financial account numbers

Existing memories:
${existingSummary}

New exchange:
User: ${userText.slice(0, 2000)}
Assistant: ${(assistantText || '').slice(0, 1000)}

Respond with ONLY a JSON array (no markdown fences, no commentary). Each item: {"content": "concise fact in third person, e.g. 'User lives in Lagos'", "category": "personal|work|preference|project|general"}. If nothing is worth remembering, respond with exactly: []`;

    const result = await llamaEngine.sendMessage(
      [{ role: 'user', content: extractionPrompt }],
      EXTRACTION_MODEL_KEY,
      { maxTokens: 500, temperature: 0.2 }
    );

    if (!result.success || !result.data?.content) {
      return { success: true, extracted: 0 };
    }

    const facts = safeParseJsonArray(result.data.content);
    if (facts.length === 0) return { success: true, extracted: 0 };

    let extractedCount = 0;
    for (const fact of facts) {
      const content = (fact?.content || '').trim();
      if (!content || content.length > 300) continue; // guard against a runaway/garbled response
      const category = ['personal', 'work', 'preference', 'project', 'general'].includes(fact?.category)
        ? fact.category
        : 'general';

      const superseded = findLikelySupersededMemory(existingMemories, content);
      if (superseded) {
        await updateMemory(superseded.id, { content, category });
      } else {
        await addMemory({ id: uuidv4(), content, category, sourceConversationId: conversationId });
        existingMemories.push({ content, category }); // avoid duplicate inserts within the same batch
      }
      extractedCount += 1;
    }

    if (extractedCount > 0) {
      await enforceMemoryCap();
    }

    return { success: true, extracted: extractedCount };
  } catch (err) {
    console.error('[MemoryEngine] extractMemoriesFromTurn failed:', err);
    return { success: false, extracted: 0 };
  }
}
