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
  coreAbiVersion: null,
  coreAvailability: "unavailable" as const,
  coreCommit: null,
  coreVersion: null,
  coreWrapperRevision: null,
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

  it("excludes the desktop notification center and welcome invitation", () => {
    const view = renderShell("/status");

    expect(view.container.querySelector(".notification-trigger")).toBeNull();
    expect(screen.queryByRole("button", { name: /Notifications/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("dialog", { name: "Welcome to Mish" })).not.toBeInTheDocument();
  });

  it("selects Activity and its Rules child from a desktop-compatible deep link", () => {
    renderShell("/traffic?tab=rules");

    expect(screen.getByRole("link", { name: "Activity" })).toHaveClass("is-active");
    expect(screen.getByRole("link", { name: "Rules" })).toHaveClass("is-active");
  });

  it("shows verified packaged Core identity without claiming a running VPN", () => {
    render(
      <TypesafeI18n locale="en">
        <MemoryRouter initialEntries={["/status"]}>
          <Routes>
            <Route
              element={
                <MobileShell
                  fixture={fixture}
                  vpnClient={vpnClient}
                  vpnSnapshot={{
                    ...vpnSnapshot,
                    coreAbiVersion: 1,
                    coreAvailability: "available",
                    coreCommit: "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb",
                    coreVersion: "v1.19.29",
                    coreWrapperRevision: "mish-mobile-core-v1",
                  }}
                />
              }
            >
              <Route element={<div>Route content</div>} path="*" />
            </Route>
          </Routes>
        </MemoryRouter>
      </TypesafeI18n>,
    );

    expect(
      screen.getByText("Mihomo v1.19.29 is packaged; VPN traffic capture is not connected yet."),
    ).toBeVisible();
  });
});
