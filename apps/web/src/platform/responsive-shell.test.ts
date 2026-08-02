import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync("src/styles.css", "utf8");
const shell = readFileSync("src/components/app-shell.tsx", "utf8");
const notifications = readFileSync("src/components/notification-bubble.tsx", "utf8");
const patchEditor = readFileSync("src/components/profile-patch-editor.tsx", "utf8");
const desktopConfig = readFileSync("../desktop/src-tauri/tauri.conf.json", "utf8");

describe("responsive shell CSS", () => {
  it("keeps the native desktop window above the full-sidebar layout threshold", () => {
    expect(desktopConfig).toContain('"minWidth": 800');
    expect(desktopConfig).toContain('"minHeight": 600');
    expect(desktopConfig).toContain("@mish/web build:desktop");
  });

  it("lets the shell shrink to the host viewport in both axes", () => {
    const viewportRootRule = styles.match(/html,[\s\S]*?#root \{[\s\S]*?\n\}/)?.[0];

    expect(viewportRootRule).toContain("min-width: 0");
    expect(viewportRootRule).not.toContain("min-width: 700px");
    expect(shell).toContain("app-shell relative grid h-screen h-dvh min-h-0");
    expect(shell).not.toContain("min-h-[620px]");
  });

  it("bounds the mobile root to the dynamic viewport", () => {
    const mobileViewportRule = styles.match(
      /:root\[data-runtime="mobile"\],[\s\S]*?:root\[data-runtime="mobile"\] #root \{[\s\S]*?\n\}/,
    )?.[0];

    expect(mobileViewportRule).toContain("height: 100dvh");
    expect(mobileViewportRule).toContain("min-height: 0");
  });

  it("keeps the notification icon aligned with the toolbar color states", () => {
    expect(notifications).toContain("notification-trigger relative inline-flex");
    expect(notifications).toContain("text-muted-foreground");
    expect(notifications).toContain("hover:text-fg");
  });

  it("keeps notification messages wrappable and exposes remove controls on interaction", () => {
    expect(notifications).toContain("notification-message cursor-text wrap-anywhere");
    expect(notifications).toContain("select-text");
    expect(notifications).not.toContain("truncate");
    expect(notifications).toContain("opacity-0 pointer-events-none");
    expect(notifications).toContain("group-hover/item:opacity-100");
    expect(notifications).toContain("focus-visible:pointer-events-auto");
    expect(notifications).not.toContain("group-focus-within/item");
  });

  it("separates the profile patch editor sections inside a padded content region", () => {
    expect(patchEditor).toContain('content: "flex flex-col gap-3 p-4"');
    expect(styles).not.toContain(".profile-patch-content {");
  });

  it("keeps browser and desktop chrome unselectable without blocking editable content", () => {
    const chromeSelectionRule = styles.match(
      /:root:is\(\[data-runtime="browser"\], \[data-runtime="desktop"\]\),[\s\S]*?-webkit-touch-callout: none;[\s\S]*?\n\}/,
    )?.[0];
    const contentSelectionRule = styles.match(
      /:root:is\(\[data-runtime="browser"\], \[data-runtime="desktop"\]\)\n\s+:is\([\s\S]*?\[data-native-text-interaction\][\s\S]*?-webkit-touch-callout: default;[\s\S]*?\n\}/,
    )?.[0];

    expect(chromeSelectionRule).toContain("user-select: none");
    expect(chromeSelectionRule).not.toContain('data-runtime="mobile"');
    expect(contentSelectionRule).toContain("[data-native-text-interaction]");
    expect(contentSelectionRule).toContain(".notification-toast-copy");
    expect(contentSelectionRule).toContain("user-select: text");
    expect(styles).toContain('.workspace-page-scroll h1[tabindex="-1"]:focus');
  });
});
