import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const officialFixture = fileURLToPath(new URL("./orpc-fixture.ts", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("RN/shared admission boundary", () => {
  it("has no DOM renderer, React Store adapter, remote snapshot, or browser transport imports", () => {
    const forbiddenImports = [
      "@tanstack/react-store",
      "react-dom",
      "dehydrate",
      "hydrate",
      "persistQueryClient",
      "broadcastQueryClient",
    ];
    for (const file of sourceFiles(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of forbiddenImports) {
        expect(source, relative(sourceRoot, file)).not.toContain(forbidden);
      }
    }
  });

  it("uses public package imports without private or cross-workspace resolvers", () => {
    const forbiddenResolvers = ["node_modules/.pnpm", "node_modules/@orpc", "/dist/", "../../"];
    const files = [...sourceFiles(sourceRoot), officialFixture];

    for (const file of files) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of forbiddenResolvers) {
        expect(source, relative(sourceRoot, file)).not.toContain(forbidden);
      }
    }
  });

  it("contains no RN/shared DOM or host-global assumptions", () => {
    const forbiddenGlobals = [
      "window",
      "document",
      "navigator",
      "structuredClone",
      "ReadableStream",
      "TextEncoder",
      "MessagePort",
      "HTMLElement",
    ];
    for (const file of sourceFiles(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of forbiddenGlobals) {
        expect(source, relative(sourceRoot, file)).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
      }
    }
  });

  it("uses React's renderer-neutral subscription contract", () => {
    const source = readFileSync(join(sourceRoot, "store.ts"), "utf8");
    expect(source).toContain("useSyncExternalStore");
    expect(source).toContain('from "react"');
    expect(source).not.toContain('from "react-dom"');
  });
});
