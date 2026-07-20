import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import type { WindowSurfacePreference } from "@mish/contracts";
import { syncDesktopWindowAppearance } from "./platform/desktop-window";

export type AppearancePreference = "light" | "dark" | "system";
export type ResolvedAppearance = Exclude<AppearancePreference, "system">;
export type EffectiveWindowSurface = "opaque" | "native-material";
export type WindowSurfaceFallbackReason = "unsupported" | "reduced-transparency" | null;

export interface WindowSurfaceResolution {
  effectiveSurface: EffectiveWindowSurface;
  fallbackReason: WindowSurfaceFallbackReason;
}

interface AppearanceContextValue {
  appearancePending: boolean;
  preference: AppearancePreference;
  resolvedAppearance: ResolvedAppearance;
  effectiveWindowSurface: EffectiveWindowSurface;
  setPreference: (preference: AppearancePreference) => void;
  setWindowSurfacePreference: (preference: WindowSurfacePreference) => void;
  windowSurfaceFallbackReason: WindowSurfaceFallbackReason;
  windowSurfacePending: boolean;
  windowSurfacePreference: WindowSurfacePreference;
}

const appearanceStorageKey = "mish.appearance";
const darkModeQuery = "(prefers-color-scheme: dark)";
const reducedTransparencyQuery = "(prefers-reduced-transparency: reduce)";
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

export function resolveWindowSurface(
  preference: WindowSurfacePreference,
  nativeMaterialSupported: boolean,
  reducedTransparency: boolean,
): WindowSurfaceResolution {
  if (preference === "opaque") {
    return { effectiveSurface: "opaque", fallbackReason: null };
  }
  if (!nativeMaterialSupported) {
    return { effectiveSurface: "opaque", fallbackReason: "unsupported" };
  }
  if (reducedTransparency) {
    return { effectiveSurface: "opaque", fallbackReason: "reduced-transparency" };
  }
  return { effectiveSurface: "native-material", fallbackReason: null };
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

function applyWindowSurface(resolution: WindowSurfaceResolution) {
  document.documentElement.dataset.windowSurface =
    resolution.effectiveSurface === "native-material" ? "material" : "opaque";
  if (resolution.fallbackReason) {
    document.documentElement.dataset.windowSurfaceFallback = resolution.fallbackReason;
  } else {
    delete document.documentElement.dataset.windowSurfaceFallback;
  }
}

export function applyInitialAppearance(preference: AppearancePreference) {
  persistAppearance(preference);
  applyAppearance(resolveAppearance(preference));
}

export function applyInitialWindowSurface(
  preference: WindowSurfacePreference,
  nativeMaterialSupported: boolean,
) {
  const reducedTransparency = globalThis.matchMedia?.(reducedTransparencyQuery).matches ?? false;
  applyWindowSurface(
    resolveWindowSurface(preference, nativeMaterialSupported, reducedTransparency),
  );
}

export function AppearanceProvider({
  children,
  initialPreference,
  initialWindowSurfacePreference = "material",
  nativeSidebarMaterialSupported = false,
  onPreferenceChange,
  onWindowSurfacePreferenceChange,
}: {
  children: ReactNode;
  initialPreference?: AppearancePreference;
  initialWindowSurfacePreference?: WindowSurfacePreference;
  nativeSidebarMaterialSupported?: boolean;
  onPreferenceChange?: (preference: AppearancePreference) => Promise<boolean> | void;
  onWindowSurfacePreferenceChange?: (
    preference: WindowSurfacePreference,
  ) => Promise<boolean> | void;
}) {
  const [preference, setPreferenceState] = useState(initialPreference ?? resolveInitialAppearance);
  const [appearancePending, setAppearancePending] = useState(false);
  const [resolvedAppearance, setResolvedAppearance] = useState(() => resolveAppearance(preference));
  const [windowSurfacePreference, setWindowSurfacePreferenceState] = useState(
    initialWindowSurfacePreference,
  );
  const [windowSurfacePending, setWindowSurfacePending] = useState(false);
  const [reducedTransparency, setReducedTransparency] = useState(
    () => globalThis.matchMedia?.(reducedTransparencyQuery).matches ?? false,
  );

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

  useEffect(() => {
    const mediaQuery = globalThis.matchMedia?.(reducedTransparencyQuery);
    if (!mediaQuery) return;
    const updateReducedTransparency = () => setReducedTransparency(mediaQuery.matches);
    updateReducedTransparency();
    mediaQuery.addEventListener("change", updateReducedTransparency);
    return () => mediaQuery.removeEventListener("change", updateReducedTransparency);
  }, []);

  const windowSurface = useMemo(
    () =>
      resolveWindowSurface(
        windowSurfacePreference,
        nativeSidebarMaterialSupported,
        reducedTransparency,
      ),
    [nativeSidebarMaterialSupported, reducedTransparency, windowSurfacePreference],
  );

  useEffect(() => applyWindowSurface(windowSurface), [windowSurface]);

  const value = useMemo<AppearanceContextValue>(
    () => ({
      appearancePending,
      preference,
      resolvedAppearance,
      effectiveWindowSurface: windowSurface.effectiveSurface,
      setPreference: (nextPreference) => {
        const previousPreference = preference;
        persistAppearance(nextPreference);
        setPreferenceState(nextPreference);
        const result = onPreferenceChange?.(nextPreference);
        if (result instanceof Promise) {
          setAppearancePending(true);
          void result
            .then((confirmed) => {
              if (confirmed !== false) return;
              persistAppearance(previousPreference);
              setPreferenceState(previousPreference);
            })
            .finally(() => setAppearancePending(false));
        }
      },
      setWindowSurfacePreference: (nextPreference) => {
        const previousPreference = windowSurfacePreference;
        setWindowSurfacePreferenceState(nextPreference);
        const result = onWindowSurfacePreferenceChange?.(nextPreference);
        if (result instanceof Promise) {
          setWindowSurfacePending(true);
          void result
            .then((confirmed) => {
              if (confirmed !== false) return;
              setWindowSurfacePreferenceState(previousPreference);
            })
            .finally(() => setWindowSurfacePending(false));
        }
      },
      windowSurfaceFallbackReason: windowSurface.fallbackReason,
      windowSurfacePending,
      windowSurfacePreference,
    }),
    [
      onPreferenceChange,
      onWindowSurfacePreferenceChange,
      appearancePending,
      preference,
      resolvedAppearance,
      windowSurface,
      windowSurfacePending,
      windowSurfacePreference,
    ],
  );

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error("useAppearance must be used within AppearanceProvider");
  return context;
}
