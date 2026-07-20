import { MobileFixtureBootstrapSchema } from "@mish/contracts";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { MobileShell } from "./mobile-shell";
import type { MobileVpnClient } from "../platform/mobile-vpn-client";

loadAllLocales();

const fixture = MobileFixtureBootstrapSchema.parse({
  adapterKind: "native",
  contractVersion: 1,
  core: { availability: "unavailable", kind: "fixture" },
  message: "Native fixture connected. VPN and embedded Core are not implemented.",
  platform: "android",
  targetAbis: ["arm64-v8a", "x86_64"],
  vpn: { availability: "unavailable", kind: "fixture" },
});

const vpnSnapshot = {
  backendKind: "fixture" as const,
  contractVersion: 1 as const,
  coreAvailability: "unavailable" as const,
  foreground: false,
  message: "Fixture only. No TUN or Core is available.",
  notificationPermission: "required" as const,
  permission: "required" as const,
  phase: "permission-required" as const,
  sequence: 1,
  sessionId: "session-1",
  updatedAtMillis: 1,
  vpnActive: false as const,
};

const vpnClient: MobileVpnClient = {
  dispose: () => undefined,
  getSnapshot: () => vpnSnapshot,
  initialize: async () => vpnSnapshot,
  requestNotificationPermission: async () => vpnSnapshot,
  requestVpnConsent: async () => vpnSnapshot,
  startFixtureLifecycle: async () => vpnSnapshot,
  stop: async () => vpnSnapshot,
  subscribe: () => () => undefined,
};

function renderShell(path: string) {
  return render(
    <TypesafeI18n locale="en">
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route
            element={
              <MobileShell fixture={fixture} vpnClient={vpnClient} vpnSnapshot={vpnSnapshot} />
            }
          >
            <Route element={<div>Route content</div>} path="*" />
          </Route>
        </Routes>
      </MemoryRouter>
    </TypesafeI18n>,
  );
}

describe("MobileShell", () => {
  it("renders five labeled destinations without the desktop sidebar", () => {
    const view = renderShell("/status");
    const navigation = screen.getByRole("navigation", { name: "Mobile navigation" });

    expect(within(navigation).getAllByRole("link")).toHaveLength(5);
    expect(within(navigation).getByRole("link", { name: "Home" })).toHaveClass("is-active");
    expect(view.container.querySelector(".sidebar")).toBeNull();
    expect(
      screen.getByText("VPN and embedded Core are not implemented in this test build."),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Review VPN permission" })).toBeVisible();
  });

  it("selects Activity and its Rules child from a desktop-compatible deep link", () => {
    renderShell("/traffic?tab=rules");

    expect(screen.getByRole("link", { name: "Activity" })).toHaveClass("is-active");
    expect(screen.getByRole("link", { name: "Rules" })).toHaveClass("is-active");
  });
});
