import type {
  AppearancePreference,
  LanguagePreference,
  ManagedPortPreferencesDto,
  OnboardingWelcomeAction,
  SettingsClient,
  SettingsSnapshotDto,
  StartupPreferencesDto,
  WindowCloseBehavior,
  WindowSurfacePreference,
  SystemProxyTakeoverPolicy,
} from "@mish/contracts";

function storedAppearance(): AppearancePreference {
  try {
    const value = globalThis.localStorage?.getItem("mish.appearance");
    if (value === "system" || value === "light" || value === "dark") return value;
  } catch {
    // Hardened browser contexts may not expose storage.
  }
  return "system";
}

function storedLanguage(): LanguagePreference {
  return globalThis.navigator?.languages?.some((language) =>
    language.toLowerCase().startsWith("zh"),
  )
    ? "zh-CN"
    : "en";
}

function storedWindowSurface(): WindowSurfacePreference {
  try {
    const value = globalThis.localStorage?.getItem("mish.window-surface");
    if (value === "opaque" || value === "material") return value;
  } catch {
    // Hardened browser contexts may not expose storage.
  }
  return "material";
}

export function createFixtureSettingsSnapshot(): SettingsSnapshotDto {
  return {
    adapterKind: "fixture",
    build: { appVersion: "0.1.0", mihomoVersion: "v1.19.29" },
    capabilities: {
      backgroundLaunch: "unavailable",
      backupRestore: "coming-later",
      expertConfiguration: "coming-later",
      launchAtLogin: "unavailable",
      nativeSidebarMaterial: "unavailable",
      networkDns: "unavailable",
      statusBar: "unavailable",
      tun: "unavailable",
      updates: "coming-later",
      windowLifecycle: "unavailable",
    },
    networkDns: {
      dns: null,
      failure: null,
      interfaces: [],
      observedAt: null,
      phase: "unavailable",
      source: null,
    },
    preferences: {
      appearance: storedAppearance(),
      captureSelection: { systemProxy: false, tun: false },
      language: storedLanguage(),
      managedPorts: { controller: 9090, proxy: 7890 },
      onboarding: { welcomeInvitation: null },
      startup: {
        launchAtLogin: false,
        launchProxyWhenMishLaunches: false,
        loginLaunchBehavior: "show-window",
      },
      systemProxyTakeoverPolicy: "protect-existing",
      windowCloseBehavior: "hide-to-status-bar",
      windowSurface: storedWindowSurface(),
    },
    privacy: {
      authenticated: "unavailable",
      lanControl: "unavailable",
      loopbackOnly: "unavailable",
      originValidated: "unavailable",
    },
    revision: 1,
    startupRegistration: { desired: false, observed: null, phase: "unavailable" },
    storageRecovered: false,
    tunHelper: {
      availability: "unavailable",
      expectedVersion: "3",
      health: "not-installed",
      installationId: null,
      installedVersion: null,
      lastFailure: null,
      phase: "idle",
    },
  };
}

export class FixtureSettingsClient implements SettingsClient {
  private snapshot = createFixtureSettingsSnapshot();

  async getSnapshot() {
    return structuredClone(this.snapshot);
  }

  async refreshNetworkDns(): Promise<SettingsSnapshotDto> {
    throw new Error("Native Network and DNS observation is unavailable in demo mode");
  }

  async installTunHelper(): Promise<SettingsSnapshotDto> {
    throw new Error("The signed TUN helper is unavailable in demo mode");
  }

  async repairTunHelper(): Promise<SettingsSnapshotDto> {
    throw new Error("The signed TUN helper is unavailable in demo mode");
  }

  async removeTunHelper(): Promise<SettingsSnapshotDto> {
    throw new Error("The signed TUN helper is unavailable in demo mode");
  }

  async setAppearance(appearance: AppearancePreference) {
    this.snapshot.preferences.appearance = appearance;
    return this.getSnapshot();
  }

  async setLanguage(language: LanguagePreference) {
    this.snapshot.preferences.language = language;
    this.snapshot.revision += 1;
    return this.getSnapshot();
  }

  async setOnboardingWelcomeState(_action: OnboardingWelcomeAction): Promise<SettingsSnapshotDto> {
    throw new Error("Onboarding invitations are unavailable in demo mode");
  }

  async setStartup(_startup: StartupPreferencesDto): Promise<SettingsSnapshotDto> {
    throw new Error("Native startup operations are unavailable in demo mode");
  }

  async setLaunchProxyWhenMishLaunches(
    _launchProxyWhenMishLaunches: boolean,
  ): Promise<SettingsSnapshotDto> {
    throw new Error("Native automatic proxy launch is unavailable in demo mode");
  }

  async setManagedPorts(_managedPorts: ManagedPortPreferencesDto): Promise<SettingsSnapshotDto> {
    throw new Error("Managed ports are unavailable in demo mode");
  }

  async findManagedPorts(): Promise<SettingsSnapshotDto> {
    throw new Error("Managed ports are unavailable in demo mode");
  }

  async setSystemProxyTakeoverPolicy(
    _policy: SystemProxyTakeoverPolicy,
  ): Promise<SettingsSnapshotDto> {
    throw new Error("Native System Proxy policy is unavailable in demo mode");
  }

  subscribeSnapshots(_listener: (snapshot: SettingsSnapshotDto) => void) {
    return () => undefined;
  }

  async setWindowCloseBehavior(_behavior: WindowCloseBehavior): Promise<SettingsSnapshotDto> {
    throw new Error("Native window lifecycle operations are unavailable in demo mode");
  }

  async setWindowSurface(surface: WindowSurfacePreference) {
    this.snapshot.preferences.windowSurface = surface;
    try {
      globalThis.localStorage?.setItem("mish.window-surface", surface);
    } catch {
      // The in-memory preference still works when persistence is unavailable.
    }
    return this.getSnapshot();
  }
}
