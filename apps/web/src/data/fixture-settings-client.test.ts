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
    await expect(client.setWindowSurface("opaque")).resolves.toMatchObject({
      preferences: { windowSurface: "opaque" },
    });
    await expect(
      client.setStartup({ launchAtLogin: true, loginLaunchBehavior: "background" }),
    ).rejects.toThrow(/unavailable/i);
    await expect(client.setWindowCloseBehavior("quit")).rejects.toThrow(/unavailable/i);
    await expect(client.installTunHelper()).rejects.toThrow(/unavailable/i);
    await expect(client.repairTunHelper()).rejects.toThrow(/unavailable/i);
    await expect(client.removeTunHelper()).rejects.toThrow(/unavailable/i);
    await expect(client.refreshNetworkDns()).rejects.toThrow(/unavailable/i);
    await expect(client.getSnapshot()).resolves.toMatchObject({
      capabilities: {
        launchAtLogin: "unavailable",
        networkDns: "unavailable",
        statusBar: "unavailable",
        tun: "unavailable",
        windowLifecycle: "unavailable",
      },
      networkDns: { interfaces: [], phase: "unavailable", source: null },
      preferences: { windowCloseBehavior: "hide-to-status-bar", windowSurface: "opaque" },
      privacy: { loopbackOnly: "unavailable" },
      startupRegistration: { observed: null, phase: "unavailable" },
      tunHelper: { availability: "unavailable", health: "not-installed", phase: "idle" },
    });
  });
});
