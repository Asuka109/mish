const path = require("node:path");

// Resolve the official RN transformer from the public package name. pnpm
// keeps this package transitively beside @react-native/metro-config, so the
// lookup stays lockfile-backed without importing a private workspace path.
const metroConfigRoot = path.dirname(require.resolve("@react-native/metro-config/package.json"));
const transformer = require(
  require.resolve("@react-native/metro-babel-transformer", { paths: [metroConfigRoot] }),
);

module.exports = {
  getCacheKey: transformer.getCacheKey,
  transform(args) {
    return transformer.transform({
      ...args,
      options: {
        ...args.options,
        unstable_transformProfile: "hermes-stable",
        enableBabelRuntime: false,
        customTransformOptions: {
          ...args.options.customTransformOptions,
          unstable_preserveClassPrivate: true,
        },
      },
    });
  },
};
