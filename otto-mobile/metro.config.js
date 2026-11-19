const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// The app imports the desktop's platform-agnostic code from ../src/shared
// (`@shared/*` in tsconfig.json), so Metro has to watch that folder too.
config.watchFolders = [...(config.watchFolders ?? []), path.resolve(__dirname, '../src/shared')];
// Resolve packages only from this app's node_modules, never the desktop's
// (../node_modules has its own React), even for files under ../src/shared.
config.resolver.nodeModulesPaths = [path.resolve(__dirname, 'node_modules')];
config.resolver.disableHierarchicalLookup = true;

module.exports = config;
