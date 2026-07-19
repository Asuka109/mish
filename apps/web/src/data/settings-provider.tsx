import type {
  AppearancePreference,
  LanguagePreference,
  SettingsClient,
  SettingsSnapshotDto,
  StartupPreferencesDto,
} from "@mish/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

interface SettingsContextValue {
  error: string | null;
  pending: boolean;
  setAppearance(appearance: AppearancePreference): Promise<boolean>;
  setLanguage(language: LanguagePreference): Promise<boolean>;
  setStartup(startup: StartupPreferencesDto): Promise<boolean>;
  snapshot: SettingsSnapshotDto;
}

const SettingsContext = createContext<SettingsContextValue | null>(null);

export function SettingsProvider({
  children,
  client,
  initialSnapshot,
}: {
  children: ReactNode;
  client: SettingsClient;
  initialSnapshot: SettingsSnapshotDto;
}) {
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
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

  const value = useMemo<SettingsContextValue>(
    () => ({
      error,
      pending,
      setAppearance: (appearance) => run(() => client.setAppearance(appearance)),
      setLanguage: (language) => run(() => client.setLanguage(language)),
      setStartup: (startup) => run(() => client.setStartup(startup)),
      snapshot,
    }),
    [client, error, pending, run, snapshot],
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
