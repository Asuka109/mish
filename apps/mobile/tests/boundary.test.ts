import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(import.meta.dirname, "../src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : [path];
  });
}

describe("RN host graph boundary", () => {
  it("does not import DOM, React Store, Tauri, or browser globals", () => {
    const source = sourceFiles(sourceRoot)
      .filter((path) => /\.(ts|tsx)$/.test(path))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(source).not.toMatch(/react-dom|@tanstack\/react-store|@tauri-apps|src-tauri/);
    expect(source).not.toMatch(/\b(window|document|navigator|localStorage|sessionStorage)\b/);
  });

  it("keeps Android admission native-only and permission-free", () => {
    const manifest = readFileSync(
      join(import.meta.dirname, "../android/app/src/main/AndroidManifest.xml"),
      "utf8",
    );
    const native = sourceFiles(join(import.meta.dirname, "../android/app/src/main/java"))
      .map((path) => readFileSync(path, "utf8"))
      .join("\n");

    expect(manifest).not.toMatch(/uses-permission|VpnService|INTERNET/);
    expect(native).not.toMatch(/VpnService|ConnectivityManager|DatagramSocket|WireGuard|tun\d/);
    expect(native).toContain("MishRnHost");
  });
});
