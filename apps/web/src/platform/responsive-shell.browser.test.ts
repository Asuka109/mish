import { page, userEvent } from "vitest/browser";
import { beforeAll, describe, expect, test, vi } from "vitest";
import { routePendingClassName } from "../app-routes";
import { proxyControlStyles } from "../components/app-shell";

const routes = ["/status", "/routes", "/profiles", "/traffic", "/events", "/settings"];

const viewports = [
  { height: 568, name: "compact mobile", width: 320 },
  { height: 844, name: "mobile", width: 390 },
  { height: 720, name: "narrow boundary", width: 599 },
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
  pageOverflowElements: string[];
  sidebarWidth: number;
  tableHasLocalScroll: boolean | null;
}

interface SidebarRowGeometry {
  height: number;
  iconCenter: number;
  labelLeft: number;
  left: number;
}

interface Center {
  x: number;
  y: number;
}

function centerOf(element: HTMLElement): Center {
  const rect = element.getBoundingClientRect();

  return {
    x: rect.left + element.clientLeft + element.clientWidth / 2,
    y: rect.top + element.clientTop + element.clientHeight / 2,
  };
}

function expectTargetOwnsItsCenter(target: HTMLElement, context: string) {
  const center = centerOf(target);
  const hit = document.elementFromPoint(center.x, center.y);

  expect(
    hit === target || (hit !== null && target.contains(hit)),
    `${context}: center hit ${hit?.className || hit?.tagName || "nothing"}`,
  ).toBe(true);
}

function expectNarrowNavigationGeometry(context: string) {
  const shell = document.querySelector<HTMLElement>(".app-shell");
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  const workspace = document.querySelector<HTMLElement>("main.workspace");
  if (!shell || !sidebar || !workspace) throw new Error(`${context}: missing shell geometry`);

  const sidebarRect = sidebar.getBoundingClientRect();
  const workspaceRect = workspace.getBoundingClientRect();
  const gridRows = getComputedStyle(shell)
    .gridTemplateRows.split(" ")
    .map((value) => Number.parseFloat(value));

  expect(gridRows, `${context}: two explicit nonzero rows`).toHaveLength(2);
  expect(
    gridRows.every((height) => height > 0),
    `${context}: nonzero rows`,
  ).toBe(true);
  expect(workspaceRect.bottom, `${context}: workspace ends before navigation`).toBeLessThanOrEqual(
    sidebarRect.top + 0.5,
  );
  expect(getComputedStyle(workspace).borderBottomWidth, `${context}: card bottom edge`).toBe("1px");
  expect(
    Number.parseFloat(getComputedStyle(workspace).borderBottomLeftRadius),
    `${context}: rounded card bottom edge`,
  ).toBeGreaterThan(0);
  expect(getComputedStyle(sidebar).borderTopWidth, `${context}: no divider outside card`).toBe(
    "0px",
  );
  expect(sidebarRect.height, `${context}: reachable navigation row`).toBeGreaterThanOrEqual(56);
  expect(sidebarRect.bottom, `${context}: safe viewport bottom`).toBeLessThanOrEqual(
    window.innerHeight + 0.5,
  );

  const primaryIsland = document.querySelector<HTMLElement>(".narrow-navigation-primary");
  const utilityIsland = document.querySelector<HTMLElement>(".narrow-navigation-utility");
  if (!primaryIsland || !utilityIsland) throw new Error(`${context}: missing navigation islands`);
  expect(
    utilityIsland.getBoundingClientRect().left - primaryIsland.getBoundingClientRect().right,
    `${context}: visible island separation`,
  ).toBeGreaterThanOrEqual(7);

  for (const target of document.querySelectorAll<HTMLElement>(
    ".narrow-navigation .narrow-nav-item",
  )) {
    const rect = target.getBoundingClientRect();
    const island = target.closest<HTMLElement>(".narrow-navigation-island");
    if (!island) throw new Error(`${context}: missing navigation island`);
    const islandRect = island.getBoundingClientRect();
    const label = target.getAttribute("aria-label") ?? target.textContent ?? "destination";
    expect(rect.width, `${context}: ${label} target width`).toBeGreaterThanOrEqual(24);
    expect(rect.height, `${context}: ${label} target height`).toBeGreaterThanOrEqual(44);
    expect(rect.left - islandRect.left, `${context}: ${label} left inset`).toBeGreaterThanOrEqual(
      4,
    );
    expect(
      islandRect.right - rect.right,
      `${context}: ${label} right inset`,
    ).toBeGreaterThanOrEqual(4);
    expect(rect.top - islandRect.top, `${context}: ${label} top inset`).toBeGreaterThanOrEqual(4);
    expect(
      islandRect.bottom - rect.bottom,
      `${context}: ${label} bottom inset`,
    ).toBeGreaterThanOrEqual(4);
    expectTargetOwnsItsCenter(target, `${context}: ${label}`);
  }
}

function appendRoutePending(scroller: HTMLElement) {
  const pending = document.createElement("div");
  pending.ariaBusy = "true";
  pending.className = routePendingClassName;
  pending.innerHTML = '<div class="route-loading-indicator" role="status"></div>';
  scroller.replaceChildren(pending);

  const indicator = pending.querySelector<HTMLElement>(".route-loading-indicator");
  if (!indicator) throw new Error("Missing route loading indicator");
  return indicator;
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
  const pageScroll = document.querySelector<HTMLElement>(".workspace-page-scroll");
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  const navigationItems = [
    ...document.querySelectorAll<HTMLElement>(
      ".desktop-navigation .desktop-nav-item, .narrow-navigation .narrow-nav-item",
    ),
  ].filter((item) => item.getBoundingClientRect().width > 1);
  const controls = [
    ...document.querySelectorAll<HTMLElement>(
      'a, button, input, select, textarea, [role="button"]',
    ),
  ];
  const tableContainer = document.querySelector<HTMLElement>(".traffic-table")?.parentElement;
  const pageRect = pageScroll?.getBoundingClientRect();
  const pageOverflowElements =
    pageScroll && pageRect
      ? [...pageScroll.querySelectorAll<HTMLElement>("*")]
          .filter((element) => {
            const rect = element.getBoundingClientRect();
            return rect.width > 1 && rect.right > pageRect.right + 1;
          })
          .slice(0, 8)
          .map((element) => {
            const rect = element.getBoundingClientRect();
            const identity = [element.tagName.toLowerCase(), element.getAttribute("role")]
              .filter(Boolean)
              .join("[");
            return `${identity}${identity.includes("[") ? "]" : ""} right=${Math.round(rect.right)} class=${element.className}`;
          })
      : [];

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
    pageOverflowElements,
    sidebarWidth: sidebar ? Math.round(sidebar.getBoundingClientRect().width) : Number.NaN,
    tableHasLocalScroll: tableContainer
      ? (getComputedStyle(tableContainer).overflowX === "auto" ||
          getComputedStyle(tableContainer).overflowX === "scroll") &&
        tableContainer.scrollWidth > tableContainer.clientWidth + 1
      : null,
  };
}

function measureSidebarRow(
  row: HTMLElement,
  label: HTMLElement,
  icon: HTMLElement,
): SidebarRowGeometry {
  const rowRect = row.getBoundingClientRect();
  const iconRect = icon.getBoundingClientRect();
  const labelRect = label.getBoundingClientRect();

  return {
    height: Math.round(rowRect.height * 100) / 100,
    iconCenter: Math.round((iconRect.left + iconRect.width / 2) * 100) / 100,
    labelLeft: Math.round(labelRect.left * 100) / 100,
    left: Math.round(rowRect.left * 100) / 100,
  };
}

function appendProxyControlFixture(
  status: "inactive" | "connecting" | "error" | "healthy",
  label: string,
) {
  const styles = proxyControlStyles({ healthy: status === "healthy" });
  const button = document.createElement("button");
  button.className = `ui-button ui-button--ghost ui-button--default ${styles.proxyControl()}`;
  button.dataset.status = status;
  button.type = "button";
  button.innerHTML = `
    <span class="${styles.state({ className: styles.defaultState() })}" data-slot="proxy-control-default">
      <svg aria-hidden="true" viewBox="0 0 18 18"></svg>
      <span class="${styles.label()}">${label}</span>
    </span>
    ${
      status === "healthy"
        ? `<span aria-hidden="true" class="${styles.state({ className: styles.hoverState() })}" data-slot="proxy-control-hover">
            <svg viewBox="0 0 18 18"></svg>
            <span class="${styles.label()}">Stop Proxy</span>
          </span>`
        : ""
    }
  `;
  document.querySelector(".sidebar-bottom-items")?.append(button);
  return button;
}

async function navigate(path: string): Promise<void> {
  const target = new URL(path, window.location.origin);
  const normalizedPathname = (target.pathname.replace(/\/+$/, "") || "/").toLowerCase();
  window.history.pushState({}, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));

  await vi.waitFor(() => {
    expect(window.location.pathname).toBe(target.pathname);
    expect(window.location.search).toBe(target.search);
    expect(document.querySelector("main .workspace-page-scroll")).not.toBeNull();
    expect(document.querySelector("main .route-loading")).toBeNull();
    expect(
      document
        .querySelector(".desktop-navigation .desktop-nav-item.is-active")
        ?.getAttribute("href"),
    ).toBe(normalizedPathname);

    if (normalizedPathname === "/traffic") {
      expect(document.querySelector(".traffic-table")).not.toBeNull();
      const expectedActivityTarget =
        target.searchParams.get("tab") === "rules" ? "/traffic?tab=rules" : "/traffic?tab=active";
      expect(
        document.querySelector(".narrow-section-navigation .is-active")?.getAttribute("href"),
      ).toBe(expectedActivityTarget);
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
  test("keeps the healthy proxy material inside its one-pixel rounded border", async () => {
    await page.viewport(800, 600);
    await navigate("/status");

    const button = document.querySelector<HTMLButtonElement>(".proxy-control-button");
    if (!button) throw new Error("Missing proxy control");
    if (button.dataset.status !== "healthy") {
      await page.elementLocator(button).click();
      await vi.waitFor(() => expect(button.dataset.status).toBe("healthy"));
    }

    const material = button.querySelector<HTMLElement>('[data-slot="proxy-control-material"]');
    if (!material) throw new Error("Missing healthy proxy material");
    const buttonStyle = getComputedStyle(button);
    const materialStyle = getComputedStyle(material);

    expect(materialStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
    expect(Number.parseFloat(materialStyle.borderTopLeftRadius)).toBe(
      Number.parseFloat(buttonStyle.borderTopLeftRadius) - 1,
    );
  });

  test("uses one desktop grid for destination, Settings, and every proxy-control state", async () => {
    await page.viewport(800, 600);
    const root = document.documentElement;
    const initialTheme = root.dataset.theme;
    const initialWindowSurface = root.dataset.windowSurface;

    try {
      for (const variant of [
        {
          label: "English light opaque",
          locale: "English",
          proxyLabel: "Launch Proxy",
          theme: "light",
          windowSurface: "opaque",
        },
        {
          label: "简体中文 dark material",
          locale: "简体中文",
          proxyLabel: "启动代理",
          theme: "dark",
          windowSurface: "material",
        },
      ] as const) {
        root.dataset.theme = variant.theme;
        root.dataset.windowSurface = variant.windowSurface;
        await selectLocale(variant.locale);
        await navigate("/status");

        const rows = [...document.querySelectorAll<HTMLElement>(".desktop-nav-item")];
        const settings = document.querySelector<HTMLElement>(".settings-link");
        if (!settings) throw new Error("Missing Settings navigation row");

        const reference = measureSidebarRow(
          settings,
          settings.querySelector<HTMLElement>(":scope > span") as HTMLElement,
          settings.querySelector<HTMLElement>("svg") as HTMLElement,
        );
        const fixtures = [
          appendProxyControlFixture("inactive", variant.proxyLabel),
          appendProxyControlFixture("connecting", "Pending"),
          appendProxyControlFixture("error", "Needs attention"),
          appendProxyControlFixture("healthy", "Proxy running"),
        ];

        try {
          for (const row of rows) {
            const geometry = measureSidebarRow(
              row,
              row.querySelector<HTMLElement>(":scope > span") as HTMLElement,
              row.querySelector<HTMLElement>("svg") as HTMLElement,
            );
            expect(geometry, `${variant.label}: destination`).toEqual(reference);
          }

          for (const fixture of fixtures) {
            const defaultState = fixture.querySelector<HTMLElement>(".proxy-control-default");
            const label = defaultState?.querySelector<HTMLElement>(".proxy-control-label");
            const icon = defaultState?.querySelector<HTMLElement>("svg");
            if (!defaultState || !label || !icon)
              throw new Error("Missing proxy state fixture content");
            expect(
              measureSidebarRow(fixture, label, icon),
              `${variant.label}: proxy state`,
            ).toEqual(reference);
          }

          const running = fixtures.at(-1) as HTMLButtonElement;
          const hoverState = running.querySelector<HTMLElement>(".proxy-control-hover");
          const hoverLabel = hoverState?.querySelector<HTMLElement>(".proxy-control-label");
          const hoverIcon = hoverState?.querySelector<HTMLElement>("svg");
          if (!hoverState || !hoverLabel || !hoverIcon)
            throw new Error("Missing running hover state");
          expect(measureSidebarRow(running, hoverLabel, hoverIcon)).toEqual(reference);

          await page.elementLocator(running).hover();
          await vi.waitFor(() => expect(getComputedStyle(hoverState).opacity).toBe("1"));
          expect(getComputedStyle(running).height).toBe("36px");
        } finally {
          for (const fixture of fixtures) fixture.remove();
        }
      }
    } finally {
      if (initialTheme === undefined) delete root.dataset.theme;
      else root.dataset.theme = initialTheme;
      if (initialWindowSurface === undefined) delete root.dataset.windowSurface;
      else root.dataset.windowSurface = initialWindowSurface;
    }
  });

  test("scrolls the full workspace viewport while preserving the centered Settings column", async () => {
    await page.viewport(1440, 900);
    await selectLocale("English");
    await navigate("/settings");

    const workspace = document.querySelector<HTMLElement>("main.workspace");
    const scroller = document.querySelector<HTMLElement>("main .workspace-page-scroll");
    const settingsHeading = [...document.querySelectorAll<HTMLElement>("main h1")].find(
      (heading) => heading.textContent?.trim() === "Settings",
    );
    const settings = settingsHeading?.parentElement?.parentElement;
    if (!workspace || !scroller || !settings) throw new Error("Missing workspace scroll layout");

    const workspaceRect = workspace.getBoundingClientRect();
    const scrollerRect = scroller.getBoundingClientRect();
    const settingsRect = settings.getBoundingClientRect();
    expect(scrollerRect.left).toBeCloseTo(workspaceRect.left + 1, 0);
    expect(scrollerRect.right).toBeCloseTo(workspaceRect.right - 1, 0);
    expect(scrollerRect.top).toBeCloseTo(workspaceRect.top + 57, 0);
    expect(settingsRect.width).toBeLessThan(scroller.clientWidth);
    expect(settingsRect.left).toBeGreaterThan(scrollerRect.left + 1);
    expect(settingsRect.right).toBeLessThan(scrollerRect.right - 1);
    expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight);
    expect(document.querySelectorAll("main .workspace-page-scroll")).toHaveLength(1);
    expect(document.querySelectorAll("main .page-scroll")).toHaveLength(0);
    expect(getComputedStyle(settings).overflowY).not.toMatch(/auto|scroll/);

    const initialScrollTop = scroller.scrollTop;
    await page.elementLocator(scroller).wheel({ delta: { y: 240 } });
    await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(initialScrollTop));
  });

  test("keeps profile primary actions legible and subscription spacing intact", async () => {
    await page.viewport(1057, 689);
    await selectLocale("English");
    await navigate("/profiles");

    const addSubscription = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.trim() === "Add Subscription",
    );
    const subscriptionGrid = document.querySelector<HTMLElement>(".profile-subscription-grid");
    const subscription = subscriptionGrid?.parentElement;
    const overwriteNote = subscription?.querySelector<HTMLElement>("p");
    if (!addSubscription || !subscriptionGrid || !subscription || !overwriteNote) {
      throw new Error("Missing profile subscription layout");
    }

    const actionStyle = getComputedStyle(addSubscription);
    const subscriptionStyle = getComputedStyle(subscription);
    const overwriteStyle = getComputedStyle(overwriteNote);

    expect(actionStyle.color).not.toBe(actionStyle.backgroundColor);
    expect(overwriteStyle.marginTop).toBe("9px");
    expect(subscriptionStyle.paddingBottom).toBe("13px");
  });

  test("opens the service Manage menu with pointer and keyboard input", async () => {
    await page.viewport(800, 600);
    await selectLocale("English");
    await navigate("/status");

    const trigger = page.getByRole("button", { exact: true, name: "Manage" });
    await trigger.click();
    await expect.element(page.getByRole("menuitem", { name: "Edit Services…" })).toBeVisible();
    await expect.element(trigger).toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard("{Escape}");
    await expect.element(trigger).not.toHaveAttribute("aria-expanded", "true");

    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("menuitem", { name: "Edit Services…" })).toBeVisible();
    await userEvent.keyboard("{Escape}");
    await expect.element(trigger).not.toHaveAttribute("aria-expanded", "true");
  });

  test("keeps every primary route within mobile, web, and Tauri viewports", async () => {
    for (const viewport of viewports) {
      await page.viewport(viewport.width, viewport.height);

      for (const locale of ["English", "简体中文"] as const) {
        document.documentElement.dataset.theme = locale === "English" ? "light" : "dark";
        await selectLocale(locale);

        for (const path of routes) {
          await navigate(path);
          const measurement = measureLayout();
          const context = `${viewport.name} ${viewport.width}x${viewport.height}, ${locale}, ${path}`;

          expect(measurement.documentOverflow, `${context}: document overflow`).toBeLessThanOrEqual(
            1,
          );
          expect(
            measurement.pageOverflow,
            `${context}: page overflow; outside descendants: ${measurement.pageOverflowElements.join(" | ") || "none"}`,
          ).toBeLessThanOrEqual(1);
          expect(
            document.querySelectorAll("main .workspace-page-scroll"),
            `${context}: one primary page scroller`,
          ).toHaveLength(1);
          expect(
            document.querySelectorAll("main .page-scroll"),
            `${context}: no nested route page scroller`,
          ).toHaveLength(0);
          expect(measurement.navigationCount, `${context}: primary navigation items`).toBe(
            viewport.width < 600 ? 4 : 6,
          );
          expect(
            measurement.navigationLabelsClipped,
            `${context}: clipped navigation labels`,
          ).toEqual([]);
          expect(measurement.outsideControls, `${context}: controls outside the viewport`).toEqual(
            [],
          );

          if (viewport.width < 600) {
            expectNarrowNavigationGeometry(context);
            expect(
              document.querySelector<HTMLElement>(".proxy-control-button")?.getBoundingClientRect()
                .width,
              `${context}: proxy control leaves narrow navigation`,
            ).toBe(0);
            const selectedTarget =
              path === "/status" || path === "/profiles"
                ? "/status"
                : path === "/traffic" || path === "/events"
                  ? "/traffic"
                  : path;
            expect(
              document
                .querySelector(".narrow-navigation .narrow-nav-item.is-active")
                ?.getAttribute("href"),
              `${context}: grouped primary selection`,
            ).toBe(selectedTarget);
            const currentPrimary = document.querySelectorAll(
              '.narrow-navigation .narrow-nav-item[aria-current="page"]',
            );
            expect(currentPrimary, `${context}: one current primary destination`).toHaveLength(1);
            expect(currentPrimary[0]?.getAttribute("href")).toBe(selectedTarget);
          } else {
            expect(measurement.sidebarWidth, `${context}: full desktop sidebar width`).toBe(164);
            expect(
              document.querySelector<HTMLElement>(".proxy-control-button")?.getBoundingClientRect()
                .width,
              `${context}: desktop proxy control remains available`,
            ).toBeGreaterThan(1);
          }

          if (path === "/traffic") {
            expect(measurement.tableHasLocalScroll, `${context}: traffic table local scroll`).toBe(
              true,
            );
          }
        }
      }
    }
    delete document.documentElement.dataset.theme;
  });

  test("keeps narrow destinations pointer- and keyboard-reachable with visible focus", async () => {
    await selectLocale("English");

    for (const viewport of viewports.filter(({ width }) => width < 600)) {
      await page.viewport(viewport.width, viewport.height);
      await navigate("/status");
      const links = [
        ...document.querySelectorAll<HTMLAnchorElement>(".narrow-navigation .narrow-nav-item"),
      ];
      expect(links).toHaveLength(4);

      links[0]?.focus({ preventScroll: true });
      await userEvent.keyboard("{Tab}");
      expect(document.activeElement, `${viewport.width}px keyboard entry`).toBe(links[1]);
      expect(links[1]).toHaveAttribute("data-mish-focus-visible", "keyboard");
      for (const expected of links.slice(2).concat(links.slice(0, 2))) {
        await userEvent.keyboard("{ArrowRight}");
        expect(document.activeElement, `${viewport.width}px keyboard order`).toBe(expected);
        expect(expected).toHaveAttribute("data-mish-focus-visible", "keyboard");
        expect(getComputedStyle(expected).outlineStyle).toBe("solid");
        expectTargetOwnsItsCenter(expected, `${viewport.width}px focused ${expected.ariaLabel}`);
      }

      for (const link of links) {
        expectTargetOwnsItsCenter(link, `${viewport.width}px pointer ${link.ariaLabel}`);
        await page.elementLocator(link).click();
        await vi.waitFor(() => expect(window.location.pathname).toBe(link.pathname));
      }
    }
  });

  test("opens Profiles in a narrow drawer and keeps Activity destinations reachable", async () => {
    await page.viewport(390, 844);
    await selectLocale("English");
    await navigate("/status");

    expect(document.querySelector(".narrow-section-navigation")).toBeNull();
    const profileTrigger = document.querySelector<HTMLButtonElement>(".profile-drawer-trigger");
    if (!profileTrigger) throw new Error("Missing narrow profile drawer trigger");
    expect(profileTrigger.getBoundingClientRect().width).toBeGreaterThanOrEqual(100);
    expect(profileTrigger.getBoundingClientRect().height).toBeGreaterThanOrEqual(34);
    expect(profileTrigger.scrollWidth - profileTrigger.clientWidth).toBeLessThanOrEqual(1);
    expect(profileTrigger.querySelector(".user-authored-label")).toHaveTextContent("Home");
    expectTargetOwnsItsCenter(profileTrigger, "profile drawer trigger");

    await page.elementLocator(profileTrigger).click();
    await vi.waitFor(() => {
      const drawer = document.querySelector<HTMLElement>(".drawer-content");
      const heading = drawer?.querySelector("h1");
      expect(drawer).not.toBeNull();
      expect(heading).toHaveTextContent("Profiles");
      expect(drawer?.getBoundingClientRect().width).toBeCloseTo(window.innerWidth, 0);
      expect(drawer?.getBoundingClientRect().height).toBeGreaterThanOrEqual(
        window.innerHeight - 20,
      );
    });
    expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    expect(document.querySelector('[role="dialog"]')).toHaveAccessibleName("Profiles");
    const currentProfileButton = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((button) => button.textContent?.trim() === "Current Profile");
    const switchProfileButton = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button'),
    ].find((button) => button.textContent?.trim() === "Switch Profile");
    expect(currentProfileButton).toBeDisabled();
    expect(currentProfileButton).toHaveAttribute("aria-pressed", "true");
    if (!switchProfileButton) throw new Error("Missing profile switch action in drawer");
    await page.elementLocator(switchProfileButton).click();
    await vi.waitFor(() => {
      expect(profileTrigger.querySelector(".user-authored-label")).toHaveTextContent("Work 工作");
      expect(switchProfileButton).toHaveTextContent("Current Profile");
      expect(switchProfileButton).toHaveAttribute("aria-pressed", "true");
    });

    await userEvent.keyboard("{Escape}");
    await vi.waitFor(() => expect(document.querySelector(".drawer-content")).toBeNull());
    expect(document.activeElement).toBe(profileTrigger);

    await navigate("/profiles");
    expect(document.querySelector(".narrow-section-navigation")).toBeNull();
    expect(
      document.querySelector(".narrow-navigation .narrow-nav-item.is-active")?.getAttribute("href"),
    ).toBe("/status");

    await navigate("/traffic");
    const links = [
      ...document.querySelectorAll<HTMLAnchorElement>(".narrow-section-navigation .nav-item"),
    ];
    expect(links.map((link) => link.getAttribute("href"))).toEqual([
      "/traffic?tab=active",
      "/traffic?tab=rules",
      "/events",
    ]);
    expect(
      document.querySelectorAll('.narrow-section-navigation .nav-item[aria-current="page"]'),
    ).toHaveLength(1);

    for (const link of links) {
      expect(link.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
      expectTargetOwnsItsCenter(link, `grouped destination ${link.textContent}`);
    }

    links[0]?.focus({ preventScroll: true });
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(links[1]);
    expect(links[1]).toHaveAttribute("data-mish-focus-visible", "keyboard");
    expect(getComputedStyle(links[1] as HTMLAnchorElement).outlineStyle).toBe("solid");
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(links[2]);
    expect(links[2]).toHaveAttribute("data-mish-focus-visible", "keyboard");
    expect(getComputedStyle(links[2] as HTMLAnchorElement).outlineStyle).toBe("solid");

    const navigation = links[0]?.closest<HTMLElement>(".narrow-section-navigation");
    if (!navigation) throw new Error("Missing activity navigation");
    navigation.style.width = "150px";
    navigation.scrollLeft = 0;
    links[0]?.focus({ preventScroll: true });
    expect(navigation.scrollWidth).toBeGreaterThan(navigation.clientWidth);

    await userEvent.keyboard("{End}");
    await vi.waitFor(() => expect(navigation.scrollLeft).toBeGreaterThan(0));
    const navigationRect = navigation.getBoundingClientRect();
    const focusedRect = links.at(-1)?.getBoundingClientRect();
    expect(focusedRect?.left).toBeGreaterThanOrEqual(navigationRect.left);
    expect(focusedRect?.right).toBeLessThanOrEqual(navigationRect.right);
    navigation.style.removeProperty("width");

    await page
      .elementLocator(
        document.querySelector('.narrow-section-navigation a[href="/events"]') as Element,
      )
      .click();
    await vi.waitFor(() => expect(window.location.pathname).toBe("/events"));
    expect(
      document.querySelector(".narrow-navigation .narrow-nav-item.is-active")?.getAttribute("href"),
    ).toBe("/traffic");

    await navigate("/traffic?tab=ruleset");
    await vi.waitFor(() => {
      expect(
        document.querySelector(".narrow-section-navigation .is-active")?.getAttribute("href"),
      ).toBe("/traffic?tab=active");
      expect(
        document.querySelectorAll('.narrow-section-navigation .nav-item[aria-current="page"]'),
      ).toHaveLength(1);
    });

    await navigate("/traffic?tab=rules");
    await vi.waitFor(() => {
      expect(
        document.querySelector(".narrow-section-navigation .is-active")?.getAttribute("href"),
      ).toBe("/traffic?tab=rules");
      expect(
        document.querySelectorAll('.narrow-section-navigation .nav-item[aria-current="page"]'),
      ).toHaveLength(1);
    });
  });

  test("keeps grouped narrow navigation active on trailing-slash routes", async () => {
    await page.viewport(390, 844);
    await selectLocale("English");

    for (const [path, primary] of [
      ["/STATUS/", "/status"],
      ["/profiles/", "/status"],
      ["/TRAFFIC/", "/traffic"],
      ["/events/", "/traffic"],
    ] as const) {
      await navigate(path);
      expect(
        document.querySelector('.narrow-navigation .narrow-nav-item[aria-current="page"]'),
        `${path}: grouped primary selection`,
      ).toHaveAttribute("href", primary);
      expect(document.title, `${path}: page title`).not.toBe("Mish");
      if (primary === "/traffic") {
        expect(document.querySelector(".narrow-section-navigation")).not.toBeNull();
      }
    }
  });

  test("preserves the compact desktop sidebar at the 600px boundary", async () => {
    await page.viewport(600, 720);
    await selectLocale("English");
    await navigate("/status");

    const shell = document.querySelector<HTMLElement>(".app-shell");
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    const navigationItem = document.querySelector<HTMLElement>(".desktop-nav-item");
    const profileSelect = document.querySelector<HTMLElement>(".profile-select-trigger");
    const profileDrawerTrigger = document.querySelector<HTMLElement>(".profile-drawer-trigger");
    if (!shell || !sidebar || !navigationItem || !profileSelect || !profileDrawerTrigger) {
      throw new Error("Missing desktop boundary shell");
    }

    expect(Math.round(sidebar.getBoundingClientRect().width)).toBe(164);
    expect(getComputedStyle(shell).gridTemplateColumns).toMatch(/^164px /);
    expect(Math.round(navigationItem.getBoundingClientRect().height)).toBe(36);
    expect(profileSelect.getBoundingClientRect().width).toBeGreaterThan(1);
    expect(profileDrawerTrigger.getBoundingClientRect().width).toBe(0);
  });

  test("centers deferred route loading in the visible workspace scroller", async () => {
    await page.viewport(1440, 900);
    await navigate("/settings");

    const scroller = document.querySelector<HTMLElement>("main .workspace-page-scroll");
    if (!scroller) throw new Error("Missing workspace scroller");

    scroller.scrollTop = 180;
    await vi.waitFor(() => expect(scroller.scrollTop, "nonzero scroll precondition").toBe(180));

    const indicator = appendRoutePending(scroller);

    for (const viewport of [
      { height: 900, name: "wide desktop", width: 1440 },
      { height: 600, name: "narrow desktop", width: 800 },
    ]) {
      await page.viewport(viewport.width, viewport.height);
      await vi.waitFor(() => {
        const indicatorCenter = centerOf(indicator);
        const scrollerCenter = centerOf(scroller);

        expect(indicatorCenter.x, `${viewport.name}: horizontal center`).toBeCloseTo(
          scrollerCenter.x,
          0,
        );
        expect(indicatorCenter.y, `${viewport.name}: vertical center`).toBeCloseTo(
          scrollerCenter.y,
          0,
        );
      });

      expect(
        document.querySelectorAll("main .workspace-page-scroll"),
        `${viewport.name}: scroller`,
      ).toHaveLength(1);
      expect(getComputedStyle(scroller).overflowY, `${viewport.name}: scroller overflow`).toMatch(
        /auto|scroll/,
      );
      expect(
        document.querySelectorAll("main .page-scroll"),
        `${viewport.name}: nested scroller`,
      ).toHaveLength(0);
    }
  });
});
