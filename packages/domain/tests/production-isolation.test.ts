import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(import.meta.dirname, "..", "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("domain production isolation", () => {
  it("contains no POC, host API, protocol, or alternate lifecycle edge", () => {
    const source = sourceFiles(sourceRoot)
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(source).not.toMatch(
      /(?:^|["'])(?:node:|fs(?:\/|["'])|child_process|net(?:\/|["'])|http(?:\/|["'])|https(?:\/|["'])|dgram(?:\/|["']))/u,
    );
    expect(source).not.toMatch(/(?:^|["'])[^"']*poc[^"']*["']/iu);
    expect(source).not.toMatch(/json[-_ ]?rpc|dual[-_ ]?write|parity|fallback|kernel|runner/iu);
    expect(source).not.toMatch(/(?:WebSocket|MessagePort|fetch|process\.|Bun\.|Deno\.)/u);
  });
});
