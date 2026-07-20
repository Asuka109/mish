import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");

describe("responsive shell CSS", () => {
  it("lets the shell shrink to the host viewport in both axes", () => {
    const viewportRootRule = styles.match(/html,[\s\S]*?#root \{[\s\S]*?\n\}/)?.[0];
    const appShellRule = styles.match(/\.app-shell \{[\s\S]*?\n\}/)?.[0];

    expect(viewportRootRule).toContain("min-width: 0");
    expect(viewportRootRule).not.toContain("min-width: 700px");
    expect(appShellRule).toContain("min-height: 0");
    expect(appShellRule).not.toContain("min-height: 620px");
  });

  it("keeps the full sidebar at the minimum desktop window width", () => {
    const appShellRule = styles.match(/\.app-shell \{[\s\S]*?\n\}/)?.[0];
    const narrowDesktopRule = styles.match(
      /@media \(max-width: 820px\) \{[\s\S]*?(?=@media \(max-width: 600px\))/,
    )?.[0];

    expect(appShellRule).toContain("grid-template-columns: 164px minmax(0, 1fr)");
    expect(styles).not.toContain("grid-template-columns: 148px minmax(0, 1fr)");
    expect(styles).not.toContain("grid-template-columns: 84px minmax(0, 1fr)");
    expect(narrowDesktopRule).not.toContain(".nav-item > span");
    expect(narrowDesktopRule).not.toContain(".proxy-control-label");
  });

  it("moves navigation below the workspace on mobile viewports", () => {
    const mobileRule = styles.match(
      /@media \(max-width: 600px\) \{[\s\S]*?(?=@media \(prefers-reduced-motion: reduce\))/,
    )?.[0];

    expect(mobileRule).toContain("grid-template-rows: minmax(0, 1fr) auto");
    expect(mobileRule).toContain("grid-template-columns: repeat(7, minmax(0, 1fr))");
    expect(mobileRule).toContain("env(safe-area-inset-bottom)");
  });
});
