import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { StatusCommand, StatusSnapshotDto } from "@mish/contracts";
import { TooltipProvider } from "@mish/ui";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { AppRoutes } from "../app";
import { AppearanceProvider } from "../appearance";
import { FixtureStatusClient } from "../data/fixture-status-client";
import { ProductProvider } from "../data/product-provider";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";

loadAllLocales();

function renderRoutes(client = new FixtureStatusClient()) {
  return render(
    <AppearanceProvider>
      <TypesafeI18n locale="en">
        <MemoryRouter initialEntries={["/routes"]}>
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

describe("Routes workspace", () => {
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
    await user.click(screen.getByText("🇯🇵 NRT-03"));
    await user.click(screen.getByRole("link", { name: /View all/ }));
    await user.click(await screen.findByRole("button", { name: "Expand 🎬 Streaming" }));
    expect(
      screen.getByRole("button", { name: "Select 🇯🇵 NRT-03 in 🎬 Streaming" }),
    ).toHaveAttribute("aria-pressed", "true");
  });

  it("renders all group types as a nested graph without mounting a collapsed large fixture", async () => {
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

    await user.click(within(streaming!).getByRole("button", { name: "Latency" }));
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
    };
    const client = new DelaySnapshotClient(snapshot);
    const user = userEvent.setup();
    renderRoutes(client);

    await user.click(await screen.findByRole("button", { name: "Expand 🎬 Streaming" }));
    const streaming = screen
      .getByRole("button", { name: "Collapse 🎬 Streaming" })
      .closest("article")!;
    expect(within(streaming).getByText(/mihomo-google-204-v1/)).toBeVisible();
    await user.click(
      within(streaming).getByRole("button", { name: "Start delay test for 🎬 Streaming" }),
    );

    expect(await within(streaming).findByText("Testing 🎬 Streaming")).toBeVisible();
    expect(client.startedGroupIds).toEqual([
      snapshot.groups.find((group) => group.label === "🎬 Streaming")!.id,
    ]);
    await user.click(
      within(streaming).getByRole("button", { name: "Cancel delay test for 🎬 Streaming" }),
    );
    expect(await within(streaming).findByText(/Cancelled · 3\/3/)).toBeVisible();
    expect(client.cancelledTestIds).toEqual(["group-delay-ui"]);
  });

  it("does not let the browser fixture masquerade as a desktop delay test", async () => {
    const user = userEvent.setup();
    renderRoutes();
    await user.click(await screen.findByRole("button", { name: "Expand 🎬 Streaming" }));

    expect(
      screen.getByRole("button", { name: "Start delay test for 🎬 Streaming" }),
    ).toBeDisabled();
  });

  it("explains and disables policy selection for the read-only RPC adapter", async () => {
    const snapshot = await new FixtureStatusClient().getSnapshot();
    snapshot.adapterKind = "rpc";
    snapshot.capabilities = { systemProxy: "unavailable", tun: "unavailable" };
    const user = userEvent.setup();
    renderRoutes(new SnapshotClient(snapshot, false));

    expect(await screen.findByText("Routes are read-only")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Expand 🎬 Streaming" }));
    const selection = screen.getByRole("button", {
      name: "Select 🇯🇵 NRT-03 in 🎬 Streaming",
    });
    expect(selection).toBeDisabled();
    expect(selection).toHaveAccessibleDescription(
      "This action is not supported by the current local service.",
    );
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
