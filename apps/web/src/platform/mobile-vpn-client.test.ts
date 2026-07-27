import type { PluginListener } from "@tauri-apps/api/core";
import { describe, expect, it, vi } from "vitest";
import { MOBILE_CORE_MAX_CONFIG_BYTES_V1, MobileVpnFixtureClient } from "./mobile-vpn-client";

function snapshot(sequence: number, phase = "stopped") {
  return {
    backendKind: "fixture",
    contractVersion: 1,
    coreAbiVersion: null,
    coreAvailability: "unavailable",
    coreCommit: null,
    coreVersion: null,
    coreWrapperRevision: null,
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

function validationResult(sequence: number, overrides: Record<string, unknown> = {}) {
  return {
    contractVersion: 1,
    failure: null,
    message: "Configuration is valid.",
    outcome: "valid",
    sequence,
    sessionId: "session-1",
    ...overrides,
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

  it("carries bounded fictional bytes to the closed validation command", async () => {
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_snapshot") return snapshot(4);
      expect(args).toEqual({
        request: {
          configBytes: Array.from(new TextEncoder().encode("mode: rule\nproxies: []\nrules: []\n")),
          sequence: 4,
          sessionId: "session-1",
        },
      });
      return validationResult(4);
    });
    const client = new MobileVpnFixtureClient({
      invoke,
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });
    await client.initialize();

    const before = client.getSnapshot();
    await expect(
      client.validateConfig(new TextEncoder().encode("mode: rule\nproxies: []\nrules: []\n")),
    ).resolves.toEqual(validationResult(4));
    expect(client.getSnapshot()).toBe(before);
    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "get_snapshot",
      "validate_config",
    ]);
  });

  it("maps rejected configuration without exposing native response text", async () => {
    const secret = "https://user:token@example.invalid/subscription";
    const client = new MobileVpnFixtureClient({
      invoke: async (command) => {
        if (command === "get_snapshot") return snapshot(2);
        return validationResult(2, {
          failure: "configuration-rejected",
          message: "Configuration was rejected by Mobile Core.",
          outcome: "invalid",
        });
      },
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });
    await client.initialize();

    const result = await client.validateConfig(new TextEncoder().encode(secret));

    expect(result.failure).toBe("configuration-rejected");
    expect(result.outcome).toBe("invalid");
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(client.getSnapshot()?.sequence).toBe(2);
  });

  it("rejects oversized input before invoking the native validation command", async () => {
    const invoke = vi.fn(async () => snapshot(3));
    const client = new MobileVpnFixtureClient({
      invoke,
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });
    await client.initialize();

    const result = await client.validateConfig(new Uint8Array(MOBILE_CORE_MAX_CONFIG_BYTES_V1 + 1));

    expect(result.failure).toBe("configuration-too-large");
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(client.getSnapshot()?.sequence).toBe(3);
  });

  it("returns cancelled and duplicate results without replaying validation", async () => {
    let resolveValidation: ((value: unknown) => void) | undefined;
    let validationCalls = 0;
    const invoke = vi.fn(async (command: string) => {
      if (command === "get_snapshot") return snapshot(7);
      validationCalls += 1;
      if (validationCalls > 1) return validationResult(7);
      return new Promise((resolve) => {
        resolveValidation = resolve;
      });
    });
    const client = new MobileVpnFixtureClient({
      invoke,
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });
    await client.initialize();
    const controller = new AbortController();
    const first = client.validateConfig(new Uint8Array([1, 2, 3]), {
      signal: controller.signal,
    });

    controller.abort();
    await expect(first).resolves.toMatchObject({ failure: "cancelled", outcome: "failed" });
    const duplicate = await client.validateConfig(new Uint8Array([4, 5, 6]));
    expect(duplicate).toMatchObject({ failure: "duplicate-command", outcome: "failed" });

    resolveValidation?.(validationResult(7));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(client.validateConfig(new Uint8Array([7, 8, 9]))).resolves.toMatchObject({
      failure: null,
      outcome: "valid",
    });

    expect(invoke.mock.calls.filter(([command]) => command === "validate_config")).toHaveLength(2);
    expect(client.getSnapshot()?.sequence).toBe(7);
  });

  it("maps plugin failures and stale result authority to bounded typed failures", async () => {
    let validationResponse: unknown = Promise.reject(
      new Error("secret config: password: fictional-secret"),
    );
    const client = new MobileVpnFixtureClient({
      invoke: async (command) => {
        if (command === "get_snapshot") return snapshot(9);
        return await validationResponse;
      },
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });
    await client.initialize();

    const failed = await client.validateConfig(new Uint8Array([1]));
    expect(failed).toMatchObject({ failure: "plugin-failure", sequence: 9 });
    expect(JSON.stringify(failed)).not.toContain("fictional-secret");

    validationResponse = {
      ...validationResult(9),
      nativeResponse: "password: fictional-secret",
    };
    const malformed = await client.validateConfig(new Uint8Array([2]));
    expect(malformed).toMatchObject({ failure: "plugin-failure", sequence: 9 });
    expect(JSON.stringify(malformed)).not.toContain("fictional-secret");

    validationResponse = validationResult(10);
    const stale = await client.validateConfig(new Uint8Array([3]));
    expect(stale).toMatchObject({ failure: "stale-authority", sequence: 9 });
    expect(client.getSnapshot()?.sequence).toBe(9);
  });

  it("rejects a result when a newer native snapshot arrives during validation", async () => {
    let handler: ((payload: unknown) => void) | undefined;
    let resolveValidation: ((value: unknown) => void) | undefined;
    const client = new MobileVpnFixtureClient({
      invoke: async (command) => {
        if (command === "get_snapshot") return snapshot(12);
        return new Promise((resolve) => {
          resolveValidation = resolve;
        });
      },
      listen: async (nextHandler) => {
        handler = nextHandler;
        return { unregister: vi.fn() } as unknown as PluginListener;
      },
    });
    await client.initialize();
    const pending = client.validateConfig(new Uint8Array([1]));

    handler?.({
      eventKind: "snapshot-changed",
      eventVersion: 1,
      sequence: 13,
      sessionId: "session-1",
      snapshot: snapshot(13),
    });
    resolveValidation?.(validationResult(12));

    await expect(pending).resolves.toMatchObject({
      failure: "stale-authority",
      sequence: 13,
      sessionId: "session-1",
    });
    expect(client.getSnapshot()?.sequence).toBe(13);
  });
});
