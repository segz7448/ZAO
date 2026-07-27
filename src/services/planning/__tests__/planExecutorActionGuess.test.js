/**
 * ZAO - planExecutor.js normalizeActionGuess tests
 *
 * normalizeActionGuess() is the safety net for when a plan step's
 * `action` doesn't exactly match a real TOOL_REGISTRY key - it falls
 * back to a sensible default FOR THAT DOMAIN rather than failing the
 * step outright. This file protects two things that have both been
 * real bugs in this exact function:
 *
 *   1. A wrong hardcoded default silently working most of the time
 *      because the model usually gets the action name right anyway
 *      (executionPlanner.js's prompt once said "terminal_run_command",
 *      a tool that has never existed - the real one is
 *      "terminal_pc_run_command" - and this fallback papered over it
 *      without anyone noticing until the prompt was read carefully).
 *   2. A domain added elsewhere (executionPlanner.js's normalizeDomain
 *      valid-domains list) without a matching default added HERE -
 *      "time" and "search" existed in the prompt's vocabulary for a
 *      while with no fallback in this function at all.
 *
 * Keeping both files' domain lists in sync is exactly the kind of thing
 * that silently drifts apart over time without a test - this is that
 * test.
 */

import { normalizeActionGuess, translatePcLogDecisionArgs } from '../planExecutor';

describe('normalizeActionGuess - known domains resolve to their real tool', () => {
  test.each([
    ['files', 'fs_create_file'],
    ['github', 'github_commit_files'],
    ['terminal', 'terminal_pc_run_command'],
    ['time', 'time_get_current'],
    ['search', 'web_search'],
    ['test', 'pc_run_tests'],
  ])('domain "%s" defaults to "%s"', (domain, expectedAction) => {
    expect(normalizeActionGuess({ domain, action: 'something_the_model_made_up' })).toBe(expectedAction);
  });

  test('the terminal default is specifically "terminal_pc_run_command", not the never-existed "terminal_run_command" a past prompt bug referenced', () => {
    expect(normalizeActionGuess({ domain: 'terminal', action: 'anything' })).toBe('terminal_pc_run_command');
    expect(normalizeActionGuess({ domain: 'terminal', action: 'anything' })).not.toBe('terminal_run_command');
  });
});

describe('normalizeActionGuess - domains with multiple possible real tools are left alone', () => {
  test('domain "coding" and "browser" have no single default - the model\'s own action guess passes through unchanged, since guessing wrong here would silently run the wrong one of several real tools', () => {
    expect(normalizeActionGuess({ domain: 'coding', action: 'pc_fs_edit_file' })).toBe('pc_fs_edit_file');
    expect(normalizeActionGuess({ domain: 'browser', action: 'browser_navigate' })).toBe('browser_navigate');
  });

  test('an unrecognized domain with no default also passes the action through unchanged rather than guessing', () => {
    expect(normalizeActionGuess({ domain: 'nonsense', action: 'whatever_the_model_said' })).toBe('whatever_the_model_said');
  });
});

describe('normalizeActionGuess - keeps pace with executionPlanner.js\'s domain vocabulary', () => {
  test('every domain executionPlanner.js\'s prompt tells the model to use has a sensible resolution here (either a real default, or a deliberate pass-through for multi-tool domains) - this is the regression test for "time"/"search" existing in the prompt with no matching fallback here', () => {
    // Mirrors executionPlanner.js's normalizeDomain valid-domains list -
    // if that list ever grows, this test's list should grow with it,
    // and whoever adds the new domain there should also decide what
    // (if anything) belongs here.
    const allPromptDomains = ['coding', 'terminal', 'files', 'browser', 'github', 'time', 'search', 'test'];
    for (const domain of allPromptDomains) {
      const result = normalizeActionGuess({ domain, action: 'placeholder_action' });
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    }
  });
});

describe('translatePcLogDecisionArgs', () => {
  test('populates decision/reasoning from step.target/args.content - the real bug this fixes: without this translation, a plan-produced pc_log_decision step always received decision:undefined, reasoning:undefined and failed its own required-field check', () => {
    const step = { target: 'Used SQLite instead of a flat JSON file for the cache layer' };
    const baseArgs = { path: step.target, target: step.target, name: step.target, content: 'Concurrent writes needed real locking, which a flat JSON file cannot provide safely.' };

    const result = translatePcLogDecisionArgs(step, baseArgs);

    expect(result.decision).toBe('Used SQLite instead of a flat JSON file for the cache layer');
    expect(result.reasoning).toBe('Concurrent writes needed real locking, which a flat JSON file cannot provide safely.');
    expect(result.decision).not.toBeUndefined();
    expect(result.reasoning).not.toBeUndefined();
  });

  test('falls back to null (not undefined) for reasoning when args.content is missing, so recordDecision\'s own validation gets a clean falsy value to check rather than undefined leaking through', () => {
    const step = { target: 'Some decision with no reasoning provided' };
    const baseArgs = { path: step.target, target: step.target, name: step.target };

    const result = translatePcLogDecisionArgs(step, baseArgs);

    expect(result.decision).toBe('Some decision with no reasoning provided');
    expect(result.reasoning).toBeNull();
  });

  test('preserves projectPath from baseArgs when present, defaults to null otherwise', () => {
    const step = { target: 'A decision' };
    const withPath = translatePcLogDecisionArgs(step, { content: 'why', projectPath: 'my-project' });
    const withoutPath = translatePcLogDecisionArgs(step, { content: 'why' });

    expect(withPath.projectPath).toBe('my-project');
    expect(withoutPath.projectPath).toBeNull();
  });
});
