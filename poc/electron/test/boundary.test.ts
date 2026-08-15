import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = fileURLToPath(new URL("../src", import.meta.url));
const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const current = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(current)
      : current.endsWith(".ts") || current.endsWith(".tsx")
        ? [current]
        : [];
  });
}

describe("Electron admission boundary", () => {
  it("uses the locked ESM Electron and React DOM dependencies", () => {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      readonly type: string;
      readonly dependencies: Record<string, string>;
    };
    expect(packageJson.type).toBe("module");
    expect(packageJson.dependencies.electron).toBe("43.4.0");
    expect(packageJson.dependencies.react).toBe("19.2.7");
    expect(packageJson.dependencies["react-dom"]).toBe("19.2.7");
  });

  it("keeps the renderer boundary hardened and the preload API narrow", () => {
    const files = sourceFiles(sourceRoot);
    const main = readFileSync(path.join(sourceRoot, "main.ts"), "utf8");
    const preload = readFileSync(path.join(sourceRoot, "preload.ts"), "utf8");
    const renderer = readFileSync(path.join(sourceRoot, "renderer.tsx"), "utf8");

    expect(main).toContain("sandbox: true");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("@orpc/server/message-port");
    expect(main).not.toContain("@orpc/server/websocket");
    expect(main).not.toContain("ipcMain.handle");
    expect(preload).toContain("contextBridge.exposeInMainWorld");
    expect(preload).not.toContain('exposeInMainWorld("electron"');
    expect(preload).not.toContain("MessageChannelMain");
    expect(renderer).toContain('from "react-dom/client"');
    expect(renderer).toContain("useMishStore");
    expect(renderer).toContain("createRoot");

    const joined = files.map((file) => readFileSync(file, "utf8")).join("\n");
    for (const forbidden of [
      "JSON-RPC",
      "json-rpc",
      "fallback",
      "nodeIntegration: true",
      "sandbox: false",
      "@orpc/client/websocket",
      "@orpc/server/websocket",
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("keeps DMG assembly free of Finder, AppleScript, and open side effects", () => {
    const script = readFileSync(
      fileURLToPath(new URL("../scripts/electron-fixture.ts", import.meta.url)),
      "utf8",
    );
    for (const forbidden of ["osascript", "Finder", "/usr/bin/open", "open -a"]) {
      expect(script).not.toContain(forbidden);
    }
    expect(script).toContain("verifyMacOsDmgPresentation");
  });
});
