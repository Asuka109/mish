import type {
  AppearancePreference,
  LanguagePreference,
  LocalBackupClient,
  OnboardingWelcomeAction,
  SettingsClient,
  SettingsSnapshotDto,
  StartupPreferencesDto,
  TunHelperFailureKind,
  WindowCloseBehavior,
  WindowSurfacePreference,
} from "@mish/contracts";
import { TunHelperFailureKindSchema } from "@mish/contracts";
import { RpcRemoteError } from "@mish/rpc-client";
import { UnavailableLocalBackupClient } from "../platform/local-backup";
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

interface SettingsContextValue {
  acceptSnapshot(snapshot: SettingsSnapshotDto): void;
  error: string | null;
  pending: boolean;
  installTunHelper(): Promise<TunHelperOperationResult>;
  localBackupClient: LocalBackupClient;
  refreshNetworkDns(): Promise<boolean>;
  removeTunHelper(): Promise<boolean>;
  repairTunHelper(): Promise<boolean>;
  setAppearance(appearance: AppearancePreference): Promise<boolean>;
  setLanguage(language: LanguagePreference): Promise<boolean>;
  setOnboardingWelcomeState(action: OnboardingWelcomeAction): Promise<boolean>;
  setStartup(startup: StartupPreferencesDto): Promise<boolean>;
  setLaunchProxyWhenMishLaunches(launchProxyWhenMishLaunches: boolean): Promise<boolean>;
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
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const networkRefreshController = useRef<AbortController | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tunHelperFailure, setTunHelperFailure] = useState<TunHelperFailureKind | null>(null);

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
        setSnapshot(await operation());
        return { ok: true } as const;
      } catch (operationError) {
        setError("settings-update-failed");
        try {
          setSnapshot(await client.getSnapshot());
        } catch {
          // Keep the last confirmed snapshot when refresh also fails.
        }
        return { error: operationError, ok: false } as const;
      } finally {
        pendingRef.current = false;
        setPending(false);
      }
    },
    [client],
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

  useEffect(() => client.subscribeSnapshots(setSnapshot), [client]);

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
      acceptSnapshot: setSnapshot,
      error,
      installTunHelper: () => runTunHelper(() => client.installTunHelper()),
      localBackupClient,
      pending,
      refreshNetworkDns,
      removeTunHelper: async () => (await runTunHelper(() => client.removeTunHelper())).ok,
      repairTunHelper: async () => (await runTunHelper(() => client.repairTunHelper())).ok,
      setAppearance: async (appearance) => (await run(() => client.setAppearance(appearance))).ok,
      setLanguage: async (language) => (await run(() => client.setLanguage(language))).ok,
      setOnboardingWelcomeState: async (action) =>
        (await run(() => client.setOnboardingWelcomeState(action))).ok,
      setStartup: async (startup) => (await run(() => client.setStartup(startup))).ok,
      setLaunchProxyWhenMishLaunches: async (launchProxyWhenMishLaunches) =>
        (await run(() => client.setLaunchProxyWhenMishLaunches(launchProxyWhenMishLaunches))).ok,
      setWindowCloseBehavior: async (behavior) =>
        (await run(() => client.setWindowCloseBehavior(behavior))).ok,
      setWindowSurface: async (surface) => (await run(() => client.setWindowSurface(surface))).ok,
      snapshot,
      tunHelperFailure,
    }),
    [
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

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) throw new Error("useSettings must be used inside SettingsProvider");
  return context;
}

export function useOptionalSettings() {
  return useContext(SettingsContext);
}
