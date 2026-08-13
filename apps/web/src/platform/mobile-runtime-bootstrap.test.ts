import { describe, expect, it, vi } from "vitest";
import { createFixtureSettingsSnapshot } from "../data/fixture-settings-client";
import { FixtureStatusClient } from "../data/fixture-status-client";
import { resolveMobileStartup } from "./mobile-runtime-bootstrap";
import { MobileSettingsClient } from "./mobile-settings-client";
import type { MobileVpnClient } from "./mobile-vpn-client";

const fixture = {
  adapterKind: "native",
  contractVersion: 1,
  core: { availability: "available", kind: "native" },
  message: "Android VPN and embedded Mobile Core boundaries are available through typed commands.",
  platform: "android",
  targetAbis: ["arm64-v8a", "x86_64"],
  vpn: { availability: "available", kind: "native" },
};

const vpnSnapshot = {
  activationSessionId: null,
  activeNetwork: false,
  authorityId: "bootstrap-authority",
  backendKind: "fixture" as const,
  contractVersion: 1 as const,
  coreAbiVersion: null,
  coreAvailability: "unavailable" as const,
  coreRunning: false,
  coreCommit: null,
  configFailureInjectionAvailable: false,
  coreConfigState: "unloaded" as const,
  coreVersion: null,
  coreWrapperRevision: null,
  dnsApplied: false,
  failure: null,
  foreground: false,
  loadedConfigDigest: null,
  loadedConfigRevision: null,
  message: "Fixture only. No TUN or Core is available.",
  notificationPermission: "required" as const,
  operation: null,
  permission: "required" as const,
  phase: "permission-required" as const,
  protectedSocketCount: 0,
  publicRequestObserved: false,
  revision: 1,
  routesApplied: false,
  sequence: 1,
  sessionId: "session-1",
  updatedAtMillis: 1,
  validatedConfigDigest: null,
  validatedConfigRevision: null,
  vpnActive: false as const,
  vpnAvailability: "unavailable" as const,
  tunAvailability: "unavailable" as const,
  tunEstablished: false,
};

function createVpnClient(): MobileVpnClient & { publishConfigCommit(): void } {
  const configCommitSubscribers = new Set<() => void>();
  return {
    dispose: vi.fn(),
    getSnapshot: () => vpnSnapshot,
    initialize: vi.fn(async () => vpnSnapshot),
    loadConfig: vi.fn(async (_bytes, identity) => ({
      cancellation: "not-requested" as const,
      contractVersion: 1 as const,
      digest: identity.digest,
      failure: "core-unavailable" as const,
      message: "The packaged Mobile Core is unavailable.",
      operationId: "bootstrap-load",
      outcome: "failed" as const,
      revision: identity.revision,
      rollback: "unloaded" as const,
      snapshot: vpnSnapshot,
      timing: "on-time" as const,
    })),
    requestNotificationPermission: vi.fn(async () => vpnSnapshot),
    requestVpnConsent: vi.fn(async () => vpnSnapshot),
    start: vi.fn(async () => vpnSnapshot),
    stop: vi.fn(async () => vpnSnapshot),
    subscribe: vi.fn(() => () => undefined),
    subscribeConfigCommits: vi.fn((handler) => {
      configCommitSubscribers.add(handler);
      return () => configCommitSubscribers.delete(handler);
    }),
    publishConfigCommit: () => {
      for (const subscriber of configCommitSubscribers) subscriber();
    },
    validateConfig: vi.fn(async () => ({
      contractVersion: 1 as const,
      failure: "core-unavailable" as const,
      message: "The packaged Mobile Core is unavailable.",
      outcome: "failed" as const,
      sequence: vpnSnapshot.sequence,
      sessionId: vpnSnapshot.sessionId,
    })),
  };
}

function createSettingsClient() {
  const snapshot = { ...createFixtureSettingsSnapshot(), adapterKind: "native" as const };
  return new MobileSettingsClient({ invoke: vi.fn(async () => snapshot) });
}

describe("mobile native fixture bootstrap", () => {
  it("uses and disposes the injected native Status adapter", async () => {
    const mobileStatusClient = new FixtureStatusClient();
    const disposeStatus = vi.spyOn(mobileStatusClient, "dispose");
    const startup = await resolveMobileStartup({
      invokeBootstrap: async () => fixture,
      mobileSettingsClient: createSettingsClient(),
      mobileStatusClient,
      mobileVpnClient: createVpnClient(),
    });

    expect(startup.client).toBe(mobileStatusClient);
    startup.dispose();
    expect(disposeStatus).toHaveBeenCalledOnce();
  });

  it("refreshes the authoritative Routes baseline after a native config commit", async () => {
    const mobileStatusClient = new FixtureStatusClient();
    const refresh = vi
      .spyOn(mobileStatusClient, "getSnapshot")
      .mockRejectedValueOnce(new Error("Routes are unavailable before the first config commit."));
    const mobileVpnClient = createVpnClient();
    const startup = await resolveMobileStartup({
      invokeBootstrap: async () => fixture,
      mobileSettingsClient: createSettingsClient(),
      mobileStatusClient,
      mobileVpnClient,
    });

    await expect(startup.client?.getSnapshot()).rejects.toThrow("Routes are unavailable");
    mobileVpnClient.publishConfigCommit();
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(2));
    startup.dispose();
    mobileVpnClient.publishConfigCommit();
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("constructs native mobile clients without desktop bootstrap or sockets", async () => {
    const invokeBootstrap = vi.fn(async () => fixture);
    const mobileVpnClient = createVpnClient();
    const startup = await resolveMobileStartup({
      invokeBootstrap,
      mobileSettingsClient: createSettingsClient(),
      mobileVpnClient,
    });

    expect(invokeBootstrap).toHaveBeenCalledOnce();
    expect(startup.runtime).toBe("mobile");
    expect(startup.mobileFixture).toEqual(fixture);
    expect(startup.mobileVpnSnapshot).toEqual(vpnSnapshot);
    expect(startup.settingsSnapshot.adapterKind).toBe("native");
    await expect(startup.client?.getSnapshot()).resolves.toMatchObject({
      adapterKind: "native",
      capabilities: { systemProxy: "unavailable", tun: "unavailable" },
      runtime: { phase: "inactive", systemProxyEnabled: false, tunEnabled: false },
    });
  });

  it("keeps a host-only Android-shaped fixture on the fixture Settings adapter", async () => {
    const hostFixture = {
      ...fixture,
      core: { availability: "unavailable", kind: "fixture" },
      vpn: { availability: "unavailable", kind: "fixture" },
    };

    const startup = await resolveMobileStartup({
      invokeBootstrap: async () => hostFixture,
      mobileSettingsClient: createSettingsClient(),
      mobileVpnClient: createVpnClient(),
    });

    expect(startup.settingsSnapshot.adapterKind).toBe("fixture");
  });

  it("keeps a native-labelled mobile fixture Capture-unsupported", async () => {
    const startup = await resolveMobileStartup({
      invokeBootstrap: async () => fixture,
      mobileSettingsClient: createSettingsClient(),
      mobileVpnClient: createVpnClient(),
    });
    const client = startup.client;
    if (!client) throw new Error("Missing mobile fixture status client");
    const before = await client.getSnapshot();

    expect(client.supportsCommand("capture")).toBe(false);
    await expect(client.setCapture({ systemProxy: true, tun: false }, true)).rejects.toMatchObject({
      code: "unsupported",
    });
    await expect(client.getSnapshot()).resolves.toEqual(before);
    startup.dispose();
  });

  it("rejects malformed or capability-inflating native messages", async () => {
    await expect(
      resolveMobileStartup({
        invokeBootstrap: async () => ({ ...fixture, vpn: { availability: "supported" } }),
        mobileSettingsClient: createSettingsClient(),
        mobileVpnClient: createVpnClient(),
      }),
    ).rejects.toThrow();
  });
});
