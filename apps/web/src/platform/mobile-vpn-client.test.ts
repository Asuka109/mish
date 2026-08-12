import type { PluginListener } from "@tauri-apps/api/core";
import {
  ANDROID_PLATFORM_FACTS_GOLDEN,
  AndroidPlatformFactsSchema,
  MobileCoreProvenanceSnapshotSchema,
  type MobileVpnSnapshotDto,
} from "@mish/contracts";
import { describe, expect, it, vi } from "vitest";
import {
  MOBILE_CORE_MAX_CONFIG_BYTES_V1,
  MobileVpnFixtureClient,
  type MobileVpnDeliveryTraceEvent,
} from "./mobile-vpn-client";

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

function eventPayload(value: MobileVpnSnapshotDto) {
  return {
    authorityId: value.authorityId,
    eventKind: "snapshot-changed" as const,
    eventVersion: 2 as const,
    revision: value.revision,
    sequence: value.sequence,
    sessionId: value.sessionId,
    snapshot: value,
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
  it("projects only the bounded Mobile Core provenance DTO", async () => {
    const provenance = {
      authorityId: "mobile-core-authority",
      classification: "available",
      evidence: {
        abiVersion: 1,
        artifactDigest: "a".repeat(64),
        manifestSchemaVersion: 2,
        selectedAbi: "arm64-v8a",
        signatureVerification: "verified",
        signerFingerprint: "b".repeat(64),
        sourceCommit: "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb",
        sourceVersion: "v1.19.29",
        wrapperContractVersion: 1,
        wrapperRevision: "mish-mobile-core-v1",
      },
      generation: 1,
      schemaVersion: 1,
      state: "admitted",
    } as const;
    const client = new MobileVpnFixtureClient({
      invoke: async (command) => {
        if (command !== "get_core_provenance") throw new Error(`Unexpected command: ${command}`);
        return provenance;
      },
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });

    await expect(client.getCoreProvenance()).resolves.toEqual(provenance);
    expect(
      MobileCoreProvenanceSnapshotSchema.safeParse({
        ...provenance,
        privatePath: "/data/user/0/mish",
      }).success,
    ).toBe(false);
    expect(
      MobileCoreProvenanceSnapshotSchema.safeParse({
        ...provenance,
        evidence: { ...provenance.evidence, certificateBytes: [1, 2] },
      }).success,
    ).toBe(false);
    expect(
      MobileCoreProvenanceSnapshotSchema.safeParse({
        ...provenance,
        evidence: { ...provenance.evidence, artifactDigest: "a".repeat(65) },
      }).success,
    ).toBe(false);
    expect(
      MobileCoreProvenanceSnapshotSchema.safeParse({ ...provenance, evidence: null }).success,
    ).toBe(false);
  });

  it("checks the complete generated Android facts schema and rejects drift", () => {
    expect(AndroidPlatformFactsSchema.parse(ANDROID_PLATFORM_FACTS_GOLDEN)).toEqual(
      ANDROID_PLATFORM_FACTS_GOLDEN,
    );
    expect(() =>
      AndroidPlatformFactsSchema.parse({
        ...ANDROID_PLATFORM_FACTS_GOLDEN,
        event: "future-event",
      }),
    ).toThrow();
    expect(() =>
      AndroidPlatformFactsSchema.parse({
        ...ANDROID_PLATFORM_FACTS_GOLDEN,
        privatePath: "/data/user/0/example",
      }),
    ).toThrow();
  });

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

  it("keeps the initial baseline authoritative when a newer notification beats a late load", async () => {
    let handler: ((payload: unknown) => void) | undefined;
    let resolveLoad: ((value: unknown) => void) | undefined;
    const traces: MobileVpnDeliveryTraceEvent[] = [];
    const client = new MobileVpnFixtureClient(
      {
        invoke: async (command) => {
          if (command === "get_snapshot") return snapshot(4);
          return new Promise((resolve) => {
            resolveLoad = resolve;
          });
        },
        listen: async (nextHandler) => {
          handler = nextHandler;
          return { unregister: vi.fn() } as unknown as PluginListener;
        },
      },
      { trace: (event) => traces.push(event) },
    );
    await client.initialize();

    const pending = client.loadConfig(
      new TextEncoder().encode(configA),
      { digest: configADigest, profileId: "profile-a", revision: "fixture-a" },
      { operationId: "load-a" },
    );
    await vi.waitFor(() => expect(resolveLoad).toBeDefined());
    const newer = loadedConfigSnapshot(5);
    handler?.(eventPayload(newer));
    const resolve = resolveLoad;
    if (resolve) resolve(loadResult(loadedConfigSnapshot(4)));

    await expect(pending).resolves.toMatchObject({
      failure: "stale-authority",
      outcome: "failed",
    });
    expect(client.getSnapshot()).toMatchObject({ sequence: 5, loadedConfigRevision: "fixture-a" });
    expect(traces).toContainEqual(
      expect.objectContaining({
        acceptance: "stale",
        delivery: "load",
        sequence: 4,
      }),
    );
  });

  it("rejects equal-order conflicting snapshots and late events from an old authority", async () => {
    let handler: ((payload: unknown) => void) | undefined;
    const traces: MobileVpnDeliveryTraceEvent[] = [];
    const client = new MobileVpnFixtureClient(
      {
        invoke: async () => snapshot(4),
        listen: async (nextHandler) => {
          handler = nextHandler;
          return { unregister: vi.fn() } as unknown as PluginListener;
        },
      },
      { trace: (event) => traces.push(event) },
    );
    await client.initialize();

    handler?.(eventPayload(snapshot(4, "unavailable")));
    handler?.(eventPayload(snapshot(5, "stopped", "session-2", "authority-2")));
    handler?.(eventPayload(snapshot(3, "unavailable", "session-1", "authority-1")));

    expect(client.getSnapshot()).toMatchObject({ authorityId: "authority-1", sequence: 4 });
    expect(traces.filter((event) => event.kind === "delivery")).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ acceptance: "stale", sequence: 4 }),
        expect.objectContaining({ acceptance: "stale", authorityId: "authority-2" }),
      ]),
    );
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
          const resolve = resolveStart;
          if (resolve) resolve(result);
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

  it("accepts a valid replacement command once and retires the old session", async () => {
    const replacement = snapshot(6, "stopped", "session-2", "authority-2");
    const operation = {
      failure: "stale-platform-authority" as const,
      kind: "stop" as const,
      operationId: "replacement-stop",
      outcome: "rejected" as const,
    };
    const client = new MobileVpnFixtureClient({
      invoke: async (command, args) => {
        if (command === "get_snapshot") return snapshot(4);
        const request = args?.request as { operationId: string } | undefined;
        if (!request) throw new Error(`Missing request for command: ${command}`);
        const operationId = request.operationId;
        return {
          contractVersion: 1,
          operation: { ...operation, operationId },
          snapshot: { ...replacement, operation: { ...operation, operationId } },
        };
      },
      listen: async () => ({ unregister: vi.fn() }) as unknown as PluginListener,
    });
    await client.initialize();

    const result = await client.stop();

    expect(result).toMatchObject({ authorityId: "authority-2" });
    expect(client.getSnapshot()).toMatchObject({
      authorityId: "authority-2",
      sessionId: "session-2",
    });
  });

  it("retires pending lifecycle work on dispose and permits a clean remount baseline", async () => {
    let handler: ((payload: unknown) => void) | undefined;
    let resolveStart: ((value: unknown) => void) | undefined;
    const unlisten = vi.fn(async () => undefined);
    const invoke = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === "get_snapshot") return snapshot(1);
      if (command === "cancel_lifecycle_operation") {
        const request = args?.request as { operationId: string } | undefined;
        if (!request) throw new Error(`Missing request for command: ${command}`);
        const operationId = request.operationId;
        const operation = {
          failure: "cancelled" as const,
          kind: "start" as const,
          operationId,
          outcome: "cancelled" as const,
        };
        return { contractVersion: 1, operation, snapshot: { ...snapshot(2), operation } };
      }
      return new Promise((resolve) => {
        resolveStart = resolve;
      });
    });
    const observed: number[] = [];
    const client = new MobileVpnFixtureClient({
      invoke,
      listen: async (nextHandler) => {
        handler = nextHandler;
        return { unregister: unlisten } as unknown as PluginListener;
      },
    });
    await client.initialize();
    client.subscribe((value) => observed.push(value.sequence));
    const pending = client.start();
    await vi.waitFor(() => expect(resolveStart).toBeDefined());

    client.dispose();
    const resolve = resolveStart;
    if (resolve) resolve(lifecycleResult("start", "mobile-vpn-start-ignored-1", snapshot(3)));
    await expect(pending).resolves.toMatchObject({ sequence: 1 });
    handler?.(eventPayload(snapshot(4, "unavailable")));
    expect(observed).toEqual([1]);
    expect(unlisten).toHaveBeenCalledOnce();

    await expect(client.initialize()).resolves.toMatchObject({ sequence: 1 });
    expect(client.getSnapshot()).toMatchObject({ sequence: 1 });
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

  it("coalesces a pre-baseline burst to each authority's terminal-last snapshot", async () => {
    let handler: ((payload: unknown) => void) | undefined;
    let resolveBaseline: ((value: MobileVpnSnapshotDto) => void) | undefined;
    const baseline = new Promise<MobileVpnSnapshotDto>((resolve) => {
      resolveBaseline = resolve;
    });
    const client = new MobileVpnFixtureClient({
      invoke: async () => baseline,
      listen: async (nextHandler) => {
        handler = nextHandler;
        return { unregister: vi.fn() } as unknown as PluginListener;
      },
    });
    const initialization = client.initialize();
    await vi.waitFor(() => expect(handler).toBeDefined());

    for (let sequence = 5; sequence <= 80; sequence += 1) {
      handler?.({
        authorityId: "authority-1",
        eventKind: "snapshot-changed",
        eventVersion: 2,
        revision: sequence,
        sequence,
        sessionId: "session-1",
        snapshot: snapshot(sequence, sequence === 80 ? "unavailable" : "starting"),
      });
    }
    resolveBaseline?.(snapshot(4));
    await expect(initialization).resolves.toMatchObject({ phase: "unavailable", sequence: 80 });
  });

  it("fails an unknown event field explicitly instead of silently dropping it", async () => {
    let handler: ((payload: unknown) => void) | undefined;
    const client = new MobileVpnFixtureClient({
      invoke: async () => snapshot(1),
      listen: async (nextHandler) => {
        handler = nextHandler;
        return { unregister: vi.fn() } as unknown as PluginListener;
      },
    });
    await client.initialize();

    expect(() =>
      handler?.({
        authorityId: "authority-1",
        eventKind: "snapshot-changed",
        eventVersion: 2,
        revision: 2,
        sequence: 2,
        sessionId: "session-1",
        snapshot: snapshot(2),
        futureField: true,
      }),
    ).toThrow();
  });

  it("fails closed when the bounded delivery transcript overflows", async () => {
    let handler: ((payload: unknown) => void) | undefined;
    const client = new MobileVpnFixtureClient(
      {
        invoke: async () => snapshot(1),
        listen: async (nextHandler) => {
          handler = nextHandler;
          return { unregister: vi.fn() } as unknown as PluginListener;
        },
      },
      { trace: () => undefined },
    );
    await client.initialize();

    for (let sequence = 2; sequence <= 30; sequence += 1) {
      handler?.(eventPayload(snapshot(sequence)));
    }
    expect(() => handler?.(eventPayload(snapshot(31)))).toThrow(
      "The mobile VPN delivery transcript overflowed.",
    );
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
          profileId: "profile-a",
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
      { digest: configADigest, profileId: "profile-a", revision: "fixture-a" },
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
      { digest: configADigest, profileId: "profile-a", revision: "fixture-a" },
      { operationId: "load-a", signal: controller.signal },
    );
    await vi.waitFor(() => {
      expect(invoke.mock.calls.map(([command]) => command)).toContain("load_config");
    });
    controller.abort();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    const resolve = resolveLoad;
    if (resolve)
      resolve(
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

  it("retires a late successful load after abort without projecting its snapshot", async () => {
    let resolveLoad: ((value: unknown) => void) | undefined;
    const invoke = vi.fn(async (command: string) => {
      if (command === "get_snapshot") return snapshot(4);
      if (command === "cancel_config_load")
        return { accepted: true, contractVersion: 1, operationId: "load-a" };
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
      { digest: configADigest, profileId: "profile-a", revision: "fixture-a" },
      { operationId: "load-a", signal: controller.signal },
    );
    await vi.waitFor(() => expect(resolveLoad).toBeDefined());

    controller.abort();
    const resolve = resolveLoad;
    if (resolve) resolve(loadResult(loadedConfigSnapshot(5)));

    await expect(pending).resolves.toMatchObject({
      cancellation: "too-late",
      failure: "cancelled",
      outcome: "cancelled",
    });
    expect(client.getSnapshot()).toMatchObject({ coreConfigState: "unloaded", sequence: 4 });
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
      { digest: configADigest, profileId: "profile-a", revision: "fixture-a" },
      { operationId: "load-a" },
    );
    await vi.waitFor(() => {
      expect(invoke.mock.calls.map(([command]) => command)).toContain("load_config");
    });

    const duplicate = await client.loadConfig(
      new TextEncoder().encode(configA),
      { digest: configADigest, profileId: "profile-a", revision: "fixture-a" },
      { operationId: "load-b" },
    );
    expect(duplicate).toMatchObject({ failure: "duplicate-command", outcome: "failed" });
    const resolve = resolveLoad;
    if (resolve) resolve(loadResult(loadedConfigSnapshot(5)));
    await expect(first).resolves.toMatchObject({ outcome: "first-load" });

    response = {
      ...loadResult(loadedConfigSnapshot(6)),
      nativeResponse: "password: fictional-secret",
    };
    const malformed = await client.loadConfig(
      new TextEncoder().encode(configA),
      { digest: configADigest, profileId: "profile-a", revision: "fixture-a" },
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

    const resolve = resolveValidation;
    if (resolve) resolve(validationResult(7));
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
    const resolve = resolveValidation;
    if (resolve) resolve(validationResult(12));

    await expect(pending).resolves.toMatchObject({
      failure: "stale-authority",
      sequence: 13,
      sessionId: "session-1",
    });
    expect(client.getSnapshot()?.sequence).toBe(13);
  });
});
