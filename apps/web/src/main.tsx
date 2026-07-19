import { StrictMode, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { Toaster } from "sonner";
import { TooltipProvider } from "@mish/ui";
import { isTauri } from "@tauri-apps/api/core";
import { AppRoutes } from "./app";
import {
  applyInitialAppearance,
  applyInitialWindowSurface,
  AppearanceProvider,
  useAppearance,
} from "./appearance";
import { ProductProvider } from "./data/product-provider";
import { ProfileProvider } from "./data/profile-provider";
import { TrafficProvider } from "./data/traffic-provider";
import { EventsProvider } from "./data/events-provider";
import { SettingsProvider, useSettings } from "./data/settings-provider";
import { StartupFailure } from "./components/startup-failure";
import TypesafeI18n from "./i18n/i18n-react";
import { loadAllLocales } from "./i18n/i18n-util.sync";
import { persistLocale, resolveInitialLocale } from "./i18n/locale";
import { resolveStartupStatusClient } from "./platform/runtime-bootstrap";
import { installDesktopNativeFeel } from "./platform/desktop-native-feel";
import { signalDesktopWindowReady } from "./platform/desktop-window";
import { NativeNavigationBridge } from "./platform/native-navigation";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const applicationRoot = root;
const reactRoot = createRoot(applicationRoot);

function renderInitialApplication(application: ReactNode) {
  flushSync(() => reactRoot.render(application));
  void signalDesktopWindowReady().catch(() => undefined);
}

function AppearanceToaster() {
  const { resolvedAppearance } = useAppearance();
  return <Toaster position="bottom-right" theme={resolvedAppearance} />;
}

function ConfiguredAppearanceProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  return (
    <AppearanceProvider
      initialPreference={settings.snapshot.preferences.appearance}
      initialWindowSurfacePreference={settings.snapshot.preferences.windowSurface}
      nativeSidebarMaterialSupported={
        settings.snapshot.capabilities.nativeSidebarMaterial === "supported"
      }
      onPreferenceChange={settings.setAppearance}
      onWindowSurfacePreferenceChange={settings.setWindowSurface}
    >
      {children}
    </AppearanceProvider>
  );
}

async function startApplication() {
  loadAllLocales();
  const runtime = isTauri() ? "desktop" : "browser";
  document.documentElement.dataset.runtime = runtime;
  const releaseNativeFeel = installDesktopNativeFeel(runtime);
  let disposeStartup: () => void = () => undefined;
  window.addEventListener(
    "pagehide",
    () => {
      releaseNativeFeel();
      disposeStartup();
    },
    { once: true },
  );

  try {
    const startup = await resolveStartupStatusClient();
    disposeStartup = startup.dispose;
    const initialLocale = startup.settingsSnapshot.preferences.language ?? resolveInitialLocale();
    applyInitialAppearance(startup.settingsSnapshot.preferences.appearance);
    applyInitialWindowSurface(
      startup.settingsSnapshot.preferences.windowSurface,
      startup.settingsSnapshot.capabilities.nativeSidebarMaterial === "supported",
    );
    persistLocale(initialLocale);
    renderInitialApplication(
      <StrictMode>
        <SettingsProvider
          client={startup.settingsClient}
          initialSnapshot={startup.settingsSnapshot}
          localBackupClient={startup.localBackupClient}
        >
          <ConfiguredAppearanceProvider>
            <TypesafeI18n locale={initialLocale}>
              <BrowserRouter>
                <NativeNavigationBridge />
                <ProductProvider client={startup.client}>
                  <ProfileProvider client={startup.profileClient}>
                    <TrafficProvider client={startup.trafficClient}>
                      <EventsProvider
                        client={startup.eventsClient}
                        diagnosticsClient={startup.diagnosticsClient}
                        supportBundleClient={startup.supportBundleClient}
                      >
                        <TooltipProvider delay={500}>
                          <AppRoutes />
                          <AppearanceToaster />
                        </TooltipProvider>
                      </EventsProvider>
                    </TrafficProvider>
                  </ProfileProvider>
                </ProductProvider>
              </BrowserRouter>
            </TypesafeI18n>
          </ConfiguredAppearanceProvider>
        </SettingsProvider>
      </StrictMode>,
    );
  } catch {
    const initialLocale = resolveInitialLocale();
    persistLocale(initialLocale);
    renderInitialApplication(
      <StrictMode>
        <AppearanceProvider>
          <TypesafeI18n locale={initialLocale}>
            <StartupFailure />
          </TypesafeI18n>
        </AppearanceProvider>
      </StrictMode>,
    );
  }
}

void startApplication();
