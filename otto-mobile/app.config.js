// Dynamic layer over app.json (which keeps the static config). Release builds take their version
// from the environment so the iOS app, the desktop app and the `v*` tag share one version:
//
//   OTTO_APP_VERSION   x.y.z: the app version (CFBundleShortVersionString), and with the
//                      "appVersion" policy also the EAS Update runtime version. ios.yml sets it
//                      from the tag, ota.yml from the native release it updates. Default: app.json.
//   OTTO_BUILD_NUMBER  The build number (CFBundleVersion). Default: app.json / Expo's default.
//   EXPO_PROJECT_ID    The EAS project ID (`eas init`), or put it in app.json at
//                      expo.extra.eas.projectId. Without one, expo-updates is disabled and the app
//                      runs the JS bundle embedded in the build, exactly as before expo-updates.
//
// Over-the-air updates: builds ask https://u.expo.dev/<project> on the "production" channel for
// updates made for their runtime version (= app version), download them in the background and
// run them on the next launch. See ota.yml.

module.exports = ({ config }) => {
  const version = process.env.OTTO_APP_VERSION || config.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) {
    throw new Error(`OTTO_APP_VERSION must be x.y.z, got "${version}"`);
  }
  const buildNumber = process.env.OTTO_BUILD_NUMBER || config.ios?.buildNumber;
  const projectId = process.env.EXPO_PROJECT_ID || config.extra?.eas?.projectId;

  return {
    ...config,
    version,
    ios: { ...config.ios, ...(buildNumber ? { buildNumber: String(buildNumber) } : {}) },
    runtimeVersion: { policy: 'appVersion' },
    updates: {
      ...config.updates,
      enabled: Boolean(projectId),
      ...(projectId ? { url: `https://u.expo.dev/${projectId}` } : {}),
      // Builds made with xcodebuild after `expo prebuild` don't get a channel from eas.json.
      requestHeaders: { 'expo-channel-name': 'production' },
    },
    extra: {
      ...config.extra,
      ...(projectId ? { eas: { ...config.extra?.eas, projectId } } : {}),
    },
  };
};
