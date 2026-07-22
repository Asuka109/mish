import { describe, expect, it, vi } from "vitest";
import {
  BrowserAuthenticationRequired,
  parseRuntimeBootstrap,
  resolveStartupStatusClient,
} from "./runtime-bootstrap";

const token = "0123456789abcdef".repeat(4);
const settingsSnapshot = {
  adapterKind: "rpc" as const,
  build: { appVersion: "0.1.0", mihomoVersion: "v1.19.29" },
  capabilities: {
    backgroundLaunch: "supported" as const,
    backupRestore: "coming-later" as const,
    expertConfiguration: "coming-later" as const,
    launchAtLogin: "supported" as const,
    nativeSidebarMaterial: "supported" as const,
    networkDns: "supported" as const,
    statusBar: "supported" as const,
    tun: "unavailable" as const,
    updates: "coming-later" as const,
    windowLifecycle: "supported" as const,
  },
  networkDns: {
    dns: null,
    failure: null,
    interfaces: [],
    observedAt: null,
    phase: "unknown" as const,
    source: "macos-system-configuration" as const,
  },
  preferences: {
    appearance: "system" as const,
    language: "en" as const,
    managedPorts: { controller: 9090, proxy: 7890 },
    onboarding: { welcomeInvitation: null },
    startup: {
      launchAtLogin: false,
      launchProxyWhenMishLaunches: false,
      loginLaunchBehavior: "show-window" as const,
    },
    windowCloseBehavior: "hide-to-status-bar" as const,
    windowSurface: "material" as const,
  },
  privacy: {
    authenticated: "confirmed" as const,
    lanControl: "unavailable" as const,
    loopbackOnly: "confirmed" as const,
    originValidated: "confirmed" as const,
  },
  startupRegistration: { desired: false, observed: false, phase: "applied" as const },
  storageRecovered: false,
  tunHelper: {
    availability: "unpackaged" as const,
    expectedVersion: "3",
    health: "not-installed" as const,
    installationId: null,
    installedVersion: null,
    lastFailure: "unpackaged" as const,
    phase: "idle" as const,
  },
};
const supportBundleDependencies = {
  invokeCommitLocalRestore: vi.fn(),
  invokeLocalBackupPreview: vi.fn(),
  invokeLocalBackupSave: vi.fn(),
  invokeLocalRestorePreview: vi.fn(),
  invokeSupportBundlePreview: vi.fn(),
  invokeSupportBundleSave: vi.fn(),
};

describe("desktop runtime bootstrap", () => {
  it.each([
    [false, "browser"],
    [true, "desktop"],
  ] as const)(
    "starts explicit demo fixtures without contacting a backend when desktop is %s",
    async (desktop, runtime) => {
      const invokeBootstrap = vi.fn();
      const startup = await resolveStartupStatusClient({
        demoMode: true,
        invokeBootstrap,
        invokeLocalProfilePreflight: vi.fn(),
        ...supportBundleDependencies,
        isDesktop: () => desktop,
        openWebSocket: vi.fn(),
      });

      expect(startup.runtime).toBe(runtime);
      expect(startup.settingsSnapshot.adapterKind).toBe("fixture");
      expect(invokeBootstrap).not.toHaveBeenCalled();
      startup.dispose();
    },
  );

  it("requires authentication for an ordinary browser instead of exposing fixtures", async () => {
    const invokeBootstrap = vi.fn();
    const invokeLocalProfilePreflight = vi.fn();
    await expect(
      resolveStartupStatusClient({
        invokeBootstrap,
        invokeLocalProfilePreflight,
        ...supportBundleDependencies,
        isDesktop: () => false,
        openWebSocket: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(BrowserAuthenticationRequired);
    expect(invokeBootstrap).not.toHaveBeenCalled();
    expect(invokeLocalProfilePreflight).not.toHaveBeenCalled();
  });

  it("connects an explicitly launched browser client to the authenticated desktop RPC", async () => {
    const clearLaunchPin = vi.fn();
    const saveProof = vi.fn();
    const fetchBootstrap = vi.fn(async () => ({
      authToken: token,
      localBackup: false,
      rpcUrl: "ws://127.0.0.1:43123/rpc",
      settingsSnapshot,
      supportBundleExport: false,
    }));
    const transport = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      readyState: 0,
      removeEventListener: vi.fn(),
      send: vi.fn(),
    };
    const openWebSocket = vi.fn((_url: string) => transport as unknown as WebSocket);

    const startup = await resolveStartupStatusClient({
      browserBootstrap: {
        clearLaunchPin,
        clearProof: vi.fn(),
        createProof: () => "d".repeat(64),
        fetch: fetchBootstrap,
        launchPin: () => "a".repeat(64),
        loadProof: () => null,
        saveProof,
      },
      invokeBootstrap: vi.fn(),
      invokeLocalProfilePreflight: vi.fn(),
      ...supportBundleDependencies,
      isDesktop: () => false,
      openWebSocket,
    });

    expect(fetchBootstrap).toHaveBeenCalledWith("a".repeat(64), "d".repeat(64));
    expect(clearLaunchPin).toHaveBeenCalledOnce();
    expect(saveProof).toHaveBeenCalledWith("d".repeat(64));
    expect(startup.runtime).toBe("browser");
    expect(startup.browserBackendPort).toBe(43_123);
    expect(startup.settingsSnapshot.adapterKind).toBe("rpc");
    const request = startup.client?.getSnapshot();
    expect(openWebSocket).toHaveBeenCalledWith("ws://127.0.0.1:43123/rpc");
    startup.dispose();
    await expect(request).rejects.toMatchObject({ code: "disconnected" });
  });

  it("restores an explicitly launched browser client after a page refresh", async () => {
    const fetchBootstrap = vi.fn(async () => ({
      authToken: token,
      localBackup: false,
      rpcUrl: "ws://127.0.0.1:43123/rpc",
      settingsSnapshot,
      supportBundleExport: false,
    }));
    const startup = await resolveStartupStatusClient({
      browserBootstrap: {
        clearLaunchPin: vi.fn(),
        clearProof: vi.fn(),
        createProof: () => "d".repeat(64),
        fetch: fetchBootstrap,
        launchPin: () => null,
        loadProof: () => "e".repeat(64),
        saveProof: vi.fn(),
      },
      invokeBootstrap: vi.fn(),
      invokeLocalProfilePreflight: vi.fn(),
      ...supportBundleDependencies,
      isDesktop: () => false,
      openWebSocket: vi.fn(),
    });

    expect(fetchBootstrap).toHaveBeenCalledWith(null, "e".repeat(64));
    expect(startup.settingsSnapshot.adapterKind).toBe("rpc");
    startup.dispose();
  });

  it("routes local profile preflight only through the injected native boundary", async () => {
    const invokeLocalProfilePreflight = vi.fn(async () => null);
    const startup = await resolveStartupStatusClient({
      invokeBootstrap: async () => ({
        authToken: token,
        localBackup: true,
        rpcUrl: "ws://127.0.0.1:43123/rpc",
        settingsSnapshot,
        supportBundleExport: true,
      }),
      invokeLocalProfilePreflight,
      ...supportBundleDependencies,
      isDesktop: () => true,
      openWebSocket: vi.fn(),
    });

    await expect(startup.profileClient?.preflightLocal("Local profile")).resolves.toBeNull();
    expect(invokeLocalProfilePreflight).toHaveBeenCalledWith("Local profile");
    startup.dispose();
  });

  it("keeps support bundle commands unavailable when desktop bootstrap omits the capability", async () => {
    const startup = await resolveStartupStatusClient({
      invokeBootstrap: async () => ({
        authToken: token,
        localBackup: false,
        nativeSidebarMaterial: true,
        rpcUrl: "ws://127.0.0.1:43123/rpc",
        settingsSnapshot,
        supportBundleExport: false,
      }),
      invokeLocalProfilePreflight: vi.fn(),
      ...supportBundleDependencies,
      isDesktop: () => true,
      openWebSocket: vi.fn(),
    });

    expect(startup.supportBundleClient.availability).toBe("unavailable");
    expect(startup.browserBackendPort).toBeUndefined();
    startup.dispose();
  });

  it("accepts only an uncredentialed loopback WebSocket endpoint", () => {
    expect(
      parseRuntimeBootstrap({
        authToken: token,
        localBackup: true,
        rpcUrl: "ws://127.0.0.1:43123/rpc",
        settingsSnapshot,
        supportBundleExport: true,
      }),
    ).toEqual({
      authToken: token,
      localBackup: true,
      rpcUrl: "ws://127.0.0.1:43123/rpc",
      settingsSnapshot: {
        ...settingsSnapshot,
        preferences: {
          ...settingsSnapshot.preferences,
          captureSelection: { systemProxy: false, tun: false },
        },
      },
      supportBundleExport: true,
    });

    for (const rpcUrl of [
      "wss://127.0.0.1:43123/rpc",
      "ws://localhost:43123/rpc",
      "ws://192.168.1.2:43123/rpc",
      "ws://token@127.0.0.1:43123/rpc",
      "ws://127.0.0.1:43123/rpc?token=secret",
      "ws://127.0.0.1:43123/other",
    ]) {
      expect(() =>
        parseRuntimeBootstrap({
          authToken: token,
          localBackup: true,
          rpcUrl,
          settingsSnapshot,
          supportBundleExport: true,
        }),
      ).toThrow();
    }
  });

  it("takes native material capability only from the validated settings snapshot", () => {
    expect(() =>
      parseRuntimeBootstrap({ authToken: token, rpcUrl: "ws://127.0.0.1:43123/rpc" }),
    ).toThrow();
    expect(() =>
      parseRuntimeBootstrap({
        authToken: token,
        localBackup: true,
        rpcUrl: "ws://127.0.0.1:43123/rpc",
        settingsSnapshot: {
          ...settingsSnapshot,
          capabilities: { ...settingsSnapshot.capabilities, nativeSidebarMaterial: "macos" },
        },
      }),
    ).toThrow();
  });

  it("keeps the token in the RPC authentication message instead of the endpoint", async () => {
    const transport = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      readyState: 0,
      removeEventListener: vi.fn(),
      send: vi.fn(),
    };
    const openWebSocket = vi.fn((_url: string) => transport as unknown as WebSocket);
    const startup = await resolveStartupStatusClient({
      invokeBootstrap: async () => ({
        authToken: token,
        localBackup: true,
        rpcUrl: "ws://127.0.0.1:43123/rpc",
        settingsSnapshot,
        supportBundleExport: true,
      }),
      invokeLocalProfilePreflight: vi.fn(),
      ...supportBundleDependencies,
      isDesktop: () => true,
      openWebSocket,
    });

    const request = startup.client?.getSnapshot();
    expect(startup.runtime).toBe("desktop");
    expect(startup.settingsSnapshot.capabilities.nativeSidebarMaterial).toBe("supported");
    expect(openWebSocket).toHaveBeenCalledWith("ws://127.0.0.1:43123/rpc");
    expect(openWebSocket.mock.calls[0][0]).not.toContain(token);
    startup.dispose();
    await expect(request).rejects.toMatchObject({ code: "disconnected" });
  });
});
