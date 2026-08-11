import type {
  ApplicationLaunchBehavior,
  AppearancePreference,
  LanguagePreference,
  LocalBackupClient,
  OnboardingWelcomeAction,
  ProcessDiscoveryMode,
  SettingsClient,
  SettingsSnapshotDelivery,
  SettingsSnapshotDto,
  StartupPreferencesDto,
  SystemProxyTakeoverPolicy,
  TunHelperLifecycleOptions,
  ManagedPortPreferencesDto,
  ManagedPortKind,
  TunHelperFailureKind,
  WindowCloseBehavior,
  WindowSurfacePreference,
} from "@mish/contracts";
import { TunHelperFailureKindSchema } from "@mish/contracts";
import { RpcRemoteError, RpcSessionAuthority } from "@mish/rpc-client";
import { UnavailableLocalBackupClient } from "../platform/local-backup";
import { LocalBackupExportAuthority } from "../platform/local-backup-authority";
import TypesafeI18n from "../i18n/i18n-react";
import { projectLocale } from "../i18n/locale";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type TunHelperOperationResult =
  | { ok: true }
  | { failure: TunHelperFailureKind | null; ok: false };

export interface TunHelperSetupOptions {
  resumeCapture?: boolean;
}

interface SettingsContextValue {
  acceptSnapshot(snapshot: SettingsSnapshotDto, delivery?: SettingsSnapshotDelivery): void;
  error: string | null;
  localBackupExportAuthority: LocalBackupExportAuthority;
  pending: boolean;
  installTunHelper(options?: TunHelperSetupOptions): Promise<TunHelperOperationResult>;
  localBackupClient: LocalBackupClient;
  refreshNetworkDns(): Promise<boolean>;
  removeTunHelper(): Promise<boolean>;
  repairTunHelper(options?: TunHelperSetupOptions): Promise<TunHelperOperationResult>;
  setAppearance(appearance: AppearancePreference): Promise<boolean>;
  setLanguage(language: LanguagePreference): Promise<boolean>;
  setOnboardingWelcomeState(action: OnboardingWelcomeAction): Promise<boolean>;
  setStartup(startup: StartupPreferencesDto): Promise<boolean>;
  setApplicationLaunchBehavior(launchBehavior: ApplicationLaunchBehavior): Promise<boolean>;
  setManagedPorts(managedPorts: ManagedPortPreferencesDto): Promise<boolean>;
  setProcessDiscoveryMode(mode: ProcessDiscoveryMode): Promise<boolean>;
  setCloseOldConnectionsAfterGroupSwitch(enabled: boolean): Promise<boolean>;
  setSystemProxyTakeoverPolicy(policy: SystemProxyTakeoverPolicy): Promise<boolean>;
  findManagedPorts(): Promise<boolean>;
  findManagedPort(kind: ManagedPortKind): Promise<boolean>;
  setWindowCloseBehavior(behavior: WindowCloseBehavior): Promise<boolean>;
  setWindowSurface(surface: WindowSurfacePreference): Promise<boolean>;
  snapshot: SettingsSnapshotDto;
  tunHelperFailure: TunHelperFailureKind | null;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);
const unavailableLocalBackupClient = new UnavailableLocalBackupClient();

export function SettingsProvider({
  children,
  client,
  initialSnapshot,
  localBackupClient = unavailableLocalBackupClient,
}: {
  children: ReactNode;
  client: SettingsClient;
  initialSnapshot: SettingsSnapshotDto;
  localBackupClient?: LocalBackupClient;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const sessionAuthority = useRef(new RpcSessionAuthority<SettingsSnapshotDto>());
  const localBackupExportAuthority = useRef<LocalBackupExportAuthority | null>(null);
  const initializedAcceptance = useRef(false);
  if (!initializedAcceptance.current) {
    sessionAuthority.current.observeTransport(true);
    sessionAuthority.current.accept(
      sessionAuthority.current.beginRequest(),
      initialSnapshot,
      "baseline",
    );
    initializedAcceptance.current = true;
  }
  if (!localBackupExportAuthority.current) {
    localBackupExportAuthority.current = new LocalBackupExportAuthority(sessionAuthority.current);
  }
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const networkRefreshController = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tunHelperFailure, setTunHelperFailure] = useState<TunHelperFailureKind | null>(null);
  const acceptSnapshot = useCallback(
    (next: SettingsSnapshotDto, delivery: SettingsSnapshotDelivery = "update") => {
      const ticket =
        delivery === "baseline" || delivery === "update"
          ? sessionAuthority.current.beginSubscription()
          : sessionAuthority.current.beginRequest();
      const result = sessionAuthority.current.accept(ticket, next, delivery);
      if (result.kind === "conflict") {
        setError("settings-snapshot-conflict");
        return;
      }
      if (result.kind === "accepted" && result.snapshot) setSnapshot(result.snapshot);
    },
    [],
  );

  const run = useCallback(
    async (operation: () => Promise<SettingsSnapshotDto>) => {
      if (pendingRef.current) {
        return {
          error: new Error("A Settings mutation is already in progress"),
          ok: false,
        } as const;
      }
      pendingRef.current = true;
      setPending(true);
      setError(null);
      try {
        acceptSnapshot(await operation(), "command");
        return { ok: true } as const;
      } catch (operationError) {
        setError("settings-update-failed");
        try {
          acceptSnapshot(await client.getSnapshot(), "request");
        } catch {
          // Keep the last confirmed snapshot when refresh also fails.
        }
        return { error: operationError, ok: false } as const;
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [acceptSnapshot, client],
  );

  const refreshNetworkDns = useCallback(async () => {
    if (networkRefreshController.current) return false;
    const controller = new AbortController();
    networkRefreshController.current = controller;
    try {
      return (await run(() => client.refreshNetworkDns({ signal: controller.signal }))).ok;
    } finally {
      if (networkRefreshController.current === controller) {
        networkRefreshController.current = null;
      }
    }
  }, [client, run]);

  useEffect(
    () => () => {
      networkRefreshController.current?.abort();
      networkRefreshController.current = null;
    },
    [],
  );

  useEffect(() => {
    const connectionAwareClient = client as SettingsClient & {
      subscribeConnection?: (listener: (state: { phase: string }) => void) => () => void;
    };
    const unsubscribeConnection = connectionAwareClient.subscribeConnection?.((connection) => {
      sessionAuthority.current.observeTransport(
        connection.phase === "connected" || connection.phase === "fixture",
      );
    });
    const unsubscribeSnapshots = client.subscribeSnapshots((next, delivery) =>
      acceptSnapshot(next, delivery ?? "update"),
    );
    return () => {
      unsubscribeConnection?.();
      unsubscribeSnapshots();
    };
  }, [acceptSnapshot, client]);

  const runTunHelper = useCallback(
    async (operation: () => Promise<SettingsSnapshotDto>): Promise<TunHelperOperationResult> => {
      setTunHelperFailure(null);
      const result = await run(operation);
      if (result.ok) return result;
      const parsed =
        result.error instanceof RpcRemoteError
          ? TunHelperFailureKindSchema.safeParse(
              (result.error.data as { kind?: unknown } | undefined)?.kind,
            )
          : null;
      const failure = parsed?.success ? parsed.data : null;
      setTunHelperFailure(failure);
      return { failure, ok: false };
    },
    [run],
  );

  const value = useMemo<SettingsContextValue>(
    () => ({
      acceptSnapshot,
      error,
      localBackupExportAuthority: localBackupExportAuthority.current!,
      installTunHelper: (options) =>
        runTunHelper(() => client.installTunHelper(tunHelperLifecycleOptions(options))),
      localBackupClient,
      pending,
      refreshNetworkDns,
      removeTunHelper: async () => (await runTunHelper(() => client.removeTunHelper())).ok,
      repairTunHelper: (options) =>
        runTunHelper(() => client.repairTunHelper(tunHelperLifecycleOptions(options))),
      setAppearance: async (appearance) => (await run(() => client.setAppearance(appearance))).ok,
      setLanguage: async (language) => (await run(() => client.setLanguage(language))).ok,
      setOnboardingWelcomeState: async (action) =>
        (await run(() => client.setOnboardingWelcomeState(action))).ok,
      setStartup: async (startup) => (await run(() => client.setStartup(startup))).ok,
      setApplicationLaunchBehavior: async (launchBehavior) =>
        (await run(() => client.setApplicationLaunchBehavior(launchBehavior))).ok,
      setManagedPorts: async (managedPorts) =>
        (await run(() => client.setManagedPorts(managedPorts))).ok,
      setProcessDiscoveryMode: async (mode) =>
        (await run(() => client.setProcessDiscoveryMode(mode))).ok,
      setCloseOldConnectionsAfterGroupSwitch: async (enabled) =>
        (await run(() => client.setCloseOldConnectionsAfterGroupSwitch(enabled))).ok,
      findManagedPorts: async () => (await run(() => client.findManagedPorts())).ok,
      findManagedPort: async (kind) => (await run(() => client.findManagedPort(kind))).ok,
      setSystemProxyTakeoverPolicy: async (policy) =>
        (await run(() => client.setSystemProxyTakeoverPolicy(policy))).ok,
      setWindowCloseBehavior: async (behavior) =>
        (await run(() => client.setWindowCloseBehavior(behavior))).ok,
      setWindowSurface: async (surface) => (await run(() => client.setWindowSurface(surface))).ok,
      snapshot,
      tunHelperFailure,
    }),
    [
      acceptSnapshot,
      client,
      error,
      localBackupClient,
      pending,
      refreshNetworkDns,
      run,
      runTunHelper,
      snapshot,
      tunHelperFailure,
    ],
  );
  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}

function tunHelperLifecycleOptions(
  options: TunHelperSetupOptions | undefined,
): TunHelperLifecycleOptions | undefined {
  if (!options?.resumeCapture) return undefined;
  return { resumeCapture: true };
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useSettings must be used inside SettingsProvider");
  return context;
}

export function useOptionalSettings() {
  return useContext(SettingsContext);
}

/** Projects the Rust-authoritative language into the shared Web rendering surface. */
export function SettingsLanguageProjection({ children }: { children: ReactNode }) {
  const { snapshot } = useSettings();
  const locale = snapshot.preferences.language === "zh-CN" ? "zh" : "en";
  projectLocale(locale);
  return (
    <TypesafeI18n key={locale} locale={locale}>
      {children}
    </TypesafeI18n>
  );
}
