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
    expect(view.container.querySelector(".sidebar")).toBeNull();
    expect(
      screen.getByText("VPN and embedded Core are not implemented in this test build."),
    ).toBeVisible();
  });

  it("selects Activity and its Rules child from a desktop-compatible deep link", () => {
    renderShell("/traffic?tab=rules");

    expect(screen.getByRole("link", { name: "Activity" })).toHaveClass("is-active");
    expect(screen.getByRole("link", { name: "Rules" })).toHaveClass("is-active");
  });
});
