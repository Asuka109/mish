import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  mishRpcMethods,
  SettingsSnapshotSchema,
  type EventsClient,
  type DiagnosticsClient,
  type ProfileClient,
  type SettingsClient,
  type SettingsSnapshotDto,
  type StatusClient,
  type SupportBundleClient,
  type TrafficClient,
} from "@mish/contracts";
import { RpcClient } from "@mish/rpc-client";
import { RpcProfileClient } from "../data/rpc-profile-client";
import { RpcEventsClient } from "../data/rpc-events-client";
import { RpcDiagnosticsClient } from "../data/rpc-diagnostics-client";
import { RpcStatusClient } from "../data/rpc-status-client";
import { FixtureSettingsClient } from "../data/fixture-settings-client";
import { RpcSettingsClient } from "../data/rpc-settings-client";
import { RpcTrafficClient } from "../data/rpc-traffic-client";
import { DesktopSupportBundleClient, UnavailableSupportBundleClient } from "./support-bundle";

interface RuntimeBootstrapPayload {
  authToken: string;
  rpcUrl: string;
  settingsSnapshot: SettingsSnapshotDto;
  supportBundleExport: boolean;
}

interface BootstrapDependencies {
  invokeBootstrap(): Promise<unknown>;
  invokeLocalProfilePreflight(label?: string): Promise<unknown>;
  invokeSupportBundlePreview(): Promise<unknown>;
  invokeSupportBundleSave(previewId: string): Promise<unknown>;
  isDesktop(): boolean;
  openWebSocket(url: string): WebSocket;
}

export interface StartupStatusClient {
  client?: StatusClient;
  eventsClient?: EventsClient;
  diagnosticsClient?: DiagnosticsClient;
  trafficClient?: TrafficClient;
  dispose(): void;
  profileClient?: ProfileClient;
  settingsClient: SettingsClient;
  settingsSnapshot: SettingsSnapshotDto;
  runtime: "browser" | "desktop";
  supportBundleClient: SupportBundleClient;
}

const defaultDependencies: BootstrapDependencies = {
  invokeBootstrap: () => invoke("runtime_bootstrap"),
  invokeLocalProfilePreflight: (label) => invoke("profile_preflight_local", { label }),
  invokeSupportBundlePreview: () => invoke("diagnostics_support_bundle_preview"),
  invokeSupportBundleSave: (previewId) => invoke("diagnostics_support_bundle_save", { previewId }),
  isDesktop: isTauri,
  openWebSocket: (url) => new WebSocket(url),
};

export async function resolveStartupStatusClient(
  dependencies: BootstrapDependencies = defaultDependencies,
): Promise<StartupStatusClient> {
  if (!dependencies.isDesktop()) {
    const settingsClient = new FixtureSettingsClient();
    return {
      dispose: () => undefined,
      runtime: "browser",
      settingsClient,
      settingsSnapshot: await settingsClient.getSnapshot(),
      supportBundleClient: new UnavailableSupportBundleClient(),
    };
  }

  const bootstrap = parseRuntimeBootstrap(await dependencies.invokeBootstrap());
  const rpc = new RpcClient({
    authentication: () => ({
      clientName: "mish-desktop-webview",
      clientVersion: "bootstrap-v1",
      token: bootstrap.authToken,
    }),
    methods: mishRpcMethods,
    transportFactory: () => dependencies.openWebSocket(bootstrap.rpcUrl),
  });
  const client = new RpcStatusClient(rpc, true);
  const eventsClient = new RpcEventsClient(rpc);
  const diagnosticsClient = new RpcDiagnosticsClient(rpc);
  const profileClient = new RpcProfileClient(rpc, dependencies.invokeLocalProfilePreflight);
  const trafficClient = new RpcTrafficClient(rpc);
  const settingsClient = new RpcSettingsClient(rpc);
  const settingsSnapshot = bootstrap.settingsSnapshot;
  return {
    client,
    eventsClient,
    diagnosticsClient,
    profileClient,
    settingsClient,
    settingsSnapshot,
    supportBundleClient: bootstrap.supportBundleExport
      ? new DesktopSupportBundleClient({
          invokePreview: dependencies.invokeSupportBundlePreview,
          invokeSave: dependencies.invokeSupportBundleSave,
        })
      : new UnavailableSupportBundleClient(),
    trafficClient,
    dispose: () => {
      profileClient.dispose();
      diagnosticsClient.dispose();
      eventsClient.dispose();
      trafficClient.dispose();
      client.dispose();
    },
    runtime: "desktop",
  };
}

export function parseRuntimeBootstrap(value: unknown): RuntimeBootstrapPayload {
  if (!value || typeof value !== "object") throw new Error("Invalid desktop bootstrap");
  const { authToken, rpcUrl, settingsSnapshot, supportBundleExport } = value as Record<
    string,
    unknown
  >;
  if (typeof authToken !== "string" || authToken.length < 32) {
    throw new Error("Invalid desktop authentication token");
  }
  if (typeof supportBundleExport !== "boolean") {
    throw new Error("Invalid support bundle export capability");
  }
  if (typeof rpcUrl !== "string") throw new Error("Invalid desktop RPC endpoint");

  const endpoint = new URL(rpcUrl);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.pathname !== "/rpc" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Desktop RPC must use an uncredentialed IPv4 loopback WebSocket URL");
  }
  return {
    authToken,
    rpcUrl: endpoint.href,
    settingsSnapshot: SettingsSnapshotSchema.parse(settingsSnapshot),
    supportBundleExport,
  };
}
