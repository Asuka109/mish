import {
  mishRpcMethods,
  type AppearancePreference,
  type LanguagePreference,
  type SettingsClient,
  type SettingsSnapshotDto,
  type StartupPreferencesDto,
  type WindowCloseBehavior,
  type WindowSurfacePreference,
} from "@mish/contracts";
import type { RpcClient, RpcRequestOptions } from "@mish/rpc-client";

export class RpcSettingsClient implements SettingsClient {
  constructor(
    private readonly rpc: RpcClient<typeof mishRpcMethods>,
    private readonly nativeWindowCapabilities = true,
  ) {}

  getSnapshot(options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.getSnapshot", {}, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  refreshNetworkDns(options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.refreshNetworkDns", {}, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  installTunHelper(options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.installTunHelper", {}, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  repairTunHelper(options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.repairTunHelper", {}, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  removeTunHelper(options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.removeTunHelper", {}, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setAppearance(appearance: AppearancePreference, options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.setAppearance", { appearance }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setLanguage(language: LanguagePreference, options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.setLanguage", { language }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setStartup(startup: StartupPreferencesDto, options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.setStartup", { startup }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setWindowCloseBehavior(behavior: WindowCloseBehavior, options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.setWindowCloseBehavior", { behavior }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setWindowSurface(surface: WindowSurfacePreference, options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.setWindowSurface", { surface }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  private normalizeSnapshot(snapshot: SettingsSnapshotDto) {
    if (this.nativeWindowCapabilities) return snapshot;
    return {
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        backupRestore: "unavailable" as const,
        nativeSidebarMaterial: "unavailable" as const,
        windowLifecycle: "unavailable" as const,
      },
    };
  }
}
