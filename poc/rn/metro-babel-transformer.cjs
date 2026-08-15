const transformer = require("@react-native/metro-babel-transformer");

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
