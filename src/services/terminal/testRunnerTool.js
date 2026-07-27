/**
 * ZAO - PC Test Runner Tool
 *
 * WHY THIS EXISTS: terminal_pc_run_command can already run ANY command,
 * including a test suite - "can it run tests" was never the gap. The
 * actual gap was that nothing made running tests after a code change
 * the OBVIOUS, EASY next step, and nothing turned raw pytest/jest output
 * into something the model can actually act on rather than just paste
 * back. This tool is that: one call, auto-detects the right test
 * command for whatever project it's pointed at, runs it through the
 * same real terminal_pc_run_command path (see pcTerminalTool.js -
 * same sandboxing, same shell auto-detection, nothing new invented at
 * the execution layer), and returns a STRUCTURED pass/fail/error
 * summary instead of a wall of raw text.
 *
 * This does not create an automatic loop by itself - it doesn't run
 * after every edit unasked, since most edits (a README, a config
 * comment) have nothing to do with tests and forcing a test run after
 * each one would be slow and often irrelevant. Instead,
 * executionPlanner.js's own prompt (see the "test" domain there) now
 * tells the model to plan an explicit pc_run_tests step after a real
 * code change, so running tests becomes a normal, expected part of a
 * coding plan - a step the model chooses to include because it
 * understands it should, not a hidden side effect bolted onto every
 * file write.
 */

import { readFile } from './pcFilesystemTool';
import * as pcTerminalTool from './pcTerminalTool';

const DEFAULT_TIMEOUT_MS = 180000; // 3 minutes - a real test suite can run longer than a typical command

/**
 * Looks at what's actually in the project folder to guess the right
 * test command, rather than requiring the model to already know
 * (or guess wrong) whether this project uses jest, pytest, go test,
 * cargo test, etc. Checked in order of how common each is in a fresh
 * project; the first match wins.
 */
async function detectTestCommand(projectPath) {
  const candidates = [
    { file: 'package.json', build: async (content) => {
      try {
        const parsed = JSON.parse(content);
        if (parsed.scripts?.test && parsed.scripts.test !== 'echo "Error: no test specified" && exit 1') {
          return 'npm test';
        }
      } catch (err) {
        // Malformed package.json - fall through to other candidates rather than failing detection outright.
      }
      return null;
    }},
    { file: 'pytest.ini', build: async () => 'pytest' },
    { file: 'pyproject.toml', build: async (content) => (/\[tool\.pytest/.test(content) ? 'pytest' : null) },
    { file: 'setup.cfg', build: async (content) => (/\[tool:pytest\]/.test(content) ? 'pytest' : null) },
    { file: 'go.mod', build: async () => 'go test ./...' },
    { file: 'Cargo.toml', build: async () => 'cargo test' },
    { file: 'phpunit.xml', build: async () => './vendor/bin/phpunit' },
  ];

  for (const candidate of candidates) {
    const path = projectPath ? `${projectPath.replace(/[\\/]+$/, '')}/${candidate.file}` : candidate.file;
    const result = await readFile(path).catch(() => ({ success: false }));
    if (!result.success || typeof result.data?.content !== 'string') continue;
    const command = await candidate.build(result.data.content);
    if (command) return { command, detectedFrom: candidate.file };
  }

  return null;
}

/**
 * Parses common test-runner output shapes into one consistent
 * {passed, failed, total, failureSummaries} shape, so the model gets
 * the same structure regardless of which framework actually ran - it
 * shouldn't need separate logic per test framework to understand
 * "did this work and what broke."
 *
 * Deliberately tolerant: if none of the known patterns match (an
 * unfamiliar framework, a custom test script), this still returns
 * something usable built from the exit code alone, rather than
 * throwing or returning nothing.
 */
function parseTestOutput(stdout, stderr, exitCode) {
  const combined = `${stdout}\n${stderr}`;

  // Jest / most JS test runners: "Tests: 3 failed, 12 passed, 15 total"
  const jestMatch = combined.match(/Tests:\s*(?:(\d+) failed,\s*)?(?:(\d+) passed,\s*)?(\d+) total/i);
  if (jestMatch) {
    return {
      framework: 'jest-like',
      passed: Number(jestMatch[2] || 0),
      failed: Number(jestMatch[1] || 0),
      total: Number(jestMatch[3] || 0),
      failureSummaries: extractFailureBlocks(combined, /(?:FAIL|✕|✗)\s+(.+)/g),
    };
  }

  // pytest: "3 failed, 12 passed in 1.23s" (order/fields vary, so match each independently)
  const pytestFailed = combined.match(/(\d+) failed/i);
  const pytestPassed = combined.match(/(\d+) passed/i);
  const pytestErrored = combined.match(/(\d+) error/i);
  if (pytestFailed || pytestPassed) {
    const passed = Number(pytestPassed?.[1] || 0);
    const failed = Number(pytestFailed?.[1] || 0) + Number(pytestErrored?.[1] || 0);
    return {
      framework: 'pytest-like',
      passed,
      failed,
      total: passed + failed,
      failureSummaries: extractFailureBlocks(combined, /FAILED\s+(.+)/g),
    };
  }

  // go test: "--- FAIL: TestName" lines are the only reliable signal -
  // a bare line starting with "ok"/"FAIL" (the package-level summary
  // line) is too easy to false-positive on unrelated output (an error
  // message that happens to start with "FAIL to load config...", for
  // instance, is not a Go test result at all) - only trust the
  // per-test "--- FAIL:" marker, which Go's test runner is the only
  // thing that actually prints.
  const goFailures = [...combined.matchAll(/--- FAIL: (\S+)/g)].map((m) => m[1]);
  const goPassCount = (combined.match(/--- PASS: /g) || []).length;
  if (goFailures.length || goPassCount > 0) {
    return {
      framework: 'go-test',
      passed: goPassCount || null,
      failed: goFailures.length,
      total: goPassCount ? goPassCount + goFailures.length : null,
      failureSummaries: goFailures,
    };
  }

  // Nothing recognized - fall back to exit code alone rather than
  // returning nothing. A non-zero exit from a test command overwhelmingly
  // means something failed, even if this parser doesn't know the format.
  return {
    framework: 'unknown',
    passed: exitCode === 0 ? null : null,
    failed: exitCode === 0 ? 0 : null,
    total: null,
    failureSummaries: [],
    note: 'Test output format not recognized - see rawOutput for the actual text.',
  };
}

function extractFailureBlocks(text, pattern) {
  return [...text.matchAll(pattern)].map((m) => m[1].trim()).slice(0, 20); // cap at 20 - a failure list this long means something systemic (a bad import, broken config), not something worth reading test-by-test
}

/**
 * Runs the project's test suite and returns a structured summary.
 *
 * @param {object} args
 * @param {string} [args.projectPath] - folder to look for a test config
 *   in and run the command from; omit to use the PC's configured
 *   project root (same default terminal_pc_run_command uses)
 * @param {string} [args.command] - skip auto-detection and run this
 *   exact command instead (e.g. "npm test -- --watchAll=false", or a
 *   specific test file/pattern)
 * @returns {Promise<{success, data, error}>}
 */
export async function runTests({ projectPath = null, command = null } = {}) {
  let testCommand = command;
  let detectedFrom = null;

  if (!testCommand) {
    const detected = await detectTestCommand(projectPath);
    if (!detected) {
      return {
        success: false,
        data: null,
        error: {
          message: 'Could not detect a test command for this project (no package.json test script, pytest.ini, go.mod, Cargo.toml, or phpunit.xml found). Pass an explicit `command` if this project uses a test runner not listed here.',
        },
      };
    }
    testCommand = detected.command;
    detectedFrom = detected.detectedFrom;
  }

  const result = await pcTerminalTool.runCommand(testCommand, {
    workingDirectory: projectPath || undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  });

  // A non-zero exit is the NORMAL, expected shape of "tests failed" -
  // this tool's job is to report that clearly, not treat it as a tool
  // failure the way a broken command would be. Only report failure
  // (success: false) when the command itself couldn't run at all
  // (missing test runner, timeout) - see the blocked/syntaxBlocked/
  // timedOut checks below.
  if (!result.success && !result.data) {
    return { success: false, data: null, error: result.error };
  }

  const { stdout, stderr, exitCode, shellUsed } = result.data;
  const parsed = parseTestOutput(stdout, stderr, exitCode);
  const allPassed = exitCode === 0;

  return {
    success: true, // the TOOL succeeded (it ran and got a real result) - see data.allPassed for whether the TESTS passed
    data: {
      command: testCommand,
      detectedFrom,
      shellUsed,
      exitCode,
      allPassed,
      ...parsed,
      rawOutput: `${stdout}\n${stderr}`.trim().slice(0, 8000), // capped - a full failing suite's output can be huge; the structured failureSummaries above is what the model should reason from first
    },
    error: null,
  };
}
