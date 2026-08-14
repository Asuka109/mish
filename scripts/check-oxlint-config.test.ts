import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { checkOxlintConfig, validateOxlintPolicy } from "./check-oxlint-config.ts";

const repositoryRoot = resolve(import.meta.dirname, "..");
const config = JSON.parse(readFileSync(resolve(repositoryRoot, ".oxlintrc.json"), "utf8"));
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8"));

test("the checked-in Oxlint policy and negative fixtures pass", () => {
  assert.doesNotThrow(() => checkOxlintConfig(repositoryRoot));
});

test("plugin and check:pr drift fail closed", () => {
  const driftedConfig = {
    ...config,
    plugins: config.plugins.filter((plugin: string) => plugin !== "jsx-a11y"),
  };
  const driftedPackage = {
    ...packageJson,
    devDependencies: { ...packageJson.devDependencies, eslint: "latest" },
    scripts: {
      ...packageJson.scripts,
      "check:pr": packageJson.scripts["check:pr"].replace("pnpm check:lint && ", ""),
    },
  };
  assert.deepEqual(validateOxlintPolicy(driftedConfig, driftedPackage), [
    "missing native plugin: jsx-a11y",
    "second lint authority is not allowed: eslint",
    "check:pr must retain check:lint",
  ]);
});
