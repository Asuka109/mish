import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceRoot = path.join(desktopRoot, "src");

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

describe("Electron host boundary", () => {
  it("keeps the production host ESM and Electron-version exact", () => {
    const packageJson = JSON.parse(
      readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
    ) as {
      readonly type: string;
      readonly dependencies: Record<string, string>;
    };
    expect(packageJson.type).toBe("module");
    expect(packageJson.dependencies.electron).toBe("43.4.0");
    expect(packageJson.dependencies["@mish/orpc-client"]).toBe("workspace:*");
    expect(packageJson.dependencies["@mish/web"]).toBe("workspace:*");
  });

  it("keeps BrowserWindow security and MessagePort ownership in the host", () => {
    const main = readFileSync(path.join(sourceRoot, "main.ts"), "utf8");
    const preload = readFileSync(path.join(sourceRoot, "preload.ts"), "utf8");
    const renderer = readFileSync(path.join(sourceRoot, "renderer.tsx"), "utf8");
    expect(main).toContain("sandbox: true");
    expect(main).toContain("contextIsolation: true");
    expect(main).toContain("nodeIntegration: false");
    expect(main).toContain("@orpc/server/message-port");
    expect(main).toContain("MessageChannelMain");
    expect(main).not.toContain("ipcMain.handle");
    expect(preload).toContain("contextBridge.exposeInMainWorld");
    expect(preload).toContain("MessagePortTransport");
    expect(preload).toContain("waitForPort");
    expect(renderer).toContain("StrictMode");
    expect(renderer).toContain("sessionStarted");
    expect(renderer).toContain("MishQueryProvider");
    expect(renderer).toContain("useMishStore");
    expect(renderer).toContain('from "@mish/web"');
    expect(renderer).toContain('"@mish/web/styles.css"');
    expect(renderer).toContain("<AppRoutes />");
    expect(renderer).toContain("<CutoverViewProvider source={viewSource}>");
    expect(renderer).toContain('aria-hidden="true"');
    expect(renderer).toContain("hidden");
    for (const forbidden of [
      'from "electron"',
      "node:crypto",
      "ipcRenderer",
      "MessageChannelMain",
      "authToken",
    ]) {
      expect(renderer).not.toContain(forbidden);
    }
  });

  it("has one renderer session effect and does not reuse the actor on a surface remount", () => {
    const renderer = readFileSync(path.join(sourceRoot, "renderer.tsx"), "utf8");
    expect(renderer).toContain("const sessionStarted = useRef(false);");
    expect(renderer).toContain("if (!sessionStarted.current)");
    expect(renderer).toContain("if (isCurrentEpoch(startedEpoch, epoch)) void handle.dispose();");
    expect(renderer).toContain("}, [handle, presentationStore, source]);");
    expect(renderer).toContain("key={surfaceLabel}");
    expect(renderer).not.toContain("}, [api, handle, presentationStore, surfaceLabel]);");
  });

  it("keeps production source free of POC, native, and custom RPC imports", () => {
    const joined = sourceFiles(sourceRoot)
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    for (const forbidden of [
      "@mish/poc",
      "src-tauri",
      "@orpc/client/websocket",
      "JSON-RPC",
      "json-rpc",
    ]) {
      expect(joined).not.toContain(forbidden);
    }
  });

  it("keeps the product projection owned by the Electron host and shared contracts", () => {
    const main = readFileSync(path.join(sourceRoot, "main.ts"), "utf8");
    const projection = readFileSync(path.join(sourceRoot, "projection.ts"), "utf8");
    const productSurface = readFileSync(path.join(sourceRoot, "product-surface.ts"), "utf8");
    expect(main).toContain("state.projection.invoke(input, signal)");
    expect(main).toContain("data: result.data");
    expect(projection).toContain('from "@mish/contracts"');
    expect(projection).toContain("ElectronProjectionDataByOperation");
    expect(projection).toContain('"projection-degraded"');
    expect(projection).toContain("setRuntimeObservation");
    expect(projection).toContain('kind: "profiles", profiles: []');
    expect(projection).toContain('kind: "routes", groups: []');
    expect(projection).toContain('kind: "traffic", connections: [], rules: []');
    expect(projection).not.toContain("@mish/web");
    expect(projection).not.toContain("apps/web");
    expect(projection).not.toContain("fixture-token");
    expect(projection).not.toContain("authToken");
    expect(productSurface).toContain("getBoundingClientRect");
    expect(productSurface).toContain("placeholderVisible");
  });

  it("keeps the fixture credential-free and free of distribution or Finder side effects", () => {
    const fixture = readFileSync(path.join(desktopRoot, "scripts", "electron-fixture.ts"), "utf8");
    expect(fixture).toContain("verifyMacOsDmgPresentation");
    expect(fixture).toContain("installMountedDmgApplication");
    expect(fixture).toContain(
      'execFileSync("/usr/bin/ditto", [mountedApplication, installedApplication]',
    );
    expect(fixture).not.toContain("launchAndQuitElectronFixture(mountedApplication, userData)");
    expect(fixture).toContain("createRequire");
    expect(fixture).toContain("process.kill(-child.pid");
    expect(fixture).not.toContain("osascript");
    expect(fixture).not.toContain("/usr/bin/open");
    expect(fixture).not.toContain("codesign");
    expect(fixture).not.toContain("notarize");
    expect(fixture).not.toContain("publish");
    expect(fixture).not.toContain("@mish/poc");
  });
});
