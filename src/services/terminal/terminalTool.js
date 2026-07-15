/**
 * ZAO - Terminal Tool
 *
 * Runs REAL shell commands (npm install, pip install, gradlew
 * assembleRelease, unzip, etc.) via Termux's RUN_COMMAND API - not a
 * terminal-styled UI widget, not a fake command interpreter. Android
 * sandboxes every app with no shell, no /bin, no package managers, and
 * no JVM/Gradle/Python toolchain of its own. Termux only has real
 * command execution because it ships its own entire Linux userland as a
 * dedicated app; ZAO borrows that capability by asking Termux itself to
 * run the command, rather than trying to run it in-process.
 *
 * ============================================================================
 * DISPATCH: how this actually reaches Termux
 * ============================================================================
 * Termux's RUN_COMMAND is exposed as an Android SERVICE
 * (com.termux.app.RunCommandService, started via startService/
 * startForegroundService with an explicit Intent), not an Activity.
 * expo-intent-launcher only exposes startActivityAsync(), which cannot
 * reach a Service. That gap is closed by a small native module
 * (see plugins/withTermuxRunCommand) that exposes
 * NativeModules.TermuxRunCommand.startRunCommandService() to JS, wired
 * in automatically by an Expo config plugin on every `expo prebuild` /
 * CI build - no manual Android Studio step required.
 *
 * ============================================================================
 * ONE-TIME SETUP TERMUX ITSELF STILL REQUIRES (cannot be skipped)
 * ============================================================================
 * Termux enforces its own permission gate that no app, ZAO included, can
 * grant on its behalf:
 *   1. Termux:API / RUN_COMMAND must be allowed via
 *      ~/.termux/termux.properties containing `allow-external-apps=true`.
 *   2. Android's own runtime permission prompt ("Allow ZAO to run
 *      commands in Termux") must be accepted once.
 * getSetupCommand() below returns the single copy-pasteable command that
 * does step 1 (and reloads Termux's settings so it takes effect
 * immediately); step 2 is a normal Android permission dialog that
 * appears the first time a command is actually dispatched.
 */

import { NativeModules } from 'react-native';
import * as IntentLauncher from 'expo-intent-launcher';
import * as FileSystem from 'expo-file-system/legacy';

const { TermuxRunCommand } = NativeModules;

// Termux's RUN_COMMAND Intent requires the script and its I/O redirects
// to live somewhere Termux's own process can read/write - its home
// directory is the reliable, always-present choice (unlike an
// app-private directory, which Termux's separate process/UID cannot
// access at all).
const TERMUX_HOME = '/data/data/com.termux/files/home';
const ZAO_TERMUX_DIR = `${TERMUX_HOME}/.zao-terminal`;
const TERMUX_BASH = '/data/data/com.termux/files/usr/bin/bash';

const DEFAULT_TIMEOUT_MS = 120000; // 2 minutes - generous for npm/pip installs, still bounded
const POLL_INTERVAL_MS = 800;

function runId() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * The single one-time command Zenas pastes into Termux (once, ever, per
 * device) to let ZAO dispatch commands to it. This is Termux's own
 * permission gate - ZAO cannot flip it from the outside, only tell you
 * exactly what to run.
 */
export function getSetupCommand() {
  return 'mkdir -p ~/.termux && echo "allow-external-apps=true" >> ~/.termux/termux.properties && termux-reload-settings && echo ZAO_TERMUX_SETUP_OK';
}

/**
 * Sends one shell command to Termux for real execution, waits for it to
 * finish (or times out), and returns its actual stdout/stderr/exit code.
 *
 * @param {string} command - a real shell command, e.g. "npm install" or "cd /storage/emulated/0/Download/myproject && npm install"
 * @param {object} options - { timeoutMs, workingDirectory }
 */
export async function runCommand(command, options = {}) {
  const { timeoutMs = DEFAULT_TIMEOUT_MS, workingDirectory = null } = options;
  const id = runId();

  const scriptPath = `${ZAO_TERMUX_DIR}/${id}.sh`;
  const stdoutPath = `${ZAO_TERMUX_DIR}/${id}.stdout`;
  const stderrPath = `${ZAO_TERMUX_DIR}/${id}.stderr`;
  const exitCodePath = `${ZAO_TERMUX_DIR}/${id}.exitcode`;

  if (!TermuxRunCommand) {
    return {
      success: false,
      data: null,
      error: {
        message:
          'The native Termux bridge isn\'t in this build. Run `npx expo prebuild --platform android --clean` (or let the GitHub Actions workflow do it) so the withTermuxRunCommand plugin regenerates the android/ project, then rebuild the APK.',
      },
    };
  }

  try {
    const cdPrefix = workingDirectory ? `cd ${shellQuote(workingDirectory)} && ` : '';
    // Exit code is captured explicitly and written to its own file -
    // RUN_COMMAND doesn't surface a script's exit status back to the
    // calling app on its own, so this is done manually: run the real
    // command, capture $?, write it out, and ALWAYS write something to
    // that file (even on failure) so polling below has a reliable
    // "finished" signal to watch for.
    const scriptContent = `#!${TERMUX_BASH}
mkdir -p "${ZAO_TERMUX_DIR}"
${cdPrefix}(${command}) > "${stdoutPath}" 2> "${stderrPath}"
echo $? > "${exitCodePath}"
`;

    // Bootstrap: write the real script from Termux's own side (so it
    // lands somewhere Termux's process/UID actually owns), then execute
    // it. Both steps run as arguments to a single RUN_COMMAND dispatch.
    const bootstrapScript = `mkdir -p "${ZAO_TERMUX_DIR}" && cat > "${scriptPath}" << 'ZAO_EOF'\n${scriptContent}\nZAO_EOF\nchmod +x "${scriptPath}" && "${scriptPath}"`;

    const dispatch = await sendRunCommandIntent({
      executable: TERMUX_BASH,
      arguments: ['-c', bootstrapScript],
      workdir: workingDirectory || TERMUX_HOME,
    });

    if (!dispatch.success) {
      return { success: false, data: null, error: dispatch.error };
    }

    const result = await pollForCompletion(exitCodePath, stdoutPath, stderrPath, timeoutMs);
    return result;
  } catch (err) {
    return { success: false, data: null, error: { message: err?.message || 'Could not run this command.' } };
  }
}

/**
 * Sends the actual Android Intent to Termux's RunCommandService via the
 * native module. If Termux hasn't granted the RUN_COMMAND permission yet
 * (setup step not done, or the Android permission prompt was denied),
 * this rejects with a clear, actionable message rather than hanging.
 */
async function sendRunCommandIntent({ executable, arguments: args, workdir }) {
  try {
    await TermuxRunCommand.startRunCommandService(executable, args, workdir, true);
    return { success: true, error: null };
  } catch (err) {
    if (err?.code === 'TERMUX_PERMISSION_DENIED') {
      return {
        success: false,
        error: {
          message: `Termux hasn't granted ZAO permission yet. In Termux, run:\n\n${getSetupCommand()}\n\nThen try again - Android will show a one-time "Allow ZAO to run commands in Termux" prompt to accept.`,
        },
      };
    }
    return {
      success: false,
      error: { message: err?.message || 'Could not reach Termux. Make sure Termux is installed and open at least once.' },
    };
  }
}

/**
 * Polls for the exit-code file to appear (meaning the command finished),
 * then reads back the real stdout/stderr/exit code. This is the
 * necessary shape given RUN_COMMAND has no synchronous return value -
 * the command is genuinely running in the background the whole time
 * this function is polling.
 */
async function pollForCompletion(exitCodePath, stdoutPath, stderrPath, timeoutMs) {
  const startTime = Date.now();
  const exitCodeUri = `file://${exitCodePath}`;

  while (Date.now() - startTime < timeoutMs) {
    const info = await FileSystem.getInfoAsync(exitCodeUri).catch(() => ({ exists: false }));
    if (info.exists) {
      const [exitCodeStr, stdout, stderr] = await Promise.all([
        FileSystem.readAsStringAsync(exitCodeUri).catch(() => '1'),
        FileSystem.readAsStringAsync(`file://${stdoutPath}`).catch(() => ''),
        FileSystem.readAsStringAsync(`file://${stderrPath}`).catch(() => ''),
      ]);

      const exitCode = parseInt(exitCodeStr.trim(), 10);
      const succeeded = exitCode === 0;

      // Real success/failure, with the actual output either way - a
      // failing command (network down, wrong Node version, missing
      // dependency, etc.) is reported honestly with its real stderr,
      // never hidden or reframed as a success.
      return {
        success: succeeded,
        data: { stdout: stdout.trim(), stderr: stderr.trim(), exitCode },
        error: succeeded ? null : { message: stderr.trim() || `Command exited with code ${exitCode}`, exitCode },
      };
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }

  return {
    success: false,
    data: null,
    error: { message: `Command did not finish within ${Math.round(timeoutMs / 1000)}s - it may still be running in Termux, or Termux may not have received the command at all (check the one-time setup with getSetupCommand()).` },
  };
}

/**
 * Very basic shell-quoting for the workingDirectory option - wraps in
 * single quotes and escapes any embedded single quote. Not a substitute
 * for careful command construction generally (this tool executes
 * whatever string it's given, by design - see the file docstring), but
 * this specific path is the one value this module itself interpolates
 * into a larger command string, so it gets this minimal protection
 * against breaking the surrounding quoting.
 */
function shellQuote(value) {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Checks whether Termux is actually installed via PackageManager (native
 * module), rather than the previous approach of only finding out by
 * attempting to open it.
 */
export async function isTermuxInstalled() {
  if (!TermuxRunCommand) return null;
  try {
    return await TermuxRunCommand.isTermuxAvailable();
  } catch {
    return null;
  }
}

/**
 * Opens Termux itself so the person can run the one-time setup command
 * (see getSetupCommand()) that grants ZAO's RUN_COMMAND permission -
 * Termux enforces this itself and ZAO cannot grant it on Termux's
 * behalf, only guide the person to where they do it themselves.
 */
export async function openTermuxForSetup() {
  try {
    await IntentLauncher.startActivityAsync('android.intent.action.MAIN', {
      packageName: 'com.termux',
      className: 'com.termux.app.TermuxActivity',
    });
    return { success: true, error: null };
  } catch (err) {
    return {
      success: false,
      error: { message: 'Could not open Termux - it may not be installed. Install it from F-Droid or GitHub (not the outdated Play Store version) first.' },
    };
  }
}
