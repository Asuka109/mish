import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "@mish/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../app";
import { AppearanceProvider } from "../appearance";
import { EventsProvider } from "../data/events-provider";
import { FixtureEventsClient } from "../data/fixture-events-client";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";

loadAllLocales();

function renderEvents(client: FixtureEventsClient) {
  return render(
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
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Events page", () => {
  it("labels browser data as fictional and exposes every unsupported source explicitly", async () => {
    renderEvents(new FixtureEventsClient());

    expect(await screen.findByText(/Fictional browser fixture events/)).toBeVisible();
    expect(screen.getAllByText("Fixture only")).toHaveLength(4);
    expect(screen.queryByRole("button", { name: /export|upload/i })).not.toBeInTheDocument();
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

    const run = await screen.findByRole("button", { name: "Run diagnostics" });
    expect(screen.getByText(/Fictional browser fixture results/)).toBeVisible();
    expect(screen.queryByText("Synthetic fixture DNS failure")).not.toBeInTheDocument();

    run.focus();
    await user.keyboard("{Enter}");

    expect(await screen.findByText("Synthetic fixture DNS failure")).toBeVisible();
    expect(screen.getAllByText("Observed fact").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Interpretation").length).toBeGreaterThan(0);
    expect(screen.getByText(/mish-guided-diagnostics-fixture-v1/)).toBeVisible();
    expect(screen.getByText(/not a desktop diagnostic run/i)).toBeVisible();
    expect(screen.queryByRole("button", { name: /export|upload/i })).not.toBeInTheDocument();
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
});
