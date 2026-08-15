import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const packagePath = fileURLToPath(new URL("../package.json", import.meta.url));

describe("renderer evidence boundary", () => {
  it("records the locked renderer-neutral contract", () => {
    const packageJson = JSON.parse(readFileSync(packagePath, "utf8")) as {
      readonly dependencies: Record<string, string>;
    };

    expect(packageJson.dependencies.react).toBe("19.2.7");
    expect(packageJson.dependencies["react-dom"]).toBeUndefined();
    expect(packageJson.dependencies["react-native"]).toBeUndefined();
  });

  it.skip("React DOM renderer admission requires a renderer dependency not in the locked POC", () => {
    // Intentional admission failure: no DOM renderer may enter the shared graph.
  });

  it.skip("Hermes/RN renderer admission requires the later RN fixture", () => {
    // Intentional admission failure: package-only Vitest cannot claim Hermes execution.
  });
});
