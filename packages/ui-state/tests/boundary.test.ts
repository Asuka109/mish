import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("RN/Hermes and shared-graph admission", () => {
  it("has no DOM renderer, React Store adapter, remote snapshot hydration, or host transport", () => {
    const forbiddenImports = [
      "@tanstack/react-store",
      "react-dom",
      "dehydrate",
      "hydrate",
      "persistQueryClient",
      "broadcastQueryClient",
      "@tauri-apps",
      "electron",
      "WebSocket",
      "MessagePort",
    ];
    for (const file of sourceFiles(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of forbiddenImports) {
        expect(source).not.toContain(forbidden);
      }
    }
  });

  it("does not rely on browser globals or private workspace resolvers", () => {
    const forbiddenGlobals = [
      "window",
      "document",
      "navigator",
      "structuredClone",
      "ReadableStream",
      "TextEncoder",
      "HTMLElement",
    ];
    const forbiddenResolvers = ["node_modules/.pnpm", "/dist/", ["..", "..", "poc", ""].join("/")];
    for (const file of sourceFiles(sourceRoot)) {
      const source = readFileSync(file, "utf8");
      for (const forbidden of forbiddenGlobals) {
        expect(source).not.toMatch(new RegExp(`\\b${forbidden}\\b`));
      }
      for (const forbidden of forbiddenResolvers) {
        expect(source).not.toContain(forbidden);
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
