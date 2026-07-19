import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { Toaster } from "sonner";
import { TooltipProvider } from "@mish/ui";
import { AppRoutes } from "./app";
import { applyInitialAppearance, AppearanceProvider, useAppearance } from "./appearance";
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
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Missing application root");
const applicationRoot = root;

function AppearanceToaster() {
  const { resolvedAppearance } = useAppearance();
  return <Toaster position="bottom-right" theme={resolvedAppearance} />;
}

function ConfiguredAppearanceProvider({ children }: { children: ReactNode }) {
  const settings = useSettings();
  return (
    <AppearanceProvider
      initialPreference={settings.snapshot.preferences.appearance}
      onPreferenceChange={settings.setAppearance}
    >
      {children}
    </AppearanceProvider>
  );
}

async function startApplication() {
  loadAllLocales();

  try {
    const startup = await resolveStartupStatusClient();
    const initialLocale = startup.settingsSnapshot.preferences.language ?? resolveInitialLocale();
    applyInitialAppearance(startup.settingsSnapshot.preferences.appearance);
    persistLocale(initialLocale);
    document.documentElement.dataset.runtime = startup.runtime;
    document.documentElement.dataset.nativeSidebarMaterial = startup.nativeSidebarMaterial
      ? "available"
      : "fallback";
    window.addEventListener("pagehide", startup.dispose, { once: true });
    createRoot(applicationRoot).render(
      <StrictMode>
        <SettingsProvider
          client={startup.settingsClient}
          initialSnapshot={startup.settingsSnapshot}
        >
          <ConfiguredAppearanceProvider>
            <TypesafeI18n locale={initialLocale}>
              <BrowserRouter>
                <ProductProvider client={startup.client}>
                  <ProfileProvider client={startup.profileClient}>
                    <TrafficProvider client={startup.trafficClient}>
                      <EventsProvider client={startup.eventsClient}>
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
    createRoot(applicationRoot).render(
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
