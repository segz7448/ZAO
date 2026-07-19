/**
 * ZAO - GitHub Tool
 *
 * Real GitHub REST API calls, authenticated with a Personal Access Token
 * the person pastes into Settings (stored the same secure way as
 * OpenRouter/HF keys - see src/db/database.js's storeApiKey, provider
 * 'github'). This is a plugin behind the chat interface, per the
 * project-manager architecture: the person never sees a "Git button" -
 * The local coder model decides when to call these functions, and the result comes
 * back as plain chat text ("✓ Pushed to GitHub").
 *
 * IMPORTANT LIMITATION, stated honestly: this is the REST/Git Data API,
 * not the `git` binary. "Clone" here means fetching a repo's file tree
 * and contents over HTTPS, not running `git clone` (there's no git
 * binary available inside the Expo/React Native runtime on-device).
 * "Commit" and "push" use GitHub's Git Data API (create a blob, a tree,
 * a commit, then update the branch ref) - the end result in the repo is
 * identical to a normal git push, but the mechanism is pure HTTPS calls,
 * matching how MobileCloud/ZAO's existing GitHub Actions workflows already
 * describe this pattern (fetch SHA + update atomically) elsewhere in this
 * project's history.
 */

import { getApiKey } from '../../db/database';
import { utf8ToBase64, base64ToUtf8, base64ToBytes } from '../shared/base64Utils';

const API_BASE = 'https://api.github.com';

async function githubFetch(path, token, options = {}) {
  try {
    const response = await fetch(`${API_BASE}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(options.body ? { 'Content-Type': 'application/json' } : {}),
        ...options.headers,
      },
    });

    const text = await response.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (e) { /* non-JSON response body */ }

    if (!response.ok) {
      return {
        success: false,
        data: null,
        error: {
          status: response.status,
          message: json?.message || `GitHub API error (HTTP ${response.status})`,
        },
      };
    }

    return { success: true, data: json, error: null };
  } catch (err) {
    return {
      success: false,
      data: null,
      error: { status: null, message: err?.message || 'Network request to GitHub failed' },
    };
  }
}

async function getToken() {
  const result = await getApiKey('github');
  return result?.data?.key_value || null;
}

/**
 * Fetches repo metadata + the default branch's file tree (recursive) -
 * the "clone" equivalent: everything needed to know what's in the repo
 * without an actual git binary.
 */
export async function cloneRepo(owner, repo) {
  const token = await getToken();
  if (!token) return { success: false, data: null, error: { message: 'No GitHub token configured.' } };

  const repoResult = await githubFetch(`/repos/${owner}/${repo}`, token);
  if (!repoResult.success) return repoResult;

  const defaultBranch = repoResult.data.default_branch;
  const branchResult = await githubFetch(`/repos/${owner}/${repo}/branches/${defaultBranch}`, token);
  if (!branchResult.success) return branchResult;

  const treeSha = branchResult.data.commit.commit.tree.sha;
  const treeResult = await githubFetch(`/repos/${owner}/${repo}/git/trees/${treeSha}?recursive=1`, token);
  if (!treeResult.success) return treeResult;

  return {
    success: true,
    data: {
      repo: repoResult.data,
      defaultBranch,
      files: treeResult.data.tree.filter((entry) => entry.type === 'blob'),
    },
    error: null,
  };
}

/**
 * Reads one file's content (base64-decoded to a UTF-8 string) from a repo.
 */
export async function readFile(owner, repo, path, ref = undefined) {
  const token = await getToken();
  if (!token) return { success: false, data: null, error: { message: 'No GitHub token configured.' } };

  const query = ref ? `?ref=${encodeURIComponent(ref)}` : '';
  const result = await githubFetch(`/repos/${owner}/${repo}/contents/${path}${query}`, token);
  if (!result.success) return result;

  if (Array.isArray(result.data)) {
    return { success: false, data: null, error: { message: `${path} is a directory, not a file.` } };
  }

  const content = result.data.content
    ? base64ToUtf8(result.data.content)
    : '';

  return { success: true, data: { path, content, sha: result.data.sha }, error: null };
}

/**
 * Creates a brand-new repository under the authenticated account.
 */
export async function createRepo(name, { description = '', isPrivate = true } = {}) {
  const token = await getToken();
  if (!token) return { success: false, data: null, error: { message: 'No GitHub token configured.' } };

  return githubFetch('/user/repos', token, {
    method: 'POST',
    body: JSON.stringify({ name, description, private: isPrivate, auto_init: true }),
  });
}

/**
 * Creates or updates ONE file and commits it directly to a branch - this
 * is the Contents API's atomic single-file commit path (fetch current
 * SHA if the file exists, then PUT with that SHA to update, or omit SHA
 * to create new). For multiple files in one commit, use commitFiles()
 * below instead, which uses the lower-level Git Data API so all files
 * land in a single commit rather than one commit per file.
 */
export async function commitFile(owner, repo, path, content, message, branch = undefined) {
  const token = await getToken();
  if (!token) return { success: false, data: null, error: { message: 'No GitHub token configured.' } };

  // Check if the file already exists, to get its current SHA (required by
  // the API to update rather than create).
  const existing = await githubFetch(
    `/repos/${owner}/${repo}/contents/${path}${branch ? `?ref=${branch}` : ''}`,
    token
  );
  const sha = existing.success && !Array.isArray(existing.data) ? existing.data.sha : undefined;

  const base64Content = utf8ToBase64(content);

  return githubFetch(`/repos/${owner}/${repo}/contents/${path}`, token, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: base64Content,
      ...(sha ? { sha } : {}),
      ...(branch ? { branch } : {}),
    }),
  });
}

/**
 * Commits MULTIPLE files in a single atomic commit, using the Git Data
 * API directly (create blobs -> create a tree -> create a commit ->
 * update the branch ref). This is what "Generated 14 files... Pushed to
 * GitHub" as ONE commit needs - commitFile() above would create 14
 * separate commits instead.
 *
 * @param {Array<{path: string, content: string}>} files
 */
export async function commitFiles(owner, repo, files, message, branch = 'main') {
  const token = await getToken();
  if (!token) return { success: false, data: null, error: { message: 'No GitHub token configured.' } };

  const refResult = await githubFetch(`/repos/${owner}/${repo}/git/ref/heads/${branch}`, token);
  if (!refResult.success) return refResult;
  const parentCommitSha = refResult.data.object.sha;

  const parentCommitResult = await githubFetch(`/repos/${owner}/${repo}/git/commits/${parentCommitSha}`, token);
  if (!parentCommitResult.success) return parentCommitResult;
  const baseTreeSha = parentCommitResult.data.tree.sha;

  // Create a blob per file first - each blob call is independent, so
  // these run in parallel rather than sequentially.
  const blobResults = await Promise.all(
    files.map((f) =>
      githubFetch(`/repos/${owner}/${repo}/git/blobs`, token, {
        method: 'POST',
        body: JSON.stringify({ content: utf8ToBase64(f.content), encoding: 'base64' }),
      })
    )
  );
  const failedBlob = blobResults.find((r) => !r.success);
  if (failedBlob) return failedBlob;

  const treeEntries = files.map((f, i) => ({
    path: f.path,
    mode: '100644',
    type: 'blob',
    sha: blobResults[i].data.sha,
  }));

  const treeResult = await githubFetch(`/repos/${owner}/${repo}/git/trees`, token, {
    method: 'POST',
    body: JSON.stringify({ base_tree: baseTreeSha, tree: treeEntries }),
  });
  if (!treeResult.success) return treeResult;

  const commitResult = await githubFetch(`/repos/${owner}/${repo}/git/commits`, token, {
    method: 'POST',
    body: JSON.stringify({ message, tree: treeResult.data.sha, parents: [parentCommitSha] }),
  });
  if (!commitResult.success) return commitResult;

  const updateRefResult = await githubFetch(`/repos/${owner}/${repo}/git/refs/heads/${branch}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ sha: commitResult.data.sha }),
  });
  if (!updateRefResult.success) return updateRefResult;

  return { success: true, data: { commitSha: commitResult.data.sha, filesCommitted: files.length }, error: null };
}

/**
 * Creates a new branch from the tip of an existing one (defaults to the
 * repo's default branch if fromBranch isn't given).
 */
export async function createBranch(owner, repo, newBranchName, fromBranch = undefined) {
  const token = await getToken();
  if (!token) return { success: false, data: null, error: { message: 'No GitHub token configured.' } };

  let sourceBranch = fromBranch;
  if (!sourceBranch) {
    const repoResult = await githubFetch(`/repos/${owner}/${repo}`, token);
    if (!repoResult.success) return repoResult;
    sourceBranch = repoResult.data.default_branch;
  }

  const refResult = await githubFetch(`/repos/${owner}/${repo}/git/ref/heads/${sourceBranch}`, token);
  if (!refResult.success) return refResult;

  return githubFetch(`/repos/${owner}/${repo}/git/refs`, token, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${newBranchName}`, sha: refResult.data.object.sha }),
  });
}

/**
 * Opens a pull request from one branch into another.
 */
export async function createPullRequest(owner, repo, { title, head, base = 'main', body = '' }) {
  const token = await getToken();
  if (!token) return { success: false, data: null, error: { message: 'No GitHub token configured.' } };

  return githubFetch(`/repos/${owner}/${repo}/pulls`, token, {
    method: 'POST',
    body: JSON.stringify({ title, head, base, body }),
  });
}

/**
 * Creates a GitHub Release and uploads one or more binary assets to it
 * (e.g. an APK from a completed build). Asset content must be provided as
 * base64.
 */
export async function createRelease(owner, repo, { tagName, name, body = '', assets = [] }) {
  const token = await getToken();
  if (!token) return { success: false, data: null, error: { message: 'No GitHub token configured.' } };

  const releaseResult = await githubFetch(`/repos/${owner}/${repo}/releases`, token, {
    method: 'POST',
    body: JSON.stringify({ tag_name: tagName, name: name || tagName, body }),
  });
  if (!releaseResult.success) return releaseResult;

  const uploadUrlBase = releaseResult.data.upload_url.replace('{?name,label}', '');
  const uploadResults = [];
  for (const asset of assets) {
    // Uses fetch directly (not githubFetch) since asset uploads go to a
    // different host (uploads.github.com) with a binary body and
    // different Content-Type, not the JSON API shape githubFetch expects.
    try {
      const binary = base64ToBytes(asset.base64Content);
      const response = await fetch(`${uploadUrlBase}?name=${encodeURIComponent(asset.name)}`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'Content-Type': asset.contentType || 'application/octet-stream',
        },
        body: binary,
      });
      const json = await response.json();
      uploadResults.push({ name: asset.name, success: response.ok, data: json });
    } catch (err) {
      uploadResults.push({ name: asset.name, success: false, error: err?.message });
    }
  }

  return { success: true, data: { release: releaseResult.data, assets: uploadResults }, error: null };
}

/**
 * Quick validity check for a token - used by Settings when the person
 * first pastes their username/token in, so they get immediate feedback
 * rather than finding out on the first real tool call.
 */
export async function verifyToken(token) {
  const result = await githubFetch('/user', token);
  if (!result.success) return { valid: false, username: null, error: result.error };
  return { valid: true, username: result.data.login, error: null };
}
