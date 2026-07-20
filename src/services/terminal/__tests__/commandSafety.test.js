/**
 * ZAO - commandSafety.js tests
 *
 * This is the gate the person's HARDENING_NOTES.md issue calls out by
 * name: "a silent bug in commandSafety.js won't be caught before it
 * ships." Both terminal tools execute whatever string they're handed, so
 * a false negative here (a destructive command that should be blocked or
 * flagged risky but isn't) is a real data-loss bug, not a cosmetic one -
 * and a false positive (blocking something harmless) breaks the app for
 * legitimate use. Both directions are worth locking down with tests.
 */

import { checkCommandSafety, HARD_BLOCKED_PATTERNS, RISKY_TERMINAL_PATTERNS } from '../commandSafety';

describe('checkCommandSafety - HARD_BLOCKED tier', () => {
  test.each([
    'rm -rf /',
    'rm -rf / ',
    'sudo rm -rf /',
    'rm -rf /*',
    'mkfs.ext4 /dev/sda1',
    'dd if=/dev/zero of=/dev/sda',
    'format c:',
    'FORMAT C:',
    ':(){ :|:& };:',
  ])('blocks catastrophic command: %s', (cmd) => {
    const result = checkCommandSafety(cmd);
    expect(result.blocked).toBe(true);
    expect(result.reason).toBeTruthy();
  });

  test('blocking is not bypassable by risky-tier confirmation - blocked implies risky true too', () => {
    // The gate's own contract (see checkCommandSafety's JSDoc): a blocked
    // command also reports risky: true, so a caller that only checks
    // `.risky` before deciding to prompt-and-run can never accidentally
    // treat a HARD_BLOCKED command as merely "needs confirmation".
    const result = checkCommandSafety('rm -rf /');
    expect(result.risky).toBe(true);
  });
});

describe('checkCommandSafety - does not over-block similar-looking safe commands', () => {
  test.each([
    ['rm -rf ./build', 'relative path delete'],
    ['rm -rf /home/user/project/node_modules', 'delete inside a real subdirectory'],
    ['rm -rf /tmp/scratch', 'delete inside /tmp'],
    ['npm install', 'package install'],
    ['git status', 'read-only git command'],
    ['ls -la /', 'listing root, not wiping it'],
    ['echo "format c: is dangerous"', 'command that merely mentions format c: in a string'],
  ])('does not hard-block: %s (%s)', (cmd) => {
    expect(checkCommandSafety(cmd).blocked).toBe(false);
  });
});

describe('checkCommandSafety - RISKY tier', () => {
  test.each([
    'rm -rf ./dist',
    'rmdir old-folder',
    'del /f /q file.txt',
    'rd /s old-folder',
    'DROP TABLE users;',
    'drop database prod',
    'truncate table sessions',
    'git push origin main',
    'git push --force origin main',
    'git reset --hard HEAD~1',
    'shutdown -h now',
    'reboot',
    'diskpart',
  ])('flags as risky (needs confirmation): %s', (cmd) => {
    const result = checkCommandSafety(cmd);
    expect(result.blocked).toBe(false);
    expect(result.risky).toBe(true);
    expect(result.reason).toBeTruthy();
  });
});

describe('checkCommandSafety - safe tier', () => {
  test.each([
    'ls -la',
    'cat package.json',
    'npm run build',
    'git status',
    'git add .',
    'git commit -m "wip"',
    'pip install requests',
    'node index.js',
  ])('allows freely, no confirmation needed: %s', (cmd) => {
    const result = checkCommandSafety(cmd);
    expect(result.blocked).toBe(false);
    expect(result.risky).toBe(false);
    expect(result.reason).toBeNull();
  });
});

describe('checkCommandSafety - input robustness', () => {
  test('handles empty/undefined/null command without throwing', () => {
    expect(() => checkCommandSafety('')).not.toThrow();
    expect(() => checkCommandSafety(undefined)).not.toThrow();
    expect(() => checkCommandSafety(null)).not.toThrow();
    expect(checkCommandSafety(undefined).blocked).toBe(false);
  });

  test('is case-insensitive (a model or injected instruction may vary casing)', () => {
    expect(checkCommandSafety('RM -RF /').blocked).toBe(true);
    expect(checkCommandSafety('Git Push Origin Main').risky).toBe(true);
  });
});

describe('single source of truth (module header contract)', () => {
  test('exports the raw pattern lists so riskClassifier.js can re-export rather than duplicate them', () => {
    expect(Array.isArray(HARD_BLOCKED_PATTERNS)).toBe(true);
    expect(Array.isArray(RISKY_TERMINAL_PATTERNS)).toBe(true);
    expect(HARD_BLOCKED_PATTERNS.length).toBeGreaterThan(0);
    expect(RISKY_TERMINAL_PATTERNS.length).toBeGreaterThan(0);
  });
});
