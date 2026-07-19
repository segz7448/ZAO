/**
 * ZAO - Risk Classifier
 *
 * Single shared source of truth for "does this step need the person's
 * approval before running, or can it auto-run?" - used by every planner
 * in src/services/planning/ (executionPlanner.js at plan-creation time,
 * and planStore.js's Phase-1-compatible createPlanFromSteps() for any
 * caller still handing in a pre-built step list directly) so the rule
 * never drifts between them. A step is risky ONLY if it's irreversible -
 * per Zenas's explicit call: installs, new-file creation, reads,
 * non-destructive git operations, and pre-submit browser actions are all
 * safe to auto-run. Anything that destroys existing state or can't be
 * undone needs a person's eyes on it first.
 *
 * ACTION NAME MATCHING: this module has to work whether `step.action` is
 * a real TOOL_REGISTRY function name (e.g. 'fs_delete',
 * 'github_create_release', 'terminal_pc_run_command' -
 * executionPlanner.js's vocabulary, matching toolOrchestrator.js exactly)
 * or a shorter domain-generic action string (e.g. 'delete', 'delete_repo'
 * - what an external caller of planStore.js's Phase 1
 * createPlanFromSteps() might still pass directly). Rather than keeping
 * two exact-match Sets in sync with both vocabularies forever, matching
 * below is substring/pattern based against the lowercased action name
 * (and, for terminal steps, the command text wherever it actually lives -
 * step.target OR step.details.command, since executionPlanner.js puts
 * the literal command in `target`).
 *
 * RISKY (needs approval):
 *   - Deleting anything: files, folders, DB rows/tables, GitHub
 *     repos/branches/releases
 *   - git push / force-push (rewrites remote state others may depend on)
 *   - Any payment/purchase action in a browser
 *   - Overwriting a file that already exists with different content (the
 *     old content is gone - same class of harm as a delete)
 *
 * SAFE (auto-run):
 *   - Installs (npm install, pip install, etc.)
 *   - Creating a new file (nothing existed before, nothing lost)
 *   - git add / commit / pull / clone (local or additive, not destructive)
 *   - Reading, navigating, clicking, filling forms (pre-submit) in a
 *     browser
 *   - Terminal commands that build/compile/run without deleting
 *
 * This module only classifies - it does not itself pause or execute
 * anything. Callers (planExecutor.js's runExecutionPlan()) check
 * classifyStep().risky and act on it.
 */

// Terminal command patterns that count as destructive/irreversible.
// Checked as whole-word-ish substring matches against the lowercased
// command string - deliberately simple regexes rather than a full shell
// parser, since false positives here just mean "asked for approval when
// it wasn't strictly needed" (annoying but safe), while false negatives
// mean "ran something destructive without asking" (the actually dangerous
// direction to get wrong). When in doubt, this errs toward flagging risky.
//
// SINGLE SOURCE OF TRUTH: this list now lives in
// src/services/terminal/commandSafety.js and is re-exported here, since
// pcTerminalTool.js/termuxTerminalTool.js also need it (to gate the raw
// tool call itself, for the flat toolOrchestrator.js loop that never
// goes through this planner-side classifier at all) and two copies of
// "which commands are destructive" drifting apart is exactly the kind of
// bug that's invisible until it isn't.
import { RISKY_TERMINAL_PATTERNS } from '../terminal/commandSafety';

// Filesystem action-name FRAGMENTS that count as destructive regardless
// of the target - matched as substrings against the lowercased action so
// this catches both TOOL_REGISTRY's real names (fs_delete) and any
// shorter action string a direct createPlanFromSteps() caller might pass
// (delete, delete_folder, remove).
const RISKY_FILESYSTEM_ACTION_FRAGMENTS = ['delete', 'remove'];

// GitHub action-name fragments that delete/force-modify remote state -
// matches both TOOL_REGISTRY names (github_create_release is NOT
// matched, only actual delete/force actions) and shorter forms
// (delete_repo, force_push).
const RISKY_GITHUB_ACTION_FRAGMENTS = ['delete', 'force_push', 'force-push'];

// Browser actions that count as risky regardless of which site they're on -
// submitting a form (data leaves the draft state, may not be undoable) and
// anything explicitly tagged as a payment step. download is included
// cautiously - it writes a new file to a real path, and a payment
// receipt/contract download is common enough to warrant a heads-up even
// though it's not itself destructive.
const RISKY_BROWSER_ACTION_FRAGMENTS = ['submit', 'download', 'purchase', 'checkout', 'pay'];

/**
 * @param {object} step - one plan step, shape: { domain, action, target, details }
 *   domain: 'terminal' | 'files' | 'browser' | 'github'
 *   action: the specific action name/command for that domain
 *   target: what it acts on (file path, url, repo name) - used for the
 *     "overwriting an existing file" check
 *   details: free-form extra info (e.g. { command: '...' } for terminal,
 *     { fileExists: true/false } for files, { isPayment: true/false } for
 *     browser)
 * @returns {{ risky: boolean, reason: string|null }}
 */
function classifyStep(step) {
  if (!step || !step.domain) {
    return { risky: false, reason: null };
  }

  const action = (step.action || '').toLowerCase();

  switch (step.domain) {
    case 'terminal':
    case 'coding': {
      // The literal command text can live in details.command (an older
      // caller's shape) OR in target (executionPlanner.js's shape, where
      // `target` holds "what this step acts on" - for a terminal step,
      // that's the command itself). Check both, and action last as a
      // final fallback for a caller that put it there instead.
      const command = (step.details?.command || step.target || action || '').toLowerCase();
      for (const pattern of RISKY_TERMINAL_PATTERNS) {
        if (pattern.test(command)) {
          return { risky: true, reason: `This command looks irreversible (${describeTerminalMatch(command)}) - approve before running it.` };
        }
      }
      return { risky: false, reason: null };
    }

    case 'files': {
      if (RISKY_FILESYSTEM_ACTION_FRAGMENTS.some((fragment) => action.includes(fragment))) {
        return { risky: true, reason: `This deletes ${step.target || 'a file/folder'} - approve before running it.` };
      }
      // Overwriting an existing file with different content is treated the
      // same as a delete, since the old content is unrecoverable. Relies
      // on the caller supplying details.fileExists - executionPlanner.js
      // doesn't currently probe the filesystem at plan time to know this,
      // so this check is a hook for a caller that does have that
      // information (e.g. a re-plan after seeing a real directory
      // listing), not yet populated by the default pipeline.
      if (step.details?.fileExists && (action.includes('create') || action.includes('write'))) {
        return { risky: true, reason: `This overwrites the existing file ${step.target || ''} - approve before running it.` };
      }
      return { risky: false, reason: null };
    }

    case 'github': {
      if (RISKY_GITHUB_ACTION_FRAGMENTS.some((fragment) => action.includes(fragment))) {
        return { risky: true, reason: `This ${describeGithubAction(action)} on ${step.target || 'the repo'} - approve before running it.` };
      }
      const command = (step.details?.command || step.target || '').toLowerCase();
      if (/\bgit\s+push\b/.test(command) && !/\bgit\s+push\s+origin\s+--delete\b/.test(command)) {
        return { risky: true, reason: 'This pushes to the remote repo - approve before running it.' };
      }
      return { risky: false, reason: null };
    }

    case 'browser': {
      if (step.details?.isPayment) {
        return { risky: true, reason: 'This step involves a payment - approve before it runs.' };
      }
      if (RISKY_BROWSER_ACTION_FRAGMENTS.some((fragment) => action.includes(fragment))) {
        return { risky: true, reason: `This ${action.includes('submit') ? 'submits a form' : action.includes('download') ? 'downloads a file' : 'involves a payment/checkout step'} - approve before it runs.` };
      }
      return { risky: false, reason: null };
    }

    default:
      // Unknown domain - default to safe rather than blocking on
      // something the classifier doesn't understand yet. Planners
      // should always set a recognized `domain`; this is a fallback, not
      // the expected path.
      return { risky: false, reason: null };
  }
}

function describeTerminalMatch(command) {
  if (/\bgit\s+push\b/.test(command)) return 'git push';
  if (/\brm\s+-rf?\b/.test(command)) return 'recursive delete';
  if (/\bdrop\s+(table|database)\b/i.test(command)) return 'drops a database/table';
  return 'a destructive command';
}

function describeGithubAction(action) {
  const a = (action || '').toLowerCase();
  if (a.includes('force_push') || a.includes('force-push')) return 'force-pushes (can overwrite remote history)';
  if (a.includes('branch') && a.includes('delete')) return 'permanently deletes the branch';
  if (a.includes('release') && a.includes('delete')) return 'permanently deletes the release';
  if (a.includes('repo') && a.includes('delete')) return 'permanently deletes the repo';
  if (a.includes('delete')) return 'permanently deletes something on GitHub';
  return 'makes an irreversible change';
}

export { classifyStep };
