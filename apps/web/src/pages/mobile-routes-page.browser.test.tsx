import type { MobileFixtureBootstrapDto } from "@mish/contracts";
import { TooltipProvider } from "@mish/ui";
import { cdp, page, userEvent } from "vitest/browser";
import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes } from "react-router";
import { AppearanceProvider } from "../appearance";
import { MobileShell } from "../components/mobile-shell";
import { FixtureStatusClient } from "../data/fixture-status-client";
import { NotificationDeliveryProvider } from "../data/notification-delivery";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import type { Locales } from "../i18n/i18n-types";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { MobileRouteChildPage, MobileRouteGroupPage, MobileRoutesPage } from "./mobile-routes-page";
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
  core: { availability: "unavailable", kind: "fixture" },
  message: "Native fixture connected.",
  platform: "android",
  targetAbis: ["arm64-v8a", "x86_64"],
  vpn: { availability: "unavailable", kind: "fixture" },
};

const viewports: readonly MobileViewport[] = [
  { height: 568, locale: "en", name: "compact portrait", theme: "light", width: 320 },
  { height: 800, locale: "zh", name: "common portrait", theme: "dark", width: 360 },
  { height: 915, locale: "en", name: "large portrait", theme: "dark", width: 412 },
  { height: 360, locale: "zh", name: "compact landscape", theme: "light", width: 640 },
  { height: 412, locale: "en", name: "common landscape", theme: "light", width: 915 },
];

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

function renderMobileRoutes(
  route: string,
  locale: Locales = "en",
  theme: "dark" | "light" = "light",
  client: FixtureStatusClient = new FixtureStatusClient(),
) {
  document.documentElement.dataset.runtime = "mobile";
  container = document.createElement("div");
  container.style.height = "100vh";
  document.body.append(container);
  root = createRoot(container);
  root.render(
    <AppearanceProvider initialPreference={theme}>
      <TypesafeI18n locale={locale}>
        <MemoryRouter initialEntries={[route]}>
          <ProductProvider client={client}>
            <NotificationDeliveryProvider>
              <TooltipProvider>
                <Routes>
                  <Route element={<MobileShell fixture={fixture} />}>
                    <Route element={<MobileRoutesPage />} path="routes" />
                    <Route element={<MobileRouteGroupPage />} path="routes/:groupId" />
                    <Route
                      element={<MobileRouteChildPage />}
                      path="routes/:groupId/children/:childId"
                    />
                  </Route>
                </Routes>
              </TooltipProvider>
            </NotificationDeliveryProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function waitForRoute(selector: string) {
  await vi.waitFor(() => expect(document.querySelector(selector)).not.toBeNull());
  await nextFrame();
}

function expectMobileRouteGeometry(context: string) {
  const scroller = document.querySelector<HTMLElement>(".mobile-route-scroller");
  const bottomNavigation = document.querySelector<HTMLElement>(".mobile-bottom-navigation");
  if (!scroller || !bottomNavigation) throw new Error(`${context}: missing mobile Routes shell`);

  expect(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    `${context}: document overflow`,
  ).toBeLessThanOrEqual(1);
  expect(
    scroller.scrollWidth - scroller.clientWidth,
    `${context}: route overflow`,
  ).toBeLessThanOrEqual(1);
  expect(bottomNavigation.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    window.innerHeight + 0.5,
  );

  const controls = [
    ...document.querySelectorAll<HTMLElement>(
      ".mobile-routes-list a, .mobile-policy-browser-toolbar input.ui-input, .policy-browser-sort, .mobile-policy-browser-toolbar-actions > button, [data-policy-row-primary], .policy-browser-browse, .policy-browser-show-more, .mobile-top-app-bar-back, .mobile-destination",
    ),
  ].filter((element) => {
    const rect = element.getBoundingClientRect();
    return rect.height > 0 && rect.width > 0;
  });
  if (controls.length === 0) throw new Error(`${context}: missing touch controls`);

  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    const identity = [
      control.tagName.toLowerCase(),
      control.className,
      control.getAttribute("aria-label") ?? control.textContent?.trim(),
    ]
      .filter(Boolean)
      .join(" ");
    expect(rect.height, `${context}: ${identity} touch height`).toBeGreaterThanOrEqual(44);
    expect(rect.width, `${context}: ${identity} touch width`).toBeGreaterThanOrEqual(44);
    expect(rect.left, `${context}: ${identity} inside left`).toBeGreaterThanOrEqual(-0.5);
    expect(rect.right, `${context}: ${identity} inside right`).toBeLessThanOrEqual(
      window.innerWidth + 0.5,
    );
  }
}

describe("Android mobile Routes geometry", () => {
  test.each(viewports)("keeps $name usable in $locale $theme", async (viewport) => {
    await page.viewport(viewport.width, viewport.height);
    renderMobileRoutes("/routes", viewport.locale, viewport.theme);
    await waitForRoute(".mobile-routes-list");

    expect(document.querySelector(".routes-page")).toBeNull();
    expect(document.documentElement.dataset.theme).toBe(viewport.theme);
    expectMobileRouteGeometry(`${viewport.locale} ${viewport.theme} ${viewport.name}`);
  });

  test("keeps the group scroller usable when the software keyboard reduces height", async () => {
    await page.viewport(360, 420);
    renderMobileRoutes("/routes/proxy", "zh");
    await waitForRoute(".mobile-policy-browser-toolbar");

    const scroller = document.querySelector<HTMLElement>(".mobile-route-scroller");
    const search = document.querySelector<HTMLInputElement>(".mobile-policy-browser-toolbar input");
    if (!scroller || !search) throw new Error("Missing mobile group scroller or search");
    search.focus();
    expect(document.activeElement).toBe(search);
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    expect(getComputedStyle(scroller).overflowY).toBe("auto");
    expectMobileRouteGeometry("software keyboard viewport");
  });

  test("supports enlarged text without horizontal clipping", async () => {
    await page.viewport(320, 568);
    document.documentElement.style.setProperty("--mish-typography-title-font-size", "30px");
    document.documentElement.style.setProperty("--mish-typography-body-font-size", "20px");
    document.documentElement.style.setProperty("--mish-typography-metadata-font-size", "18px");
    document.documentElement.style.setProperty("--mish-typography-label-small-font-size", "16px");

    renderMobileRoutes("/routes/proxy", "zh", "dark");
    await waitForRoute(".mobile-policy-browser-toolbar");
    expectMobileRouteGeometry("enlarged text");
    for (const row of document.querySelectorAll<HTMLElement>(".policy-browser-entity-row")) {
      expect(
        row.scrollWidth - row.clientWidth,
        row.textContent ?? "scaled route row",
      ).toBeLessThanOrEqual(1);
    }
  });

  test("progressively drills down, restores focus, and returns through mobile back controls", async () => {
    await page.viewport(360, 568);
    renderMobileRoutes("/routes");
    await waitForRoute(".mobile-routes-list");

    await userEvent.click(page.getByRole("link", { name: "Browse 🌐 Proxy" }));
    await vi.waitFor(() => {
      expect(document.querySelector("#mobile-routes-group-title")).toHaveTextContent("🌐 Proxy");
      expect(document.activeElement).toBe(document.querySelector(".mobile-top-app-bar h1"));
    });
    const groupScroller = document.querySelector<HTMLElement>(".mobile-route-scroller");
    if (!groupScroller) throw new Error("Missing mobile group scroller");
    groupScroller.scrollTop = 120;
    groupScroller.dispatchEvent(new Event("scroll"));
    expect(groupScroller.scrollTop).toBeGreaterThan(0);

    await userEvent.click(page.getByRole("link", { name: "View Details for 🇯🇵 NRT-03" }));
    await vi.waitFor(() => {
      expect(document.querySelector("#mobile-routes-child-title")).toHaveTextContent("🇯🇵 NRT-03");
      expect(document.activeElement).toBe(document.querySelector(".mobile-top-app-bar h1"));
    });
    await userEvent.click(page.getByRole("link", { exact: true, name: "Back" }));
    await vi.waitFor(() => {
      expect(document.querySelector("#mobile-routes-group-title")).toHaveTextContent("🌐 Proxy");
      expect(document.activeElement).toBe(document.querySelector(".mobile-top-app-bar h1"));
      expect(
        document.querySelector<HTMLElement>(".mobile-route-scroller")?.scrollTop,
      ).toBeGreaterThan(0);
    });
    await userEvent.click(page.getByRole("link", { exact: true, name: "Back" }));
    await vi.waitFor(() => expect(document.querySelector(".mobile-routes-list")).not.toBeNull());
  });

  test("bounds a large group and announces the next page without losing touch geometry", async () => {
    await page.viewport(360, 800);
    renderMobileRoutes("/routes/large-fixture");
    await waitForRoute(".policy-browser-entity-list");

    expect(document.querySelectorAll(".policy-browser-entity-list > li")).toHaveLength(100);
    await userEvent.click(page.getByRole("button", { name: "Show 60 More" }));
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".policy-browser-entity-list > li")).toHaveLength(160),
    );
    expectMobileRouteGeometry("large route group");
  });

  test("honors reduced motion while keeping the current Routes controls available", async () => {
    const session = (await cdp()) as unknown as EmulationSession;
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    try {
      await page.viewport(360, 800);
      renderMobileRoutes("/routes/proxy");
      await waitForRoute(".mobile-policy-browser-toolbar");
      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      expect(
        page.getByRole("searchbox", { name: "Search direct children of 🌐 Proxy" }),
      ).toBeVisible();
      expectMobileRouteGeometry("reduced motion");
    } finally {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
    }
  });
});
