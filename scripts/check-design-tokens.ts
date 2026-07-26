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
  const variables = new Map<string, string>();
  for (const match of source.matchAll(/--([A-Za-z0-9-]+):\s*([^;]+);/g)) {
    if (!variables.has(match[1])) variables.set(match[1], match[2]);
  }
  return variables;
}

function normalize(value: string | number): string {
  return String(value)
    .trim()
    .replace(/["']/g, "")
    .replace(/\s+/g, " ")
    .replace(/,\s+/g, ",")
    .toLowerCase();
}

function readRuleVariables(source: string, selector: string): Map<string, string> {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = source.match(new RegExp(`${escapedSelector}\\s*\\{([\\s\\S]*?)\\n\\}`))?.[1];
  if (!body) throw new Error(`Missing CSS rule ${selector}.`);
  return readCssVariables(body);
}

function relativeLuminance(hex: string): number {
  const normalizedHex = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-f]{6}$/i.test(normalizedHex))
    throw new Error(`Expected a hex color, received ${hex}.`);
  const channels = normalizedHex
    .match(/.{2}/g)!
    .map((channel) => Number.parseInt(channel, 16) / 255);
  const [red, green, blue] = channels.map((channel) =>
    channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
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

const themeVariables = readRuleVariables(tokenSource, "@theme inline static");
const requiredThemeTokens = [
  "color-background",
  "color-fg",
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
  "text-caption",
  "text-label-small",
  "text-micro",
  "radius-sm",
  "radius-md",
  "radius-section-grid-inner",
  "radius-material-inset",
  "radius-compact",
  "radius-lg",
  "shadow-panel",
  "shadow-float",
  "shadow-focus-ring",
  "color-sidebar-background",
  "color-sidebar-item-hover",
  "color-feedback-warning-border",
  "color-feedback-error-border",
  "breakpoint-shell-mobile",
  "breakpoint-page-compact",
  "container-dialog-height",
  "container-settings-compact",
  "container-welcome-description",
  "container-welcome-purpose",
  "ease-proxy-crossfade",
  "animate-spinner-reduced",
  "spacing",
  "spacing-page-gutter",
  "spacing-page-gutter-compact",
  "spacing-page-gutter-mobile",
];

for (const token of requiredThemeTokens) {
  if (!themeVariables.has(token)) throw new Error(`Tailwind theme is missing --${token}.`);
}

for (const token of themeVariables.keys()) {
  if (!token.startsWith("text-")) continue;
  const utilityName = token.slice("text-".length);
  if (themeVariables.has(`color-${utilityName}`)) {
    throw new Error(
      `Tailwind theme utility text-${utilityName} is ambiguous between typography and color.`,
    );
  }
}

if (variables.get("accent") !== "var(--mish-color-interactive)") {
  throw new Error("The shadcn/Tailwind accent role must resolve through --mish-color-interactive.");
}

const darkVariables = readRuleVariables(tokenSource, ':root[data-theme="dark"]');
const darkCanvas = darkVariables.get("mish-color-canvas");
const darkInteractive = darkVariables.get("mish-color-interactive");
if (!darkCanvas || !darkInteractive) {
  throw new Error("Dark appearance must define canvas and interactive colors.");
}
if (relativeLuminance(darkInteractive) <= relativeLuminance(darkCanvas)) {
  throw new Error("Dark interactive surfaces must be lighter than the dark canvas.");
}

const consumers = [
  ["apps/web/src/styles.css", '@import "@mish/design-tokens/tokens.css";'],
] as const;
for (const [path, expectedImport] of consumers) {
  const source = readFileSync(`${root}/${path}`, "utf8");
  if (!source.includes(expectedImport))
    throw new Error(`${path} does not import the shared theme.`);
}

const webStyles = readFileSync(`${root}/apps/web/src/styles.css`, "utf8");
const appShellSource = readFileSync(`${root}/apps/web/src/components/app-shell.tsx`, "utf8");
if (variables.get("color-sidebar-background") !== "var(--mish-sidebar-background)") {
  throw new Error("The sidebar background theme token must preserve its runtime surface alias.");
}
if (!appShellSource.includes("bg-sidebar-background")) {
  throw new Error("The sidebar must consume its named runtime surface theme token.");
}
if (
  !tokenSource.match(
    /\[data-surface-rendering="material"\]\s*\{[\s\S]*?--mish-sidebar-background:\s*transparent;/,
  )
) {
  throw new Error("The material surface scope must make --mish-sidebar-background transparent.");
}
if (variables.get("color-sidebar-item-hover") !== "var(--mish-sidebar-item-hover-background)") {
  throw new Error("The sidebar hover theme token must preserve its runtime surface alias.");
}
if (!appShellSource.includes("hover:bg-sidebar-item-hover")) {
  throw new Error("Sidebar hover must consume its named runtime surface theme token.");
}

const nonSemanticInteractiveBackground = /var\(--color-(?:surface-soft|hairline-soft|canvas)\)/;
const interactiveSelector =
  /:(?:hover|active)|\.is-active|\[(?:aria-pressed|data-(?:active|checked|highlighted|popup-open|pressed|selected))/;
for (const match of webStyles.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
  const selector = match[1].trim();
  const declarations = match[2];
  if (!interactiveSelector.test(selector)) continue;
  if (!/background(?:-color)?:/.test(declarations)) continue;
  if (!nonSemanticInteractiveBackground.test(declarations)) continue;
  throw new Error(`Interactive selector must consume a semantic state token: ${selector}`);
}

console.log(
  `Design token contract valid: ${checkedTokens} DESIGN.md values and Tailwind theme mappings.`,
);
