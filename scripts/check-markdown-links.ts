import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const roots = ["README.md", "PRODUCT.md", "DESIGN.md", "bootstrap.md", "development.md", "docs"];
const markdownLinkPattern = /!?(?:\[[^\]]*\])\(([^)]+)\)/g;
const externalSchemePattern = /^(?:[a-z]+:|#)/i;

function collectMarkdownFiles(path: string): string[] {
  const absolutePath = resolve(repositoryRoot, path);
  if (!existsSync(absolutePath)) return [];
  if (!statSync(absolutePath).isDirectory())
    return absolutePath.endsWith(".md") ? [absolutePath] : [];

  return readdirSync(absolutePath, { withFileTypes: true }).flatMap((entry) => {
    const childPath = join(absolutePath, entry.name);
    if (entry.isDirectory()) return collectMarkdownFiles(childPath);
    return entry.name.endsWith(".md") ? [childPath] : [];
  });
}

function normalizeTarget(rawTarget: string) {
  const targetWithoutTitle = rawTarget
    .trim()
    .replace(/^<|>$/g, "")
    .split(/\s+["']/u, 1)[0];
  return decodeURIComponent(targetWithoutTitle.split("#", 1)[0]);
}

const missingLinks: string[] = [];

for (const filePath of roots.flatMap(collectMarkdownFiles)) {
  const content = readFileSync(filePath, "utf8");
  for (const match of content.matchAll(markdownLinkPattern)) {
    const rawTarget = match[1];
    if (!rawTarget || externalSchemePattern.test(rawTarget)) continue;

    const target = normalizeTarget(rawTarget);
    if (!target) continue;
    const resolvedTarget = resolve(dirname(filePath), target);
    if (!existsSync(resolvedTarget)) {
      missingLinks.push(`${filePath.slice(repositoryRoot.length + 1)} -> ${rawTarget}`);
    }
  }
}

if (missingLinks.length > 0) {
  console.error("Broken local Markdown links:");
  for (const missingLink of missingLinks) console.error(`- ${missingLink}`);
  process.exitCode = 1;
} else {
  console.log("All local Markdown links resolve.");
}
