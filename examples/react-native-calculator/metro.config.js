const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [repoRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(repoRoot, 'node_modules'),
];

// The Rustra generator emits `.js` specifiers so the generated clients are
// valid ESM after TypeScript compilation. Metro resolves source files by
// extension, however, and the generated source still lives as `.ts` in this
// example. Prefer the extensionless source during Metro resolution, then fall
// back to the normal resolver for real JavaScript modules.
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName.endsWith('.js')) {
    const sourceName = moduleName.slice(0, -3);
    try {
      return (defaultResolveRequest || context.resolveRequest)(context, sourceName, platform);
    } catch {
      // Keep Metro's normal error and resolution behavior for actual .js files.
    }
  }
  return (defaultResolveRequest || context.resolveRequest)(context, moduleName, platform);
};

module.exports = config;
