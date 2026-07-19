import type {
  AppearancePreference,
  LanguagePreference,
  SettingsClient,
  SettingsSnapshotDto,
  StartupPreferencesDto,
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
  try {
    const value = globalThis.localStorage?.getItem("mish.locale");
    if (value === "en" || value === "zh") return value;
  } catch {
    // Hardened browser contexts may not expose storage.
  }
  return globalThis.navigator?.languages?.some((language) =>
    language.toLowerCase().startsWith("zh"),
  )
    ? "zh"
    : "en";
}

export function createFixtureSettingsSnapshot(): SettingsSnapshotDto {
  return {
    adapterKind: "fixture",
    capabilities: {
      backgroundLaunch: "unavailable",
      backupRestore: "coming-later",
      expertConfiguration: "coming-later",
      launchAtLogin: "unavailable",
      nativeSidebarMaterial: "unavailable",
      networkDns: "coming-later",
      tun: "unavailable",
      updates: "coming-later",
    },
    preferences: {
      appearance: storedAppearance(),
      language: storedLanguage(),
      startup: { launchAtLogin: false, loginLaunchBehavior: "show-window" },
    },
    privacy: {
      authenticated: "unavailable",
      lanControl: "unavailable",
      loopbackOnly: "unavailable",
      originValidated: "unavailable",
    },
    startupRegistration: { desired: false, observed: null, phase: "unavailable" },
    storageRecovered: false,
  };
}

export class FixtureSettingsClient implements SettingsClient {
  private snapshot = createFixtureSettingsSnapshot();

  async getSnapshot() {
    return structuredClone(this.snapshot);
  }

  async setAppearance(appearance: AppearancePreference) {
    this.snapshot.preferences.appearance = appearance;
    return this.getSnapshot();
  }

  async setLanguage(language: LanguagePreference) {
    this.snapshot.preferences.language = language;
    return this.getSnapshot();
  }

  async setStartup(_startup: StartupPreferencesDto): Promise<SettingsSnapshotDto> {
    throw new Error("Native startup operations are unavailable in the browser fixture");
  }
}
