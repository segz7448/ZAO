/**
 * ZAO - PC File Pull Tool
 *
 * The PC and the phone are two separate filesystems. terminal_pc_run_command
 * (pcTerminalTool.js) runs real commands on the PC - npm install, gradlew
 * assembleRelease, a webpack build - and whatever those commands produce
 * (node_modules, a built .apk, a bundle) stays on the PC's own disk. It
 * is NOT automatically visible in the phone app or the SAF folder you
 * granted ZAO access to.
 *
 * This tool is the bridge for the common case: after running a PC build,
 * pull the actual output file down and save it into your phone project
 * folder, so it's somewhere you can install it, share it, or have the
 * agent work with it further on-device.
 *
 * Flow:
 *   1. (optional) pc_list_directory - see what a command actually produced
 *   2. pc_pull_file - fetch one specific file's bytes from the PC and
 *      write them into the phone's SAF folder at a path you choose
 *
 * Not meant for huge files - see PC_BRIDGE_MAX_FILE_BYTES in
 * server/config.js (200MB default, one plain HTTP response, no
 * chunking/streaming). A release APK is normally well under that.
 */

import { listPcDirectory, readPcFile } from '../backend/backendClient';
import * as filesystemTool from '../filesystem/filesystemTool';

/**
 * Lists a folder on the PC (relative to PC_BRIDGE_ROOT in server/config.js)
 * so the model can see what a build/command actually produced before
 * deciding what to pull.
 * @param {string} [relativePath]
 */
export async function listDirectory(relativePath = '') {
  const result = await listPcDirectory(relativePath);
  if (!result.success) return { success: false, data: null, error: result.error };
  return { success: true, data: result.data, error: null };
}

/**
 * Pulls one file from the PC (via /pc-fs/read) and saves it into the
 * phone's own SAF-granted folder at devicePath, using the same
 * checkpoint-before-write path as any other on-device file write.
 *
 * @param {string} pcPath - path on the PC, relative to PC_BRIDGE_ROOT
 * @param {string} devicePath - where to save it on the phone, relative to the granted SAF folder
 */
export async function pullFile(pcPath, devicePath) {
  const pcResult = await readPcFile(pcPath);
  if (!pcResult.success) return { success: false, data: null, error: pcResult.error };

  const { contentB64, size } = pcResult.data;
  const writeResult = await filesystemTool.writeBinaryFileFromBase64(devicePath, contentB64);
  if (!writeResult.success) return writeResult;

  return {
    success: true,
    data: { pcPath, devicePath, size, checkpointId: writeResult.data.checkpointId },
    error: null,
  };
}
