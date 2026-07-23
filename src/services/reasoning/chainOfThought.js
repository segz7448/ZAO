/**
 * ZAO - Chain of Thought (CoT)
 *
 * Linear step-by-step reasoning before an answer, in one model call.
 * This is ZAO's default reasoning strategy for plain chat - the
 * majority of messages that don't need a specific inference mode
 * (deductive/inductive/abductive/analogical), don't need branching
 * search (tree of thought), and don't need real tools (ReAct).
 *
 * Shape: the model is asked to reason inside <thinking> tags, then give
 * the person-facing answer inside <answer> tags. The trace (thinking)
 * is kept for the reasoning chip in ChatScreen.js; only the answer is
 * shown in the bubble itself, same as extended-thinking-style UIs.
 */

import * as backendClient from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';

const COT_SYSTEM_PROMPT = `Think through this step by step before answering. Put your step-by-step reasoning inside <thinking></thinking> tags - be concrete, work through the actual substance of the question, don't just restate it. Then put your final, person-facing answer inside <answer></answer> tags. The <answer> should stand alone and read naturally - don't say "as I reasoned above" or reference the <thinking> section, since the person may only see the answer. Use ONLY these two tags, nothing else outside them.`;

/**
 * @param {Array<{role, content}>} history - full conversation so far, ending in the new user message
 * @param {(text: string) => void} [onToken] - called with the in-progress, person-facing
 *   answer text as it streams in. The first call only happens once an <answer> tag has
 *   opened. See extractStreamingAnswer() below for how a partial/still-arriving closing
 *   tag is kept from flashing into the visible text.
 * @param {(text: string) => void} [onThinking] - called with the in-progress reasoning
 *   text WHILE the model is still inside <thinking>, so the UI can show the model's
 *   live train of thought instead of a bare spinner (see extractStreamingThinking()).
 *   Stops firing once <answer> opens - onToken takes over from there.
 * @returns {Promise<{success: boolean, content: string, trace: string|null, error: object|null}>}
 */
export async function runChainOfThought(history, onToken, onThinking) {
  const augmented = withSystemPrompt(history, COT_SYSTEM_PROMPT);

  const hasOnToken = typeof onToken === 'function';
  const hasOnThinking = typeof onThinking === 'function';

  const result = await backendClient.sendMessage(augmented, MODEL_KEYS.QWEN25_CODER_3B, {
    maxTokens: 1024,
    temperature: 0.7,
    onToken: (hasOnToken || hasOnThinking)
      ? (accumulatedRaw) => {
          const visible = extractStreamingAnswer(accumulatedRaw);
          if (visible !== null) {
            if (hasOnToken) onToken(visible);
            return;
          }
          if (hasOnThinking) {
            const thinkingSoFar = extractStreamingThinking(accumulatedRaw);
            if (thinkingSoFar !== null) onThinking(thinkingSoFar);
          }
        }
      : undefined,
  });

  if (!result.success) {
    return { success: false, content: '', trace: null, error: result.error };
  }

  const { thinking, answer } = splitThinkingAndAnswer(result.data?.content || '');
  return { success: true, content: answer, trace: thinking, error: null };
}

/**
 * Given the raw model output accumulated SO FAR (mid-stream, so it may end
 * anywhere - inside <thinking>, between tags, mid-word inside <answer>, or
 * mid-way through the literal characters of a not-yet-complete "</answer>"),
 * returns the text that's safe to show in the reply bubble right now, or
 * null if there's nothing showable yet (still inside/before <thinking>, or
 * <answer> hasn't opened).
 *
 * The one thing this actively guards against: as "</answer>" arrives
 * character-by-character, a naive "everything since <answer>" would flash
 * "some text<", then "some text</", then "some text</a" etc. into the
 * bubble for a few tokens before the tag completes and splitThinkingAndAnswer
 * strips it. This trims any trailing prefix-of-"</answer>" off the end so
 * that never shows.
 */
export function extractStreamingAnswer(rawTextSoFar) {
  const openMatch = rawTextSoFar.match(/<answer>/i);
  if (!openMatch) return null;

  let visible = rawTextSoFar.slice(openMatch.index + openMatch[0].length);

  const closeMatch = visible.match(/<\/answer>/i);
  if (closeMatch) {
    return visible.slice(0, closeMatch.index).trim();
  }

  // No complete closing tag yet - strip any trailing partial prefix of
  // "</answer>" (e.g. "<", "</", "</an") so it doesn't briefly appear.
  const CLOSE_TAG = '</answer>';
  for (let len = Math.min(CLOSE_TAG.length - 1, visible.length); len > 0; len -= 1) {
    if (visible.slice(-len).toLowerCase() === CLOSE_TAG.slice(0, len).toLowerCase()) {
      visible = visible.slice(0, -len);
      break;
    }
  }

  return visible;
}

/**
 * Same idea as extractStreamingAnswer() above, but for the <thinking> block
 * instead: given raw model output accumulated so far, returns the reasoning
 * text that's safe to show live (e.g. in a "🧠 Thinking…" box) right now, or
 * null if nothing showable yet (still before/inside the opening <thinking>
 * tag itself). Stops returning new text once <answer> opens - at that point
 * extractStreamingAnswer() takes over and this should no longer be called.
 * Guards against a partial "</thinking>" tag flashing into view the same way
 * extractStreamingAnswer() guards against a partial "</answer>".
 */
export function extractStreamingThinking(rawTextSoFar) {
  const openMatch = rawTextSoFar.match(/<thinking>/i);
  if (!openMatch) return null;

  let visible = rawTextSoFar.slice(openMatch.index + openMatch[0].length);

  // <answer> has opened - the thinking phase is over, nothing new to show here.
  if (/<answer>/i.test(visible)) {
    const beforeAnswer = visible.split(/<answer>/i)[0];
    return beforeAnswer.replace(/<\/thinking>\s*$/i, '').trim();
  }

  const closeMatch = visible.match(/<\/thinking>/i);
  if (closeMatch) {
    return visible.slice(0, closeMatch.index).trim();
  }

  // No complete closing tag yet - strip any trailing partial prefix of
  // "</thinking>" so it doesn't briefly appear.
  const CLOSE_TAG = '</thinking>';
  for (let len = Math.min(CLOSE_TAG.length - 1, visible.length); len > 0; len -= 1) {
    if (visible.slice(-len).toLowerCase() === CLOSE_TAG.slice(0, len).toLowerCase()) {
      visible = visible.slice(0, -len);
      break;
    }
  }

  return visible;
}

/**
 * Inserts (or merges into an existing leading) system message so a
 * reasoning-mode prompt doesn't get sent as a second competing system
 * message alongside memory/working-history system content already
 * built by chatStore.js's assembleHistory().
 */
export function withSystemPrompt(history, instructions) {
  if (!Array.isArray(history) || history.length === 0) return history;
  const [first, ...rest] = history;
  if (first.role === 'system') {
    return [{ ...first, content: `${first.content}\n\n${instructions}` }, ...rest];
  }
  return [{ role: 'system', content: instructions }, ...history];
}

/**
 * Pulls <thinking>...</thinking> and <answer>...</answer> out of raw
 * model output. Falls back gracefully if the model didn't follow the
 * tag format exactly (small local models don't always comply) - the
 * whole response becomes the answer and trace is null, rather than
 * showing the person a mangled or truncated reply.
 */
export function splitThinkingAndAnswer(rawContent) {
  const thinkingMatch = rawContent.match(/<thinking>([\s\S]*?)<\/thinking>/i);
  const answerMatch = rawContent.match(/<answer>([\s\S]*?)<\/answer>/i);

  if (answerMatch) {
    return {
      thinking: thinkingMatch ? thinkingMatch[1].trim() : null,
      answer: answerMatch[1].trim(),
    };
  }

  // No <answer> tag found - strip a <thinking> block if present (so it
  // at least doesn't leak into the visible reply) and use the rest.
  const withoutThinking = rawContent.replace(/<thinking>[\s\S]*?<\/thinking>/i, '').trim();
  return {
    thinking: thinkingMatch ? thinkingMatch[1].trim() : null,
    answer: withoutThinking || rawContent.trim(),
  };
}
