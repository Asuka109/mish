import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  StatusClientError,
  type ProfileRouteCatalogDto,
  type StatusCommand,
  type StatusSnapshotDto,
} from "@mish/contracts";
import { TooltipProvider } from "@mish/ui";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "../app";
import { AppearanceProvider } from "../appearance";
import { FixtureStatusClient } from "../data/fixture-status-client";
import { FixtureProfileClient } from "../data/fixture-profile-client";
import { ProductProvider } from "../data/product-provider";
import { ProfileProvider } from "../data/profile-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";

loadAllLocales();

function renderRoutes(client = new FixtureStatusClient(), initialEntry = "/routes") {
  return render(
    <AppearanceProvider>
      <TypesafeI18n locale="en">
        <MemoryRouter initialEntries={[initialEntry]}>
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

class SnapshotClient extends FixtureStatusClient {
  constructor(
    protected readonly confirmedSnapshot: StatusSnapshotDto,
    private readonly commandsSupported = true,
  ) {
    super();
  }

  override async getSnapshot() {
    return structuredClone(this.confirmedSnapshot);
  }

  override supportsCommand(_command: StatusCommand) {
    return this.commandsSupported;
  }
}

class DelaySnapshotClient extends SnapshotClient {
  readonly cancelledTestIds: string[] = [];
  readonly startedGroupIds: string[] = [];
  mutateLatenciesOnStart = false;

  override async startGroupDelayTest(groupId: string) {
    this.startedGroupIds.push(groupId);
    const group = this.confirmedSnapshot.groups.find((candidate) => candidate.id === groupId)!;
    this.confirmedSnapshot.groupDelayTest = {
      children: group.childIds.map((childId) => ({
        childId,
        failure: null,
        latencyMilliseconds: null,
        observedAt: null,
        phase: "pending",
      })),
      finishedAt: null,
      groupId,
      phase: "pending",
      profileId: this.confirmedSnapshot.activeProfileId,
      startedAt: 1_720_000_000_000,
      testId: "group-delay-ui",
    };
    if (this.mutateLatenciesOnStart) {
      group.childIds.forEach((childId, index) => {
        const node = this.confirmedSnapshot.nodes.find((candidate) => candidate.id === childId);
        if (node) node.latencyMilliseconds = (index + 1) * 100;
      });
    }
    return structuredClone(this.confirmedSnapshot);
  }

  override async cancelGroupDelayTest(testId: string) {
    this.cancelledTestIds.push(testId);
    this.confirmedSnapshot.groupDelayTest = {
      ...this.confirmedSnapshot.groupDelayTest,
      children: this.confirmedSnapshot.groupDelayTest.children.map((child) => ({
        ...child,
        failure: "cancelled",
        observedAt: 1_720_000_000_100,
        phase: "cancelled",
      })),
      finishedAt: 1_720_000_000_100,
      phase: "cancelled",
    };
    return structuredClone(this.confirmedSnapshot);
  }
}

class DeferredSelectionClient extends SnapshotClient {
  rejectSelection: (() => void) | null = null;
  selectionAttempts = 0;

  override selectGroupChild() {
    this.selectionAttempts += 1;
    return new Promise<StatusSnapshotDto>((_, reject) => {
      this.rejectSelection = () =>
        reject(new StatusClientError("conflict", "Group selection failed", true));
    });
  }
}

class ConfiguredRoutesProfileClient extends FixtureProfileClient {
  override async getRoutes(): Promise<ProfileRouteCatalogDto> {
    return {
      fingerprint: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      groups: [
        {
          childIds: ["node-z", "node-a"],
          id: "group-z",
          label: "Z first",
          selectedChildId: null,
          type: "selector",
        },
        {
          childIds: ["node-a", "node-z"],
          id: "group-a",
          label: "A second",
          selectedChildId: null,
          type: "url-test",
        },
      ],
      nodes: [
        { id: "node-z", label: "Zulu node", latencyMilliseconds: null, protocol: "ss" },
        { id: "node-a", label: "Alpha node", latencyMilliseconds: null, protocol: "trojan" },
      ],
      profileId: "fixture-profile-studio",
      routingMode: "rule",
    };
  }
}

describe("Routes workspace", () => {
  it("hides the special GLOBAL selector in Rule mode", async () => {
    const snapshot = await new FixtureStatusClient().getSnapshot();
    snapshot.groups.unshift({
      childIds: ["proxy"],
      id: "global",
      label: "GLOBAL",
      selectedChildId: "proxy",
      type: "selector",
    });
    renderRoutes(new SnapshotClient(snapshot));

    expect(await screen.findByRole("button", { name: "Expand 🌐 Proxy" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Expand GLOBAL" })).not.toBeInTheDocument();
  });

  it("keeps configured order and disables non-GLOBAL policy groups in Global mode", async () => {
    const snapshot = await new FixtureStatusClient().getSnapshot();
    snapshot.routingMode = "global";
    snapshot.groups.push({
      childIds: ["proxy"],
      id: "global",
      label: "GLOBAL",
      selectedChildId: "proxy",
      type: "selector",
    });
    renderRoutes(new SnapshotClient(snapshot));

    const routes = await screen.findByRole("region", { name: "Routes" });
    const groupToggles = within(routes).getAllByRole("button", { name: /^Expand / });
    expect(groupToggles.at(-1)).toHaveAccessibleName("Expand GLOBAL");
    expect(groupToggles.at(-1)).toBeEnabled();
    expect(screen.getByRole("button", { name: "Expand 🌐 Proxy" })).toBeDisabled();
  });

  it("keeps referenced policy groups independent while showing direct references inside parents", async () => {
    const user = userEvent.setup();
    renderRoutes();

    expect(await screen.findByRole("button", { name: "Expand ⚡ 自动选择・Auto" })).toBeVisible();
    expect(
      screen.getByText(
        "Browse the active profile's policy groups independently. Expanding a group shows its direct choices, and each selection changes only that group.",
      ),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Expand 🌐 Proxy" }));

    const proxy = screen.getByRole("button", { name: "Collapse 🌐 Proxy" }).closest("article")!;
    const referencedGroup = within(proxy).getByText("⚡ 自动选择・Auto").closest("li");
    expect(referencedGroup).not.toBeNull();
    expect(referencedGroup).toHaveTextContent("Policy group · URL test");
    expect(
      within(referencedGroup!).getByRole("link", { name: "Browse ⚡ 自动选择・Auto" }),
    ).toBeVisible();
    expect(
      within(referencedGroup!).queryByRole("button", {
        name: "Select ⚡ 自动选择・Auto in 🌐 Proxy",
      }),
    ).not.toBeInTheDocument();
    expect(
      within(proxy).queryByRole("button", { name: "Expand ⚡ 自动选择・Auto" }),
    ).not.toBeInTheDocument();
  });

  it("reconciles a Status shortcut selection into Routes through the shared client seam", async () => {
    const user = userEvent.setup();
    render(
      <AppearanceProvider>
        <TypesafeI18n locale="en">
          <MemoryRouter initialEntries={["/status"]}>
            <ProductProvider client={new FixtureStatusClient()}>
              <TooltipProvider>
                <AppRoutes />
              </TooltipProvider>
            </ProductProvider>
          </MemoryRouter>
        </TypesafeI18n>
      </AppearanceProvider>,
    );

    await user.click(await screen.findByRole("button", { name: /Streaming/ }));
    await user.click(screen.getByRole("button", { name: "Select 🇯🇵 NRT-03 in 🎬 Streaming" }));
    await user.click(screen.getByRole("link", { name: /View All/ }));
    await user.click(await screen.findByRole("button", { name: "Expand 🎬 Streaming" }));
    expect(
      screen.getByRole("button", { name: "Select 🇯🇵 NRT-03 in 🎬 Streaming" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("renders every group independently without mounting a collapsed large fixture", async () => {
    const user = userEvent.setup();
    renderRoutes();

    expect(await screen.findByRole("heading", { name: "Routes" })).toBeVisible();
    expect(screen.queryByText(/Current profile:/)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Expand 🌐 Proxy" })).toBeVisible();
    expect(
      screen.getByRole("button", { name: "Expand Scale verification pool · 160" }),
    ).toBeVisible();
    expect(screen.queryByText("Scale fixture node 160")).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Expand 🌐 Proxy" }));
    for (const label of [
      "URL test",
      "Fallback",
      "Load balance",
      "Relay",
      "Direct",
      "Reject",
      "Unsupported · smart-group",
    ]) {
      expect(screen.getAllByText(label)[0]).toBeVisible();
    }

    await user.click(screen.getByRole("button", { name: "Expand Scale verification pool · 160" }));
    const scaleGroup = screen
      .getByRole("button", { name: "Collapse Scale verification pool · 160" })
      .closest("article")!;
    expect(scaleGroup.querySelectorAll(".policy-browser-entity-list > li")).toHaveLength(100);
    expect(within(scaleGroup).queryByText("Scale fixture node 101")).not.toBeInTheDocument();
    await user.click(within(scaleGroup).getByRole("button", { name: /Show 60 More/i }));
    expect(within(scaleGroup).getByText("Scale fixture node 160")).toBeVisible();
  });

  it("uses a dedicated single-group route for narrow policy browsing", async () => {
    const user = userEvent.setup();
    renderRoutes(new FixtureStatusClient(), "/routes/proxy");

    expect(await screen.findByRole("heading", { name: "🌐 Proxy" })).toBeVisible();
    expect(screen.getByRole("link", { name: "All Routes" })).toHaveAttribute("href", "/routes");
    const search = screen.getByRole("searchbox", { name: "Search direct children of 🌐 Proxy" });
    fireEvent.keyDown(window, { key: "f", metaKey: true });
    expect(search).toHaveFocus();
    await user.type(search, "vless");
    expect(screen.getByRole("button", { name: "Select 🇯🇵 NRT-03 in 🌐 Proxy" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Expand 🎬 Streaming" })).not.toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(search).toHaveValue("");
    expect(search).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(search).not.toHaveFocus();
  });

  it("searches complete Unicode child labels and keeps their nested path visible", async () => {
    const user = userEvent.setup();
    renderRoutes();
    const search = await screen.findByRole("searchbox", {
      name: "Search policy groups and children",
    });

    await user.type(search, "開発 🚄");

    expect((await screen.findAllByText("台北・開発 🚄"))[0]).toBeVisible();
    expect(screen.getAllByText("⚡ 自动选择・Auto")[0]).toBeVisible();
    expect(screen.getAllByText("🌐 Proxy")[0]).toBeVisible();
  });

  it("keeps sorting and selection scoped to one selector group", async () => {
    const user = userEvent.setup();
    renderRoutes();
    await user.click(await screen.findByRole("button", { name: "Expand 🎬 Streaming" }));
    const streaming = screen
      .getByRole("button", { name: "Collapse 🎬 Streaming" })
      .closest("article");
    expect(streaming).not.toBeNull();

    await user.click(
      within(streaming!).getByRole("combobox", { name: "Sort children in 🎬 Streaming" }),
    );
    await user.click(await screen.findByRole("option", { name: "Latency" }));
    const rows = within(streaming!).getAllByRole("button", { name: /^Select / });
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual([
      "Select 🇭🇰 HKG-02 in 🎬 Streaming",
      "Select 🇯🇵 NRT-03 in 🎬 Streaming",
      "Select 🇸🇬 SIN-01 in 🎬 Streaming",
    ]);

    await user.click(
      within(streaming!).getByRole("button", { name: "Select 🇯🇵 NRT-03 in 🎬 Streaming" }),
    );
    await waitFor(() =>
      expect(
        within(streaming!).getByRole("button", {
          name: "Select 🇯🇵 NRT-03 in 🎬 Streaming",
        }),
      ).toHaveAttribute("aria-pressed", "true"),
    );

    await user.click(screen.getByRole("button", { name: "Expand 🌐 Proxy" }));
    expect(screen.getByRole("button", { name: "Select 🇭🇰 HKG-02 in 🌐 Proxy" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("keeps the confirmed child current while a target is switching and restores it on failure", async () => {
    const snapshot = await new FixtureStatusClient().getSnapshot();
    const client = new DeferredSelectionClient(snapshot);
    const user = userEvent.setup();
    renderRoutes(client);
    await user.click(await screen.findByRole("button", { name: "Expand 🎬 Streaming" }));

    const selection = screen.getByRole("button", {
      name: "Select 🇯🇵 NRT-03 in 🎬 Streaming",
    });
    await user.click(selection);

    expect(selection).toHaveAttribute("aria-busy", "true");
    expect(selection).toHaveAttribute("aria-pressed", "false");
    expect(selection).toHaveTextContent("Switching");
    expect(selection.querySelector(".ui-spinner")).toBeInTheDocument();
    const confirmedSelection = screen.getByRole("button", {
      name: "Select 🇸🇬 SIN-01 in 🎬 Streaming",
    });
    expect(confirmedSelection).toBeDisabled();
    expect(confirmedSelection).toHaveAttribute("aria-pressed", "true");
    await user.click(confirmedSelection);
    expect(client.selectionAttempts).toBe(1);

    client.rejectSelection?.();
    await waitFor(() => expect(selection).not.toHaveAttribute("aria-busy"));
    expect(selection).toHaveAttribute("aria-pressed", "false");
    expect(selection).toHaveFocus();
  });

  it("does not expose automatic or unsupported group children as manual selectors", async () => {
    const user = userEvent.setup();
    renderRoutes();
    await user.click(await screen.findByRole("button", { name: "Expand 🌐 Proxy" }));
    await user.click(screen.getByRole("button", { name: "Expand ⚡ 自动选择・Auto" }));
    await user.click(screen.getByRole("button", { name: "Expand Provider smart policy" }));

    expect(
      screen.queryByRole("button", { name: "Select 🇯🇵 NRT-03 in ⚡ 自动选择・Auto" }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Select 台北・開発 🚄 in Provider smart policy" }),
    ).not.toBeInTheDocument();
  });

  it("keeps delay testing and cancellation in the expanded group's local toolbar", async () => {
    const snapshot = await new FixtureStatusClient().getSnapshot();
    snapshot.adapterKind = "rpc";
    snapshot.groupDelayPolicy = {
      id: "mihomo-google-204-v1",
      timeoutMilliseconds: 5_000,
      url: "https://www.gstatic.com/generate_204",
    };
    const client = new DelaySnapshotClient(snapshot);
    client.mutateLatenciesOnStart = true;
    const user = userEvent.setup();
    renderRoutes(client);

    await user.click(await screen.findByRole("button", { name: "Expand 🎬 Streaming" }));
    const streaming = screen
      .getByRole("button", { name: "Collapse 🎬 Streaming" })
      .closest("article")!;
    expect(within(streaming).getByText(/https:\/\/www\.gstatic\.com\/generate_204/)).toBeVisible();
    expect(within(streaming).queryByText(/mihomo-google-204-v1/)).not.toBeInTheDocument();
    expect(within(streaming).queryByText(/5 s timeout/)).not.toBeInTheDocument();
    await user.click(
      within(streaming).getByRole("combobox", { name: "Sort children in 🎬 Streaming" }),
    );
    await user.click(await screen.findByRole("option", { name: "Latency" }));
    const orderBeforeTest = within(streaming)
      .getAllByRole("button", { name: /^Select / })
      .map((row) => row.getAttribute("aria-label"));
    await user.click(
      within(streaming).getByRole("button", { name: "Start Delay Test for 🎬 Streaming" }),
    );

    expect(await within(streaming).findByText("Pending · 0/3")).toBeVisible();
    expect(
      within(streaming)
        .getAllByRole("button", { name: /^Select / })
        .map((row) => row.getAttribute("aria-label")),
    ).toEqual(orderBeforeTest);
    expect(client.startedGroupIds).toEqual([
      snapshot.groups.find((group) => group.label === "🎬 Streaming")!.id,
    ]);
    await user.click(screen.getByRole("button", { name: "Expand 🌐 Proxy" }));
    const proxy = screen.getByRole("button", { name: "Collapse 🌐 Proxy" }).closest("article")!;
    expect(
      within(proxy).getByRole("button", { name: "Start Delay Test for 🌐 Proxy" }),
    ).toBeDisabled();
    expect(within(proxy).getByText("Testing 🎬 Streaming")).toBeVisible();
    await user.click(
      within(streaming).getByRole("button", { name: "Cancel Delay Test for 🎬 Streaming" }),
    );
    expect(await within(streaming).findByText(/Cancelled · 3\/3/)).toBeVisible();
    expect(client.cancelledTestIds).toEqual(["group-delay-ui"]);
  });

  it("does not let the browser fixture masquerade as a desktop delay test", async () => {
    const user = userEvent.setup();
    renderRoutes();
    await user.click(await screen.findByRole("button", { name: "Expand 🎬 Streaming" }));

    expect(
      screen.getByRole("button", { name: "Start Delay Test for 🎬 Streaming" }),
    ).toBeDisabled();
  });

  it("disables policy selection without reusing the read-only entity state", async () => {
    const snapshot = await new FixtureStatusClient().getSnapshot();
    snapshot.adapterKind = "rpc";
    snapshot.capabilities = { systemProxy: "unavailable", tun: "unavailable" };
    const user = userEvent.setup();
    renderRoutes(new SnapshotClient(snapshot, false));

    await screen.findByRole("heading", { name: "Routes" });
    expect(screen.queryByText("Routes are read-only")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Expand 🎬 Streaming" }));
    const disabledSelection = screen.getByRole("button", {
      name: "Select 🇯🇵 NRT-03 in 🎬 Streaming",
    });
    expect(disabledSelection).toBeDisabled();
    expect(disabledSelection).not.toHaveTextContent("Read-only");
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
  });

  it("shows the selected profile's configured groups while Mihomo is stopped", async () => {
    const user = userEvent.setup();
    const snapshot = await new FixtureStatusClient().getSnapshot();
    snapshot.adapterKind = "rpc";
    snapshot.activeProfileId = "local";
    snapshot.groups = [];
    snapshot.nodes = [];
    snapshot.runtime.phase = "inactive";

    render(
      <AppearanceProvider>
        <TypesafeI18n locale="en">
          <MemoryRouter initialEntries={["/routes"]}>
            <ProductProvider client={new SnapshotClient(snapshot, false)}>
              <ProfileProvider client={new ConfiguredRoutesProfileClient()}>
                <TooltipProvider>
                  <AppRoutes />
                </TooltipProvider>
              </ProfileProvider>
            </ProductProvider>
          </MemoryRouter>
        </TypesafeI18n>
      </AppearanceProvider>,
    );

    const routes = await screen.findByRole("region", { name: "Routes" });
    const groups = within(routes).getAllByRole("button", { name: /^Expand / });
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Expand Z first",
      "Expand A second",
    ]);

    await user.click(groups[0]);
    const configuredSelection = screen.getByRole("button", {
      name: "Select Zulu node in Z first",
    });
    expect(configuredSelection).toBeDisabled();
    expect(configuredSelection).not.toHaveTextContent("Read-only");
    expect(screen.queryByText("Read-only")).not.toBeInTheDocument();
    expect(screen.getAllByText(/No single current child/)[0]).toBeVisible();
  });

  it("shows a safe graph error instead of rendering inconsistent relationships", async () => {
    const snapshot = await new FixtureStatusClient().getSnapshot();
    snapshot.groups = [
      {
        childIds: ["loop-b", "missing"],
        id: "loop-a",
        label: "Loop A",
        selectedChildId: "missing",
        type: "selector",
      },
      {
        childIds: ["loop-a"],
        id: "loop-b",
        label: "Loop B",
        selectedChildId: "loop-a",
        type: "fallback",
      },
    ];
    renderRoutes(new SnapshotClient(snapshot));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("The policy-group graph is invalid");
    expect(alert).toHaveTextContent("Cycle detected: Loop A → Loop B → Loop A");
    expect(alert).toHaveTextContent("Loop A references missing child missing");
    expect(screen.queryByRole("button", { name: "Expand Loop A" })).not.toBeInTheDocument();
  });
});
