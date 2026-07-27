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
    expect(screen.getByRole("button", { name: "Preview Support Bundle" })).toBeDisabled();
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

    await user.click(screen.getByRole("button", { name: "Pause View" }));
    const before = await client.getSnapshot();
    client.publishSnapshot({
      ...before,
      events: [
        ...before.events,
        {
          application: null,
          evidence: { detail: null, message: "Buffered while paused" },
          id: "fixture-events:4",
          level: "info",
          observedAt: Date.parse("2026-07-18T08:00:03Z"),
          sequence: 4,
          source: "core",
        },
      ],
      sequence: 4,
    });
    expect(await screen.findByText(/1 newer events remain buffered/)).toBeVisible();
    expect(screen.queryByText("Buffered while paused")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Resume View" }));
    expect(await screen.findByText("Buffered while paused")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Pause View" }));
    await user.click(screen.getByRole("button", { name: "Clear Local" }));
    expect(await screen.findByText("No local events")).toBeVisible();
    expect((await client.getSnapshot()).events).toHaveLength(4);
  });

  it("keeps the wide toolbar controls icon-only, named, focusable, and actionable", async () => {
    const user = userEvent.setup();
    renderEvents(new FixtureEventsClient());

    const pause = await screen.findByRole("button", { name: "Pause View" });
    const follow = screen.getByRole("button", { name: "Following latest" });
    const clear = screen.getByRole("button", { name: "Clear Local" });

    for (const control of [pause, follow, clear]) {
      expect(control).toHaveClass("events-toolbar-button", "ui-button--icon-sm");
      expect(control.querySelector("svg")).toBeInTheDocument();
      control.focus();
      expect(control).toHaveFocus();
    }

    await user.click(pause);
    expect(await screen.findByRole("button", { name: "Resume View" })).toBeVisible();
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
          application: null,
          evidence: {
            detail: "token=[redacted] path=[redacted-path]",
            message: "Request to [redacted-url] failed",
          },
          id: "fixture-events:safe",
          level: "error",
          observedAt: Date.parse("2026-07-18T08:00:04Z"),
          sequence: 4,
          source: "core",
        },
      ],
      sequence: 4,
    });
    renderEvents(client);
    await screen.findByText("Request to [redacted-url] failed");

    await user.click(screen.getByRole("button", { name: "Copy Safe Event Text" }));
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("[redacted-url]"));
    expect(writeText.mock.calls[0]?.[0]).not.toContain("fixture.invalid/list?token=");
  });

  it("previews exact bounded categories before an explicit keyboard-confirmed native save", async () => {
    const user = userEvent.setup();
    const support = new TestSupportBundleClient("written");
    renderEvents(new FixtureEventsClient(), support);

    const preview = await findEnabledButton("Preview Support Bundle");
    await waitForInitialRouteReady();
    preview.focus();
    await user.keyboard("{Enter}");

    const dialog = await screen.findByRole("dialog", { name: "Review redacted support bundle" });
    expect(within(dialog).getByText("JSON · v2")).toBeVisible();
    expect(within(dialog).getByText("Actual / maximum size").parentElement).toHaveTextContent(
      "12.0 KiB / 256.0 KiB",
    );
    expect(within(dialog).getByText("Recent event aggregates")).toBeVisible();
    expect(within(dialog).getByText(/Subscription URLs/)).toBeVisible();
    expect(support.save).not.toHaveBeenCalled();

    const confirmSave = within(dialog).getByRole("button", {
      name: "Choose Location and Save",
    });
    confirmSave.focus();
    await user.keyboard("{Enter}");
    expect(support.save).toHaveBeenCalledWith("preview-support-bundle-1", {
      signal: expect.any(AbortSignal),
    });
    expect(await screen.findByText("Support bundle saved locally.")).toBeVisible();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("treats a native save cancellation as neither a write nor a failure", async () => {
    const user = userEvent.setup();
    const support = new TestSupportBundleClient("cancelled");
    renderEvents(new FixtureEventsClient(), support);

    await user.click(await findEnabledButton("Preview Support Bundle"));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Choose Location and Save",
      }),
    );

    expect(await screen.findByText("Save cancelled. Nothing was written.")).toBeVisible();
    expect(screen.queryByText("Support bundle saved locally.")).not.toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("reports path-free save failure without mutating the Events surface", async () => {
    const user = userEvent.setup();
    const support = new TestSupportBundleClient("failed");
    renderEvents(new FixtureEventsClient(), support);
    await screen.findByRole("heading", { name: "Events" });

    await user.click(await findEnabledButton("Preview Support Bundle"));
    await user.click(
      within(await screen.findByRole("dialog")).getByRole("button", {
        name: "Choose Location and Save",
      }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "The support bundle could not be saved. No runtime state was changed.",
    );
    expect(screen.getByRole("heading", { name: "Events" })).toBeVisible();
    expect(screen.queryByText(/synthetic\/|bundle\.json/)).not.toBeInTheDocument();
  });
});

const supportBundlePreview: SupportBundlePreviewDto = {
  categories: [
    { category: "application", itemCount: 1 },
    { category: "activation", itemCount: 1 },
    { category: "platform", itemCount: 1 },
    { category: "capabilities", itemCount: 1 },
    { category: "active-profile", itemCount: 1 },
    { category: "capture", itemCount: 1 },
    { category: "service-probes", itemCount: 4 },
    { category: "events-summary", itemCount: 12 },
    { category: "redaction-report", itemCount: 12 },
    { category: "termination-recovery-evidence", itemCount: 0 },
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
  ],
  fileType: "application/json",
  formatVersion: 2,
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
