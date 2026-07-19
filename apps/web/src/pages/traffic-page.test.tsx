import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "@mish/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppRoutes } from "../app";
import { AppearanceProvider } from "../appearance";
import { ProductProvider } from "../data/product-provider";
import { FixtureTrafficClient } from "../data/fixture-traffic-client";
import type {
  TrafficCommandAuthorityDto,
  TrafficCommandOperation,
  TrafficCommandResultDto,
} from "@mish/contracts";
import { TrafficProvider } from "../data/traffic-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";

loadAllLocales();

function renderTraffic(client: FixtureTrafficClient) {
  return render(
    <AppearanceProvider>
      <TypesafeI18n locale="en">
        <MemoryRouter initialEntries={["/traffic"]}>
          <ProductProvider>
            <TrafficProvider client={client}>
              <TooltipProvider>
                <AppRoutes />
              </TooltipProvider>
            </TrafficProvider>
          </ProductProvider>
        </MemoryRouter>
      </TypesafeI18n>
    </AppearanceProvider>,
  );
}

class CommandTrafficClient extends FixtureTrafficClient {
  supportsCommand(_command: TrafficCommandOperation) {
    return true;
  }

  async closeConnection(
    _authority: TrafficCommandAuthorityDto,
    connectionId: string,
  ): Promise<TrafficCommandResultDto> {
    const before = await this.getSnapshot();
    const snapshot = {
      ...before,
      activeConnections: before.activeConnections.filter(
        (connection) => connection.id !== connectionId,
      ),
      sequence: before.sequence + 1,
    };
    this.publishSnapshot(snapshot);
    return {
      failure: null,
      operation: "close-connection",
      remainingConnectionIds: [],
      snapshot,
      status: "success",
      targetCount: 1,
    };
  }

  async closeAllActive(_authority: TrafficCommandAuthorityDto): Promise<TrafficCommandResultDto> {
    const before = await this.getSnapshot();
    const snapshot = { ...before, activeConnections: [], sequence: before.sequence + 1 };
    this.publishSnapshot(snapshot);
    return {
      failure: null,
      operation: "close-all-active",
      remainingConnectionIds: [],
      snapshot,
      status: "success",
      targetCount: before.activeConnections.length,
    };
  }
}

async function commandClient() {
  const client = new CommandTrafficClient();
  const snapshot = await client.getSnapshot();
  client.publishSnapshot({ ...snapshot, adapterKind: "rpc" });
  return client;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Traffic page", () => {
  it("renders fictional active observations, explicitly unsupported close controls, and complete row detail", async () => {
    const user = userEvent.setup();
    renderTraffic(new FixtureTrafficClient());

    expect(await screen.findByText(/Fictional local fixture data/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Close all active connections" })).toBeDisabled();
    const row = screen.getByRole("row", { name: /docs\.fixture\.invalid/ });
    expect(within(row).getByText("Fixture Browser")).toBeVisible();
    expect(within(row).getByText(/Fixture Policy → Fixture Relay → Fixture Exit/)).toBeVisible();
    expect(within(row).getByRole("button", { name: "Close" })).toBeDisabled();

    await user.click(within(row).getByRole("button", { name: /docs\.fixture\.invalid/ }));
    const dialog = screen.getByRole("dialog", { name: "Connection details" });
    const chain = within(dialog).getByRole("list");
    expect(within(chain).getAllByRole("listitem")).toHaveLength(3);
    expect(chain).toHaveTextContent("Fixture Policy");
    expect(chain).toHaveTextContent("Fixture Relay");
    expect(chain).toHaveTextContent("Fixture Exit");
    expect(dialog).toHaveTextContent("/synthetic/apps/fixture-browser");
  });

  it("closes one only after confirmation and preserves it in local Closed history", async () => {
    const user = userEvent.setup();
    renderTraffic(await commandClient());
    const row = await screen.findByRole("row", { name: /docs\.fixture\.invalid/ });

    await user.click(within(row).getByRole("button", { name: "Close" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Close this active connection?" });
    expect(confirmation).toHaveTextContent("stable connection ID");
    await user.click(within(confirmation).getByRole("button", { name: "Close connection" }));

    expect(screen.queryByText("docs.fixture.invalid")).not.toBeInTheDocument();
    await user.click(screen.getByRole("tab", { name: /Closed/ }));
    expect(await screen.findByText("docs.fixture.invalid")).toBeVisible();
  });

  it("closes all current active connections regardless of filters and supports keyboard cancel", async () => {
    const user = userEvent.setup();
    renderTraffic(await commandClient());
    await screen.findByText("Fixture Browser");
    const search = screen.getByRole("textbox", { name: "Search Traffic" });
    await user.type(search, "process:browser");
    expect(screen.getAllByRole("row")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Close all active connections" }));
    let confirmation = screen.getByRole("alertdialog", {
      name: "Close all currently active connections?",
    });
    expect(confirmation).toHaveTextContent("all 6 connections");
    expect(confirmation).toHaveTextContent("hidden by the current search");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close all active connections" }));
    confirmation = screen.getByRole("alertdialog", {
      name: "Close all currently active connections?",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "Close all active connections" }),
    );
    expect(await screen.findByText("No matches")).toBeVisible();
    await user.clear(search);
    expect(await screen.findByText("No active connections")).toBeVisible();
    await user.click(screen.getByRole("tab", { name: /Closed/ }));
    expect(screen.getByRole("tab", { name: /Closed 6/ })).toBeVisible();
  });

  it("derives Closed locally, filters structured fields, and clears only local history", async () => {
    const user = userEvent.setup();
    const client = new FixtureTrafficClient();
    renderTraffic(client);
    await screen.findByText("Fixture Browser");
    const before = await client.getSnapshot();
    client.publishSnapshot({
      ...before,
      activeConnections: before.activeConnections.slice(1),
      sequence: before.sequence + 1,
    });

    await user.click(screen.getByRole("tab", { name: /Closed/ }));
    expect(await screen.findByText("docs.fixture.invalid")).toBeVisible();
    const search = screen.getByRole("textbox", { name: "Search Traffic" });
    await user.type(search, "process:browser chain:relay state:closed");
    expect(screen.getByText("docs.fixture.invalid")).toBeVisible();
    await user.clear(search);
    await user.type(search, "process:missing");
    expect(await screen.findByText("No matches")).toBeVisible();
    await user.clear(search);

    await user.click(screen.getByRole("button", { name: "Clear Closed" }));
    expect(await screen.findByText("No recently closed connections")).toBeVisible();
    expect((await client.getSnapshot()).activeConnections).toHaveLength(5);
  });

  it("searches ordered Rules and distinguishes disabled entries", async () => {
    const user = userEvent.setup();
    renderTraffic(new FixtureTrafficClient());
    await screen.findByText("Fixture Browser");
    await user.click(screen.getByRole("tab", { name: /Rules/ }));
    const search = screen.getByRole("textbox", { name: "Search Traffic" });
    await user.type(search, "enabled:false target:reject");

    const row = await screen.findByRole("row", { name: /unused\.fixture\.invalid/ });
    expect(row).toHaveTextContent("Disabled");
    expect(screen.queryByRole("row", { name: /Fixture Development/ })).not.toBeInTheDocument();
  });

  it("hides retained Active rows whenever the observation snapshot is stale", async () => {
    const client = new FixtureTrafficClient();
    renderTraffic(client);
    await screen.findByText("Fixture Browser");
    const snapshot = await client.getSnapshot();
    client.publishSnapshot({ ...snapshot, adapterKind: "rpc", phase: "stale", sequence: 2 });

    expect(await screen.findByText(/Traffic observation is stale/)).toBeVisible();
    expect(screen.queryByText("Fixture Browser")).not.toBeInTheDocument();
    expect(screen.getByText("No active connections")).toBeVisible();
  });

  it("keeps large snapshots bounded to incremental render batches", async () => {
    const client = new FixtureTrafficClient();
    const snapshot = await client.getSnapshot();
    const template = snapshot.activeConnections[0];
    client.publishSnapshot({
      ...snapshot,
      activeConnections: Array.from({ length: 2_000 }, (_, index) => ({
        ...template,
        destinationHost: `row-${index.toString().padStart(4, "0")}.fixture.invalid`,
        id: `large-fixture-${index}`,
      })),
      sequence: 2,
    });
    const user = userEvent.setup();
    renderTraffic(client);

    await screen.findByText("Showing 250 of 2000");
    expect(screen.getAllByRole("row")).toHaveLength(251);
    await user.click(screen.getByRole("button", { name: "Show more" }));
    expect(screen.getAllByRole("row")).toHaveLength(501);
  }, 10_000);

  it("keeps destination, process, IP, and path fixtures local", async () => {
    const webSocket = vi.fn();
    const fetch = vi.fn();
    vi.stubGlobal("WebSocket", webSocket);
    vi.stubGlobal("fetch", fetch);
    const client = new FixtureTrafficClient();
    const snapshot = await client.getSnapshot();
    renderTraffic(client);
    await screen.findByText("Fixture Browser");

    expect(webSocket).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
    expect(
      snapshot.activeConnections.every(
        (item) => item.destinationHost?.endsWith(".invalid") ?? true,
      ),
    ).toBe(true);
    expect(
      snapshot.activeConnections.every(
        (item) => item.processPath?.startsWith("/synthetic/") ?? true,
      ),
    ).toBe(true);
    expect(JSON.stringify(snapshot)).not.toMatch(/token|credential|subscription/iu);
    expect(screen.queryByRole("button", { name: /copy|export/i })).not.toBeInTheDocument();
  });
});
