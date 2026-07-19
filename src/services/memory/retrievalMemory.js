/**
 * ZAO - Retrieval Memory (vector/retrieval memory type)
 *
 * The taxonomy calls this "embeddings + similarity search over a
 * knowledge base (RAG-style)". ZAO doesn't run a real embedding model on
 * a 4GB phone, so this is a lexical (BM25) stand-in: cheap, local, no
 * network, no extra model weights - but it plays the same functional
 * role as a vector store for this app's actual failure mode, which
 * isn't "the model needs paragraph-level semantic similarity over a
 * huge corpus" but "the person referenced something from three weeks
 * ago in a conversation that's no longer in the current context
 * window or even the current chat thread at all."
 *
 * This is deliberately separate from memoryEngine.js's semantic memory
 * (durable EXTRACTED facts, always injected) and workingMemory.js's
 * rolling summary (THIS conversation's own older turns, always
 * injected once long enough). Retrieval memory searches RAW past
 * messages across EVERY conversation, and only fires when the current
 * message actually looks like a backward-reference - it would be both
 * slow and noisy to run this on every single turn.
 */

import { getRecentMessagesAcrossConversations } from '../../db/database';

// Local, no-LLM cue detection - same design choice as
// memoryEngine.js's detectExplicitMemoryCommand: a fast regex pass, not
// a model call, so checking "should I even bother retrieving?" never
// adds latency to the common case (most messages aren't backward
// references).
const RECALL_CUE_PATTERNS = [
  /\b(remember when|remember that time|remember what)\b/i,
  /\b(we (?:talked|discussed|spoke) about)\b/i,
  /\b(you mentioned|i mentioned|i told you)\b/i,
  /\b(last time (?:we|i))\b/i,
  /\b(earlier (?:we|i|you) (?:talked|discussed|said|mentioned))\b/i,
  /\b(what did (?:i|we|you) (?:say|decide|discuss|talk about))\b/i,
  /\b(before,? (?:i|we) (?:said|talked|discussed))\b/i,
  /\b(in (?:a|our|that) (?:previous|past|earlier|old) (?:conversation|chat|session))\b/i,
];

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'i', 'we', 'you', 'me', 'my', 'our', 'your',
  'it', 'that', 'this', 'to', 'of', 'in', 'on', 'for', 'with', 'and', 'or', 'do', 'did', 'does',
  'about', 'what', 'when', 'where', 'who', 'how', 'remember', 'talked', 'discussed', 'mentioned',
  'said', 'told', 'earlier', 'before', 'last', 'time', 'previous', 'conversation', 'chat',
]);

function tokenize(text) {
  return (text || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));
}

/** Cheap local check: does this message look like it's pointing back at a past conversation? No LLM call. */
export function shouldAttemptRecall(userText) {
  const text = (userText || '').trim();
  if (text.length < 8) return false;
  return RECALL_CUE_PATTERNS.some((p) => p.test(text));
}

/**
 * BM25-lite scoring: term frequency in the message, weighted down for
 * terms that appear in almost every candidate (rough idf), no length
 * normalization sophistication - good enough to rank "does this old
 * message actually relate to the query" without an embedding model.
 */
function scoreMessage(queryTokens, docTokens, docFreqByTerm, totalDocs) {
  if (docTokens.length === 0) return 0;
  const docTermCounts = new Map();
  for (const t of docTokens) docTermCounts.set(t, (docTermCounts.get(t) || 0) + 1);

  let score = 0;
  for (const qt of queryTokens) {
    const tf = docTermCounts.get(qt) || 0;
    if (tf === 0) continue;
    const df = docFreqByTerm.get(qt) || 1;
    const idf = Math.log(1 + totalDocs / df);
    score += tf * idf;
  }
  return score;
}

/**
 * Searches recent messages (across ALL conversations, excluding the
 * current one to avoid "recalling" what's already in this turn's own
 * context) for the best matches to userText, and returns a short,
 * ready-to-inject system message - or null if nothing scored well
 * enough to be worth surfacing.
 *
 * @param {string} userText
 * @param {{ excludeConversationId?: string, limit?: number }} options
 */
export async function retrieveRelevantContext(userText, { excludeConversationId = null, limit = 4 } = {}) {
  try {
    const queryTokens = tokenize(userText);
    if (queryTokens.length === 0) return null;

    const poolResult = await getRecentMessagesAcrossConversations(3000);
    if (!poolResult.success || poolResult.data.length === 0) return null;

    const candidates = poolResult.data.filter((m) => m.conversation_id !== excludeConversationId);
    if (candidates.length === 0) return null;

    // Precompute document frequency per term across the candidate pool
    // for the idf weighting above - one pass, cheap even at a few
    // thousand rows on a phone.
    const docTokensById = new Map();
    const docFreqByTerm = new Map();
    for (const m of candidates) {
      const toks = tokenize(m.content);
      docTokensById.set(m.id, toks);
      const seen = new Set(toks);
      for (const t of seen) {
        if (!queryTokens.includes(t)) continue; // only track terms we'll actually query
        docFreqByTerm.set(t, (docFreqByTerm.get(t) || 0) + 1);
      }
    }

    const scored = candidates
      .map((m) => ({ message: m, score: scoreMessage(queryTokens, docTokensById.get(m.id) || [], docFreqByTerm, candidates.length) }))
      .filter((s) => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);

    if (scored.length === 0) return null;

    const snippets = scored
      .map(({ message }) => {
        const when = message.created_at ? new Date(message.created_at).toISOString().slice(0, 10) : 'unknown date';
        const truncated = message.content.length > 300 ? `${message.content.slice(0, 300)}…` : message.content;
        return `[${when}, "${message.conversation_title || 'Untitled conversation'}"] ${message.role === 'user' ? 'User said' : 'You said'}: ${truncated}`;
      })
      .join('\n\n');

    return {
      role: 'system',
      content: `The person's message seems to reference a past conversation. Here are the most relevant snippets found by searching chat history (may or may not actually be what they mean - use judgment, don't just assume a match is correct):\n\n${snippets}`,
    };
  } catch (err) {
    console.error('[RetrievalMemory] retrieveRelevantContext failed:', err);
    return null;
  }
}
