import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("native sidebar material CSS boundary", () => {
  it("exposes only the native-capable shell while keeping the workspace opaque", () => {
    const nativeMaterialRule = styles.match(
      /:root\[data-native-sidebar-material="available"\][\s\S]*?\.sidebar \{\s*background: transparent;\s*\}/,
    )?.[0];
    const workspaceRule = styles.match(/\.workspace \{[\s\S]*?\n\}/)?.[0];

    expect(nativeMaterialRule).toBeDefined();
    expect(nativeMaterialRule).not.toMatch(/backdrop-filter|gradient|url\(/);
    expect(workspaceRule).toContain("background: var(--color-canvas)");
  });

  it("restores the deterministic surface when transparency is reduced", () => {
    const reducedTransparencyRule = styles.match(
      /@media \(prefers-reduced-transparency: reduce\) \{[\s\S]*?\n\}/,
    )?.[0];

    expect(reducedTransparencyRule).toContain(
      ':root[data-native-sidebar-material="available"] .sidebar',
    );
    expect(reducedTransparencyRule).toContain("background: var(--color-surface-soft)");
    expect(reducedTransparencyRule).not.toMatch(/backdrop-filter|gradient|url\(/);
  });
});
