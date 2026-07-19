/**
 * ZAO - permissionModes.js tests
 *
 * Covers the decision function toolOrchestrator.js's flat ReAct loop
 * (GitHub/filesystem/office/PDF/terminal) checks before every single tool
 * call. A bug here has the same blast radius as a commandSafety.js bug -
 * it can silently let a destructive call through, or silently block a
 * harmless read - and previously had zero test coverage even though it's
 * the actual authority on which calls need a human in the loop.
 */

import { getToolPermissionDecision, isWriteTool, PERMISSION_MODES } from '../permissionModes';

describe('plan mode - hard read-only floor', () => {
  test.each([
    'fs_create_file', 'fs_delete', 'fs_edit_file',
    'github_commit_files', 'github_create_repo',
    'pdf_create', 'docx_create', 'xlsx_create', 'pptx_create',
    'terminal_pc_run_command', 'terminal_termux_run_command',
  ])('refuses %s outright, with no confirmation escape hatch', (toolName) => {
    const decision = getToolPermissionDecision(toolName, {}, 'plan');
    expect(decision.allowed).toBe(false);
    expect(decision.requiresConfirmation).toBe(false);
    expect(decision.reason).toBeTruthy();
  });

  test.each([
    'fs_read_file', 'fs_list_folder', 'fs_grep', 'fs_glob',
    'github_read_file', 'github_clone_repo',
    'web_search', 'time_get_current', 'todo_write',
  ])('still allows read/inspect tool %s', (toolName) => {
    const decision = getToolPermissionDecision(toolName, {}, 'plan');
    expect(decision.allowed).toBe(true);
  });
});

describe('default mode', () => {
  test('write tools require confirmation but are allowed', () => {
    const decision = getToolPermissionDecision('fs_create_file', {}, 'default');
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
  });

  test('destructive tools require confirmation', () => {
    const decision = getToolPermissionDecision('fs_delete', {}, 'default');
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
  });

  test('a GitHub write requires confirmation, same as a filesystem write', () => {
    const decision = getToolPermissionDecision('github_commit_files', { owner: 'a', repo: 'b', files: [], message: 'x' }, 'default');
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(true);
  });

  test('an office/PDF create requires confirmation', () => {
    for (const toolName of ['pdf_create', 'docx_create', 'xlsx_create', 'pptx_create', 'csv_create']) {
      const decision = getToolPermissionDecision(toolName, {}, 'default');
      expect(decision.requiresConfirmation).toBe(true);
    }
  });

  test('read tools never require confirmation', () => {
    const decision = getToolPermissionDecision('fs_read_file', { path: 'x.txt' }, 'default');
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(false);
  });

  test('a risky terminal command requires confirmation, a safe one does not', () => {
    const risky = getToolPermissionDecision('terminal_pc_run_command', { command: 'git push origin main' }, 'default');
    expect(risky.requiresConfirmation).toBe(true);

    const safe = getToolPermissionDecision('terminal_pc_run_command', { command: 'npm run build' }, 'default');
    expect(safe.allowed).toBe(true);
    expect(safe.requiresConfirmation).toBe(false);
  });

  test('a HARD_BLOCKED terminal command is refused, not just gated', () => {
    const decision = getToolPermissionDecision('terminal_pc_run_command', { command: 'rm -rf /' }, 'default');
    expect(decision.allowed).toBe(false);
    expect(decision.requiresConfirmation).toBe(false);
  });
});

describe('acceptEdits mode', () => {
  test('ordinary write tools auto-run without confirmation', () => {
    const decision = getToolPermissionDecision('fs_create_file', {}, 'acceptEdits');
    expect(decision.allowed).toBe(true);
    expect(decision.requiresConfirmation).toBe(false);
  });

  test('destructive tools still require confirmation (not covered by acceptEdits)', () => {
    const decision = getToolPermissionDecision('fs_delete', {}, 'acceptEdits');
    expect(decision.requiresConfirmation).toBe(true);
  });

  test('terminal commands still follow default RISKY rules', () => {
    const decision = getToolPermissionDecision('terminal_pc_run_command', { command: 'git push' }, 'acceptEdits');
    expect(decision.requiresConfirmation).toBe(true);
  });
});

describe('auto and bypassPermissions modes', () => {
  test.each(['auto', 'bypassPermissions'])('%s auto-runs write, destructive, and risky-terminal calls', (mode) => {
    expect(getToolPermissionDecision('fs_create_file', {}, mode).requiresConfirmation).toBe(false);
    expect(getToolPermissionDecision('fs_delete', {}, mode).requiresConfirmation).toBe(false);
    expect(getToolPermissionDecision('terminal_pc_run_command', { command: 'git push --force origin main' }, mode).requiresConfirmation).toBe(false);
  });

  test.each(['auto', 'bypassPermissions'])('%s still cannot override a HARD_BLOCKED command', (mode) => {
    const decision = getToolPermissionDecision('terminal_pc_run_command', { command: 'rm -rf /' }, mode);
    expect(decision.allowed).toBe(false);
  });
});

describe('isWriteTool', () => {
  test('true for write and destructive tools', () => {
    expect(isWriteTool('fs_create_file')).toBe(true);
    expect(isWriteTool('fs_delete')).toBe(true);
    expect(isWriteTool('github_commit_files')).toBe(true);
  });

  test('false for read/search/time/todo tools', () => {
    expect(isWriteTool('fs_read_file')).toBe(false);
    expect(isWriteTool('web_search')).toBe(false);
    expect(isWriteTool('time_get_current')).toBe(false);
  });
});

test('PERMISSION_MODES lists exactly the five documented modes', () => {
  expect(PERMISSION_MODES).toEqual(['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']);
});
