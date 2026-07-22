import { page } from "vitest/browser";
import { beforeAll, describe, expect, test, vi } from "vitest";

const desktopViewports = [
  { height: 720, name: "normal desktop", width: 1024 },
  { height: 600, name: "minimum desktop", width: 800 },
] as const;

const longSubtitle =
  "Deliberately overlong localized traffic activity copy that must truncate before reaching the action";

interface HeadingGeometry {
  action: DOMRect;
  chevron: DOMRect;
  subtitle: DOMRect;
  title: DOMRect;
}

function rectsOverlap(first: DOMRect, second: DOMRect): boolean {
  const tolerance = 0.5;
  return (
    first.left < second.right - tolerance &&
    first.right > second.left + tolerance &&
    first.top < second.bottom - tolerance &&
    first.bottom > second.top + tolerance
  );
}

function statusHeadings(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>("main h2")].flatMap((title) => {
    const heading = title.parentElement?.parentElement;
    return heading instanceof HTMLElement && heading.querySelector(":scope > a") ? [heading] : [];
  });
}

function measureHeading(heading: HTMLElement): HeadingGeometry {
  const title = heading.querySelector("h2");
  const subtitle = heading.querySelector("p");
  const action = heading.querySelector(":scope > a span");
  const chevron = heading.querySelector(":scope > a svg");

  if (!title || !subtitle || !action || !chevron) {
    throw new Error("Status section heading is missing a measurable copy or action segment");
  }

  return {
    action: action.getBoundingClientRect(),
    chevron: chevron.getBoundingClientRect(),
    subtitle: subtitle.getBoundingClientRect(),
    title: title.getBoundingClientRect(),
  };
}

function expectCollisionFree(heading: HTMLElement, context: string): void {
  const geometry = measureHeading(heading);
  const segments = Object.entries(geometry);

  for (const [name, rect] of segments) {
    expect(rect.width, `${context}: ${name} remains visible`).toBeGreaterThan(1);
    expect(rect.height, `${context}: ${name} retains height`).toBeGreaterThan(1);
  }

  for (let firstIndex = 0; firstIndex < segments.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < segments.length; secondIndex += 1) {
      const [firstName, firstRect] = segments[firstIndex];
      const [secondName, secondRect] = segments[secondIndex];
      expect(
        rectsOverlap(firstRect, secondRect),
        `${context}: ${firstName} overlaps ${secondName}`,
      ).toBe(false);
    }
  }

  const chevron = heading.querySelector<SVGElement>(":scope > a svg");
  expect(chevron, `${context}: chevron exists`).not.toBeNull();
  expect(
    getComputedStyle(chevron as SVGElement).flexShrink,
    `${context}: chevron does not shrink`,
  ).toBe("0");
}

async function nextFrame(): Promise<void> {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function navigateToStatus(): Promise<void> {
  window.history.pushState({}, "", "/status");
  window.dispatchEvent(new PopStateEvent("popstate"));

  await vi.waitFor(() => {
    expect(document.querySelector(".route-loading")).toBeNull();
    expect(statusHeadings()).toHaveLength(2);
  });
  await nextFrame();
}

async function selectLocale(name: "English" | "简体中文"): Promise<void> {
  const trigger = document.querySelector(".language-menu-trigger");
  if (!trigger) throw new Error("Missing language menu trigger");

  await page.elementLocator(trigger).click();
  await page.getByRole("menuitemradio", { exact: true, name }).click();
  await vi.waitFor(() => {
    expect(
      document.querySelector(".language-menu-trigger")?.getAttribute("aria-expanded"),
    ).not.toBe("true");
  });
  await nextFrame();
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
  await navigateToStatus();
});

describe("status section-heading containment", () => {
  test("keeps localized title, subtitle, action, and chevron collision-free at desktop widths", async () => {
    for (const viewport of desktopViewports) {
      await page.viewport(viewport.width, viewport.height);

      for (const locale of ["English", "简体中文"] as const) {
        await selectLocale(locale);

        for (const heading of statusHeadings()) {
          const title = heading.querySelector("h2")?.textContent?.trim() ?? "unknown heading";
          expectCollisionFree(heading, `${viewport.name} ${viewport.width}px, ${locale}, ${title}`);
        }

        const sessionSubtitle = statusHeadings()[0]?.querySelector<HTMLElement>("p");
        expect(sessionSubtitle, `${viewport.name}, ${locale}: session subtitle`).not.toBeNull();
        expect(sessionSubtitle?.title).toBe(sessionSubtitle?.textContent);
      }
    }
  });

  test("ellipsizes an overlong subtitle while preserving its full native advisory text", async () => {
    for (const viewport of desktopViewports) {
      await page.viewport(viewport.width, viewport.height);
      await selectLocale("English");

      const sessionHeading = statusHeadings()[0];
      const subtitle = sessionHeading?.querySelector<HTMLElement>("p");
      if (!sessionHeading || !subtitle) throw new Error("Missing Session section heading");

      const originalText = subtitle.textContent ?? "";
      const originalTitle = subtitle.title;
      subtitle.textContent = longSubtitle;
      subtitle.title = longSubtitle;
      await nextFrame();

      const style = getComputedStyle(subtitle);
      expect(style.overflow, `${viewport.name}: overflow containment`).toBe("hidden");
      expect(style.textOverflow, `${viewport.name}: ellipsis`).toBe("ellipsis");
      expect(style.whiteSpace, `${viewport.name}: desktop single line`).toBe("nowrap");
      expect(subtitle.scrollWidth, `${viewport.name}: fixture overflows`).toBeGreaterThan(
        subtitle.clientWidth,
      );
      expect(subtitle.title, `${viewport.name}: full text is discoverable`).toBe(longSubtitle);
      expectCollisionFree(sessionHeading, `${viewport.name}, overlong subtitle`);

      subtitle.textContent = originalText;
      subtitle.title = originalTitle;
    }
  });

  test("keeps concise visible actions independently descriptive", async () => {
    await page.viewport(1024, 720);
    await selectLocale("English");
    await expect
      .element(page.getByRole("link", { exact: true, name: "Open live traffic details" }))
      .toBeVisible();
    await expect.element(page.getByText("Live traffic", { exact: true })).toBeVisible();

    await selectLocale("简体中文");
    await expect
      .element(page.getByRole("link", { exact: true, name: "查看实时流量详情" }))
      .toBeVisible();
    await expect.element(page.getByText("查看实时流量", { exact: true })).toBeVisible();
  });
});
