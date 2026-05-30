// No-op babel plugin shim for react-native-worklets/plugin.
// react-native-css-interop (via nativewind) unconditionally adds this plugin,
// but we don't use worklets and don't want the native module compiled.
module.exports = function () {
  return { visitor: {} };
};
