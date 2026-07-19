import { describe, expect, it } from "vitest";
import { FixtureSettingsClient } from "./fixture-settings-client";

describe("browser settings fixture", () => {
  it("allows browser presentation preferences without simulating native startup success", async () => {
    const client = new FixtureSettingsClient();
    await expect(client.setAppearance("dark")).resolves.toMatchObject({
      adapterKind: "fixture",
      preferences: { appearance: "dark" },
    });
    await expect(client.setLanguage("zh")).resolves.toMatchObject({
      preferences: { language: "zh" },
    });
    await expect(
      client.setStartup({ launchAtLogin: true, loginLaunchBehavior: "background" }),
    ).rejects.toThrow(/unavailable/i);
    await expect(client.setWindowCloseBehavior("quit")).rejects.toThrow(/unavailable/i);
    await expect(client.getSnapshot()).resolves.toMatchObject({
      capabilities: {
        launchAtLogin: "unavailable",
        statusBar: "unavailable",
        tun: "unavailable",
        windowLifecycle: "unavailable",
      },
      preferences: { windowCloseBehavior: "hide-to-status-bar" },
      privacy: { loopbackOnly: "unavailable" },
      startupRegistration: { observed: null, phase: "unavailable" },
    });
  });
});
