/**
 * ZAO - Worktree Sessions
 *
 * Honest framing first, since this is the one feature in the comparison
 * table that doesn't map onto ZAO 1:1: Claude Code worktrees exist
 * because Claude Code always operates inside a real, persistent local git
 * checkout on the developer's machine. ZAO mostly doesn't have that - the
 * phone-side filesystem tool (filesystemTool.js) works through Android's
 * Storage Access Framework on plain folders, most of which have no .git
 * at all, and GitHub access happens over the REST API (githubTool.js),
 * not a local clone.
 *
 * So this module is genuinely two different things wearing one name,
 * chosen per-request by which backend is reachable (same reachable/
 * unreachable check terminalRouter.js already does for terminal
 * commands):
 *
 *   1. REAL git worktrees (backend: 'pc_git_worktree') - when the PC
 *      terminal backend is reachable and the target folder is an actual
 *      git repo there, this runs literal `git worktree add <path>
 *      <branch>` via terminal_pc_run_command - the exact same primitive
 *      Claude Code itself uses. Full fidelity, PC-only.
 *   2. GitHub branch + forked conversation (backend: 'github') - when
 *      there's no reachable local checkout (phone-only session, or the PC
 *      backend is down), this creates a GitHub branch via githubTool.js
 *      and pairs it with database.forkConversation() (which already
 *      existed pre-this-feature, for the chat "fork from here" action) -
 *      so the person gets an isolated chat context per branch even
 *      without a literal second working directory. Less faithful to what
 *      "worktree" technically means, but delivers the actual thing people
 *      use worktrees FOR: working on two branches of the same project in
 *      parallel without one session's uncommitted state stepping on the
 *      other's.
 *
 * Both paths write one row to worktree_sessions (src/db/database.js) so
 * Settings > Worktrees can list "what parallel branches am I mid-work on"
 * regardless of which backend created them.
 */

import * as githubTool from '../github/githubTool';
import * as pcTerminalTool from '../terminal/pcTerminalTool';
import { createConversation, forkConversation, createWorktreeSession, getWorktreeSessions, updateWorktreeSessionStatus } from '../../db/database';

function newId() {
  return `wt_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

/**
 * @param {object} opts
 * @param {'pc_git_worktree'|'github'} opts.backend
 * @param {string} opts.branch - new branch name for this parallel session
 * @param {string} opts.baseBranch - branch to fork from
 * @param {string} opts.sourceConversationId - the conversation this worktree is being split off from
 * @param {string} [opts.owner] - GitHub owner (both backends need this if a repo is involved)
 * @param {string} [opts.repo]
 * @param {string} [opts.repoPath] - for pc_git_worktree, the existing local repo's path on the PC
 * @param {string} [opts.worktreePath] - for pc_git_worktree, where to check the new worktree out to
 */
export async function createWorktreeSessionFor(opts) {
  const { backend, branch, baseBranch, sourceConversationId, owner = null, repo = null, repoPath = null, worktreePath = null } = opts;

  if (backend === 'pc_git_worktree') {
    if (!repoPath || !worktreePath) {
      return { success: false, error: { message: 'repoPath and worktreePath are required for a real git worktree.' } };
    }
    // Literal `git worktree add` - checks out `branch` (creating it from
    // baseBranch if it doesn't exist yet) into worktreePath, as a second
    // working directory alongside repoPath that shares the same .git -
    // exactly Claude Code's own mechanism, just invoked over ZAO's
    // existing PC terminal tool instead of a native git binding.
    const cmd = `cd "${repoPath}" && git worktree add "${worktreePath}" -B "${branch}" "${baseBranch || 'HEAD'}"`;
    const runResult = await pcTerminalTool.runCommand(cmd);
    if (!runResult.success) {
      return { success: false, error: runResult.error };
    }
  } else {
    if (!owner || !repo) {
      return { success: false, error: { message: 'owner and repo are required to create a GitHub-branch worktree session.' } };
    }
    const branchResult = await githubTool.createBranch(owner, repo, branch, baseBranch);
    if (!branchResult.success) {
      return { success: false, error: branchResult.error };
    }
  }

  const newConversationId = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const forkResult = sourceConversationId
    ? await forkConversation(sourceConversationId, newConversationId, { title: `${branch} (worktree)` })
    : await createConversation(newConversationId, `${branch} (worktree)`);
  if (!forkResult.success) {
    return { success: false, error: { message: forkResult.error || 'Could not create the worktree session\'s conversation.' } };
  }

  const id = newId();
  await createWorktreeSession({
    id,
    conversationId: newConversationId,
    sourceConversationId: sourceConversationId || null,
    owner,
    repo,
    branch,
    baseBranch: baseBranch || null,
    localPath: backend === 'pc_git_worktree' ? worktreePath : null,
    backend,
  });

  return { success: true, data: { id, conversationId: newConversationId, branch, backend } };
}

export async function listActiveWorktreeSessions() {
  const result = await getWorktreeSessions('active');
  return result.data;
}

/**
 * Marks a worktree session as merged/removed. For pc_git_worktree, also
 * removes the actual local checkout via `git worktree remove` so ZAO
 * doesn't leave stale directories behind on the PC - callers that only
 * want to stop tracking it without touching disk should pass
 * removeLocalCheckout: false.
 */
export async function closeWorktreeSession(session, { merged = false, removeLocalCheckout = true } = {}) {
  if (session.backend === 'pc_git_worktree' && session.local_path && removeLocalCheckout) {
    await pcTerminalTool.runCommand(`git worktree remove "${session.local_path}" --force`);
  }
  await updateWorktreeSessionStatus(session.id, merged ? 'merged' : 'removed');
  return { success: true };
}
