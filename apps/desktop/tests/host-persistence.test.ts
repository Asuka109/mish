import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import { quitDecision } from "../src/host-quit-policy.js";

const desktopRoot = fileURLToPath(new URL("..", import.meta.url));

describe("Electron host persistence boundary", () => {
  it("keeps the default ready and failure paths open", () => {
    const main = readFileSync(path.join(desktopRoot, "src", "main.ts"), "utf8");

    expect(main).toContain('"fixture-auto-quit"');
    expect(main).toContain("quitDecision");
    expect(main).toContain('"renderer-failure"');
    expect(main).toContain('"renderer-timeout"');
    expect(main).toContain('requestQuitFor("renderer-failure")');
    expect(main).toContain('requestQuitFor(stageName === "renderer-ready"');
    expect(main).toContain('quitDecision(HOST_MODE, "renderer-ready")');
    expect(main).toContain("rendererDisposed");
    expect(main).toContain('requestQuitFor("renderer-ready")');
    expect(main).not.toContain("setImmediate(requestQuit);\n}");
  });

  it("makes default persistence and fixture cleanup explicit at the policy boundary", () => {
    expect(quitDecision("default", "renderer-ready")).toBe("keep-open");
    expect(quitDecision("default", "renderer-failure")).toBe("keep-open");
    expect(quitDecision("default", "renderer-timeout")).toBe("keep-open");
    expect(quitDecision("default", "user-close")).toBe("request-quit");
    expect(quitDecision("fixture-auto-quit", "renderer-ready")).toBe("request-quit");
    expect(quitDecision("fixture-auto-quit", "renderer-failure")).toBe("request-quit");
  });

  it("keeps the default renderer session alive until host disposal", () => {
    const renderer = readFileSync(path.join(desktopRoot, "src", "renderer.tsx"), "utf8");

    expect(renderer).toContain("void api.rendererReady(readyReport).then(");
    expect(renderer).toContain('if (disposition !== "dispose-and-quit") return;');
    expect(renderer).toContain("void handle.dispose().then(() => {");
    expect(renderer).toContain("api.rendererDisposed();");
  });

  it("keeps explicit fixture auto-quit separate from default persistence", () => {
    const fixture = readFileSync(path.join(desktopRoot, "scripts", "electron-fixture.ts"), "utf8");

    expect(fixture).toContain("launchMountedDmgAndStayAlive");
    expect(fixture).toContain("MISH_ELECTRON_READY stage=renderer-ready");
    expect(fixture).toContain("process.kill(-child.pid, 0)");
    expect(fixture).toContain('"fixture-auto-quit"');
    expect(fixture).toContain('"persistent"');
  });
});
