import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { toast } from "sonner";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@mish/ui";
import {
  StatusClientError,
  type AppearancePreference,
  type CaptureSelectionDto,
  type ProfileClient,
  type ProfileSnapshotDto,
  type LanguagePreference,
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
import { AppRoutes } from "./app";
import { AppearanceProvider } from "./appearance";
import { FixtureStatusClient } from "./data/fixture-status-client";
import { FixtureProfileClient } from "./data/fixture-profile-client";
import { ProductProvider } from "./data/product-provider";
import { EventsProvider } from "./data/events-provider";
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
) {
  return render(
    <SettingsProvider client={settingsClient} initialSnapshot={settingsSnapshot}>
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
                  <EventsProvider>
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
      networkDns: "coming-later",
      statusBar: "supported",
      tun: "unavailable",
      updates: "coming-later",
      windowLifecycle: "supported",
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
  setStartup = vi.fn(async (startup: StartupPreferencesDto) => {
    this.snapshot.preferences.startup = startup;
    this.snapshot.startupRegistration = {
      desired: startup.launchAtLogin,
      observed: startup.launchAtLogin,
      phase: "applied",
    };
    return this.getSnapshot();
  });
  setWindowCloseBehavior = vi.fn(async (behavior: "hide-to-status-bar" | "quit") => {
    this.snapshot.preferences.windowCloseBehavior = behavior;
    return this.getSnapshot();
  });
  setWindowSurface = vi.fn(async (surface: WindowSurfacePreference) => {
    this.snapshot.preferences.windowSurface = surface;
    return this.getSnapshot();
  });
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
  override setCapture(): Promise<StatusSnapshotDto> {
    return new Promise(() => undefined);
  }

  override supportsCommand(command: StatusCommand) {
    return command === "capture";
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
    tun: { desired: false, failure: null, observed: "disabled", phase: "off" },
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
  it("presents Mish as the product brand", () => {
    renderRoute("/status");
    const brandImages = screen.getByLabelText("Mish").querySelectorAll("img");
    expect(brandImages).toHaveLength(2);
    expect(brandImages[0]).toHaveAttribute("src", "/brand/mish-brand.svg");
    expect(brandImages[1]).toHaveAttribute("src", "/brand/mish-brand-dark.svg");
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
      "Privacy and access",
      "Advanced and support",
    ]) {
      expect(await screen.findByRole("heading", { name: heading })).toBeInTheDocument();
    }
    expect(
      screen.getByText(/cannot perform or confirm native macOS operations/i),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Launch at login" })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Virtual Interface, not selected, not running" }),
    ).toBeDisabled();
    expect(screen.queryByRole("button", { name: /enable lan/i })).not.toBeInTheDocument();
    expect(screen.queryByText("Window surface")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Native material" })).not.toBeInTheDocument();
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

    const routesLink = screen.getByRole("link", { name: "Routes" });
    expect(routesLink).toHaveAttribute("href", "/routes");
    await user.click(routesLink);
    expect(await screen.findByRole("heading", { name: "Routes" })).toBeInTheDocument();
    expect(routesLink).toHaveAttribute("aria-current", "page");
  });

  it("starts with fixture data without opening a socket or making a request", async () => {
    const webSocket = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("WebSocket", webSocket);
    vi.stubGlobal("fetch", fetch);

    renderRoute("/status");
    await screen.findByText("Fixture activity at a glance.");

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

  it("separates login registration from the exclusive login-window behavior", async () => {
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

    const background = await screen.findByRole("button", { name: "Background" });
    expect(background).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "Launch at login" }));
    await waitFor(() =>
      expect(settingsClient.setStartup).toHaveBeenCalledWith({
        launchAtLogin: true,
        loginLaunchBehavior: "show-window",
      }),
    );
    await waitFor(() => expect(background).not.toBeDisabled());
    await user.click(background);
    await waitFor(() =>
      expect(settingsClient.setStartup).toHaveBeenLastCalledWith({
        launchAtLogin: true,
        loginLaunchBehavior: "background",
      }),
    );
  });

  it("reuses the System Proxy drift and recovery model inside Settings", async () => {
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.captureSelection.systemProxy = true;
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "System Proxy differs from Mish's requested state.",
    );
    expect(screen.getByRole("button", { name: "Repair System Proxy" })).toBeInTheDocument();
  });

  it("uses the Profile activation command seam from the Status selector", async () => {
    const user = userEvent.setup();
    const statusClient = new SnapshotStatusClient(await createRpcSnapshot(true));
    const profileClient = createActivationProfileClient();
    const legacyStatusActivation = vi.spyOn(statusClient, "setActiveProfile");
    renderRoute("/status", "en", statusClient, profileClient);

    const trigger = await screen.findByRole("button", {
      name: "Switch profile. Current profile: Safely stopped",
    });
    expect(trigger).toBeEnabled();
    await user.click(trigger);
    await user.click(await screen.findByRole("menuitemradio", { name: "Studio route set" }));

    await waitFor(() =>
      expect(profileClient.activateProfile).toHaveBeenCalledWith(
        expect.any(String),
        "fixture-profile-studio",
      ),
    );
    expect(legacyStatusActivation).not.toHaveBeenCalled();
  });

  it("renders a sparse reconnecting snapshot without fixture claims or runnable actions", async () => {
    const snapshot = await createRpcSnapshot(true);
    const client = new SnapshotStatusClient(snapshot, {
      attempt: 2,
      phase: "reconnecting",
      stale: true,
    });
    renderRoute("/status", "en", client);

    expect(await screen.findByText("Live status from the desktop local service.")).toBeVisible();
    expect(screen.getByText("Local service")).toBeVisible();
    expect(screen.queryByText("Demo mode")).not.toBeInTheDocument();
    expect(document.getElementById("fixture-action-description")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(/reconnecting/i);

    const proxyControl = screen.getByRole("button", { name: "Enable proxy" });
    expect(proxyControl).toBeDisabled();
    expect(proxyControl).toHaveAccessibleDescription(/capture is unavailable/i);

    const systemProxy = screen.getByRole("button", { name: /^System Proxy/ });
    expect(systemProxy).toBeDisabled();
    expect(systemProxy).toHaveAccessibleDescription(/System Proxy is unavailable/i);

    const tun = screen.getByRole("button", { name: /^Virtual Interface/ });
    expect(tun).toBeDisabled();
    expect(tun).toHaveAccessibleDescription(/Virtual Interface is unavailable/i);

    expect(screen.getByRole("button", { name: "Rule" })).toBeDisabled();
    expect(screen.getByRole("button", { name: /Switch profile/ })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Manage" })).toBeDisabled();
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
    await screen.findByText("Live status from the desktop local service.");

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
  it("labels fixture state and renders opaque Unicode labels verbatim", async () => {
    renderRoute("/status");
    expect(await screen.findByText("Fixture activity at a glance.")).toBeInTheDocument();
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

  it("changes routing and one group child through the typed fixture adapter", async () => {
    const user = userEvent.setup();
    renderRoute("/status");
    await screen.findByText("Fixture activity at a glance.");

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
    const startButton = await screen.findByRole("button", { name: "Enable the proxy demo state" });
    expect(startButton).toHaveAccessibleDescription(/local fixture data only/);
    await user.click(startButton);
    const stopButton = await screen.findByRole("button", { name: "Disable the proxy demo state" });
    expect(stopButton).toHaveAccessibleDescription(/local fixture data only/);
    await user.click(stopButton);
    expect(
      await screen.findByRole("button", { name: "Enable the proxy demo state" }),
    ).toBeInTheDocument();
  });

  it("remembers selected capture modes when the master control stops and resumes capture", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    await user.click(await screen.findByRole("button", { name: "Enable the proxy demo state" }));

    const systemProxy = await screen.findByRole("button", { name: /^System Proxy/ });
    expect(systemProxy).toHaveAttribute("aria-pressed", "true");
    expect(systemProxy).toHaveAccessibleName("System Proxy, selected, running");

    await user.click(screen.getByRole("button", { name: "Disable the proxy demo state" }));

    await waitFor(() => {
      expect(systemProxy).toHaveAttribute("aria-pressed", "true");
      expect(systemProxy).toHaveAccessibleName("System Proxy, selected, not running");
    });

    await user.click(screen.getByRole("button", { name: "Enable the proxy demo state" }));

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
    await user.click(screen.getByRole("button", { name: "Disable the proxy demo state" }));
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
    await user.click(screen.getByRole("button", { name: "Disable the proxy demo state" }));
    await user.click(
      screen.getByRole("button", {
        name: "Virtual Interface, not selected, not running",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Disable the proxy demo state" }));
    await user.click(screen.getByRole("button", { name: "System Proxy, selected, not running" }));

    expect(
      await screen.findByRole("button", { name: "System Proxy, not selected, not running" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(
      screen.getByRole("button", { name: "Virtual Interface, selected, not running" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Enable the proxy demo state" })).toHaveAttribute(
      "title",
      "Start proxy with Virtual Interface",
    );
  });

  it("uses System Proxy as the master-control fallback when no mode is selected", async () => {
    const user = userEvent.setup();
    renderRoute("/status");

    expect(
      await screen.findByRole("button", { name: "System Proxy, not selected, not running" }),
    ).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByRole("button", { name: "Enable the proxy demo state" })).toHaveAttribute(
      "title",
      "Start proxy with System Proxy",
    );

    await user.click(screen.getByRole("button", { name: "Enable the proxy demo state" }));

    expect(
      await screen.findByRole("button", { name: "System Proxy, selected, running" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("does not remember an unconfirmed capture-mode change", async () => {
    const user = userEvent.setup();
    renderRoute("/status", "en", new FailingCaptureClient());

    await user.click(
      await screen.findByRole("button", {
        name: "Virtual Interface, not selected, not running",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent("The command failed.");
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
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    snapshot.runtime.captureSelection = { systemProxy: true, tun: false };
    snapshot.runtime.phase = "error";
    snapshot.runtime.systemProxy = {
      desired: true,
      failure: null,
      observed: "other",
      phase: "drift",
      recoveryActions: ["repair", "leave-as-is"],
    };
    const client = new DriftRecoveryClient(snapshot);

    renderRoute("/status", "en", client);

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "System Proxy differs from Mish's requested state.",
    );
    expect(screen.getByRole("button", { name: "Proxy needs attention" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Repair System Proxy" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Leave OS settings as is" }));

    await waitFor(() =>
      expect(client.recoverSystemProxy).toHaveBeenCalledWith(
        "leave-as-is",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      ),
    );
  });

  it("describes System Proxy confirmation while a desktop command is pending", async () => {
    const user = userEvent.setup();
    const snapshot = await createRpcSnapshot();
    snapshot.capabilities = { systemProxy: "supported", tun: "unavailable" };
    const client = new DeferredCaptureClient(snapshot);
    renderRoute("/status", "en", client);

    await user.click(await screen.findByRole("button", { name: "Enable proxy" }));

    expect(await screen.findByRole("status")).toHaveTextContent(
      "System Proxy is pending macOS confirmation.",
    );
  });

  it("describes a typed permission failure without claiming success", async () => {
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

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "macOS did not allow the System Proxy change. No success was recorded.",
    );
    expect(screen.getByRole("button", { name: "Proxy needs attention" })).toBeDisabled();
  });

  it("prevents duplicate commands while pending and preserves confirmed state on failure", async () => {
    const user = userEvent.setup();
    const client = new DeferredRoutingClient();
    renderRoute("/status", "en", client);
    await screen.findByText("Fixture activity at a glance.");
    const globalMode = screen.getByRole("button", { name: "Global" });

    await user.click(globalMode);
    expect(globalMode).toBeDisabled();
    await user.click(globalMode);
    expect(client.calls).toBe(1);

    client.rejectCommand?.();
    expect(await screen.findByRole("alert")).toHaveTextContent("The command failed.");
    await waitFor(() => expect(globalMode).not.toBeDisabled());
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
    const successToast = vi.spyOn(toast, "success");
    renderRoute("/status", "en", new FailingServicesClient());
    await screen.findByText("Fixture activity at a glance.");

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(await screen.findByRole("menuitem", { name: "Restore defaults" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("The command failed.");
    expect(successToast).not.toHaveBeenCalled();
  });

  it("switches to Simplified Chinese and persists the locale", async () => {
    const user = userEvent.setup();
    const view = renderRoute("/status");
    await screen.findByText("Fixture activity at a glance.");
    const authoredLabels = [...view.container.querySelectorAll(".user-authored-label")].map(
      (element) => element.textContent,
    );

    await user.click(
      screen.getByRole("button", { name: "Change language. Current language: English" }),
    );
    await user.click(await screen.findByRole("menuitemradio", { name: "简体中文" }));

    expect(await screen.findByText("当前演示活动概览。")).toBeInTheDocument();
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
    await screen.findByText("Fixture activity at a glance.");

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
    await screen.findByText("Fixture activity at a glance.");

    await user.click(screen.getByRole("button", { name: "Manage" }));
    await user.click(await screen.findByRole("menuitem", { name: "Add service" }));

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
    expect(alert).toHaveTextContent("无法建立私有本地连接");
    expect(alert).not.toHaveTextContent(/ws:\/\//i);
    expect(alert).not.toHaveTextContent(/token/i);
  });
});
