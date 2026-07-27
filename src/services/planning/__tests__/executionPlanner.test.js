/**
 * ZAO - executionPlanner.js tests
 *
 * WHY THESE TESTS EXIST: this file is where a real, traced-down
 * production bug lived - safeParseStepsJson() required the model's
 * response to be perfectly clean JSON with zero surrounding text. When
 * that parse failed (which a 3B model does often - wrapping JSON in
 * commentary like "Here's the plan: {...}" despite being told not to),
 * the code silently fell back to a placeholder step with
 * action: null, target: null - which then either errored quietly or
 * did nothing, while the model still wrote a plausible "done" summary
 * afterward. That's the exact "it says it's finished but it isn't" /
 * "it explains how to do it myself instead of doing it" bug a person
 * using this app actually hit and reported.
 *
 * These tests exist so that specific failure mode - and the
 * plannerFailed honesty fix that replaced it - can never silently
 * regress again without a test catching it, the same way
 * planExecutor.test.js already protects computeReadySteps().
 */

import {
  normalizeDomain,
  fallbackStepForUnit,
  safeParseStepsJson,
  extractBalancedJsonObject,
} from '../executionPlanner';

describe('extractBalancedJsonObject', () => {
  test('extracts a flat object with no surrounding text', () => {
    const text = '{"a": 1, "b": 2}';
    expect(extractBalancedJsonObject(text)).toBe(text);
  });

  test('extracts an object preceded by commentary - the exact "Here\'s the plan: {...}" shape a 3B model actually produces', () => {
    const text = 'Sure, here is the plan: {"steps": [{"domain": "files"}]} Let me know if you need anything else.';
    expect(extractBalancedJsonObject(text)).toBe('{"steps": [{"domain": "files"}]}');
  });

  test('extracts a NESTED object correctly - the case a naive non-nesting regex (/\\{[^{}]*\\}/) truncates at the first inner closing brace', () => {
    const text = '{"steps": [{"domain": "files", "action": "a"}, {"domain": "github", "action": "b"}]}';
    const extracted = extractBalancedJsonObject(text);
    expect(extracted).toBe(text);
    expect(() => JSON.parse(extracted)).not.toThrow();
    expect(JSON.parse(extracted).steps).toHaveLength(2);
  });

  test('extracts an object wrapped in a markdown code fence (fence stripping happens in safeParseStepsJson, but the balanced extractor must still work on the fenced text if called directly)', () => {
    const text = '```json\n{"steps": [{"domain": "files"}]}\n```';
    // extractBalancedJsonObject only finds the {...} - it does not strip fences itself (that's safeParseStepsJson's job) - so it should still find the object embedded inside the fence.
    expect(extractBalancedJsonObject(text)).toBe('{"steps": [{"domain": "files"}]}');
  });

  test('returns null for text with no braces at all', () => {
    expect(extractBalancedJsonObject('I think the best approach is to just create the folder manually.')).toBeNull();
  });

  test('returns null for an unbalanced/truncated object (never finds a false match)', () => {
    expect(extractBalancedJsonObject('{"steps": [{"domain": "files"')).toBeNull();
  });
});

describe('safeParseStepsJson', () => {
  test('parses clean JSON directly', () => {
    const result = safeParseStepsJson('{"steps": [{"domain": "files", "action": "pc_fs_create_folder", "target": "Smile"}]}');
    expect(result).toEqual({ steps: [{ domain: 'files', action: 'pc_fs_create_folder', target: 'Smile' }] });
  });

  test('recovers JSON wrapped in commentary - the real bug this was traced back to', () => {
    const text = 'Sure, here is the plan: {"steps": [{"domain": "files", "action": "pc_fs_create_folder", "target": "Smile"}]} Let me know if you need anything else.';
    const result = safeParseStepsJson(text);
    expect(result).toEqual({ steps: [{ domain: 'files', action: 'pc_fs_create_folder', target: 'Smile' }] });
  });

  test('recovers JSON wrapped in a markdown code fence', () => {
    const text = '```json\n{"steps": [{"domain": "files", "action": "pc_fs_create_folder", "target": "Smile"}]}\n```';
    const result = safeParseStepsJson(text);
    expect(result).toEqual({ steps: [{ domain: 'files', action: 'pc_fs_create_folder', target: 'Smile' }] });
  });

  test('recovers a multi-step NESTED plan wrapped in commentary AND a fence together', () => {
    const text = '```json\n{"steps": [{"domain": "files", "action": "pc_fs_create_folder", "target": "Smile"}, {"domain": "files", "action": "pc_fs_create_file", "target": "Smile/readme.txt"}]}\n```\nThis creates the folder and a readme.';
    const result = safeParseStepsJson(text);
    expect(result.steps).toHaveLength(2);
    expect(result.steps[1].target).toBe('Smile/readme.txt');
  });

  test('returns null (never throws) for text with genuinely no JSON - this is what should trigger the honest plannerFailed fallback, not a crash', () => {
    expect(() => safeParseStepsJson('I think the best approach is to just create the folder manually.')).not.toThrow();
    expect(safeParseStepsJson('I think the best approach is to just create the folder manually.')).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(safeParseStepsJson('')).toBeNull();
  });

  test('returns null (not a throw, not a non-object) when the extracted text parses to a non-object JSON value', () => {
    expect(safeParseStepsJson('here is the number: 42')).toBeNull();
  });
});

describe('normalizeDomain', () => {
  test.each(['coding', 'terminal', 'files', 'browser', 'github', 'time', 'search', 'test'])(
    'accepts the valid domain "%s" unchanged',
    (domain) => {
      expect(normalizeDomain(domain)).toBe(domain);
    }
  );

  test('an unrecognized domain falls back to "terminal", not undefined/null - this was a real bug: "time"/"search" were being silently rewritten to "terminal" before those two were added to the valid list', () => {
    expect(normalizeDomain('nonsense')).toBe('terminal');
    expect(normalizeDomain(undefined)).toBe('terminal');
    expect(normalizeDomain(null)).toBe('terminal');
  });
});

describe('fallbackStepForUnit', () => {
  test('produces a step flagged plannerFailed:true, not a silent action:null ghost step', () => {
    const unit = { title: 'Create a Smile folder' };
    const task = { title: 'Folder task' };
    const step = fallbackStepForUnit(unit, task);

    expect(step.plannerFailed).toBe(true);
    expect(step.action).toBeNull();
    expect(step.target).toBeNull();
  });

  test('uses the unit title when present, falling back to the task title', () => {
    expect(fallbackStepForUnit({ title: 'Unit title' }, { title: 'Task title' }).description).toBe('Unit title');
    expect(fallbackStepForUnit({}, { title: 'Task title' }).description).toBe('Task title');
  });
});
