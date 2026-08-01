import { MobileFixtureBootstrapSchema } from "@mish/contracts";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { MobileShell } from "./mobile-shell";

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

function renderShell(path: string) {
  return render(
    <TypesafeI18n locale="en">
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route element={<MobileShell fixture={fixture} />}>
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
    expect(within(navigation).getByRole("link", { name: "Home" })).toHaveAttribute(
      "aria-current",
      "page",
    );
    expect(view.container.querySelector(".sidebar")).toBeNull();
    expect(view.container.querySelector(".mobile-fixture-banner")).toBeNull();
    expect(screen.getByText("Route content")).toBeVisible();
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
    expect(screen.getByRole("link", { name: "Activity" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Rules" })).toHaveAttribute("aria-current", "page");
  });

  it("keeps Routes active and exposes the progressive back targets for group and child links", () => {
    const group = renderShell("/routes/proxy");

    expect(screen.getByRole("link", { name: "Routes" })).toHaveClass("is-active");
    expect(screen.getByRole("link", { name: "Routes" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/routes");

    group.unmount();
    renderShell("/routes/proxy/children/nrt-03");

    expect(screen.getByRole("link", { name: "Back" })).toHaveAttribute("href", "/routes/proxy");
    expect(screen.getByRole("link", { name: "Routes" })).toHaveAttribute("aria-current", "page");
  });
});
