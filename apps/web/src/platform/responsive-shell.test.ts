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

  it("keeps narrow Browser navigation in explicit safe-area-aware rows", () => {
    expect(shell).toContain("max-shell-mobile:row-start-2");
    expect(shell).toContain("max-shell-mobile:row-start-1");
    expect(shell).toContain("safe-area-inset-left");
    expect(shell).toContain("safe-area-inset-right");
    expect(shell).toContain("safe-area-inset-bottom");
    expect(shell).not.toContain("max-shell-mobile:grid-row-");
    expect(shell).toContain("narrow-navigation-primary grid-cols-3");
    expect(shell).toContain("narrow-navigation-utility min-w-16 grid-cols-1");
    expect(shell).toContain("grid-cols-[minmax(0,320px)_64px] justify-between");
    expect(shell).not.toContain("max-shell-mobile:grid-cols-7");
    expect(shell).toContain("const narrowDestinations = [");
    expect(shell).toContain('{ icon: House, key: "home", path: "/status" }');
    expect(shell).toContain('{ icon: Pulse, key: "activity", path: "/traffic" }');
  });

  it("keeps proxy ownership in Home on narrow Browser layouts", () => {
    expect(shell).toContain("desktop-navigation nav-list");
    expect(shell).toContain("max-shell-mobile:hidden");
    expect(shell).toContain("<ProxyControlButton />");
    expect(shell).not.toContain("max-shell-mobile:contents");
    expect(shell).toContain("if (!isActivityPath(location.pathname)) return null");
    expect(shell).toContain("<DrawerProfilesPage");
    expect(shell).toContain(
      "profileSupported ? (profileId) => void selectProfile(profileId) : undefined",
    );
    expect(shell).not.toContain(
      "className={shellStyles().profileDrawerTrigger()}\n              disabled=",
    );
    expect(shell).toContain("profile-drawer-trigger");
    expect(shell).not.toContain("max-shell-mobile:border-b-0");
    expect(shell).not.toContain("max-shell-mobile:rounded-b-none");
    expect(shell).not.toContain("max-shell-mobile:border-t");
  });

  it("bounds the mobile root to the dynamic viewport", () => {
    const mobileViewportRule = styles.match(
      /:root\[data-runtime="mobile"\],[\s\S]*?:root\[data-runtime="mobile"\] #root \{[\s\S]*?\n\}/,
    )?.[0];

    expect(mobileViewportRule).toContain("height: 100dvh");
    expect(mobileViewportRule).toContain("min-height: 0");
  });

  it("keeps the notification icon on the shared adaptive toolbar recipe", () => {
    expect(notifications).toContain('trigger: "notification-trigger relative"');
    expect(notifications).toContain('touchTarget="adaptive"');
    expect(notifications).toContain('variant="toolbar"');
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
    expect(styles).toContain('[tabindex="-1"]:focus');
    expect(styles).toContain('[data-mish-focus-visible="keyboard"]');
    expect(styles).not.toContain('.workspace-page-scroll h1[tabindex="-1"]:focus');
  });
});
