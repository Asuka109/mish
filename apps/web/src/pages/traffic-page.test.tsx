import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { TooltipProvider } from "@mish/ui";
import { afterEach, describe, expect, it, vi } from "vitest";
import { toast } from "sonner";
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
import type { Locales } from "../i18n/i18n-types";
import { loadAllLocales } from "../i18n/i18n-util.sync";

loadAllLocales();

function renderTraffic(
  client: FixtureTrafficClient,
  locale: Locales = "en",
  initialEntry = "/traffic",
) {
  return render(
    <AppearanceProvider>
      <TypesafeI18n locale={locale}>
        <MemoryRouter initialEntries={[initialEntry]}>
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

  async closeFilteredVisible(
    _authority: TrafficCommandAuthorityDto,
    connectionIds: string[],
  ): Promise<TrafficCommandResultDto> {
    const before = await this.getSnapshot();
    const targets = new Set(connectionIds);
    const snapshot = {
      ...before,
      activeConnections: before.activeConnections.filter(
        (connection) => !targets.has(connection.id),
      ),
      sequence: before.sequence + 1,
    };
    this.publishSnapshot(snapshot);
    return {
      failure: null,
      operation: "close-filtered-visible",
      remainingConnectionIds: [],
      snapshot,
      status: "success",
      targetCount: connectionIds.length,
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

class FailingTrafficClient extends CommandTrafficClient {
  override async closeAllActive(
    _authority: TrafficCommandAuthorityDto,
  ): Promise<TrafficCommandResultDto> {
    const snapshot = await this.getSnapshot();
    return {
      failure: "controller-rejected",
      operation: "close-all-active",
      remainingConnectionIds: snapshot.activeConnections.map(({ id }) => id),
      snapshot,
      status: "failure",
      targetCount: snapshot.activeConnections.length,
    };
  }
}

class PendingFilteredTrafficClient extends CommandTrafficClient {
  private readonly gate: Promise<void>;
  release!: () => void;

  constructor() {
    super();
    this.gate = new Promise((resolve) => {
      this.release = resolve;
    });
  }

  override async closeFilteredVisible(
    authority: TrafficCommandAuthorityDto,
    connectionIds: string[],
  ): Promise<TrafficCommandResultDto> {
    await this.gate;
    return super.closeFilteredVisible(authority, connectionIds);
  }
}

class IconTrafficClient extends FixtureTrafficClient {
  readonly iconRequests: string[] = [];

  override async getProcessIcon(connectionId: string) {
    this.iconRequests.push(connectionId);
    return {
      dataUrl:
        connectionId === "fixture-connection-1"
          ? ("data:image/png;base64,iVBORw0KGgo=" as const)
          : null,
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
  it("preserves the requested Traffic tab when the initial baseline arrives", async () => {
    renderTraffic(new FixtureTrafficClient(), "en", "/traffic?tab=rules");

    expect(await screen.findByRole("button", { name: /Rules/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(screen.getByText("DomainSuffix")).toBeVisible();
  });

  it("keeps the search placeholder concise and explains structured filters on demand", async () => {
    const user = userEvent.setup();
    renderTraffic(new FixtureTrafficClient());

    const search = await screen.findByRole("textbox", { name: "Search Traffic" });
    expect(search).toHaveAttribute("placeholder", "Search Traffic");

    await user.click(screen.getByRole("button", { name: "Explain Traffic search syntax" }));
    const dialog = screen.getByRole("dialog", { name: "Search Traffic" });
    expect(dialog).toHaveTextContent("destination:");
    expect(dialog).toHaveTextContent("process:browser network:tcp");
    expect(dialog).toHaveTextContent("geosite:youtube");
    expect(dialog).toHaveTextContent("GeoSite rule payload");
  });

  it("renders fictional active observations, explicitly unsupported close controls, and complete row detail", async () => {
    const user = userEvent.setup();
    renderTraffic(new FixtureTrafficClient());

    expect(await screen.findByText(/Fictional local fixture data/)).toBeVisible();
    expect(screen.getByRole("button", { name: "Close All Active Connections" })).toBeDisabled();
    const row = screen.getByRole("row", { name: /docs\.fixture\.invalid/ });
    expect(row).toHaveAccessibleName(/TCP · HTTPS/);
    expect(within(row).getByText("TCP · HTTPS")).toBeVisible();
    expect(within(row).getByText("Fixture Browser")).toHaveAttribute("tabindex", "0");
    expect(within(row).getByText(/Fixture Policy → Fixture Relay → Fixture Exit/)).toBeVisible();
    expect(within(row).getByRole("button", { name: "Close" })).toBeDisabled();
    const details = within(row).getByRole("button", {
      name: /Connection details.*docs\.fixture\.invalid/,
    });
    expect(details).toHaveAttribute("aria-controls", "traffic-connection-details");
    expect(details).toHaveAttribute("aria-expanded", "false");

    await user.click(details);
    const dialog = screen.getByRole("dialog", { name: "Connection details" });
    expect(details).toHaveAttribute("aria-expanded", "true");
    expect(dialog).toHaveTextContent("TCP · HTTPS");
    const chain = within(dialog).getByRole("list");
    expect(within(chain).getAllByRole("listitem")).toHaveLength(3);
    expect(
      within(chain)
        .getAllByRole("listitem")
        .map((item) => item.textContent),
    ).toEqual(["1Fixture Policy", "2Fixture Relay", "3Fixture Exit"]);
    expect(dialog).toHaveTextContent("/synthetic/apps/fixture-browser");
  });

  it("opens details from the named action with keyboard and restores focus after closing", async () => {
    const user = userEvent.setup();
    renderTraffic(new FixtureTrafficClient());

    const row = await screen.findByRole("row", { name: /docs\.fixture\.invalid/ });
    const details = within(row).getByRole("button", {
      name: /Connection details.*docs\.fixture\.invalid/,
    });
    details.focus();
    await user.keyboard("{Enter}");

    expect(screen.getByRole("dialog", { name: "Connection details" })).toBeVisible();
    expect(details).toHaveAttribute("aria-expanded", "true");

    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(details).toHaveAttribute("aria-expanded", "false");
    expect(document.activeElement).toBe(details);
  });

  it("keeps canonical identifiers identical in English and Chinese", async () => {
    const english = renderTraffic(new FixtureTrafficClient(), "en");
    expect(
      await screen.findByRole("row", { name: /docs\.fixture\.invalid.*TCP · HTTPS/ }),
    ).toBeVisible();
    english.unmount();

    renderTraffic(new FixtureTrafficClient(), "zh");
    expect(
      await screen.findByRole("row", { name: /docs\.fixture\.invalid.*TCP · HTTPS/ }),
    ).toBeVisible();
  });

  it("searches the shared canonical and raw protocol presentation", async () => {
    const user = userEvent.setup();
    renderTraffic(new FixtureTrafficClient());
    const search = await screen.findByRole("textbox", { name: "Search Traffic" });

    await user.type(search, "TCP HTTPS");
    expect(await screen.findByRole("row", { name: /docs\.fixture\.invalid/ })).toBeVisible();
    expect(screen.queryByRole("row", { name: /media\.fixture\.invalid/ })).not.toBeInTheDocument();

    await user.clear(search);
    await user.type(search, "network:tcp protocol:https");
    expect(await screen.findByRole("row", { name: /docs\.fixture\.invalid/ })).toBeVisible();
  });

  it("renders unavailable for an empty normalized provider chain and preserves mixed chain order", async () => {
    const user = userEvent.setup();
    const client = new FixtureTrafficClient();
    const snapshot = await client.getSnapshot();
    const connection = snapshot.activeConnections[0]!;
    client.publishSnapshot({
      ...snapshot,
      activeConnections: [
        {
          ...connection,
          providerChain: [],
        },
      ],
      sequence: snapshot.sequence + 1,
    });
    renderTraffic(client);

    const row = await screen.findByRole("row", { name: /docs\.fixture\.invalid/ });
    await user.click(
      within(row).getByRole("button", { name: /Connection details.*docs\.fixture\.invalid/ }),
    );
    const dialog = screen.getByRole("dialog", { name: "Connection details" });
    expect(dialog).toHaveTextContent("Provider chain");
    expect(dialog).toHaveTextContent("Unavailable");
    expect(dialog).not.toHaveTextContent("→");

    await user.keyboard("{Escape}");
    client.publishSnapshot({
      ...snapshot,
      activeConnections: [
        {
          ...connection,
          providerChain: ["Provider A", "东京 🚀", "Provider A"],
        },
      ],
      sequence: snapshot.sequence + 2,
    });
    const updatedRow = await screen.findByRole("row", { name: /docs\.fixture\.invalid/ });
    await user.click(
      within(updatedRow).getByRole("button", {
        name: /Connection details.*docs\.fixture\.invalid/,
      }),
    );
    expect(screen.getByRole("dialog", { name: "Connection details" })).toHaveTextContent(
      "Provider A → 东京 🚀 → Provider A",
    );
  });

  it("renders a decorative process icon and reuses it by process path", async () => {
    const client = new IconTrafficClient();
    renderTraffic(client);

    const row = await screen.findByRole("row", { name: /docs\.fixture\.invalid/ });
    await waitFor(() =>
      expect(row.querySelector("img")).toHaveAttribute("src", "data:image/png;base64,iVBORw0KGgo="),
    );
    expect(client.iconRequests.filter((id) => id === "fixture-connection-1")).toHaveLength(1);

    const snapshot = await client.getSnapshot();
    client.publishSnapshot({ ...snapshot, sequence: snapshot.sequence + 1 });
    await waitFor(() => expect(row.querySelector("img")).toBeInTheDocument());
    expect(client.iconRequests.filter((id) => id === "fixture-connection-1")).toHaveLength(1);
  });

  it("closes one only after confirmation and preserves it in local Closed history", async () => {
    const user = userEvent.setup();
    renderTraffic(await commandClient());
    const row = await screen.findByRole("row", { name: /docs\.fixture\.invalid/ });

    await user.click(within(row).getByRole("button", { name: "Close" }));
    const confirmation = screen.getByRole("alertdialog", { name: "Close this active connection?" });
    expect(screen.queryByRole("dialog", { name: "Connection details" })).not.toBeInTheDocument();
    expect(confirmation).toHaveTextContent("stable connection ID");
    await user.click(within(confirmation).getByRole("button", { name: "Close Connection" }));

    expect(screen.queryByText("docs.fixture.invalid")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /Closed/ }));
    expect(await screen.findByText("docs.fixture.invalid")).toBeVisible();
  });

  it("resets Traffic view-local filters, selection, and confirmation on replacement", async () => {
    const user = userEvent.setup();
    const client = await commandClient();
    renderTraffic(client);
    const search = await screen.findByRole("textbox", { name: "Search Traffic" });
    await user.type(search, "process:browser");
    const row = await screen.findByRole("row", { name: /docs\.fixture\.invalid/ });
    await user.click(
      within(row).getByRole("button", { name: /Connection details.*docs\.fixture\.invalid/ }),
    );
    expect(screen.getByRole("dialog", { name: "Connection details" })).toBeVisible();
    await user.keyboard("{Escape}");
    await user.click(within(row).getByRole("button", { name: "Close" }));
    expect(
      screen.getByRole("alertdialog", { name: "Close this active connection?" }),
    ).toBeVisible();

    const current = await client.getSnapshot();
    client.publishSnapshot({
      ...current,
      profileId: "replacement-profile",
      sequence: 1,
      sessionId: "replacement-session",
    });

    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
    expect(search).toHaveValue("");
    expect(screen.queryByRole("dialog", { name: "Connection details" })).not.toBeInTheDocument();
  });

  it("closes all current active connections regardless of filters and supports keyboard cancel", async () => {
    const user = userEvent.setup();
    renderTraffic(await commandClient());
    await screen.findByText("Fixture Browser");
    const search = screen.getByRole("textbox", { name: "Search Traffic" });
    await user.type(search, "process:browser");
    expect(screen.getAllByRole("row")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: "Close All Active Connections" }));
    let confirmation = screen.getByRole("alertdialog", {
      name: "Close all currently active connections?",
    });
    expect(confirmation).toHaveTextContent("all 6 connections");
    expect(confirmation).toHaveTextContent("hidden by the current search");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Close All Active Connections" }));
    confirmation = screen.getByRole("alertdialog", {
      name: "Close all currently active connections?",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "Close All Active Connections" }),
    );
    expect(await screen.findByText("No matches")).toBeVisible();
    await user.clear(search);
    expect(await screen.findByText("No active connections")).toBeVisible();
    await user.click(screen.getByRole("button", { name: /Closed/ }));
    expect(screen.getByRole("button", { name: /Closed 6/ })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("freezes and closes exactly the filtered-visible connection IDs", async () => {
    const user = userEvent.setup();
    renderTraffic(await commandClient());
    const search = await screen.findByRole("textbox", { name: "Search Traffic" });
    await user.type(search, "process:browser");

    await user.click(screen.getByRole("button", { name: "Close Visible Connections" }));
    const confirmation = screen.getByRole("alertdialog", {
      name: "Close the filtered visible connections?",
    });
    expect(confirmation).toHaveTextContent("Target count: 1");
    await user.click(
      within(confirmation).getByRole("button", { name: "Close Visible Connections" }),
    );

    expect(await screen.findByText("No matches")).toBeVisible();
    await user.clear(search);
    expect(await screen.findAllByRole("row")).toHaveLength(6);
  });

  it("keeps filtered-visible confirmation pending and blocks broader close scopes", async () => {
    const user = userEvent.setup();
    const client = new PendingFilteredTrafficClient();
    const snapshot = await client.getSnapshot();
    client.publishSnapshot({ ...snapshot, adapterKind: "rpc" });
    renderTraffic(client);
    await screen.findByText("Fixture Browser");
    const closeAll = screen.getByRole("button", { name: "Close All Active Connections" });

    await user.click(screen.getByRole("button", { name: "Close Visible Connections" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Close Visible Connections",
      }),
    );

    expect(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Closing visible connections…",
      }),
    ).toBeDisabled();
    expect(closeAll).toBeDisabled();

    client.release();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument());
  });

  it("moves a failed close confirmation into a toast and the notification center", async () => {
    const user = userEvent.setup();
    const errorToast = vi.spyOn(toast, "error");
    const client = new FailingTrafficClient();
    const snapshot = await client.getSnapshot();
    client.publishSnapshot({ ...snapshot, adapterKind: "rpc" });
    renderTraffic(client);

    await user.click(await screen.findByRole("button", { name: "Close All Active Connections" }));
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Close All Active Connections",
      }),
    );

    await waitFor(() =>
      expect(errorToast).toHaveBeenCalledWith(
        "Mihomo rejected the close command. The active snapshot was refreshed without claiming success.",
        expect.objectContaining({ id: expect.stringMatching(/^notification:/) }),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Notifications, 1 unread" }));
    expect(await screen.findByRole("dialog")).toHaveTextContent(
      "Mihomo rejected the close command. The active snapshot was refreshed without claiming success.",
    );
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

    await user.click(screen.getByRole("button", { name: /Closed/ }));
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
    await user.click(screen.getByRole("button", { name: /Rules/ }));
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

  it("explains unavailable traffic data in plain language", async () => {
    const client = new FixtureTrafficClient();
    const snapshot = await client.getSnapshot();
    client.publishSnapshot({ ...snapshot, adapterKind: "rpc", phase: "unavailable" });
    renderTraffic(client);

    expect(await screen.findByText("No traffic data is available right now.")).toBeVisible();
  });

  it("explains unavailable process attribution without inventing a process", async () => {
    const client = await commandClient();
    const snapshot = await client.getSnapshot();
    client.publishSnapshot({
      ...snapshot,
      activeConnections: snapshot.activeConnections.map((connection) => ({
        ...connection,
        processName: null,
        processPath: null,
      })),
      sequence: snapshot.sequence + 1,
    });
    renderTraffic(client);

    expect(
      await screen.findByText(
        "Process attribution is unavailable for 6 active connections because Mihomo could not identify their owning process.",
      ),
    ).toBeVisible();
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
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
    await user.click(screen.getByRole("button", { name: "Show More" }));
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
