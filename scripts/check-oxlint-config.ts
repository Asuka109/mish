import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

type JsonObject = Record<string, unknown>;

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

  for (const plugin of REQUIRED_PLUGINS) {
    if (!plugins.includes(plugin)) errors.push(`missing native plugin: ${plugin}`);
  }
  if ("jsPlugins" in config) errors.push("alpha JavaScript plugins are not allowed");
  if (object(config.options).denyWarnings !== true)
    errors.push("lint warnings must fail the command");
  if (object(config.options).typeAware !== false)
    errors.push("type-aware linting must remain explicitly deferred");
  if (!serializedOverrides.includes('"browser":true'))
    errors.push("browser globals override is missing");
  if (!serializedOverrides.includes('"vitest":true'))
    errors.push("Vitest globals override is missing");
  if (!serializedOverrides.includes('"node":true')) errors.push("Node globals override is missing");
  if (rules["eslint/no-debugger"] !== "error")
    errors.push("baseline correctness rules are missing");
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
  if (result.status === 0) throw new Error("invalid Oxlint fixtures unexpectedly passed");
  const missing = REQUIRED_DIAGNOSTICS.filter((diagnostic) => !output.includes(diagnostic));
  if (missing.length > 0)
    throw new Error(`negative fixtures did not prove: ${missing.join(", ")}\n${output}`);
}

const scriptPath = fileURLToPath(import.meta.url);
const repositoryRoot = resolve(dirname(scriptPath), "..");
if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  checkOxlintConfig(repositoryRoot);
  console.log(
    `Oxlint policy valid: ${REQUIRED_PLUGINS.length} native plugin families and ${REQUIRED_DIAGNOSTICS.length} negative diagnostics enforced.`,
  );
}
