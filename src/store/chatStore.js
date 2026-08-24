/**
 * ZAO - Chat Store (Zustand)
 *
 * Holds active conversation state. All DB calls go through the safe
 * database.js wrappers, so store actions check `.success` and set
 * `error` state instead of throwing - the UI can always render something.
 */

import { create } from 'zustand';
import 'react-native-get-random-values';
import { v4 as uuidv4 } from 'uuid';
import * as FileSystem from 'expo-file-system';
import {
  createConversation,
  getMessages,
  addMessage,
  updateMessage as dbUpdateMessage,
  updateConversationMeta,
  getConversations,
  deleteConversation as dbDeleteConversation,
  deleteMessagesAfter,
  setMessageFeedback as dbSetMessageFeedback,
  clearPendingConfirmation as dbClearPendingConfirmation,
} from '../db/database';
import { sendMessageOrchestrated } from '../utils/orchestrator';
import { approveAndRunPendingTool } from '../services/toolOrchestrator';
import { usePreferencesStore } from './preferencesStore';
import { processAttachedFile, formatFileContextBlock } from '../services/fileProcessor';
import { getMemorySystemMessage, extractMemoriesFromTurn, detectExplicitMemoryCommand, handleRememberCommand, handleForgetCommand } from '../services/memory/memoryEngine';
import { buildWorkingHistory } from '../services/memory/workingMemory';
import { shouldAttemptRecall, retrieveRelevantContext } from '../services/memory/retrievalMemory';
import { getFeedbackGuidanceMessage, recordDislikeFeedback } from '../services/memory/feedbackMemory';

/**
 * Assembles the exact `history` array sent to the model for a turn,
 * layering every memory type that injects into the prompt, in a fixed
 * order, in one place - all three send paths below (send / edit /
 * regenerate) call this instead of each hand-rolling their own
 * unshift() calls, so the order and the compaction behavior can't drift
 * between them.
 *
 * Order (front to back): semantic facts (memoryEngine.js) -> feedback
 * guidance distilled from past dislikes (feedbackMemory.js) -> retrieved
 * cross-conversation snippets (retrievalMemory.js, only when the
 * message looks like a backward reference) -> rolling summary of this
 * conversation's own older turns, if it's long enough to need one
 * (workingMemory.js) -> the raw recent turns themselves.
 *
 * @param {Array<{id, role, content, created_at}>} rawMessages - this conversation's messages, oldest first, including the new/edited message
 * @param {{ conversationId: string, memoryEnabled: boolean, lastUserText: string }} context
 */
async function assembleHistory(rawMessages, { conversationId, memoryEnabled, lastUserText }) {
  const history = await buildWorkingHistory(conversationId, rawMessages);

  if (lastUserText && shouldAttemptRecall(lastUserText)) {
    const retrieved = await retrieveRelevantContext(lastUserText, { excludeConversationId: conversationId });
    if (retrieved) history.unshift(retrieved);
  }

  if (memoryEnabled !== false) {
    // Feedback guidance is derived from past conversation content the
    // same way semantic memory is, so it's gated behind the same
    // memoryEnabled toggle rather than always-on - someone who's turned
    // memory off doesn't want past exchanges (even distilled ones)
    // feeding back into the prompt either.
    const feedbackMessage = await getFeedbackGuidanceMessage();
    if (feedbackMessage) history.unshift(feedbackMessage);

    const memoryMessage = await getMemorySystemMessage();
    if (memoryMessage) history.unshift(memoryMessage);
  }

  return history;
}

/**
 * Builds an OpenAI/OpenRouter-shaped multi-part content array for a
 * message that has an image or video attachment - `text` first (the
 * OCR/video note + whatever the person typed, exactly what was already
 * going to be sent as plain content), then one media part. Data URLs
 * (`data:<mime>;base64,<data>`) are what OpenRouter documents for both
 * image_url and video_url content parts - see server/config.js's header
 * comment for why the actual model call is relayed through the VM rather
 * than hit directly from here.
 */
function buildMultimodalContent(text, attachmentMedia) {
  const { base64, mimeType, isVideo } = attachmentMedia;
  const dataUrl = `data:${mimeType || (isVideo ? 'video/mp4' : 'image/jpeg')};base64,${base64}`;
  const parts = [{ type: 'text', text: text || '' }];
  parts.push(
    isVideo
      ? { type: 'video_url', video_url: { url: dataUrl } }
      : { type: 'image_url', image_url: { url: dataUrl } }
  );
  return parts;
}

const SENT_IMAGES_DIR = `${FileSystem.documentDirectory}zao-sent-images/`;

/**
 * Copies a user-picked image (camera or library) into the app's own
 * document directory so it persists reliably across app restarts.
 * Picker URIs - especially content:// URIs from the Android media provider -
 * aren't guaranteed to stay readable after the picker session ends, so we
 * can't just store attachment.uri directly in local_image_path.
 * Returns the new local file:// URI, or null on failure (caller falls back
 * to not showing a thumbnail rather than blocking the send).
 */
async function copyAttachmentLocally(attachment) {
  try {
    const dirInfo = await FileSystem.getInfoAsync(SENT_IMAGES_DIR);
    if (!dirInfo.exists) {
      await FileSystem.makeDirectoryAsync(SENT_IMAGES_DIR, { intermediates: true });
    }
    const ext = (attachment.name || '').split('.').pop()?.toLowerCase() || 'jpg';
    const localUri = `${SENT_IMAGES_DIR}${uuidv4()}.${ext}`;
    await FileSystem.copyAsync({ from: attachment.uri, to: localUri });
    return localUri;
  } catch (err) {
    console.error('[ChatStore] copyAttachmentLocally failed:', err);
    return null;
  }
}

/**
 * Builds the assistant message row to persist + render from a successful
 * orchestrator result. Centralized so all three call sites (send, edit,
 * regenerate) build it identically.
 */
function buildAssistantMessageFromResult(result, conversationId) {
  return {
    id: uuidv4(),
    conversation_id: conversationId,
    role: 'assistant',
    content: result.data.content,
    provider: result.data.provider,
    model: result.data.modelId,
    model_family: result.data.family,
    is_error: false,
    // Set only when the reply came from the hierarchical planning system
    // (src/services/brain/backendBrain.js's runHierarchicalPlan, wired in
    // via src/utils/orchestrator.js) - lets ChatScreen.js render a "View
    // Plan" chip on this specific bubble. NULL for every ordinary reply.
    plan_id: result.data.planId || null,
    // Which reasoning strategy produced this reply (see
    // src/services/reasoning/reasoningTypes.js) - chain_of_thought by
    // default, or tree_of_thought/deductive/inductive/abductive/
    // analogical/self_reflection for a reasoningRouter.js-classified
    // message, or react/hybrid_symbolic_plan for tool/browsing/plan
    // routes (see orchestrator.js's STRATEGY_FOR_ROUTE). Lets
    // ChatScreen.js render a reasoning chip on the bubble.
    reasoning_type: result.data.reasoningType || null,
    reasoning_trace: result.data.reasoningTrace || null,
    // Set only when this reply came from a time_get_current tool call -
    // lets ChatScreen.js render a live ClockWidget on this specific
    // bubble. NULL for every ordinary reply. See src/db/database.js's
    // messages migration comment for clock_data.
    //
    // NOTE: orchestrator.js's three route handlers (runChat/runBrowsing/
    // runHierarchicalPlan) never set result.data.clockData themselves,
    // so this is always null on the chat-message path today - a
    // hierarchical-plan REPLY here is always just the plan proposal
    // (backendBrain.js's runHierarchicalPlan doesn't run any steps, so
    // there's nothing to read a clock from yet). If a plan is later
    // actually run (PlanScreen.js's "Start plan" -> planStore.js's
    // startPlan() -> backendBrain.js's runApprovedPlan(), a completely
    // separate call path from this file), that result DOES carry
    // clockData (see runApprovedPlan's own comment) but today nothing
    // feeds it back into a chat message - it's only readable via
    // startPlan()'s own return value, which App.js currently discards.
    clock_data: result.data.clockData ? JSON.stringify(result.data.clockData) : null,
    // Set only when a terminal command/tool call this turn was refused
    // because it needs human confirmation - lets ChatScreen.js render an
    // "Approve this command?" card on this specific bubble. NULL for
    // every ordinary reply. See src/db/database.js's messages migration
    // comment for pending_confirmation.
    //
    // NOTE: this is toolOrchestrator.js's own pendingConfirmation/
    // approveAndRunPendingTool mechanism (used by runToolTask(), see its
    // own header comment), which - like clockData above - has no
    // producer on the chat-message path today; toolOrchestrator.js's
    // flat loop only runs as a subagent (subagentManager.js), never as
    // a top-level chat route. A risky/write call reached through
    // ordinary chat instead goes through the hierarchical-plan pipeline,
    // which has its OWN independent risk gate - a step marked is_risky
    // pauses the plan at status 'awaiting_approval' (planExecutor.js)
    // rather than producing a pending_confirmation here, and is approved
    // via PlanScreen.js/planStore.js's approveStep(), not
    // approvePendingToolCall() below. This field/action pair is real,
    // tested, and correctly wired end-to-end (see
    // approvePendingToolCall() below) - it's just currently only
    // reachable for a subagent's own confirmable call, not for an
    // ordinary top-level message.
    pending_confirmation: result.data.pendingConfirmation ? JSON.stringify(result.data.pendingConfirmation) : null,
  };
}

export const useChatStore = create((set, get) => ({
  conversationId: null,
  conversations: [], // list for the sidebar - {id, title, updated_at, ...}
  messages: [], // { id, role, content, provider, model_family, is_error, created_at }
  isSending: false,
  error: null,
  // Live browser-agent progress for the message currently being sent.
  // Reset to null at the start of every send; populated only when the
  // orchestrator's browsing branch actually runs (see sendMessage below).
  // ChatScreen can render this as a step list while isSending is true -
  // the actual live *visual* view is the PC's screenshot stream, shown by
  // BrowserAgentPiP (mounted at the App level), not routed through the
  // store.
  browsingSteps: [],
  // Live hierarchical-plan progress for the message currently being
  // sent - mirrors browsingSteps above. planProgress is the short
  // cosmetic stage label fired while the plan is being BUILT
  // (planCoordinator.js, e.g. "Breaking the goal into projects…");
  // planSteps accumulates one label per completed step while the plan
  // then RUNS (planExecutor.js). Reset to null/[] at the start of every
  // send and cleared again once the reply lands, same lifecycle as
  // browsingSteps. Previously threaded through orchestrator.js with no
  // handler on this end, so a running plan showed nothing but a generic
  // "Thinking…" spinner - see SYSTEM_COMPONENTS.md's state-management
  // section.
  planProgress: null,
  planSteps: [],
  // The in-progress reply text for the message currently being sent, while
  // it's still streaming in (see backendClient.js's onToken /
  // reasoningEngine.js's runReasoningChat). Only ever populated for the
  // CHAT route - other routes keep using their own progress state above.
  // Reset to null at the start of every send and cleared again once the
  // final assistant message is appended, same lifecycle as browsingSteps.
  streamingText: null,
  streamingThinking: null,
  // The connected BrowserAgentStream instance
  // (src/services/browserAgent/browserAgentStream.js) - talks to the
  // Playwright agent running on the person's PC. Set once via
  // setAgentSession() from wherever BrowserAgentPiP mounts (App.js) since
  // the store itself can't hold a React ref/instance directly. Held here
  // so sendMessage/editMessage/regenerateMessage can all pass the same
  // stream into the orchestrator without each needing their own plumbing
  // back up to the component tree - this is what lets one PC-side
  // session's browser state/history persist across multiple separate
  // browsing tasks within a single chat. Named agentSession (not
  // browserStream) for call-site compatibility with orchestrator.js.
  agentSession: null,
  setAgentSession(session) {
    set({ agentSession: session });
  },

  async loadConversationList() {
    const result = await getConversations(100);
    if (result.success) {
      set({ conversations: result.data });
    }
    // Silently no-op on failure - the sidebar will just show an empty list
    // rather than blocking the whole app on a listing error.
  },

  async startNewConversation() {
    const id = uuidv4();
    const result = await createConversation(id);
    if (!result.success) {
      set({ error: 'Could not start a new conversation. Please try again.' });
      return null;
    }
    set({ conversationId: id, messages: [], error: null });
    await get().loadConversationList();
    return id;
  },

  async loadConversation(conversationId) {
    const result = await getMessages(conversationId);
    if (!result.success) {
      set({ error: 'Could not load conversation history.', messages: [] });
      return;
    }
    set({ conversationId, messages: result.data, error: null });
  },

  async deleteConversation(conversationId) {
    const result = await dbDeleteConversation(conversationId);
    if (result.success) {
      const wasActive = get().conversationId === conversationId;
      set((state) => ({
        conversations: state.conversations.filter((c) => c.id !== conversationId),
        ...(wasActive ? { conversationId: null, messages: [] } : {}),
      }));
    }
    return result;
  },

  /**
   * Persists an edit to an existing user message (long-press > Edit > Save,
   * see MessageActionMenu.js) AND reprocesses the conversation from that
   * point, the way most modern chat apps handle an edit: everything after the
   * edited message is discarded (both in SQLite and in local state), the
   * edited content is saved in place with an "Edited" stamp, and the AI is
   * asked to respond again using history truncated to (and including) the
   * edited message. The new reply is appended just like a normal send.
   */
  async editMessage(messageId, newContent) {
    const trimmed = (newContent || '').trim();
    if (!trimmed) return { success: false, error: 'EMPTY_CONTENT' };

    const { conversationId, messages } = get();
    const editedIndex = messages.findIndex((m) => m.id === messageId);
    if (editedIndex === -1) return { success: false, error: 'MESSAGE_NOT_FOUND' };

    const editedMessage = messages[editedIndex];

    // 1. Save the new content in place.
    const updateResult = await dbUpdateMessage(messageId, trimmed);
    if (!updateResult.success) return updateResult;

    // 2. Truncate: drop every message after this one, both in SQLite and
    // in local state, since the conversation is being replayed from here.
    await deleteMessagesAfter(conversationId, editedMessage.created_at);

    const truncatedMessages = messages.slice(0, editedIndex + 1).map((m) =>
      m.id === messageId
        ? { ...m, content: trimmed, edited_at: updateResult.data.edited_at }
        : m
    );
    set({ messages: truncatedMessages, isSending: true, error: null, planProgress: null, planSteps: [], streamingText: null, streamingThinking: null });

    // 3. Re-run orchestration using history up to and including the edit.
    const prefs = usePreferencesStore.getState().preferences;
    const history = await assembleHistory(truncatedMessages, {
      conversationId,
      memoryEnabled: prefs.memory_enabled !== false,
      lastUserText: trimmed,
    });

    const result = await sendMessageOrchestrated({
      history,
      browserAccessEnabled: !!prefs.browser_access_enabled,
      lastMessageText: trimmed,
      agentSession: get().agentSession,
      githubUsername: prefs.github_username,
      conversationId,
      onPlanProgress: (stage) => set({ planProgress: stage }),
      onPlanStep: (label) => set((state) => ({ planSteps: [...state.planSteps, label] })),
      onToken: (text) => set({ streamingText: text }),
      onThinkingToken: (text) => set({ streamingThinking: text }),
    });

    if (result.success) {
      const assistantMessage = buildAssistantMessageFromResult(result, conversationId);
      await addMessage(assistantMessage);
      await updateConversationMeta(conversationId, {
        last_provider: result.data.provider,
        last_model: result.data.family,
      });
      set((state) => ({
        messages: [...state.messages, assistantMessage],
        isSending: false,
        planProgress: null,
        planSteps: [],
        streamingText: null,
        streamingThinking: null,
      }));
      await get().loadConversationList();
      if (prefs.memory_enabled !== false) {
        extractMemoriesFromTurn(trimmed, assistantMessage.content, conversationId)
          .catch((err) => console.error('[ChatStore] background memory extraction failed:', err));
      }
    } else {
      const errorMessage = {
        id: uuidv4(),
        conversation_id: conversationId,
        role: 'assistant',
        content: result.error?.message || 'Something went wrong. Please try again.',
        is_error: true,
      };
      await addMessage(errorMessage);
      set((state) => ({
        messages: [...state.messages, errorMessage],
        isSending: false,
        error: result.error?.message || 'Failed to get a response',
        planProgress: null,
        planSteps: [],
        streamingText: null,
        streamingThinking: null,
      }));
    }

    return { success: true };
  },

  /**
   * Regenerates an assistant reply (inline action row > regenerate icon).
   * Finds the user message immediately preceding this assistant message,
   * drops the stale reply (and anything after it, so regenerating an old
   * turn doesn't leave orphaned later messages), and re-runs orchestration
   * from that point - replacing, not appending.
   */
  async regenerateMessage(assistantMessageId) {
    const { conversationId, messages } = get();
    const assistantIndex = messages.findIndex((m) => m.id === assistantMessageId);
    if (assistantIndex === -1 || messages[assistantIndex].role !== 'assistant') {
      return { success: false, error: 'MESSAGE_NOT_FOUND' };
    }

    // Walk back to the nearest preceding user message - that's what gets re-sent.
    let userIndex = assistantIndex - 1;
    while (userIndex >= 0 && messages[userIndex].role !== 'user') userIndex -= 1;
    if (userIndex < 0) return { success: false, error: 'NO_PRIOR_USER_MESSAGE' };

    const anchorMessage = messages[userIndex];

    await deleteMessagesAfter(conversationId, anchorMessage.created_at);
    const truncatedMessages = messages.slice(0, userIndex + 1);
    set({ messages: truncatedMessages, isSending: true, error: null, planProgress: null, planSteps: [], streamingText: null, streamingThinking: null });

    const prefs = usePreferencesStore.getState().preferences;
    const history = await assembleHistory(truncatedMessages, {
      conversationId,
      memoryEnabled: prefs.memory_enabled !== false,
      lastUserText: anchorMessage.content,
    });

    const result = await sendMessageOrchestrated({
      history,
      browserAccessEnabled: !!prefs.browser_access_enabled,
      lastMessageText: anchorMessage.content,
      agentSession: get().agentSession,
      githubUsername: prefs.github_username,
      conversationId,
      onPlanProgress: (stage) => set({ planProgress: stage }),
      onPlanStep: (label) => set((state) => ({ planSteps: [...state.planSteps, label] })),
      onToken: (text) => set({ streamingText: text }),
      onThinkingToken: (text) => set({ streamingThinking: text }),
    });

    if (result.success) {
      const assistantMessage = buildAssistantMessageFromResult(result, conversationId);
      await addMessage(assistantMessage);
      await updateConversationMeta(conversationId, {
        last_provider: result.data.provider,
        last_model: result.data.family,
      });
      set((state) => ({
        messages: [...state.messages, assistantMessage],
        isSending: false,
        planProgress: null,
        planSteps: [],
        streamingText: null,
        streamingThinking: null,
      }));
      await get().loadConversationList();
      return { success: true };
    }

    const errorMessage = {
      id: uuidv4(),
      conversation_id: conversationId,
      role: 'assistant',
      content: result.error?.message || 'Something went wrong. Please try again.',
      is_error: true,
    };
    await addMessage(errorMessage);
    set((state) => ({
      messages: [...state.messages, errorMessage],
      isSending: false,
      error: result.error?.message || 'Failed to get a response',
      planProgress: null,
      planSteps: [],
      streamingText: null,
      streamingThinking: null,
    }));
    return { success: false, error: result.error };
  },

  /**
   * Toggles like/dislike on an assistant message. Tapping the already-
   * active button clears feedback (passing null); tapping the other one
   * switches it. Persisted so it survives app restarts.
   *
   * A fresh 'dislike' also fires feedbackMemory.js's aggregation
   * (fire-and-forget, never awaited - a slow/failed distillation call
   * must never make the dislike button feel unresponsive): the disliked
   * reply plus the user message that led to it are distilled into a
   * general "avoid this" instruction and folded into future prompts via
   * assembleHistory() above. Toggling dislike back off does NOT retract
   * an already-distilled pattern - same tradeoff memoryEngine.js makes
   * for extractMemoriesFromTurn (nothing un-learns a fact if the
   * triggering message is later edited/deleted either); this is a
   * background learning signal, not a 1:1 reversible log.
   */
  async setFeedback(messageId, feedback) {
    const messages = get().messages;
    const current = messages.find((m) => m.id === messageId);
    const nextFeedback = current?.feedback === feedback ? null : feedback;

    const result = await dbSetMessageFeedback(messageId, nextFeedback);
    if (result.success) {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId ? { ...m, feedback: nextFeedback } : m
        ),
      }));

      if (nextFeedback === 'dislike' && current) {
        const messageIndex = messages.findIndex((m) => m.id === messageId);
        const precedingUserMessage = messages
          .slice(0, messageIndex)
          .reverse()
          .find((m) => m.role === 'user');
        recordDislikeFeedback(precedingUserMessage?.content || '', current.content, messageId);
      }
    }
    return result;
  },

  clearError() {
    set({ error: null });
  },

  /**
   * Appends an already-persisted message straight into the live
   * `messages` array, for a message created OUTSIDE the normal
   * send/receive flow above - specifically, planStore.js's startPlan()
   * posting an "here's what got created" message once an approved plan
   * finishes running, if the person still has that plan's conversation
   * open. A no-op guard against double-appending the same row twice
   * (e.g. a fast-firing duplicate call) is intentionally NOT here - the
   * caller is expected to only call this once per real message, same
   * trust level sendMessage() itself has for its own single addMessage() call.
   */
  appendLiveMessage(message) {
    if (!message) return;
    set((state) => ({ messages: [...state.messages, message] }));
  },

  /**
   * Approves the tool call attached to a message's pending_confirmation
   * (see database.js's migration comment and toolOrchestrator.js's
   * pendingConfirmation) - the ONLY path in the app that re-invokes a
   * refused confirmable tool call, and only reachable from an explicit
   * tap on ChatScreen.js's confirmation card. Runs the exact call that
   * was refused (terminal commands re-run with confirmed: true; every
   * other WRITE_TOOL/DESTRUCTIVE_TOOL runs directly - see
   * approveAndRunPendingTool()'s own header), appends its real result as
   * a new assistant message (success or failure, never hidden either way
   * - same honesty guarantee runCommand() itself already gives), and
   * clears pending_confirmation off the original message so the card
   * doesn't linger or re-trigger.
   *
   * Covers every confirmable tool now, not just terminal commands - a
   * GitHub push, a file delete, or a generated document that got refused
   * with requiresConfirmation used to have no way to ever actually run;
   * see toolOrchestrator.js's pendingConfirmation comment for that gap.
   */
  async approvePendingToolCall(messageId) {
    const { conversationId, messages } = get();
    const message = messages.find((m) => m.id === messageId);
    if (!message?.pending_confirmation) return { success: false, error: 'NO_PENDING_CONFIRMATION' };

    let pending;
    try {
      pending = JSON.parse(message.pending_confirmation);
    } catch (err) {
      return { success: false, error: 'MALFORMED_PENDING_CONFIRMATION' };
    }

    await dbClearPendingConfirmation(messageId);
    set((state) => ({
      messages: state.messages.map((m) => (m.id === messageId ? { ...m, pending_confirmation: null } : m)),
    }));

    const result = await approveAndRunPendingTool(pending);

    // Terminal commands carry stdout/stderr; every other tool's result
    // shape varies (a created file's path, a commit SHA, etc.), so fall
    // back to the tool's own human-readable label rather than assuming
    // a terminal-shaped payload.
    const resultMessage = {
      id: uuidv4(),
      conversation_id: conversationId,
      role: 'assistant',
      content: result.success
        ? (result.data?.stdout != null
            ? `Ran it:\n\n\`\`\`\n${result.data.stdout || '(no output)'}\n\`\`\``
            : `Done: ${result.label || 'Approved and completed.'}`)
        : `That failed: ${result.error?.message || 'Unknown error'}${result.data?.stderr ? `\n\n\`\`\`\n${result.data.stderr}\n\`\`\`` : ''}`,
      is_error: !result.success,
    };
    await addMessage(resultMessage);
    set((state) => ({ messages: [...state.messages, resultMessage] }));

    return result;
  },

  /** Dismisses a pending terminal-command confirmation without running it. */
  async dismissPendingConfirmation(messageId) {
    await dbClearPendingConfirmation(messageId);
    set((state) => ({
      messages: state.messages.map((m) => (m.id === messageId ? { ...m, pending_confirmation: null } : m)),
    }));
  },

  async sendMessage(userText, attachment = null, { webSearchEnabled = false, githubToolsEnabled = false, browserAgentActive = false } = {}) {
    const trimmed = (userText || '').trim();
    if (!trimmed && !attachment) return;

    let { conversationId } = get();
    if (!conversationId) {
      conversationId = await get().startNewConversation();
      if (!conversationId) return; // conversation creation failed, error already set
    }

    // ========================================================================
    // EXPLICIT MEMORY COMMANDS - "remember this", "add this to your memory",
    // "don't forget to save this", "forget that I...". Checked before
    // anything else (attachments, orchestration) since these are handled
    // entirely locally - no model call needed, no fallback routing, just an
    // instant local write + a short confirmation reply, the way Claude
    // acknowledges "Got it, I'll remember that." See memoryEngine.js for the
    // pattern matching and storage logic. Skipped entirely if the person
    // has turned Memory off in Settings (attachments still bypass this,
    // since a memory command is text-only by definition).
    // ========================================================================
    if (!attachment && trimmed) {
      const prefsForMemory = usePreferencesStore.getState().preferences;
      if (prefsForMemory.memory_enabled !== false) {
        const memoryCommand = detectExplicitMemoryCommand(trimmed);
        if (memoryCommand) {
          const isFirstMemoryMessage = get().messages.length === 0;
          const userMemCommandMessage = {
            id: uuidv4(),
            conversation_id: conversationId,
            role: 'user',
            content: trimmed,
          };
          await addMessage(userMemCommandMessage);
          set((state) => ({
            messages: [...state.messages, userMemCommandMessage],
            isSending: true,
            error: null,
          }));

          // Same auto-title-from-first-message behavior as the normal send
          // path below - a conversation that happens to START with a
          // memory command shouldn't be left titled "New Conversation".
          if (isFirstMemoryMessage) {
            const title = trimmed.length > 60 ? `${trimmed.slice(0, 57).trim()}...` : trimmed;
            await updateConversationMeta(conversationId, { title });
          }

          const outcome = memoryCommand.type === 'remember'
            ? await handleRememberCommand(memoryCommand.payload, conversationId)
            : await handleForgetCommand(memoryCommand.payload);

          const confirmationMessage = {
            id: uuidv4(),
            conversation_id: conversationId,
            role: 'assistant',
            content: outcome.confirmation || 'Something went wrong updating my memory - please try again.',
            is_error: !outcome.success,
          };
          await addMessage(confirmationMessage);
          set((state) => ({
            messages: [...state.messages, confirmationMessage],
            isSending: false,
          }));
          await get().loadConversationList();
          return;
        }
      }
    }

    let messageContent = trimmed;
    let modelOnlyNote = null; // text meant for the model only - never shown in the person's own bubble (the attachment card/thumbnail already shows it was sent)
    let userImageLocalPath = null;
    let userAttachmentLocalPath = null;
    let userAttachmentKind = null; // 'video' | 'file'
    let userAttachmentName = null;
    let attachmentMedia = null; // { base64, mimeType, isVideo } - see buildMultimodalContent() below

    if (attachment) {
      set({ isSending: true, error: null }); // show activity immediately during extraction, which can take a moment for PDFs/ZIPs
      const result = await processAttachedFile(attachment, trimmed);

      if (result.isImage) {
        // Ox Alpha (via OpenRouter) has real vision - the image is
        // attached directly as an image_url content part (see
        // buildMultimodalContent() below, outbound-only, not persisted to
        // the DB) and the model reads/analyzes/extracts text from it
        // itself based on whatever the person's prompt asks for. No
        // separate OCR step anymore (see fileProcessor.js's processImage)
        // - one path, one source of truth for what's in the image.
        if (!result.success) {
          // The picker gave us a URI but reading it failed (bad/expired
          // content:// URI, permissions, etc.) - surface this plainly
          // rather than silently sending a text-only message that CLAIMS
          // an image was attached when it wasn't. This was the exact bug
          // where the model would reply "I don't see an image."
          set({ isSending: false, error: result.error });
          return;
        }
        userImageLocalPath = await copyAttachmentLocally(attachment);
        attachmentMedia = { base64: result.base64, mimeType: result.mimeType, isVideo: false };
        modelOnlyNote = '[The user attached an image, shown above and sent to you directly.]';
      } else if (result.isVideo) {
        if (!result.success) {
          set({ isSending: false, error: result.error });
          return;
        }
        // Persist a local copy the same way images do (copyAttachmentLocally
        // is generic - works for any file, not just images), so the video
        // shows up as a real card in the bubble and survives app restarts,
        // instead of only existing as a text note nobody can see. See
        // SentAttachmentCard.js for the rendering side.
        userAttachmentLocalPath = await copyAttachmentLocally(attachment);
        userAttachmentKind = 'video';
        userAttachmentName = attachment.name || 'video';
        attachmentMedia = { base64: result.base64, mimeType: result.mimeType, isVideo: true };
        modelOnlyNote = '[The user attached a video, sent to you directly for you to watch and understand.]';
      } else if (result.success) {
        // Generic file (zip, pdf, docx, etc.) - same local-copy treatment
        // so it stays visible as a card in the chat, on top of the
        // extracted text content block that's what actually goes to the
        // model (see formatFileContextBlock below).
        userAttachmentLocalPath = await copyAttachmentLocally(attachment);
        userAttachmentKind = 'file';
        userAttachmentName = attachment.name || 'file';
        modelOnlyNote = messageContent
          ? formatFileContextBlock(attachment.name, result)
          : `${formatFileContextBlock(attachment.name, result)}\n\nPlease look at the attached file above and let me know what you'd like to help with, or summarize/analyze it.`;
      } else {
        // Extraction failed - surface the specific reason (e.g. "sign in
        // required for PDFs", "pptx not supported yet") rather than silently
        // dropping the attachment or sending a blank message.
        set({ isSending: false, error: result.error });
        return;
      }
    }

    // The exact text the MODEL sees for this turn - note/extracted-content
    // prefix (if any) plus whatever the person actually typed. Kept
    // separate from messageContent (below), which is what's stored in the
    // DB and rendered in the person's own bubble: the note is redundant
    // once the image/video/file card is already visible in chat, and for
    // files it can be many thousands of characters of raw extracted
    // text - neither belongs cluttering the UI the person sees.
    const wireContent = modelOnlyNote
      ? (messageContent ? `${modelOnlyNote}\n\n${messageContent}` : modelOnlyNote)
      : messageContent;

    const userMessage = {
      id: uuidv4(),
      conversation_id: conversationId,
      role: 'user',
      content: messageContent,
      // Local copy of a user-attached image, if any (see
      // copyAttachmentLocally above). Persisted via the same
      // local_image_path column, so MessageBubble renders it and
      // reopening the conversation later still shows the thumbnail.
      local_image_path: userImageLocalPath,
      // Same idea for video/generic-file attachments, via the separate
      // local_attachment_path/attachment_kind/attachment_name columns -
      // see SentAttachmentCard.js for the bubble rendering.
      local_attachment_path: userAttachmentLocalPath,
      attachment_kind: userAttachmentKind,
      attachment_name: userAttachmentName,
    };

    // Optimistic local write + UI update
    const saveResult = await addMessage(userMessage);
    const isFirstMessage = get().messages.length === 0;
    set((state) => ({
      messages: [...state.messages, saveResult.data || userMessage],
      isSending: true,
      error: null,
      browsingSteps: [],
      planProgress: null,
      planSteps: [],
      streamingText: null,
      streamingThinking: null,
    }));

    // Auto-title the conversation from the first message, same pattern as
    // most chat apps - truncated, no trailing punctuation weirdness.
    if (isFirstMessage) {
      const titleSource = trimmed || attachment?.name || 'New Conversation';
      const title = titleSource.length > 60 ? `${titleSource.slice(0, 57).trim()}...` : titleSource;
      await updateConversationMeta(conversationId, { title });
      await get().loadConversationList();
    }

    const prefs = usePreferencesStore.getState().preferences;

    // Layers every prompt-injecting memory type in one place - see
    // assembleHistory() above: semantic facts (memoryEngine.js),
    // cross-conversation retrieval (retrievalMemory.js, only when this
    // message looks like a backward reference), and this conversation's
    // own rolling summary once it's long enough to need compaction
    // (workingMemory.js) - in front of the raw recent turns. Skipped/no-op
    // pieces (memory off in Settings, nothing stored yet, no recall cue,
    // conversation still short) each degrade gracefully on their own.
    const history = await assembleHistory(get().messages.concat([userMessage]), {
      conversationId,
      memoryEnabled: prefs.memory_enabled !== false,
      lastUserText: wireContent,
    });

    // The last history entry was built from userMessage.content, which is
    // the CLEAN caption (no note/extracted-file-text) - that's correct for
    // display but not for what the model needs to see. Swap in wireContent
    // here, on this ephemeral outbound copy only - never on userMessage
    // itself (already saved to the DB above as the clean caption) or on
    // anything memory/history subsystems touch, so retrievalMemory.js,
    // workingMemory.js, memoryEngine.js etc. keep working unchanged.
    if (modelOnlyNote && history.length) {
      const last = history[history.length - 1];
      history[history.length - 1] = { ...last, content: wireContent };
    }

    // Swaps the just-assembled last message's plain-string content for a
    // multimodal content-parts array when this turn has an image/video
    // attachment - same ephemeral-outbound-copy-only rule as above; only
    // backendClient.sendMessage(), which forwards history messages to
    // OpenRouter as-is, ever sees the array.
    if (attachmentMedia?.base64 && history.length) {
      const last = history[history.length - 1];
      history[history.length - 1] = {
        ...last,
        content: buildMultimodalContent(last.content, attachmentMedia),
      };
      console.log('[ChatStore] Outbound message content is multimodal (image/video part attached).');
    } else if (attachmentMedia && !attachmentMedia.base64) {
      console.warn('[ChatStore] Had an attachment but no base64 - outbound message is TEXT-ONLY. The model will not see an image.');
    }

    const result = await sendMessageOrchestrated({
      history,
      browserAccessEnabled: !!prefs.browser_access_enabled,
      browserAgentActive: !!browserAgentActive,
      webSearchEnabled: !!webSearchEnabled,
      githubToolsEnabled: !!githubToolsEnabled,
      lastMessageText: wireContent,
      // The connected BrowserAgentStream to the PC's Playwright agent
      // (src/services/browserAgent/browserAgentStream.js), set via
      // setAgentSession() from wherever BrowserAgentPiP mounts. Live
      // visual progress is the PiP's screenshot stream itself, not routed
      // through the store - onBrowserStep here is just a lightweight text
      // log (step index + action taken) for an optional "what it's doing"
      // list in ChatScreen, if the person has the PiP minimized.
      agentSession: get().agentSession,
      githubUsername: prefs.github_username,
      conversationId,
      onBrowserStep: (step) => {
        set((state) => ({ browsingSteps: [...state.browsingSteps, step] }));
      },
      // Live hierarchical-plan progress, same idea as onBrowserStep above -
      // onPlanProgress fires cosmetic stage labels while the plan is being
      // BUILT (planCoordinator.js), onPlanStep fires once per completed
      // step while it RUNS (planExecutor.js). Both threaded through
      // orchestrator.js already; this is the handler that was missing on
      // this end (see SYSTEM_COMPONENTS.md's state-management section).
      onPlanProgress: (stage) => set({ planProgress: stage }),
      onPlanStep: (label) => set((state) => ({ planSteps: [...state.planSteps, label] })),
      // Live token-by-token text for a plain CHAT reply (see
      // reasoningEngine.js's runReasoningChat) - ChatScreen renders this in
      // place of the "Thinking…" indicator while it's populated.
      onToken: (text) => set({ streamingText: text }),
      onThinkingToken: (text) => set({ streamingThinking: text }),
    });

    if (result.success) {
      const assistantMessage = buildAssistantMessageFromResult(result, conversationId);
      await addMessage(assistantMessage);
      await updateConversationMeta(conversationId, {
        last_provider: result.data.provider,
        last_model: result.data.family,
      });
      set((state) => ({
        messages: [...state.messages, assistantMessage],
        isSending: false,
        browsingSteps: [],
        planProgress: null,
        planSteps: [],
        streamingText: null,
        streamingThinking: null,
      }));

      await get().loadConversationList();

      // Fire-and-forget memory extraction - looks at this exchange and
      // stores any durable fact it finds, so future conversations (not
      // just this one) benefit from it. Never awaited: a slow or failed
      // extraction call must never delay the chat UI (see memoryEngine.js).
      if (prefs.memory_enabled !== false) {
        extractMemoriesFromTurn(wireContent, assistantMessage.content, conversationId)
          .catch((err) => console.error('[ChatStore] background memory extraction failed:', err));
      }
    } else {
      // Store a visible error message in the conversation itself so the user
      // has context on what happened, rather than a silent failure.
      const errorMessage = {
        id: uuidv4(),
        conversation_id: conversationId,
        role: 'assistant',
        content: result.error?.message || 'Something went wrong. Please try again.',
        is_error: true,
      };
      await addMessage(errorMessage);
      set((state) => ({
        messages: [...state.messages, errorMessage],
        isSending: false,
        error: result.error?.message || 'Failed to get a response',
        browsingSteps: [],
        planProgress: null,
        planSteps: [],
        streamingText: null,
        streamingThinking: null,
      }));
    }
  },
}));
