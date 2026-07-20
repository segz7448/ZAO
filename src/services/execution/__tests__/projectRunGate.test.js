/**
 * ZAO - projectRunGate.js tests
 *
 * Covers the automatic pre-run gate wired into both pcTerminalTool.js and
 * termuxTerminalTool.js: isProjectRunCommand's pattern matching (must
 * catch real "start/build/serve" commands without false-positiving on
 * unrelated ones - see the inline comments on each case below for why
 * each one is there) and checkBeforeProjectRun's block/pass decision
 * against a mocked checkProjectSyntax result.
 */

import { isProjectRunCommand, checkBeforeProjectRun } from '../projectRunGate';
import { checkProjectSyntax } from '../../filesystem/filesystemTool';

jest.mock('../../filesystem/filesystemTool', () => ({
  checkProjectSyntax: jest.fn(),
}));

describe('isProjectRunCommand', () => {
  test.each([
    ['npm start', true],
    ['npm run start', true],
    ['npm run dev', true],
    ['npm run build', true],
    ['yarn start', true],
    ['yarn build', true],
    ['pnpm dev', true],
    ['expo start', true],
    ['expo start --tunnel', true],
    ['expo run:android', true],
    ['node index.js', true],
    ['node scripts/build.mjs', true],
    ['react-native run-android', true],
    ['next dev', true],
    ['vite', true],
    ['vite build', true],
    ['gradlew assembleRelease', true],
    ['python3 manage.py runserver 0.0.0.0:8000', true],
  ])('%s is recognized as a project-run command', (command) => {
    expect(isProjectRunCommand(command)).toBe(true);
  });

  test.each([
    ['npm install', false], // installing, not running
    ['npm install react-starter-kit', false], // "start" appears inside a package name - must not false-positive
    ['npm --version', false],
    ['npm test', false], // tests, not a project launch
    ['yarn add react', false],
    ['expo install expo-camera', false],
    ['node --version', false],
    ['cat npm-start-notes.md', false], // "start" appears in a filename, not a command
    ['git status', false],
    ['git log --oneline', false],
    ['ls -la', false],
    ['vite --version', false],
    ['pip install django', false],
    [null, false],
    [undefined, false],
    ['', false],
  ])('%s is NOT a project-run command', (command) => {
    expect(isProjectRunCommand(command)).toBe(false);
  });
});

describe('checkBeforeProjectRun', () => {
  beforeEach(() => jest.clearAllMocks());

  test('passes through untouched for a non-run command (no syntax check even attempted)', async () => {
    const decision = await checkBeforeProjectRun('git status');
    expect(decision.blocked).toBe(false);
    expect(checkProjectSyntax).not.toHaveBeenCalled();
  });

  test('allows the run when every file is valid', async () => {
    checkProjectSyntax.mockResolvedValue({
      success: true,
      data: { filesChecked: 12, valid: true, failures: [] },
      error: null,
    });
    const decision = await checkBeforeProjectRun('npm start');
    expect(decision.blocked).toBe(false);
    expect(checkProjectSyntax).toHaveBeenCalledWith('');
  });

  test('blocks the run and reports the failing file when a syntax error exists', async () => {
    checkProjectSyntax.mockResolvedValue({
      success: true,
      data: {
        filesChecked: 12,
        valid: false,
        failures: [{ path: 'src/App.js', errors: [{ line: 10, column: 3, message: 'Unexpected token' }] }],
      },
      error: null,
    });
    const decision = await checkBeforeProjectRun('expo start');
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain('src/App.js');
    expect(decision.reason).toContain('line 10');
    expect(decision.failures).toHaveLength(1);
  });

  test('fails OPEN (never blocks) when no folder is granted / the scan itself fails', async () => {
    checkProjectSyntax.mockResolvedValue({ success: false, data: null, error: { message: 'No folder access granted.' } });
    const decision = await checkBeforeProjectRun('npm run build');
    expect(decision.blocked).toBe(false);
  });

  test('fails OPEN when there are simply no checkable files in the project', async () => {
    checkProjectSyntax.mockResolvedValue({ success: true, data: { filesChecked: 0, valid: true, failures: [] }, error: null });
    const decision = await checkBeforeProjectRun('npm start');
    expect(decision.blocked).toBe(false);
  });

  test('truncates the summary at 10 files and mentions how many more failed', async () => {
    const failures = Array.from({ length: 14 }, (_, i) => ({
      path: `src/file${i}.js`,
      errors: [{ line: 1, column: 1, message: 'Unexpected token' }],
    }));
    checkProjectSyntax.mockResolvedValue({ success: true, data: { filesChecked: 14, valid: false, failures }, error: null });
    const decision = await checkBeforeProjectRun('npm start');
    expect(decision.blocked).toBe(true);
    expect(decision.reason).toContain('and 4 more file(s)');
  });
});
