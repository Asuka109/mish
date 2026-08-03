import type { PluginListener } from "@tauri-apps/api/core";
import type { MobileVpnSnapshotDto } from "@mish/contracts";
import { describe, expect, it, vi } from "vitest";
import { MOBILE_CORE_MAX_CONFIG_BYTES_V1, MobileVpnFixtureClient } from "./mobile-vpn-client";

function snapshot(
  sequence: number,
  phase: MobileVpnSnapshotDto["phase"] = "stopped",
  sessionId = "session-1",
  authorityId = "authority-1",
): MobileVpnSnapshotDto {
  return {
    activationSessionId: null,
    activeNetwork: false,
    authorityId,
    backendKind: "fixture",
    contractVersion: 1,
    coreAbiVersion: null,
    coreAvailability: "unavailable",
    coreRunning: false,
    coreCommit: null,
    configFailureInjectionAvailable: false,
    coreConfigState: "unloaded",
    coreVersion: null,
    coreWrapperRevision: null,
    dnsApplied: false,
    failure: null,
    foreground: false,
    loadedConfigDigest: null,
    loadedConfigRevision: null,
    message: "Fixture only. No TUN or Core is available.",
    notificationPermission: "required",
    operation: null,
    permission: "required",
    phase,
    protectedSocketCount: 0,
    publicRequestObserved: false,
    revision: sequence,
    routesApplied: false,
    sequence,
    sessionId,
    updatedAtMillis: sequence,
    validatedConfigDigest: null,
    validatedConfigRevision: null,
    vpnActive: false,
    vpnAvailability: "unavailable",
    tunAvailability: "unavailable",
    tunEstablished: false,
  };
}

function lifecycleResult(
  kind: "request-notification-permission" | "request-vpn-consent" | "start" | "stop",
  operationId: string,
  value: MobileVpnSnapshotDto,
) {
  const operation = { failure: null, kind, operationId, outcome: "completed" as const };
  return {
    contractVersion: 1,
    operation,
    snapshot: { ...value, operation },
  };
}

const configA = "mode: rule\nproxies: []\nproxy-groups: []\nrules: []\n";
const configADigest = "68f2de0232c31d5790035632a9b745bc2e3dfb926d55cd36c4e0fdfa8d54ddc5";

function loadResult(resultSnapshot: MobileVpnSnapshotDto, overrides: Record<string, unknown> = {}) {
  return {
    cancellation: "not-requested",
    contractVersion: 1,
    digest: configADigest,
    failure: null,
    message: "Configuration loaded. VPN and TUN remain unavailable.",
    operationId: "load-a",
    outcome: "first-load",
    revision: "fixture-a",
    rollback: "not-needed",
    snapshot: resultSnapshot,
    timing: "on-time",
    ...overrides,
  };
}

function loadedConfigSnapshot(sequence: number): MobileVpnSnapshotDto {
  return {
    ...snapshot(sequence),
    coreAbiVersion: 1,
    coreAvailability: "available",
    coreCommit: "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb",
    coreConfigState: "loaded",
    coreVersion: "v1.19.29",
    coreWrapperRevision: "mish-mobile-core-v1",
    loadedConfigDigest: configADigest,
    loadedConfigRevision: "fixture-a",
    validatedConfigDigest: configADigest,
    validatedConfigRevision: "fixture-a",
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
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      const value = snapshot(++sequence);
      if (command === "get_snapshot") return value;
      const operationId = (args?.request as { operationId?: unknown } | undefined)?.operationId;
      if (typeof operationId !== "string") throw new Error("Missing lifecycle operation ID.");
      const kind = {
        request_notification_permission: "request-notification-permission",
        request_vpn_consent: "request-vpn-consent",
        start: "start",
        stop: "stop",
      }[command] as "request-notification-permission" | "request-vpn-consent" | "start" | "stop";
      return lifecycleResult(kind, operationId, value);
    });
    const client = new MobileVpnFixtureClient({
      invoke,
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });

    await client.initialize();
    await client.requestVpnConsent();
    await client.requestNotificationPermission();
    await client.start();
    await client.stop();

    expect(invoke.mock.calls.map(([command]) => command)).toEqual([
      "get_snapshot",
      "request_vpn_consent",
      "request_notification_permission",
      "start",
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
      authorityId: "authority-1",
      eventKind: "snapshot-changed",
      eventVersion: 2,
      revision: 6,
      sequence: 6,
      sessionId: "session-1",
      snapshot: snapshot(6, "unavailable"),
    });
    handler?.({
      authorityId: "authority-1",
      eventKind: "snapshot-changed",
      eventVersion: 2,
      revision: 5,
      sequence: 5,
      sessionId: "session-1",
      snapshot: snapshot(5),
    });

    expect(observed).toEqual([4, 6]);
    expect(client.getSnapshot()?.phase).toBe("unavailable");
  });

  it("routes start cancellation through the typed native cleanup barrier", async () => {
    let resolveStart: ((value: unknown) => void) | undefined;
    const commands: string[] = [];
    const client = new MobileVpnFixtureClient({
      invoke: async (command, args) => {
        commands.push(command);
        if (command === "get_snapshot") return snapshot(1);
        const request = args?.request as { operationId: string } | undefined;
        if (!request) throw new Error(`Missing request for command: ${command}`);
        const { operationId } = request;
        if (command === "start") {
          return new Promise((resolve) => {
            resolveStart = resolve;
          });
        }
        if (command === "cancel_lifecycle_operation") {
          const operation = {
            failure: "cancelled",
            kind: "start",
            operationId,
            outcome: "cancelled",
          } as const;
          const result = {
            contractVersion: 1,
            operation,
            snapshot: { ...snapshot(2), operation },
          };
          resolveStart?.(result);
          return result;
        }
        throw new Error(`Unexpected command: ${command}`);
      },
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });
    await client.initialize();
    const controller = new AbortController();

    const starting = client.start({ signal: controller.signal });
    controller.abort();
    const terminal = await starting;

    expect(commands).toEqual(["get_snapshot", "start", "cancel_lifecycle_operation"]);
    expect(terminal.operation?.outcome).toBe("cancelled");
    expect(terminal.phase).toBe("stopped");
  });

  it("requires a complete baseline before replaying only same-authority events", async () => {
    let handler: ((payload: unknown) => void) | undefined;
    let resolveBaseline: ((value: MobileVpnSnapshotDto) => void) | undefined;
    const baseline = new Promise<MobileVpnSnapshotDto>((resolve) => {
      resolveBaseline = resolve;
    });
    const observed: number[] = [];
    const client = new MobileVpnFixtureClient({
      invoke: async () => baseline,
      listen: async (nextHandler) => {
        handler = nextHandler;
        return { unregister: vi.fn() } as unknown as PluginListener;
      },
    });
    client.subscribe((value) => observed.push(value.sequence));
    const initialization = client.initialize();
    await vi.waitFor(() => expect(handler).toBeDefined());

    handler?.({
      authorityId: "retired-authority",
      eventKind: "snapshot-changed",
      eventVersion: 2,
      revision: 8,
      sequence: 8,
      sessionId: "retired-session",
      snapshot: snapshot(8, "unavailable", "retired-session", "retired-authority"),
    });
    handler?.({
      authorityId: "authority-1",
      eventKind: "snapshot-changed",
      eventVersion: 2,
      revision: 6,
      sequence: 6,
      sessionId: "session-1",
      snapshot: snapshot(6, "unavailable"),
    });
    expect(client.getSnapshot()).toBeUndefined();

    resolveBaseline?.(snapshot(4));
    await expect(initialization).resolves.toMatchObject({ sequence: 6 });

    expect(observed).toEqual([4, 6]);
    expect(client.getSnapshot()).toMatchObject({
      authorityId: "authority-1",
      phase: "unavailable",
      sequence: 6,
    });
  });

  it("accepts runtime replacement once and rejects late events from the retired session", async () => {
    let handler: ((payload: unknown) => void) | undefined;
    const client = new MobileVpnFixtureClient({
      invoke: async () => snapshot(8),
      listen: async (nextHandler) => {
        handler = nextHandler;
        return { unregister: vi.fn() } as unknown as PluginListener;
      },
    });
    await client.initialize();

    handler?.({
      authorityId: "authority-1",
      eventKind: "snapshot-changed",
      eventVersion: 2,
      revision: 9,
      sequence: 9,
      sessionId: "session-2",
      snapshot: snapshot(9, "stopped", "session-2"),
    });
    handler?.({
      authorityId: "authority-1",
      eventKind: "snapshot-changed",
      eventVersion: 2,
      revision: 10,
      sequence: 10,
      sessionId: "session-1",
      snapshot: snapshot(10),
    });

    expect(client.getSnapshot()).toMatchObject({ sequence: 9, sessionId: "session-2" });
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

  it("loads an admitted revision through the closed command and accepts its terminal snapshot", async () => {
    const loadedSnapshot = loadedConfigSnapshot(6);
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_snapshot") return snapshot(4);
      expect(command).toBe("load_config");
      expect(args).toEqual({
        request: {
          configBytes: Array.from(new TextEncoder().encode(configA)),
          digest: configADigest,
          injectFailure: false,
          operationId: "load-a",
          revision: "fixture-a",
          sequence: 4,
          sessionId: "session-1",
          timeoutMillis: 5_000,
        },
      });
      return loadResult(loadedSnapshot);
    });
    const client = new MobileVpnFixtureClient({
      invoke,
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });
    await client.initialize();

    const result = await client.loadConfig(
      new TextEncoder().encode(configA),
      { digest: configADigest, revision: "fixture-a" },
      { operationId: "load-a", timeoutMillis: 5_000 },
    );

    expect(result.outcome).toBe("first-load");
    expect(client.getSnapshot()).toEqual(loadedSnapshot);
    expect(JSON.stringify(result)).not.toContain(configA);
  });

  it("orders cancellation through the native barrier without inventing unloaded state", async () => {
    let resolveLoad: ((value: unknown) => void) | undefined;
    const invoke = vi.fn(async (command: string) => {
      if (command === "get_snapshot") return snapshot(4);
      if (command === "cancel_config_load") {
        return { accepted: true, contractVersion: 1, operationId: "load-a" };
      }
      return new Promise((resolve) => {
        resolveLoad = resolve;
      });
    });
    const client = new MobileVpnFixtureClient({
      invoke,
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });
    await client.initialize();
    const controller = new AbortController();
    const pending = client.loadConfig(
      new TextEncoder().encode(configA),
      { digest: configADigest, revision: "fixture-a" },
      { operationId: "load-a", signal: controller.signal },
    );
    await vi.waitFor(() => {
      expect(invoke.mock.calls.map(([command]) => command)).toContain("load_config");
    });
    controller.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    resolveLoad?.(
      loadResult(snapshot(5), {
        cancellation: "before-load",
        failure: "cancelled",
        message: "Configuration loading was cancelled before the native load barrier.",
        outcome: "cancelled",
        rollback: "unloaded",
      }),
    );

    await expect(pending).resolves.toMatchObject({
      cancellation: "before-load",
      failure: "cancelled",
      outcome: "cancelled",
    });
    expect(invoke.mock.calls.map(([command]) => command)).toContain("cancel_config_load");
    expect(client.getSnapshot()?.coreConfigState).toBe("unloaded");
  });

  it("rejects repeated loads and malformed native completion without exposing response text", async () => {
    let resolveLoad: ((value: unknown) => void) | undefined;
    let response: unknown = new Promise((resolve) => {
      resolveLoad = resolve;
    });
    const invoke = vi.fn(async (command: string) => {
      if (command === "get_snapshot") return snapshot(4);
      return await response;
    });
    const client = new MobileVpnFixtureClient({
      invoke,
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });
    await client.initialize();
    const first = client.loadConfig(
      new TextEncoder().encode(configA),
      { digest: configADigest, revision: "fixture-a" },
      { operationId: "load-a" },
    );
    await vi.waitFor(() => {
      expect(invoke.mock.calls.map(([command]) => command)).toContain("load_config");
    });

    const duplicate = await client.loadConfig(
      new TextEncoder().encode(configA),
      { digest: configADigest, revision: "fixture-a" },
      { operationId: "load-b" },
    );
    expect(duplicate).toMatchObject({ failure: "duplicate-command", outcome: "failed" });
    resolveLoad?.(loadResult(loadedConfigSnapshot(5)));
    await expect(first).resolves.toMatchObject({ outcome: "first-load" });

    response = {
      ...loadResult(loadedConfigSnapshot(6)),
      nativeResponse: "password: fictional-secret",
    };
    const malformed = await client.loadConfig(
      new TextEncoder().encode(configA),
      { digest: configADigest, revision: "fixture-a" },
      { operationId: "load-c" },
    );
    expect(malformed).toMatchObject({ failure: "plugin-failure" });
    expect(JSON.stringify(malformed)).not.toContain("fictional-secret");
    expect(invoke.mock.calls.filter(([command]) => command === "load_config")).toHaveLength(2);
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
      authorityId: "authority-1",
      eventKind: "snapshot-changed",
      eventVersion: 2,
      revision: 13,
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
