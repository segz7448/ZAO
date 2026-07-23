/**
 * ZAO - PC Git Tool
 *
 * Thin wrapper around backendClient's git* functions (server/pcGit.js) -
 * structured git operations with zero shell-quoting risk (every
 * subcommand runs via execFile with an args array, not a shell string -
 * see pcGit.js's header for why that matters). `path` in every function
 * below is a project folder relative to PC_BRIDGE_ROOT.
 */

import {
  gitInitPc, gitStatusPc, gitAddPc, gitCommitPc, gitPushPc, gitPullPc,
  gitCheckoutPc, gitRemoteAddPc, gitLogPc, gitDiffPc,
} from '../backend/backendClient';

function shapeResult(result) {
  if (!result.success) return { success: false, data: null, error: result.error };
  // Every /pc-git/* route returns { exitCode, stdout, stderr, ... } even
  // on a git-level failure (bad branch name, nothing to commit, etc.) -
  // HTTP 200 doesn't mean git itself succeeded, so surface that as a
  // tool-level failure too rather than making the caller check exitCode.
  if (result.data?.exitCode !== 0 && result.data?.exitCode !== undefined) {
    return { success: false, data: result.data, error: { message: result.data.stderr?.trim() || result.data.stdout?.trim() || `git exited with code ${result.data.exitCode}.` } };
  }
  return { success: true, data: result.data, error: null };
}

export async function init(path) {
  return shapeResult(await gitInitPc(path));
}

/** @returns data.parsed = { branch, upstream, ahead, behind, files, clean } */
export async function status(path) {
  return shapeResult(await gitStatusPc(path));
}

/** @param {{files?: string[], all?: boolean}} [options] - omit both for "add everything" */
export async function add(path, options = {}) {
  return shapeResult(await gitAddPc(path, options));
}

export async function commit(path, message, options = {}) {
  return shapeResult(await gitCommitPc(path, message, options));
}

export async function push(path, options = {}) {
  return shapeResult(await gitPushPc(path, options));
}

export async function pull(path, options = {}) {
  return shapeResult(await gitPullPc(path, options));
}

export async function checkout(path, branch, options = {}) {
  return shapeResult(await gitCheckoutPc(path, branch, options));
}

export async function remoteAdd(path, name, url) {
  return shapeResult(await gitRemoteAddPc(path, name, url));
}

/** @returns data.commits = [{hash, shortHash, author, date, subject}, ...] */
export async function log(path, options = {}) {
  return shapeResult(await gitLogPc(path, options));
}

export async function diff(path, options = {}) {
  return shapeResult(await gitDiffPc(path, options));
}
