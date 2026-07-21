import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "@mish/ui";
import type { SupportBundleClient, SupportBundlePreviewDto } from "@mish/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../app";
import { AppearanceProvider } from "../appearance";
import { EventsProvider } from "../data/events-provider";
import { FixtureEventsClient } from "../data/fixture-events-client";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";

loadAllLocales();

function renderEvents(client: FixtureEventsClient, supportBundleClient?: SupportBundleClient) {
  return render(
    <AppearanceProvider>
      <TypesafeI18n locale="en">
        <MemoryRouter initialEntries={["/events"]}>
          <ProductProvider>
            <EventsProvider client={client} supportBundleClient={supportBundleClient}>
              <TooltipProvider>
                <AppRoutes />
              </TooltipProvider>
            </EventsProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
}

async function findEnabledButton(name: string) {
  const button = await screen.findByRole("button", { name });
  await waitFor(() => expect(button).toBeEnabled());
  return button;
}

async function waitForInitialRouteReady() {
  const heading = screen.getByRole("heading", { level: 1 });
  await waitFor(() => expect(document.title).toBe("Events — Mish"));
  expect(heading).not.toHaveFocus();
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Events page", () => {
  it("labels browser data as fictional and exposes every unsupported source explicitly", async () => {
    const view = renderEvents(new FixtureEventsClient());

    expect(await screen.findByText(/Fictional demo events/)).toBeVisible();
    const sources = screen.getByRole("region", { name: "Event sources" });
    expect(
      within(sources).getByText(
        "Shows which local sources can contribute messages to the event list below.",
      ),
    ).toBeVisible();
    expect(within(sources).getAllByText("Fixture only")).toHaveLength(4);
    expect(within(sources).queryByText(/Synthetic browser-only fixture/)).not.toBeInTheDocument();
    expect(view.container.querySelectorAll(".events-source-indicator")).toHaveLength(4);
    expect(screen.getByRole("button", { name: "Preview support bundle" })).toBeDisabled();
    expect(screen.getByText(/unavailable in demo mode/i)).toBeVisible();
  });

  it("filters text, pauses the view while buffering, resumes, and clears only local memory", async () => {
    const user = userEvent.setup();
    const client = new FixtureEventsClient();
    renderEvents(client);
    await screen.findByText(/Synthetic DNS lookup timed out/);

    const search = screen.getByRole("searchbox", { name: "Search Events" });
    await user.type(search, "route check");
    expect(screen.getByText("Synthetic route check failed")).toBeVisible();
    expect(screen.queryByText(/Synthetic DNS lookup timed out/)).not.toBeInTheDocument();
    await user.clear(search);

    await user.click(screen.getByRole("button", { name: "Pause view" }));
    const before = await client.getSnapshot();
    client.publishSnapshot({
      ...before,
      events: [
        ...before.events,
        {
          detail: null,
          id: "fixture-events:4",
          level: "info",
          message: "Buffered while paused",
          observedAt: Date.parse("2026-07-18T08:00:03Z"),
          sequence: 4,
          source: "core",
        },
      ],
      sequence: 4,
    });
    expect(await screen.findByText(/1 newer events remain buffered/)).toBeVisible();
    expect(screen.queryByText("Buffered while paused")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resume view" }));
    expect(await screen.findByText("Buffered while paused")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pause view" }));
    await user.click(screen.getByRole("button", { name: "Clear local" }));
    expect(await screen.findByText("No local events")).toBeVisible();
    expect((await client.getSnapshot()).events).toHaveLength(4);
  });

  it("copies only the selected already-redacted event text", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText } });
    const client = new FixtureEventsClient();
    const snapshot = await client.getSnapshot();
    client.publishSnapshot({
      ...snapshot,
      events: [
        {
          detail: "token=[redacted] path=[redacted-path]",
          id: "fixture-events:safe",
          level: "error",
          message: "Request to [redacted-url] failed",
          observedAt: Date.parse("2026-07-18T08:00:04Z"),
          sequence: 4,
          source: "core",
        },
      ],
      sequence: 4,
    });
    renderEvents(client);
    await screen.findByText("Request to [redacted-url] failed");

    await user.click(screen.getByRole("button", { name: "Copy safe event text" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("[redacted-url]"));
    expect(writeText.mock.calls[0]?.[0]).not.toContain("fixture.invalid/list?token=");
  });

  it("runs only on explicit keyboard activation and separates observation from interpretation", async () => {
    const user = userEvent.setup();
    renderEvents(new FixtureEventsClient());

    const run = await findEnabledButton("Run diagnostics");
    expect(screen.getByText(/Fictional demo results/)).toBeVisible();
    expect(screen.queryByText("Synthetic fixture DNS failure")).not.toBeInTheDocument();

    await waitForInitialRouteReady();
    run.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByText("Synthetic fixture DNS failure")).toBeVisible();
    expect(screen.getAllByText("Observed fact").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Interpretation").length).toBeGreaterThan(0);
    expect(screen.getByText(/mish-guided-diagnostics-fixture-v1/)).toBeVisible();
    expect(screen.getByText(/not an operational diagnostic run/i)).toBeVisible();
    expect(screen.getByRole("button", { name: "Preview support bundle" })).toBeDisabled();
  });

  it("links common failure events to the focusable diagnostics section", async () => {
    const user = userEvent.setup();
    renderEvents(new FixtureEventsClient());
    await screen.findByText(/Synthetic DNS lookup timed out/);

    const links = screen.getAllByRole("link", { name: "Open diagnostics" });
    expect(links[0]).toHaveAttribute("href", "/events?diagnostics=1");
    await user.click(links[0]);

    expect(screen.getByRole("region", { name: "Guided diagnostics" })).toHaveFocus();
  });

  it("retains complete scoped result labels in a narrow window", async () => {
    vi.stubGlobal("innerWidth", 560);
    window.dispatchEvent(new Event("resize"));
    const user = userEvent.setup();
    renderEvents(new FixtureEventsClient());
    await user.click(await screen.findByRole("button", { name: "Run diagnostics" }));

    const diagnostics = screen.getByRole("region", { name: "Guided diagnostics" });
    expect(within(diagnostics).getAllByText("Scope").length).toBeGreaterThan(0);
    expect(within(diagnostics).getAllByText("Route target").length).toBeGreaterThan(0);
    expect(within(diagnostics).getAllByText("Observed fact").length).toBeGreaterThan(0);
    expect(within(diagnostics).getAllByText("Interpretation").length).toBeGreaterThan(0);
  });

  it("previews exact bounded categories before an explicit keyboard-confirmed native save", async () => {
    const user = userEvent.setup();
    const support = new TestSupportBundleClient("written");
    renderEvents(new FixtureEventsClient(), support);

    const preview = await findEnabledButton("Preview support bundle");
    await waitForInitialRouteReady();
    preview.focus();
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog", { name: "Review redacted support bundle" });
    expect(within(dialog).getByText("JSON · v1")).toBeVisible();
    expect(within(dialog).getByText("Actual / maximum size").parentElement).toHaveTextContent(
      "12.0 KiB / 256.0 KiB",
    );
    expect(within(dialog).getByText("Recent event aggregates")).toBeVisible();
    expect(within(dialog).getByText(/Subscription URLs/)).toBeVisible();
    expect(support.save).not.toHaveBeenCalled();

    const confirmSave = within(dialog).getByRole("button", {
      name: "Choose location and save",
    });
    confirmSave.focus();
    await user.keyboard("{Enter}");
    expect(support.save).toHaveBeenCalledWith("preview-support-bundle-1");
    expect(await screen.findByText("Support bundle saved locally.")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("treats a native save cancellation as neither a write nor a failure", async () => {
    const user = userEvent.setup();
    const support = new TestSupportBundleClient("cancelled");
    renderEvents(new FixtureEventsClient(), support);

    await user.click(await findEnabledButton("Preview support bundle"));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Choose location and save",
      }),
    );

    expect(await screen.findByText("Save cancelled. Nothing was written.")).toBeVisible();
    expect(screen.queryByText("Support bundle saved locally.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports path-free save failure without mutating diagnostic history", async () => {
    const user = userEvent.setup();
    const support = new TestSupportBundleClient("failed");
    renderEvents(new FixtureEventsClient(), support);
    await screen.findByText("No diagnostic runs in local history.");

    await user.click(await findEnabledButton("Preview support bundle"));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Choose location and save",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The support bundle could not be saved. No runtime state was changed.",
    );
    expect(screen.getByText("No diagnostic runs in local history.")).toBeVisible();
    expect(screen.queryByText(/synthetic\/|bundle\.json/)).not.toBeInTheDocument();
  });
});

const supportBundlePreview: SupportBundlePreviewDto = {
  categories: [
    { category: "application", itemCount: 1 },
    { category: "platform", itemCount: 1 },
    { category: "capabilities", itemCount: 1 },
    { category: "active-profile", itemCount: 1 },
    { category: "capture", itemCount: 1 },
    { category: "events-summary", itemCount: 12 },
    { category: "diagnostic-runs", itemCount: 7 },
    { category: "redaction-report", itemCount: 13 },
  ],
  contentBytes: 12_288,
  excludedOrRedacted: [
    "raw-profile-configuration",
    "subscription-urls",
    "credentials-and-secrets",
    "full-paths",
    "node-labels",
    "connection-destinations",
    "process-paths",
    "network-addresses-and-hostnames",
    "private-endpoints",
    "controller-payloads",
    "status-bar-labels",
    "event-text",
    "diagnostic-prose",
  ],
  fileType: "application/json",
  formatVersion: 1,
  maxBytes: 256 * 1_024,
  previewId: "preview-support-bundle-1",
  timeRange: {
    endedAt: Date.parse("2026-07-18T08:05:00Z"),
    startedAt: Date.parse("2026-07-18T08:00:00Z"),
  },
};

class TestSupportBundleClient implements SupportBundleClient {
  readonly availability = "supported" as const;
  readonly preview = vi.fn(async () => structuredClone(supportBundlePreview));
  readonly save: SupportBundleClient["save"];

  constructor(result: "cancelled" | "written" | "failed") {
    this.save = vi.fn(async () => {
      if (result === "failed") throw new Error("/synthetic/private/bundle.json");
      return { status: result };
    });
  }
}
