/**
 * ZAO - Orchestrator
 *
 * The single entry point the UI calls to "send a message and get a
 * response." Everything text-based goes to the one Qwen2.5-Coder-1.5B model
 * served by the Termux backend (src/services/backend/backendClient.js) -
 * no manual mode, no fallback chain, no per-task model switching.
 *
 * There is no image generation, image editing, or vision/OCR anymore
 * (Gemini removed per product decision) - an attached image is passed
 * through as a plain attachment (see chatStore.js/AttachmentSheet) but is
 * not "read" by the model; camera/gallery/file attachments still work for
 * sending files INTO tool tasks (e.g. "zip this file", "push this to
 * GitHub"), just not for visual understanding.
 *
 * Contract: sendMessageOrchestrated() NEVER throws. It always resolves to a
 * result object. The UI only needs to handle one shape.
 */

import { logUsageEvent } from '../db/database';
import {
  classifyTask,
  getModelKeyForTask,
  ACTIVE_MODEL,
} from '../config/localModels';
import * as backendClient from '../services/backend/backendClient';
import { runGithubTask } from '../services/toolOrchestrator';

/**
 * @param {object} params
 * @param {Array<{role, content}>} params.history - full conversation so far, including the new user message
 * @param {string} [params.lastMessageText] - used for task classification
 * @param {boolean} [params.browserAccessEnabled] - gates the on-device browser agent. When
 *   false (default), browsing-classified messages fall straight through to normal
 *   chat routing - the person must explicitly turn on the composer bar's globe
 *   toggle to allow live web access.
 * @param {object} [params.agentSession] - the live AgentSession instance (src/services/browserAgent/agentLoop.js),
 *   created once at the App level and held for the lifetime of the browser-agent PiP
 *   so a session's browser state/history survives across multiple separate tasks in
 *   the same conversation.
 * @param {function} [params.onBrowserStep] - callback fired per completed browser-agent step
 * @param {string} [params.githubUsername] - hint passed to the tool orchestrator so the coder model
 *   doesn't have to ask "whose account?" on every request
 * @param {function} [params.onGithubStep] - callback fired per completed tool-orchestrator step
 *
 * @returns {Promise<{
 *   success: boolean,
 *   data: { content: string, family: string, provider: string, modelId: string } | null,
 *   error: { type: string, message: string } | null,
 * }>}
 */
export async function sendMessageOrchestrated({
  history,
  lastMessageText = '',
  browserAccessEnabled = false,
  agentSession = null,
  onBrowserStep = null,
  githubUsername = null,
  onGithubStep = null,
}) {
  try {
    if (!Array.isArray(history) || history.length === 0) {
      return {
        success: false,
        data: null,
        error: { type: 'BAD_REQUEST', message: 'No conversation history provided' },
      };
    }

    const detectedTask = classifyTask(lastMessageText);

    // ========================================================================
    // TOOL ORCHESTRATOR (GitHub + Filesystem + Terminal + PDF + Office) -
    // checked before the browser toggle and normal chat routing.
    // ========================================================================
    if (detectedTask === 'github') {
      const githubResult = await runGithubTask(lastMessageText, githubUsername, onGithubStep);

      if (githubResult.success) {
        return {
          success: true,
          data: {
            content: githubResult.answer,
            family: ACTIVE_MODEL.key,
            provider: 'local-backend',
            modelId: ACTIVE_MODEL.label,
            toolStepsCompleted: githubResult.stepsCompleted,
          },
          error: null,
        };
      }

      return {
        success: false,
        data: null,
        error: githubResult.error || { type: 'UNKNOWN', message: 'Tool task failed.' },
      };
    }

    // ========================================================================
    // ON-DEVICE BROWSER AGENT - checked before normal chat routing. Once the
    // person has explicitly turned on the composer bar's globe/browser-
    // access toggle, every message goes here - short-circuits the whole
    // normal chat-completion path.
    // ========================================================================
    if (browserAccessEnabled) {
      if (agentSession) {
        const agentResult = await agentSession.runTask(lastMessageText, {
          onStep: (stepInfo) => onBrowserStep?.(stepInfo),
        });

        if (agentResult.success) {
          logUsageEvent('browser_session', lastMessageText.slice(0, 80), { stepsUsed: agentResult.stepsUsed }).catch(() => {});
          return {
            success: true,
            data: {
              content: agentResult.answer,
              family: ACTIVE_MODEL.key,
              provider: 'local-backend',
              modelId: ACTIVE_MODEL.label,
              browserStepsUsed: agentResult.stepsUsed,
            },
            error: null,
          };
        }

        if (agentResult.needsHuman) {
          return {
            success: false,
            data: null,
            error: { type: 'NEEDS_HUMAN', message: agentResult.reason },
          };
        }

        return {
          success: false,
          data: null,
          error: {
            type: agentResult.error?.type || 'BROWSER_AGENT_ERROR',
            message: agentResult.error?.message || 'Browser agent task failed.',
          },
        };
      }
      // No session yet (PiP not mounted) - fall through to normal routing below.
    }

    // ========================================================================
    // NORMAL CHAT COMPLETION - the one Qwen2.5-Coder-1.5B model, served by the
    // Termux backend. No fallback: a failure here (backend unreachable,
    // model still loading, inference error) is a real failure and is
    // surfaced to the person as such.
    // ========================================================================
    const modelKey = getModelKeyForTask(detectedTask);

    const result = await backendClient.sendMessage(history, modelKey, { maxTokens: 1024, temperature: 0.7 });

    if (result.success) {
      return {
        success: true,
        data: {
          content: result.data.content,
          family: modelKey,
          provider: 'local-backend',
          modelId: ACTIVE_MODEL.label,
        },
        error: null,
      };
    }

    return {
      success: false,
      data: null,
      error: result.error || { type: 'UNKNOWN', message: 'Backend failed to respond.' },
    };
  } catch (err) {
    // Absolute last-resort catch. The UI should never see an uncaught exception
    // from this function, no matter what goes wrong internally.
    console.error('[Orchestrator] Unexpected error:', err);
    return {
      success: false,
      data: null,
      error: { type: 'UNKNOWN', message: 'Something went wrong. Please try again.' },
    };
  }
}
