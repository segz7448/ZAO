const { withAndroidManifest } = require('@expo/config-plugins');

// Needed to reach the Alibaba Cloud VM (Settings > Server Connection):
// unless you've put a TLS certificate in front of the VM yourself (e.g. a
// reverse proxy with Let's Encrypt), the app talks to it over plain HTTP
// (http://<vm-ip>:8000), which Android blocks by default on API 28+
// without this. Safe to remove this plugin if you do set up HTTPS on the
// VM and switch the VM address in Settings to an https:// URL.
function withCleartextTraffic(config) {
  return withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;
    const application = androidManifest.manifest.application[0];
    application.$['android:usesCleartextTraffic'] = 'true';
    return config;
  });
}

module.exports = withCleartextTraffic;