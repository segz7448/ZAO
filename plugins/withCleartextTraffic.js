const { withAndroidManifest } = require('@expo/config-plugins');

function withCleartextTraffic(config) {
  return withAndroidManifest(config, (config) => {
    const androidManifest = config.modResults;
    const application = androidManifest.manifest.application[0];
    application.$['android:usesCleartextTraffic'] = 'true';
    return config;
  });
}

module.exports = withCleartextTraffic;