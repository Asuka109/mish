import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const FORBIDDEN_LINT_PACKAGES = ["eslint", "prettier", "@biomejs/biome", "stylelint"] as const;

const REQUIRED_PLUGINS = [
  "eslint",
  "oxc",
  "typescript",
  "unicorn",
  "react",
  "jsx-a11y",
  "import",
  "promise",
  "vitest",
  "node",
  "react-perf",
] as const;

const REQUIRED_DIAGNOSTICS = [
  "eslint(no-debugger)",
  "oxc(missing-throw)",
  "typescript(no-duplicate-enum-values)",
  "unicorn(no-thenable)",
  "import(no-self-import)",
  "promise(valid-params)",
  "react-hooks(rules-of-hooks)",
  "react(only-export-components)",
  "react-perf(jsx-no-new-function-as-prop)",
  "jsx-a11y(alt-text)",
  "vitest(no-focused-tests)",
  "node(no-path-concat)",
] as const;

function object(value: unknown): JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}

export function validateOxlintPolicy(config: JsonObject, packageJson: JsonObject): string[] {
  const errors: string[] = [];
  const plugins = Array.isArray(config.plugins) ? config.plugins : [];
  const serializedOverrides = JSON.stringify(config.overrides ?? []);
  const rules = object(config.rules);
  const scripts = object(packageJson.scripts);
  const dependencies = {
    ...object(packageJson.dependencies),
    ...object(packageJson.devDependencies),
  };

  for (const plugin of REQUIRED_PLUGINS) {
    if (!plugins.includes(plugin)) errors.push(`missing native plugin: ${plugin}`);
  }
  if ("jsPlugins" in config) errors.push("alpha JavaScript plugins are not allowed");
  for (const lintPackage of FORBIDDEN_LINT_PACKAGES) {
    if (lintPackage in dependencies)
      errors.push(`second lint authority is not allowed: ${lintPackage}`);
  }
  if (object(config.options).denyWarnings !== false)
    errors.push("lint warnings must remain advisory during the improvement rollout");
  if (object(config.options).respectEslintDisableDirectives !== false)
    errors.push("Oxlint must not consume legacy ESLint directives");
  if (object(config.options).typeAware !== false)
    errors.push("type-aware linting must remain explicitly deferred");
  if (!serializedOverrides.includes('"browser":true'))
    errors.push("browser globals override is missing");
  if (!serializedOverrides.includes('"vitest":true'))
    errors.push("Vitest globals override is missing");
  if (!serializedOverrides.includes('"node":true')) errors.push("Node globals override is missing");
  if (rules["eslint/no-debugger"] !== "warn") errors.push("baseline correctness rules are missing");
  const configuredSeverities = [
    ...Object.values(object(config.categories)),
    ...Object.values(rules),
    ...(Array.isArray(config.overrides)
      ? config.overrides.flatMap((override) => Object.values(object(object(override).rules)))
      : []),
  ];
  if (
    configuredSeverities.some(
      (severity) => severity === "error" || severity === "deny" || severity === 2,
    )
  ) {
    errors.push("lint findings must remain warnings or allows during the improvement rollout");
  }
  if (
    typeof scripts["check:lint"] !== "string" ||
    !scripts["check:lint"].includes("check-oxlint-config.ts")
  ) {
    errors.push("check:lint must run the Oxlint regression contract");
  }
  if (typeof scripts["check:pr"] !== "string" || !scripts["check:pr"].includes("pnpm check:lint")) {
    errors.push("check:pr must retain check:lint");
  }
  return errors;
}

export function checkOxlintConfig(repositoryRoot: string): void {
  const config = JSON.parse(
    readFileSync(resolve(repositoryRoot, ".oxlintrc.json"), "utf8"),
  ) as JsonObject;
  const packageJson = JSON.parse(
    readFileSync(resolve(repositoryRoot, "package.json"), "utf8"),
  ) as JsonObject;
  const policyErrors = validateOxlintPolicy(config, packageJson);
  if (policyErrors.length > 0) throw new Error(policyErrors.join("\n"));

  const oxlint = resolve(repositoryRoot, "node_modules/.bin/oxlint");
  const result = spawnSync(oxlint, ["--no-ignore", "scripts/fixtures/oxlint-invalid"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  const output = `${result.stdout}${result.stderr}`;
  if (result.status !== 0)
    throw new Error(`advisory Oxlint fixtures blocked the command\n${output}`);
  const missing = REQUIRED_DIAGNOSTICS.filter((diagnostic) => !output.includes(diagnostic));
  if (missing.length > 0)
    throw new Error(`negative fixtures did not prove: ${missing.join(", ")}\n${output}`);
}

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  checkOxlintConfig(repositoryRoot);
  console.log(
    `Oxlint policy valid: ${REQUIRED_PLUGINS.length} native plugin families and ${REQUIRED_DIAGNOSTICS.length} advisory diagnostics observed without blocking.`,
  );
}
