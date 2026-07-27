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
 * Task classifier - LOCAL FALLBACK ONLY, used exactly once: the moment
 * src/services/intentClassifier.js's real classifyIntent() model call
 * has already failed (backend unreachable, request timed out - see
 * that file's catch block). Because THAT is the situation this
 * function runs in, it cannot itself call the model to "reason
 * properly" - the whole reason it's running is that the model call
 * didn't work, so anything depending on another model call would fail
 * the exact same way and defeat the point of having a fallback at all.
 *
 * What CAN be made genuinely better without a model call: how the
 * classification itself works. The old version here matched a fixed
 * list of ~70 exact phrases ("create a folder", "delete this file",
 * "make a powerpoint" ...) - anything phrased even slightly differently
 * ("make me a folder", "can you delete that file", "I need a pdf of
 * this") silently fell through to 'general' and never got acted on.
 * This version instead parses the actual grammatical shape of the
 * request - an ACTION VERB (create/delete/update/...) applied to an
 * OBJECT TYPE (folder/file/repo/pdf/...) - the same way a person reads
 * the sentence, not a lookup table of exact strings it has to already
 * know about. This is real, local, offline understanding - a genuine
 * upgrade over string-matching, not a second AI call dressed up as one.
 *
 * GITHUB IS ITS OWN CATEGORY, DELIBERATELY SEPARATE FROM PLAIN
 * FILE/FOLDER WORK - a request to create/delete a FOLDER or FILE (no
 * GitHub language) means the PC's own filesystem (pc_fs_create_folder,
 * pc_fs_create_file, pc_fs_delete, pc_fs_edit_file - see
 * toolOrchestrator.js's TOOL_REGISTRY) and should never get routed
 * toward github_create_repo or any other github_* tool just because
 * both eventually run through the same 'github' execution-mode label
 * (see intentClassifier.js's own three-way split: 'github' is the mode
 * name for "something needs to actually be created/changed/run",
 * covering PC files AND GitHub AND terminal AND office docs - it is NOT
 * a claim that the request is about GitHub specifically). This function
 * still only needs to return one of that same three ('github' /
 * 'browsing' / 'general'), matching classifyIntent()'s contract exactly
 * - which underlying tool actually runs is executionPlanner.js's job
 * (see that file's EXECUTION_SYSTEM_PROMPT), not this classifier's.
 * GitHub-specific language (repo, branch, pull request, commit, push,
 * clone, release, PR, upstream, remote) is still detected below only so
 * a plan gets built with the right FRAMING (a GitHub action, not just
 * "some file work"), which matters for executionPlanner.js's own
 * planning quality even though both land under the same 'github' mode.
 */

// Action verbs, matched as whole words (not substrings of unrelated
// words) so this catches "make me a folder", "can you delete that
// file", "pls remove this" - any phrasing built around one of these
// verbs - not just one fixed sentence shape per verb.
const ACTION_VERBS = /\b(create|make|build|generate|write|add|new|delete|remove|erase|update|edit|modify|change|rename|move|relocate|zip|compress|unzip|extract|decompress|merge|combine|split|separate|save|export|download|clone|push|commit|open|run|execute|start|launch)\b/i;

// Object types a plain PC filesystem action targets - deliberately
// GitHub-agnostic (no "repo", "branch", etc. here at all), so
// "create a folder" or "delete that file" match ONLY this, never the
// GitHub patterns below, even though both ultimately route to the same
// 'github' execution mode label.
const FILE_OBJECT_RE = /\b(folder|directory|file|files|document|doc|zip|archive)\b/i;

// GitHub-specific nouns/phrasing - only these push a request toward the
// GitHub-flavored framing rather than plain PC file work, per the
// explicit "GitHub is very different" distinction this fallback needs
// to respect.
const GITHUB_OBJECT_RE = /\b(repo|repository|github|branch|pull request|\bpr\b|commit|push|clone|release|workflow|upstream|remote origin)\b/i;

// Office/document export formats - their own object family since they
// map to a distinct tool set (pdf_*, docx_create, xlsx_create, etc.)
// rather than plain fs_*/pc_fs_*.
const OFFICE_FORMAT_RE = /\b(pdf|docx?|word document|spreadsheet|xlsx|csv|pptx|powerpoint|slide ?deck|pitch deck|presentation)\b/i;

// Terminal/command-line phrasing.
const TERMINAL_RE = /\b(terminal|command line|shell|run this command|execute this command|npm install|npm run|pip install)\b/i;

// Genuinely needs live internet access - current info, an explicit
// site/URL, or "browse"-shaped phrasing. Kept separate from ACTION_VERBS
// above since browsing isn't a create/delete/update action on a local
// object, it's a live lookup.
const BROWSING_RE = /\b(search (?:the web|online|for)|browse|open (?:this|that|the) (?:website|site|url|link)|visit (?:this|that|the) (?:site|url|link|page)|look (?:this|that) up online|find (?:this|that|it) online|check (?:the|this) website|what does (?:this|that|the) (?:website|site|page) say|click on|fill out (?:this|the|a) form|(?:weather|news|date|time)\b.*\btoday|today'?s (?:news|weather|date)|current (?:news|price|weather|time|date)|latest (?:news|release|version)|what'?s happening|breaking news|recent news|right now\b.*\b(?:news|weather|price))\b/i;

export function classifyTask(messageText = '') {
  const text = (messageText || '').trim();
  if (!text) return 'general';

  // Browsing checked first: a message can contain an action-shaped word
  // ("check the website") without meaning "build/change/run something" -
  // live lookups are cheaper to misroute into than a full build/change
  // pipeline, matching intentClassifier.js's own "when unsure, prefer
  // browsing" tiebreaker (see that file's classifier prompt).
  if (BROWSING_RE.test(text)) return 'browsing';

  const hasVerb = ACTION_VERBS.test(text);
  const hasGithubObject = GITHUB_OBJECT_RE.test(text);
  const hasFileObject = FILE_OBJECT_RE.test(text);
  const hasOfficeFormat = OFFICE_FORMAT_RE.test(text);
  const hasTerminal = TERMINAL_RE.test(text);

  // A real create/change/run action verb applied to ANY of: a GitHub
  // object, a plain file/folder object, an office document format, or
  // terminal/command-line phrasing - all four are real "something must
  // actually be built/changed/run" requests, just with different target
  // tool families (executionPlanner.js sorts out which exact tool from
  // here - see that file's domain vocabulary: files/github/coding/
  // terminal all still share this one 'github' execution-mode label).
  if (hasVerb && (hasGithubObject || hasFileObject || hasOfficeFormat || hasTerminal)) {
    return 'github';
  }

  // GitHub/office/terminal language alone, even without a clearly
  // matched verb above (a verb list can never be exhaustive - "spin up a
  // PR", "ship this to the repo" use verbs this list doesn't have) -
  // still a real action request given how specific and rarely-casual
  // this vocabulary is outside of wanting the action done.
  if (hasGithubObject || hasTerminal) return 'github';

  return 'general';
}

export function getModelKeyForTask() {
  // Kept for call-site compatibility (orchestrator.js) - always the one model.
  return MODEL_KEYS.QWEN25_CODER_3B;
}
