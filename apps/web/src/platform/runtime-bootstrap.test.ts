import { describe, expect, it, vi } from "vitest";
import {
  BrowserAuthenticationRequired,
  ElectronBackendUnavailable,
  browserLaunchTokenFromLocation,
  consumeBrowserLaunchTokenFromLocation,
  parseRuntimeBootstrap,
  resolveStartupStatusClient,
} from "./runtime-bootstrap";

const token = "0123456789abcdef".repeat(4);
const settingsSnapshot = {
  adapterKind: "rpc" as const,
  applicationOrder: { authorityId: "runtime-bootstrap", epoch: 1, order: 1 },
  build: { appVersion: "0.1.0", mihomoVersion: "v1.19.29" },
  capabilities: {
    backgroundLaunch: "supported" as const,
    backupRestore: "coming-later" as const,
    expertConfiguration: "coming-later" as const,
    launchAtLogin: "supported" as const,
    nativeSidebarMaterial: "supported" as const,
    networkDns: "supported" as const,
    policyGroupConnectionCleanup: "supported" as const,
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
    closeOldConnectionsAfterGroupSwitch: false,
    language: "en" as const,
    managedPorts: { controller: 9090, proxy: 7890 },
    onboarding: { welcomeInvitation: null },
    processDiscoveryMode: "always" as const,
    startup: {
      launchAtLogin: false,
      launchBehavior: "off",
      loginLaunchBehavior: "show-window" as const,
    },
    systemProxyTakeoverPolicy: "protect-existing" as const,
    windowCloseBehavior: "hide-to-status-bar" as const,
    windowSurface: "material" as const,
  },
  privacy: {
    authenticated: "confirmed" as const,
    lanControl: "unavailable" as const,
    loopbackOnly: "confirmed" as const,
    originValidated: "confirmed" as const,
  },
  revision: 1,
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
    removal: "not-installed" as const,
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
  it("fails closed in the Electron shell until a backend is explicitly composed", async () => {
    await expect(
      resolveStartupStatusClient({
        invokeBootstrap: vi.fn(),
        invokeLocalProfilePreflight: vi.fn(),
        ...supportBundleDependencies,
        isDesktop: () => false,
        isElectron: () => true,
        openWebSocket: vi.fn(),
      }),
    ).rejects.toBeInstanceOf(ElectronBackendUnavailable);
  });

  it.each([
    "/",
    "/status",
    "/routes",
    "/routes/proxy",
    "/profiles",
    "/traffic",
    "/events",
    "/settings",
    "/activity",
  ])("accepts Browser Client launch capabilities on recognized route %s", (pathname) => {
    const launchToken = "a".repeat(43);
    expect(
      browserLaunchTokenFromLocation({
        hash: `#token=${launchToken}`,
        pathname,
      }),
    ).toBe(launchToken);
  });

  it.each(["/unknown", "/status/details", "/routes/proxy/children/direct"])(
    "rejects Browser Client launch capabilities on unknown route %s",
    (pathname) => {
      expect(
        browserLaunchTokenFromLocation({ hash: `#token=${"a".repeat(43)}`, pathname }),
      ).toBeNull();
    },
  );

  it("rejects malformed Browser Client launch capabilities", () => {
    expect(browserLaunchTokenFromLocation({ hash: "#token=short", pathname: "/" })).toBeNull();
  });

  it("consumes the launch fragment without replacing the requested route, query, or history state", () => {
    const history = { replaceState: vi.fn(), state: { navigation: "original" } };
    const launchToken = "a".repeat(43);

    expect(
      consumeBrowserLaunchTokenFromLocation(
        {
          hash: `#token=${launchToken}`,
          origin: "http://127.0.0.1:6474",
          pathname: "/routes/proxy",
          search: "?sort=latency",
        },
        history,
      ),
    ).toBe(launchToken);
    expect(history.replaceState).toHaveBeenCalledWith(
      history.state,
      "",
      "http://127.0.0.1:6474/routes/proxy?sort=latency",
    );
  });

  it.each([
    ["/status", "#token=short"],
    ["/unknown", `#token=${"a".repeat(43)}`],
  ])(
    "scrubs a rejected launch fragment from %s before authentication fallback",
    (pathname, hash) => {
      const history = { replaceState: vi.fn(), state: null };
      expect(
        consumeBrowserLaunchTokenFromLocation(
          { hash, origin: "http://127.0.0.1:6474", pathname, search: "" },
          history,
        ),
      ).toBeNull();
      expect(history.replaceState).toHaveBeenCalledWith(
        null,
        "",
        `http://127.0.0.1:6474${pathname}`,
      );
    },
  );

  it("leaves unrelated fragments untouched", () => {
    const history = { replaceState: vi.fn(), state: null };
    expect(
      consumeBrowserLaunchTokenFromLocation(
        {
          hash: "#section=advanced",
          origin: "http://127.0.0.1:6474",
          pathname: "/settings",
          search: "",
        },
        history,
      ),
    ).toBeNull();
    expect(history.replaceState).not.toHaveBeenCalled();
  });

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
    const consumeLaunchToken = vi.fn(() => "a".repeat(43));
    const saveProof = vi.fn();
    const browserSettingsSnapshot = {
      ...settingsSnapshot,
      capabilities: { ...settingsSnapshot.capabilities, tun: "supported" as const },
    };
    const fetchBootstrap = vi.fn(async () => ({
      authToken: token,
      localBackup: false,
      rpcUrl: "ws://127.0.0.1:43123/rpc",
      settingsSnapshot: browserSettingsSnapshot,
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
        clearProof: vi.fn(),
        consumeLaunchToken,
        createProof: () => "d".repeat(64),
        fetch: fetchBootstrap,
        loadProof: () => null,
        saveProof,
      },
      invokeBootstrap: vi.fn(),
      invokeLocalProfilePreflight: vi.fn(),
      ...supportBundleDependencies,
      isDesktop: () => false,
      openWebSocket,
    });

    expect(fetchBootstrap).toHaveBeenCalledWith("a".repeat(43), "d".repeat(64));
    expect(consumeLaunchToken).toHaveBeenCalledOnce();
    expect(saveProof).toHaveBeenCalledWith("d".repeat(64));
    expect(startup.runtime).toBe("browser");
    expect(startup.browserBackendPort).toBe(43_123);
    expect(startup.settingsSnapshot.adapterKind).toBe("rpc");
    expect(startup.settingsSnapshot.capabilities.tun).toBe("supported");
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
        clearProof: vi.fn(),
        consumeLaunchToken: () => null,
        createProof: () => "d".repeat(64),
        fetch: fetchBootstrap,
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
        tunHelperOperation: {
          admittedRevision: 0,
          failure: null,
          operation: null,
          operationId: null,
          outcome: null,
          phase: "idle",
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
    const transports = Array.from({ length: 1 }, () => ({
      addEventListener: vi.fn(),
      close: vi.fn(),
      readyState: 0,
      removeEventListener: vi.fn(),
      send: vi.fn(),
    }));
    const openWebSocket = vi.fn(
      (_url: string) => transports[openWebSocket.mock.calls.length - 1] as unknown as WebSocket,
    );
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

    const statusRequest = startup.client?.getSnapshot();
    expect(startup.runtime).toBe("desktop");
    expect(startup.settingsSnapshot.capabilities.nativeSidebarMaterial).toBe("supported");
    expect(openWebSocket).toHaveBeenCalledTimes(1);
    expect(openWebSocket).toHaveBeenNthCalledWith(1, "ws://127.0.0.1:43123/rpc");
    expect(openWebSocket.mock.calls[0]?.[0]).not.toContain(token);
    startup.dispose();
    await expect(statusRequest).rejects.toMatchObject({ code: "disconnected" });
  });
});
