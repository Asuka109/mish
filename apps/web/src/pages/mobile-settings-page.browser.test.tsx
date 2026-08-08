import type {
  MobileConfigLoadResultDto,
  MobileConfigValidationResultDto,
  MobileFixtureBootstrapDto,
  MobileVpnSnapshotDto,
  SettingsSnapshotDto,
} from "@mish/contracts";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { AppearanceProvider } from "../appearance";
import { MobileShell } from "../components/mobile-shell";
import { createFixtureSettingsSnapshot } from "../data/fixture-settings-client";
import { SettingsLanguageProjection, SettingsProvider } from "../data/settings-provider";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import type { Locales } from "../i18n/i18n-types";
import { MobileSettingsDetailPage, MobileSettingsPage } from "./mobile-settings-page";
import {
  MobileSettingsClient,
  type MobileSettingsTransport,
} from "../platform/mobile-settings-client";
import type { MobileVpnClient } from "../platform/mobile-vpn-client";
import "../styles.css";

interface EmulationSession {
  send(
    method: "Emulation.setEmulatedMedia",
    params: { features: { name: string; value: string }[] },
  ): Promise<unknown>;
}

interface MobileViewport {
  height: number;
  locale: Locales;
  name: string;
  theme: "dark" | "light";
  width: number;
}

const fixture: MobileFixtureBootstrapDto = {
  adapterKind: "native",
  contractVersion: 1,
  core: { availability: "available", kind: "native" },
  message: "Android VPN boundaries are available through typed commands.",
  platform: "android",
  targetAbis: ["arm64-v8a", "x86_64"],
  vpn: { availability: "available", kind: "native" },
};

const vpnSnapshot: MobileVpnSnapshotDto = {
  activationSessionId: "mobile-settings-activation",
  activeNetwork: true,
  authorityId: "mobile-settings-browser-authority",
  backendKind: "native",
  contractVersion: 1,
  coreAbiVersion: 1,
  coreAvailability: "available",
  coreCommit: "test-commit",
  configFailureInjectionAvailable: false,
  coreConfigState: "loaded",
  coreRunning: true,
  coreVersion: "v1.19.29",
  coreWrapperRevision: "mobile-v1",
  dnsApplied: true,
  failure: null,
  foreground: true,
  loadedConfigDigest: "a".repeat(64),
  loadedConfigRevision: "settings-browser-revision",
  message: "Android VPN is running with verified platform facts.",
  notificationPermission: "granted",
  operation: null,
  permission: "granted",
  phase: "running",
  protectedSocketCount: 1,
  publicRequestObserved: true,
  revision: 2,
  routesApplied: true,
  sequence: 2,
  sessionId: "mobile-settings-browser-session",
  tunAvailability: "available",
  tunEstablished: true,
  updatedAtMillis: 2,
  validatedConfigDigest: "a".repeat(64),
  validatedConfigRevision: "settings-browser-revision",
  vpnActive: true,
  vpnAvailability: "available",
};

const viewports: readonly MobileViewport[] = [
  { height: 568, locale: "en", name: "compact portrait", theme: "light", width: 320 },
  { height: 800, locale: "zh", name: "common portrait", theme: "dark", width: 360 },
  { height: 915, locale: "en", name: "large portrait", theme: "dark", width: 412 },
  { height: 360, locale: "zh", name: "compact landscape", theme: "light", width: 640 },
  { height: 412, locale: "en", name: "common landscape", theme: "light", width: 915 },
];

class BrowserMobileVpnClient implements MobileVpnClient {
  constructor(private snapshot: MobileVpnSnapshotDto) {}

  dispose() {}

  getSnapshot() {
    return this.snapshot;
  }

  async initialize() {
    return this.snapshot;
  }

  async loadConfig(
    _bytes: Uint8Array,
    identity: { digest: string; revision: string },
  ): Promise<MobileConfigLoadResultDto> {
    return {
      cancellation: "not-requested",
      contractVersion: 1,
      digest: identity.digest,
      failure: "core-unavailable",
      message: "The browser test does not load configuration.",
      operationId: "mobile-settings-browser-load",
      outcome: "failed",
      revision: identity.revision,
      rollback: "unloaded",
      snapshot: this.snapshot,
      timing: "on-time",
    };
  }

  async requestNotificationPermission() {
    return this.snapshot;
  }

  async requestVpnConsent() {
    return this.snapshot;
  }

  async start() {
    return this.snapshot;
  }

  async stop() {
    return this.snapshot;
  }

  subscribe(listener: (snapshot: MobileVpnSnapshotDto) => void) {
    listener(this.snapshot);
    return () => undefined;
  }

  async validateConfig(): Promise<MobileConfigValidationResultDto> {
    return {
      contractVersion: 1,
      failure: "core-unavailable",
      message: "The browser test does not validate configuration.",
      outcome: "failed",
      sequence: this.snapshot.sequence,
      sessionId: this.snapshot.sessionId,
    };
  }
}

class BrowserSettingsTransport implements MobileSettingsTransport {
  readonly commands: string[] = [];

  constructor(private snapshot: SettingsSnapshotDto) {}

  async invoke(command: string, args?: Record<string, unknown>) {
    this.commands.push(command);
    if (command === "mobile_settings_get_snapshot") return structuredClone(this.snapshot);

    const request = args?.request as
      | { appearance?: "dark" | "light" | "system"; language?: "en" | "zh-CN" }
      | undefined;
    if (command === "mobile_settings_set_appearance" && request?.appearance) {
      this.snapshot = {
        ...this.snapshot,
        applicationOrder: {
          ...this.snapshot.applicationOrder,
          order: this.snapshot.applicationOrder.order + 1,
        },
        preferences: { ...this.snapshot.preferences, appearance: request.appearance },
        revision: this.snapshot.revision + 1,
      };
      return structuredClone(this.snapshot);
    }
    if (command === "mobile_settings_set_language" && request?.language) {
      this.snapshot = {
        ...this.snapshot,
        applicationOrder: {
          ...this.snapshot.applicationOrder,
          order: this.snapshot.applicationOrder.order + 1,
        },
        preferences: { ...this.snapshot.preferences, language: request.language },
        revision: this.snapshot.revision + 1,
      };
      return structuredClone(this.snapshot);
    }
    throw new Error(`Unexpected Android Settings command: ${command}`);
  }
}

function nativeSettingsSnapshot(locale: Locales, theme: "dark" | "light"): SettingsSnapshotDto {
  const snapshot = createFixtureSettingsSnapshot();
  return {
    ...snapshot,
    adapterKind: "native",
    preferences: {
      ...snapshot.preferences,
      appearance: theme,
      language: locale === "zh" ? "zh-CN" : "en",
      onboarding: { welcomeInvitation: null },
    },
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeAll(() => loadAllLocales());

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.runtime;
  delete document.documentElement.dataset.theme;
});

function renderMobileSettings(
  route: string,
  locale: Locales = "en",
  theme: "dark" | "light" = "light",
) {
  const initialSnapshot = nativeSettingsSnapshot(locale, theme);
  const transport = new BrowserSettingsTransport(initialSnapshot);
  const settingsClient = new MobileSettingsClient(transport);
  const vpnClient = new BrowserMobileVpnClient(vpnSnapshot);
  document.documentElement.dataset.runtime = "mobile";
  container = document.createElement("div");
  container.id = "root";
  document.body.append(container);
  root = createRoot(container);

  flushSync(() => {
    root?.render(
      <SettingsProvider client={settingsClient} initialSnapshot={initialSnapshot}>
        <AppearanceProvider
          initialPreference={initialSnapshot.preferences.appearance}
          onPreferenceChange={(appearance) =>
            settingsClient.setAppearance(appearance).then(() => true)
          }
        >
          <SettingsLanguageProjection>
            <MemoryRouter initialEntries={[route]} key={`${route}-${locale}-${theme}`}>
              <Routes>
                <Route element={<MobileShell fixture={fixture} />}>
                  <Route
                    element={
                      <MobileSettingsPage initialSnapshot={vpnSnapshot} vpnClient={vpnClient} />
                    }
                    path="settings"
                  />
                  <Route
                    element={
                      <MobileSettingsDetailPage
                        initialSnapshot={vpnSnapshot}
                        vpnClient={vpnClient}
                      />
                    }
                    path="settings/:section"
                  />
                </Route>
              </Routes>
            </MemoryRouter>
          </SettingsLanguageProjection>
        </AppearanceProvider>
      </SettingsProvider>,
    );
  });

  return { transport };
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForSettingsPage() {
  await vi.waitFor(() => expect(document.querySelector(".mobile-settings-page")).not.toBeNull());
  await nextFrame();
}

function expectSettingsGeometry(context: string) {
  const scroller = document.querySelector<HTMLElement>(".mobile-settings-page");
  const bottomNavigation = document.querySelector<HTMLElement>(".mobile-bottom-navigation");
  if (!scroller || !bottomNavigation) throw new Error(`${context}: missing Android Settings shell`);

  expect(getComputedStyle(scroller).overflowY, `${context}: Settings owns local scrolling`).toBe(
    "auto",
  );
  expect(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    `${context}: document overflow`,
  ).toBeLessThanOrEqual(1);
  expect(
    scroller.scrollWidth - scroller.clientWidth,
    `${context}: Settings overflow`,
  ).toBeLessThanOrEqual(1);
  expect(bottomNavigation.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    window.innerHeight + 0.5,
  );

  const controls = [
    ...document.querySelectorAll<HTMLElement>(
      ".mobile-settings-category, .mobile-settings-page button, .mobile-top-app-bar-back, .mobile-destination",
    ),
  ].filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.height > 0 && rect.width > 0;
  });
  if (controls.length === 0) throw new Error(`${context}: missing visible Settings controls`);

  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    const identity = control.getAttribute("aria-label") ?? control.textContent?.trim() ?? "control";
    expect(rect.height, `${context}: ${identity} touch height`).toBeGreaterThanOrEqual(44);
    expect(rect.width, `${context}: ${identity} touch width`).toBeGreaterThanOrEqual(44);
    expect(rect.left, `${context}: ${identity} left edge`).toBeGreaterThanOrEqual(-0.5);
    expect(rect.right, `${context}: ${identity} right edge`).toBeLessThanOrEqual(
      window.innerWidth + 0.5,
    );
  }
}

describe("Android mobile Settings geometry and authority projection", () => {
  test.each(viewports)(
    "keeps the grouped root usable in $name with $locale $theme",
    async (viewport) => {
      await page.viewport(viewport.width, viewport.height);
      renderMobileSettings("/settings", viewport.locale, viewport.theme);
      await waitForSettingsPage();

      expect(document.querySelector(".settings-page")).toBeNull();
      expect(document.querySelector(".mobile-settings-category")).not.toBeNull();
      expect(document.body.textContent).not.toContain("System Proxy");
      expect(document.body.textContent).not.toContain("Window surface");
      expectSettingsGeometry(`${viewport.locale} ${viewport.theme} ${viewport.name}`);
    },
  );

  test("keeps an Application child locally scrollable when the keyboard reduces height", async () => {
    await page.viewport(360, 420);
    renderMobileSettings("/settings/application", "zh");
    await waitForSettingsPage();

    const scroller = document.querySelector<HTMLElement>(".mobile-settings-page");
    const appearance = page.getByRole("button", { name: "深色" });
    if (!scroller) throw new Error("Missing Android Settings scroller");
    appearance.element().focus();
    expect(document.activeElement).toBe(appearance.element());
    expect(getComputedStyle(scroller).overflowY).toBe("auto");
    expectSettingsGeometry("keyboard viewport");
  });

  test("supports enlarged text without horizontal clipping", async () => {
    await page.viewport(320, 568);
    document.documentElement.style.setProperty("--mish-typography-title-font-size", "30px");
    document.documentElement.style.setProperty("--mish-typography-body-font-size", "20px");
    document.documentElement.style.setProperty("--mish-typography-metadata-font-size", "18px");
    document.documentElement.style.setProperty("--mish-typography-label-small-font-size", "16px");
    renderMobileSettings("/settings/application", "zh", "dark");
    await waitForSettingsPage();

    expectSettingsGeometry("enlarged text");
    for (const row of document.querySelectorAll<HTMLElement>(".section-grid-item")) {
      expect(
        row.scrollWidth - row.clientWidth,
        row.textContent ?? "scaled Settings row",
      ).toBeLessThanOrEqual(1);
    }
  });

  test("keeps enlarged text within the 392px physical Android WebView width", async () => {
    await page.viewport(392, 872);
    document.documentElement.style.setProperty("--mish-typography-title-font-size", "30px");
    document.documentElement.style.setProperty("--mish-typography-body-font-size", "20px");
    document.documentElement.style.setProperty("--mish-typography-metadata-font-size", "18px");
    document.documentElement.style.setProperty("--mish-typography-label-small-font-size", "16px");
    renderMobileSettings("/settings/application", "en", "dark");
    await waitForSettingsPage();

    expectSettingsGeometry("392px physical Android WebView enlarged text");
    for (const row of document.querySelectorAll<HTMLElement>(".section-grid-item")) {
      expect(
        row.scrollWidth - row.clientWidth,
        row.textContent ?? "scaled Settings row",
      ).toBeLessThanOrEqual(1);
    }
  });

  test("keeps enlarged text within the physical Android landscape WebView", async () => {
    await page.viewport(872, 392);
    document.documentElement.style.setProperty("--mish-typography-title-font-size", "30px");
    document.documentElement.style.setProperty("--mish-typography-body-font-size", "20px");
    document.documentElement.style.setProperty("--mish-typography-metadata-font-size", "18px");
    document.documentElement.style.setProperty("--mish-typography-label-small-font-size", "16px");
    renderMobileSettings("/settings/application", "en", "dark");
    await waitForSettingsPage();

    expectSettingsGeometry("physical Android landscape WebView enlarged text");
    for (const row of document.querySelectorAll<HTMLElement>(".section-grid-item")) {
      expect(
        row.scrollWidth - row.clientWidth,
        row.textContent ?? "scaled Settings row",
      ).toBeLessThanOrEqual(1);
    }
  });

  test("uses native commands for portable changes and returns through focused Settings navigation", async () => {
    await page.viewport(360, 800);
    const { transport } = renderMobileSettings("/settings");
    await waitForSettingsPage();

    await userEvent.click(page.getByRole("link", { name: "Application" }));
    await vi.waitFor(() => {
      expect(document.querySelector(".mobile-top-app-bar h1")).toHaveTextContent("Settings");
      expect(document.activeElement).toBe(document.querySelector(".mobile-top-app-bar h1"));
    });
    await userEvent.click(page.getByRole("button", { name: "Dark" }));
    await vi.waitFor(() => expect(transport.commands).toContain("mobile_settings_set_appearance"));
    expect(document.documentElement.dataset.theme).toBe("dark");

    await userEvent.click(page.getByRole("link", { exact: true, name: "Back" }));
    await vi.waitFor(() => {
      expect(document.querySelector(".mobile-settings-category")).not.toBeNull();
      expect(document.activeElement).toBe(document.querySelector(".mobile-top-app-bar h1"));
    });
  });

  test("keeps Settings controls available when reduced motion is requested", async () => {
    const session = (await cdp()) as unknown as EmulationSession;
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    try {
      await page.viewport(360, 800);
      renderMobileSettings("/settings/recovery");
      await waitForSettingsPage();
      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      expect(page.getByRole("link", { name: "Manage on Home" })).toBeVisible();
      expectSettingsGeometry("reduced motion");
    } finally {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
    }
  });
});
