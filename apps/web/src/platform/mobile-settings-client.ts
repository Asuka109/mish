import {
  SettingsSnapshotSchema,
  type ApplicationLaunchBehavior,
  type AppearancePreference,
  type LanguagePreference,
  type ManagedPortKind,
  type ManagedPortPreferencesDto,
  type OnboardingWelcomeAction,
  type ProcessDiscoveryMode,
  type SettingsClient,
  type SettingsSnapshotDelivery,
  type SettingsSnapshotDto,
  type StartupPreferencesDto,
  type SystemProxyTakeoverPolicy,
  type TunHelperLifecycleOptions,
  type WindowCloseBehavior,
  type WindowSurfacePreference,
} from "@mish/contracts";
import { invoke } from "@tauri-apps/api/core";
import { ApplicationSnapshotAcceptance } from "../data/application-snapshot-acceptance";

export interface MobileSettingsTransport {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

const defaultTransport: MobileSettingsTransport = { invoke };

function abortedError() {
  const error = new Error("The settings operation was cancelled.");
  error.name = "AbortError";
  return error;
}

function unavailableError(operation: string) {
  return new Error(`${operation} is unavailable in Android Settings.`);
}

/**
 * Native Android Settings transport. Shared Rust validates, persists, and returns
 * the complete snapshot; this client only retains the last accepted projection.
 */
export class MobileSettingsClient implements SettingsClient {
  private readonly snapshotAcceptance = new ApplicationSnapshotAcceptance<SettingsSnapshotDto>();
  private readonly snapshotListeners = new Set<
    (snapshot: SettingsSnapshotDto, delivery?: SettingsSnapshotDelivery) => void
  >();

  constructor(private readonly transport: MobileSettingsTransport = defaultTransport) {}

  getSnapshot(options?: { signal?: AbortSignal }) {
    return this.requestSnapshot("mobile_settings_get_snapshot", undefined, options);
  }

  setAppearance(appearance: AppearancePreference, options?: { signal?: AbortSignal }) {
    return this.requestSnapshot(
      "mobile_settings_set_appearance",
      { request: { appearance } },
      options,
    );
  }

  setLanguage(language: LanguagePreference, options?: { signal?: AbortSignal }) {
    return this.requestSnapshot("mobile_settings_set_language", { request: { language } }, options);
  }

  refreshNetworkDns(_options?: { signal?: AbortSignal }) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("Network and DNS observation"));
  }

  installTunHelper(_options?: TunHelperLifecycleOptions) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("The macOS TUN Helper"));
  }

  repairTunHelper(_options?: TunHelperLifecycleOptions) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("The macOS TUN Helper"));
  }

  removeTunHelper(_options?: { signal?: AbortSignal }) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("The macOS TUN Helper"));
  }

  setOnboardingWelcomeState(_action: OnboardingWelcomeAction, _options?: { signal?: AbortSignal }) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("Desktop onboarding"));
  }

  setStartup(_startup: StartupPreferencesDto, _options?: { signal?: AbortSignal }) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("Desktop startup settings"));
  }

  setApplicationLaunchBehavior(
    _launchBehavior: ApplicationLaunchBehavior,
    _options?: { signal?: AbortSignal },
  ) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("Desktop launch behavior"));
  }

  setManagedPorts(_managedPorts: ManagedPortPreferencesDto, _options?: { signal?: AbortSignal }) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("Desktop managed ports"));
  }

  findManagedPorts(_options?: { signal?: AbortSignal }) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("Desktop managed ports"));
  }

  findManagedPort(_kind: ManagedPortKind, _options?: { signal?: AbortSignal }) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("Desktop managed ports"));
  }

  setSystemProxyTakeoverPolicy(
    _policy: SystemProxyTakeoverPolicy,
    _options?: { signal?: AbortSignal },
  ) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("System Proxy policy"));
  }

  setProcessDiscoveryMode(_mode: ProcessDiscoveryMode, _options?: { signal?: AbortSignal }) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("Desktop process discovery"));
  }

  setCloseOldConnectionsAfterGroupSwitch(_enabled: boolean, _options?: { signal?: AbortSignal }) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("Connection cleanup"));
  }

  setWindowCloseBehavior(_behavior: WindowCloseBehavior, _options?: { signal?: AbortSignal }) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("Desktop window behavior"));
  }

  setWindowSurface(_surface: WindowSurfacePreference, _options?: { signal?: AbortSignal }) {
    return Promise.reject<SettingsSnapshotDto>(unavailableError("Desktop window surface"));
  }

  subscribeSnapshots(
    listener: (snapshot: SettingsSnapshotDto, delivery?: SettingsSnapshotDelivery) => void,
  ) {
    this.snapshotListeners.add(listener);
    const snapshot = this.snapshotAcceptance.snapshot();
    if (snapshot) listener(snapshot, "baseline");
    return () => this.snapshotListeners.delete(listener);
  }

  private async requestSnapshot(
    command: string,
    args: Record<string, unknown> | undefined,
    options?: { signal?: AbortSignal },
  ) {
    if (options?.signal?.aborted) throw abortedError();
    const snapshot = SettingsSnapshotSchema.parse(await this.transport.invoke(command, args));
    if (options?.signal?.aborted) throw abortedError();
    return this.acceptSnapshot(snapshot);
  }

  private acceptSnapshot(snapshot: SettingsSnapshotDto) {
    const result = this.snapshotAcceptance.accept(snapshot, "request");
    if (result.kind !== "accepted") return result.snapshot;
    for (const listener of this.snapshotListeners) listener(result.snapshot, "request");
    return result.snapshot;
  }
}
