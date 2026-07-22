import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mish/ui";
import {
  SERVICE_ICON_URLS,
  StatusClientError,
  type AppearancePreference,
  type CaptureSelectionDto,
  type EventsClient,
  type ProfileClient,
  type ProfileRouteCatalogDto,
  type ProfileSnapshotDto,
  type LanguagePreference,
  type LocalBackupClient,
  type LocalBackupScopeDto,
  type LocalProxyTestPhase,
  type OnboardingWelcomeAction,
  type RoutingMode,
  type SettingsClient,
  type SettingsSnapshotDto,
  type StartupPreferencesDto,
  type StatusClient,
  type StatusCommand,
  type StatusConnectionState,
  type StatusSnapshotDto,
  type WindowSurfacePreference,
} from "@mish/contracts";
import { AppRoutes, RoutePending } from "./app";
import { AppearanceProvider } from "./appearance";
import { FixtureStatusClient } from "./data/fixture-status-client";
import { FixtureProfileClient } from "./data/fixture-profile-client";
import { ProductProvider } from "./data/product-provider";
import { EventsProvider } from "./data/events-provider";
import { createFixtureEventsClient } from "./data/fixture-events-client";
import {
  FixtureSettingsClient,
  createFixtureSettingsSnapshot,
} from "./data/fixture-settings-client";
import { SettingsProvider } from "./data/settings-provider";
import { ProfileProvider } from "./data/profile-provider";
import { TrafficProvider } from "./data/traffic-provider";
import { StartupFailure } from "./components/startup-failure";
import TypesafeI18n from "./i18n/i18n-react";
import type { Locales } from "./i18n/i18n-types";
import { loadAllLocales } from "./i18n/i18n-util.sync";

loadAllLocales();

function renderRoute(
  path: string,
  locale: Locales = "en",
  client?: StatusClient,
  profileClient?: ProfileClient,
  settingsClient: SettingsClient = new FixtureSettingsClient(),
  settingsSnapshot: SettingsSnapshotDto = createFixtureSettingsSnapshot(),
  localBackupClient?: LocalBackupClient,
  eventsClient?: EventsClient,
) {
  return render(
    <SettingsProvider
      client={settingsClient}
      initialSnapshot={settingsSnapshot}
      localBackupClient={localBackupClient}
    >
      <AppearanceProvider
        initialPreference={settingsSnapshot.preferences.appearance}
        initialWindowSurfacePreference={settingsSnapshot.preferences.windowSurface}
        nativeSidebarMaterialSupported={
          settingsSnapshot.capabilities.nativeSidebarMaterial === "supported"
        }
        onPreferenceChange={async (appearance) => {
          await settingsClient.setAppearance(appearance);
          return true;
        }}
        onWindowSurfacePreferenceChange={async (surface) => {
          await settingsClient.setWindowSurface(surface);
          return true;
        }}
      >
        <TypesafeI18n locale={locale}>
          <MemoryRouter initialEntries={[path]}>
            <ProductProvider client={client}>
              <ProfileProvider client={profileClient}>
                <TrafficProvider>
                  <EventsProvider client={eventsClient}>
                    <TooltipProvider>
                      <AppRoutes />
                    </TooltipProvider>
                  </EventsProvider>
                </TrafficProvider>
              </ProfileProvider>
            </ProductProvider>
          </MemoryRouter>
        </TypesafeI18n>
      </AppearanceProvider>
    </SettingsProvider>,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

class DeferredRoutingClient extends FixtureStatusClient {
  calls = 0;
  rejectCommand: (() => void) | null = null;

  override setRoutingMode(_mode: RoutingMode) {
    this.calls += 1;
    return new Promise<Awaited<ReturnType<FixtureStatusClient["getSnapshot"]>>>((_, reject) => {
      this.rejectCommand = () =>
        reject(new StatusClientError("conflict", "Routing command failed", true));
    });
  }
}

class CancellableRoutingClient extends FixtureStatusClient {
  aborted = false;

  override setRoutingMode(
    _mode: RoutingMode,
    options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto> {
    return new Promise((_, reject) => {
      options?.signal?.addEventListener(
        "abort",
        () => {
          this.aborted = true;
          reject(new StatusClientError("cancelled", "Routing command cancelled"));
        },
        { once: true },
      );
    });
  }
}

class FailingServicesClient extends FixtureStatusClient {
  override restoreDefaultServices(): Promise<StatusSnapshotDto> {
    return Promise.reject(new StatusClientError("remote", "Restore failed"));
  }
}

class DeferredServiceProbeClient extends FixtureStatusClient {
  private resolveProbe: ((snapshot: StatusSnapshotDto) => void) | null = null;

  override testServiceMonitor(): Promise<StatusSnapshotDto> {
    return new Promise((resolve) => {
      this.resolveProbe = resolve;
    });
  }

  async completeProbe(monitorId: string, latencyMilliseconds: number) {
    const snapshot = await this.getSnapshot();
    const result = snapshot.probeResults.find((candidate) => candidate.monitorId === monitorId);
    if (!result) throw new Error(`Missing probe result for ${monitorId}`);
    result.latencyMilliseconds = latencyMilliseconds;
    result.status = "healthy";
    this.resolveProbe?.(snapshot);
  }
}

class FailingServiceProbeClient extends FixtureStatusClient {
  override testServiceMonitor(): Promise<StatusSnapshotDto> {
    return Promise.reject(new StatusClientError("remote", "Probe transport failed"));
  }
}

class DesktopSettingsClient implements SettingsClient {
  snapshot: SettingsSnapshotDto = {
    ...createFixtureSettingsSnapshot(),
    adapterKind: "rpc",
    capabilities: {
      backgroundLaunch: "supported",
      backupRestore: "coming-later",
      expertConfiguration: "coming-later",
      launchAtLogin: "supported",
      nativeSidebarMaterial: "supported",
      networkDns: "supported",
      statusBar: "supported",
      tun: "unavailable",
      updates: "coming-later",
      windowLifecycle: "supported",
    },
    networkDns: {
      dns: null,
      failure: null,
      interfaces: [],
      observedAt: null,
      phase: "unknown",
      source: "macos-system-configuration",
    },
    privacy: {
      authenticated: "confirmed",
      lanControl: "unavailable",
      loopbackOnly: "confirmed",
      originValidated: "confirmed",
    },
    startupRegistration: { desired: false, observed: false, phase: "applied" },
  };

  getSnapshot = vi.fn(async () => structuredClone(this.snapshot));
  refreshNetworkDns = vi.fn(async () => {
    this.snapshot.networkDns = {
      dns: {
        resolverCount: 2,
        scopedResolverCount: 1,
        searchDomains: ["office.example"],
        servers: ["192.0.2.53", "2001:db8::53"],
      },
      failure: null,
      interfaces: [
        {
          interface: "en0",
          interfaceKind: "ethernet",
          ipv4Available: true,
          ipv6Available: true,
          service: "Office LAN",
        },
      ],
      observedAt: 1_789_824_600_000,
      phase: "ready",
      source: "macos-system-configuration",
    };
    return this.getSnapshot();
  });
  installTunHelper = vi.fn(async () => this.getSnapshot());
  repairTunHelper = vi.fn(async () => this.getSnapshot());
  removeTunHelper = vi.fn(async () => this.getSnapshot());
  setAppearance = vi.fn(async (appearance: AppearancePreference) => {
    this.snapshot.preferences.appearance = appearance;
    return this.getSnapshot();
  });
  setLanguage = vi.fn(async (language: LanguagePreference) => {
    this.snapshot.preferences.language = language;
    return this.getSnapshot();
  });
  setOnboardingWelcomeState = vi.fn(async (action: OnboardingWelcomeAction) => {
    const invitation = this.snapshot.preferences.onboarding.welcomeInvitation;
    if (!invitation || invitation.completedAt !== null) return this.getSnapshot();
    const observedAt = Math.max(Date.now(), invitation.createdAt);
    invitation.promptedAt ??= observedAt;
    if (action !== "prompt") invitation.firstOpenedAt ??= observedAt;
    if (action === "dismiss") invitation.lastDismissedAt = observedAt;
    if (action === "complete") invitation.completedAt = observedAt;
    return this.getSnapshot();
  });
  setStartup = vi.fn(async (startup: StartupPreferencesDto) => {
    this.snapshot.preferences.startup = startup;
    this.snapshot.startupRegistration = {
      desired: startup.launchAtLogin,
      observed: startup.launchAtLogin,
      phase: "applied",
    };
    return this.getSnapshot();
  });
  setLaunchProxyWhenMishLaunches = vi.fn(async (launchProxyWhenMishLaunches: boolean) => {
    this.snapshot.preferences.startup.launchProxyWhenMishLaunches = launchProxyWhenMishLaunches;
    return this.getSnapshot();
  });
  setManagedPorts = vi.fn(async (managedPorts: { controller: number; proxy: number }) => {
    this.snapshot.preferences.managedPorts = managedPorts;
    return this.getSnapshot();
  });
  findManagedPorts = vi.fn(async () => {
    this.snapshot.preferences.managedPorts = { controller: 29090, proxy: 27890 };
    return this.getSnapshot();
  });
  subscribeSnapshots = vi.fn(
    (_listener: (snapshot: SettingsSnapshotDto) => void) => () => undefined,
  );
  setWindowCloseBehavior = vi.fn(async (behavior: "hide-to-status-bar" | "quit") => {
    this.snapshot.preferences.windowCloseBehavior = behavior;
    return this.getSnapshot();
  });
  setWindowSurface = vi.fn(async (surface: WindowSurfacePreference) => {
    this.snapshot.preferences.windowSurface = surface;
    return this.getSnapshot();
  });
}

function onboardingSettingsClient() {
  const client = new DesktopSettingsClient();
  client.snapshot.preferences.onboarding.welcomeInvitation = {
    completedAt: null,
    createdAt: 1_789_824_600_000,
    firstOpenedAt: null,
    lastDismissedAt: null,
    promptedAt: null,
    version: 2,
  };
  return client;
}

class InactiveDesktopStatusClient extends FixtureStatusClient {
  override getConnectionState(): StatusConnectionState {
    return { attempt: 0, phase: "connected", stale: false };
  }

  override async getSnapshot(options?: { signal?: AbortSignal }) {
    const snapshot = await super.getSnapshot(options);
    snapshot.adapterKind = "rpc";
    snapshot.capabilities = { systemProxy: "supported", tun: "supported" };
    snapshot.runtime.phase = "inactive";
    return snapshot;
  }
}

class FailingSettingsClient extends DesktopSettingsClient {
  override setStartup = vi.fn(
    async (_startup: StartupPreferencesDto): Promise<SettingsSnapshotDto> => {
      throw new Error("Settings update failed");
    },
  );
}

class TestLocalBackupClient implements LocalBackupClient {
  readonly availability = "supported" as const;
  readonly previewExport = vi.fn(async (scope: LocalBackupScopeDto) => ({
    contentBytes: 4_096,
    excludedSensitiveData: [
      "credentials-and-profile-contents" as const,
      "subscription-urls-and-full-paths" as const,
    ],
    fileType: "application/json" as const,
    formatVersion: 1 as const,
    included: { patches: 3, profiles: 0, schedules: 2, settings: 1 },
    includedSensitiveData: [],
    maxBytes: 8_388_608 as const,
    previewId: "preview-1",
    scope,
  }));
  readonly saveExport = vi.fn(async () => ({ status: "written" as const }));
  readonly previewRestore = vi.fn<LocalBackupClient["previewRestore"]>(async () => null);
  readonly commitRestore = vi.fn(async () => ({
    applied: { add: 0, replace: 0, skip: 0, update: 1 },
    settingsSnapshot: createFixtureSettingsSnapshot(),
  }));
}

class FailingCaptureClient extends FixtureStatusClient {
  override setCapture(
    _selection: CaptureSelectionDto,
    _active: boolean,
  ): Promise<StatusSnapshotDto> {
    return Promise.reject(new StatusClientError("remote", "Capture failed"));
  }
}

class EmptyStatusClient extends FixtureStatusClient {
  override async getSnapshot(): Promise<StatusSnapshotDto> {
    const snapshot = await super.getSnapshot();
    snapshot.groups = [];
    snapshot.groupUsage = [];
    snapshot.metrics = {
      activeConnections: 0,
      effectiveRules: 0,
      memoryBytes: 0,
      uptimeSeconds: 0,
    };
    snapshot.traffic = {
      downloadBytesPerSecond: 0,
      downloadSeries: [],
      downloadedBytes: 0,
      uploadBytesPerSecond: 0,
      uploadSeries: [],
      uploadedBytes: 0,
    };
    return snapshot;
  }
}

class ConfiguredStatusProfileClient extends FixtureProfileClient {
  readonly getRoutes = vi.fn(
    async (profileId: string): Promise<ProfileRouteCatalogDto> => ({
      fingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      groups: Array.from({ length: 6 }, (_, index) => ({
        childIds: [`configured-node-${index + 1}`],
        id: `configured-group-${index + 1}`,
        label: `Configured group ${index + 1}`,
        selectedChildId: `configured-node-${index + 1}`,
        type: "selector" as const,
      })),
      nodes: Array.from({ length: 6 }, (_, index) => ({
        id: `configured-node-${index + 1}`,
        label: `Configured node ${index + 1}`,
        latencyMilliseconds: null,
        protocol: "ss",
      })),
      profileId,
      routingMode: "rule",
    }),
  );
}

class SnapshotStatusClient extends FixtureStatusClient {
  constructor(
    private readonly confirmedSnapshot: StatusSnapshotDto,
    private readonly confirmedConnection: StatusConnectionState = {
      attempt: 0,
      phase: "connected",
      stale: false,
    },
  ) {
    super();
  }

  override getConnectionState() {
    return { ...this.confirmedConnection };
  }

  override async getSnapshot() {
    return structuredClone(this.confirmedSnapshot);
  }

  override subscribeConnection(listener: (state: StatusConnectionState) => void) {
    listener(this.getConnectionState());
    return () => false;
  }

  override supportsCommand(_command: StatusCommand) {
    return false;
  }
}

class RecordingCaptureClient extends SnapshotStatusClient {
  readonly setCapture = vi.fn(
    async (selection: CaptureSelectionDto, active: boolean): Promise<StatusSnapshotDto> => {
      const snapshot = await this.getSnapshot();
      snapshot.runtime.captureSelection = selection;
      snapshot.runtime.phase = active ? "healthy" : "inactive";
      snapshot.runtime.systemProxyEnabled = active && selection.systemProxy;
      snapshot.runtime.systemProxy = {
        desired: active && selection.systemProxy,
        failure: null,
        observed: active && selection.systemProxy ? "mish" : "disabled",
        phase: active && selection.systemProxy ? "applied" : "off",
        recoveryActions: [],
      };
      return snapshot;
    },
  );

  override supportsCommand(command: StatusCommand) {
    return command === "capture";
  }
}

class FailingCoreUnhealthyCaptureClient extends SnapshotStatusClient {
  readonly setCapture = vi.fn(async () => {
    throw new StatusClientError("remote", "Capture failed");
  });

  override supportsCommand(command: StatusCommand) {
    return command === "capture";
  }
}

async function managedProfileSnapshot(): Promise<ProfileSnapshotDto> {
  const snapshot: ProfileSnapshotDto = await new FixtureProfileClient().getSnapshot();
  snapshot.adapterKind = "rpc";
  snapshot.activation.availability = "available";
  snapshot.capabilities.activation = "supported";
  return snapshot;
}

function createActivationProfileClient() {
  const fixture = new FixtureProfileClient();
  const activateProfile = vi.fn(async (commandId: string, profileId: string) => {
    const snapshot = await managedProfileSnapshot();
    return {
      ...snapshot.activation,
      commandId,
      operation: "activate" as const,
      phase: "pending" as const,
      targetProfileId: profileId,
    };
  });
  return {
    activateProfile,
    cancelActivation: fixture.cancelActivation.bind(fixture),
    deleteProfile: fixture.deleteProfile.bind(fixture),
    dispose: fixture.dispose.bind(fixture),
    getConnectionState: () => ({ attempt: 0, phase: "connected" as const, stale: false }),
    getPatches: fixture.getPatches.bind(fixture),
    getSnapshot: managedProfileSnapshot,
    preflightHttps: fixture.preflightHttps.bind(fixture),
    preflightLocal: fixture.preflightLocal.bind(fixture),
    refreshProfile: fixture.refreshProfile.bind(fixture),
    replacePatches: fixture.replacePatches.bind(fixture),
    setRefreshPolicy: fixture.setRefreshPolicy.bind(fixture),
    savePreview: fixture.savePreview.bind(fixture),
    stopActiveProfile: fixture.stopActiveProfile.bind(fixture),
    updateAllProviders: fixture.updateAllProviders.bind(fixture),
    updateProvider: fixture.updateProvider.bind(fixture),
    subscribeConnection: (listener) => {
      listener({ attempt: 0, phase: "connected", stale: false });
      return () => undefined;
    },
    subscribeSnapshots: () => () => undefined,
  } satisfies ProfileClient;
}

async function createCompletingActivationProfileClient(
  includeTravelProfile = false,
  initialManagedListenerConflict = false,
) {
  const fixture = new FixtureProfileClient();
  let snapshot = await managedProfileSnapshot();
  if (includeTravelProfile) {
    snapshot.profiles.push({
      ...structuredClone(snapshot.profiles[0]),
      id: "fixture-profile-travel",
      label: "Travel route set",
      status: { ...snapshot.profiles[0].status, active: false },
    });
  }
  const profileId = snapshot.profiles[0].id;
  snapshot.activation.targetProfileId = profileId;
  if (initialManagedListenerConflict) {
    snapshot.activation = {
      ...snapshot.activation,
      failure: "managed-listener-conflict",
      failureEndpoint: "127.0.0.1:7890",
      phase: "failure",
      safeStopped: true,
    };
  }
  const listeners = new Set<(nextSnapshot: ProfileSnapshotDto) => void>();
  const publish = () => {
    const nextSnapshot = structuredClone(snapshot);
    for (const listener of listeners) listener(nextSnapshot);
  };
  const activateProfile = vi.fn(async (commandId: string, targetProfileId: string) => {
    snapshot = {
      ...snapshot,
      activation: {
        ...snapshot.activation,
        commandId,
        operation: "activate",
        phase: "pending",
        targetProfileId,
      },
    };
    queueMicrotask(() => {
      snapshot = {
        ...snapshot,
        activation: {
          ...snapshot.activation,
          activeProfileId: targetProfileId,
          failure: null,
          phase: "success",
          safeStopped: false,
        },
      };
      publish();
    });
    return structuredClone(snapshot.activation);
  });
  return {
    activateProfile,
    cancelActivation: fixture.cancelActivation.bind(fixture),
    deleteProfile: fixture.deleteProfile.bind(fixture),
    dispose: fixture.dispose.bind(fixture),
    getConnectionState: () => ({ attempt: 0, phase: "connected" as const, stale: false }),
    getPatches: fixture.getPatches.bind(fixture),
    getSnapshot: async () => structuredClone(snapshot),
    preflightHttps: fixture.preflightHttps.bind(fixture),
    preflightLocal: fixture.preflightLocal.bind(fixture),
    refreshProfile: fixture.refreshProfile.bind(fixture),
    replacePatches: fixture.replacePatches.bind(fixture),
    setRefreshPolicy: fixture.setRefreshPolicy.bind(fixture),
    savePreview: fixture.savePreview.bind(fixture),
    stopActiveProfile: fixture.stopActiveProfile.bind(fixture),
    subscribeConnection: (listener) => {
      listener({ attempt: 0, phase: "connected", stale: false });
      return () => undefined;
    },
    subscribeSnapshots: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    updateAllProviders: fixture.updateAllProviders.bind(fixture),
    updateProvider: fixture.updateProvider.bind(fixture),
  } satisfies ProfileClient;
}

class DriftRecoveryClient extends SnapshotStatusClient {
  readonly recoverSystemProxy = vi.fn(async () => {
    const snapshot = await this.getSnapshot();
    snapshot.runtime.systemProxy = {
      desired: false,
      failure: null,
      observed: "other",
      phase: "off",
      recoveryActions: [],
    };
    return snapshot;
  });

  override supportsCommand(command: StatusCommand) {
    return command === "capture";
  }
}

class DeferredCaptureClient extends SnapshotStatusClient {
  private readonly listeners = new Set<(snapshot: StatusSnapshotDto) => void>();
  private currentSnapshot: StatusSnapshotDto;

  constructor(snapshot: StatusSnapshotDto) {
    super(snapshot);
    this.currentSnapshot = structuredClone(snapshot);
  }

  override async getSnapshot() {
    return structuredClone(this.currentSnapshot);
  }

  override subscribeSnapshots(listener: (snapshot: StatusSnapshotDto) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  override setCapture(): Promise<StatusSnapshotDto> {
    this.currentSnapshot.runtime.systemProxy.phase = "pending";
    this.currentSnapshot.runtime.tun.phase = "pending";
    for (const listener of this.listeners) listener(structuredClone(this.currentSnapshot));
    return new Promise(() => undefined);
  }

  override supportsCommand(command: StatusCommand) {
    return command === "capture";
  }
}

class LocalProxyPhaseClient extends SnapshotStatusClient {
  constructor(
    snapshot: StatusSnapshotDto,
    private readonly phase: LocalProxyTestPhase,
  ) {
    super(snapshot);
  }

  readonly testLocalProxy = vi.fn(async () => ({
    host: "127.0.0.1" as const,
    phase: this.phase,
    port: 7890 as const,
  }));
}

class DeferredLocalProxyClient extends SnapshotStatusClient {
  private completeTest: (() => void) | null = null;

  readonly testLocalProxy = vi.fn(
    () =>
      new Promise<{ host: "127.0.0.1"; phase: "ready"; port: 7890 }>((resolve) => {
        this.completeTest = () => resolve({ host: "127.0.0.1", phase: "ready", port: 7890 });
      }),
  );

  complete() {
    this.completeTest?.();
  }
}

class FailingLocalProxyClient extends SnapshotStatusClient {
  readonly testLocalProxy = vi.fn(async () => {
    throw new StatusClientError(
      "remote",
      "bridge-token=super-secret controller said arbitrary backend detail",
    );
  });
}

class MutableLocalProxyClient extends LocalProxyPhaseClient {
  private readonly listeners = new Set<(snapshot: StatusSnapshotDto) => void>();

  publish(snapshot: StatusSnapshotDto) {
    for (const listener of this.listeners) listener(structuredClone(snapshot));
  }

  override subscribeSnapshots(listener: (snapshot: StatusSnapshotDto) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

async function createRpcSnapshot(sparse = false) {
  const snapshot = await new FixtureStatusClient().getSnapshot();
  snapshot.adapterKind = "rpc";
  snapshot.capabilities = { systemProxy: "unavailable", tun: "unavailable" };
  snapshot.runtime = {
    captureSelection: { systemProxy: true, tun: false },
    message: "Mihomo is stopped",
    phase: "inactive",
    systemProxy: {
      desired: false,
      failure: null,
      observed: "disabled",
      phase: "off",
      recoveryActions: [],
    },
    systemProxyEnabled: false,
    tun: {
      desired: false,
      failure: null,
      observation: null,
      observed: "disabled",
      phase: "off",
    },
    tunEnabled: false,
  };
  if (!sparse) return snapshot;

  snapshot.activeProfileId = "local";
  snapshot.groups = [];
  snapshot.groupUsage = [];
  snapshot.metrics = {
    activeConnections: 0,
    effectiveRules: 0,
    memoryBytes: 0,
    uptimeSeconds: 0,
  };
  snapshot.nodes = [];
  snapshot.probeResults = [];
  snapshot.profiles = [{ id: "local", label: "Local Mihomo" }];
  snapshot.services = [];
  snapshot.traffic = {
    downloadBytesPerSecond: 0,
    downloadSeries: [],
    downloadedBytes: 0,
    uploadBytesPerSecond: 0,
    uploadSeries: [],
    uploadedBytes: 0,
  };
  return snapshot;
}

describe("production routes", () => {
  it("keeps fast deferred routes visually quiet before showing progress", () => {
    vi.useFakeTimers();
    render(
      <TypesafeI18n locale="en">
        <RoutePending />
      </TypesafeI18n>,
    );

    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(199));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByRole("status")).toBeInTheDocument();
    expect(screen.getByText("Loading…")).toHaveClass("sr-only");
    vi.useRealTimers();
  });

  it("keeps the shell and default Status route on the eager first-frame path", async () => {
    const { container } = renderRoute("/status");

    expect(screen.getByLabelText("Mish")).toBeInTheDocument();
    expect(container.querySelector(".route-loading")).not.toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Status" })).toBeInTheDocument();
  });

  it("presents Mish as the product brand", () => {
    const { container } = renderRoute("/status");
    const brandImages = screen.getByLabelText("Mish").querySelectorAll("img");
    expect(brandImages).toHaveLength(2);
    expect(brandImages[0]).toHaveAttribute("src", "/brand/mish-brand.svg");
    expect(brandImages[1]).toHaveAttribute("src", "/brand/mish-brand-dark.svg");
    expect(brandImages[0]).toHaveAttribute("draggable", "false");
    expect(brandImages[1]).toHaveAttribute("draggable", "false");
    expect(container.querySelector("[data-window-drag-surface='sidebar']")).toHaveClass("sidebar");
    expect(container.querySelector("[data-window-drag-surface='sidebar']")).toHaveAttribute(
      "data-window-drag-behavior",
      "drag-only",
    );
    expect(container.querySelector("[data-window-drag-surface='workspace-top']")).toBeNull();
  });

  it("marks current notifications read on open, retains them, and removes only one item", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    const notificationTrigger = await screen.findByRole("button", {
      name: "Notifications, 2 unread",
    });
    await user.click(notificationTrigger);

    const notificationCenter = await screen.findByRole("dialog");
    expect(
      within(notificationCenter).getByRole("heading", { name: "Notifications" }),
    ).toBeInTheDocument();
    expect(notificationTrigger).toHaveAccessibleName("Notifications, 0 unread");
    const routeMessage = within(notificationCenter).getByText("Synthetic route check failed");
    expect(routeMessage).toHaveClass("notification-message");
    expect(routeMessage).toHaveAttribute("data-native-text-interaction");
    expect(
      within(notificationCenter).getByText(
        "Synthetic DNS lookup timed out for api.fixture.invalid",
      ),
    ).toBeInTheDocument();
    const notificationItems = within(notificationCenter).getAllByRole("listitem");
    expect(notificationItems[0]).toHaveTextContent("Synthetic route check failed");
    expect(notificationItems[1]).toHaveTextContent(
      "Synthetic DNS lookup timed out for api.fixture.invalid",
    );
    expect(within(notificationCenter).queryByText("Platform")).not.toBeInTheDocument();
    expect(within(notificationCenter).queryByText("Mihomo core")).not.toBeInTheDocument();

    const removeRouteNotification = within(notificationCenter).getByRole("button", {
      name: "Remove notification: Synthetic route check failed",
    });
    expect(removeRouteNotification.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
    removeRouteNotification.focus();
    expect(removeRouteNotification).toHaveFocus();
    await user.click(removeRouteNotification);

    expect(routeMessage).not.toBeInTheDocument();
    expect(
      within(notificationCenter).getByText(
        "Synthetic DNS lookup timed out for api.fixture.invalid",
      ),
    ).toBeInTheDocument();
    expect(notificationTrigger).toHaveAccessibleName("Notifications, 0 unread");

    await user.click(notificationTrigger);
    await waitFor(() => expect(notificationCenter).not.toBeInTheDocument());
    expect(notificationTrigger).toHaveAccessibleName("Notifications, 0 unread");
    await user.click(notificationTrigger);

    const reopenedCenter = await screen.findByRole("dialog");
    expect(
      within(reopenedCenter).queryByText("Synthetic route check failed"),
    ).not.toBeInTheDocument();
    expect(
      within(reopenedCenter).getByText("Synthetic DNS lookup timed out for api.fixture.invalid"),
    ).toBeInTheDocument();
  });

  it("proactively prompts an unprompted onboarding invitation only once", async () => {
    const infoToast = vi.spyOn(toast, "info");
    const settingsClient = onboardingSettingsClient();
    const view = renderRoute(
      "/status",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    await waitFor(() =>
      expect(settingsClient.setOnboardingWelcomeState).toHaveBeenCalledWith("prompt"),
    );
    await waitFor(() =>
      expect(infoToast).toHaveBeenCalledWith(
        "Your Mish welcome is ready",
        expect.objectContaining({
          action: expect.objectContaining({
            props: expect.objectContaining({
              actions: [expect.objectContaining({ id: "open-welcome", label: "Open Welcome" })],
              execute: expect.any(Function),
            }),
          }),
          description: "Welcome to Mish. Your introduction is ready whenever you are.",
          duration: Number.POSITIVE_INFINITY,
          id: "onboarding-welcome-prompt",
        }),
      ),
    );
    expect(
      settingsClient.snapshot.preferences.onboarding.welcomeInvitation?.promptedAt,
    ).not.toBeNull();
    expect(
      settingsClient.snapshot.preferences.onboarding.welcomeInvitation?.completedAt,
    ).toBeNull();
    expect(
      settingsClient.setOnboardingWelcomeState.mock.calls.filter(([action]) => action === "prompt"),
    ).toHaveLength(1);
    const toastAction = infoToast.mock.calls.at(-1)?.[1]?.action as
      | { props: { execute(actionId: string): Promise<void> } }
      | undefined;
    expect(toastAction).toBeDefined();
    await act(async () => toastAction?.props.execute("open-welcome"));
    expect(await screen.findByRole("dialog", { name: "Welcome to Mish" })).toBeVisible();
    expect(settingsClient.setOnboardingWelcomeState).toHaveBeenCalledWith("open");

    view.unmount();
    infoToast.mockClear();
    renderRoute(
      "/status",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );
    await act(async () => Promise.resolve());
    expect(infoToast).not.toHaveBeenCalled();
    expect(
      settingsClient.setOnboardingWelcomeState.mock.calls.filter(([action]) => action === "prompt"),
    ).toHaveLength(1);
  });

  it("removes the welcome item locally without completing its durable invitation", async () => {
    const user = userEvent.setup();
    const settingsClient = onboardingSettingsClient();
    const view = renderRoute(
      "/status",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    await waitFor(() =>
      expect(settingsClient.setOnboardingWelcomeState).toHaveBeenCalledWith("prompt"),
    );
    await user.click(
      await screen.findByRole("button", {
        name: /Notifications, \d+ unread/,
      }),
    );
    const notificationCenter = await screen.findByRole("dialog");
    expect(within(notificationCenter).queryByText("Mish")).not.toBeInTheDocument();
    await user.click(
      within(notificationCenter).getByRole("button", {
        name: "Remove notification: Welcome to Mish. Your introduction is ready whenever you are.",
      }),
    );

    expect(within(notificationCenter).queryByRole("button", { name: "Open Welcome" })).toBeNull();
    expect(
      settingsClient.snapshot.preferences.onboarding.welcomeInvitation?.completedAt,
    ).toBeNull();
    expect(settingsClient.setOnboardingWelcomeState).not.toHaveBeenCalledWith("complete");
    expect(settingsClient.setOnboardingWelcomeState).not.toHaveBeenCalledWith("dismiss");

    view.unmount();
    renderRoute(
      "/status",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );
    await user.click(
      await screen.findByRole("button", {
        name: /Notifications, \d+ unread/,
      }),
    );
    expect(await screen.findByRole("button", { name: "Open Welcome" })).toBeVisible();
  });

  it("opens the durable welcome by keyboard, names it, restores focus, and retains it on dismiss", async () => {
    const user = userEvent.setup();
    const settingsClient = onboardingSettingsClient();
    const initialSnapshot = structuredClone(settingsClient.snapshot);
    const view = renderRoute(
      "/status",
      "en",
      undefined,
      undefined,
      settingsClient,
      initialSnapshot,
    );
    const notificationTrigger = await screen.findByRole("button", {
      name: /Notifications, \d+ unread/,
    });

    notificationTrigger.focus();
    await user.keyboard("{Enter}");
    await user.click(await screen.findByRole("button", { name: "Open Welcome" }));

    const welcome = await screen.findByRole("dialog", { name: "Welcome to Mish" });
    const cover = welcome.querySelector("img");
    expect(cover).toHaveAttribute("src", "/onboarding/welcome-cover.webp");
    expect(welcome.querySelector(".welcome-progress")).toBeNull();
    expect(welcome).toHaveTextContent("independent proxy client powered by the Mihomo core");
    const start = within(welcome).getByRole("button", { name: "Show Me Around" });
    const dismiss = within(welcome).getByRole("button", { name: "Not Now" });
    const backdrop = document.querySelector(".dialog-backdrop");
    await waitFor(() => expect(start).toHaveFocus());
    await user.tab({ shift: true });
    expect(dismiss).toHaveFocus();
    await user.tab();
    expect(start).toHaveFocus();
    expect(backdrop).not.toBeNull();
    await user.click(backdrop as HTMLElement);
    expect(welcome).toBeInTheDocument();
    expect(settingsClient.setOnboardingWelcomeState).not.toHaveBeenCalledWith("dismiss");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(welcome).not.toBeInTheDocument());
    await waitFor(() => expect(notificationTrigger).toHaveFocus());
    await waitFor(() =>
      expect(settingsClient.setOnboardingWelcomeState).toHaveBeenLastCalledWith("dismiss"),
    );
    expect(
      settingsClient.snapshot.preferences.onboarding.welcomeInvitation?.completedAt,
    ).toBeNull();
    expect(
      settingsClient.snapshot.preferences.onboarding.welcomeInvitation?.lastDismissedAt,
    ).not.toBeNull();

    view.unmount();
    renderRoute(
      "/status",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );
    await user.click(
      await screen.findByRole("button", {
        name: /Notifications, \d+ unread/,
      }),
    );
    expect(await screen.findByRole("button", { name: "Open Welcome" })).toBeVisible();
  });

  it("renders the welcome invitation and dialog in Simplified Chinese", async () => {
    const user = userEvent.setup();
    const settingsClient = onboardingSettingsClient();
    renderRoute(
      "/status",
      "zh",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    await user.click(await screen.findByRole("button", { name: /通知，\d+ 条未读/ }));
    await user.click(await screen.findByRole("button", { name: "打开欢迎介绍" }));

    const welcome = await screen.findByRole("dialog", { name: "欢迎使用 Mish" });
    expect(welcome).toHaveTextContent("由 Mihomo 内核驱动的独立代理客户端");
    expect(welcome.querySelector(".welcome-progress")).toBeNull();
    expect(within(welcome).getByRole("button", { name: "稍后再说" })).toBeVisible();
    await user.click(within(welcome).getByRole("button", { name: "开始介绍" }));
    const profileTitle = await screen.findByRole("heading", { name: "从一份配置文件开始" });
    const progress = welcome.querySelector(".welcome-progress");
    expect(profileTitle).toHaveFocus();
    expect(welcome.querySelector(".welcome-step-icon")).toBeNull();
    expect(
      (welcome.querySelector(".welcome-concept-grid") as HTMLElement).style.getPropertyValue(
        "--section-grid-columns",
      ),
    ).toBe("1");
    expect(progress).not.toBeNull();
    expect(progress?.querySelectorAll("li")).toHaveLength(3);
    expect(progress?.querySelector("li[aria-current='step']")).toBe(progress?.querySelector("li"));
    expect(progress?.compareDocumentPosition(profileTitle)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(progress).not.toHaveTextContent("第 1 步");
    expect(welcome).toHaveTextContent("大多数服务供应商会提供订阅地址或配置文件");
    await user.click(within(welcome).getByRole("button", { name: "继续" }));
    expect(await screen.findByRole("heading", { name: "让 Mish 接管你的流量" })).toHaveFocus();
    expect(welcome).toHaveTextContent("Mish 需要接管设备流量才能为你提供服务");
    expect(welcome).toHaveTextContent("提供两种不同的接入方式");
    expect(welcome).toHaveTextContent("系统代理");
    expect(welcome).toHaveTextContent("虚拟网卡（TUN）");
    await user.click(within(welcome).getByRole("button", { name: "继续" }));
    expect(await screen.findByRole("heading", { name: "路由与策略组" })).toHaveFocus();
    expect(within(welcome).queryByRole("heading", { name: "规则" })).not.toBeInTheDocument();
    expect(within(welcome).queryByRole("heading", { name: "全局" })).not.toBeInTheDocument();
    expect(within(welcome).queryByRole("heading", { name: "直连" })).not.toBeInTheDocument();
    expect(welcome).toHaveTextContent("大多数情况下使用“规则”模式即可");
    expect(welcome).toHaveTextContent("原本可以直连的流量也会经过代理，通常会变慢");
    expect(welcome).not.toHaveTextContent("国内流量");
    expect(welcome).toHaveTextContent("策略组把规则连接到节点");
    expect(welcome).toHaveTextContent("通过规则让不同的请求分别使用不同的策略");
    expect(welcome).toHaveTextContent("手动或自动地在不同节点间切换");
    expect(welcome).toHaveTextContent("进行故障转移");
    expect(within(welcome).getByRole("button", { name: "开始使用 Mish" })).toBeVisible();
  });

  it("announces completion, removes the invitation durably, and performs no runtime action", async () => {
    const user = userEvent.setup();
    const settingsClient = onboardingSettingsClient();
    const statusClient = new FixtureStatusClient();
    const setCapture = vi.spyOn(statusClient, "setCapture");
    const setRoutingMode = vi.spyOn(statusClient, "setRoutingMode");
    renderRoute(
      "/status",
      "en",
      statusClient,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );
    const notificationTrigger = await screen.findByRole("button", {
      name: /Notifications, \d+ unread/,
    });

    await user.click(notificationTrigger);
    await user.click(await screen.findByRole("button", { name: "Open Welcome" }));
    const welcome = await screen.findByRole("dialog", { name: "Welcome to Mish" });
    await user.click(within(welcome).getByRole("button", { name: "Show Me Around" }));
    await user.click(within(welcome).getByRole("button", { name: "Continue" }));
    await user.click(within(welcome).getByRole("button", { name: "Continue" }));
    await user.click(within(welcome).getByRole("button", { name: "Start Using Mish" }));

    const announcement = await screen.findByText(
      "Welcome complete. The invitation was removed from Notifications.",
    );
    expect(announcement).toHaveAttribute("role", "status");
    await waitFor(() => expect(notificationTrigger).toHaveFocus());
    expect(settingsClient.setOnboardingWelcomeState).toHaveBeenLastCalledWith("complete");
    expect(
      settingsClient.snapshot.preferences.onboarding.welcomeInvitation?.completedAt,
    ).not.toBeNull();
    expect(setCapture).not.toHaveBeenCalled();
    expect(setRoutingMode).not.toHaveBeenCalled();
    expect(settingsClient.installTunHelper).not.toHaveBeenCalled();
    expect(settingsClient.repairTunHelper).not.toHaveBeenCalled();
    expect(settingsClient.removeTunHelper).not.toHaveBeenCalled();

    await user.click(notificationTrigger);
    expect(screen.queryByRole("button", { name: "Open Welcome" })).not.toBeInTheDocument();
  });

  it.each([
    ["/status", "Status"],
    ["/routes", "Routes"],
    ["/profiles", "Profiles"],
    ["/traffic", "Traffic"],
    ["/events", "Events"],
    ["/settings", "Settings"],
  ])("renders %s as a direct deep link", async (path, title) => {
    renderRoute(path);
    expect(await screen.findByRole("heading", { name: title })).toBeInTheDocument();
  });

  it("organizes Settings by outcomes and keeps native-only controls truthfully unavailable", async () => {
    renderRoute("/settings");

    for (const heading of [
      "Capture and startup",
      "Network and DNS",
      "Appearance and interaction",
      "Updates and data",
      "Advanced and support",
    ]) {
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(
      screen.getByText(/cannot perform or confirm native macOS operations/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Off" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Virtual Interface, not selected, not running" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /enable lan/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Window surface")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Native material" })).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Privacy and access" })).not.toBeInTheDocument();
    expect(screen.getByText("Mish 0.1.0")).toBeVisible();
    expect(screen.getByText("Mihomo v1.19.29")).toBeVisible();
    expect(screen.getByRole("button", { name: "Check for Updates" })).toBeDisabled();
  });

  it("saves managed ports and can replace them with an available pair", async () => {
    const user = userEvent.setup();
    const settingsClient = new DesktopSettingsClient();
    renderRoute(
      "/settings",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    const proxyPort = await screen.findByRole("spinbutton", { name: "Managed proxy port" });
    const controllerPort = screen.getByRole("spinbutton", { name: "Managed Controller port" });
    await user.clear(proxyPort);
    await user.type(proxyPort, "17890");
    await user.clear(controllerPort);
    await user.type(controllerPort, "19090");
    await user.click(screen.getByRole("button", { name: "Save Ports" }));

    await waitFor(() =>
      expect(settingsClient.setManagedPorts).toHaveBeenCalledWith({
        controller: 19090,
        proxy: 17890,
      }),
    );
    await user.click(screen.getByRole("button", { name: "Find Available Ports" }));
    await waitFor(() => expect(settingsClient.findManagedPorts).toHaveBeenCalledOnce());
    expect(proxyPort).toHaveValue(27890);
    expect(controllerPort).toHaveValue(29090);
  });

  it("reallocates managed ports and retries the aggregate proxy command", async () => {
    const user = userEvent.setup();
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.captureSelection = { systemProxy: true, tun: false };
    const statusClient = new RecordingCaptureClient(snapshot);
    const profileClient = await createCompletingActivationProfileClient(false, true);
    const settingsClient = new DesktopSettingsClient();
    renderRoute(
      "/status",
      "en",
      statusClient,
      profileClient,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    await user.click(await screen.findByRole("button", { name: /Notifications, \d+ unread/ }));
    const notificationCenter = await screen.findByRole("dialog");
    expect(notificationCenter).toHaveTextContent("Mish could not use 127.0.0.1:7890.");
    await user.click(
      within(notificationCenter).getByRole("button", { name: "Find Ports and Retry" }),
    );

    await waitFor(() => expect(settingsClient.findManagedPorts).toHaveBeenCalledOnce());
    await waitFor(() =>
      expect(statusClient.setCapture).toHaveBeenCalledWith(
        { systemProxy: true, tun: false },
        true,
        "fixture-profile-studio",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("replaces a generic capture failure with the managed-listener explanation", async () => {
    const user = userEvent.setup();
    const errorToast = vi.spyOn(toast, "error");
    const profileClient = await createCompletingActivationProfileClient(false, true);
    renderRoute("/status", "en", new FailingCaptureClient(), profileClient);

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "Mish could not use 127.0.0.1:7890.",
        expect.objectContaining({ id: "managed-listener-conflict" }),
      ),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Virtual Interface, not selected, not running",
      }),
    );
    await waitFor(() => expect(errorToast).toHaveBeenCalledTimes(1));

    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    const notificationCenter = await screen.findByRole("dialog");
    expect(notificationCenter).toHaveTextContent("Mish could not use 127.0.0.1:7890.");
    expect(notificationCenter).not.toHaveTextContent("The command failed.");
  });

  it("delivers an application capture-failure event once across the toast and center", async () => {
    const user = userEvent.setup();
    const errorToast = vi.spyOn(toast, "error");
    const eventsClient = createFixtureEventsClient();
    const eventsSnapshot = await eventsClient.getSnapshot();
    eventsSnapshot.adapterKind = "rpc";
    eventsClient.publishSnapshot(eventsSnapshot);
    const failureEvent = {
      detail: "Restart the active profile and retry only after Status is healthy",
      id: "capture-failure:listener-unavailable",
      level: "error" as const,
      message: "Traffic capture was blocked because the managed listener is unavailable",
      notificationKind: "capture-failure" as const,
      observedAt: Date.now(),
      sequence: eventsSnapshot.sequence + 1,
      source: "application" as const,
    };
    renderRoute(
      "/status",
      "en",
      new FailingCaptureClient(),
      undefined,
      undefined,
      undefined,
      undefined,
      eventsClient,
    );

    await user.click(
      await screen.findByRole("button", {
        name: "Virtual Interface, not selected, not running",
      }),
    );
    eventsClient.publishSnapshot({
      ...eventsSnapshot,
      events: [...eventsSnapshot.events, failureEvent],
      sequence: eventsSnapshot.sequence + 1,
    });
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "Traffic capture was blocked because the managed listener is unavailable",
        expect.objectContaining({ id: "capture-failure:listener-unavailable" }),
      ),
    );
    expect(errorToast).not.toHaveBeenCalledWith("The command failed.", expect.anything());

    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    const notificationCenter = await screen.findByRole("dialog");
    expect(notificationCenter).toHaveTextContent(
      "Traffic capture was blocked because the managed listener is unavailable",
    );
    expect(notificationCenter).toHaveTextContent(
      "Restart the active profile and retry only after Status is healthy",
    );
    expect(notificationCenter).not.toHaveTextContent("The command failed.");
  });

  it("offers a clean helper reinstall when the desktop core is inactive", async () => {
    const user = userEvent.setup();
    const settingsClient = new DesktopSettingsClient();
    settingsClient.snapshot.capabilities.tun = "supported";
    settingsClient.snapshot.tunHelper = {
      availability: "available",
      expectedVersion: "3",
      health: "healthy",
      installationId: "a".repeat(64),
      installedVersion: "3",
      lastFailure: null,
      phase: "idle",
    };
    renderRoute(
      "/settings",
      "en",
      new InactiveDesktopStatusClient(),
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    const reinstall = await screen.findByRole("button", { name: "Clean Reinstall" });
    expect(reinstall).toBeEnabled();
    await user.click(reinstall);

    expect(settingsClient.repairTunHelper).toHaveBeenCalledOnce();
  });

  it("keeps Settings operable by keyboard at the minimum desktop window breakpoint", async () => {
    const user = userEvent.setup();
    Object.defineProperty(window, "innerWidth", { configurable: true, value: 800 });
    window.dispatchEvent(new Event("resize"));
    renderRoute("/settings");

    const dark = await screen.findByRole("button", { name: "Dark" });
    dark.focus();
    await user.keyboard(" ");

    expect(dark).toHaveFocus();
    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));
    expect(screen.getByRole("heading", { name: "Advanced and support" })).toBeVisible();
  });

  it("uses semantic links and preserves an accessible active destination", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    const initialHeading = await screen.findByRole("heading", { name: "Status" });
    await waitFor(() => expect(document.title).toBe("Status — Mish"));
    expect(initialHeading).not.toHaveFocus();

    const routesLink = screen.getByRole("link", { name: "Routes" });
    expect(routesLink).toHaveAttribute("href", "/routes");
    await user.click(routesLink);
    const routesHeading = await screen.findByRole("heading", { name: "Routes" });
    await waitFor(() => expect(routesHeading).toHaveFocus());
    expect(routesLink).toHaveAttribute("aria-current", "page");
  });

  it("supports native sidebar arrow, boundary, and type-ahead navigation", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    const status = screen.getByRole("link", { name: "Status" });
    const routes = screen.getByRole("link", { name: "Routes" });
    const profiles = screen.getByRole("link", { name: "Profiles" });
    const settings = screen.getByRole("link", { name: "Settings" });

    status.focus();
    await user.keyboard("{ArrowDown}");
    expect(routes).toHaveFocus();

    await user.keyboard("p");
    expect(profiles).toHaveFocus();

    await user.keyboard("{End}");
    expect(settings).toHaveFocus();

    await user.keyboard("{ArrowDown}");
    expect(status).toHaveFocus();
  });

  it("restores each destination's scroll position when returning to it", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    const statusHeading = await screen.findByRole("heading", { name: "Status" });
    await waitFor(() => expect(document.title).toBe("Status — Mish"));
    expect(statusHeading).not.toHaveFocus();
    const statusScroller = document.querySelector<HTMLElement>(".workspace-page-scroll");
    expect(statusScroller).not.toBeNull();
    statusScroller!.scrollTop = 180;
    fireEvent.scroll(statusScroller!);

    await user.click(screen.getByRole("link", { name: "Routes" }));
    const routesHeading = await screen.findByRole("heading", { name: "Routes" });
    await waitFor(() => expect(routesHeading).toHaveFocus());
    await user.click(screen.getByRole("link", { name: "Status" }));

    await screen.findByRole("heading", { name: "Status" });
    await waitFor(() =>
      expect(document.querySelector<HTMLElement>(".workspace-page-scroll")?.scrollTop).toBe(180),
    );
  });

  it("keeps compact toolbar menus and proxy control at their intended hierarchy", async () => {
    renderRoute("/status");
    await screen.findByText("Live demo traffic");

    const theme = screen.getByRole("button", {
      name: "Change theme. Current theme: Follow system",
    });
    const language = screen.getByRole("button", {
      name: "Change language. Current language: English",
    });
    const profile = screen.getByRole("combobox", { name: /Switch profile/ });
    const runtimeBadge = screen.getByRole("button", { name: "Demo mode" });
    for (const trigger of [theme, language]) {
      expect(trigger.querySelectorAll("svg")).toHaveLength(1);
    }
    expect(profile.querySelectorAll("svg")).toHaveLength(2);
    expect(profile.parentElement?.firstElementChild).toBe(profile);
    expect(runtimeBadge.parentElement).toHaveClass("toolbar-heading");
    expect(within(runtimeBadge.parentElement!).getByText("Status")).toHaveClass("toolbar-title");
    expect(profile.closest(".toolbar-actions")).not.toContainElement(runtimeBadge);

    const navigation = screen.getByRole("navigation", { name: "Workspace sections" });
    const settings = within(navigation).getByRole("link", { name: "Settings" });
    const proxy = within(navigation).getByRole("button", {
      name: "Launch the Proxy Demo State",
    });
    expect(settings.parentElement).toBe(proxy.parentElement);
    expect(settings.parentElement).toHaveClass("sidebar-bottom-items");
  });

  it("opens the fixture profile menu and keeps selection inside demo state", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    const trigger = await screen.findByRole("combobox", {
      name: "Switch profile. Current profile: Home",
    });
    expect(trigger).toBeEnabled();
    expect(trigger).toHaveAccessibleDescription(/local fixture data only/);

    await user.click(trigger);
    await user.click(await screen.findByRole("option", { name: "Work 工作" }));

    expect(
      await screen.findByRole("combobox", {
        name: "Switch profile. Current profile: Work 工作",
      }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "Launch the Proxy Demo State" })).toBeInTheDocument();
  });

  it("starts with fixture data without opening a socket or making a request", async () => {
    const webSocket = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("WebSocket", webSocket);
    vi.stubGlobal("fetch", fetch);

    renderRoute("/status");
    await screen.findByText("Live demo traffic");

    expect(webSocket).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.getByText("Demo mode")).toBeInTheDocument();
    expect(screen.queryByText("Local service")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Rule" })).toHaveAccessibleDescription(
      /local fixture data only/,
    );
  });
});

describe("desktop RPC experience", () => {
  it("reports listener readiness without changing the Settings row layout", async () => {
    const user = userEvent.setup();
    const successToast = vi.spyOn(toast, "success");
    const settingsClient = new DesktopSettingsClient();
    const snapshot = await createRpcSnapshot();
    const statusClient = new DeferredLocalProxyClient(snapshot);
    renderRoute(
      "/settings",
      "en",
      statusClient,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    expect(await screen.findByText("127.0.0.1:7890")).toBeVisible();
    expect(screen.getByText(/browser extension or an app-specific proxy/i)).toBeVisible();
    expect(screen.getByText(/does not enable or change macOS System Proxy/i)).toBeVisible();
    expect(screen.queryByText("HTTP")).not.toBeInTheDocument();
    expect(screen.queryByText("SOCKS5")).not.toBeInTheDocument();

    const testButton = screen.getByRole("button", { name: "Test Listener" });
    await user.click(testButton);

    await waitFor(() => expect(statusClient.testLocalProxy).toHaveBeenCalledTimes(1));
    expect(testButton).toHaveAttribute("aria-busy", "true");
    expect(testButton.querySelector(".ui-spinner")).toBeInTheDocument();
    expect(testButton).toHaveTextContent("Test Listener");
    expect(screen.queryByText("Testing…")).not.toBeInTheDocument();
    expect(screen.queryByText("Listener ready")).not.toBeInTheDocument();

    act(() => statusClient.complete());

    await waitFor(() =>
      expect(successToast).toHaveBeenCalledWith("Listener ready", expect.any(Object)),
    );
    expect(screen.queryByText("Listener ready")).not.toBeInTheDocument();
    expect(snapshot.runtime.systemProxy.phase).toBe("off");
    expect(snapshot.runtime.systemProxyEnabled).toBe(false);
  });

  it("routes an unhealthy Core listener result through toast and notifications", async () => {
    const user = userEvent.setup();
    const warningToast = vi.spyOn(toast, "warning");
    const snapshot = await createRpcSnapshot();
    const statusClient = new LocalProxyPhaseClient(snapshot, "core-unhealthy");
    renderRoute("/settings", "en", statusClient);

    await user.click(await screen.findByRole("button", { name: "Test Listener" }));

    await waitFor(() =>
      expect(warningToast).toHaveBeenCalledWith(
        "Start the proxy with a valid Profile, then test the listener again.",
        expect.any(Object),
      ),
    );
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Start the proxy with a valid Profile, then test the listener again.",
    );
  });

  it("explains a runtime transition through toast and notifications", async () => {
    const user = userEvent.setup();
    const warningToast = vi.spyOn(toast, "warning");
    const snapshot = await createRpcSnapshot();
    const statusClient = new LocalProxyPhaseClient(snapshot, "runtime-transition");
    renderRoute("/settings", "en", statusClient);

    await user.click(await screen.findByRole("button", { name: "Test Listener" }));

    await waitFor(() =>
      expect(warningToast).toHaveBeenCalledWith(
        "The Core is changing state. Wait for it to finish, then test again.",
        expect.any(Object),
      ),
    );
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "The Core is changing state. Wait for it to finish, then test again.",
    );
  });

  it("reports an unavailable listener through toast and notifications", async () => {
    const user = userEvent.setup();
    const errorToast = vi.spyOn(toast, "error");
    const snapshot = await createRpcSnapshot();
    const statusClient = new LocalProxyPhaseClient(snapshot, "listener-unavailable");
    renderRoute("/settings", "en", statusClient);

    await user.click(await screen.findByRole("button", { name: "Test Listener" }));

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "The local listener did not respond. Confirm the active Profile is healthy, then try again.",
        expect.any(Object),
      ),
    );
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "The local listener did not respond. Confirm the active Profile is healthy, then try again.",
    );
  });

  it("redacts an RPC listener-test failure in toast and notifications", async () => {
    const user = userEvent.setup();
    const errorToast = vi.spyOn(toast, "error");
    const snapshot = await createRpcSnapshot();
    const statusClient = new FailingLocalProxyClient(snapshot);
    renderRoute("/settings", "en", statusClient);

    await user.click(await screen.findByRole("button", { name: "Test Listener" }));

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "Mish could not test the local listener. Check the local service connection and try again.",
        expect.any(Object),
      ),
    );
    expect(document.body).not.toHaveTextContent("super-secret");
    expect(document.body).not.toHaveTextContent("arbitrary backend detail");

    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Mish could not test the local listener. Check the local service connection and try again.",
    );
    expect(document.body).not.toHaveTextContent("super-secret");
    expect(document.body).not.toHaveTextContent("arbitrary backend detail");
  });

  it("expires a listener failure notification when the active runtime changes", async () => {
    const user = userEvent.setup();
    const snapshot = await createRpcSnapshot();
    snapshot.runtime.phase = "healthy";
    const statusClient = new MutableLocalProxyClient(snapshot, "listener-unavailable");
    renderRoute("/settings", "en", statusClient);

    await user.click(await screen.findByRole("button", { name: "Test Listener" }));
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    const notificationCenter = await screen.findByRole("dialog");
    expect(notificationCenter).toHaveTextContent("The local listener did not respond.");

    snapshot.runtime.phase = "stopping";
    act(() => statusClient.publish(snapshot));

    await waitFor(() =>
      expect(notificationCenter).not.toHaveTextContent("The local listener did not respond."),
    );
  });

  it("shows a source-labeled read-only macOS Network and DNS observation", async () => {
    const user = userEvent.setup();
    const settingsClient = new DesktopSettingsClient();
    renderRoute(
      "/settings",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    expect(await screen.findByText("Office LAN")).toBeVisible();
    expect(screen.getByText("en0 · Ethernet")).toBeVisible();
    expect(screen.getByText("2 resolvers · 1 scoped")).toBeVisible();
    expect(screen.getByText("192.0.2.53")).toBeVisible();
    expect(screen.getByText("office.example")).toBeVisible();
    expect(settingsClient.refreshNetworkDns).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole("button", { name: "Refresh Observation" }));
    await waitFor(() => expect(settingsClient.refreshNetworkDns).toHaveBeenCalledTimes(2));
  });

  it("labels retained Network and DNS values stale instead of current", async () => {
    const settingsClient = new DesktopSettingsClient();
    await settingsClient.refreshNetworkDns();
    settingsClient.refreshNetworkDns.mockClear();
    settingsClient.snapshot.networkDns.phase = "stale";
    renderRoute(
      "/settings",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    expect(await screen.findByText("Stale")).toBeVisible();
    expect(
      screen.getByText("The last observation is stale and must not be treated as current."),
    ).toBeVisible();
    expect(screen.getByText("Office LAN")).toBeVisible();
    expect(settingsClient.refreshNetworkDns).not.toHaveBeenCalled();
  });

  it("previews exact local backup scope before opening the native save boundary", async () => {
    const user = userEvent.setup();
    const settingsClient = new DesktopSettingsClient();
    settingsClient.snapshot.capabilities.backupRestore = "supported";
    const backupClient = new TestLocalBackupClient();
    renderRoute(
      "/settings",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
      backupClient,
    );

    await user.click(await screen.findByRole("button", { name: "Create Backup" }));
    const dialog = screen.getByRole("dialog", { name: "Create local backup" });
    expect(within(dialog).getByRole("checkbox", { name: /Application settings/ })).toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: /Profile configuration contents/ }),
    ).not.toBeChecked();
    expect(
      within(dialog).getByRole("checkbox", { name: /Subscription URLs and full local paths/ }),
    ).toBeDisabled();

    await user.click(within(dialog).getByRole("button", { name: "Generate Preview" }));
    expect(await within(dialog).findByText("JSON · v1")).toBeVisible();
    expect(
      within(dialog).getByText(/1 settings · 0 profiles · 3 patches · 2 schedules/),
    ).toBeVisible();
    expect(backupClient.previewExport).toHaveBeenCalledWith({
      patches: true,
      profiles: false,
      schedules: true,
      settings: true,
      sourceLocators: false,
    });

    await user.click(within(dialog).getByRole("button", { name: "Choose Location and Save" }));
    await waitFor(() => expect(backupClient.saveExport).toHaveBeenCalledWith("preview-1"));
    expect(await screen.findByText("The local backup was written atomically.")).toBeVisible();
  });

  it("shows the validated restore scope and both sensitive data classes before confirmation", async () => {
    const user = userEvent.setup();
    const settingsClient = new DesktopSettingsClient();
    settingsClient.snapshot.capabilities.backupRestore = "supported";
    const backupClient = new TestLocalBackupClient();
    backupClient.previewRestore.mockResolvedValueOnce({
      actions: { add: 1, replace: 0, skip: 0, update: 1 },
      conflicts: [],
      contentBytes: 8_192,
      excludedSensitiveData: ["subscription-urls-and-full-paths"],
      fileType: "application/json",
      formatVersion: 1,
      included: { patches: 0, profiles: 1, schedules: 0, settings: 1 },
      includedSensitiveData: ["credentials-and-profile-contents"],
      maxBytes: 8_388_608,
      previewId: "restore-preview-1",
      scope: {
        patches: false,
        profiles: true,
        schedules: false,
        settings: true,
        sourceLocators: false,
      },
    });
    renderRoute(
      "/settings",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
      backupClient,
    );

    await user.click(await screen.findByRole("button", { name: "Restore Backup" }));
    const dialog = await screen.findByRole("dialog", { name: "Review validated restore" });
    const scope = within(dialog).getByRole("region", { name: "Validated restore scope" });
    expect(scope).toHaveTextContent("Application settings · Profile configuration contents");
    expect(scope).toHaveTextContent("Profile credentials and configuration contentsIncluded");
    expect(scope).toHaveTextContent("Subscription URLs and full local pathsExcluded");
    expect(within(dialog).getByRole("button", { name: "Restore Selected Data" })).toBeEnabled();
  });

  it("scopes native material to the sidebar and keeps the workspace opaque", async () => {
    const user = userEvent.setup();
    const settingsClient = new DesktopSettingsClient();
    const view = renderRoute(
      "/settings",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    await screen.findByRole("heading", { name: "Settings" });
    expect(screen.getByText("Window surface")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Native material" })).toBeInTheDocument();
    expect(view.container.querySelector(".sidebar")).toHaveAttribute(
      "data-surface-rendering",
      "material",
    );
    expect(view.container.querySelector(".workspace")).toHaveAttribute(
      "data-surface-rendering",
      "opaque",
    );

    await user.click(screen.getByRole("button", { name: "Opaque" }));

    await waitFor(() => expect(settingsClient.setWindowSurface).toHaveBeenCalledWith("opaque"));
    expect(view.container.querySelector(".sidebar")).toHaveAttribute(
      "data-surface-rendering",
      "opaque",
    );
    expect(view.container.querySelector(".workspace")).toHaveAttribute(
      "data-surface-rendering",
      "opaque",
    );
    expect(settingsClient.setAppearance).not.toHaveBeenCalled();
  });

  it("keeps close behavior independent from login launch behavior", async () => {
    const user = userEvent.setup();
    const settingsClient = new DesktopSettingsClient();
    renderRoute(
      "/settings",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    const hide = await screen.findByRole("button", { name: "Hide to status bar" });
    const quit = screen.getByRole("button", { name: "Quit Mish" });
    expect(hide).toHaveAttribute("aria-pressed", "true");
    await user.click(quit);

    await waitFor(() => expect(settingsClient.setWindowCloseBehavior).toHaveBeenCalledWith("quit"));
    expect(settingsClient.setStartup).not.toHaveBeenCalled();
  });

  it("presents login startup as one exclusive three-state setting", async () => {
    const user = userEvent.setup();
    const settingsClient = new DesktopSettingsClient();
    renderRoute(
      "/settings",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    const off = await screen.findByRole("button", { name: "Off" });
    const showWindow = screen.getByRole("button", { name: "Show Window" });
    const background = screen.getByRole("button", { name: "Background" });
    expect(off).toHaveAttribute("aria-pressed", "true");
    expect(showWindow).not.toBeDisabled();
    expect(background).not.toBeDisabled();
    expect(screen.queryByText("Applied")).not.toBeInTheDocument();

    await user.click(showWindow);
    await waitFor(() =>
      expect(settingsClient.setStartup).toHaveBeenCalledWith({
        launchAtLogin: true,
        launchProxyWhenMishLaunches: false,
        loginLaunchBehavior: "show-window",
      }),
    );
    await waitFor(() => expect(background).not.toBeDisabled());
    await user.click(background);
    await waitFor(() =>
      expect(settingsClient.setStartup).toHaveBeenLastCalledWith({
        launchAtLogin: true,
        launchProxyWhenMishLaunches: false,
        loginLaunchBehavior: "background",
      }),
    );
    await user.click(off);
    await waitFor(() =>
      expect(settingsClient.setStartup).toHaveBeenLastCalledWith({
        launchAtLogin: false,
        launchProxyWhenMishLaunches: false,
        loginLaunchBehavior: "background",
      }),
    );
  });

  it("persists the automatic proxy launch preference independently in English and Chinese", async () => {
    const user = userEvent.setup();
    const settingsClient = new DesktopSettingsClient();
    const { unmount } = renderRoute(
      "/settings",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    expect(screen.getByText("Launch proxy when Mish launches")).toBeInTheDocument();
    expect(screen.getByText(/does not start or stop the proxy now/)).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Launch proxy when Mish launches: On" }));
    await waitFor(() =>
      expect(settingsClient.setLaunchProxyWhenMishLaunches).toHaveBeenCalledWith(true),
    );
    expect(settingsClient.setStartup).not.toHaveBeenCalled();
    unmount();

    renderRoute(
      "/settings",
      "zh",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );
    expect(screen.getByText("启动应用自动代理")).toBeInTheDocument();
    expect(screen.getByText(/切换后不会立即启动或停止代理/)).toBeInTheDocument();
  });

  it("shows login startup status only when the observed registration needs attention", async () => {
    const settingsClient = new DesktopSettingsClient();
    settingsClient.snapshot.startupRegistration = {
      desired: true,
      observed: false,
      phase: "drift",
    };
    renderRoute(
      "/settings",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    expect(await screen.findByText("Needs reconciliation")).toBeInTheDocument();
  });

  it("moves a Settings operation failure into a toast and the notification center", async () => {
    const user = userEvent.setup();
    const errorToast = vi.spyOn(toast, "error");
    const settingsClient = new FailingSettingsClient();
    renderRoute(
      "/settings",
      "en",
      undefined,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    await user.click(await screen.findByRole("button", { name: "Show Window" }));

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "The setting could not be confirmed. The last confirmed state is still shown.",
        expect.any(Object),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "The setting could not be confirmed. The last confirmed state is still shown.",
    );
  });

  it("reuses the System Proxy drift and recovery model inside Settings", async () => {
    const user = userEvent.setup();
    const warningToast = vi.spyOn(toast, "warning");
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.captureSelection.systemProxy = true;
    snapshot.runtime.phase = "healthy";
    snapshot.runtime.systemProxy = {
      desired: true,
      failure: null,
      observed: "other",
      phase: "drift",
      recoveryActions: ["repair", "leave-as-is"],
    };
    const statusClient = new DriftRecoveryClient(snapshot);
    const settingsClient = new DesktopSettingsClient();
    renderRoute(
      "/settings",
      "en",
      statusClient,
      undefined,
      settingsClient,
      structuredClone(settingsClient.snapshot),
    );

    await waitFor(() => expect(warningToast).toHaveBeenCalled());
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    const notificationCenter = await screen.findByRole("dialog");
    expect(notificationCenter).toHaveTextContent(
      "System Proxy differs from Mish's requested state.",
    );
    expect(
      within(notificationCenter).getByRole("button", { name: "Repair System Proxy" }),
    ).toBeInTheDocument();
    expect(
      within(notificationCenter).getByRole("button", { name: "Leave OS Settings as Is" }),
    ).toBeInTheDocument();
  });

  it("changes the selected Profile preference without activating Core", async () => {
    const user = userEvent.setup();
    const statusClient = new SnapshotStatusClient(await createRpcSnapshot(true));
    const profileClient = createActivationProfileClient();
    const legacyStatusActivation = vi.spyOn(statusClient, "setActiveProfile");
    renderRoute("/status", "en", statusClient, profileClient);

    const trigger = await screen.findByRole("combobox", {
      name: "Switch profile. Current profile: Studio route set",
    });
    expect(trigger).toBeEnabled();
    await user.click(trigger);
    const option = await screen.findByRole("option", { name: "Studio route set" });
    expect(option).toHaveAttribute("aria-selected", "true");
    await user.click(option);

    expect(profileClient.activateProfile).not.toHaveBeenCalled();
    expect(legacyStatusActivation).not.toHaveBeenCalled();
  });

  it("allows selecting any saved Profile while Core is stopped and marks the choice", async () => {
    const user = userEvent.setup();
    const statusClient = new SnapshotStatusClient(await createRpcSnapshot(true));
    const profileClient = createActivationProfileClient();
    profileClient.getSnapshot = async () => {
      const snapshot = await managedProfileSnapshot();
      snapshot.profiles.push({
        ...structuredClone(snapshot.profiles[0]),
        id: "fixture-profile-travel",
        label: "Travel route set",
        status: { ...snapshot.profiles[0].status, active: false },
      });
      return snapshot;
    };
    renderRoute("/status", "en", statusClient, profileClient);

    await user.click(
      await screen.findByRole("combobox", {
        name: "Switch profile. Current profile: Studio route set",
      }),
    );
    await user.click(await screen.findByRole("option", { name: "Travel route set" }));

    expect(
      await screen.findByRole("combobox", {
        name: "Switch profile. Current profile: Travel route set",
      }),
    ).toBeEnabled();
    expect(profileClient.activateProfile).not.toHaveBeenCalled();

    await user.click(screen.getByRole("combobox", { name: /Current profile: Travel route set/ }));
    expect(await screen.findByRole("option", { name: "Travel route set" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("shows an explicit empty label instead of the status placeholder when no Profile exists", async () => {
    const statusClient = new SnapshotStatusClient(await createRpcSnapshot(true));
    const profileClient = createActivationProfileClient();
    profileClient.getSnapshot = async () => {
      const snapshot = await managedProfileSnapshot();
      snapshot.activation.activeProfileId = null;
      snapshot.activation.targetProfileId = null;
      snapshot.profiles = [];
      return snapshot;
    };
    renderRoute("/profiles", "zh", statusClient, profileClient);

    const trigger = await screen.findByRole("combobox", {
      name: "切换配置。当前配置：<无配置文件>",
    });
    expect(trigger).toBeDisabled();
    expect(trigger).toHaveTextContent("<无配置文件>");
    expect(screen.queryByText("Local Mihomo")).not.toBeInTheDocument();
  });

  it("switches the running Core when the current Profile selection changes", async () => {
    const user = userEvent.setup();
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.phase = "healthy";
    snapshot.runtime.systemProxyEnabled = true;
    snapshot.runtime.systemProxy = {
      desired: true,
      failure: null,
      observed: "mish",
      phase: "applied",
      recoveryActions: [],
    };
    const statusClient = new SnapshotStatusClient(snapshot);
    const profileClient = await createCompletingActivationProfileClient(true);
    renderRoute("/status", "en", statusClient, profileClient);

    await user.click(
      await screen.findByRole("combobox", {
        name: "Switch profile. Current profile: Studio route set",
      }),
    );
    await user.click(await screen.findByRole("option", { name: "Travel route set" }));

    await waitFor(() =>
      expect(profileClient.activateProfile).toHaveBeenCalledWith(
        expect.any(String),
        "fixture-profile-travel",
      ),
    );
    expect(
      await screen.findByRole("combobox", {
        name: "Switch profile. Current profile: Travel route set",
      }),
    ).toBeEnabled();
  });

  it("opens the Profile menu when its only managed profile is already active", async () => {
    const user = userEvent.setup();
    const statusClient = new SnapshotStatusClient(await createRpcSnapshot(true));
    const profileClient = createActivationProfileClient();
    profileClient.getSnapshot = async () => {
      const snapshot = await managedProfileSnapshot();
      const profile = snapshot.profiles[0];
      snapshot.activation.activeProfileId = profile.id;
      profile.status.active = true;
      return snapshot;
    };
    renderRoute("/status", "en", statusClient, profileClient);

    const trigger = await screen.findByRole("combobox", {
      name: "Switch profile. Current profile: Studio route set",
    });
    expect(trigger).toBeEnabled();
    await user.click(trigger);

    expect(await screen.findByRole("option", { name: "Studio route set" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
  });

  it("opens the Profile menu for inspection when activation is unavailable", async () => {
    const user = userEvent.setup();
    const statusClient = new SnapshotStatusClient(await createRpcSnapshot(true));
    const profileClient = createActivationProfileClient();
    profileClient.getSnapshot = async () => {
      const snapshot = await managedProfileSnapshot();
      snapshot.capabilities.activation = "unavailable";
      return snapshot;
    };
    renderRoute("/status", "en", statusClient, profileClient);

    const trigger = await screen.findByRole("combobox", {
      name: "Switch profile. Current profile: Studio route set",
    });
    expect(trigger).toBeEnabled();
    await user.click(trigger);

    expect(await screen.findByRole("option", { name: "Studio route set" })).toBeEnabled();
  });

  it("keeps service probes pending while the proxy runtime is safely stopped", async () => {
    const snapshot = await createRpcSnapshot();
    snapshot.probeResults = [];
    renderRoute("/status", "en", new SnapshotStatusClient(snapshot));

    await screen.findByText("Live desktop traffic");
    expect(screen.queryByRole("link", { name: "Open Diagnostics" })).not.toBeInTheDocument();

    const services = screen.getByRole("region", { name: "Service latency monitors" });
    const google = within(services).getByRole("button", { name: /Google/ });
    expect(within(google).getByText("Pending")).toBeVisible();
  });

  it("shows the shared proxy loader while a native startup capture transition is pending", async () => {
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.phase = "connecting";
    snapshot.runtime.systemProxy = {
      desired: true,
      failure: null,
      observed: "disabled",
      phase: "pending",
      recoveryActions: [],
    };
    renderRoute("/status", "en", new SnapshotStatusClient(snapshot));

    const proxyControl = await screen.findByRole("button", { name: "Launch Proxy" });
    expect(proxyControl).toHaveAttribute("aria-busy", "true");
    expect(proxyControl).toBeDisabled();
    expect(proxyControl).toHaveTextContent("Pending");
  });

  it("renders a sparse reconnecting snapshot without fixture claims or runnable actions", async () => {
    const user = userEvent.setup();
    const snapshot = await createRpcSnapshot(true);
    const client = new SnapshotStatusClient(snapshot, {
      attempt: 2,
      phase: "reconnecting",
      stale: true,
    });
    renderRoute("/status", "en", client);

    expect(await screen.findByText("Live desktop traffic")).toBeVisible();
    expect(screen.queryByText("Local service")).not.toBeInTheDocument();
    expect(screen.queryByText("Demo mode")).not.toBeInTheDocument();
    expect(document.getElementById("fixture-action-description")).not.toBeInTheDocument();
    expect(screen.getByText(/Reconnecting to the Mish background service/i)).toBeInTheDocument();

    const proxyControl = screen.getByRole("button", { name: "Launch Proxy" });
    expect(proxyControl).toBeDisabled();
    expect(proxyControl).toHaveAccessibleDescription(/capture is unavailable/i);

    const systemProxy = screen.getByRole("button", { name: /^System Proxy/ });
    expect(systemProxy).toBeDisabled();
    expect(systemProxy).toHaveAccessibleDescription(/System Proxy is unavailable/i);

    const tun = screen.getByRole("button", { name: /^Virtual Interface/ });
    expect(tun).toBeDisabled();
    expect(tun).toHaveAccessibleDescription(/Virtual Interface is unavailable/i);

    expect(screen.getByRole("button", { name: "Rule" })).toBeDisabled();
    expect(screen.getByRole("combobox", { name: /Switch profile/ })).toBeDisabled();
    const manage = screen.getByRole("button", { name: "Manage" });
    expect(manage).toBeEnabled();
    await user.click(manage);
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByText("This action is not supported by the current local service."),
    ).toBeVisible();
    expect(within(menu).getByText("Edit Services…").closest("[role='menuitem']")).toHaveAttribute(
      "data-disabled",
    );
    expect(
      screen.getByText("The local desktop service reports no service monitors."),
    ).toBeVisible();
  });

  it("combines backend support with supported and permission-required capabilities", async () => {
    const user = userEvent.setup();
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "permission-required" };
    const client = new SnapshotStatusClient(snapshot);
    const setCapture = vi.spyOn(client, "setCapture");
    const setRoutingMode = vi.spyOn(client, "setRoutingMode");
    renderRoute("/status", "en", client);
    await screen.findByText("Live desktop traffic");

    const systemProxy = screen.getByRole("button", { name: /^System Proxy/ });
    expect(systemProxy).toBeDisabled();
    expect(systemProxy).toHaveAccessibleDescription(/not supported by the current local service/i);
    expect(systemProxy).not.toHaveAttribute("aria-describedby", "fixture-action-description");

    const tun = screen.getByRole("button", { name: /^Virtual Interface/ });
    expect(tun).toBeDisabled();
    expect(tun).toHaveAccessibleDescription(/requires permission/i);

    const globalMode = screen.getByRole("button", { name: "Global" });
    const group = screen.getByRole("button", { name: /🌐 Proxy/ });
    const services = screen.getByRole("region", { name: "Service latency monitors" });
    const google = within(services).getByRole("button", { name: /Google/ });
    for (const control of [globalMode, group, google]) {
      expect(control).toBeDisabled();
      expect(control).toHaveAccessibleDescription(/not supported by the current local service/i);
      await user.click(control);
    }

    expect(setCapture).not.toHaveBeenCalled();
    expect(setRoutingMode).not.toHaveBeenCalled();
  });
});

describe("Status fixture experience", () => {
  it("clears Status session telemetry when capture stops and establishes a fresh baseline on relaunch", async () => {
    const client = new FixtureStatusClient();
    renderRoute("/status", "en", client);
    const session = await screen.findByLabelText("Current session");

    expect([...session.querySelectorAll("strong")].map((value) => value.textContent)).toEqual([
      "- B/s",
      "- B/s",
      "-",
      "-",
      "-",
      "-",
    ]);
    expect(session.querySelectorAll(".traffic-sparkline path")).toHaveLength(0);

    await act(() => client.setCapture({ systemProxy: true, tun: false }, true));
    await waitFor(() => expect(session.querySelectorAll("small")[0]).toHaveTextContent("0 B"));
    expect(session.querySelectorAll(".traffic-sparkline path")).toHaveLength(0);

    await act(() => client.setCapture({ systemProxy: true, tun: false }, false));
    await waitFor(() =>
      expect([...session.querySelectorAll("strong")].map((value) => value.textContent)).toEqual([
        "- B/s",
        "- B/s",
        "-",
        "-",
        "-",
        "-",
      ]),
    );
    expect(session.querySelectorAll(".traffic-sparkline path")).toHaveLength(0);

    await act(() => client.setCapture({ systemProxy: true, tun: false }, true));
    await waitFor(() => expect(session.querySelectorAll("small")[0]).toHaveTextContent("0 B"));
    expect(session.querySelectorAll(".traffic-sparkline path")).toHaveLength(0);
  });

  it("labels fixture state and renders opaque Unicode labels verbatim", async () => {
    renderRoute("/status");
    expect(await screen.findByText("Live demo traffic")).toBeInTheDocument();
    expect(screen.getByText("Demo mode")).toBeInTheDocument();
    expect(screen.getByText("🌐 Proxy")).toBeInTheDocument();
    expect(screen.getByText("Messaging")).toBeInTheDocument();
  });

  it("renders explicit placeholders for policy groups and unavailable session samples", async () => {
    renderRoute("/status", "en", new EmptyStatusClient());

    expect(await screen.findByText("No policy groups available.")).toBeInTheDocument();
    const session = screen.getByRole("region", { name: "Current session" });
    expect(within(session).getAllByText("- B/s")).toHaveLength(2);
    expect(within(session).getAllByText("-")).toHaveLength(6);
    expect(within(session).queryByText("0 B/s")).not.toBeInTheDocument();
    expect(within(session).queryByText("00:00:00")).not.toBeInTheDocument();
  });

  it("shows configured policy groups before Mihomo starts", async () => {
    const snapshot = await new EmptyStatusClient().getSnapshot();
    snapshot.adapterKind = "rpc";
    snapshot.nodes = [];
    snapshot.runtime.phase = "inactive";
    const profileClient = new ConfiguredStatusProfileClient();

    renderRoute("/status", "en", new SnapshotStatusClient(snapshot), profileClient);

    const groups = await screen.findByRole("region", { name: "Frequently used policy groups" });
    expect(within(groups).getByText("Configured order.")).toBeVisible();
    expect(within(groups).getByText("Configured group 1")).toBeVisible();
    expect(within(groups).getByText("Configured node 1")).toBeVisible();
    expect(within(groups).getByText("Configured group 5")).toBeVisible();
    expect(within(groups).queryByText("Configured group 6")).not.toBeInTheDocument();
    expect(within(groups).queryByText("No policy groups available.")).not.toBeInTheDocument();
    expect(within(groups).getByRole("button", { name: /Configured group 1/ })).toBeDisabled();
    expect(profileClient.getRoutes).toHaveBeenCalledWith("fixture-profile-studio");
  });

  it("changes routing and one group child through the typed fixture adapter", async () => {
    const user = userEvent.setup();
    renderRoute("/status");
    await screen.findByText("Live demo traffic");

    const globalMode = screen.getByRole("button", { name: "Global" });
    await user.click(globalMode);
    await waitFor(() => expect(globalMode).toHaveAttribute("aria-pressed", "true"));

    await user.click(screen.getByRole("button", { name: /🌐 Proxy/ }));
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    await user.click(screen.getByText("🇯🇵 NRT-03"));

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /🌐 Proxy/ })).toHaveTextContent(
        "🇯🇵 NRT-03 · 71 ms",
      );
    });
  });

  it("keeps Status shortcut selection synchronized with the Routes page", async () => {
    const user = userEvent.setup();
    renderRoute("/status");
    await user.click(await screen.findByRole("button", { name: /🌐 Proxy/ }));
    await user.click(await screen.findByText("🇯🇵 NRT-03"));
    await user.click(screen.getByRole("link", { name: "Routes" }));
    await user.click(await screen.findByRole("button", { name: "Expand 🌐 Proxy" }));

    expect(screen.getByRole("button", { name: "Select 🇯🇵 NRT-03 in 🌐 Proxy" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps capture actions explicitly described as fixture-only", async () => {
    const user = userEvent.setup();
    renderRoute("/status");
    const startButton = await screen.findByRole("button", { name: "Launch the Proxy Demo State" });
    expect(startButton).toHaveAttribute("data-slot", "button");
    expect(startButton).toHaveAccessibleDescription(/local fixture data only/);
    expect(startButton).toHaveAttribute("data-status", "inactive");
    expect(
      startButton.querySelector('[data-slot="proxy-control-material"]'),
    ).not.toBeInTheDocument();
    expect(startButton.querySelector(".sidebar-status-shimmer")).not.toBeInTheDocument();
    await user.click(startButton);
    const stopButton = await screen.findByRole("button", { name: "Disable the Proxy Demo State" });
    const material = stopButton.querySelector('[data-slot="proxy-control-material"]');
    expect(stopButton).toHaveAttribute("data-slot", "button");
    expect(stopButton).toHaveAccessibleDescription(/local fixture data only/);
    expect(material).toHaveAttribute("aria-hidden", "true");
    expect(material?.querySelector(".sidebar-status-shimmer")).toBeInTheDocument();
    await user.click(stopButton);
    expect(
      await screen.findByRole("button", { name: "Launch the Proxy Demo State" }),
    ).toBeInTheDocument();
  });

  it("delegates selected-profile capture launch to the aggregate command", async () => {
    const user = userEvent.setup();
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.captureSelection = { systemProxy: false, tun: false };
    const statusClient = new RecordingCaptureClient(snapshot);
    const profileClient = await createCompletingActivationProfileClient();
    renderRoute("/status", "en", statusClient, profileClient);

    await user.click(
      await screen.findByRole("button", { name: "System Proxy, not selected, not running" }),
    );

    await waitFor(() => expect(statusClient.setCapture).toHaveBeenCalledTimes(1));
    expect(statusClient.setCapture).toHaveBeenCalledWith(
      { systemProxy: true, tun: false },
      true,
      "fixture-profile-studio",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(profileClient.activateProfile).not.toHaveBeenCalled();
  });

  it("returns a Core startup failure to idle and shows one specific notification", async () => {
    const user = userEvent.setup();
    const errorToast = vi.spyOn(toast, "error");
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.captureSelection = { systemProxy: true, tun: false };
    snapshot.runtime.phase = "error";
    snapshot.runtime.systemProxy = {
      desired: true,
      failure: "core-unhealthy",
      observed: "disabled",
      phase: "failed",
      recoveryActions: [],
    };
    const statusClient = new FailingCoreUnhealthyCaptureClient(snapshot);
    const profileClient = await createCompletingActivationProfileClient();
    renderRoute("/status", "zh", statusClient, profileClient);

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "代理启动失败，Mish 已回到闲置状态。请检查当前配置后重试。",
        expect.any(Object),
      ),
    );
    const startButton = screen.getByRole("button", { name: "启动代理" });
    expect(startButton).toHaveAttribute("data-status", "inactive");
    expect(startButton).toBeEnabled();

    errorToast.mockClear();
    await user.click(startButton);

    await waitFor(() => expect(statusClient.setCapture).toHaveBeenCalledOnce());
    expect(profileClient.activateProfile).not.toHaveBeenCalled();
    expect(errorToast).not.toHaveBeenCalledWith("操作失败。");
    expect(screen.getByRole("button", { name: "启动代理" })).toBeEnabled();

    await user.click(screen.getByRole("button", { name: /通知/ }));
    const notificationCenter = await screen.findByRole("dialog");
    expect(notificationCenter).toHaveTextContent(
      "代理启动失败，Mish 已回到闲置状态。请检查当前配置后重试。",
    );
    expect(notificationCenter).not.toHaveTextContent("操作失败。");
  });

  it("remembers selected capture modes when the master control stops and resumes capture", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    await user.click(await screen.findByRole("button", { name: "Launch the Proxy Demo State" }));

    const systemProxy = await screen.findByRole("button", { name: /^System Proxy/ });
    expect(systemProxy).toHaveAttribute("aria-pressed", "true");
    expect(systemProxy).toHaveAccessibleName("System Proxy, selected, running");

    await user.click(screen.getByRole("button", { name: "Disable the Proxy Demo State" }));

    await waitFor(() => {
      expect(systemProxy).toHaveAttribute("aria-pressed", "true");
      expect(systemProxy).toHaveAccessibleName("System Proxy, selected, not running");
    });

    await user.click(screen.getByRole("button", { name: "Launch the Proxy Demo State" }));

    await waitFor(() => {
      expect(systemProxy).toHaveAccessibleName("System Proxy, selected, running");
    });
  });

  it("starts the complete remembered combination when a stopped unselected mode is added", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    await user.click(
      await screen.findByRole("button", { name: "System Proxy, not selected, not running" }),
    );
    await user.click(screen.getByRole("button", { name: "Disable the Proxy Demo State" }));
    const systemProxy = screen.getByRole("button", {
      name: "System Proxy, selected, not running",
    });
    const tun = screen.getByRole("button", {
      name: "Virtual Interface, not selected, not running",
    });

    await user.click(tun);

    await waitFor(() => {
      expect(systemProxy).toHaveAccessibleName("System Proxy, selected, running");
      expect(tun).toHaveAccessibleName("Virtual Interface, selected, running");
    });
  });

  it("removes a remembered mode without starting capture when its gray control is clicked", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    await user.click(
      await screen.findByRole("button", { name: "System Proxy, not selected, not running" }),
    );
    await user.click(screen.getByRole("button", { name: "Disable the Proxy Demo State" }));
    await user.click(
      screen.getByRole("button", {
        name: "Virtual Interface, not selected, not running",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Disable the Proxy Demo State" }));
    await user.click(screen.getByRole("button", { name: "System Proxy, selected, not running" }));

    expect(
      await screen.findByRole("button", { name: "System Proxy, not selected, not running" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Virtual Interface, selected, not running" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Launch the Proxy Demo State" })).toHaveAttribute(
      "title",
      "Launch Proxy with Virtual Interface",
    );
  });

  it("uses System Proxy as the master-control fallback when no mode is selected", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    expect(
      await screen.findByRole("button", { name: "System Proxy, not selected, not running" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Launch the Proxy Demo State" })).toHaveAttribute(
      "title",
      "Launch Proxy with System Proxy",
    );

    await user.click(screen.getByRole("button", { name: "Launch the Proxy Demo State" }));

    expect(
      await screen.findByRole("button", { name: "System Proxy, selected, running" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("does not remember an unconfirmed capture-mode change", async () => {
    const user = userEvent.setup();
    const errorToast = vi.spyOn(toast, "error");
    renderRoute("/status", "en", new FailingCaptureClient());

    await user.click(
      await screen.findByRole("button", {
        name: "Virtual Interface, not selected, not running",
      }),
    );

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "The command failed.",
        expect.objectContaining({ id: "status-operation-failure" }),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("The command failed.");
    expect(
      screen.getByRole("button", { name: "System Proxy, not selected, not running" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", {
        name: "Virtual Interface, not selected, not running",
      }),
    ).toHaveAttribute("aria-pressed", "false");
  });

  it("shows observed System Proxy drift and offers typed recovery choices", async () => {
    const user = userEvent.setup();
    const warningToast = vi.spyOn(toast, "warning");
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.captureSelection = { systemProxy: true, tun: false };
    snapshot.runtime.phase = "healthy";
    snapshot.runtime.systemProxy = {
      desired: true,
      failure: null,
      observed: "other",
      phase: "drift",
      recoveryActions: ["repair", "leave-as-is"],
    };
    const client = new DriftRecoveryClient(snapshot);

    renderRoute("/status", "en", client);

    await screen.findByText("Live desktop traffic");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(warningToast).toHaveBeenCalledWith(
        expect.stringContaining("System Proxy differs from Mish's requested state."),
        expect.objectContaining({
          action: expect.objectContaining({
            props: expect.objectContaining({
              actions: expect.arrayContaining([
                expect.objectContaining({ id: "repair", label: "Repair System Proxy" }),
                expect.objectContaining({ id: "leave-as-is", label: "Leave OS Settings as Is" }),
              ]),
            }),
          }),
          cancel: undefined,
        }),
      ),
    );
    expect(screen.getByRole("button", { name: "Proxy needs attention" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    const notificationCenter = await screen.findByRole("dialog");
    expect(notificationCenter).toHaveTextContent(
      "System Proxy differs from Mish's requested state.",
    );
    expect(
      within(notificationCenter).getByRole("button", { name: "Repair System Proxy" }),
    ).toBeInTheDocument();
    await user.click(
      within(notificationCenter).getByRole("button", { name: "Leave OS Settings as Is" }),
    );

    await waitFor(() =>
      expect(client.recoverSystemProxy).toHaveBeenCalledWith(
        "leave-as-is",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("does not offer System Proxy repair while Mihomo Core is stopped", async () => {
    const user = userEvent.setup();
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.captureSelection = { systemProxy: true, tun: false };
    snapshot.runtime.systemProxy = {
      desired: true,
      failure: null,
      observed: "other",
      phase: "drift",
      recoveryActions: ["repair", "leave-as-is"],
    };
    renderRoute("/status", "en", new DriftRecoveryClient(snapshot));

    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    const notificationCenter = await screen.findByRole("dialog");
    expect(notificationCenter).toHaveTextContent("Repair requires a running Mihomo core");
    expect(
      within(notificationCenter).queryByRole("button", { name: "Repair System Proxy" }),
    ).not.toBeInTheDocument();
    expect(
      within(notificationCenter).getByRole("button", { name: "Leave OS Settings as Is" }),
    ).toBeEnabled();
  });

  it("explains invalid recovery state without offering an unsafe repair", async () => {
    const user = userEvent.setup();
    const warningToast = vi.spyOn(toast, "warning");
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.captureSelection = { systemProxy: true, tun: false };
    snapshot.runtime.phase = "error";
    snapshot.runtime.systemProxy = {
      desired: true,
      failure: "invalid-recovery",
      observed: "unknown",
      phase: "drift",
      recoveryActions: ["leave-as-is"],
    };

    renderRoute("/status", "en", new DriftRecoveryClient(snapshot));

    await waitFor(() =>
      expect(warningToast).toHaveBeenCalledWith(
        expect.stringContaining("Mish cannot validate its saved System Proxy recovery record."),
        expect.objectContaining({
          action: expect.objectContaining({
            props: expect.objectContaining({
              actions: [
                expect.objectContaining({ id: "leave-as-is", label: "Leave OS Settings as Is" }),
              ],
            }),
          }),
          cancel: undefined,
        }),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    const notificationCenter = await screen.findByRole("dialog");
    expect(notificationCenter).toHaveTextContent(
      "Mish cannot validate its saved System Proxy recovery record.",
    );
    expect(
      within(notificationCenter).queryByRole("button", { name: "Repair System Proxy" }),
    ).not.toBeInTheDocument();
    expect(
      within(notificationCenter).getByRole("button", { name: "Leave OS Settings as Is" }),
    ).toBeInTheDocument();
  });

  it("describes System Proxy confirmation while a desktop command is pending", async () => {
    const user = userEvent.setup();
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    const client = new DeferredCaptureClient(snapshot);
    renderRoute("/status", "en", client);

    await user.click(await screen.findByRole("button", { name: "Launch Proxy" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "System Proxy is pending macOS confirmation.",
    );
  });

  it("describes a typed permission failure without claiming success", async () => {
    const errorToast = vi.spyOn(toast, "error");
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.systemProxy = {
      desired: true,
      failure: "permission-denied",
      observed: "disabled",
      phase: "failed",
      recoveryActions: [],
    };
    renderRoute("/status", "en", new SnapshotStatusClient(snapshot));

    await screen.findByText("Live desktop traffic");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "macOS did not allow the System Proxy change. No success was recorded.",
        expect.any(Object),
      ),
    );
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "macOS did not allow the System Proxy change. No success was recorded.",
    );
    expect(screen.getByRole("button", { name: "Proxy needs attention" })).toBeDisabled();
  });

  it("moves a TUN drift warning into a toast and the notification center", async () => {
    const user = userEvent.setup();
    const warningToast = vi.spyOn(toast, "warning");
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "unavailable", tun: "supported" };
    snapshot.runtime.tun = {
      desired: true,
      failure: "observation-partial",
      observation: {
        core: "confirmed",
        dns: "confirmed",
        interface: "confirmed",
        observedAt: Date.now(),
        routes: "partial",
        schemaVersion: 1,
      },
      observed: "partial",
      phase: "drift",
    };
    renderRoute("/status", "en", new SnapshotStatusClient(snapshot));

    await waitFor(() =>
      expect(warningToast).toHaveBeenCalledWith(
        "Virtual Interface differs from the requested state and was not reported as active.",
        expect.any(Object),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Virtual Interface differs from the requested state and was not reported as active.",
    );
  });

  it("prevents duplicate commands while pending and preserves confirmed state on failure", async () => {
    const user = userEvent.setup();
    const client = new DeferredRoutingClient();
    renderRoute("/status", "en", client);
    await screen.findByText("Live demo traffic");
    const globalMode = screen.getByRole("button", { name: "Global" });

    await user.click(globalMode);
    expect(globalMode).toBeDisabled();
    expect(globalMode).toHaveAttribute("aria-busy", "true");
    expect(globalMode).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Rule" })).toHaveAttribute("aria-pressed", "true");
    expect(globalMode.querySelector(".ui-spinner")).toBeInTheDocument();
    await user.click(globalMode);
    expect(client.calls).toBe(1);

    const errorToast = vi.spyOn(toast, "error");
    client.rejectCommand?.();
    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "The command failed.",
        expect.objectContaining({ id: "status-operation-failure" }),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("The command failed.");
    await waitFor(() => expect(globalMode).not.toBeDisabled());
    expect(globalMode).toHaveAttribute("aria-busy", "false");
    expect(globalMode).toHaveAttribute("aria-pressed", "false");
  });

  it("cancels pending command ownership when the shared product provider is disposed", async () => {
    const user = userEvent.setup();
    const client = new CancellableRoutingClient();
    const view = renderRoute("/status", "en", client);
    await user.click(await screen.findByRole("button", { name: "Global" }));

    view.unmount();

    expect(client.aborted).toBe(true);
  });

  it("does not show a success toast after a failed service command", async () => {
    const user = userEvent.setup();
    const errorToast = vi.spyOn(toast, "error");
    const successToast = vi.spyOn(toast, "success");
    renderRoute("/status", "en", new FailingServicesClient());
    await screen.findByText("Live demo traffic");

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Services…" }));
    const manager = await screen.findByRole("dialog", { name: "Edit Services…" });
    await user.click(within(manager).getByRole("button", { name: "Restore Defaults" }));

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "The command failed.",
        expect.objectContaining({ id: "status-operation-failure" }),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(within(manager).getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: /Notifications, \d+ unread/ }));
    expect(await screen.findByRole("dialog")).toHaveTextContent("The command failed.");
    expect(successToast).not.toHaveBeenCalled();
  });

  it("changes the service test interval from the Manage menu", async () => {
    const user = userEvent.setup();
    const client = new FixtureStatusClient();
    const setInterval = vi.spyOn(client, "setServiceProbeInterval");
    renderRoute("/status", "en", client);
    await screen.findByText("Live demo traffic");

    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByRole("menuitemradio", { name: "Every 5 seconds" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("menuitemradio", { name: "Never" })).toBeVisible();
    await user.click(await screen.findByRole("menuitemradio", { name: "Every 10 seconds" }));

    await waitFor(() => expect(setInterval).toHaveBeenCalledWith(10, expect.any(Object)));

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(await screen.findByRole("menuitemradio", { name: "Never" }));
    await waitFor(() => expect(setInterval).toHaveBeenCalledWith(0, expect.any(Object)));
  });

  it("tests a service from its status row and edits it through Manage", async () => {
    const user = userEvent.setup();
    const client = new FixtureStatusClient();
    const testService = vi.spyOn(client, "testServiceMonitor");
    renderRoute("/status", "en", client);
    await screen.findByText("Live demo traffic");

    await user.click(screen.getByRole("button", { name: "Test Latency for Google" }));
    await waitFor(() => expect(testService).toHaveBeenCalledWith("google", expect.any(Object)));

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Services…" }));
    const manager = await screen.findByRole("dialog", { name: "Edit Services…" });
    await user.click(within(manager).getByRole("button", { name: "Google" }));

    expect(await screen.findByRole("dialog", { name: "Edit Service" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Title" })).toHaveValue("Google");
    expect(screen.getByRole("textbox", { name: "Icon URL" })).toHaveValue(SERVICE_ICON_URLS.google);
  });

  it("lets users replace a service icon with a custom HTTPS image URL", async () => {
    const user = userEvent.setup();
    renderRoute("/status", "en", new FixtureStatusClient());
    await screen.findByText("Live demo traffic");

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Services…" }));
    const manager = await screen.findByRole("dialog", { name: "Edit Services…" });
    await user.click(within(manager).getByRole("button", { name: "Google" }));

    const customIconUrl = "https://example.com/custom-service.svg";
    const iconUrl = await screen.findByRole("textbox", { name: "Icon URL" });
    await user.clear(iconUrl);
    await user.type(iconUrl, customIconUrl);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Edit Service" })).toBeNull());
    const google = screen.getByRole("button", { name: "Test Latency for Google" });
    expect(google.querySelector("img")).toHaveAttribute("src", customIconUrl);
  });

  it("dims only the service being tested while preserving its previous latency", async () => {
    const user = userEvent.setup();
    const client = new DeferredServiceProbeClient();
    renderRoute("/status", "en", client);
    await screen.findByText("Live demo traffic");

    const services = screen.getByRole("region", { name: "Service latency monitors" });
    const google = within(services).getByRole("button", { name: "Test Latency for Google" });
    const github = within(services).getByRole("button", { name: "Test Latency for GitHub" });
    await user.click(google);

    expect(google.querySelector(".ui-spinner")).not.toBeInTheDocument();
    expect(within(google).getByText("48 ms")).toBeVisible();
    expect(google).toBeDisabled();
    expect(github.querySelector(".ui-spinner")).not.toBeInTheDocument();
    expect(github).toBeEnabled();

    await client.completeProbe("google", 73);
    await waitFor(() => expect(within(google).getByText("73 ms")).toBeVisible());
  });

  it("renders service probe failures inline without an error toast", async () => {
    const user = userEvent.setup();
    const errorToast = vi.spyOn(toast, "error");
    renderRoute("/status", "en", new FailingServiceProbeClient());
    await screen.findByText("Live demo traffic");

    const google = screen.getByRole("button", { name: "Test Latency for Google" });
    await user.click(google);

    const failure = await within(google).findByText("Unreachable");
    expect(failure).toHaveAttribute("data-status", "error");
    expect(errorToast).not.toHaveBeenCalled();
  });

  it("caps displayed service latency and preserves the full label as a title", async () => {
    const snapshot = await new FixtureStatusClient().getSnapshot();
    const google = snapshot.services.find((service) => service.id === "google");
    const result = snapshot.probeResults.find((candidate) => candidate.monitorId === "google");
    if (!google || !result) throw new Error("Google fixture is missing");
    google.label = "A very long custom service monitor name";
    result.latencyMilliseconds = 10_000;
    renderRoute("/status", "en", new SnapshotStatusClient(snapshot));

    const service = await screen.findByRole("button", {
      name: "Test Latency for A very long custom service monitor name",
    });
    expect(within(service).getByText(">9999ms")).toBeVisible();
    expect(within(service).getByText(google.label)).toHaveAttribute("title", google.label);
  });

  it("switches to Simplified Chinese and persists the locale", async () => {
    const user = userEvent.setup();
    const view = renderRoute("/status");
    await screen.findByText("Live demo traffic");
    const authoredLabels = [...view.container.querySelectorAll(".user-authored-label")].map(
      (element) => element.textContent,
    );

    await user.click(
      screen.getByRole("button", { name: "Change language. Current language: English" }),
    );
    await user.click(await screen.findByRole("menuitemradio", { name: "简体中文" }));

    expect(await screen.findByText("当前演示的实时流量")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole("menu")).not.toBeInTheDocument());
    expect(screen.getByRole("link", { name: "路由" })).toBeInTheDocument();
    expect(document.documentElement).toHaveAttribute("lang", "zh-CN");
    expect(localStorage.getItem("mish.locale")).toBe("zh");
    expect(
      [...view.container.querySelectorAll(".user-authored-label")].map(
        (element) => element.textContent,
      ),
    ).toEqual(authoredLabels);
  });

  it("switches appearance manually and persists the preference", async () => {
    const user = userEvent.setup();
    renderRoute("/status");
    await screen.findByText("Live demo traffic");

    await user.click(
      screen.getByRole("button", { name: "Change theme. Current theme: Follow system" }),
    );
    await user.click(await screen.findByRole("menuitemradio", { name: "Dark" }));

    await waitFor(() => expect(document.documentElement).toHaveAttribute("data-theme", "dark"));
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(localStorage.getItem("mish.appearance")).toBe("dark");
    expect(screen.getByRole("button", { name: "Change theme. Current theme: Dark" })).toBeVisible();
  });

  it("defers service validation feedback until a field is edited", async () => {
    const user = userEvent.setup();
    renderRoute("/status");
    await screen.findByText("Live demo traffic");

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(await screen.findByRole("menuitem", { name: "Edit Services…" }));
    const manager = await screen.findByRole("dialog", { name: "Edit Services…" });
    await user.click(within(manager).getByRole("button", { name: "Add Service" }));

    const title = await screen.findByRole("textbox", { name: "Title" });
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(title).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();

    await user.type(title, "Temporary");
    await user.clear(title);

    expect(await screen.findByRole("alert")).toHaveTextContent("Enter a title.");
    expect(title).toHaveAttribute("aria-invalid", "true");
  });
});

describe("desktop startup failure", () => {
  it("uses the selected Simplified Chinese locale without exposing connection details", () => {
    render(
      <AppearanceProvider>
        <TypesafeI18n locale="zh">
          <StartupFailure />
        </TypesafeI18n>
      </AppearanceProvider>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("本地服务不可用");
    expect(alert).toHaveTextContent("无法连接本机服务");
    expect(alert).not.toHaveTextContent(/ws:\/\//i);
    expect(alert).not.toHaveTextContent(/token/i);
  });
});
