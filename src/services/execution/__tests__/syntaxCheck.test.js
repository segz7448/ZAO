/**
 * ZAO - syntaxCheck.js tests
 *
 * Covers the real-parser gate that filesystemTool.js's createFile/editFile
 * run automatically before every write (see that file), plus the
 * standalone fs_check_syntax/fs_check_project_syntax tools and
 * projectRunGate.js's pre-run gate - a bug here either lets broken code
 * get saved/run, or false-positives on genuinely valid code and blocks
 * the person's legitimate work, so both directions are covered below.
 */

import { isCheckableFile, checkSyntax, formatSyntaxErrors } from '../syntaxCheck';

describe('isCheckableFile', () => {
  test.each(['App.js', 'src/screens/ChatScreen.js', 'component.jsx', 'types.ts', 'Screen.tsx', 'data.json', 'index.mjs', 'config.cjs'])(
    '%s is checkable',
    (path) => expect(isCheckableFile(path)).toBe(true)
  );

  test.each(['README.md', 'notes.txt', 'icon.png', 'archive.zip', 'styles.css', 'noextension'])(
    '%s is not checkable',
    (path) => expect(isCheckableFile(path)).toBe(false)
  );
});

describe('checkSyntax - valid code', () => {
  test('plain JS', () => {
    const result = checkSyntax('utils.js', 'export function add(a, b) { return a + b; }');
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  test('JSX in a .js file (common in this codebase)', () => {
    const result = checkSyntax('src/components/Button.js', `
      import React from 'react';
      export default function Button({ label, onPress }) {
        return <TouchableOpacity onPress={onPress}><Text>{label}</Text></TouchableOpacity>;
      }
    `);
    expect(result.valid).toBe(true);
  });

  test('JSX in a .jsx file', () => {
    const result = checkSyntax('Card.jsx', 'export const Card = () => <View><Text>hi</Text></View>;');
    expect(result.valid).toBe(true);
  });

  test('TypeScript in a .ts file', () => {
    const result = checkSyntax('types.ts', 'export interface User { id: string; age: number; }');
    expect(result.valid).toBe(true);
  });

  test('TSX (TypeScript + JSX)', () => {
    const result = checkSyntax('Screen.tsx', `
      type Props = { title: string };
      export const Screen = ({ title }: Props) => <Text>{title}</Text>;
    `);
    expect(result.valid).toBe(true);
  });

  test('modern JS features (optional chaining, nullish coalescing, spread)', () => {
    const result = checkSyntax('modern.js', `
      const value = obj?.a?.b ?? 'default';
      const merged = { ...a, ...b };
      class Foo { #private = 1; static bar = 2; }
      async function f() { await Promise.resolve(); }
    `);
    expect(result.valid).toBe(true);
  });

  test('valid JSON', () => {
    const result = checkSyntax('data.json', '{"a": 1, "b": [1, 2, 3]}');
    expect(result.valid).toBe(true);
    expect(result.language).toBe('json');
  });

  test('non-code file is skipped, not flagged invalid', () => {
    const result = checkSyntax('README.md', 'this is #not# {valid js at all');
    expect(result.valid).toBe(true);
    expect(result.skipped).toBe(true);
  });
});

describe('checkSyntax - invalid code (the whole point of this module)', () => {
  test('dropped closing brace', () => {
    const result = checkSyntax('broken.js', 'function add(a, b) { return a + b;');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0].line).toBeGreaterThan(0);
  });

  test('unclosed JSX tag', () => {
    const result = checkSyntax('Broken.jsx', 'export const X = () => <View><Text>hi</View>;');
    expect(result.valid).toBe(false);
  });

  test('stray extra closing brace', () => {
    const result = checkSyntax('broken2.js', 'const x = 1; }');
    expect(result.valid).toBe(false);
  });

  test('invalid JSON', () => {
    const result = checkSyntax('bad.json', '{"a": 1,}');
    expect(result.valid).toBe(false);
    expect(result.language).toBe('json');
  });

  test('reports a usable line number for a multi-line file', () => {
    const content = ['const a = 1;', 'const b = 2;', 'function broken( {', 'return a + b;', '}'].join('\n');
    const result = checkSyntax('multiline.js', content);
    expect(result.valid).toBe(false);
    expect(result.errors[0].line).toBeGreaterThanOrEqual(3);
  });
});

describe('formatSyntaxErrors', () => {
  test('returns null for a valid result', () => {
    expect(formatSyntaxErrors('ok.js', { valid: true, errors: [] })).toBeNull();
  });

  test('formats line/column/message for an invalid result', () => {
    const result = checkSyntax('broken.js', 'function f( {');
    const formatted = formatSyntaxErrors('broken.js', result);
    expect(formatted).toContain('broken.js');
    expect(formatted).toMatch(/line \d+/);
  });
});
