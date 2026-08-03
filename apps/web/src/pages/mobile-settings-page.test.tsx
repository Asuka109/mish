import type { MobileVpnSnapshotDto, SettingsSnapshotDto } from "@mish/contracts";
import type { ReactNode } from "react";
import { AppearanceProvider } from "../appearance";
import { SettingsProvider, useSettings } from "../data/settings-provider";
import { createFixtureSettingsSnapshot } from "../data/fixture-settings-client";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import {
  MobileSettingsClient,
  type MobileSettingsTransport,
} from "../platform/mobile-settings-client";
import type { MobileVpnClient } from "../platform/mobile-vpn-client";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it, vi } from "vitest";
import { MobileSettingsDetailPage, MobileSettingsPage } from "./mobile-settings-page";

loadAllLocales();

const vpnSnapshot: MobileVpnSnapshotDto = {
  activationSessionId: null,
  activeNetwork: false,
  authorityId: "mobile-settings-authority",
  backendKind: "fixture",
  contractVersion: 1,
  coreAbiVersion: null,
  coreAvailability: "unavailable",
  coreCommit: null,
  configFailureInjectionAvailable: false,
  coreConfigState: "unloaded",
  coreRunning: false,
  coreVersion: null,
  coreWrapperRevision: null,
  dnsApplied: false,
  failure: null,
  foreground: false,
  loadedConfigDigest: null,
  loadedConfigRevision: null,
  message: "Android lifecycle is stopped safely.",
  notificationPermission: "required",
  operation: null,
  permission: "required",
  phase: "permission-required",
  protectedSocketCount: 0,
  publicRequestObserved: false,
  revision: 1,
  routesApplied: false,
  sequence: 1,
  sessionId: "mobile-settings-session",
  tunAvailability: "unavailable",
  tunEstablished: false,
  updatedAtMillis: 1,
  validatedConfigDigest: null,
  validatedConfigRevision: null,
  vpnActive: false,
  vpnAvailability: "unavailable",
};

const vpnClient: MobileVpnClient = {
  dispose() {},
  getSnapshot: () => vpnSnapshot,
  initialize: async () => vpnSnapshot,
  loadConfig: async (_bytes, identity) => ({
    cancellation: "not-requested",
    contractVersion: 1,
    digest: identity.digest,
    failure: "core-unavailable",
    message: "The packaged Mobile Core is unavailable.",
    operationId: "mobile-settings-load",
    outcome: "failed",
    revision: identity.revision,
    rollback: "unloaded",
    snapshot: vpnSnapshot,
    timing: "on-time",
  }),
  requestNotificationPermission: async () => vpnSnapshot,
  requestVpnConsent: async () => vpnSnapshot,
  start: async () => vpnSnapshot,
  stop: async () => vpnSnapshot,
  subscribe: (listener) => {
    listener(vpnSnapshot);
    return () => undefined;
  },
  validateConfig: async () => ({
    contractVersion: 1,
    failure: "core-unavailable",
    message: "The packaged Mobile Core is unavailable.",
    outcome: "failed",
    sequence: vpnSnapshot.sequence,
    sessionId: vpnSnapshot.sessionId,
  }),
};

function nativeSettingsSnapshot(): SettingsSnapshotDto {
  return { ...createFixtureSettingsSnapshot(), adapterKind: "native" };
}

function createSettingsClient(transport: MobileSettingsTransport) {
  return new MobileSettingsClient(transport);
}

function SettingsAppearanceProvider({
  children,
  initialPreference,
}: {
  children: ReactNode;
  initialPreference: SettingsSnapshotDto["preferences"]["appearance"];
}) {
  const settings = useSettings();
  return (
    <AppearanceProvider
      initialPreference={initialPreference}
      onPreferenceChange={settings.setAppearance}
    >
      {children}
    </AppearanceProvider>
  );
}

function renderSettings(path: string, transport: MobileSettingsTransport) {
  const client = createSettingsClient(transport);
  const initialSnapshot = nativeSettingsSnapshot();
  return render(
    <SettingsProvider client={client} initialSnapshot={initialSnapshot}>
      <SettingsAppearanceProvider initialPreference={initialSnapshot.preferences.appearance}>
        <TypesafeI18n locale="en">
          <MemoryRouter initialEntries={[path]}>
            <Routes>
              <Route
                element={<MobileSettingsPage initialSnapshot={vpnSnapshot} vpnClient={vpnClient} />}
                path="/settings"
              />
              <Route
                element={
                  <MobileSettingsDetailPage initialSnapshot={vpnSnapshot} vpnClient={vpnClient} />
                }
                path="/settings/:section"
              />
            </Routes>
          </MemoryRouter>
        </TypesafeI18n>
      </SettingsAppearanceProvider>
    </SettingsProvider>,
  );
}

describe("mobile Settings composition", () => {
  it("uses a dedicated grouped category list and omits desktop-only controls", () => {
    const transport = { invoke: vi.fn(async () => nativeSettingsSnapshot()) };
    const view = renderSettings("/settings", transport);

    expect(screen.getByRole("heading", { name: "Android settings" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Application/ })).toHaveAttribute(
      "href",
      "/settings/application",
    );
    expect(screen.getByRole("link", { name: "VPN" })).toHaveAttribute("href", "/settings/vpn");
    expect(screen.getByRole("link", { name: /Network and DNS/ })).toHaveAttribute(
      "href",
      "/settings/network",
    );
    expect(screen.getByRole("link", { name: /Privacy/ })).toHaveAttribute(
      "href",
      "/settings/privacy",
    );
    expect(screen.getByRole("link", { name: /Updates/ })).toHaveAttribute(
      "href",
      "/settings/updates",
    );
    expect(screen.getByRole("link", { name: /Diagnostics/ })).toHaveAttribute(
      "href",
      "/settings/diagnostics",
    );
    expect(screen.getByRole("link", { name: /Recovery/ })).toHaveAttribute(
      "href",
      "/settings/recovery",
    );
    expect(view.container.querySelector(".mobile-settings-page")).not.toBeNull();
    expect(view.container.querySelector(".settings-page")).toBeNull();
    expect(screen.queryByText("System Proxy")).not.toBeInTheDocument();
    expect(screen.queryByText("Window surface")).not.toBeInTheDocument();
  });

  it("sends portable language changes to the native Rust Settings transport", async () => {
    const snapshot = nativeSettingsSnapshot();
    const transport = {
      invoke: vi.fn(async (command: string, args?: Record<string, unknown>) => {
        if (command === "mobile_settings_set_language") {
          const request = args?.request as { language: "en" | "zh-CN" } | undefined;
          return {
            ...snapshot,
            preferences: { ...snapshot.preferences, language: request?.language ?? "en" },
            revision: 2,
          };
        }
        return snapshot;
      }),
    };
    const user = userEvent.setup();
    renderSettings("/settings/application", transport);

    await user.click(screen.getByRole("button", { name: "简体中文" }));

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith("mobile_settings_set_language", {
        request: { language: "zh-CN" },
      }),
    );
  });

  it("rolls back an optimistic appearance affordance after a native rejection", async () => {
    const snapshot = nativeSettingsSnapshot();
    const transport = {
      invoke: vi.fn(async (command: string) => {
        if (command === "mobile_settings_set_appearance") {
          throw new Error("native persistence rejected the change");
        }
        return snapshot;
      }),
    };
    const user = userEvent.setup();
    renderSettings("/settings/application", transport);

    await user.click(screen.getByRole("button", { name: "Dark" }));

    await waitFor(() =>
      expect(transport.invoke).toHaveBeenCalledWith("mobile_settings_set_appearance", {
        request: { appearance: "dark" },
      }),
    );
    await waitFor(() =>
      expect(
        screen.getByText("The setting was not confirmed. The last confirmed value remains in use."),
      ).toBeVisible(),
    );
    expect(screen.getByRole("button", { name: "Dark" })).toHaveAttribute("aria-pressed", "false");
  });

  it("projects Android VPN facts without offering a second lifecycle command", () => {
    const transport = { invoke: vi.fn(async () => nativeSettingsSnapshot()) };
    renderSettings("/settings/network", transport);

    expect(screen.getByText("Underlying network")).toBeVisible();
    expect(screen.getByText("VPN routes")).toBeVisible();
    expect(screen.getByText("VPN DNS policy")).toBeVisible();
    expect(screen.getByText("Public request")).toBeVisible();
    expect(screen.queryByRole("button", { name: /Start VPN|Stop VPN/ })).not.toBeInTheDocument();
  });
});
