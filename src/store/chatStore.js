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
} from '../db/database';
import { sendMessageOrchestrated } from '../utils/orchestrator';
import { usePreferencesStore } from './preferencesStore';
import { processAttachedFile, formatFileContextBlock } from '../services/fileProcessor';
import { getMemorySystemMessage, extractMemoriesFromTurn, detectExplicitMemoryCommand, handleRememberCommand, handleForgetCommand } from '../services/memory/memoryEngine';

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
  // the actual live *visual* view is BrowserAgentPiP itself (mounted at
  // the App level), not a screenshot feed through the store anymore.
  browsingSteps: [],
  // The live AgentSession instance (src/services/browserAgent/agentLoop.js),
  // set once via setAgentSession() from wherever BrowserAgentPiP mounts
  // (App.js) since the store itself can't hold a React ref directly. Held
  // here so sendMessage/editMessage/regenerateMessage can all pass the
  // same session into the orchestrator without each needing their own
  // plumbing back up to the component tree - this is what lets one
  // AgentSession's browser state/history persist across multiple separate
  // browsing tasks within a single chat.
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
    set({ messages: truncatedMessages, isSending: true, error: null });

    // 3. Re-run orchestration using history up to and including the edit.
    const prefs = usePreferencesStore.getState().preferences;
    const history = truncatedMessages.map((m) => ({ role: m.role, content: m.content }));

    if (prefs.memory_enabled !== false) {
      const memoryMessage = await getMemorySystemMessage();
      if (memoryMessage) history.unshift(memoryMessage);
    }

    const result = await sendMessageOrchestrated({
      history,
      browserAccessEnabled: !!prefs.browser_access_enabled,
      lastMessageText: trimmed,
      agentSession: get().agentSession,
      githubUsername: prefs.github_username,
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
    set({ messages: truncatedMessages, isSending: true, error: null });

    const prefs = usePreferencesStore.getState().preferences;
    const history = truncatedMessages.map((m) => ({ role: m.role, content: m.content }));

    if (prefs.memory_enabled !== false) {
      const memoryMessage = await getMemorySystemMessage();
      if (memoryMessage) history.unshift(memoryMessage);
    }

    const result = await sendMessageOrchestrated({
      history,
      browserAccessEnabled: !!prefs.browser_access_enabled,
      lastMessageText: anchorMessage.content,
      agentSession: get().agentSession,
      githubUsername: prefs.github_username,
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
    }));
    return { success: false, error: result.error };
  },

  /**
   * Toggles like/dislike on an assistant message. Tapping the already-
   * active button clears feedback (passing null); tapping the other one
   * switches it. Persisted so it survives app restarts.
   */
  async setFeedback(messageId, feedback) {
    const current = get().messages.find((m) => m.id === messageId);
    const nextFeedback = current?.feedback === feedback ? null : feedback;

    const result = await dbSetMessageFeedback(messageId, nextFeedback);
    if (result.success) {
      set((state) => ({
        messages: state.messages.map((m) =>
          m.id === messageId ? { ...m, feedback: nextFeedback } : m
        ),
      }));
    }
    return result;
  },

  clearError() {
    set({ error: null });
  },

  async sendMessage(userText, attachment = null) {
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
    let userImageLocalPath = null;

    if (attachment) {
      set({ isSending: true, error: null }); // show activity immediately during extraction, which can take a moment for PDFs/ZIPs
      const result = await processAttachedFile(attachment, trimmed);

      if (result.isImage) {
        // There's no vision model anymore (Gemini removed) - the image
        // still attaches and shows as a thumbnail in the chat (per product
        // decision: camera/gallery/file attachments stay), but the model
        // can't actually see it. Tell it so in plain text rather than
        // silently sending nothing and confusing the person when the
        // reply doesn't reference the image at all.
        userImageLocalPath = await copyAttachmentLocally(attachment);
        const imageNote = "[The user attached an image, but it can't be viewed - there's no vision model available. If relevant, let them know you can't see images.]";
        messageContent = messageContent ? `${imageNote}\n\n${messageContent}` : imageNote;
      } else if (result.success) {
        const contextBlock = formatFileContextBlock(attachment.name, result);
        messageContent = messageContent
          ? `${contextBlock}\n\n${messageContent}`
          : `${contextBlock}\n\nPlease look at the attached file above and let me know what you'd like to help with, or summarize/analyze it.`;
      } else {
        // Extraction failed - surface the specific reason (e.g. "sign in
        // required for PDFs", "pptx not supported yet") rather than silently
        // dropping the attachment or sending a blank message.
        set({ isSending: false, error: result.error });
        return;
      }
    }

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
    };

    // Optimistic local write + UI update
    const saveResult = await addMessage(userMessage);
    const isFirstMessage = get().messages.length === 0;
    set((state) => ({
      messages: [...state.messages, saveResult.data || userMessage],
      isSending: true,
      error: null,
      browsingSteps: [],
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
    const history = get().messages
      .concat([userMessage])
      .map((m) => ({ role: m.role, content: m.content }));

    // Long-term memory injection - prepends a system message summarizing
    // everything ZAO remembers about the person from past conversations
    // (see src/services/memory/memoryEngine.js). Skipped entirely if the
    // person has turned memory off in Settings, or if there's nothing
    // stored yet (getMemorySystemMessage returns null in that case).
    if (prefs.memory_enabled !== false) {
      const memoryMessage = await getMemorySystemMessage();
      if (memoryMessage) {
        history.unshift(memoryMessage);
      }
    }

    const result = await sendMessageOrchestrated({
      history,
      browserAccessEnabled: !!prefs.browser_access_enabled,
      lastMessageText: messageContent,
      // The on-device AgentSession (src/services/browserAgent/agentLoop.js),
      // set via setAgentSession() from wherever BrowserAgentPiP mounts.
      // Live visual progress is the PiP itself, not a screenshot feed
      // through the store - onBrowserStep here is just a lightweight text
      // log (step index + action taken) for an optional "what it's doing"
      // list in ChatScreen, if the person has the PiP minimized.
      agentSession: get().agentSession,
      githubUsername: prefs.github_username,
      onBrowserStep: (step) => {
        set((state) => ({ browsingSteps: [...state.browsingSteps, step] }));
      },
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
      }));

      await get().loadConversationList();

      // Fire-and-forget memory extraction - looks at this exchange and
      // stores any durable fact it finds, so future conversations (not
      // just this one) benefit from it. Never awaited: a slow or failed
      // extraction call must never delay the chat UI (see memoryEngine.js).
      if (prefs.memory_enabled !== false) {
        extractMemoriesFromTurn(messageContent, assistantMessage.content, conversationId)
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
      }));
    }
  },
}));
