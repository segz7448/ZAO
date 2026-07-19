/**
 * ZAO - Data Analysis Tool (client side)
 *
 * The other half of server/data.js / scripts/data_analyze.py. Reads a
 * CSV/XLSX file already sitting in the person's granted filesystem
 * folder (same SAF access every other filesystem tool uses -
 * filesystemTool.js) and sends it to the PC backend for real pandas
 * analysis - this file itself does no data processing, it's the same
 * thin { success, data, error } wrapper every other backend-calling tool
 * module in this repo uses (compare webSearchTool.js).
 */

import * as FileSystem from 'expo-file-system/legacy';
import { getExistingFileUriForTools } from '../filesystem/filesystemTool';
import { runDataAnalysis } from '../backend/backendClient';

/**
 * @param {string} relativePath - path to the .csv/.tsv/.xlsx/.xls file, relative to the granted folder
 * @param {object} options - { operation: 'describe'|'head'|'filter'|'groupby', sheet, n, filter: {column,op,value}, groupby: {by,agg} } - see server/scripts/data_analyze.py's header for the full shape
 * @returns {Promise<{success, data: {shape, columns, dtypes, result}|null, error}>}
 */
export async function analyzeFile(relativePath, options = {}) {
  const resolved = await getExistingFileUriForTools(relativePath);
  if (!resolved.success) return resolved;

  let base64;
  try {
    base64 = await FileSystem.readAsStringAsync(resolved.data.uri, { encoding: FileSystem.EncodingType.Base64 });
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || `Could not read ${relativePath}.` } };
  }

  return runDataAnalysis(base64, relativePath, options);
}
