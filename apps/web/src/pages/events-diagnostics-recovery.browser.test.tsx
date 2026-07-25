import { TooltipProvider } from "@mish/ui";
import type { DiagnosticHistoryDto, DiagnosticsClient } from "@mish/contracts";
import { page } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppearanceProvider } from "../appearance";
import { EventsProvider } from "../data/events-provider";
import { FixtureDiagnosticsClient } from "../data/fixture-diagnostics-client";
import { FixtureEventsClient } from "../data/fixture-events-client";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { EventsPage } from "./events-page";
import "../styles.css";

class RecoveringBrowserDiagnosticsClient implements DiagnosticsClient {
  private completeRefresh: (() => void) | null = null;
  private historyRequests = 0;
  private rejectRefresh: (() => void) | null = null;
  private readonly emptyHistory: DiagnosticHistoryDto;
  private readonly runningHistory: DiagnosticHistoryDto;

  constructor(private readonly completedHistory: DiagnosticHistoryDto) {
    const run = completedHistory.runs[0]!;
    this.emptyHistory = {
      activeRunId: null,
      adapterKind: "rpc",
      runs: [],
    };
    this.runningHistory = {
      activeRunId: run.id,
      adapterKind: "rpc",
      runs: [{ ...run, checks: [], finishedAt: null, status: "running" }],
    };
  }

  async cancelRun() {
    return structuredClone(this.completedHistory);
  }

  dispose() {}

  failRefresh() {
    this.rejectRefresh?.();
  }

  async getHistory() {
    this.historyRequests += 1;
    if (this.historyRequests === 1) return structuredClone(this.emptyHistory);
    if (this.historyRequests === 2) {
      return new Promise<DiagnosticHistoryDto>((_resolve, reject) => {
        this.rejectRefresh = () => reject(new Error("transient local RPC interruption"));
      });
    }
    return new Promise<DiagnosticHistoryDto>((resolve) => {
      this.completeRefresh = () => resolve(structuredClone(this.completedHistory));
    });
  }

  hasPendingFailure() {
    return this.rejectRefresh !== null;
  }

  hasPendingRecovery() {
    return this.completeRefresh !== null;
  }

  recover() {
    this.completeRefresh?.();
  }

  async startRun() {
    return structuredClone(this.runningHistory);
  }
}

function rectTuple(element: Element) {
  const rect = element.getBoundingClientRect();
  return [rect.x, rect.y, rect.width, rect.height].map((value) => Math.round(value * 100) / 100);
}

function diagnosticGeometry() {
  const run = document.querySelector(".diagnostic-run");
  const supportBundle = document.querySelector(".support-bundle-section");
  if (!run || !supportBundle) throw new Error("Missing diagnostic layout evidence");
  return {
    run: rectTuple(run),
    supportBundle: rectTuple(supportBundle),
  };
}

let client: RecoveringBrowserDiagnosticsClient;
let root: Root;

beforeAll(async () => {
  await page.viewport(390, 844);
  loadAllLocales();
  document.body.innerHTML = '<div id="events-diagnostics-recovery-root"></div>';
  const fixtureHistory = await new FixtureDiagnosticsClient().startRun();
  client = new RecoveringBrowserDiagnosticsClient({
    ...fixtureHistory,
    adapterKind: "rpc",
    runs: fixtureHistory.runs.map((run) => ({ ...run, adapterKind: "rpc" })),
  });
  const container = document.getElementById("events-diagnostics-recovery-root");
  if (!container) throw new Error("Missing diagnostic recovery browser root");
  root = createRoot(container);
  root.render(
    <AppearanceProvider initialPreference="light" initialWindowSurfacePreference="opaque">
      <TypesafeI18n locale="en">
        <MemoryRouter initialEntries={["/events"]}>
          <ProductProvider>
            <EventsProvider client={new FixtureEventsClient()} diagnosticsClient={client}>
              <TooltipProvider>
                <EventsPage />
              </TooltipProvider>
            </EventsProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
  await vi.waitFor(() => {
    expect(document.querySelector(".diagnostics-section")?.textContent).toContain(
      "No diagnostic runs in local history.",
    );
  });
});

afterAll(() => root.unmount());

describe("diagnostic recovery layout", () => {
  test("recovers one failed refresh without shifting a narrow running result", async () => {
    await page.getByRole("button", { exact: true, name: "Run Diagnostics" }).click();
    await expect.element(page.getByText("Running", { exact: true })).toBeVisible();
    await vi.waitFor(() => expect(client.hasPendingFailure()).toBe(true));
    const before = diagnosticGeometry();

    client.failRefresh();

    await expect
      .element(page.getByText("Diagnostics are currently unavailable.", { exact: true }))
      .toBeVisible();
    expect(diagnosticGeometry()).toEqual(before);
    await vi.waitFor(() => expect(client.hasPendingRecovery()).toBe(true));
    client.recover();

    await expect.element(page.getByText("Completed", { exact: true })).toBeVisible();
    await expect
      .element(page.getByText("Diagnostics are currently unavailable.", { exact: true }))
      .not.toBeInTheDocument();
    expect(
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ).toBeLessThanOrEqual(1);
  });
});
