/**
 * ZAO - Syntax / JSX Check
 *
 * A REAL parser check (Babel's own parser - the same one Metro/Expo use
 * to build this app), not a heuristic like "does it have matching
 * braces?" - closes the specific gap this module exists for: previously
 * nothing stopped fs_create_file/fs_edit_file (filesystemTool.js) from
 * writing a file with a broken import, a stray JSX tag, or a dropped
 * bracket straight to disk. The person would only find out later, from
 * a Metro red-screen or a crash - the same failure mode Claude Code's own
 * Edit/Write tools avoid by construction.
 *
 * WHAT THIS CHECKS: real syntax - can the file be parsed at all - for
 * .js/.jsx/.mjs/.cjs/.ts/.tsx (JSX + TypeScript types both enabled, so
 * this never false-positives on either) and .json (JSON.parse). This is
 * NOT a linter (no unused-vars, no style rules, no type-checking beyond
 * "does the TS syntax itself parse") and NOT a bundler (no resolving
 * imports, no checking a module actually exists) - those need a real
 * toolchain (eslint/tsc) running via terminal_pc_run_command, which this
 * app doesn't bundle. This is
 * the same floor Claude Code's own tools guarantee before every write:
 * "what got saved is at least valid code," nothing more, nothing less.
 *
 * USED BY:
 *   - filesystemTool.js's createFile/editFile - automatically, on every
 *     write, before it touches disk. A failure here means nothing is
 *     written at all (fails closed) - the checkpoint is never even taken.
 *   - filesystemTool.js's checkFileSyntax/checkProjectSyntax - standalone,
 *     for checking a file the model didn't just write, exposed as the
 *     fs_check_syntax/fs_check_project_syntax tools.
 *   - projectRunGate.js - the pre-run gate that blocks
 *     terminal_pc_run_command from starting a
 *     broken project.
 */
import * as babelParser from '@babel/parser';

// jsx: needed for .js too, not just .jsx - Expo/RN projects routinely
// write JSX in plain .js files, and refusing to parse that would make
// this check actively wrong for a huge share of real files in this
// project's own src/screens, src/components, etc.
// typescript: only added for .ts/.tsx - mixing it into every file isn't
// free (it changes how a few ambiguous constructs like `<T>` are parsed)
// and .js/.jsx files in this codebase are never TypeScript.
const EXTENSION_PLUGINS = {
  js: ['jsx'],
  jsx: ['jsx'],
  mjs: ['jsx'],
  cjs: ['jsx'],
  ts: ['typescript'],
  tsx: ['typescript', 'jsx'],
};

const CODE_EXTENSIONS = new Set(Object.keys(EXTENSION_PLUGINS));

// Plugins for language features that are safe to enable unconditionally
// across every checkable extension - all long-stable stage-4 (or
// effectively so) JS features this codebase and any reasonable
// React Native/Expo project can use, that @babel/parser still requires
// opting into explicitly.
const COMMON_PLUGINS = [
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'objectRestSpread',
  'optionalChaining',
  'nullishCoalescingOperator',
  'dynamicImport',
  'exportDefaultFrom',
  'exportNamespaceFrom',
  'topLevelAwait',
  'optionalCatchBinding',
];

/**
 * Whether checkSyntax actually does anything for this path. Non-code
 * files (images, zips, .md, etc.) always report valid: true, skipped: true
 * without this being called - filesystemTool.js checks this first so it
 * doesn't waste time (or risk a false failure) parsing content that was
 * never meant to be JS/JSON in the first place.
 */
export function isCheckableFile(relativePath) {
  const ext = (relativePath || '').split('.').pop()?.toLowerCase();
  return CODE_EXTENSIONS.has(ext) || ext === 'json';
}

/**
 * Parses `content` as if it were the file at `relativePath` (extension
 * decides JSX/TypeScript plugins) and reports whether it's syntactically
 * valid.
 *
 * @param {string} relativePath - used only for its extension
 * @param {string} content - full file text to check
 * @returns {{valid: boolean, language: string|null, errors: Array<{line: number|null, column: number|null, message: string}>, skipped?: boolean}}
 */
export function checkSyntax(relativePath, content) {
  const ext = (relativePath || '').split('.').pop()?.toLowerCase();

  if (ext === 'json') {
    try {
      JSON.parse(content);
      return { valid: true, language: 'json', errors: [] };
    } catch (err) {
      return { valid: false, language: 'json', errors: [{ line: null, column: null, message: err.message }] };
    }
  }

  if (!CODE_EXTENSIONS.has(ext)) {
    return { valid: true, language: null, errors: [], skipped: true };
  }

  const plugins = Array.from(new Set([...COMMON_PLUGINS, ...EXTENSION_PLUGINS[ext]]));

  try {
    babelParser.parse(content, {
      sourceType: 'unambiguous', // accepts both ESM and CJS/script-style files without guessing wrong
      allowImportExportEverywhere: false,
      allowReturnOutsideFunction: false,
      errorRecovery: false, // a single real error, not a best-effort partial parse
      plugins,
    });
    return { valid: true, language: ext, errors: [] };
  } catch (err) {
    const loc = err.loc || {};
    return {
      valid: false,
      language: ext,
      errors: [{
        line: typeof loc.line === 'number' ? loc.line : null,
        column: typeof loc.column === 'number' ? loc.column + 1 : null, // Babel's column is 0-indexed; report 1-indexed like an editor gutter
        message: cleanBabelMessage(err.message),
      }],
    };
  }
}

// Babel appends its own "(line:column)" suffix to err.message, which is
// redundant once loc.line/loc.column are surfaced as separate fields.
function cleanBabelMessage(message) {
  return String(message || '').replace(/\s*\(\d+:\d+\)\s*$/, '').trim();
}

/**
 * Formats a checkSyntax() result into one human/model-readable block,
 * e.g. for a tool-result error message. Returns null when the result was
 * valid (nothing to format).
 */
export function formatSyntaxErrors(relativePath, result) {
  if (!result || result.valid) return null;
  const lines = (result.errors || []).map((e) => {
    const loc = e.line != null ? `line ${e.line}${e.column != null ? `, column ${e.column}` : ''}` : 'unknown location';
    return `  - ${loc}: ${e.message}`;
  });
  return `Syntax check failed for ${relativePath}:\n${lines.join('\n')}`;
}
