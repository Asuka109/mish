import type { MobileConfigValidationResultDto, MobileVpnSnapshotDto } from "@mish/contracts";
import { cdp, page } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router";
import { flushSync } from "react-dom";
import { MobileShell } from "../components/mobile-shell";
import TypesafeI18n from "../i18n/i18n-react";
import type { Locales } from "../i18n/i18n-types";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import type { MobileVpnClient } from "../platform/mobile-vpn-client";
import { MobileHomePage } from "./mobile-home-page";
import "../styles.css";

interface EmulationSession {
  send(
    method: "Emulation.setEmulatedMedia",
    params: { features: { name: string; value: string }[] },
  ): Promise<unknown>;
}

interface Viewport {
  height: number;
  name: string;
  width: number;
}

const fixture = {
  adapterKind: "native" as const,
  contractVersion: 1 as const,
  core: { availability: "unavailable" as const, kind: "fixture" as const },
  message: "Native fixture connected.",
  platform: "android" as const,
  targetAbis: ["arm64-v8a", "x86_64"] as ["arm64-v8a", "x86_64"],
  vpn: { availability: "unavailable" as const, kind: "fixture" as const },
};

const permissionSnapshot: MobileVpnSnapshotDto = {
  backendKind: "fixture",
  contractVersion: 1,
  coreAbiVersion: null,
  coreAvailability: "unavailable",
  coreCommit: null,
  coreVersion: null,
  coreWrapperRevision: null,
  foreground: false,
  message: "Fixture only. No TUN or Core is available.",
  notificationPermission: "required",
  permission: "required",
  phase: "permission-required",
  sequence: 1,
  sessionId: "browser-session",
  updatedAtMillis: 1,
  vpnActive: false,
};

const viewports: Viewport[] = [
  { height: 568, name: "compact portrait", width: 320 },
  { height: 800, name: "common portrait", width: 360 },
  { height: 915, name: "large portrait", width: 412 },
  { height: 360, name: "compact landscape", width: 640 },
  { height: 412, name: "common landscape", width: 915 },
];

class BrowserMobileVpnClient implements MobileVpnClient {
  private readonly subscribers = new Set<(snapshot: MobileVpnSnapshotDto) => void>();

  constructor(private snapshot: MobileVpnSnapshotDto) {}

  dispose() {}

  getSnapshot() {
    return this.snapshot;
  }

  async initialize() {
    return this.snapshot;
  }

  async requestNotificationPermission() {
    return this.snapshot;
  }

  async requestVpnConsent() {
    return this.snapshot;
  }

  async startFixtureLifecycle() {
    return this.snapshot;
  }

  async stop() {
    return this.snapshot;
  }

  async validateConfig(): Promise<MobileConfigValidationResultDto> {
    return {
      contractVersion: 1,
      failure: "core-unavailable",
      message: "The packaged Mobile Core is unavailable.",
      outcome: "failed",
      sequence: this.snapshot.sequence,
      sessionId: this.snapshot.sessionId,
    };
  }

  subscribe(handler: (snapshot: MobileVpnSnapshotDto) => void) {
    this.subscribers.add(handler);
    handler(this.snapshot);
    return () => this.subscribers.delete(handler);
  }
}

function DummyPage({ name }: { name: string }) {
  return <div className="h-full overflow-y-auto p-4">{name}</div>;
}

let root: Root;

function renderMobile(
  locale: Locales,
  snapshot: MobileVpnSnapshotDto = permissionSnapshot,
  theme: "dark" | "light" = "light",
) {
  document.documentElement.dataset.runtime = "mobile";
  document.documentElement.dataset.theme = theme;
  window.history.replaceState({}, "", "/status");
  const client = new BrowserMobileVpnClient(snapshot);

  flushSync(() => {
    root.render(
      <TypesafeI18n locale={locale}>
        <BrowserRouter>
          <Routes>
            <Route element={<MobileShell fixture={fixture} />}>
              <Route
                element={
                  <MobileHomePage fixture={fixture} initialSnapshot={snapshot} vpnClient={client} />
                }
                path="status"
              />
              <Route element={<DummyPage name="Routes content" />} path="routes" />
              <Route element={<DummyPage name="Profiles content" />} path="profiles" />
              <Route element={<DummyPage name="Traffic content" />} path="traffic" />
              <Route element={<DummyPage name="Events content" />} path="events" />
              <Route element={<DummyPage name="Settings content" />} path="settings" />
            </Route>
          </Routes>
        </BrowserRouter>
      </TypesafeI18n>,
    );
  });
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

function expectHorizontalGeometry(context: string) {
  const pageScroller = document.querySelector<HTMLElement>(".mobile-home-page");
  const action = document.querySelector<HTMLElement>(".mobile-home-primary-action");
  const authority = document.querySelector<HTMLElement>(".mobile-home-authority");
  const bottomNavigation = document.querySelector<HTMLElement>(".mobile-bottom-navigation");
  if (!pageScroller || !action || !authority || !bottomNavigation) {
    throw new Error(`${context}: mobile Home geometry is incomplete`);
  }

  expect(
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
    `${context}: document overflow`,
  ).toBeLessThanOrEqual(1);
  expect(
    pageScroller.scrollWidth - pageScroller.clientWidth,
    `${context}: page overflow`,
  ).toBeLessThanOrEqual(1);
  expect(
    authority.getBoundingClientRect().bottom,
    `${context}: VPN authority precedes current setup`,
  ).toBeLessThanOrEqual(
    document.querySelector("#mobile-home-current-title")!.getBoundingClientRect().top,
  );

  const controls = [action, ...document.querySelectorAll<HTMLElement>(".mobile-destination")];
  for (const control of controls) {
    const rect = control.getBoundingClientRect();
    expect(rect.width, `${context}: ${control.textContent} touch width`).toBeGreaterThanOrEqual(44);
    expect(rect.height, `${context}: ${control.textContent} touch height`).toBeGreaterThanOrEqual(
      44,
    );
    expect(rect.left, `${context}: ${control.textContent} left edge`).toBeGreaterThanOrEqual(-0.5);
    expect(rect.right, `${context}: ${control.textContent} right edge`).toBeLessThanOrEqual(
      window.innerWidth + 0.5,
    );
  }

  for (const destination of document.querySelectorAll<HTMLElement>(".mobile-destination")) {
    const label = destination.lastElementChild as HTMLElement;
    const destinationRect = destination.getBoundingClientRect();
    const labelRect = label.getBoundingClientRect();
    expect(labelRect.left, `${context}: ${label.textContent} label left`).toBeGreaterThanOrEqual(
      destinationRect.left - 0.5,
    );
    expect(labelRect.right, `${context}: ${label.textContent} label right`).toBeLessThanOrEqual(
      destinationRect.right + 0.5,
    );
  }

  expect(bottomNavigation.getBoundingClientRect().bottom).toBeLessThanOrEqual(
    window.innerHeight + 0.5,
  );
}

beforeAll(() => {
  loadAllLocales();
  document.body.innerHTML = '<div id="mobile-home-browser-root" style="height:100vh"></div>';
  const container = document.getElementById("mobile-home-browser-root");
  if (!container) throw new Error("Missing mobile Home browser root");
  root = createRoot(container);
});

afterAll(() => {
  root.unmount();
  delete document.documentElement.dataset.runtime;
  delete document.documentElement.dataset.theme;
});

describe("Android mobile Home geometry", () => {
  test("fits supported portrait and landscape sizes in both locales and themes", async () => {
    for (const locale of ["en", "zh"] as const) {
      for (const theme of ["light", "dark"] as const) {
        for (const viewport of viewports) {
          await page.viewport(viewport.width, viewport.height);
          renderMobile(locale, permissionSnapshot, theme);
          await nextFrame();
          expectHorizontalGeometry(`${locale} ${theme} ${viewport.name}`);

          if (viewport.height >= 800) {
            const routingValue = document
              .querySelector("#mobile-home-current-title")
              ?.parentElement?.querySelectorAll<HTMLElement>(".section-grid-item")[1];
            const bottomNavigation = document.querySelector(".mobile-bottom-navigation");
            if (!routingValue || !bottomNavigation) {
              throw new Error("Missing current setup or mobile navigation");
            }
            expect(
              routingValue.getBoundingClientRect().bottom,
              `${locale} ${theme} ${viewport.name}: routing mode is visible without scrolling`,
            ).toBeLessThanOrEqual(bottomNavigation.getBoundingClientRect().top);
          }
        }
      }
    }
  });

  test("keeps local scrolling and navigation stable when the software keyboard reduces height", async () => {
    await page.viewport(360, 420);
    renderMobile("zh");
    await nextFrame();

    const pageScroller = document.querySelector<HTMLElement>(".mobile-home-page");
    if (!pageScroller) throw new Error("Missing mobile Home scroller");
    expect(pageScroller.scrollHeight).toBeGreaterThan(pageScroller.clientHeight);
    expect(getComputedStyle(pageScroller).overflowY).toBe("auto");
    expectHorizontalGeometry("software keyboard viewport");
  });

  test("supports enlarged text without clipped actions, values, or navigation labels", async () => {
    await page.viewport(320, 568);
    document.documentElement.style.setProperty("--mish-typography-title-font-size", "30px");
    document.documentElement.style.setProperty("--mish-typography-body-font-size", "20px");
    document.documentElement.style.setProperty("--mish-typography-metadata-font-size", "18px");
    document.documentElement.style.setProperty("--mish-typography-label-small-font-size", "16px");

    try {
      renderMobile("zh");
      await nextFrame();
      expectHorizontalGeometry("enlarged text");
      for (const row of document.querySelectorAll<HTMLElement>(".section-grid-item")) {
        expect(
          row.scrollWidth - row.clientWidth,
          row.textContent ?? "scaled row",
        ).toBeLessThanOrEqual(1);
      }
    } finally {
      for (const property of [
        "--mish-typography-title-font-size",
        "--mish-typography-body-font-size",
        "--mish-typography-metadata-font-size",
        "--mish-typography-label-small-font-size",
      ]) {
        document.documentElement.style.removeProperty(property);
      }
    }
  });

  test("restores route focus and Home scroll through browser back navigation", async () => {
    await page.viewport(320, 568);
    renderMobile("en");
    await nextFrame();
    const pageScroller = document.querySelector<HTMLElement>(".mobile-home-page");
    if (!pageScroller) throw new Error("Missing mobile Home scroller");
    pageScroller.scrollTop = 120;
    pageScroller.dispatchEvent(new Event("scroll"));
    const rememberedScrollTop = pageScroller.scrollTop;
    expect(rememberedScrollTop).toBeGreaterThan(0);

    await page.getByRole("link", { name: "Routes" }).click();
    await vi.waitFor(() => {
      expect(window.location.pathname).toBe("/routes");
      expect(document.activeElement).toBe(document.querySelector(".mobile-top-app-bar h1"));
      expect(document.activeElement).toHaveTextContent("Routes");
    });

    window.history.back();
    await vi.waitFor(() => {
      expect(window.location.pathname).toBe("/status");
      expect(document.activeElement).toBe(document.querySelector(".mobile-top-app-bar h1"));
      expect(document.activeElement).toHaveTextContent("Home");
      expect(document.querySelector<HTMLElement>(".mobile-home-page")?.scrollTop).toBe(
        rememberedScrollTop,
      );
    });
  });

  test("reduces native Home motion while preserving authoritative pending state", async () => {
    const session = (await cdp()) as unknown as EmulationSession;
    await session.send("Emulation.setEmulatedMedia", {
      features: [{ name: "prefers-reduced-motion", value: "reduce" }],
    });

    try {
      await page.viewport(360, 800);
      renderMobile("en", {
        ...permissionSnapshot,
        notificationPermission: "granted",
        permission: "granted",
        phase: "starting",
        sequence: 2,
      });
      await nextFrame();

      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      await vi.waitFor(() =>
        expect(document.querySelector(".mobile-home-authority .ui-spinner")).not.toBeNull(),
      );
      const spinner = document.querySelector<HTMLElement>(".mobile-home-authority .ui-spinner");
      if (!spinner) throw new Error("Missing authoritative pending spinner");
      expect(parseFloat(getComputedStyle(spinner).animationDuration)).toBeLessThanOrEqual(0.01);
      expect(page.getByRole("heading", { name: "Checking native lifecycle" })).toBeVisible();
      expect(page.getByRole("button", { name: "Pending" })).toBeDisabled();
    } finally {
      await session.send("Emulation.setEmulatedMedia", { features: [] });
    }
  });
});
