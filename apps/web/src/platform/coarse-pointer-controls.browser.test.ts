import { page, userEvent } from "vitest/browser";
import { beforeAll, describe, expect, test, vi } from "vitest";

const expectsCoarsePointer = import.meta.env.VITE_MISH_TEST_COARSE_POINTER === "true";

interface ControlGeometry {
  height: number;
  label: string;
  rect: DOMRect;
  width: number;
}

function geometry(element: HTMLElement): ControlGeometry {
  const rect = element.getBoundingClientRect();
  return {
    height: Math.round(rect.height * 100) / 100,
    label: (element.getAttribute("aria-label") || element.textContent || "unnamed").trim(),
    rect,
    width: Math.round(rect.width * 100) / 100,
  };
}

function expectNoTargetOverlap(elements: HTMLElement[], context: string) {
  for (const [index, element] of elements.entries()) {
    const current = geometry(element);
    for (const sibling of elements.slice(index + 1)) {
      const candidate = geometry(sibling);
      const overlapWidth =
        Math.min(current.rect.right, candidate.rect.right) -
        Math.max(current.rect.left, candidate.rect.left);
      const overlapHeight =
        Math.min(current.rect.bottom, candidate.rect.bottom) -
        Math.max(current.rect.top, candidate.rect.top);
      expect(
        overlapWidth > 0.5 && overlapHeight > 0.5,
        `${context}: ${current.label} overlaps ${candidate.label}`,
      ).toBe(false);
    }
  }
}

function expectViewportContainment(context: string) {
  const scroller = document.querySelector<HTMLElement>(".workspace-page-scroll");
  if (!scroller) throw new Error(`${context}: missing workspace scroller`);

  expect(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    `${context}: document overflow`,
  ).toBeLessThanOrEqual(1);
  expect(
    scroller.scrollWidth - scroller.clientWidth,
    `${context}: page overflow`,
  ).toBeLessThanOrEqual(1);

  for (const control of document.querySelectorAll<HTMLElement>(
    '.toolbar-actions button, .status-primary-control button, [data-capture-unavailable-trigger="true"]',
  )) {
    const rect = control.getBoundingClientRect();
    expect(rect.left, `${context}: ${geometry(control).label} left edge`).toBeGreaterThanOrEqual(
      -0.5,
    );
    expect(rect.right, `${context}: ${geometry(control).label} right edge`).toBeLessThanOrEqual(
      window.innerWidth + 0.5,
    );
  }
}

async function navigate(path: string) {
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
  await vi.waitFor(() => {
    expect(window.location.pathname).toBe(path);
    expect(document.querySelector(".nav-item.is-active")?.getAttribute("href")).toBe(path);
    expect(document.querySelector("main .route-loading")).toBeNull();
  });
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function selectLocale(name: "English" | "简体中文") {
  const trigger = document.querySelector<HTMLElement>(".language-menu-trigger");
  if (!trigger) throw new Error("Missing language trigger");
  await page.elementLocator(trigger).click();
  await page.getByRole("menuitemradio", { exact: true, name }).click();
  await vi.waitFor(() => expect(trigger.getAttribute("aria-expanded")).not.toBe("true"));
}

beforeAll(async () => {
  document.body.innerHTML = '<div id="root"></div>';
  await import("../main");
  await vi.waitFor(() => expect(document.querySelector(".app-shell")).not.toBeNull(), {
    timeout: 10_000,
  });
});

describe("input-aware shared controls", () => {
  test("preserves fine-pointer density and expands coarse-pointer interaction geometry", async () => {
    expect(matchMedia("(pointer: coarse)").matches).toBe(expectsCoarsePointer);
    expect(matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(expectsCoarsePointer);

    for (const viewport of [
      { height: 844, label: "390px representative", width: 390 },
      { height: 568, label: "320px reflow", width: 320 },
    ]) {
      await page.viewport(viewport.width, viewport.height);

      for (const variant of [
        { locale: "English", theme: "light" },
        { locale: "简体中文", theme: "dark" },
      ] as const) {
        document.documentElement.dataset.theme = variant.theme;
        await selectLocale(variant.locale);
        await navigate("/status");
        const context = `${expectsCoarsePointer ? "coarse" : "fine"}, ${viewport.label}, ${variant.locale}, ${variant.theme}`;

        const toolbar = [...document.querySelectorAll<HTMLElement>(".toolbar-actions button")];
        const routing = [
          ...document.querySelectorAll<HTMLElement>(
            ".status-primary-control .ui-toggle-group-item",
          ),
        ];
        const capture = [
          ...document.querySelectorAll<HTMLElement>(
            '.traffic-capture-stack > .inline-flex > button:not(:disabled), .traffic-capture-stack [data-capture-unavailable-trigger="true"]',
          ),
        ];
        const controls = [...toolbar, ...routing, ...capture];
        expect(toolbar).toHaveLength(4);
        expect(routing).toHaveLength(3);
        expect(capture.length).toBeGreaterThanOrEqual(2);

        for (const control of controls) {
          const measured = geometry(control);
          if (expectsCoarsePointer) {
            expect(measured.height, `${context}: ${measured.label} height`).toBeGreaterThanOrEqual(
              44,
            );
            expect(measured.width, `${context}: ${measured.label} width`).toBeGreaterThanOrEqual(
              44,
            );
          }
          expect(
            control.scrollWidth - control.clientWidth,
            `${context}: ${measured.label} clipped content`,
          ).toBeLessThanOrEqual(1);
        }

        if (!expectsCoarsePointer) {
          for (const control of toolbar) {
            expect(geometry(control).height, `${context}: compact toolbar`).toBe(34);
          }
          for (const control of [...routing, ...capture]) {
            expect(geometry(control).height, `${context}: compact Status control`).toBe(30);
          }
        }

        expectNoTargetOverlap(toolbar, `${context}: toolbar`);
        expectNoTargetOverlap(routing, `${context}: routing`);
        expectNoTargetOverlap(capture, `${context}: capture`);
        expectViewportContainment(context);

        const profile = document.querySelector<HTMLElement>(".profile-select-trigger");
        const appearance = document.querySelector<HTMLElement>(".appearance-menu-trigger");
        const language = document.querySelector<HTMLElement>(".language-menu-trigger");
        const scroller = document.querySelector<HTMLElement>(".workspace-page-scroll");
        if (!profile || !appearance || !language || !scroller) {
          throw new Error(`${context}: missing representative controls`);
        }
        const appearanceIcon = appearance.querySelector<SVGElement>("svg");
        if (!appearanceIcon) throw new Error(`${context}: missing toolbar icon`);
        expect(getComputedStyle(appearanceIcon).width, `${context}: compact icon scale`).toBe(
          "15px",
        );
        expect(getComputedStyle(appearance).fontSize, `${context}: compact type scale`).toBe(
          "13px",
        );

        profile.focus();
        await userEvent.keyboard("{Tab}");
        expect(document.activeElement, `${context}: toolbar keyboard order`).toBe(appearance);
        await userEvent.keyboard("{Tab}");
        expect(document.activeElement, `${context}: language keyboard order`).toBe(language);
        await userEvent.keyboard("{Enter}");
        const menuItems = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')];
        expect(menuItems).toHaveLength(2);
        for (const item of menuItems) {
          const measured = geometry(item);
          expect(measured.height, `${context}: ${measured.label} menu row`).toBeGreaterThanOrEqual(
            expectsCoarsePointer ? 44 : 34,
          );
        }
        await userEvent.keyboard("{Escape}");
        expect(document.activeElement, `${context}: menu focus restoration`).toBe(language);

        const initialScrollTop = scroller.scrollTop;
        await page.elementLocator(scroller).wheel({ delta: { y: 240 } });
        await vi.waitFor(() =>
          expect(scroller.scrollTop, `${context}: page scrolling`).toBeGreaterThan(
            initialScrollTop,
          ),
        );
      }
    }
  });
});
