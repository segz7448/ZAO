/**
 * ZAO - Model Configuration
 *
 * Single model, everything: chat, coding, reasoning, math, and the
 * tool-calling router all go through Qwen2.5-Coder-3B, served by the PC
 * backend (see /server and src/services/backend/backendClient.js) -
 * reachable over LAN or a Cloudflare Quick Tunnel, see Settings > Backend
 * Connection.
 *
 * No fallback chain, no task-based model switching, no on-device weights -
 * the model runs entirely on the PC backend. There's exactly one
 * "model key" left (QWEN25_CODER_3B) purely so toolOrchestrator.js and
 * memoryEngine.js - which both call
 * backendClient.sendMessage(history, modelKey, options) - didn't need
 * their call sites rewritten. (The browser agent's model calls are
 * separate - see server/browserAgent.js - since they run entirely on the
 * PC and call llama-server directly rather than through this phone-side
 * client.) The key is otherwise inert; the backend only
 * ever runs the one model it was started with (whatever MODEL_PATH in
 * server/config.js points to - this label is cosmetic/display-only and
 * won't change what actually runs).
 */

export const MODEL_KEYS = {
  QWEN25_CODER_3B: 'qwen25_coder_3b',
};

export const ACTIVE_MODEL = {
  key: MODEL_KEYS.QWEN25_CODER_3B,
  label: 'Qwen2.5 Coder 3B',
  description: 'Chat, coding, reasoning, and tool-calling - served from your PC',
};

/**
 * Task classifier - KEYWORD FALLBACK ONLY. Primary routing now goes
 * through src/services/intentClassifier.js's classifyIntent(), which
 * asks the model itself to understand what the message actually needs
 * rather than scanning for exact substrings - a request phrased any way
 * other than these specific phrases would silently misroute if this
 * were still the primary classifier. This function only runs as a
 * degraded fallback when the model call itself can't be made (backend
 * unreachable, request timed out) - see classifyIntent()'s catch block.
 * Keep the category set here in sync with classifyIntent()'s
 * ('github' | 'browsing' | 'general') even though the matching approach
 * differs, so the fallback and primary path agree on what each category
 * means.
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
