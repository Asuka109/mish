import type {
  ApplicationSnapshotDelivery,
  EventsClient,
  EventsConnectionState,
  EventsSnapshotDto,
} from "@mish/contracts";
import { TooltipProvider } from "@mish/ui";
import { page } from "vitest/browser";
import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router";
import { AppRoutes } from "../app";
import { AppearanceProvider } from "../appearance";
import { EventsProvider } from "../data/events-provider";
import { FixtureEventsClient } from "../data/fixture-events-client";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import "../styles.css";

class ConflictingEventsClient implements EventsClient {
  private readonly listeners = new Set<
    (snapshot: EventsSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private snapshot!: EventsSnapshotDto;

  async initialize() {
    this.snapshot = await new FixtureEventsClient().getSnapshot();
  }

  dispose() {
    this.listeners.clear();
  }

  getConnectionState(): EventsConnectionState {
    return { attempt: 0, phase: "fixture", stale: false };
  }

  async getSnapshot() {
    return structuredClone(this.snapshot);
  }

  subscribeConnection(listener: (state: EventsConnectionState) => void) {
    listener(this.getConnectionState());
    return () => undefined;
  }

  subscribeSnapshots(
    listener: (snapshot: EventsSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishConflict() {
    const conflict = { ...structuredClone(this.snapshot), phase: "stale" as const };
    for (const listener of this.listeners) listener(conflict, "update");
  }
}

let client: ConflictingEventsClient;
let root: Root;

beforeAll(async () => {
  loadAllLocales();
  await page.viewport(800, 600);
  document.body.innerHTML = '<div id="events-error-layout-root"></div>';
  client = new ConflictingEventsClient();
  await client.initialize();
  const container = document.getElementById("events-error-layout-root");
  if (!container) throw new Error("Missing Events error layout root");
  root = createRoot(container);
  root.render(
    <AppearanceProvider>
      <TypesafeI18n locale="en">
        <MemoryRouter initialEntries={["/events"]}>
          <ProductProvider>
            <EventsProvider client={client}>
              <TooltipProvider>
                <AppRoutes />
              </TooltipProvider>
            </EventsProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
  await vi.waitFor(() => {
    expect(document.querySelector(".events-body")).not.toBeNull();
    expect(document.querySelector(".route-loading")).toBeNull();
  });
});

afterAll(() => {
  root.unmount();
  client.dispose();
});

describe("Events error geometry", () => {
  test("keeps the fixed header and body viewport stable when typed loading fails", async () => {
    const workspace = document.querySelector<HTMLElement>(".workspace-page-scroll");
    const body = document.querySelector<HTMLElement>(".events-body");
    const heading = document.querySelector<HTMLElement>(".events-heading");
    if (!workspace || !body || !heading) throw new Error("Missing Events error geometry");
    workspace.scrollTop = 0;
    const before = {
      bodyHeight: body.clientHeight,
      bodyTop: body.getBoundingClientRect().top,
      headingTop: heading.getBoundingClientRect().top,
      workspaceHeight: workspace.clientHeight,
    };

    client.publishConflict();
    await expect
      .element(page.getByText("Events could not be loaded.", { exact: true }))
      .toBeVisible();

    expect(workspace.scrollTop).toBe(0);
    expect(workspace.scrollHeight).toBe(workspace.clientHeight);
    expect(workspace.clientHeight).toBe(before.workspaceHeight);
    expect(body.clientHeight).toBe(before.bodyHeight);
    expect(body.getBoundingClientRect().top).toBe(before.bodyTop);
    expect(heading.getBoundingClientRect().top).toBe(before.headingTop);
  });
});
