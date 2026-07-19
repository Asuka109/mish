import {
  mishRpcMethods,
  type AppearancePreference,
  type LanguagePreference,
  type SettingsClient,
  type StartupPreferencesDto,
} from "@mish/contracts";
import type { RpcClient, RpcRequestOptions } from "@mish/rpc-client";

export class RpcSettingsClient implements SettingsClient {
  constructor(private readonly rpc: RpcClient<typeof mishRpcMethods>) {}

  getSnapshot(options?: RpcRequestOptions) {
    return this.rpc.request("settings.getSnapshot", {}, options);
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
}
