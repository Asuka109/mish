import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  mishRpcMethods,
  SettingsSnapshotSchema,
  type LocalBackupClient,
  type LocalBackupScopeDto,
  type LocalRestoreConflictResolution,
  type MobileFixtureBootstrapDto,
  type MobileVpnSnapshotDto,
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
import { DesktopLocalBackupClient, UnavailableLocalBackupClient } from "./local-backup";
import type { MobileVpnClient } from "./mobile-vpn-client";

interface RuntimeBootstrapPayload {
  authToken: string;
  localBackup: boolean;
  rpcUrl: string;
  settingsSnapshot: SettingsSnapshotDto;
  supportBundleExport: boolean;
}

interface BrowserBootstrapDependencies {
  clearNonce(): void;
  clearSession(): void;
  fetch(nonce: string | null): Promise<unknown>;
  hasSession(): boolean;
  markSession(): void;
  nonce(): string | null;
}

interface BootstrapDependencies {
  browserBootstrap?: BrowserBootstrapDependencies;
  invokeCommitLocalRestore(
    previewId: string,
    resolution: LocalRestoreConflictResolution,
  ): Promise<unknown>;
  invokeBootstrap(): Promise<unknown>;
  invokeLocalBackupPreview(scope: LocalBackupScopeDto): Promise<unknown>;
  invokeLocalBackupSave(previewId: string): Promise<unknown>;
  invokeLocalProfilePreflight(label?: string): Promise<unknown>;
  invokeLocalRestorePreview(): Promise<unknown>;
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
  localBackupClient: LocalBackupClient;
  mobileFixture?: MobileFixtureBootstrapDto;
  mobileVpnClient?: MobileVpnClient;
  mobileVpnSnapshot?: MobileVpnSnapshotDto;
  runtime: "browser" | "desktop" | "mobile";
  supportBundleClient: SupportBundleClient;
}

const defaultDependencies: BootstrapDependencies = {
  browserBootstrap: {
    clearNonce: clearBrowserBootstrapNonce,
    clearSession: clearBrowserBootstrapSession,
    fetch: fetchBrowserBootstrap,
    hasSession: hasBrowserBootstrapSession,
    markSession: markBrowserBootstrapSession,
    nonce: readBrowserBootstrapNonce,
  },
  invokeCommitLocalRestore: (previewId, resolution) =>
    invoke("local_backup_restore_commit", { previewId, resolution }),
  invokeBootstrap: () => invoke("runtime_bootstrap"),
  invokeLocalBackupPreview: (scope) => invoke("local_backup_export_preview", { scope }),
  invokeLocalBackupSave: (previewId) => invoke("local_backup_export_save", { previewId }),
  invokeLocalProfilePreflight: (label) => invoke("profile_preflight_local", { label }),
  invokeLocalRestorePreview: () => invoke("local_backup_restore_preview"),
  invokeSupportBundlePreview: () => invoke("diagnostics_support_bundle_preview"),
  invokeSupportBundleSave: (previewId) => invoke("diagnostics_support_bundle_save", { previewId }),
  isDesktop: isTauri,
  openWebSocket: (url) => new WebSocket(url),
};

export async function resolveStartupStatusClient(
  dependencies: BootstrapDependencies = defaultDependencies,
): Promise<StartupStatusClient> {
  if (!dependencies.isDesktop()) {
    const nonce = dependencies.browserBootstrap?.nonce() ?? null;
    const hasSession = dependencies.browserBootstrap?.hasSession() ?? false;
    if (nonce || hasSession) {
      try {
        const bootstrap = parseRuntimeBootstrap(await dependencies.browserBootstrap?.fetch(nonce));
        dependencies.browserBootstrap?.markSession();
        return createRpcStartup(bootstrap, dependencies, "browser", "mish-browser-client");
      } catch (error) {
        dependencies.browserBootstrap?.clearSession();
        if (nonce) throw error;
      } finally {
        if (nonce) dependencies.browserBootstrap?.clearNonce();
      }
    }
    const settingsClient = new FixtureSettingsClient();
    return {
      dispose: () => undefined,
      runtime: "browser",
      localBackupClient: new UnavailableLocalBackupClient(),
      settingsClient,
      settingsSnapshot: await settingsClient.getSnapshot(),
      supportBundleClient: new UnavailableSupportBundleClient(),
    };
  }

  const bootstrap = parseRuntimeBootstrap(await dependencies.invokeBootstrap());
  return createRpcStartup(bootstrap, dependencies, "desktop", "mish-desktop-webview");
}

function createRpcStartup(
  bootstrap: RuntimeBootstrapPayload,
  dependencies: BootstrapDependencies,
  runtime: "browser" | "desktop",
  clientName: string,
): StartupStatusClient {
  const rpc = new RpcClient({
    authentication: () => ({
      clientName,
      clientVersion: "bootstrap-v1",
      token: bootstrap.authToken,
    }),
    methods: mishRpcMethods,
    transportFactory: () => dependencies.openWebSocket(bootstrap.rpcUrl),
  });
  const client = new RpcStatusClient(rpc, true);
  const eventsClient = new RpcEventsClient(rpc);
  const diagnosticsClient = new RpcDiagnosticsClient(rpc);
  const profileClient = new RpcProfileClient(
    rpc,
    runtime === "desktop" ? dependencies.invokeLocalProfilePreflight : null,
  );
  const trafficClient = new RpcTrafficClient(rpc);
  const settingsClient = new RpcSettingsClient(rpc, runtime === "desktop");
  const settingsSnapshot = bootstrap.settingsSnapshot;
  return {
    client,
    eventsClient,
    diagnosticsClient,
    profileClient,
    localBackupClient: bootstrap.localBackup
      ? new DesktopLocalBackupClient({
          invokeCommitRestore: dependencies.invokeCommitLocalRestore,
          invokePreviewExport: dependencies.invokeLocalBackupPreview,
          invokePreviewRestore: dependencies.invokeLocalRestorePreview,
          invokeSaveExport: dependencies.invokeLocalBackupSave,
        })
      : new UnavailableLocalBackupClient(),
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
    runtime,
  };
}

function readBrowserBootstrapNonce() {
  const nonce = new URLSearchParams(window.location.hash.slice(1)).get("mish-browser-bootstrap");
  return nonce && /^[a-f0-9]{64}$/.test(nonce) ? nonce : null;
}

function clearBrowserBootstrapNonce() {
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

const browserBootstrapSessionKey = "mish-browser-client-session";

function hasBrowserBootstrapSession() {
  try {
    return window.sessionStorage.getItem(browserBootstrapSessionKey) === "active";
  } catch {
    return false;
  }
}

function markBrowserBootstrapSession() {
  try {
    window.sessionStorage.setItem(browserBootstrapSessionKey, "active");
  } catch {
    // The HttpOnly bridge session still protects the current in-memory bootstrap.
  }
}

function clearBrowserBootstrapSession() {
  try {
    window.sessionStorage.removeItem(browserBootstrapSessionKey);
  } catch {
    // Storage can be unavailable under strict browser privacy policies.
  }
}

async function fetchBrowserBootstrap(nonce: string | null) {
  const response = await fetch("/browser-bootstrap", {
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(nonce ? { Authorization: `Mish-Browser ${nonce}` } : {}),
    },
    method: "POST",
  });
  if (!response.ok) throw new Error("Browser bootstrap unavailable");
  return response.json();
}

export function parseRuntimeBootstrap(value: unknown): RuntimeBootstrapPayload {
  if (!value || typeof value !== "object") throw new Error("Invalid desktop bootstrap");
  const { authToken, localBackup, rpcUrl, settingsSnapshot, supportBundleExport } = value as Record<
    string,
    unknown
  >;
  if (typeof authToken !== "string" || authToken.length < 32) {
    throw new Error("Invalid desktop authentication token");
  }
  if (typeof supportBundleExport !== "boolean") {
    throw new Error("Invalid support bundle export capability");
  }
  if (typeof localBackup !== "boolean") {
    throw new Error("Invalid local backup capability");
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
    localBackup,
    rpcUrl: endpoint.href,
    settingsSnapshot: SettingsSnapshotSchema.parse(settingsSnapshot),
    supportBundleExport,
  };
}
