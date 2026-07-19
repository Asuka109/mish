import type {
  AppearancePreference,
  LanguagePreference,
  LocalBackupClient,
  SettingsClient,
  SettingsSnapshotDto,
  StartupPreferencesDto,
  WindowCloseBehavior,
  WindowSurfacePreference,
} from "@mish/contracts";
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

interface SettingsContextValue {
  acceptSnapshot(snapshot: SettingsSnapshotDto): void;
  error: string | null;
  pending: boolean;
  installTunHelper(): Promise<boolean>;
  localBackupClient: LocalBackupClient;
  refreshNetworkDns(): Promise<boolean>;
  removeTunHelper(): Promise<boolean>;
  repairTunHelper(): Promise<boolean>;
  setAppearance(appearance: AppearancePreference): Promise<boolean>;
  setLanguage(language: LanguagePreference): Promise<boolean>;
  setStartup(startup: StartupPreferencesDto): Promise<boolean>;
  setWindowCloseBehavior(behavior: WindowCloseBehavior): Promise<boolean>;
  setWindowSurface(surface: WindowSurfacePreference): Promise<boolean>;
  snapshot: SettingsSnapshotDto;
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

  const run = useCallback(
    async (operation: () => Promise<SettingsSnapshotDto>) => {
      if (pendingRef.current) return false;
      pendingRef.current = true;
      setPending(true);
      setError(null);
      try {
        setSnapshot(await operation());
        return true;
      } catch {
        setError("settings-update-failed");
        try {
          setSnapshot(await client.getSnapshot());
        } catch {
          // Keep the last confirmed snapshot when refresh also fails.
        }
        return false;
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
      return await run(() => client.refreshNetworkDns({ signal: controller.signal }));
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

  const value = useMemo<SettingsContextValue>(
    () => ({
      acceptSnapshot: setSnapshot,
      error,
      installTunHelper: () => run(() => client.installTunHelper()),
      localBackupClient,
      pending,
      refreshNetworkDns,
      removeTunHelper: () => run(() => client.removeTunHelper()),
      repairTunHelper: () => run(() => client.repairTunHelper()),
      setAppearance: (appearance) => run(() => client.setAppearance(appearance)),
      setLanguage: (language) => run(() => client.setLanguage(language)),
      setStartup: (startup) => run(() => client.setStartup(startup)),
      setWindowCloseBehavior: (behavior) => run(() => client.setWindowCloseBehavior(behavior)),
      setWindowSurface: (surface) => run(() => client.setWindowSurface(surface)),
      snapshot,
    }),
    [client, error, localBackupClient, pending, refreshNetworkDns, run, snapshot],
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
