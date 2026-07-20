const { withAndroidManifest } = require('@expo/config-plugins');

// Needed for LAN mode (Settings > Backend Connection): the app talks
// directly to the PC's plain HTTP server (http://192.168.x.x:8080), which
// Android blocks by default on API 28+ without this. Remote mode (the
// Cloudflare Quick Tunnel) doesn't need this - the tunnel URL is HTTPS at
// Cloudflare's edge - but LAN mode has no tunnel/certificate in front of
// it, so this stays required as long as LAN mode exists.
function withCleartextTraffic(config) {
  return withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;
    const application = androidManifest.manifest.application[0];
    application.$['android:usesCleartextTraffic'] = 'true';
    return config;
  });
}

module.exports = withCleartextTraffic;