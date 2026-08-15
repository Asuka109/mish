import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INVENTORY_PATH = "packages/contracts/migration-inventory.json";
const REQUIRED_DIMENSIONS = [
  "fields",
  "enum-variants",
  "discriminants-and-tagging",
  "optional-null-semantics",
  "numeric-and-string-bounds",
  "collection-limits",
  "redaction-and-privacy",
  "compatibility-and-version-envelope",
  "generated-files",
];
const DENIED_SHAPES = [
  "credentials",
  "private-keys",
  "tokens",
  "profile-bytes",
  "raw-platform-output",
  "absolute-paths",
  "arbitrary-endpoints",
];
const REQUIRED_CONTRACT_IDS = [
  "android-platform-facts",
  "bridge-protocol",
  "presentation",
  "mobile-events-traffic",
  "mobile-route-vpn",
  "runtime-status",
  "settings",
];

export class ContractParityError extends Error {
  constructor(message: string) {
    super(`[contract-parity] ${message}`);
    this.name = "ContractParityError";
  }
}

function fail(message: string): never {
  throw new ContractParityError(message);
}

function readJson(relativePath: string): any {
  try {
    return JSON.parse(readFileSync(path.join(ROOT, relativePath), "utf8"));
  } catch (error) {
    fail(
      `cannot read JSON ${relativePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function readText(relativePath: string): string {
  try {
    return readFileSync(path.join(ROOT, relativePath), "utf8");
  } catch (error) {
    fail(`cannot read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function hasPath(relativePath: string): boolean {
  try {
    return statSync(path.join(ROOT, relativePath)).isFile();
  } catch {
    return false;
  }
}

function canonicalize(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function canonicalJson(value: unknown): string {
  return `${canonicalize(value)}\n`;
}

export function sha256Json(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function assertString(value: unknown, label: string) {
  if (typeof value !== "string" || value.length === 0) fail(`${label} must be a non-empty string`);
}

function assertUnique(values: unknown, label: string) {
  if (!Array.isArray(values) || values.some((value) => typeof value !== "string")) {
    fail(`${label} must be an array of strings`);
  }
  if (new Set(values).size !== values.length) fail(`${label} contains duplicate entries`);
}

function assertExactArray(actual: unknown, expected: unknown, label: string) {
  if (
    !Array.isArray(actual) ||
    !Array.isArray(expected) ||
    JSON.stringify(actual) !== JSON.stringify(expected)
  ) {
    fail(`${label} drifted (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
  }
}

function assertObjectKeys(actual: unknown, expected: string[], label: string) {
  if (!actual || typeof actual !== "object" || Array.isArray(actual))
    fail(`${label} must be an object`);
  const keys = Object.keys(actual as Record<string, unknown>);
  assertExactArray(keys.toSorted(), expected.toSorted(), `${label} fields`);
}

function valueAtPath(value: unknown, dottedPath: string): unknown {
  return dottedPath.split(".").reduce<unknown>((current, key) => {
    if (!current || typeof current !== "object" || !(key in current)) return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

function collectOptionalFields(value: unknown): string[] {
  const fields: string[] = [];
  function visit(node: unknown, parentKey = "") {
    if (Array.isArray(node)) {
      node.forEach((item) => visit(item, parentKey));
      return;
    }
    if (!node || typeof node !== "object") return;
    if ((node as Record<string, unknown>).optional === true && parentKey) fields.push(parentKey);
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) visit(child, key);
  }
  visit(value);
  return fields;
}

function objectBlock(text: string, openingIndex: number, rust = false): string {
  const opener = text[openingIndex];
  const closer = opener === "(" ? ")" : opener === "[" ? "]" : "}";
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = openingIndex; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (rust && character === "'" && text[index - 1] === "&") continue;
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === opener) depth += 1;
    if (character === closer) {
      depth -= 1;
      if (depth === 0) return text.slice(openingIndex + 1, index);
    }
  }
  fail(`unterminated ${opener} block`);
}

function rustWireName(name: string, renameAll: string | undefined): string {
  if (renameAll === "camelCase")
    return name.replaceAll(/_([a-z])/gu, (_, letter) => letter.toUpperCase());
  if (renameAll === "kebab-case") {
    return name
      .replaceAll(/([a-z0-9])([A-Z])/gu, "$1-$2")
      .replaceAll("_", "-")
      .toLowerCase();
  }
  if (renameAll === "lowercase") return name.toLowerCase();
  return name;
}

function rustRenameAll(attributes: string): string | undefined {
  const matches = [...attributes.matchAll(/rename_all\s*=\s*"([^"]+)"/gu)];
  return matches.at(-1)?.[1];
}

export function extractRustStruct(relativePath: string, symbol: string) {
  const text = readText(relativePath);
  const declaration = new RegExp(`\\b(?:pub\\s+)?struct\\s+${symbol}\\s*\\{`, "u").exec(text);
  if (!declaration || declaration.index === undefined)
    fail(`${relativePath} is missing Rust struct ${symbol}`);
  const openingIndex = text.indexOf("{", declaration.index);
  const body = objectBlock(text, openingIndex, true);
  const attributes = text.slice(Math.max(0, declaration.index - 800), declaration.index);
  const renameAll = rustRenameAll(attributes);
  const fields: { name: string; nullable: boolean }[] = [];
  let pendingRename: string | undefined;
  for (const line of body.split("\n")) {
    const explicitRename = line.match(/serde\(rename\s*=\s*"([^"]+)"/u)?.[1];
    if (explicitRename) {
      pendingRename = explicitRename;
      continue;
    }
    const field = line.match(/^\s*pub(?:\([^)]*\))?\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([^,]+),/u);
    if (!field) continue;
    fields.push({
      name: pendingRename ?? rustWireName(field[1], renameAll),
      nullable: /\bOption\s*</u.test(field[2]),
    });
    pendingRename = undefined;
  }
  return fields;
}

export function extractRustEnum(relativePath: string, symbol: string): string[] {
  const text = readText(relativePath);
  const declaration = new RegExp(`\\b(?:pub\\s+)?enum\\s+${symbol}\\s*\\{`, "u").exec(text);
  if (!declaration || declaration.index === undefined)
    fail(`${relativePath} is missing Rust enum ${symbol}`);
  const openingIndex = text.indexOf("{", declaration.index);
  const body = objectBlock(text, openingIndex, true);
  const attributes = text.slice(Math.max(0, declaration.index - 800), declaration.index);
  const renameAll = rustRenameAll(attributes);
  const values: string[] = [];
  let pendingRename: string | undefined;
  for (const line of body.split("\n")) {
    const explicitRename = line.match(/serde\(rename\s*=\s*"([^"]+)"/u)?.[1];
    if (explicitRename) {
      pendingRename = explicitRename;
      continue;
    }
    const variant = line.match(/^\s*([A-Z][A-Za-z0-9_]*)\s*(?:[,({]|$)/u);
    if (!variant) continue;
    values.push(pendingRename ?? rustWireName(variant[1], renameAll));
    pendingRename = undefined;
  }
  return values;
}

function findTsObject(text: string, schema: string): string {
  const declaration = new RegExp(`(?:export\\s+)?const ${schema}\\s*=`, "u").exec(text);
  if (!declaration || declaration.index === undefined)
    fail(`${schema} is missing from TypeScript contract`);
  const objectIndex = text.indexOf(".object({", declaration.index);
  if (objectIndex < 0) fail(`${schema} does not expose a direct z.object shape`);
  const openingIndex = text.indexOf("{", objectIndex);
  return objectBlock(text, openingIndex);
}

function hasTopLevelCall(expression: string, method: string): boolean {
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{" || character === "(" || character === "[") depth += 1;
    else if (character === "}" || character === ")" || character === "]") depth -= 1;
    else if (depth === 0 && expression.startsWith(method, index)) return true;
  }
  return false;
}

export function extractTsObject(relativePath: string, schema: string) {
  const text = readText(relativePath);
  const body = findTsObject(text, schema);
  const fields: { name: string; nullable: boolean; optional: boolean }[] = [];
  let depth = 0;
  let quote: string | null = null;
  let escaped = false;
  const fieldStarts: { index: number; name: string }[] = [];
  const fieldPattern = /(?:^|\n)\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:/gu;
  for (const match of body.matchAll(fieldPattern)) {
    if (match.index === undefined) continue;
    let nestedDepth = 0;
    let nestedQuote: string | null = null;
    let nestedEscaped = false;
    for (let index = 0; index < match.index; index += 1) {
      const character = body[index];
      if (nestedQuote) {
        if (nestedEscaped) nestedEscaped = false;
        else if (character === "\\") nestedEscaped = true;
        else if (character === nestedQuote) nestedQuote = null;
        continue;
      }
      if (character === '"' || character === "'") {
        nestedQuote = character;
        continue;
      }
      if (character === "{" || character === "(" || character === "[") nestedDepth += 1;
      if (character === "}" || character === ")" || character === "]") nestedDepth -= 1;
    }
    if (nestedDepth === 0) fieldStarts.push({ index: match.index, name: match[1] });
  }
  for (let index = 0; index < body.length; index += 1) {
    const character = body[index];
    if (quote) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === quote) quote = null;
      continue;
    }
    if (character === '"' || character === "'") {
      quote = character;
      continue;
    }
    if (character === "{" || character === "(" || character === "[") depth += 1;
    if (depth < 0) fail(`${schema} has an invalid nested object shape`);
  }
  for (let index = 0; index < fieldStarts.length; index += 1) {
    const current = fieldStarts[index];
    const next = fieldStarts[index + 1];
    const expression = body.slice(current.index, next?.index ?? body.length);
    fields.push({
      name: current.name,
      nullable: hasTopLevelCall(expression, ".nullable()"),
      optional: hasTopLevelCall(expression, ".optional()"),
    });
  }
  return fields;
}

function extractTsEnum(relativePath: string, schema: string): string[] {
  const text = readText(relativePath);
  const declaration = new RegExp(`(?:export\\s+)?const ${schema}\\s*=`, "u").exec(text);
  if (!declaration || declaration.index === undefined)
    fail(`${schema} is missing from TypeScript contract`);
  const enumIndex = text.indexOf("z.enum([", declaration.index);
  if (enumIndex < 0) fail(`${schema} does not expose a direct z.enum shape`);
  const body = objectBlock(text, text.indexOf("[", enumIndex));
  return [...body.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

function assertRustTypeScriptShape(contract: any, shape: any) {
  const rustFields = extractRustStruct(shape.rust.path, shape.rust.symbol);
  const tsFields = extractTsObject(shape.typescript.path, shape.typescript.schema);
  const expected = shape.wireFields;
  assertExactArray(
    rustFields.map((field) => field.name).toSorted(),
    [...expected].toSorted(),
    `${contract.id}.${shape.rust.symbol} Rust fields`,
  );
  assertExactArray(
    tsFields.map((field) => field.name).toSorted(),
    [...expected].toSorted(),
    `${contract.id}.${shape.typescript.schema} TypeScript fields`,
  );
  const expectedNullable = [...(shape.nullableFields ?? [])].toSorted();
  assertExactArray(
    rustFields
      .filter((field) => field.nullable)
      .map((field) => field.name)
      .toSorted(),
    expectedNullable,
    `${contract.id}.${shape.rust.symbol} Rust nullable fields`,
  );
  assertExactArray(
    tsFields
      .filter((field) => field.nullable)
      .map((field) => field.name)
      .toSorted(),
    expectedNullable,
    `${contract.id}.${shape.typescript.schema} TypeScript nullable fields`,
  );
  assertExactArray(
    tsFields
      .filter((field) => field.optional)
      .map((field) => field.name)
      .toSorted(),
    [...(shape.optionalFields ?? [])].toSorted(),
    `${contract.id}.${shape.typescript.schema} TypeScript optional fields`,
  );
}

function assertEnumParity(contract: any, entry: any) {
  const rust = extractRustEnum(entry.rust.path, entry.rust.symbol);
  const ts = extractTsEnum(entry.typescript.path, entry.typescript.schema);
  assertExactArray(rust, entry.values, `${contract.id}.${entry.rust.symbol} Rust enum variants`);
  assertExactArray(
    ts,
    entry.values,
    `${contract.id}.${entry.typescript.schema} TypeScript enum variants`,
  );
}

function assertSafeFixture(value: unknown, label: string, maxBytes: number) {
  const serialized = JSON.stringify(value);
  if (serialized.length > maxBytes) fail(`${label} exceeds ${maxBytes} bytes`);
  const deniedKey =
    /(credential|private.?key|token|secret|profile.?bytes|raw.?output|absolute.?path|endpoint)/iu;
  function walk(node: unknown, currentPath: string) {
    if (Array.isArray(node)) {
      node.forEach((item, index) => walk(item, `${currentPath}[${index}]`));
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
      if (deniedKey.test(key))
        fail(`${label} contains denied privacy shape at ${currentPath}.${key}`);
      walk(child, `${currentPath}.${key}`);
    }
  }
  walk(value, label);
}

function assertRequiredDimensions(contract: any) {
  assertUnique(contract.dimensions, `${contract.id}.dimensions`);
  assertExactArray(
    [...contract.dimensions].toSorted(),
    [...REQUIRED_DIMENSIONS].toSorted(),
    `${contract.id}.dimensions`,
  );
  assertExactArray(
    [...(contract.privacy?.deniedShapes ?? [])].toSorted(),
    [...DENIED_SHAPES].toSorted(),
    `${contract.id}.privacy.deniedShapes`,
  );
}

function assertSourceExpectations(contract: any) {
  if (!contract.sourceExpectations) return;
  const source = readJson(contract.authority.path);
  const expectations = contract.sourceExpectations;
  if (expectations.requiredFields) {
    assertObjectKeys(source, expectations.requiredFields, `${contract.id} authority`);
  }
  for (const [field, values] of Object.entries(expectations.enumFields ?? {})) {
    assertExactArray(valueAtPath(source, field), values, `${contract.id}.${field}`);
  }
  for (const [field, value] of Object.entries(expectations.exactValues ?? {})) {
    if (valueAtPath(source, field) !== value) {
      fail(
        `${contract.id}.${field} drifted (expected ${value}, got ${valueAtPath(source, field)})`,
      );
    }
  }
  for (const [field, bound] of Object.entries(expectations.bounds ?? {})) {
    const actual = valueAtPath(source, field);
    if (!actual || typeof actual !== "object") fail(`${contract.id}.${field} bounds are missing`);
    for (const key of ["min", "max"]) {
      if (bound[key] !== undefined && actual[key] !== bound[key]) {
        fail(`${contract.id}.${field}.${key} drifted (expected ${bound[key]}, got ${actual[key]})`);
      }
    }
  }
  for (const [field, values] of Object.entries(expectations.nestedFields ?? {})) {
    assertExactArray(valueAtPath(source, field), values, `${contract.id}.${field}`);
  }
  for (const [field, values] of Object.entries(expectations.objectFields ?? {})) {
    const actual = valueAtPath(source, field);
    if (!actual || typeof actual !== "object" || Array.isArray(actual)) {
      fail(`${contract.id}.${field} must be an object`);
    }
    assertExactArray(Object.keys(actual), values, `${contract.id}.${field}`);
  }
  if (expectations.optionalFields) {
    assertExactArray(
      collectOptionalFields(source).toSorted(),
      [...expectations.optionalFields].toSorted(),
      `${contract.id}.optionalFields`,
    );
  }
  if (expectations.goldenFields) {
    assertObjectKeys(source.goldenFacts, expectations.goldenFields, `${contract.id}.goldenFacts`);
  }
}

function assertCompatibility(contract: any) {
  const compatibility = contract.compatibility;
  if (!compatibility || typeof compatibility !== "object")
    fail(`${contract.id} has no compatibility envelope`);
  assertString(compatibility.versionField, `${contract.id}.compatibility.versionField`);
  if (compatibility.sourceField) {
    const source = readJson(contract.authority.path);
    if (source[compatibility.sourceField] !== compatibility.version) {
      fail(`${contract.id} compatibility version drifted`);
    }
  }
  for (const marker of compatibility.rustMarkers ?? []) {
    assertString(marker.path, `${contract.id}.compatibility.rustMarkers.path`);
    assertString(marker.marker, `${contract.id}.compatibility.rustMarkers.marker`);
    if (!readText(marker.path).includes(marker.marker)) {
      fail(`${contract.id} is missing Rust compatibility marker ${marker.marker}`);
    }
  }
  for (const marker of compatibility.typescriptMarkers ?? []) {
    assertString(marker.path, `${contract.id}.compatibility.typescriptMarkers.path`);
    assertString(marker.marker, `${contract.id}.compatibility.typescriptMarkers.marker`);
    if (!readText(marker.path).includes(marker.marker)) {
      fail(`${contract.id} is missing TypeScript compatibility marker ${marker.marker}`);
    }
  }
  if (compatibility.outcomes)
    assertUnique(compatibility.outcomes, `${contract.id}.compatibility.outcomes`);
}

function assertDiscriminants(contract: any) {
  const discriminants = contract.discriminants;
  if (!discriminants || typeof discriminants !== "object") {
    fail(`${contract.id} has no discriminants-and-tagging declaration`);
  }
  assertString(discriminants.typescript, `${contract.id}.discriminants.typescript`);
  assertString(discriminants.rust, `${contract.id}.discriminants.rust`);
  const expected =
    contract.family === "generated-semantic-events"
      ? { typescript: "kind", rust: "tag=kind,content=data" }
      : { typescript: "none", rust: "none" };
  if (discriminants.typescript !== expected.typescript || discriminants.rust !== expected.rust) {
    fail(
      `${contract.id} discriminants drifted (expected ${JSON.stringify(expected)}, got ${JSON.stringify(discriminants)})`,
    );
  }
}

function assertManualEvidence(contract: any) {
  for (const symbol of contract.manualEvidence?.rustSymbols ?? []) {
    const text = readText(symbol.path);
    if (!new RegExp(`\\b(?:pub\\s+)?(?:struct|enum)\\s+${symbol.name}\\b`, "u").test(text)) {
      fail(`${contract.id} is missing Rust symbol ${symbol.name}`);
    }
  }
  for (const symbol of contract.manualEvidence?.typescriptSymbols ?? []) {
    const text = readText(symbol.path);
    if (!new RegExp(`\\b${symbol.name}\\b`, "u").test(text)) {
      fail(`${contract.id} is missing TypeScript symbol ${symbol.name}`);
    }
  }
  for (const shape of contract.manualEvidence?.shapes ?? [])
    assertRustTypeScriptShape(contract, shape);
  for (const entry of contract.manualEvidence?.enums ?? []) assertEnumParity(contract, entry);
  for (const bound of contract.manualEvidence?.bounds ?? []) {
    if (!readText(bound.rust.path).includes(bound.rust.marker)) {
      fail(`${contract.id} is missing Rust bound marker ${bound.rust.marker}`);
    }
    if (!readText(bound.typescript.path).includes(bound.typescript.marker)) {
      fail(`${contract.id} is missing TypeScript bound marker ${bound.typescript.marker}`);
    }
  }
}

export function validateContractEvidence(contract: any): void {
  assertRequiredDimensions(contract);
  assertDiscriminants(contract);
  assertSourceExpectations(contract);
  assertCompatibility(contract);
  assertManualEvidence(contract);
}

function runGenerator(contract: any): void {
  if (!contract.generator) return;
  const before = contract.generatedFiles.map((file: string) => readText(file));
  const first = spawnSync("node", [contract.generator], { cwd: ROOT, encoding: "utf8" });
  if (first.status !== 0)
    fail(`${contract.id} generator failed:\n${first.stdout ?? ""}${first.stderr ?? ""}`);
  const afterFirst = contract.generatedFiles.map((file: string) => readText(file));
  const stale = contract.generatedFiles.filter(
    (file: string, index: number) => before[index] !== afterFirst[index],
  );
  if (stale.length > 0) fail(`${contract.id} generated files are stale: ${stale.join(", ")}`);
  const second = spawnSync("node", [contract.generator], { cwd: ROOT, encoding: "utf8" });
  if (second.status !== 0) fail(`${contract.id} generator is not repeatable`);
  const afterSecond = contract.generatedFiles.map((file: string) => readText(file));
  const nondeterministic = contract.generatedFiles.filter(
    (file: string, index: number) => afterFirst[index] !== afterSecond[index],
  );
  if (nondeterministic.length > 0)
    fail(`${contract.id} generated output is not deterministic: ${nondeterministic.join(", ")}`);
}

export function validateFixture(contract: any, fixture: any, maxFixtureBytes = 65_536): void {
  if (fixture.contractId !== contract.id) fail(`${contract.id} fixture has the wrong contractId`);
  if (fixture.fixtureVersion !== 1)
    fail(`${contract.id} fixture has an unsupported fixtureVersion`);
  assertSafeFixture(fixture, `${contract.id} fixture`, maxFixtureBytes);
  if (!fixture.payload || typeof fixture.payload !== "object" || Array.isArray(fixture.payload)) {
    fail(`${contract.id} fixture payload must be an object`);
  }
  const expectedFields = contract.fixtureFields ?? Object.keys(fixture.payload);
  assertObjectKeys(fixture.payload, expectedFields, `${contract.id} fixture payload`);
  if (contract.fixtureNullFields) {
    const nullFields = Object.entries(fixture.payload)
      .filter(([, value]) => value === null)
      .map(([key]) => key)
      .toSorted();
    assertExactArray(
      nullFields,
      [...contract.fixtureNullFields].toSorted(),
      `${contract.id} fixture null fields`,
    );
  }
  if (contract.fixtureShapeHash && sha256Json(fixture.payload) !== contract.fixtureShapeHash) {
    fail(`${contract.id} fixture payload hash drifted`);
  }
}

function assertFixtureProjection(contract: any, fixture: any) {
  if (!contract.fixtureProjection) return;
  const source = readJson(contract.authority.path);
  const expected = contract.fixtureProjection === "goldenFacts" ? source.goldenFacts : source;
  if (canonicalJson(fixture.payload) !== canonicalJson(expected)) {
    fail(`${contract.id} golden fixture does not match its authoritative source projection`);
  }
}

function assertFixtureBindings(contract: any, fixture: any) {
  if (!contract.fixtureBindings) return;
  const source = readJson(contract.authority.path);
  for (const binding of contract.fixtureBindings) {
    const fixtureValue = fixture.payload[binding.fixtureField];
    const sourceValue = valueAtPath(source, binding.sourcePath);
    if (binding.mode === "keys") {
      if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) {
        fail(`${contract.id} fixture binding ${binding.fixtureField} source is not an object`);
      }
      assertExactArray(
        fixtureValue,
        Object.keys(sourceValue),
        `${contract.id}.${binding.fixtureField}`,
      );
    } else if (canonicalJson(fixtureValue) !== canonicalJson(sourceValue)) {
      fail(`${contract.id} fixture binding ${binding.fixtureField} drifted`);
    }
  }
}

function assertManifestShape(inventory: any) {
  if (inventory.schemaVersion !== 1) fail("unsupported migration inventory schemaVersion");
  if (inventory.inventoryVersion !== 1) fail("unsupported migration inventory inventoryVersion");
  if (!Number.isInteger(inventory.maxFixtureBytes) || inventory.maxFixtureBytes < 1024) {
    fail("maxFixtureBytes must be a bounded integer");
  }
  assertExactArray(
    [...(inventory.requiredDimensions ?? [])].toSorted(),
    [...REQUIRED_DIMENSIONS].toSorted(),
    "inventory.requiredDimensions",
  );
  if (!Array.isArray(inventory.contracts) || inventory.contracts.length < 3) {
    fail("inventory must cover at least the generated product contract families");
  }
  const ids = inventory.contracts.map((contract: any) => contract.id);
  assertUnique(ids, "inventory.contracts");
  assertExactArray(
    ids.toSorted(),
    [...(inventory.requiredContractIds ?? REQUIRED_CONTRACT_IDS)].toSorted(),
    "inventory.contractIds",
  );
  assertExactArray(ids.toSorted(), [...REQUIRED_CONTRACT_IDS].toSorted(), "inventory coverage");
}

export function runParityGate(inventory = readJson(INVENTORY_PATH)): void {
  assertManifestShape(inventory);
  const generatedOwners = new Map<string, string>();
  for (const contract of inventory.contracts) {
    assertString(contract.id, "contract.id");
    assertString(contract.family, `${contract.id}.family`);
    assertRequiredDimensions(contract);
    if (!contract.authority?.path || !hasPath(contract.authority.path)) {
      fail(`${contract.id} authority path is missing`);
    }
    for (const file of [
      ...(contract.typescript ?? []),
      ...(contract.rust ?? []),
      ...(contract.generatedFiles ?? []),
    ]) {
      if (!hasPath(file)) fail(`${contract.id} references missing file ${file}`);
    }
    for (const file of contract.generatedFiles ?? []) {
      const owner = generatedOwners.get(file);
      if (owner) fail(`generated file ${file} is claimed by both ${owner} and ${contract.id}`);
      generatedOwners.set(file, contract.id);
      if (!readText(file).includes(`Generated by ${contract.generator};`)) {
        fail(`${contract.id} generated file ${file} has no generator marker`);
      }
    }
    validateContractEvidence(contract);
    runGenerator(contract);
    const fixture = readJson(contract.fixture);
    validateFixture(contract, fixture, inventory.maxFixtureBytes);
    assertFixtureProjection(contract, fixture);
    assertFixtureBindings(contract, fixture);
  }
  const fixtureOwners = new Map<string, string>();
  for (const contract of inventory.contracts) {
    const owner = fixtureOwners.get(contract.fixture);
    if (owner) fail(`fixture ${contract.fixture} is claimed by both ${owner} and ${contract.id}`);
    fixtureOwners.set(contract.fixture, contract.id);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runParityGate();
    console.log(
      "Rust-to-TypeScript contract parity gate passed: inventory, fixtures, generated bindings, and manual evidence are current.",
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
