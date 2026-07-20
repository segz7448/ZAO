/**
 * ZAO - planExecutor.js tests (computeReadySteps)
 *
 * planExecutor.js is the runtime state machine that walks a plan's steps:
 * dependency scheduling, risk pausing, resource gating, recovery handoff.
 * This is exactly the kind of module the person's review called out as
 * highest-risk-with-zero-coverage - a silent bug here doesn't crash
 * loudly, it just runs a step out of order, or leaves the plan stuck
 * forever, or marks something 'blocked' that should have been 'ready'.
 *
 * computeReadySteps() is the piece that decides, on every pass of the
 * executor loop, which step (if any) runs next - so its correctness is
 * what everything else in the loop depends on. It was module-private;
 * exported (no behavior change) specifically so it's testable here in
 * isolation from the database/tool-calling side effects the rest of the
 * file has.
 */

import { computeReadySteps } from '../planExecutor';
import { STEP_STATUS } from '../planTypes';

function step(id, overrides = {}) {
  return {
    id,
    status: STEP_STATUS.PENDING,
    depends_on_step_id: null,
    depends_on_step_ids: null,
    ...overrides,
  };
}

describe('computeReadySteps - no dependencies', () => {
  test('every pending step with no dependency is immediately ready', () => {
    const steps = [step('a'), step('b'), step('c')];
    const { ready, newlyBlocked } = computeReadySteps(steps);
    expect(ready.map((s) => s.id).sort()).toEqual(['a', 'b', 'c']);
    expect(newlyBlocked).toEqual([]);
  });

  test('non-pending steps (done/running/failed/skipped/blocked) are never returned as ready or newly blocked', () => {
    const steps = [
      step('a', { status: STEP_STATUS.DONE }),
      step('b', { status: STEP_STATUS.RUNNING }),
      step('c', { status: STEP_STATUS.FAILED }),
      step('d', { status: STEP_STATUS.SKIPPED }),
      step('e', { status: STEP_STATUS.BLOCKED }),
      step('f', { status: STEP_STATUS.AWAITING_APPROVAL }),
    ];
    const { ready, newlyBlocked } = computeReadySteps(steps);
    expect(ready).toEqual([]);
    expect(newlyBlocked).toEqual([]);
  });

  test('empty step list returns empty ready/newlyBlocked', () => {
    expect(computeReadySteps([])).toEqual({ ready: [], newlyBlocked: [] });
  });
});

describe('computeReadySteps - single dependency (depends_on_step_id)', () => {
  test('step becomes ready once its single dependency is done', () => {
    const steps = [
      step('a', { status: STEP_STATUS.DONE }),
      step('b', { depends_on_step_id: 'a' }),
    ];
    const { ready, newlyBlocked } = computeReadySteps(steps);
    expect(ready.map((s) => s.id)).toEqual(['b']);
    expect(newlyBlocked).toEqual([]);
  });

  test('step stays neither ready nor blocked while its dependency is still pending/running', () => {
    const steps = [
      step('a', { status: STEP_STATUS.PENDING }),
      step('b', { depends_on_step_id: 'a' }),
    ];
    const { ready, newlyBlocked } = computeReadySteps(steps);
    // 'a' itself has no deps, so it's ready; 'b' is waiting on it - neither
    // ready nor blocked, so it should simply be absent from both lists.
    expect(ready.map((s) => s.id)).toEqual(['a']);
    expect(newlyBlocked).toEqual([]);
  });

  test.each([STEP_STATUS.FAILED, STEP_STATUS.SKIPPED, STEP_STATUS.BLOCKED])(
    'step is newly blocked when its dependency ends up %s',
    (deadStatus) => {
      const steps = [
        step('a', { status: deadStatus }),
        step('b', { depends_on_step_id: 'a' }),
      ];
      const { ready, newlyBlocked } = computeReadySteps(steps);
      expect(ready).toEqual([]);
      expect(newlyBlocked.map((s) => s.id)).toEqual(['b']);
    }
  );
});

describe('computeReadySteps - fan-in dependencies (depends_on_step_ids)', () => {
  test('ready only once every dependency in the comma list is done', () => {
    const steps = [
      step('a', { status: STEP_STATUS.DONE }),
      step('b', { status: STEP_STATUS.DONE }),
      step('c', { depends_on_step_ids: 'a,b' }),
    ];
    const { ready, newlyBlocked } = computeReadySteps(steps);
    expect(ready.map((s) => s.id)).toEqual(['c']);
    expect(newlyBlocked).toEqual([]);
  });

  test('not ready while any one dependency in the fan-in is still pending', () => {
    const steps = [
      step('a', { status: STEP_STATUS.DONE }),
      step('b', { status: STEP_STATUS.PENDING }),
      step('c', { depends_on_step_ids: 'a,b' }),
    ];
    const { ready, newlyBlocked } = computeReadySteps(steps);
    expect(ready.map((s) => s.id)).toEqual(['b']);
    expect(newlyBlocked.map((s) => s.id)).toEqual([]);
  });

  test('newly blocked if any one dependency in the fan-in failed, even if the others are done', () => {
    const steps = [
      step('a', { status: STEP_STATUS.DONE }),
      step('b', { status: STEP_STATUS.FAILED }),
      step('c', { depends_on_step_ids: 'a,b' }),
    ];
    const { ready, newlyBlocked } = computeReadySteps(steps);
    expect(ready).toEqual([]);
    expect(newlyBlocked.map((s) => s.id)).toEqual(['c']);
  });

  test('combines depends_on_step_id and depends_on_step_ids into one dependency set', () => {
    const steps = [
      step('a', { status: STEP_STATUS.DONE }),
      step('b', { status: STEP_STATUS.DONE }),
      step('c', { status: STEP_STATUS.PENDING }),
      step('d', { depends_on_step_id: 'a', depends_on_step_ids: 'b,c' }),
    ];
    const { ready, newlyBlocked } = computeReadySteps(steps);
    // 'd' depends on a, b (both done) AND c (still pending) - not ready yet.
    expect(ready.map((s) => s.id)).toEqual(['c']);
    expect(newlyBlocked).toEqual([]);
  });

  test('handles a trailing comma / empty entries in depends_on_step_ids without crashing', () => {
    const steps = [
      step('a', { status: STEP_STATUS.DONE }),
      step('b', { depends_on_step_ids: 'a,,' }),
    ];
    expect(() => computeReadySteps(steps)).not.toThrow();
    const { ready } = computeReadySteps(steps);
    expect(ready.map((s) => s.id)).toEqual(['b']);
  });
});

describe('computeReadySteps - a realistic multi-step plan', () => {
  test('walks a diamond dependency graph (a -> b,c -> d) one layer at a time', () => {
    const steps = [
      step('a'),
      step('b', { depends_on_step_id: 'a' }),
      step('c', { depends_on_step_id: 'a' }),
      step('d', { depends_on_step_ids: 'b,c' }),
    ];

    // Pass 1: only 'a' has no deps.
    let result = computeReadySteps(steps);
    expect(result.ready.map((s) => s.id)).toEqual(['a']);

    // Simulate 'a' completing.
    steps[0].status = STEP_STATUS.DONE;
    result = computeReadySteps(steps);
    expect(result.ready.map((s) => s.id).sort()).toEqual(['b', 'c']);

    // Simulate 'b' completing but 'c' failing - 'd' should be blocked, not ready.
    steps[1].status = STEP_STATUS.DONE;
    steps[2].status = STEP_STATUS.FAILED;
    result = computeReadySteps(steps);
    expect(result.ready).toEqual([]);
    expect(result.newlyBlocked.map((s) => s.id)).toEqual(['d']);
  });
});
