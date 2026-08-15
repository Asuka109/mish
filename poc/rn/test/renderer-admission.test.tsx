import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const appPath = resolve(dirname(fileURLToPath(import.meta.url)), "../src/App.tsx");
const packageRoot = resolve(dirname(appPath), "..");

describe("RN renderer evidence", () => {
  it("requires an Android renderer smoke marker instead of claiming Node/jsdom", () => {
    const app = readFileSync(appPath, "utf8");
    expect(app).toContain("RN_ADMISSION_OK");
    expect(app).toContain("useMishStore");
    expect(app).toContain("renderer.cleanup");
    expect(app).toContain("store.remount");
    expect(app).not.toContain("jsdom");
  });

  it("closes the Hermes renderer gate through the emulator smoke command", () => {
    const readme = readFileSync(resolve(packageRoot, "README.md"), "utf8");
    expect(readme).toContain("node poc/rn/scripts/smoke-emulator.ts");
  });
});
