/**
 * ZAO - Data Analysis Tool (client side)
 *
 * The other half of server/data.js / scripts/data_analyze.py. Reads a
 * CSV/XLSX file already sitting on the PC backend (PC_BRIDGE_ROOT - same
 * place every pc_* filesystem tool writes to, see pcFilesystemTool.js)
 * and sends it to the PC backend for real pandas analysis - this file
 * itself does no data processing, it's the same thin
 * { success, data, error } wrapper every other backend-calling tool
 * module in this repo uses (compare webSearchTool.js).
 *
 * Changed from its original on-device SAF read - see the pcfiles/fs-file
 * split in toolOrchestrator.js. A file the person wants analyzed now
 * needs to be on the PC (e.g. via pc_create_file, or pulled in some other
 * way), not just sitting in the phone's granted folder.
 */

import { readPcFile, runDataAnalysis } from '../backend/backendClient';

/**
 * @param {string} relativePath - path to the .csv/.tsv/.xlsx/.xls file, relative to PC_BRIDGE_ROOT
 * @param {object} options - { operation: 'describe'|'head'|'filter'|'groupby', sheet, n, filter: {column,op,value}, groupby: {by,agg} } - see server/scripts/data_analyze.py's header for the full shape
 * @returns {Promise<{success, data: {shape, columns, dtypes, result}|null, error}>}
 */
export async function analyzeFile(relativePath, options = {}) {
  const resolved = await readPcFile(relativePath);
  if (!resolved.success) return { success: false, data: null, error: resolved.error };

  return runDataAnalysis(resolved.data.contentB64, relativePath, options);
}
