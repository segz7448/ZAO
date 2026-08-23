/**
 * ZAO - Recovery Planner (Planning type 6/8)
 *
 * "What do I do if a step fails?" - not every failure means the plan is
 * dead. A network hiccup deserves a retry; a wrong assumption deserves a
 * different approach; a genuinely blocked step deserves a human's input
 * rather than the executor guessing forever. This mirrors how Claude
 * handles a failed tool call: it doesn't treat every failure as fatal,
 * but it also doesn't blindly retry the exact same thing indefinitely -
 * it reads the error, picks a proportionate response, and escalates if
 * that response doesn't work either.
 *
 * ESCALATION LADDER (least to most drastic - see RECOVERY_STRATEGIES in
 * planTypes.js, which this module's ordering matches exactly):
 *   1. retry                - transient-looking error, first failure, try again as-is
 *   2. retry_with_backoff   - transient-looking error, already failed once, wait then retry
 *   3. alternate_approach   - same error twice, or a non-transient error - ask the model for a different way to do this one step
 *   4. skip_and_continue    - the step is non-critical (nothing else in the plan depends on it) and has failed multiple times
 *   5. ask_person           - the step is risky, or critical (other steps depend on it), or every automated option above has been exhausted
 *   6. abort_plan           - a resource the whole plan depends on is gone, or the person explicitly cancels
 *
 * This module decides the STRATEGY; it doesn't execute retries itself -
 * planCoordinator.js's executor loop calls back in here after every step
 * failure, gets a strategy, and acts on it (re-running the step,
 * re-planning just that step via executionPlanner.js's single-step
 * mode, marking it skipped, or flipping the plan to awaiting_approval /
 * failed).
 */

import { v4 as uuidv4 } from 'uuid';
import * as modelClient from '../backend/backendClient';
import { MODEL_KEYS } from '../../config/localModels';
import { RECOVERY_STRATEGIES } from './planTypes';

const MAX_AUTO_RETRIES = 2; // after this many automated attempts on one step, recovery always escalates to ask_person rather than looping forever
const BACKOFF_MS_BASE = 1500;

/** Rough heuristic for "does this error look like it might just work if we tried again" vs "this will fail identically every time." Deliberately simple string matching - recoveryPlanner.js only needs a coarse signal, not a full error taxonomy. */
const TRANSIENT_ERROR_PATTERNS = [
  /timeout/i,
  /timed out/i,
  /network/i,
  /econnrefused/i,
  /econnreset/i,
  /rate.?limit/i,
  /429/,
  /5\d\d/, // 5xx server errors
  /unreachable/i,
  /temporarily/i,
];

function looksTransient(errorMessage) {
  const text = errorMessage || '';
  return TRANSIENT_ERROR_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * "The tool genuinely isn't installed" is a DIFFERENT category from
 * "transient" - no amount of retrying or command-syntax rewriting fixes
 * it, only installing the thing does. Detected separately so
 * planRecovery() can skip straight to an install-based alternate
 * approach instead of burning an attempt on a syntax variant of a
 * command that can never succeed as-is.
 *
 * Matches the standard "not found"/"not recognized" shapes bash, cmd.exe,
 * and PowerShell each produce for a missing binary.
 */
const MISSING_TOOL_PATTERNS = [
  /command not found/i,
  /is not recognized as an internal or external command/i, // Windows cmd.exe
  /not found: [^\s]+$/i,
  /no such file or directory/i,
  /ENOENT/, // Node's own "executable not found" shape
];

function looksLikeMissingTool(errorMessage) {
  const text = errorMessage || '';
  return MISSING_TOOL_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * The same "genuinely missing, no amount of retrying fixes it" category
 * as looksLikeMissingTool, but for a FILES-domain existence/precondition
 * check rather than a terminal command - e.g. a "check if the installer
 * exists" step whose result is simply false. This is NOT an error in the
 * traditional sense (the check itself succeeded, it just found "no") -
 * but plan_steps only has a success/fail shape, so a negative existence
 * check surfaces here as a failed step. Broader wording on purpose since
 * these messages come from ZAO's own fs tools/model phrasing, not a
 * fixed shell error format - scoped to step.domain === 'files' so it
 * doesn't accidentally swallow unrelated failures from other domains.
 */
const MISSING_RESOURCE_PATTERNS = [
  /does not exist/i,
  /doesn'?t exist/i,
  /not found/i,
  /no such file/i,
  /missing/i,
  /not installed/i,
  /could not (find|locate)/i,
];

function looksLikeMissingResource(step, errorMessage) {
  if (step.domain !== 'files') return false;
  const text = errorMessage || '';
  return MISSING_RESOURCE_PATTERNS.some((pattern) => pattern.test(text));
}

/**
 * Pulls the missing binary's name out of the error text where possible,
 * so the install-command guess (INSTALL_HINTS below) and the fallback
 * alternateDescription can name the actual tool instead of a generic
 * "install the missing dependency" - e.g. "bash: line 1: gh: command not
 * found" -> "gh".
 */
function extractMissingToolName(errorMessage, step) {
  const text = errorMessage || '';
  const bashMatch = text.match(/bash:.*?line \d+:\s*([^\s:]+):\s*command not found/i)
    || text.match(/([^\s:]+):\s*command not found/i);
  if (bashMatch) return bashMatch[1];
  const winMatch = text.match(/'([^']+)' is not recognized/i);
  if (winMatch) return winMatch[1];
  // FILES-domain existence checks don't have a shell error to parse a
  // name out of - the step's own description/target is the only signal
  // ("Check if the Python installer file exists" -> "python").
  const descriptionMatch = (step.description || '').match(/\b(python3?|node(?:\.?js)?|npm|pip3?|git|java|go|rustc?|cargo|ffmpeg|docker|ruby|perl|php|gcc|g\+\+|make|cmake)\b/i);
  if (descriptionMatch) return descriptionMatch[1].toLowerCase();
  // Fall back to the step's own command/target if the error text didn't
  // yield a clean name - better than nothing for the install guess.
  const fallback = (step.command || step.target || '').trim().split(/\s+/)[0];
  return fallback || null;
}

/**
 * The fixed 4-step loop this whole change exists to enforce: check ->
 * (if missing) install with elevated/admin privileges -> set PATH
 * persistently (not just for the current shell session, which is why
 * "set then immediately re-check in the same process" can lie) -> echo/
 * verify PATH actually picked it up -> only then hand back to the
 * original step. Written OS-conditionally in the instruction text
 * itself (rather than requiring a separately-detected OS field threaded
 * through the plan) since the model executing this with hostAccess:true
 * already has to run a real shell and can branch on what it finds.
 */
function buildAutoInstallDescription(toolName) {
  const name = toolName || 'the required tool';
  const knownHint = toolName && INSTALL_HINTS[toolName] ? INSTALL_HINTS[toolName] : null;
  const installStep = knownHint
    ? `Install it now, with hostAccess: true and administrator/elevated privileges: ${knownHint}`
    : `Install it now, with hostAccess: true and administrator/elevated privileges, using whichever package manager matches this machine: apt-get/yum/dnf on Linux (sudo apt-get update && sudo apt-get install -y ${name}), winget or choco on Windows (winget install -e --id <package> --accept-package-agreements --accept-source-agreements, run elevated), Homebrew on macOS (brew install ${name}), or pkg on Termux (pkg install ${name} -y). Pick the one that matches the OS this step is actually running on.`;
  return `'${name}' isn't present. Do NOT stop and ask - resolve it automatically in one pass:\n`
    + `1. ${installStep}\n`
    + `2. Set PATH persistently (append to the shell profile / system PATH, not just the current session's env var) so it survives into the next command's own subprocess.\n`
    + `3. Verify: echo the PATH (or re-run '${name} --version' / 'where ${name}' / 'which ${name}') in a fresh shell call to confirm it actually resolved, not just that the install command exited 0.\n`
    + `4. Once verified, continue on to the original step this was blocking.`;
}

/** Best-effort install command for a handful of tools ZAO's own tasks
 * commonly hit (GitHub CLI chief among them, per the case this was built
 * for). Anything not in this list still gets ALTERNATE_APPROACH with
 * hostAccess: true - the model just has to name the install command
 * itself (e.g. via apt-get/pip/npm) rather than getting a canned one. */
const INSTALL_HINTS = {
  gh: 'curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /tmp/ghkey.gpg && sudo apt-get update && sudo apt-get install -y gh || (curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg && sudo chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null && sudo apt-get update && sudo apt-get install -y gh)',
};

/**
 * Decides the recovery strategy for one failed step. Pure/cheap first
 * (no model call) for the common cases - first-time transient failure,
 * or a step that's already hit MAX_AUTO_RETRIES - since those don't need
 * judgment. Only calls the model for the genuinely ambiguous middle case:
 * a non-transient failure where an alternate approach might exist.
 *
 * @param {object} step - the failed plan_steps row, plus { hasDependents: boolean } indicating whether other pending steps depend on this one
 * @param {object} options - { previousAttempts: Array<{strategy, outcome}>, isRisky: boolean }
 * @returns {Promise<{ strategy: string, reasoning: string, waitMs: number|null, alternateAction: object|null }>}
 */
export async function planRecovery(step, options = {}) {
  const { previousAttempts = [], isRisky = false, permissionMode = 'default' } = options;
  const attemptCount = previousAttempts.length;
  const transient = looksTransient(step.error_message || step.errorMessage);
  const hasDependents = !!step.hasDependents;
  const isAutoMode = permissionMode === 'auto' || permissionMode === 'bypassPermissions';

  // Already exhausted automated attempts. In auto mode there's no person
  // to hand this to - fail forward instead of stalling: drop it if
  // nothing depends on it, otherwise the plan genuinely can't continue
  // and should say so rather than sit at a silent approval screen.
  if (attemptCount >= MAX_AUTO_RETRIES) {
    if (isAutoMode) {
      return hasDependents
        ? { strategy: RECOVERY_STRATEGIES.ABORT_PLAN, reasoning: `This step failed ${attemptCount} time(s) and other steps depend on it - auto mode can't proceed without it.`, waitMs: null, alternateAction: null }
        : { strategy: RECOVERY_STRATEGIES.SKIP_AND_CONTINUE, reasoning: `This step failed ${attemptCount} time(s); nothing else depends on it, so continuing without it.`, waitMs: null, alternateAction: null };
    }
    return {
      strategy: RECOVERY_STRATEGIES.ASK_PERSON,
      reasoning: `This step has failed ${attemptCount} time(s) already - stopping automated retries and asking for your input rather than looping.`,
      waitMs: null,
      alternateAction: null,
    };
  }

  // A risky step that failed normally comes back to the person - but in
  // an auto/bypassPermissions mode there's no gate to begin with (the
  // executor's own risk check upstream already skipped it), so failures
  // on it get the same automated treatment as any other step instead of
  // an approval pause that mode was specifically turned on to avoid.
  if (isRisky && !isAutoMode) {
    return {
      strategy: RECOVERY_STRATEGIES.ASK_PERSON,
      reasoning: 'This step is marked risky - failures on risky steps need your review rather than an automatic retry.',
      waitMs: null,
      alternateAction: null,
    };
  }

  // "Command not found" is never transient and never fixed by rephrasing
  // the same call - only installing the tool fixes it. Skip straight to
  // an install-based alternate approach (using the VM's real filesystem/
  // network via hostAccess: true, since an install run inside the
  // ephemeral sandbox container is destroyed the moment that command
  // finishes and never reaches the next command) rather than burning an
  // automated attempt on a syntax variant that can't possibly work.
  const errMsg = step.error_message || step.errorMessage;
  const missingTool = !transient && looksLikeMissingTool(errMsg);
  const missingResource = !transient && !missingTool && looksLikeMissingResource(step, errMsg);
  if (missingTool || missingResource) {
    const toolName = extractMissingToolName(errMsg, step);
    return {
      strategy: RECOVERY_STRATEGIES.ALTERNATE_APPROACH,
      reasoning: `'${toolName || 'the dependency'}' isn't present on the VM - installing it automatically (with real host/admin access) instead of retrying or stopping to ask.`,
      waitMs: null,
      alternateAction: { description: buildAutoInstallDescription(toolName) },
    };
  }

  if (transient && attemptCount === 0) {
    return {
      strategy: RECOVERY_STRATEGIES.RETRY,
      reasoning: 'The error looks transient (network/timeout/rate-limit) - retrying as-is.',
      waitMs: null,
      alternateAction: null,
    };
  }

  if (transient && attemptCount === 1) {
    return {
      strategy: RECOVERY_STRATEGIES.RETRY_WITH_BACKOFF,
      reasoning: 'Still looks transient after one retry - waiting briefly before trying again in case the underlying issue (rate limit, brief outage) needs a moment to clear.',
      waitMs: BACKOFF_MS_BASE * Math.pow(2, attemptCount),
      alternateAction: null,
    };
  }

  // Non-transient, or transient but already retried with backoff once -
  // this is the genuinely ambiguous case. Ask the model whether a
  // different concrete approach exists for this one step, or whether the
  // step is safe to skip (nothing depends on it) vs needs a person.
  const modelDecision = await askModelForRecoveryStrategy(step, { hasDependents, attemptCount, isAutoMode });
  return modelDecision;
}

async function askModelForRecoveryStrategy(step, { hasDependents, attemptCount, isAutoMode = false }) {
  const systemPrompt = `You are ZAO's recovery planner. One plan step failed and simple retries haven't resolved it (or don't look like they would). Decide what should happen next.

Options, in order of preference:
- "alternate_approach": if you can suggest a genuinely different way to accomplish the SAME step's goal (different tool, different command, different target), which might avoid whatever caused the failure. Only choose this if you have a concrete alternative in mind - describe it in "alternateDescription".
- "skip_and_continue": ONLY if nothing else in the plan depends on this step succeeding (hasDependents is false) and skipping it wouldn't undermine the plan's goal.
- "ask_person": if the failure suggests a real decision or missing information only the person can supply (e.g. ambiguous requirements, a missing credential, a genuinely destructive edge case).

Respond with ONLY a JSON object, no markdown fences, no commentary:
{ "strategy": "alternate_approach" | "skip_and_continue" | "ask_person", "reasoning": "one sentence", "alternateDescription": "only if strategy is alternate_approach - a concrete different way to do this step" }`;

  const userContent = `Step: ${step.description}\nDomain: ${step.domain}\nAction: ${step.action || 'n/a'}\nTarget: ${step.target || 'n/a'}\nError: ${step.error_message || step.errorMessage || 'unknown error'}\nAttempts so far: ${attemptCount}\nOther pending steps depend on this one: ${hasDependents}`;

  const history = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userContent },
  ];

  const modelResult = await modelClient.sendMessage(history, MODEL_KEYS.QWEN3_CODER_30B_A3B, {
    maxTokens: 300,
    temperature: 0.3,
  });

  const parsed = modelResult.success && modelResult.data?.content ? safeParseRecoveryJson(modelResult.data.content) : null;

  if (parsed?.strategy === RECOVERY_STRATEGIES.SKIP_AND_CONTINUE && !hasDependents) {
    return {
      strategy: RECOVERY_STRATEGIES.SKIP_AND_CONTINUE,
      reasoning: parsed.reasoning || 'Nothing else in the plan depends on this step - skipping it and continuing.',
      waitMs: null,
      alternateAction: null,
    };
  }

  if (parsed?.strategy === RECOVERY_STRATEGIES.ALTERNATE_APPROACH && parsed.alternateDescription) {
    return {
      strategy: RECOVERY_STRATEGIES.ALTERNATE_APPROACH,
      reasoning: parsed.reasoning || 'Trying a different approach to the same step.',
      waitMs: null,
      alternateAction: { description: parsed.alternateDescription },
    };
  }

  // Default/fallback: if the model call failed, returned something
  // unparseable, or genuinely picked ask_person, normally that's safe to
  // hand to the person. In auto mode there's no one to hand it to, so
  // fail forward instead of stalling at an approval screen that mode was
  // turned on specifically to avoid: drop the step if nothing depends on
  // it, otherwise abort the plan with a clear reason.
  if (isAutoMode) {
    return hasDependents
      ? { strategy: RECOVERY_STRATEGIES.ABORT_PLAN, reasoning: parsed?.reasoning || 'This step could not be resolved automatically and other steps depend on it.', waitMs: null, alternateAction: null }
      : { strategy: RECOVERY_STRATEGIES.SKIP_AND_CONTINUE, reasoning: parsed?.reasoning || 'This step could not be resolved automatically; nothing else depends on it, so continuing without it.', waitMs: null, alternateAction: null };
  }

  return {
    strategy: RECOVERY_STRATEGIES.ASK_PERSON,
    reasoning: parsed?.reasoning || 'This step needs your input to move forward.',
    waitMs: null,
    alternateAction: null,
  };
}

function safeParseRecoveryJson(rawContent) {
  try {
    const cleaned = rawContent.replace(/```json/gi, '').replace(/```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (err) {
    return null;
  }
}

/**
 * Builds the plan_recovery_attempts row shape for a decision returned by
 * planRecovery() - a thin helper so planCoordinator.js doesn't
 * hand-assemble this object inline at every call site.
 */
export function buildRecoveryAttemptRecord(planId, stepId, attemptNumber, decision) {
  return {
    id: uuidv4(),
    planId,
    stepId,
    attemptNumber,
    strategy: decision.strategy,
    reasoning: decision.reasoning,
  };
}
