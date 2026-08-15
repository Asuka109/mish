const path = require("node:path");

const projectRoot = __dirname;
const pocRoot = path.resolve(projectRoot, "..");

/**
 * RN 0.87 Metro configuration for a workspace POC.
 *
 * Package exports stay enabled so the app consumes the public oRPC entry and
 * the three selected workspace packages without deep imports or a second
 * resolver. No host/network effect is configured here.
 */
module.exports = {
  projectRoot,
  watchFolders: [pocRoot],
  resolver: {
    unstable_enablePackageExports: true,
    unstable_conditionNames: ["react-native", "import", "default"],
    nodeModulesPaths: [path.resolve(projectRoot, "node_modules"), path.resolve(pocRoot, "node_modules")],
    sourceExts: ["js", "jsx", "json", "ts", "tsx", "cjs", "mjs"],
  },
  transformer: {
    babelTransformerPath: require.resolve("metro-babel-transformer"),
  },
};
