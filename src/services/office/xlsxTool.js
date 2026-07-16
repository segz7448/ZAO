/**
 * ZAO - XLSX / CSV Tool
 *
 * Creates spreadsheets using SheetJS (the `xlsx` npm package) - a
 * pure-JavaScript library, same reasoning as pdf-lib/docx-js elsewhere in
 * this tool suite: there's no Python runtime on-device for openpyxl/
 * pandas, which is what Claude's own sandbox would normally reach for
 * (see /mnt/skills/public/xlsx/SKILL.md).
 *
 * HONEST LIMITATION: like the PDF/DOCX tools, SheetJS's behavior under
 * Hermes specifically hasn't been runtime-verified here - it's a
 * long-established, dependency-light JS library commonly used in React
 * Native projects, but that's not the same as confirmed-working on this
 * exact device/build.
 *
 * FORMULAS: cells can be given as literal values OR as formula strings
 * (e.g. "=SUM(B2:B9)") - matching the source skill's own principle of
 * "use formulas, never hardcoded results" so a sheet stays correct if its
 * inputs change. SheetJS writes the formula string into the cell but,
 * like openpyxl, does NOT calculate and cache a value for it - most
 * spreadsheet apps recalculate on open, but this is worth knowing rather
 * than assuming a formula cell will show a number before the file is
 * actually opened once.
 *
 * SCOPE: single or multiple sheets, header row + data rows, optional
 * formulas. No charts, pivot tables, or cell styling/conditional
 * formatting - a meaningfully larger effort than this pass covers.
 */

import * as XLSX from 'xlsx';
import { getOrCreateFileUriForTools } from '../filesystem/filesystemTool';
import * as FileSystem from 'expo-file-system/legacy';

/**
 * Creates a new .xlsx workbook from one or more sheets of tabular data.
 *
 * @param {Array<{name: string, headers: string[], rows: Array<Array<string|number>>}>} sheets
 *   Each cell in `rows` can be a plain value, or a string starting with
 *   "=" to write it as a live formula instead of a literal value.
 * @param {string} outputPath - relative to the granted filesystem folder, e.g. "budget.xlsx"
 */
export async function createXlsx(sheets, outputPath) {
  try {
    const workbook = XLSX.utils.book_new();

    for (const sheet of sheets) {
      const aoa = [sheet.headers, ...sheet.rows];
      const worksheet = XLSX.utils.aoa_to_sheet(aoa);

      // aoa_to_sheet writes every value as a literal by default, including
      // strings that look like formulas - re-walk the data rows (skipping
      // the header row) and convert any "=..." string into a real formula
      // cell (SheetJS represents that as {f: 'SUM(B2:B9)'} without the
      // leading '=', not a literal string value).
      sheet.rows.forEach((row, rowIndex) => {
        row.forEach((cellValue, colIndex) => {
          if (typeof cellValue === 'string' && cellValue.startsWith('=')) {
            const cellRef = XLSX.utils.encode_cell({ r: rowIndex + 1, c: colIndex }); // +1 to skip header row
            worksheet[cellRef] = { f: cellValue.slice(1), t: 'n' };
          }
        });
      });

      // Sheet names have real constraints (max 31 chars, no []:*?/\) -
      // sanitize rather than let a natural name like "Q1 Report/Draft"
      // silently produce a broken workbook.
      const safeName = (sheet.name || 'Sheet1').replace(/[\[\]:*?/\\]/g, '-').slice(0, 31);
      XLSX.utils.book_append_sheet(workbook, worksheet, safeName);
    }

    // 'base64' output type - the universal on-device serialization format
    // used consistently across pdfTool.js/docxTool.js/this file, since it
    // writes cleanly through expo-file-system regardless of binary
    // content, without needing Node's Buffer or a real browser Blob.
    const base64 = XLSX.write(workbook, { type: 'base64', bookType: 'xlsx' });

    const resolved = await getOrCreateFileUriForTools(
      outputPath,
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
    );
    if (!resolved.success) return { success: false, data: null, error: resolved.error };

    await FileSystem.writeAsStringAsync(resolved.data.uri, base64, { encoding: FileSystem.EncodingType.Base64 });

    return { success: true, data: { path: outputPath, sheetCount: sheets.length }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Could not create spreadsheet.' } };
  }
}

/**
 * Creates a plain .csv file from one table of data - simpler and more
 * broadly compatible than xlsx when the person just needs a flat data
 * export, not a real workbook.
 *
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 * @param {string} outputPath
 */
export async function createCsv(headers, rows, outputPath) {
  try {
    const worksheet = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const csvString = XLSX.utils.sheet_to_csv(worksheet);

    const resolved = await getOrCreateFileUriForTools(outputPath, 'text/csv');
    if (!resolved.success) return { success: false, data: null, error: resolved.error };

    await FileSystem.writeAsStringAsync(resolved.data.uri, csvString, { encoding: FileSystem.EncodingType.UTF8 });

    return { success: true, data: { path: outputPath, rowCount: rows.length }, error: null };
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Could not create CSV.' } };
  }
}
