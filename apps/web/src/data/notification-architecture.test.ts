import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const approvedSonnerFiles = new Set(["data/sonner-notification-adapter.ts", "main.tsx"]);

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) return [];
      return entry.name.endsWith(".ts") || entry.name.endsWith(".tsx") ? [path] : [];
    }),
  );
  return files.flat();
}

describe("notification architecture", () => {
  it("keeps imperative Sonner calls inside the adapter and mounting boundary", async () => {
    const offenders: string[] = [];
    for (const file of await sourceFiles(sourceRoot)) {
      const relative = file.slice(sourceRoot.length + 1);
      const source = await readFile(file, "utf8");
      if (!/from ["']sonner["']|\btoast\./.test(source)) continue;
      if (!approvedSonnerFiles.has(relative)) offenders.push(relative);
    }
    expect(offenders).toEqual([]);
  });
});
