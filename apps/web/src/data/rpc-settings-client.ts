import {
  mishRpcMethods,
  type AppearancePreference,
  type LanguagePreference,
  type SettingsClient,
  type StartupPreferencesDto,
  type WindowCloseBehavior,
  type WindowSurfacePreference,
} from "@mish/contracts";
import type { RpcClient, RpcRequestOptions } from "@mish/rpc-client";

export class RpcSettingsClient implements SettingsClient {
  constructor(private readonly rpc: RpcClient<typeof mishRpcMethods>) {}

  getSnapshot(options?: RpcRequestOptions) {
    return this.rpc.request("settings.getSnapshot", {}, options);
  }

  refreshNetworkDns(options?: RpcRequestOptions) {
    return this.rpc.request("settings.refreshNetworkDns", {}, options);
  }

  installTunHelper(options?: RpcRequestOptions) {
    return this.rpc.request("settings.installTunHelper", {}, options);
  }

  repairTunHelper(options?: RpcRequestOptions) {
    return this.rpc.request("settings.repairTunHelper", {}, options);
  }

  removeTunHelper(options?: RpcRequestOptions) {
    return this.rpc.request("settings.removeTunHelper", {}, options);
  }

  setAppearance(appearance: AppearancePreference, options?: RpcRequestOptions) {
    return this.rpc.request("settings.setAppearance", { appearance }, options);
  }

  setLanguage(language: LanguagePreference, options?: RpcRequestOptions) {
    return this.rpc.request("settings.setLanguage", { language }, options);
  }

  setStartup(startup: StartupPreferencesDto, options?: RpcRequestOptions) {
    return this.rpc.request("settings.setStartup", { startup }, options);
  }

  setWindowCloseBehavior(behavior: WindowCloseBehavior, options?: RpcRequestOptions) {
    return this.rpc.request("settings.setWindowCloseBehavior", { behavior }, options);
  }

  setWindowSurface(surface: WindowSurfacePreference, options?: RpcRequestOptions) {
    return this.rpc.request("settings.setWindowSurface", { surface }, options);
  }
}
