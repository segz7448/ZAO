/**
 * ZAO - Resource Planner (Planning type 5/8)
 *
 * "What do I need that I might not have?" - before executionPlanner.js
 * runs a single tool call, this module looks at the domains a plan's
 * steps touch and checks whether the preconditions those domains need
 * are actually in place: is the PC backend reachable, is a GitHub token
 * on file and valid, does the person have a PC backend path available at
 * all. This mirrors how Claude, given a task that needs a tool or
 * credential, checks availability up front rather than discovering the
 * gap three tool calls into execution and having to backtrack.
 *
 * A missing resource does not automatically fail the plan - it's
 * recorded on plan_resources (is_available: false) and surfaced in
 * PlanScreen.js as a blocker the person can act on (e.g. "connect
 * GitHub in Settings"), while any steps that don't need that resource
 * can still run. planCoordinator.js checks plan_resources before
 * starting a step whose domain maps to an unavailable resource and
 * marks that step 'blocked' (see planTypes.js's STEP_STATUS) instead of
 * letting it fail confusingly mid-tool-call.
 */

import { v4 as uuidv4 } from 'uuid';
import { checkBackendHealth } from '../backend/backendClient';
import { checkTerminalStatus } from '../terminal/terminalRouter';
import { RESOURCE_TYPES } from './planTypes';

/**
 * Which resource a step's domain generally needs - used to pick which
 * checks below are actually relevant to a given plan instead of running
 * every check for every plan.
 *
 * NOTE on 'browser': this only checks that the PC backend is reachable
 * at ALL (a coarse plan-time signal) - it deliberately does NOT gate on
 * the composer bar's browser-access preference toggle. That toggle used
 * to be treated as a hard precondition for browsing (in
 * orchestrator.js's ad-hoc chat path); it no longer is, there or here -
 * a browser-domain step only exists in a plan because
 * executionPlanner.js decided the goal genuinely needs it, and anything
 * actually risky within that (a form submit, a payment) already goes
 * through riskClassifier.js's separate approval gate. Requiring a
 * SEPARATE manual toggle on top of that would just be a forgettable
 * extra step blocking work the person already asked for. The actual
 * runtime gate for a browser step is whether a live agentSession object
 * is available when planExecutor.js's runBrowserStep() runs - that's a
 * genuine capability check (is the PC agent connected right now), not
 * something resourcePlanner.js can check at plan-creation time since the
 * session is a live object created at the App level, not a queryable
 * status like backend reachability.
 */
const DOMAIN_RESOURCE_MAP = {
  coding: ['pc_backend'],
  terminal: ['pc_backend'],
  files: [], // filesystem tool runs against the device directly - nothing external needed
  browser: ['pc_backend'],
  github: ['github_token'],
};

/**
 * Inspects a flat list of step-like objects ({ domain, ... }) and
 * returns the deduplicated set of resource keys this plan will actually
 * need, so identifyResources() only checks what's relevant.
 * @param {Array<{domain: string}>} steps
 */
function resourceKeysForSteps(steps) {
  const keys = new Set();
  for (const step of steps || []) {
    for (const key of DOMAIN_RESOURCE_MAP[step.domain] || []) {
      keys.add(key);
    }
  }
  return keys;
}

/**
 * Runs the real availability check for one resource key. Each check
 * reuses an existing status function elsewhere in the codebase rather
 * than reimplementing connectivity/auth logic - this module's job is
 * only to decide WHICH checks a plan needs and translate their results
 * into the plan_resources shape, not to own the checking logic itself.
 *
 * @param {string} key
 * @param {object} context - { githubToken } - passed in by the caller since resourcePlanner.js has no direct access to secure storage
 * @returns {Promise<{ isAvailable: boolean, details: object }>}
 */
async function checkResource(key, context) {
  switch (key) {
    case 'pc_backend': {
      const health = await checkBackendHealth();
      const terminalStatus = await checkTerminalStatus().catch(() => null);
      return {
        isAvailable: !!health.connected,
        details: {
          connected: !!health.connected,
          ready: !!health.ready,
          internetAvailable: health.internetAvailable ?? null,
          recommendation: terminalStatus?.recommendation || null,
        },
      };
    }
    case 'github_token': {
      const hasToken = !!context.githubToken;
      if (!hasToken) {
        return { isAvailable: false, details: { reason: 'No GitHub token saved in Settings.' } };
      }
      // Token presence is checked here; verifyToken() itself is a network
      // call best left to the moment execution actually needs it rather
      // than doubling GitHub API calls during planning for every plan -
      // resourcePlanner.js treats "token on file" as available and lets
      // executionPlanner.js's own error handling catch an actually-revoked
      // token as a step failure feeding into recoveryPlanner.js.
      return { isAvailable: true, details: { tokenOnFile: true } };
    }
    default:
      return { isAvailable: true, details: {} };
  }
}

const RESOURCE_LABELS = {
  pc_backend: 'PC backend connection',
  github_token: 'GitHub account connection',
};

const RESOURCE_TYPE_BY_KEY = {
  pc_backend: RESOURCE_TYPES.CONNECTION,
  github_token: RESOURCE_TYPES.CREDENTIAL,
};

/**
 * @param {Array<{domain: string}>} steps - the flat step list a plan is about to execute (from executionPlanner.js, before insertion)
 * @param {object} context - { githubToken }
 * @returns {Promise<{success: boolean, resources: Array<{id, resourceType, label, isAvailable, checkedAt, details}>, blockers: Array, error: null}>}
 */
export async function planResources(steps, context = {}) {
  const keys = resourceKeysForSteps(steps);
  const resources = [];

  for (const key of keys) {
    const { isAvailable, details } = await checkResource(key, context);
    resources.push({
      id: uuidv4(),
      resourceType: RESOURCE_TYPE_BY_KEY[key] || RESOURCE_TYPES.OTHER,
      label: RESOURCE_LABELS[key] || key,
      isAvailable,
      checkedAt: Date.now(),
      details,
    });
  }

  const blockers = resources.filter((r) => r.isAvailable === false);

  return { success: true, resources, blockers, error: null };
}

/**
 * Given the resources already checked for a plan and one step about to
 * run, decides whether that step should be allowed to start or should be
 * marked 'blocked' instead. Cheap, local, no new network calls - reuses
 * whatever planResources() already determined for the plan as a whole.
 *
 * @param {Array<{domain: string}>} planResourcesList - rows from getPlanResources()/planResources()
 * @param {{domain: string}} step
 * @returns {{ allowed: boolean, blockedBy: string|null }}
 */
export function checkStepResourceReadiness(planResourcesList, step) {
  const neededKeys = DOMAIN_RESOURCE_MAP[step.domain] || [];
  if (neededKeys.length === 0) return { allowed: true, blockedBy: null };

  for (const key of neededKeys) {
    const label = RESOURCE_LABELS[key] || key;
    const match = (planResourcesList || []).find((r) => r.label === label);
    if (match && match.is_available === 0) {
      return { allowed: false, blockedBy: label };
    }
  }
  return { allowed: true, blockedBy: null };
}
