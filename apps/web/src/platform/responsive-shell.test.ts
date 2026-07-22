import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");
const desktopConfig = readFileSync("../desktop/src-tauri/tauri.conf.json", "utf8");

describe("responsive shell CSS", () => {
  it("keeps the native desktop window above the full-sidebar layout threshold", () => {
    expect(desktopConfig).toContain('"minWidth": 800');
    expect(desktopConfig).toContain('"minHeight": 600');
    expect(desktopConfig).toContain("@mish/web build:desktop");
  });

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

    expect(mobileRule).toContain(':root[data-runtime="browser"] .app-shell');
    expect(mobileRule).toContain("grid-template-rows: minmax(0, 1fr) auto");
    expect(mobileRule).toContain("grid-template-columns: repeat(7, minmax(0, 1fr))");
    expect(mobileRule).toContain("env(safe-area-inset-bottom)");
    expect(mobileRule).not.toMatch(/\n\s{2}\.app-shell \{/);
    expect(mobileRule).not.toMatch(/\n\s{2}\.sidebar \{/);
  });

  it("keeps the notification icon aligned with the toolbar color states", () => {
    const notificationRule = styles.match(/\.ui-button\.notification-trigger \{[\s\S]*?\n\}/)?.[0];
    const notificationInteractiveRule = styles.match(
      /\.ui-button\.notification-trigger:hover,[\s\S]*?\n\}/,
    )?.[0];

    expect(notificationRule).toContain("color: var(--color-text-muted)");
    expect(notificationInteractiveRule).toContain("color: var(--color-body)");
  });

  it("keeps notification messages wrappable and exposes remove controls on interaction", () => {
    const messageRule = styles.match(/\.notification-message \{[\s\S]*?\n\}/)?.[0];
    const removeRule = styles.match(/\.notification-remove \{[\s\S]*?\n\}/)?.[0];
    const revealRule = styles.match(
      /\.notification-item:is\(:hover, :focus-within\) \.notification-remove \{[\s\S]*?\n\}/,
    )?.[0];

    expect(messageRule).toContain("overflow-wrap: anywhere");
    expect(messageRule).toContain("user-select: text");
    expect(messageRule).toContain("white-space: normal");
    expect(messageRule).not.toContain("text-overflow: ellipsis");
    expect(removeRule).toContain("opacity: 0");
    expect(removeRule).toContain("pointer-events: none");
    expect(revealRule).toContain("opacity: 1");
    expect(revealRule).toContain("pointer-events: auto");
  });

  it("nests the proxy material inside its one-pixel rounded border without a light seam", () => {
    const healthyButtonRule = styles.match(
      /\.ui-button\.proxy-control-button\[data-status="healthy"\] \{[\s\S]*?\n\}/,
    )?.[0];
    const materialRule = styles.match(/\.proxy-control-material \{[\s\S]*?\n\}/)?.[0];

    expect(healthyButtonRule).toContain("background: var(--color-status-water-base)");
    expect(materialRule).toContain("border-radius: calc(var(--radius-md) - 1px)");
  });

  it("separates the profile patch editor sections inside a padded content region", () => {
    const patchContentRule = styles.match(/\.profile-patch-content \{[\s\S]*?\n\}/)?.[0];

    expect(patchContentRule).toContain("display: flex");
    expect(patchContentRule).toContain("flex-direction: column");
    expect(patchContentRule).toContain("gap: 12px");
    expect(patchContentRule).toContain("padding: 16px");
  });

  it("keeps browser and desktop chrome unselectable without blocking editable content", () => {
    const chromeSelectionRule = styles.match(
      /:root:is\(\[data-runtime="browser"\], \[data-runtime="desktop"\]\),[\s\S]*?-webkit-touch-callout: none;[\s\S]*?\n\}/,
    )?.[0];
    const contentSelectionRule = styles.match(
      /:root:is\(\[data-runtime="browser"\], \[data-runtime="desktop"\]\)\n\s+:is\(input,[\s\S]*?-webkit-touch-callout: default;[\s\S]*?\n\}/,
    )?.[0];

    expect(chromeSelectionRule).toContain("user-select: none");
    expect(chromeSelectionRule).not.toContain('data-runtime="mobile"');
    expect(contentSelectionRule).toContain("[data-native-text-interaction]");
    expect(contentSelectionRule).toContain("user-select: text");
    expect(styles).toContain('.workspace-page-scroll h1[tabindex="-1"]:focus');
  });
});
