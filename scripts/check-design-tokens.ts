import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

type TokenTree = Record<string, string | number | TokenTree>;

const root = fileURLToPath(new URL("..", import.meta.url));
const designSource = readFileSync(`${root}/DESIGN.md`, "utf8");
const tokenSource = readFileSync(`${root}/packages/design-tokens/src/tokens.css`, "utf8");

const frontmatter = designSource.match(/^---\n([\s\S]*?)\n---/)?.[1];
if (!frontmatter) throw new Error("DESIGN.md is missing YAML frontmatter.");

function parseFrontmatter(source: string): TokenTree {
  const result: TokenTree = {};
  const stack: Array<{ indent: number; value: TokenTree }> = [{ indent: -1, value: result }];

  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    const match = line.match(/^(\s*)([A-Za-z0-9-]+):(?:\s+(.*))?$/);
    if (!match) continue;

    const indent = match[1].length;
    const key = match[2];
    const rawValue = match[3];
    while (stack.at(-1)!.indent >= indent) stack.pop();
    const parent = stack.at(-1)!.value;

    if (rawValue === undefined) {
      const value: TokenTree = {};
      parent[key] = value;
      stack.push({ indent, value });
      continue;
    }

    const unquoted = rawValue.replace(/^(["'])(.*)\1$/, "$2");
    parent[key] = /^-?\d+(?:\.\d+)?$/.test(unquoted) ? Number(unquoted) : unquoted;
  }

  return result;
}

function readCssVariables(source: string): Map<string, string> {
  return new Map(
    [...source.matchAll(/--([A-Za-z0-9-]+):\s*([^;]+);/g)].map((match) => [match[1], match[2]]),
  );
}

function normalize(value: string | number): string {
  return String(value)
    .trim()
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .replace(/,\s+/g, ",")
    .toLowerCase();
}

function kebabCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => `-${character.toLowerCase()}`);
}

function expectToken(name: string, expected: string | number, variables: Map<string, string>) {
  const actual = variables.get(name);
  if (actual === undefined) throw new Error(`Missing CSS token --${name}.`);
  if (normalize(actual) !== normalize(expected)) {
    throw new Error(
      `Token --${name} is ${actual.trim()}, expected ${String(expected)} from DESIGN.md.`,
    );
  }
}

const design = parseFrontmatter(frontmatter);
const variables = readCssVariables(tokenSource);
let checkedTokens = 0;

for (const section of ["colors", "rounded", "spacing"] as const) {
  const values = design[section];
  if (!values || typeof values !== "object") throw new Error(`DESIGN.md is missing ${section}.`);
  const prefix = section === "colors" ? "color" : section === "rounded" ? "radius" : "spacing";

  for (const [name, value] of Object.entries(values)) {
    if (typeof value === "object") continue;
    expectToken(`mish-${prefix}-${name}`, value, variables);
    checkedTokens += 1;
  }
}

const typography = design.typography;
if (!typography || typeof typography !== "object")
  throw new Error("DESIGN.md is missing typography.");
for (const [level, properties] of Object.entries(typography)) {
  if (!properties || typeof properties !== "object") continue;
  for (const [property, value] of Object.entries(properties)) {
    if (typeof value === "object") continue;
    expectToken(`mish-typography-${level}-${kebabCase(property)}`, value, variables);
    checkedTokens += 1;
  }
}

if (!tokenSource.includes("@theme inline static")) {
  throw new Error("The shared token package must expose a static inline Tailwind theme.");
}

const requiredThemeTokens = [
  "color-background",
  "color-foreground",
  "color-primary",
  "color-primary-foreground",
  "color-muted",
  "color-muted-foreground",
  "color-border",
  "color-ring",
  "font-sans",
  "text-title",
  "text-body",
  "text-metadata",
  "radius-sm",
  "radius-md",
  "radius-lg",
  "shadow-panel",
  "shadow-float",
  "spacing",
];

for (const token of requiredThemeTokens) {
  if (!variables.has(token)) throw new Error(`Tailwind theme is missing --${token}.`);
}

const consumers = [
  ["apps/web/src/styles.css", '@import "@mish/design-tokens/tokens.css";'],
  ["sketch/src/styles.css", '@import "../../packages/design-tokens/src/tokens.css";'],
] as const;
for (const [path, expectedImport] of consumers) {
  const source = readFileSync(`${root}/${path}`, "utf8");
  if (!source.includes(expectedImport))
    throw new Error(`${path} does not import the shared theme.`);
}

console.log(
  `Design token contract valid: ${checkedTokens} DESIGN.md values and Tailwind theme mappings.`,
);
