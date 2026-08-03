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
  client: FixtureStatusClient = new FixtureStatusClient(),
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
          <ProductProvider client={client}>
            <TooltipProvider>
              <AppRoutes />
            </TooltipProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
}

class LocalizedStatusDensityClient extends FixtureStatusClient {
  constructor(private readonly locale: Locales) {
    super();
  }

  override async getSnapshot() {
    const snapshot = await super.getSnapshot();
    const labels =
      this.locale === "zh"
        ? [
            "香港优选策略组・超长名称",
            "流媒体专用策略组・超长名称",
            "自动选择・中国大陆回退",
            "日本节点负载均衡・超长名称",
            "全球服务加速・超长名称",
          ]
        : [
            "Hong Kong preferred policy group with a long name",
            "Streaming policy group with a long name",
            "Automatic mainland fallback policy group",
            "Japan load-balanced policy group with a long name",
            "Global service acceleration policy group",
          ];
    const nodeLabels =
      this.locale === "zh"
        ? ["香港专线节点・超长名称", "日本高速节点・超长名称", "新加坡稳定节点・超长名称"]
        : [
            "Hong Kong dedicated node with a long name",
            "Japan high-speed node with a long name",
            "Singapore stable node with a long name",
          ];
    return {
      ...snapshot,
      groups: snapshot.groups.map((group, index) => ({
        ...group,
        label: labels[index] ?? group.label,
      })),
      nodes: snapshot.nodes.map((node, index) => ({
        ...node,
        label: nodeLabels[index % nodeLabels.length] ?? node.label,
      })),
    };
  }
}

class StoppedPolicySelectionClient extends FixtureStatusClient {
  selectionAttempts = 0;

  override getConnectionState() {
    return { attempt: 0, phase: "connected" as const, stale: false };
  }

  override async getSnapshot() {
    const snapshot = await super.getSnapshot();
    snapshot.adapterKind = "rpc";
    snapshot.runtime.phase = "inactive";
    snapshot.groupSelectionAvailability = "unavailable";
    return snapshot;
  }

  override async selectGroupChild(groupId: string, childId: string) {
    this.selectionAttempts += 1;
    return super.selectGroupChild(groupId, childId);
  }
}

describe("unified policy browser", () => {
  test.each([
    ["en", "Start the proxy before changing this policy-group selection."],
    ["zh", "请先启动代理，再更改这个策略组的选择。"],
  ] as const)(
    "keeps stopped Browser Client selection inert with a focusable %s explanation",
    async (locale, explanation) => {
      await page.viewport(800, 600);
      const client = new StoppedPolicySelectionClient();
      renderPolicyWorkspace("/routes", locale, "light", "opaque", client);
      await expect
        .element(page.getByRole("heading", { name: locale === "zh" ? "路由" : "Routes" }))
        .toBeVisible();
      await userEvent.click(
        page.getByRole("button", {
          name: locale === "zh" ? "浏览 🎬 Streaming" : "Browse 🎬 Streaming",
        }),
      );
      await expect.element(page.getByRole("dialog", { name: "🎬 Streaming" })).toBeVisible();

      const selection = document.querySelector<HTMLButtonElement>(
        '[data-entity-id="nrt-03"] [data-policy-row-primary]',
      );
      const trigger = selection?.closest<HTMLElement>(
        "[data-policy-selection-unavailable-trigger]",
      );
      if (!selection || !trigger) throw new Error("Missing stopped selection explanation");
      expect(selection.disabled).toBe(true);
      expect(trigger.tabIndex).toBe(0);

      await page.elementLocator(trigger).hover();
      await expect.element(page.getByText(explanation)).toBeVisible();
      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      await userEvent.keyboard("{Enter}");
      trigger.dispatchEvent(new TouchEvent("touchstart", { bubbles: true }));
      trigger.dispatchEvent(new TouchEvent("touchend", { bubbles: true }));
      await userEvent.click(page.elementLocator(trigger));

      expect(client.selectionAttempts).toBe(0);
      expect(selection.getAttribute("aria-busy")).not.toBe("true");
      expect(document.querySelector("[data-sonner-toast]")).toBeNull();
    },
  );

  test.each([
    ["en", "light"],
    ["zh", "dark"],
  ] as const)(
    "keeps five %s Status rows compact at wide width in %s appearance",
    async (locale, appearance) => {
      await page.viewport(1280, 800);
      renderPolicyWorkspace(
        "/status",
        locale,
        appearance,
        "opaque",
        new LocalizedStatusDensityClient(locale),
      );
      await expect
        .element(page.getByRole("heading", { name: locale === "zh" ? "状态" : "Status" }))
        .toBeVisible();
      await vi.waitFor(() => {
        expect(
          document.querySelectorAll(".policy-group-list [data-policy-row-primary]"),
        ).toHaveLength(5);
      });

      const rows = [
        ...document.querySelectorAll<HTMLElement>(".policy-group-list [data-policy-row-primary]"),
      ];
      const groupSection = document.querySelector<HTMLElement>(
        `[aria-label="${locale === "zh" ? "常用策略组" : "Frequently used policy groups"}"]`,
      );
      if (!groupSection) throw new Error("Missing Status Groups section");
      expect(getComputedStyle(groupSection).alignSelf).toBe("flex-start");
      expect(rows.every((row) => row.dataset.policyBrowserDensity === "status")).toBe(true);
      expect(rows.every((row) => row.getBoundingClientRect().height === 50)).toBe(true);
      rows.forEach((row) => {
        const copy = row.querySelector<HTMLElement>(".policy-browser-summary-copy");
        if (!copy) throw new Error("Missing Status policy summary copy");
        const rowRect = row.getBoundingClientRect();
        const copyRect = copy.getBoundingClientRect();
        const topInset = copyRect.top - rowRect.top;
        const bottomInset = rowRect.bottom - copyRect.bottom;
        expect(Math.min(topInset, bottomInset)).toBeGreaterThanOrEqual(4);
        expect(Math.abs(topInset - bottomInset)).toBeLessThanOrEqual(1);
        expect(row.querySelectorAll(".user-authored-label")).toHaveLength(2);
        expect(row.querySelector(".ui-badge")).not.toBeNull();
        expect(row.querySelector("svg")).not.toBeNull();
      });

      const firstRow = rows[0];
      if (!firstRow) throw new Error("Missing first Status row");
      const restingBackground = getComputedStyle(firstRow).backgroundColor;
      await page.elementLocator(firstRow).hover();
      expect(getComputedStyle(firstRow).backgroundColor).not.toBe(restingBackground);
      firstRow.focus();
      expect(document.activeElement).toBe(firstRow);
      await userEvent.click(page.elementLocator(firstRow));
      await expect.element(page.getByRole("dialog")).toBeVisible();
      const selectedElement = [
        ...document.querySelectorAll<HTMLButtonElement>(
          ".policy-picker-dialog [data-entity-id] [data-policy-row-primary]",
        ),
      ].find((candidate) => candidate.getAttribute("aria-pressed") === "false");
      if (!selectedElement) throw new Error("Missing selectable node in shared picker");
      const selected = page.elementLocator(selectedElement);
      await selected.click();
      await vi.waitFor(() => {
        expect(document.querySelector(".policy-picker-dialog")).toBeNull();
      });
      expect(document.documentElement.dataset.theme).toBe(appearance);
    },
  );

  test("relaxes the Status height contract after the desktop columns stack", async () => {
    await page.viewport(800, 700);
    renderPolicyWorkspace(
      "/status",
      "zh",
      "dark",
      "opaque",
      new LocalizedStatusDensityClient("zh"),
    );
    await expect.element(page.getByRole("heading", { name: "状态" })).toBeVisible();
    await vi.waitFor(() => {
      expect(
        document.querySelectorAll(".policy-group-list [data-policy-row-primary]"),
      ).toHaveLength(5);
    });
    const policyList = document.querySelector<HTMLElement>(".policy-group-list");
    const sessionList = document.querySelector<HTMLElement>(".session-list");
    const rows = [
      ...document.querySelectorAll<HTMLElement>(".policy-group-list [data-policy-row-primary]"),
    ];
    if (!policyList || !sessionList) throw new Error("Missing Status cards");
    expect(rows.every((row) => row.getBoundingClientRect().height >= 58)).toBe(true);
    expect(policyList.getBoundingClientRect().height).toBeGreaterThan(
      sessionList.getBoundingClientRect().height,
    );
    expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
  });

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
    expect(summaries[0]?.getBoundingClientRect().height).toBeGreaterThanOrEqual(58);
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
