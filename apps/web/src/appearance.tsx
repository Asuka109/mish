import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { syncDesktopWindowAppearance } from "./platform/desktop-window";

export type AppearancePreference = "light" | "dark" | "system";
export type ResolvedAppearance = Exclude<AppearancePreference, "system">;

interface AppearanceContextValue {
  preference: AppearancePreference;
  resolvedAppearance: ResolvedAppearance;
  setPreference: (preference: AppearancePreference) => void;
}

const appearanceStorageKey = "mish.appearance";
const darkModeQuery = "(prefers-color-scheme: dark)";
const AppearanceContext = createContext<AppearanceContextValue | null>(null);

function isAppearancePreference(value: string | null): value is AppearancePreference {
  return value === "light" || value === "dark" || value === "system";
}

export function resolveInitialAppearance(): AppearancePreference {
  try {
    const storedAppearance = globalThis.localStorage?.getItem(appearanceStorageKey) ?? null;
    if (isAppearancePreference(storedAppearance)) return storedAppearance;
  } catch {
    // Storage can be unavailable in hardened browser contexts.
  }

  return "system";
}

function resolveAppearance(preference: AppearancePreference): ResolvedAppearance {
  if (preference !== "system") return preference;
  return globalThis.matchMedia?.(darkModeQuery).matches ? "dark" : "light";
}

function applyAppearance(appearance: ResolvedAppearance) {
  document.documentElement.dataset.theme = appearance;
  document.documentElement.style.colorScheme = appearance;

  const themeColor = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  themeColor?.setAttribute("content", appearance === "dark" ? "#111113" : "#f8f9fa");
}

function persistAppearance(preference: AppearancePreference) {
  try {
    globalThis.localStorage?.setItem(appearanceStorageKey, preference);
  } catch {
    // The in-memory preference still works when persistence is unavailable.
  }
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [preference, setPreferenceState] = useState(resolveInitialAppearance);
  const [resolvedAppearance, setResolvedAppearance] = useState(() => resolveAppearance(preference));

  useEffect(() => {
    const mediaQuery = globalThis.matchMedia?.(darkModeQuery);

    const updateAppearance = () => {
      const nextAppearance = resolveAppearance(preference);
      setResolvedAppearance(nextAppearance);
      applyAppearance(nextAppearance);
    };

    updateAppearance();
    syncDesktopWindowAppearance(preference);
    if (preference !== "system" || !mediaQuery) return;

    mediaQuery.addEventListener("change", updateAppearance);
    return () => mediaQuery.removeEventListener("change", updateAppearance);
  }, [preference]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      preference,
      resolvedAppearance,
      setPreference: (nextPreference) => {
        persistAppearance(nextPreference);
        setPreferenceState(nextPreference);
      },
    }),
    [preference, resolvedAppearance],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error("useAppearance must be used within AppearanceProvider");
  return context;
}
