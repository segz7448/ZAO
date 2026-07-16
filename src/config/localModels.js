/**
 * ZAO - Model Configuration
 *
 * Single model, everything: chat, coding, reasoning, math, and the
 * tool-calling router all go through Qwen2.5-Coder-1.5B, served by the
 * Termux backend (see /server and src/services/backend/backendClient.js).
 *
 * No fallback chain, no task-based model switching, no on-device weights -
 * the model runs entirely on the Termux server. There's exactly one
 * "model key" left (QWEN25_CODER_1_5B) purely so toolOrchestrator.js,
 * agentLoop.js, and memoryEngine.js - which all call
 * backendClient.sendMessage(history, modelKey, options) - didn't need
 * their call sites rewritten. The key is otherwise inert; the backend only
 * ever runs the one model it was started with (whatever MODEL_PATH in
 * server/config.js points to - this label is cosmetic/display-only and
 * won't change what actually runs).
 */

export const MODEL_KEYS = {
  QWEN25_CODER_1_5B: 'qwen25_coder_1_5b',
};

export const ACTIVE_MODEL = {
  key: MODEL_KEYS.QWEN25_CODER_1_5B,
  label: 'Qwen2.5 Coder 1.5B',
  description: 'Chat, coding, reasoning, and tool-calling - served from Termux',
};

/**
 * Task classifier - trimmed down. There is no more per-category model
 * routing (coding/reasoning/math/general/business all go to the same
 * model), so this now only distinguishes the categories that actually
 * change BEHAVIOR, not which model answers: 'github' (tool-orchestrator
 * tasks) and 'browsing' (on-device browser agent toggle check upstream in
 * orchestrator.js). Everything else is 'general' and goes straight to the
 * one model.
 */
export function classifyTask(messageText = '') {
  const text = messageText.toLowerCase();

  const toolTaskKeywords = [
    'push to github', 'push it to github', 'push this to github', 'commit to github',
    'create a repo', 'create a repository', 'create a github repo', 'open a pull request',
    'create a pull request', 'open a pr', 'create a branch', 'github release',
    'upload to github', 'clone the repo', 'clone this repo',
    'zip this folder', 'zip the folder', 'extract this zip', 'unzip this',
    'create a folder', 'delete this file', 'delete this folder', 'move this file',
    'rename this file', 'rename this folder', 'save this to my phone',
    'save this to my device', 'save to storage', 'create these files',
    'make this a pdf', 'create a pdf', 'save as pdf', 'export as pdf',
    'merge these pdfs', 'merge pdfs', 'combine these pdfs', 'split this pdf',
    'split the pdf', 'create a word document', 'make this a word doc',
    'save as docx', 'create a docx', 'create a spreadsheet', 'save as xlsx',
    'create a xlsx', 'make this a spreadsheet', 'export as csv', 'save as csv',
    'create a csv', 'create a presentation', 'make a powerpoint',
    'create a pptx', 'save as pptx', 'make a slide deck', 'create a pitch deck',
    'run this command', 'run in terminal', 'execute this command',
  ];
  const browsingKeywords = [
    'search the web', 'search online', 'browse', 'open this website', 'open this site',
    'visit this site', 'visit this url', 'look this up online', 'find on the web',
    'check the website', 'download the', 'latest release', 'current price of',
    'what does this website say', 'click on', 'fill out the form',
    'news today', "today's news", 'latest news', "what's happening", 'current events',
    'what happened today', 'recent news', 'breaking news',
  ];

  if (toolTaskKeywords.some((k) => text.includes(k))) return 'github';
  if (browsingKeywords.some((k) => text.includes(k))) return 'browsing';
  return 'general';
}

export function getModelKeyForTask() {
  // Kept for call-site compatibility (orchestrator.js) - always the one model.
  return MODEL_KEYS.QWEN25_CODER_3B;
}
