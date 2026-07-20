/**
 * Expo config plugin: withTermuxRunCommand
 *
 * Makes `expo prebuild` (and the GitHub Actions build that runs it)
 * automatically:
 *   1. Copy the native Kotlin module + package into the generated
 *      android/ project.
 *   2. Register TermuxRunCommandPackage in MainApplication so it's
 *      available to JS as NativeModules.TermuxRunCommand.
 *   3. Add the com.termux.permission.RUN_COMMAND permission to
 *      AndroidManifest.xml, which Termux requires from any app that
 *      wants to dispatch RUN_COMMAND to it.
 *
 * This means Zenas never has to touch Android Studio or hand-edit the
 * generated android/ folder - it's regenerated correctly on every
 * prebuild/CI run, the same way the rest of this app's native config
 * already works.
 */
const { withMainApplication, withAndroidManifest, withDangerousMod } = require('@expo/config-plugins');
const fs = require('fs');
const path = require('path');

const PACKAGE_PATH = 'com/zenas/zao/termux';
const FILES = ['TermuxRunCommandModule.kt', 'TermuxRunCommandPackage.kt'];

function withTermuxNativeSources(config) {
  return withDangerousMod(config, [
    'android',
    async (config) => {
      const srcDir = path.join(__dirname, 'android/src/main/java', PACKAGE_PATH);
      const destDir = path.join(
        config.modRequest.platformProjectRoot,
        'app/src/main/java',
        PACKAGE_PATH
      );
      fs.mkdirSync(destDir, { recursive: true });
      for (const file of FILES) {
        fs.copyFileSync(path.join(srcDir, file), path.join(destDir, file));
      }
      return config;
    },
  ]);
}

function withTermuxPackageRegistration(config) {
  return withMainApplication(config, (config) => {
    let contents = config.modResults.contents;
    const importLine = 'import com.zenas.zao.termux.TermuxRunCommandPackage';
    const addLine = '              add(TermuxRunCommandPackage())';

    if (!contents.includes(importLine)) {
      contents = contents.replace(
        /^(package [^\n]+\n)/,
        `$1\n${importLine}\n`
      );
    }

    if (!contents.includes('TermuxRunCommandPackage()')) {
      // MainApplication's PackageList already has a
      // `packages.apply { ... }` block (or similar) where other manually
      // added packages go, per Expo's default template.
      if (contents.includes('packages.apply {')) {
        contents = contents.replace(
          'packages.apply {',
          `packages.apply {\n${addLine}`
        );
      } else {
        // Fallback for template variations: insert right after
        // `PackageList(this).packages` is first assigned.
        contents = contents.replace(
          /(val packages = PackageList\(this\)\.packages\n)/,
          `$1${addLine.trim().replace('add', 'packages.add')}\n`
        );
      }
    }

    config.modResults.contents = contents;
    return config;
  });
}

function withTermuxManifestPermission(config) {
  return withAndroidManifest(config, (config) => {
    const manifest = config.modResults.manifest;
    if (!manifest['uses-permission']) {
      manifest['uses-permission'] = [];
    }
    const already = manifest['uses-permission'].some(
      (p) => p.$?.['android:name'] === 'com.termux.permission.RUN_COMMAND'
    );
    if (!already) {
      manifest['uses-permission'].push({
        $: { 'android:name': 'com.termux.permission.RUN_COMMAND' },
      });
    }

    // Android 11+ (API 30+) package visibility: without this <queries>
    // entry, PackageManager.getPackageInfo("com.termux", ...) throws
    // NameNotFoundException even when Termux IS installed - the OS
    // simply hides other apps' existence unless declared here. This is
    // what was causing isTermuxAvailable() to resolve `false` (and the
    // Settings screen to show "Termux not installed") on real devices
    // even with Termux installed, running, and already set up.
    if (!manifest.queries) {
      manifest.queries = [{}];
    }
    if (!Array.isArray(manifest.queries)) {
      manifest.queries = [manifest.queries];
    }
    if (manifest.queries.length === 0) {
      manifest.queries.push({});
    }
    const queriesNode = manifest.queries[0];
    if (!queriesNode.package) {
      queriesNode.package = [];
    }
    const alreadyQueried = queriesNode.package.some(
      (p) => p.$?.['android:name'] === 'com.termux'
    );
    if (!alreadyQueried) {
      queriesNode.package.push({ $: { 'android:name': 'com.termux' } });
    }

    return config;
  });
}

module.exports = function withTermuxRunCommand(config) {
  config = withTermuxNativeSources(config);
  config = withTermuxPackageRegistration(config);
  config = withTermuxManifestPermission(config);
  return config;
};
