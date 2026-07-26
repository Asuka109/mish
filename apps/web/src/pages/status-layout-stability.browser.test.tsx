import type { StatusConnectionState, StatusSnapshotDto } from "@mish/contracts";
import { TooltipProvider } from "@mish/ui";
import { page } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { FixtureStatusClient } from "../data/fixture-status-client";
import { NotificationDeliveryProvider } from "../data/notification-delivery";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import type { Locales } from "../i18n/i18n-types";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { RoutesPage } from "./routes-page";
import { StatusPage } from "./status-page";
import "../styles.css";

type StatusScenario = "capture-failure" | "drift" | "happy" | "runtime-failure" | "stale";

class StatusLayoutClient extends FixtureStatusClient {
  private connection: StatusConnectionState = {
    attempt: 0,
    phase: "connected",
    stale: false,
  };
  private readonly currentConnectionListeners = new Set<(state: StatusConnectionState) => void>();
  private currentSnapshot: StatusSnapshotDto;
  private readonly currentSnapshotListeners = new Set<(snapshot: StatusSnapshotDto) => void>();

  constructor(private readonly happySnapshot: StatusSnapshotDto) {
    super();
    this.currentSnapshot = structuredClone(happySnapshot);
  }

  override getConnectionState() {
    return { ...this.connection };
  }

  override async getSnapshot() {
    return structuredClone(this.currentSnapshot);
  }

  override subscribeConnection(listener: (state: StatusConnectionState) => void) {
    this.currentConnectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.currentConnectionListeners.delete(listener);
  }

  override subscribeSnapshots(listener: (snapshot: StatusSnapshotDto) => void) {
    this.currentSnapshotListeners.add(listener);
    return () => this.currentSnapshotListeners.delete(listener);
  }

  setScenario(scenario: StatusScenario) {
    this.connection = { attempt: 0, phase: "connected", stale: false };
    this.currentSnapshot = structuredClone(this.happySnapshot);

    if (scenario === "stale") {
      this.connection = { attempt: 2, phase: "reconnecting", stale: true };
    } else if (scenario === "runtime-failure") {
      this.currentSnapshot.runtime.phase = "error";
    } else if (scenario === "capture-failure") {
      this.currentSnapshot.runtime.systemProxy = {
        desired: true,
        failure: "core-unhealthy",
        observed: "disabled",
        phase: "failed",
        recoveryActions: [],
      };
    } else if (scenario === "drift") {
      this.currentSnapshot.runtime.systemProxy = {
        desired: true,
        failure: "external-drift",
        observed: "other",
        phase: "drift",
        recoveryActions: ["repair", "leave-as-is"],
      };
    }

    for (const listener of this.currentConnectionListeners) listener(this.getConnectionState());
    for (const listener of this.currentSnapshotListeners) {
      listener(structuredClone(this.currentSnapshot));
    }
  }
}

interface Geometry {
  height: number;
  left: number;
  top: number;
  width: number;
}

function geometry(element: Element): Geometry {
  const rect = element.getBoundingClientRect();
  return {
    height: rect.height,
    left: rect.left,
    top: rect.top,
    width: rect.width,
  };
}

function expectStableGeometry(
  actual: readonly Geometry[],
  expected: readonly Geometry[],
  context: string,
) {
  const tolerance = 0.5;
  expect(actual, `${context}: measured control count`).toHaveLength(expected.length);
  for (const [index, expectedRect] of expected.entries()) {
    const actualRect = actual[index];
    if (!actualRect) throw new Error(`${context}: missing control ${index}`);
    for (const key of ["height", "left", "top", "width"] as const) {
      expect(
        Math.abs(actualRect[key] - expectedRect[key]),
        `${context}: control ${index} ${key}`,
      ).toBeLessThanOrEqual(tolerance);
    }
  }
}

function statusControlGeometry() {
  const controls = [...document.querySelectorAll(".status-primary-control")];
  if (controls.length !== 2) throw new Error("Status primary controls are missing");
  return controls.map(geometry);
}

function routesSearchGeometry() {
  const search = document.querySelector(".routes-search-field");
  if (!search) throw new Error("Routes search control is missing");
  return [geometry(search)];
}

async function nextFrame() {
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function transition(scenario: StatusScenario) {
  flushSync(() => client.setScenario(scenario));
  await nextFrame();
}

let client: StatusLayoutClient;
let root: Root;

function renderPage(view: "routes" | "status", locale: Locales) {
  flushSync(() => {
    root.render(
      <TypesafeI18n key={`${view}-${locale}`} locale={locale}>
        <MemoryRouter>
          <ProductProvider client={client}>
            <NotificationDeliveryProvider>
              <TooltipProvider>
                <main>{view === "status" ? <StatusPage /> : <RoutesPage />}</main>
              </TooltipProvider>
            </NotificationDeliveryProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>,
    );
  });
}

beforeAll(async () => {
  loadAllLocales();
  document.documentElement.dataset.runtime = "browser";
  document.body.innerHTML = '<div id="status-layout-stability-root"></div>';
  const snapshot = await new FixtureStatusClient().getSnapshot();
  snapshot.adapterKind = "rpc";
  snapshot.capabilities = { systemProxy: "supported", tun: "supported" };
  snapshot.runtime.phase = "healthy";
  snapshot.recentTraffic = {
    authorityId: "browser-remount-authority",
    revision: 7,
    phase: "active",
    sessionId: "browser-remount-session",
    profileId: snapshot.activeProfileId,
    cadenceMilliseconds: 1_000,
    windowMilliseconds: 60_000,
    downloadedBytes: 2_048,
    uploadedBytes: 1_024,
    downloadBytesPerSecond: 1_024,
    uploadBytesPerSecond: 512,
    samples: [1, 2, 3].map((sequence) => ({
      sequence,
      offsetMilliseconds: sequence * 1_000,
      downloadBytesPerSecond: sequence * 1_024,
      uploadBytesPerSecond: sequence * 512,
    })),
  };
  const container = document.getElementById("status-layout-stability-root");
  if (!container) throw new Error("Missing status layout browser root");
  client = new StatusLayoutClient(snapshot);
  root = createRoot(container);
});

afterAll(() => {
  root.unmount();
  delete document.documentElement.dataset.runtime;
});

describe("primary-page status layout stability", () => {
  test("keeps Status routing and capture controls fixed through failure and recovery", async () => {
    const viewports = [
      { height: 720, width: 1024 },
      { height: 720, width: 360 },
    ];
    const scenarios = ["stale", "runtime-failure", "capture-failure", "drift"] as const;

    for (const locale of ["en", "zh"] as const) {
      for (const viewport of viewports) {
        await page.viewport(viewport.width, viewport.height);
        client.setScenario("happy");
        renderPage("status", locale);
        await vi.waitFor(() =>
          expect(document.querySelectorAll(".status-primary-control")).toHaveLength(2),
        );
        await nextFrame();
        const baseline = statusControlGeometry();
        expect(document.querySelector(".status-context-slot")).toBeNull();
        expect(document.querySelector('a[href="/events?diagnostics=1"]')).toBeNull();

        for (const scenario of scenarios) {
          await transition(scenario);
          expect(
            document.querySelector(".status-context-slot"),
            `${locale} ${viewport.width}px ${scenario}: no reserved slot`,
          ).toBeNull();
          expect(
            document.querySelector('a[href="/events?diagnostics=1"]'),
            `${locale} ${viewport.width}px ${scenario}: no inline diagnostics`,
          ).toBeNull();
          expectStableGeometry(
            statusControlGeometry(),
            baseline,
            `${locale} ${viewport.width}px ${scenario}`,
          );
        }

        await transition("happy");
        expect(document.querySelector('a[href="/events?diagnostics=1"]')).toBeNull();
        expect(document.querySelector(".status-context-slot")).toBeNull();
        expectStableGeometry(
          statusControlGeometry(),
          baseline,
          `${locale} ${viewport.width}px recovery`,
        );
      }
    }
  });

  test("starts Status controls at the top without reserved failure chrome", async () => {
    await page.viewport(360, 720);
    client.setScenario("happy");
    renderPage("status", "en");
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".status-primary-control")).toHaveLength(2),
    );
    await nextFrame();

    const firstControl = document.querySelector(".status-primary-control");
    const controlGrid = firstControl?.parentElement;
    if (!firstControl || !controlGrid) throw new Error("Missing Status controls");
    expect(firstControl.getBoundingClientRect().top - controlGrid.getBoundingClientRect().top).toBe(
      1,
    );
    expect(document.querySelector(".status-context-slot")).toBeNull();
    expect(document.querySelector('a[href="/events?diagnostics=1"]')).toBeNull();
  });

  test("renders the same authoritative Recent Traffic after a React remount", async () => {
    await page.viewport(1024, 720);
    client.setScenario("happy");
    renderPage("status", "en");
    await vi.waitFor(() =>
      expect(document.querySelectorAll(".traffic-session-copy > small")).toHaveLength(2),
    );
    const renderedTraffic = () => ({
      rates: [...document.querySelectorAll(".traffic-rate-value")].map((node) => node.textContent),
      totals: [...document.querySelectorAll(".traffic-session-copy > small")].map(
        (node) => node.textContent,
      ),
      charts: document.querySelectorAll(".traffic-sparkline .recharts-wrapper").length,
    });
    expect(renderedTraffic()).toEqual({
      rates: ["1 KB/s", "512 B/s"],
      totals: ["2 KB", "1 KB"],
      charts: 2,
    });

    root.unmount();
    const container = document.getElementById("status-layout-stability-root");
    if (!container) throw new Error("Missing Status layout browser root after remount");
    root = createRoot(container);
    renderPage("status", "en");
    await vi.waitFor(() => expect(renderedTraffic().charts).toBe(2));
    expect(renderedTraffic()).toEqual({
      rates: ["1 KB/s", "512 B/s"],
      totals: ["2 KB", "1 KB"],
      charts: 2,
    });
  });

  test("keeps the Routes search control fixed through stale and recovery", async () => {
    for (const width of [1024, 360]) {
      await page.viewport(width, 720);
      client.setScenario("happy");
      renderPage("routes", "en");
      await vi.waitFor(() => expect(document.querySelector(".routes-search-field")).not.toBeNull());
      await nextFrame();
      const baseline = routesSearchGeometry();
      expect(document.querySelector(".routes-connection-slot")).toBeNull();

      await transition("stale");
      expect(document.querySelector(".routes-connection-slot")).toBeNull();
      expectStableGeometry(routesSearchGeometry(), baseline, `${width}px Routes stale`);

      await transition("happy");
      expectStableGeometry(routesSearchGeometry(), baseline, `${width}px Routes recovery`);
    }
  });
});
