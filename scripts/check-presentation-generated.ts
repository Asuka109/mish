import { readdirSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { parse } from "yaml";

const paths = [
  "packages/contracts/src/generated/presentation.ts",
  "crates/presentation-contract/src/generated.rs",
];
const schema = JSON.parse(
  readFileSync("packages/presentation-schema/presentation.schema.json", "utf8"),
);
const resourceRoot = "crates/native-i18n/locales";
const resourceLocales = readdirSync(resourceRoot)
  .filter((name) => name.endsWith(".yml"))
  .map((name) => name.slice(0, -4))
  .sort();
const expectedLocales = [...schema.locales].sort();
if (JSON.stringify(resourceLocales) !== JSON.stringify(expectedLocales)) {
  throw new Error(`Native locale resources must be exactly: ${expectedLocales.join(", ")}`);
}

function flatten(value: unknown, prefix = "", result = new Map<string, string>()) {
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof child === "string") result.set(path, child);
    else flatten(child, path, result);
  }
  return result;
}

for (const locale of schema.locales) {
  const catalog = flatten(parse(readFileSync(`${resourceRoot}/${locale}.yml`, "utf8")));
  const expectedKeys = Object.keys(schema.messages).sort();
  const actualKeys = [...catalog.keys()].sort();
  if (JSON.stringify(actualKeys) !== JSON.stringify(expectedKeys)) {
    throw new Error(`${locale} native catalog keys do not match the presentation schema`);
  }
  for (const [id, definition] of Object.entries(schema.messages)) {
    const expectedArgs = Object.keys(
      (definition as { args?: Record<string, string> }).args ?? {},
    ).sort();
    const actualArgs = [...catalog.get(id)!.matchAll(/%\{([a-zA-Z][a-zA-Z0-9_]*)\}/gu)]
      .map((match) => match[1])
      .sort();
    if (JSON.stringify(actualArgs) !== JSON.stringify(expectedArgs)) {
      throw new Error(`${locale}:${id} arguments must be exactly: ${expectedArgs.join(", ")}`);
    }
  }
}

const before = new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));
const result = spawnSync("node", ["scripts/generate-presentation-contract.ts"], {
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);
const stale = paths.filter((path) => before.get(path) !== readFileSync(path, "utf8"));
if (stale.length)
  throw new Error(
    `Generated presentation bindings were stale:\n${stale.map((path) => `- ${path}`).join("\n")}`,
  );
console.log(`Generated presentation contract valid: ${paths.length} bindings are current.`);
console.log(
  `Native catalogs complete: ${schema.locales.length} locales match schema keys and arguments.`,
);
