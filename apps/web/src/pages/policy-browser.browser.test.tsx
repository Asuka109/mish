import { TooltipProvider } from "@mish/ui";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppRoutes } from "../app";
import { AppearanceProvider } from "../appearance";
import { FixtureStatusClient } from "../data/fixture-status-client";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import type { Locales } from "../i18n/i18n-types";
import "../styles.css";

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeAll(() => loadAllLocales());

afterEach(() => {
  root?.unmount();
  container?.remove();
  root = null;
  container = null;
  document.documentElement.removeAttribute("style");
  delete document.documentElement.dataset.runtime;
});

function renderPolicyWorkspace(
  route: string,
  locale: Locales = "en",
  appearance: "light" | "dark" = "light",
  surface: "material" | "opaque" = "material",
) {
  document.documentElement.dataset.runtime = "browser";
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  root.render(
    <AppearanceProvider
      initialPreference={appearance}
      initialWindowSurfacePreference={surface}
      nativeSidebarMaterialSupported
    >
      <TypesafeI18n locale={locale}>
        <MemoryRouter initialEntries={[route]}>
          <ProductProvider client={new FixtureStatusClient()}>
            <TooltipProvider>
              <AppRoutes />
            </TooltipProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
}

describe("unified policy browser", () => {
  test("keeps compact Status information and the focused picker operable at 800x600", async () => {
    await page.viewport(800, 600);
    renderPolicyWorkspace("/status", "en", "light", "opaque");
    await expect.element(page.getByRole("heading", { name: "Status" })).toBeInTheDocument();

    await vi.waitFor(() => {
      expect(
        document.querySelectorAll(".policy-group-list .policy-browser-group-summary").length,
      ).toBeGreaterThan(0);
    });
    const summaries = document.querySelectorAll<HTMLElement>(
      ".policy-group-list .policy-browser-group-summary",
    );
    expect(summaries[0]?.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
    expect(summaries[0]?.textContent).toMatch(/1.*🌐 Proxy.*🇭🇰 HKG-02.*38 ms.*11/s);

    const proxySummary = page.getByRole("button", { name: /🌐 Proxy/ });
    await userEvent.click(proxySummary);
    await expect.element(page.getByRole("dialog")).toBeVisible();
    await expect
      .element(page.getByRole("searchbox", { name: "Search available nodes" }))
      .toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Start Delay Test for 🌐 Proxy" }))
      .toBeVisible();
    const sort = page.getByRole("combobox", { name: "Sort children in 🌐 Proxy" });
    await expect.element(sort).toBeVisible();
    expect(document.querySelector(".policy-browser-sort-icon")).not.toBeNull();
    expect(document.querySelector(".policy-picker-dialog .policy-browser-browse")).toBeNull();
    expect(
      document.querySelector<HTMLElement>('[data-entity-id="auto-fast"] .ui-badge')?.textContent,
    ).toBe("Auto-select");
    expect(
      document.querySelector('[data-entity-id="auto-fast"] .policy-browser-selection'),
    ).toBeNull();
    expect(
      document.querySelector<HTMLElement>(".policy-picker-dialog")?.getBoundingClientRect().width,
    ).toBeLessThanOrEqual(560);
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    expect(document.documentElement.dataset.windowSurface).toBe("opaque");
  });

  test("keeps multiple Routes groups expanded with complete desktop tools", async () => {
    await page.viewport(800, 600);
    renderPolicyWorkspace("/routes", "en", "dark");
    await expect.element(page.getByRole("heading", { name: "Routes" })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "Expand 🌐 Proxy" }));
    await userEvent.click(page.getByRole("button", { name: "Expand 🎬 Streaming" }));
    await expect.element(page.getByRole("button", { name: "Collapse 🌐 Proxy" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Collapse 🎬 Streaming" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Start Delay Test for 🌐 Proxy" }))
      .toBeVisible();
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(document.documentElement.dataset.windowSurface).toBe("material");
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

  test.each([320, 390])(
    "uses the dedicated single-group route without horizontal overflow at %ipx",
    async (width) => {
      await page.viewport(width, 700);
      renderPolicyWorkspace("/routes", "zh");
      await expect.element(page.getByRole("heading", { name: "路由" })).toBeVisible();
      await vi.waitFor(() => {
        expect(document.querySelector(".route-group-desktop-toggle")).not.toBeNull();
      });
      expect(
        getComputedStyle(document.querySelector<HTMLElement>(".route-group-desktop-toggle")!)
          .display,
      ).toBe("none");

      await userEvent.click(page.getByRole("link", { name: "浏览 🌐 Proxy" }));
      await expect.element(page.getByRole("heading", { name: "🌐 Proxy" })).toBeVisible();
      await expect
        .element(page.getByRole("searchbox", { name: "搜索 🌐 Proxy 的直接子项" }))
        .toBeVisible();
      const targets = document.querySelectorAll<HTMLElement>(
        ".routes-single-group .policy-browser-entity-primary, .routes-single-group .policy-browser-browse",
      );
      expect(targets.length).toBeGreaterThan(0);
      expect(
        Math.min(...[...targets].map((target) => target.getBoundingClientRect().height)),
      ).toBeGreaterThanOrEqual(44);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    },
  );
});
