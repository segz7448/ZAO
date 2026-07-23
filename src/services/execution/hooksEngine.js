/**
 * ZAO - Hooks Engine
 *
 * Lifecycle interception, matching Claude Code's PreToolUse / PostToolUse
 * / SessionStart hooks. A hook is a real shell command (Settings >
 * Automation lets a person register one), run through the SAME PC
 * terminal tool the model itself uses (pcTerminalTool.js - see hooks
 * table's `backend` column, which is always 'pc' now that ZAO has only
 * one terminal) - no new execution surface, just a new trigger into the
 * existing one.
 *
 * Contract, matching Claude Code's own hook exit-code convention:
 *   - PreToolUse hooks run BEFORE the tool call. If any matching hook's
 *     output contains the literal marker ZAO_HOOK_BLOCK, the tool call is
 *     refused and the model sees why (same shape as commandSafety.js's
 *     `needsConfirmation: true` refusal) - this is how a hook can, e.g.,
 *     reject any fs_edit_file touching a path matching *.env.
 *   - PostToolUse hooks run AFTER the tool call completes (success or
 *     failure) and can't block anything retroactively - they're for
 *     side effects (logging to an external system, running a linter/
 *     formatter after a file edit, sending a notification).
 *   - SessionStart hooks run once, when App.js finishes initDatabase() -
 *     for things like warming a cache, checking a remote config, or
 *     just logging "session started" to wherever the person's
 *     PostToolUse/SessionStart hooks send things.
 *
 * The `context` object passed to a hook is serialized to JSON and made
 * available to the shell command via a ZAO_HOOK_CONTEXT environment-style
 * prefix (`ZAO_HOOK_CONTEXT='...' <command>`) rather than piped over
 * stdin, since pcTerminalTool.js already runs commands through a shell
 * that supports inline env assignment (Git Bash/cmd/PowerShell on the PC
 * backend).
 */

import { getHooks } from '../../db/database';
import * as pcTerminalTool from '../terminal/pcTerminalTool';

function matches(matcher, toolName) {
  if (!matcher || matcher === '*') return true;
  if (matcher.endsWith('*')) return (toolName || '').startsWith(matcher.slice(0, -1));
  return matcher === toolName;
}

function buildCommand(command, context) {
  const contextJson = JSON.stringify(context || {}).replace(/'/g, `'\\''`);
  return `ZAO_HOOK_CONTEXT='${contextJson}' ${command}`;
}

async function runOne(hook, context) {
  try {
    const result = await pcTerminalTool.runCommand(buildCommand(hook.command, context));
    const output = `${result?.data?.stdout || ''}\n${result?.data?.stderr || ''}`;
    return { hookId: hook.id, ok: !!result?.success, blocked: output.includes('ZAO_HOOK_BLOCK'), output };
  } catch (err) {
    return { hookId: hook.id, ok: false, blocked: false, output: err?.message || 'Hook failed to run.' };
  }
}

/**
 * Runs every enabled hook registered for `event` whose matcher matches
 * `toolName` (pass toolName: null for SessionStart, which has no tool).
 * Hooks run sequentially (not parallel) so a later hook can rely on an
 * earlier one's side effects finishing first, same ordering guarantee
 * Claude Code's own hooks give.
 *
 * @returns {Promise<{ blocked: boolean, reason: string|null, results: Array }>}
 */
export async function runHooks(event, { toolName = null, args = null, result = null } = {}) {
  const hooksResult = await getHooks(event);
  const hooks = (hooksResult.data || []).filter((h) => matches(h.matcher, toolName));
  if (hooks.length === 0) return { blocked: false, reason: null, results: [] };

  const context = { event, toolName, args, result, timestamp: Date.now() };
  const results = [];
  for (const hook of hooks) {
    const outcome = await runOne(hook, context);
    results.push(outcome);
    if (event === 'PreToolUse' && outcome.blocked) {
      return { blocked: true, reason: `Blocked by hook (${hook.matcher}): ${outcome.output.trim().slice(0, 300)}`, results };
    }
  }
  return { blocked: false, reason: null, results };
}

export async function runSessionStartHooks() {
  return runHooks('SessionStart', {});
}

export async function runPreToolUseHooks(toolName, args) {
  return runHooks('PreToolUse', { toolName, args });
}

export async function runPostToolUseHooks(toolName, args, result) {
  return runHooks('PostToolUse', { toolName, args, result });
}
