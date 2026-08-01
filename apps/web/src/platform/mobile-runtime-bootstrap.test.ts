import { describe, expect, it, vi } from "vitest";
import { resolveMobileStartup } from "./mobile-runtime-bootstrap";
import type { MobileVpnClient } from "./mobile-vpn-client";

const fixture = {
  adapterKind: "native",
  contractVersion: 1,
  core: { availability: "unavailable", kind: "fixture" },
  message: "Native fixture connected. VPN and embedded Core are not implemented.",
  platform: "android",
  targetAbis: ["arm64-v8a", "x86_64"],
  vpn: { availability: "unavailable", kind: "fixture" },
};

const vpnSnapshot = {
  authorityId: "bootstrap-authority",
  backendKind: "fixture" as const,
  contractVersion: 1 as const,
  coreAbiVersion: null,
  coreAvailability: "unavailable" as const,
  coreCommit: null,
  configFailureInjectionAvailable: false,
  coreConfigState: "unloaded" as const,
  coreVersion: null,
  coreWrapperRevision: null,
  foreground: false,
  loadedConfigDigest: null,
  loadedConfigRevision: null,
  message: "Fixture only. No TUN or Core is available.",
  notificationPermission: "required" as const,
  operation: null,
  permission: "required" as const,
  phase: "permission-required" as const,
  revision: 1,
  sequence: 1,
  sessionId: "session-1",
  updatedAtMillis: 1,
  validatedConfigDigest: null,
  validatedConfigRevision: null,
  vpnActive: false as const,
  vpnAvailability: "unavailable" as const,
  tunAvailability: "unavailable" as const,
};

function createVpnClient(): MobileVpnClient {
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
    startFixtureLifecycle: vi.fn(async () => vpnSnapshot),
    stop: vi.fn(async () => vpnSnapshot),
    subscribe: vi.fn(() => () => undefined),
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

describe("mobile native fixture bootstrap", () => {
  it("constructs native mobile clients without desktop bootstrap or sockets", async () => {
    const invokeBootstrap = vi.fn(async () => fixture);
    const mobileVpnClient = createVpnClient();
    const startup = await resolveMobileStartup({ invokeBootstrap, mobileVpnClient });

    expect(invokeBootstrap).toHaveBeenCalledOnce();
    expect(startup.runtime).toBe("mobile");
    expect(startup.mobileFixture).toEqual(fixture);
    expect(startup.mobileVpnSnapshot).toEqual(vpnSnapshot);
    await expect(startup.client?.getSnapshot()).resolves.toMatchObject({
      adapterKind: "native",
      capabilities: { systemProxy: "unavailable", tun: "unavailable" },
      runtime: { phase: "inactive", systemProxyEnabled: false, tunEnabled: false },
    });
  });

  it("rejects malformed or capability-inflating native messages", async () => {
    await expect(
      resolveMobileStartup({
        invokeBootstrap: async () => ({ ...fixture, vpn: { availability: "supported" } }),
        mobileVpnClient: createVpnClient(),
      }),
    ).rejects.toThrow();
  });
});
