import type { PluginListener } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { MobileVpnFixtureClient } from "./mobile-vpn-client";

function snapshot(sequence: number, phase = "stopped") {
  return {
    backendKind: "fixture",
    contractVersion: 1,
    coreAvailability: "unavailable",
    foreground: false,
    message: "Fixture only. No TUN or Core is available.",
    notificationPermission: "required",
    permission: "required",
    phase,
    sequence,
    sessionId: "session-1",
    updatedAtMillis: sequence,
    vpnActive: false,
  };
}

describe("MobileVpnFixtureClient", () => {
  it("uses the closed plugin command set and validates snapshots", async () => {
    let sequence = 0;
    const invoke = vi.fn(async (_command: string) => snapshot(++sequence));
    const client = new MobileVpnFixtureClient({
      invoke,
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });

    await client.initialize();
    await client.requestVpnConsent();
    await client.requestNotificationPermission();
    await client.startFixtureLifecycle();
    await client.stop();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "get_snapshot",
      "request_vpn_consent",
      "request_notification_permission",
      "start_fixture_lifecycle",
      "stop",
    ]);
    expect(client.getSnapshot()?.vpnActive).toBe(false);
  });

  it("accepts authoritative events and ignores stale sequences", async () => {
    let handler: ((payload: unknown) => void) | undefined;
    const observed: number[] = [];
    const client = new MobileVpnFixtureClient({
      invoke: async () => snapshot(4),
      listen: async (nextHandler) => {
        handler = nextHandler;
        return { unregister: vi.fn() } as unknown as PluginListener;
      },
    });
    await client.initialize();
    client.subscribe((value) => observed.push(value.sequence));

    handler?.({
      eventKind: "snapshot-changed",
      eventVersion: 1,
      sequence: 6,
      sessionId: "session-1",
      snapshot: snapshot(6, "unavailable"),
    });
    handler?.({
      eventKind: "snapshot-changed",
      eventVersion: 1,
      sequence: 5,
      sessionId: "session-1",
      snapshot: snapshot(5),
    });

    expect(observed).toEqual([4, 6]);
    expect(client.getSnapshot()?.phase).toBe("unavailable");
  });

  it("rejects capability inflation", async () => {
    const client = new MobileVpnFixtureClient({
      invoke: async () => ({ ...snapshot(1), vpnActive: true }),
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });

    await expect(client.initialize()).rejects.toThrow();
  });
});
