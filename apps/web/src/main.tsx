import { StrictMode, type ReactNode } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { Toaster } from "sonner";
import { TooltipProvider } from "@mish/ui";
import { isTauri } from "@tauri-apps/api/core";
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
import {
  SettingsLanguageProjection,
  SettingsProvider,
  useSettings,
} from "./data/settings-provider";
import { StartupFailure } from "./components/startup-failure";
import { BrowserAuthentication } from "./components/browser-authentication";
import { BrowserBackendRecovery } from "./components/browser-backend-recovery";
import { DesktopWindowFrame } from "./components/desktop-window-frame";
import TypesafeI18n from "./i18n/i18n-react";
import { loadAllLocales } from "./i18n/i18n-util.sync";
import { projectLocale, resolveInitialLocale } from "./i18n/locale";
import {
  BrowserAuthenticationRequired,
  resolveStartupStatusClient,
} from "./platform/runtime-bootstrap";
import { resolveMobileStartup } from "./platform/mobile-runtime-bootstrap";
import { resolveRuntimeKind } from "./platform/runtime-kind";
import { installDesktopNativeFeel } from "./platform/desktop-native-feel";
import { signalDesktopWindowReady } from "./platform/desktop-window";
import { NativeNavigationBridge } from "./platform/native-navigation";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const applicationRoot = root;
const reactRoot = createRoot(applicationRoot);
const appRoutesModulePromise =
  import.meta.env.VITE_MISH_BUILD_TARGET === "mobile" ? import("./mobile-app") : import("./app");

function renderInitialApplication(
  application: ReactNode,
  runtime: "browser" | "desktop" | "mobile",
) {
  flushSync(() =>
    reactRoot.render(<DesktopWindowFrame runtime={runtime}>{application}</DesktopWindowFrame>),
  );
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
  const runtime = resolveRuntimeKind({
    buildTarget: import.meta.env.VITE_MISH_BUILD_TARGET,
    tauri: isTauri(),
  });
  document.documentElement.dataset.runtime = runtime;
  const releaseNativeFeel =
    runtime === "mobile" ? () => undefined : installDesktopNativeFeel(runtime);
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
    const { AppRoutes } = await appRoutesModulePromise;
    const startup =
      runtime === "mobile" ? await resolveMobileStartup() : await resolveStartupStatusClient();
    disposeStartup = startup.dispose;
    const initialLocale =
      startup.settingsSnapshot.preferences.language === "zh-CN" ? "zh" : "en";
    applyInitialAppearance(startup.settingsSnapshot.preferences.appearance);
    applyInitialWindowSurface(
      startup.settingsSnapshot.preferences.windowSurface,
      startup.settingsSnapshot.capabilities.nativeSidebarMaterial === "supported",
    );
    projectLocale(initialLocale);
    renderInitialApplication(
      <StrictMode>
        <SettingsProvider
          client={startup.settingsClient}
          initialSnapshot={startup.settingsSnapshot}
          localBackupClient={startup.localBackupClient}
        >
          <ConfiguredAppearanceProvider>
            <SettingsLanguageProjection>
              <BrowserBackendRecovery
                backendPort={startup.browserBackendPort}
                connection={startup.client}
                onRecoveryRequired={startup.dispose}
                runtime={runtime}
              >
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
                            <AppRoutes
                              mobileFixture={startup.mobileFixture}
                              mobileVpnClient={startup.mobileVpnClient}
                              mobileVpnSnapshot={startup.mobileVpnSnapshot}
                            />
                            <AppearanceToaster />
                          </TooltipProvider>
                        </EventsProvider>
                      </TrafficProvider>
                    </ProfileProvider>
                  </ProductProvider>
                </BrowserRouter>
              </BrowserBackendRecovery>
            </SettingsLanguageProjection>
          </ConfiguredAppearanceProvider>
        </SettingsProvider>
      </StrictMode>,
      runtime,
    );
  } catch (error) {
    const initialLocale = resolveInitialLocale();
    projectLocale(initialLocale);
    renderInitialApplication(
      <StrictMode>
        <AppearanceProvider>
          <TypesafeI18n locale={initialLocale}>
            {error instanceof BrowserAuthenticationRequired ? (
              <BrowserAuthentication />
            ) : (
              <StartupFailure />
            )}
          </TypesafeI18n>
        </AppearanceProvider>
      </StrictMode>,
      runtime,
    );
  }
}

void startApplication();
