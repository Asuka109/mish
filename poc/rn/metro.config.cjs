const path = require("node:path");
const { getDefaultConfig, mergeConfig } = require("@react-native/metro-config");

const projectRoot = __dirname;
const pocRoot = path.resolve(projectRoot, "..");

/**
 * TypeScript-authored ESM commonly retains a `.js` specifier for the emitted
 * file. Metro resolves source files before Babel runs, so normalize only that
 * relative specifier and delegate the actual lookup to Metro's public
 * resolver. This does not alias a workspace, import a private path, or add a
 * fallback package entry.
 */
function resolveEsmSource(context, moduleName, platform) {
  if (moduleName.startsWith(".") && moduleName.endsWith(".js")) {
    return context.resolveRequest(context, moduleName.slice(0, -3), platform);
  }
  return context.resolveRequest(context, moduleName, platform);
}

/**
 * RN 0.87 Metro configuration for a workspace POC.
 *
 * Package exports stay enabled so the app consumes the public oRPC entry and
 * the three selected workspace packages without deep imports or a second
 * resolver. No host/network effect is configured here.
 */
module.exports = mergeConfig(getDefaultConfig(projectRoot), {
  projectRoot,
  watchFolders: [pocRoot],
  resolver: {
    unstable_enablePackageExports: true,
    unstable_conditionNames: ["react-native", "import", "default"],
    nodeModulesPaths: [path.resolve(projectRoot, "node_modules"), path.resolve(pocRoot, "node_modules")],
    sourceExts: ["js", "jsx", "json", "ts", "tsx", "cjs", "mjs"],
    resolveRequest: resolveEsmSource,
  },
  transformer: {
    babelTransformerPath: path.resolve(projectRoot, "metro-babel-transformer.cjs"),
  },
});
