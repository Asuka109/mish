import { page, userEvent } from "vitest/browser";
import { beforeAll, describe, expect, test, vi } from "vitest";

const routes = ["/status", "/routes", "/profiles", "/traffic", "/events", "/settings"];

const viewports = [
  { height: 568, name: "compact mobile", width: 320 },
  { height: 844, name: "mobile", width: 390 },
  { height: 600, name: "Tauri minimum", width: 800 },
];

interface OverflowIssue {
  label: string;
  left: number;
  right: number;
}

interface LayoutMeasurement {
  documentOverflow: number;
  navigationCount: number;
  navigationLabelsClipped: string[];
  outsideControls: OverflowIssue[];
  pageOverflow: number;
  sidebarWidth: number;
  tableHasLocalScroll: boolean | null;
}

function hasLocalHorizontalScroller(element: Element): boolean {
  let ancestor = element.parentElement;

  while (ancestor && ancestor !== document.body) {
    const style = getComputedStyle(ancestor);
    const scrollsHorizontally = style.overflowX === "auto" || style.overflowX === "scroll";

    if (scrollsHorizontally && ancestor.scrollWidth > ancestor.clientWidth + 1) {
      return true;
    }

    ancestor = ancestor.parentElement;
  }

  return false;
}

function measureLayout(): LayoutMeasurement {
  const pageScroll = document.querySelector<HTMLElement>(".page-scroll");
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  const navigationItems = [...document.querySelectorAll<HTMLElement>(".nav-item")];
  const controls = [
    ...document.querySelectorAll<HTMLElement>(
      'a, button, input, select, textarea, [role="button"]',
    ),
  ];
  const tableContainer = document.querySelector<HTMLElement>(".traffic-table")?.parentElement;

  const outsideControls = controls
    .filter((element) => {
      const rect = element.getBoundingClientRect();

      if (rect.width <= 1 || rect.height <= 1) return false;
      if (rect.left >= -0.5 && rect.right <= window.innerWidth + 0.5) return false;

      return !hasLocalHorizontalScroller(element);
    })
    .map((element) => {
      const rect = element.getBoundingClientRect();

      return {
        label: (element.getAttribute("aria-label") || element.textContent || "")
          .trim()
          .replace(/\s+/g, " ")
          .slice(0, 80),
        left: Math.round(rect.left),
        right: Math.round(rect.right),
      };
    });

  const navigationLabelsClipped = navigationItems.flatMap((item) => {
    const label = item.querySelector<HTMLElement>("span");
    if (!label) return [item.getAttribute("aria-label") ?? "missing label"];

    const itemRect = item.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    const clipped =
      getComputedStyle(label).display === "none" ||
      labelRect.left < itemRect.left - 0.5 ||
      labelRect.right > itemRect.right + 0.5;

    return clipped ? [item.getAttribute("aria-label") ?? label.textContent ?? ""] : [];
  });

  return {
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    navigationCount: navigationItems.length,
    navigationLabelsClipped,
    outsideControls,
    pageOverflow: pageScroll ? pageScroll.scrollWidth - pageScroll.clientWidth : Number.NaN,
    sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : Number.NaN,
    tableHasLocalScroll: tableContainer
      ? (getComputedStyle(tableContainer).overflowX === "auto" ||
          getComputedStyle(tableContainer).overflowX === "scroll") &&
        tableContainer.scrollWidth > tableContainer.clientWidth + 1
      : null,
  };
}

async function navigate(path: string): Promise<void> {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));

  await vi.waitFor(() => {
    expect(window.location.pathname).toBe(path);
    expect(document.querySelector("main .page-scroll")).not.toBeNull();
    expect(document.querySelector("main .route-loading")).toBeNull();
    expect(document.querySelector(".nav-item.is-active")?.getAttribute("href")).toBe(path);

    if (path === "/traffic") {
      expect(document.querySelector(".traffic-table")).not.toBeNull();
    }
  });

  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function selectLocale(name: "English" | "简体中文"): Promise<void> {
  const trigger = document.querySelector(".language-menu-trigger");
  expect(trigger).not.toBeNull();

  await page.elementLocator(trigger as Element).click();
  await page.getByRole("menuitemradio", { exact: true, name }).click();

  await vi.waitFor(() => {
    const currentTrigger = document.querySelector(".language-menu-trigger");
    expect(currentTrigger?.getAttribute("aria-expanded")).not.toBe("true");
  });
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await import("../main");

  await vi.waitFor(
    () => {
      expect(document.querySelector(".app-shell")).not.toBeNull();
    },
    { timeout: 10_000 },
  );
});

describe("responsive application shell", () => {
  test("opens the service Manage menu with pointer and keyboard input", async () => {
    await page.viewport(800, 600);
    await selectLocale("English");
    await navigate("/status");

    const trigger = page.getByRole("button", { exact: true, name: "Manage" });
    await trigger.click();
    await expect.element(page.getByRole("menuitem", { name: "Edit services…" })).toBeVisible();
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard("{Escape}");
    await expect.element(trigger).not.toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("menuitem", { name: "Edit services…" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(trigger).not.toHaveAttribute("aria-expanded", "true");
  });

  test("keeps every primary route within mobile, web, and Tauri viewports", async () => {
    for (const viewport of viewports) {
      await page.viewport(viewport.width, viewport.height);

      for (const locale of ["English", "简体中文"] as const) {
        await selectLocale(locale);

        for (const path of routes) {
          await navigate(path);
          const measurement = measureLayout();
          const context = `${viewport.name} ${viewport.width}x${viewport.height}, ${locale}, ${path}`;

          expect(measurement.documentOverflow, `${context}: document overflow`).toBeLessThanOrEqual(
            1,
          );
          expect(measurement.pageOverflow, `${context}: page overflow`).toBeLessThanOrEqual(1);
          expect(measurement.navigationCount, `${context}: primary navigation items`).toBe(6);
          expect(
            measurement.navigationLabelsClipped,
            `${context}: clipped navigation labels`,
          ).toEqual([]);
          expect(measurement.outsideControls, `${context}: controls outside the viewport`).toEqual(
            [],
          );

          if (viewport.name === "Tauri minimum") {
            expect(measurement.sidebarWidth, `${context}: full desktop sidebar width`).toBe(164);
          }

          if (path === "/traffic") {
            expect(measurement.tableHasLocalScroll, `${context}: traffic table local scroll`).toBe(
              true,
            );
          }
        }
      }
    }
  });
});
