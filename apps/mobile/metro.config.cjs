const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const projectRoot = __dirname;
const repositoryRoot = path.resolve(projectRoot, "../..");

/**
 * TypeScript-authored ESM retains `.js` specifiers for emitted files. Metro
 * resolves source files before Babel runs, so only relative `.js` specifiers
 * are normalized before delegating to Metro's public resolver.
 */
function resolveEsmSource(context, moduleName, platform) {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    return context.resolveRequest(context, moduleName.slice(0, -3), platform);
  }
  return context.resolveRequest(context, moduleName, platform);
}

module.exports = mergeConfig(getDefaultConfig(projectRoot), {
  projectRoot,
  watchFolders: [repositoryRoot],
  resolver: {
    unstable_enablePackageExports: true,
    unstable_conditionNames: ["react-native", "import", "default"],
    nodeModulesPaths: [
      path.resolve(projectRoot, "node_modules"),
      path.resolve(repositoryRoot, "node_modules"),
    ],
    sourceExts: ["js", "jsx", "json", "ts", "tsx", "cjs", "mjs"],
    resolveRequest: resolveEsmSource,
  },
  transformer: {
    babelTransformerPath: path.resolve(projectRoot, "metro-babel-transformer.cjs"),
  },
});
