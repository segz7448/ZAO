#!/usr/bin/env python3
"""
ZAO - Data analysis (pandas)

Reads one CSV/XLSX file path from argv[1] and a JSON options string from
argv[2], runs one pandas operation against it, and prints a single JSON
result to stdout. Called by server/data.js as a subprocess - same shape
as ocr_extract.py: errors are reported IN the JSON, not as a Python
traceback, so the Node side can always parse stdout either way.

This exists because xlsxTool.js's own header is explicit that SheetJS
(pure JS, used for CREATING spreadsheets on-device) is not a substitute
for actually ANALYZING tabular data - filtering, grouping, real
statistics - which is what a normal Claude sandbox would reach for
pandas/openpyxl for (see /mnt/skills/public/xlsx/SKILL.md). There's no
Python runtime on the phone, so this runs on the PC backend instead,
exactly like OCR does.

DELIBERATELY NOT ARBITRARY CODE EXECUTION: `terminal_pc_run_command`
already gives the model a real Python REPL if it truly needs one - this
script does NOT expose pandas.eval/exec or a raw query string built
directly from model output. Every operation is one of a small fixed set
(describe/head/filter/groupby), with structured JSON parameters, so this
tool can't become a second, ungated way to run arbitrary code under a
different name. `filter`'s `op` is restricted to a fixed comparison
whitelist for the same reason (see COMPARISONS below) - no operator
string is ever passed to eval().

Install once on the PC:
    pip install pandas openpyxl

Usage:
    python data_analyze.py <path-to-csv-or-xlsx> <options-json>

Output (stdout, single JSON object, always):
    {
      "success": bool,
      "shape": [rows, cols] | null,
      "columns": [str] | null,
      "dtypes": {str: str} | null,
      "result": { "columns": [str], "rows": [[...]], "truncated": bool } | null,
      "error": str | null
    }
"""

import sys
import json
import operator

MAX_ROWS_DEFAULT = 50
MAX_ROWS_CAP = 200

# Fixed whitelist, never eval()'d - see module header.
COMPARISONS = {
    '==': operator.eq,
    '!=': operator.ne,
    '>': operator.gt,
    '<': operator.lt,
    '>=': operator.ge,
    '<=': operator.le,
}


def fail(message):
    print(json.dumps({
        'success': False, 'shape': None, 'columns': None, 'dtypes': None,
        'result': None, 'error': message,
    }))
    sys.exit(0)  # exit 0 - the JSON's success:false is the real signal, matching ocr_extract.py's convention


def load_dataframe(path, sheet):
    import pandas as pd
    lower = path.lower()
    if lower.endswith('.csv') or lower.endswith('.tsv'):
        sep = '\t' if lower.endswith('.tsv') else ','
        return pd.read_csv(path, sep=sep)
    if lower.endswith('.xlsx') or lower.endswith('.xls'):
        return pd.read_excel(path, sheet_name=sheet or 0, engine='openpyxl' if lower.endswith('.xlsx') else None)
    raise ValueError(f'Unsupported file type: {path} (only .csv, .tsv, .xlsx, .xls are supported)')


def to_native(value):
    """Converts a numpy scalar (np.int64, np.float64, np.bool_, ...) to a
    plain Python type so json.dumps can serialize it. Needed specifically
    for describe()'s transposed output, whose .values array keeps numpy
    scalars boxed as-is (unlike a plain read_csv frame's .values.tolist(),
    which already comes out as native Python types) - found by actually
    running this script against a test CSV rather than assuming pandas'
    behavior was uniform across code paths.
    """
    if hasattr(value, 'item'):
        try:
            return value.item()
        except (ValueError, TypeError):
            return str(value)
    return value


def frame_to_result(df, max_rows):
    capped = df.head(max_rows)
    # NaN isn't valid JSON - pandas' own to_json would emit `NaN` literally,
    # which most JSON parsers (including JS's) reject, so this goes through
    # a plain-Python round-trip (via .where + None) instead of df.to_json().
    safe = capped.astype(object).where(capped.notna(), None)
    return {
        'columns': [str(c) for c in df.columns],
        'rows': [[to_native(v) for v in row] for row in safe.values.tolist()],
        'truncated': len(df) > max_rows,
    }


def op_describe(df, opts):
    desc = df.describe(include='all').transpose()
    desc = desc.astype(object).where(desc.notna(), None)
    return {
        'columns': ['column'] + [str(c) for c in desc.columns],
        'rows': [[str(idx)] + [to_native(v) for v in row] for idx, row in zip(desc.index, desc.values.tolist())],
        'truncated': False,
    }


def op_head(df, opts):
    n = min(int(opts.get('n', MAX_ROWS_DEFAULT)), MAX_ROWS_CAP)
    return frame_to_result(df, n)


def op_filter(df, opts):
    f = opts.get('filter') or {}
    column, op_name, value = f.get('column'), f.get('op'), f.get('value')
    if column not in df.columns:
        raise ValueError(f'Unknown column "{column}" - available columns: {list(df.columns)}')
    if op_name == 'contains':
        filtered = df[df[column].astype(str).str.contains(str(value), case=False, na=False)]
    else:
        fn = COMPARISONS.get(op_name)
        if not fn:
            raise ValueError(f'Unsupported filter op "{op_name}" - use one of {list(COMPARISONS.keys()) + ["contains"]}')
        filtered = df[fn(df[column], value)]
    n = min(int(opts.get('n', MAX_ROWS_DEFAULT)), MAX_ROWS_CAP)
    return frame_to_result(filtered, n)


def op_groupby(df, opts):
    g = opts.get('groupby') or {}
    by = g.get('by') or []
    agg = g.get('agg') or {}
    missing = [c for c in list(by) + list(agg.keys()) if c not in df.columns]
    if missing:
        raise ValueError(f'Unknown column(s) {missing} - available columns: {list(df.columns)}')
    grouped = df.groupby(by).agg(agg).reset_index()
    n = min(int(opts.get('n', MAX_ROWS_DEFAULT)), MAX_ROWS_CAP)
    return frame_to_result(grouped, n)


OPERATIONS = {
    'describe': op_describe,
    'head': op_head,
    'filter': op_filter,
    'groupby': op_groupby,
}


def main():
    if len(sys.argv) < 2:
        fail('Missing file path argument.')

    path = sys.argv[1]
    try:
        opts = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else {}
    except json.JSONDecodeError as e:
        fail(f'Could not parse options JSON: {e}')
        return

    operation = opts.get('operation', 'describe')
    handler = OPERATIONS.get(operation)
    if not handler:
        fail(f'Unsupported operation "{operation}" - use one of {list(OPERATIONS.keys())}')
        return

    try:
        df = load_dataframe(path, opts.get('sheet'))
    except Exception as e:
        fail(f'Could not read {path}: {e}')
        return

    try:
        result = handler(df, opts)
    except Exception as e:
        fail(f'"{operation}" failed: {e}')
        return

    print(json.dumps({
        'success': True,
        'shape': list(df.shape),
        'columns': [str(c) for c in df.columns],
        'dtypes': {str(c): str(t) for c, t in df.dtypes.items()},
        'result': result,
        'error': None,
    }))


if __name__ == '__main__':
    main()
