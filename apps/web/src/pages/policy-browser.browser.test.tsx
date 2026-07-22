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
    const policyProgress = document.querySelector<HTMLElement>(
      ".policy-picker-dialog .policy-browser-progress",
    );
    expect(policyProgress?.textContent).toBe("https://www.gstatic.com/generate_204");
    expect(policyProgress?.textContent).not.toContain("fixture-only");
    const sort = page.getByRole("combobox", { name: "Sort children in 🌐 Proxy" });
    await expect.element(sort).toBeVisible();
    expect(document.querySelector(".policy-browser-sort-icon")).not.toBeNull();
    await userEvent.click(sort);
    await expect.element(page.getByRole("option", { name: "Latency" })).toBeVisible();
    const sortPositioner = document.querySelector<HTMLElement>(".ui-select-positioner");
    const dialog = document.querySelector<HTMLElement>(".policy-picker-dialog");
    if (!sortPositioner || !dialog) throw new Error("Missing picker sort overlay");
    expect(Number(getComputedStyle(sortPositioner).zIndex)).toBeGreaterThan(
      Number(getComputedStyle(dialog).zIndex),
    );
    await userEvent.keyboard("{Escape}");
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

  test("opens the shared node browser from the unified Routes collection card", async () => {
    await page.viewport(800, 600);
    renderPolicyWorkspace("/routes", "en", "dark");
    await expect.element(page.getByRole("heading", { name: "Routes" })).toBeVisible();

    const graph = document.querySelector<HTMLElement>(".routes-graph");
    const groupList = graph?.querySelector<HTMLElement>(":scope > .route-root-list");
    const groupCards = groupList?.querySelectorAll<HTMLElement>(":scope > li > .route-group");
    if (!graph || !groupList || !groupCards) throw new Error("Missing Routes collection card");
    expect(getComputedStyle(graph).borderTopWidth).toBe("1px");
    expect(getComputedStyle(graph).overflow).toBe("hidden");
    expect(groupCards.length).toBeGreaterThan(1);
    const groupItems = [...groupList.children] as HTMLElement[];
    expect(groupItems[1]!.getBoundingClientRect().top).toBeCloseTo(
      groupItems[0]!.getBoundingClientRect().bottom,
      0,
    );
    groupCards.forEach((groupCard) => {
      expect(getComputedStyle(groupCard).borderTopWidth).toBe("0px");
      expect(getComputedStyle(groupCard).borderRadius).toBe("0px");
    });
    expect(graph.querySelectorAll(".route-group-body")).toHaveLength(0);
    await userEvent.click(page.getByRole("button", { name: "Browse 🌐 Proxy" }));
    await expect.element(page.getByRole("dialog", { name: "🌐 Proxy" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Start Delay Test for 🌐 Proxy" }))
      .toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Close" }));
    const automaticGroup = page.getByRole("button", { name: "Browse ⚡ 自动选择・Auto" });
    await expect.element(automaticGroup).toBeEnabled();
    await userEvent.click(automaticGroup);
    await expect.element(page.getByRole("dialog", { name: "⚡ 自动选择・Auto" })).toBeVisible();
    expect(document.querySelector('.policy-picker-dialog [aria-label^="Select "]')).toBeNull();
    expect(
      document.querySelector(".policy-picker-dialog .policy-browser-entity-row--read-only"),
    ).toBeNull();
    expect(document.querySelector(".policy-picker-dialog")?.textContent).not.toContain("Read-only");
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
        expect(document.querySelector(".route-group-desktop-open")).not.toBeNull();
      });
      expect(
        getComputedStyle(document.querySelector<HTMLElement>(".route-group-desktop-open")!).display,
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
