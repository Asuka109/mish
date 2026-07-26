import { describe, expect, it } from "vitest";
import en from "./en";
import zh from "./zh";

describe("English action-label capitalization", () => {
  it("uses Title Case for representative visible actions and their action-name mirrors", () => {
    expect(en.settingsPage.checkForUpdates).toBe("Check for Updates");
    expect(en.notifications.viewAllEvents).toBe("View All Events");
    expect(en.profiles.openConfigDirectory).toBe("Open Folder");
    expect(en.services.restoreDefaults).toBe("Restore Defaults");
    expect(en.proxyControl.enable).toBe("Launch Proxy");
    expect(en.proxyControl.enableAria).toBe(en.proxyControl.enable);
  });

  it("keeps representative informational and state-bearing copy in sentence style", () => {
    expect(en.settingsPage.network).toBe("Network and DNS");
    expect(en.proxyControl.running).toBe("Proxy running");
    expect(en.status.desktopActivity).toBe("Live desktop traffic");
    expect(en.settingsPage.applicationLaunch).toBe("When app starts");
  });

  it("keeps the Chinese automatic-proxy label distinct from login launch", () => {
    expect(zh.settingsPage.applicationLaunch).toBe("应用启动时");
    expect(zh.settingsPage.applicationLaunch).not.toBe(zh.settingsPage.launchAtLogin);
  });
});
