import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");
const tokens = readFileSync("../../packages/design-tokens/src/tokens.css", "utf8");
const shell = readFileSync("src/components/app-shell.tsx", "utf8");

describe("native sidebar material CSS boundary", () => {
  it("exposes only the native-capable shell while keeping the workspace opaque", () => {
    const nativeMaterialRule = tokens.match(
      /\[data-surface-rendering="material"\] \{[\s\S]*?\n\}/,
    )?.[0];

    expect(nativeMaterialRule).toContain("--mish-sidebar-background: transparent");
    expect(nativeMaterialRule).toContain("--mish-sidebar-item-hover-background: color-mix(");
    expect(nativeMaterialRule).toContain("var(--mish-color-ink)");
    expect(nativeMaterialRule).toContain("var(--mish-sidebar-material-active-opacity)");
    expect(nativeMaterialRule).toContain("--mish-sidebar-control-background: transparent");
    expect(nativeMaterialRule).toContain(
      "--mish-sidebar-control-hover-background: var(--mish-sidebar-item-hover-background)",
    );
    expect(nativeMaterialRule).toContain("var(--mish-sidebar-material-control-border-opacity)");
    expect(nativeMaterialRule).not.toMatch(/backdrop-filter|gradient|url\(/);
    expect(shell).toContain("bg-(--mish-sidebar-background)");
    expect(shell).toContain("hover:bg-(--mish-sidebar-item-hover-background)");
    expect(shell).toContain("bg-(--color-canvas)");
  });

  it("does not independently override the resolved surface for reduced transparency", () => {
    expect(styles).not.toContain("@media (prefers-reduced-transparency: reduce)");
  });
});
