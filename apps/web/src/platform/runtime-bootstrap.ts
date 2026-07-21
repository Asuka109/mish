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
  clearLaunchPin(): void;
  clearProof(): void;
  createProof(): string;
  fetch(pin: string | null, proof: string | null): Promise<unknown>;
  launchPin(): string | null;
  loadProof(): string | null;
  saveProof(proof: string): void;
}

interface BootstrapDependencies {
  browserBootstrap?: BrowserBootstrapDependencies;
  demoMode?: boolean;
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
    clearLaunchPin: clearBrowserLaunchPin,
    clearProof: clearBrowserProof,
    createProof: createBrowserProof,
    fetch: fetchBrowserBootstrap,
    launchPin: readBrowserLaunchPin,
    loadProof: readBrowserProof,
    saveProof: saveBrowserProof,
  },
  demoMode: import.meta.env.MODE === "demo" || import.meta.env.MODE === "test",
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
  if (dependencies.demoMode) {
    return createFixtureStartup(dependencies.isDesktop() ? "desktop" : "browser");
  }

  if (!dependencies.isDesktop()) {
    const browser = dependencies.browserBootstrap;
    if (!browser) {
      throw new BrowserAuthenticationRequired();
    }
    const pin = browser.launchPin();
    const proof = pin ? browser.createProof() : browser.loadProof();
    try {
      const bootstrap = parseRuntimeBootstrap(await browser.fetch(pin, proof));
      if (pin && proof) browser.saveProof(proof);
      return createRpcStartup(bootstrap, dependencies, "browser", "mish-browser-client");
    } catch (error) {
      browser.clearProof();
      if (error instanceof BrowserBootstrapUnavailable) {
        throw new BrowserAuthenticationRequired();
      }
      throw error;
    } finally {
      if (pin) browser.clearLaunchPin();
    }
  }

  const bootstrap = parseRuntimeBootstrap(await dependencies.invokeBootstrap());
  return createRpcStartup(bootstrap, dependencies, "desktop", "mish-desktop-webview");
}

async function createFixtureStartup(runtime: "browser" | "desktop"): Promise<StartupStatusClient> {
  const settingsClient = new FixtureSettingsClient();
  return {
    dispose: () => undefined,
    runtime,
    localBackupClient: new UnavailableLocalBackupClient(),
    settingsClient,
    settingsSnapshot: await settingsClient.getSnapshot(),
    supportBundleClient: new UnavailableSupportBundleClient(),
  };
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

export class BrowserAuthenticationRequired extends Error {
  constructor() {
    super("Browser authentication required");
    this.name = "BrowserAuthenticationRequired";
  }
}

class BrowserBootstrapUnavailable extends Error {
  constructor(readonly status: number | null) {
    super("Browser bootstrap unavailable");
    this.name = "BrowserBootstrapUnavailable";
  }
}

function readBrowserLaunchPin() {
  const pin = new URLSearchParams(window.location.hash.slice(1)).get("mish-browser-pin");
  return pin && /^[a-f0-9]{64}$/.test(pin) ? pin : null;
}

function clearBrowserLaunchPin() {
  const url = new URL(window.location.href);
  url.hash = "";
  window.history.replaceState(null, "", `${url.pathname}${url.search}`);
}

const browserProofKey = "mish-browser-client-proof";

function readBrowserProof() {
  try {
    const proof = window.localStorage.getItem(browserProofKey);
    return proof && /^[a-f0-9]{64}$/.test(proof) ? proof : null;
  } catch {
    return null;
  }
}

function saveBrowserProof(proof: string) {
  try {
    window.localStorage.setItem(browserProofKey, proof);
  } catch {
    // Authentication can still complete, but a later navigation will require a new PIN.
  }
}

function clearBrowserProof() {
  try {
    window.localStorage.removeItem(browserProofKey);
  } catch {
    // Storage can be unavailable under strict browser privacy policies.
  }
}

function createBrowserProof() {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function fetchBrowserBootstrap(pin: string | null, proof: string | null) {
  const response = await fetch("/browser-bootstrap", {
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      ...(pin ? { Authorization: `Mish-Browser-Pin ${pin}` } : {}),
      ...(proof ? { "X-Mish-Browser-Proof": proof } : {}),
    },
    method: "POST",
  });
  if (!response.ok) throw new BrowserBootstrapUnavailable(response.status);
  return response.json();
}

export interface BrowserPairingChallenge {
  challengeId: string;
  expiresInSeconds: number;
}

export class BrowserPairingError extends Error {
  constructor(readonly kind: "expired" | "invalid" | "locked" | "unavailable") {
    super(`Browser pairing ${kind}`);
    this.name = "BrowserPairingError";
  }
}

export async function requestBrowserPairing(): Promise<BrowserPairingChallenge> {
  const response = await fetch("/browser-pairing", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "POST",
  });
  if (!response.ok) {
    throw new BrowserPairingError(response.status === 429 ? "locked" : "unavailable");
  }
  const value = (await response.json()) as Record<string, unknown>;
  if (
    typeof value.challengeId !== "string" ||
    !/^[a-f0-9]{64}$/.test(value.challengeId) ||
    typeof value.expiresInSeconds !== "number" ||
    value.expiresInSeconds <= 0
  ) {
    throw new BrowserPairingError("unavailable");
  }
  return {
    challengeId: value.challengeId,
    expiresInSeconds: value.expiresInSeconds,
  };
}

export async function completeBrowserPairing(challengeId: string, pin: string): Promise<void> {
  const proof = createBrowserProof();
  const response = await fetch("/browser-pairing/complete", {
    body: JSON.stringify({ challengeId, pin }),
    cache: "no-store",
    credentials: "same-origin",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      "X-Mish-Browser-Proof": proof,
    },
    method: "POST",
  });
  if (!response.ok) {
    const kind =
      response.status === 401
        ? "invalid"
        : response.status === 410
          ? "expired"
          : response.status === 429
            ? "locked"
            : "unavailable";
    throw new BrowserPairingError(kind);
  }
  parseRuntimeBootstrap(await response.json());
  saveBrowserProof(proof);
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
