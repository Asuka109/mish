import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StatusClientError, type RoutingMode, type StatusSnapshotDto } from "@mish/contracts";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import TypesafeI18n from "../i18n/i18n-react";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import { FixtureStatusClient } from "./fixture-status-client";
import { ProductProvider, useProduct } from "./product-provider";

loadAllLocales();

class RuntimeReplacementClient extends FixtureStatusClient {
  snapshotRequests = 0;

  override async getSnapshot(options?: { signal?: AbortSignal }) {
    this.snapshotRequests += 1;
    return super.getSnapshot(options);
  }

  override async setRoutingMode(
    _mode: RoutingMode,
    _options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto> {
    const snapshot = await super.getSnapshot();
    snapshot.activeProfileId = "profile-replacement";
    snapshot.profiles = [{ id: "profile-replacement", label: "Replacement profile" }];
    snapshot.routingMode = "rule";
    throw new StatusClientError(
      "runtime-replaced",
      "The Status runtime was replaced before the command completed",
      true,
      snapshot,
    );
  }
}

class ConfirmedGroupRuntimeReplacementClient extends FixtureStatusClient {
  constructor(
    private readonly observedChildId = "hkg-01",
    private readonly replacementProfileId: string | null = null,
  ) {
    super();
  }

  override async selectGroupChild(groupId: string, _childId: string): Promise<StatusSnapshotDto> {
    const snapshot = await super.getSnapshot();
    const group = snapshot.groups.find(({ id }) => id === groupId);
    if (!group) throw new Error(`Missing group ${groupId}`);
    group.selectedChildId = this.observedChildId;
    if (this.replacementProfileId) snapshot.activeProfileId = this.replacementProfileId;
    snapshot.applicationOrder.order += 1;
    throw new StatusClientError(
      "runtime-replaced",
      "The Status runtime was replaced before the command completed",
      true,
      snapshot,
    );
  }
}

class ConfirmedGroupTimeoutClient extends FixtureStatusClient {
  private confirmationRefreshes = 0;
  private pendingSelection: { childId: string; groupId: string } | null = null;
  private snapshotState: StatusSnapshotDto | null = null;

  constructor(private readonly confirmAfterRefreshes: number | null = 3) {
    super();
  }

  override async getSnapshot() {
    this.snapshotState ??= await super.getSnapshot();
    if (this.pendingSelection && this.confirmAfterRefreshes !== null) {
      this.confirmationRefreshes += 1;
      if (this.confirmationRefreshes >= this.confirmAfterRefreshes) {
        const pendingSelection = this.pendingSelection;
        const group = this.snapshotState.groups.find(({ id }) => id === pendingSelection.groupId);
        if (!group) throw new Error(`Missing group ${pendingSelection.groupId}`);
        group.selectedChildId = pendingSelection.childId;
        this.snapshotState.applicationOrder.order += 1;
        this.pendingSelection = null;
      }
    }
    return structuredClone(this.snapshotState);
  }

  override async selectGroupChild(groupId: string, childId: string): Promise<StatusSnapshotDto> {
    const snapshot = await this.getSnapshot();
    const group = snapshot.groups.find(({ id }) => id === groupId);
    if (!group) throw new Error(`Missing group ${groupId}`);
    this.pendingSelection = { childId, groupId };
    throw new StatusClientError(
      "timeout",
      "The Controller did not confirm the group selection before the deadline",
      true,
    );
  }
}

class DelayedRoutingClient extends FixtureStatusClient {
  private readonly listeners = new Set<(snapshot: StatusSnapshotDto) => void>();
  private readonly requests: Array<{
    mode: RoutingMode;
    resolve(snapshot: StatusSnapshotDto): void;
  }> = [];
  private snapshotState!: StatusSnapshotDto;

  async initialize() {
    this.snapshotState = await super.getSnapshot();
  }

  override async getSnapshot() {
    return structuredClone(this.snapshotState);
  }

  override setRoutingMode(mode: RoutingMode): Promise<StatusSnapshotDto> {
    return new Promise((resolve) => {
      this.requests.push({ mode, resolve });
    });
  }

  override subscribeSnapshots(listener: (snapshot: StatusSnapshotDto) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publishReplacement() {
    this.snapshotState = {
      ...structuredClone(this.snapshotState),
      activeProfileId: "profile-replacement",
      applicationOrder: {
        ...this.snapshotState.applicationOrder,
        epoch: this.snapshotState.applicationOrder.epoch + 1,
        order: 1,
      },
      profiles: [{ id: "profile-replacement", label: "Replacement profile" }],
      routingMode: "rule",
    };
    for (const listener of this.listeners) listener(structuredClone(this.snapshotState));
  }

  resolve(index: number, snapshot: StatusSnapshotDto) {
    this.requests[index]?.resolve(snapshot);
  }

  requestCount() {
    return this.requests.length;
  }
}

class ConcurrentGroupClient extends FixtureStatusClient {
  private readonly requests: Array<{
    childId: string;
    groupId: string;
    reject(error: Error): void;
    resolve(snapshot: StatusSnapshotDto): void;
  }> = [];
  private snapshotState!: StatusSnapshotDto;

  async initialize() {
    this.snapshotState = await super.getSnapshot();
  }

  override async getSnapshot() {
    return structuredClone(this.snapshotState);
  }

  override selectGroupChild(groupId: string, childId: string): Promise<StatusSnapshotDto> {
    return new Promise((resolve, reject) => {
      this.requests.push({ childId, groupId, reject, resolve });
    });
  }

  reject(index: number) {
    this.requests[index]?.reject(new StatusClientError("remote", "Group command failed"));
  }

  resolve(index: number) {
    const request = this.requests[index];
    if (!request) throw new Error(`Missing group request ${index}`);
    const group = this.snapshotState.groups.find(({ id }) => id === request.groupId);
    if (!group) throw new Error(`Missing group ${request.groupId}`);
    group.selectedChildId = request.childId;
    this.snapshotState.applicationOrder.order += 1;
    request.resolve(structuredClone(this.snapshotState));
  }

  requestCount() {
    return this.requests.length;
  }
}

function RuntimeReplacementHarness() {
  const { setRoutingMode, snapshot } = useProduct();
  return (
    <>
      <button onClick={() => void setRoutingMode("global")} type="button">
        Change routing
      </button>
      <output data-testid="profile">{snapshot?.activeProfileId ?? "loading"}</output>
      <output data-testid="routing">{snapshot?.routingMode ?? "loading"}</output>
    </>
  );
}

function ConfirmedGroupRuntimeReplacementHarness() {
  const product = useProduct();
  const [result, setResult] = useState("idle");
  return (
    <>
      <button
        onClick={() => {
          void product
            .selectGroupChild("proxy", "hkg-01")
            .then((next) => setResult(next.ok ? "confirmed" : "failed"));
        }}
        type="button"
      >
        Change proxy
      </button>
      <output data-testid="group-result">{result}</output>
      <output data-testid="group-selection">
        {product.snapshot?.groups.find(({ id }) => id === "proxy")?.selectedChildId ?? "loading"}
      </output>
    </>
  );
}

function DelayedRoutingHarness() {
  const product = useProduct();
  return (
    <>
      <button onClick={() => void product.setRoutingMode("global")} type="button">
        Change routing
      </button>
      <output data-testid="pending">{String(product.isCommandPending("routing"))}</output>
      <output data-testid="profile">{product.snapshot?.activeProfileId ?? "loading"}</output>
      <output data-testid="routing">{product.snapshot?.routingMode ?? "loading"}</output>
    </>
  );
}

function ConcurrentGroupHarness() {
  const product = useProduct();
  return (
    <>
      <button onClick={() => void product.selectGroupChild("proxy", "hkg-01")} type="button">
        Change proxy
      </button>
      <button onClick={() => void product.selectGroupChild("streaming", "hkg-02")} type="button">
        Change streaming
      </button>
      <output data-testid="group-phase">{product.commandStates.group.phase}</output>
    </>
  );
}

describe("ProductProvider runtime replacement reconciliation", () => {
  it("applies the authoritative terminal snapshot without issuing a second refresh", async () => {
    const client = new RuntimeReplacementClient();
    render(
      <TypesafeI18n locale="en">
        <ProductProvider client={client}>
          <RuntimeReplacementHarness />
        </ProductProvider>
      </TypesafeI18n>,
    );

    await waitFor(() => expect(screen.getByTestId("profile")).toHaveTextContent("home"));
    expect(client.snapshotRequests).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: "Change routing" }));

    await waitFor(() => {
      expect(screen.getByTestId("profile")).toHaveTextContent("profile-replacement");
      expect(screen.getByTestId("routing")).toHaveTextContent("rule");
    });
    expect(client.snapshotRequests).toBe(1);
  });

  it("accepts a group selection confirmed by the replacement snapshot", async () => {
    render(
      <TypesafeI18n locale="en">
        <ProductProvider client={new ConfirmedGroupRuntimeReplacementClient()}>
          <ConfirmedGroupRuntimeReplacementHarness />
        </ProductProvider>
      </TypesafeI18n>,
    );

    await waitFor(() => expect(screen.getByTestId("group-selection")).toHaveTextContent("hkg-02"));
    fireEvent.click(screen.getByRole("button", { name: "Change proxy" }));

    await waitFor(() => {
      expect(screen.getByTestId("group-selection")).toHaveTextContent("hkg-01");
      expect(screen.getByTestId("group-result")).toHaveTextContent("confirmed");
    });
  });

  it("accepts a timed-out group selection confirmed by the bounded refresh", async () => {
    render(
      <TypesafeI18n locale="en">
        <ProductProvider client={new ConfirmedGroupTimeoutClient()}>
          <ConfirmedGroupRuntimeReplacementHarness />
        </ProductProvider>
      </TypesafeI18n>,
    );

    await waitFor(() => expect(screen.getByTestId("group-selection")).toHaveTextContent("hkg-02"));
    fireEvent.click(screen.getByRole("button", { name: "Change proxy" }));

    await waitFor(() => {
      expect(screen.getByTestId("group-selection")).toHaveTextContent("hkg-01");
      expect(screen.getByTestId("group-result")).toHaveTextContent("confirmed");
    });
  });

  it("keeps a timed-out group selection failed when bounded refreshes never confirm it", async () => {
    render(
      <TypesafeI18n locale="en">
        <ProductProvider client={new ConfirmedGroupTimeoutClient(null)}>
          <ConfirmedGroupRuntimeReplacementHarness />
        </ProductProvider>
      </TypesafeI18n>,
    );

    await waitFor(() => expect(screen.getByTestId("group-selection")).toHaveTextContent("hkg-02"));
    fireEvent.click(screen.getByRole("button", { name: "Change proxy" }));

    await waitFor(
      () => {
        expect(screen.getByTestId("group-selection")).toHaveTextContent("hkg-02");
        expect(screen.getByTestId("group-result")).toHaveTextContent("failed");
      },
      { timeout: 4_000 },
    );
  });

  it("keeps a runtime replacement failed when the observed child differs", async () => {
    render(
      <TypesafeI18n locale="en">
        <ProductProvider client={new ConfirmedGroupRuntimeReplacementClient("sin-01")}>
          <ConfirmedGroupRuntimeReplacementHarness />
        </ProductProvider>
      </TypesafeI18n>,
    );

    await waitFor(() => expect(screen.getByTestId("group-selection")).toHaveTextContent("hkg-02"));
    fireEvent.click(screen.getByRole("button", { name: "Change proxy" }));

    await waitFor(() => {
      expect(screen.getByTestId("group-selection")).toHaveTextContent("sin-01");
      expect(screen.getByTestId("group-result")).toHaveTextContent("failed");
    });
  });

  it("keeps a runtime replacement failed when the active Profile differs", async () => {
    render(
      <TypesafeI18n locale="en">
        <ProductProvider
          client={new ConfirmedGroupRuntimeReplacementClient("hkg-01", "profile-replacement")}
        >
          <ConfirmedGroupRuntimeReplacementHarness />
        </ProductProvider>
      </TypesafeI18n>,
    );

    await waitFor(() => expect(screen.getByTestId("group-selection")).toHaveTextContent("hkg-02"));
    fireEvent.click(screen.getByRole("button", { name: "Change proxy" }));

    await waitFor(() => {
      expect(screen.getByTestId("group-selection")).toHaveTextContent("hkg-01");
      expect(screen.getByTestId("group-result")).toHaveTextContent("failed");
    });
  });

  it("rejects a duplicate and keeps replacement work pending through an old completion and finally", async () => {
    const client = new DelayedRoutingClient();
    await client.initialize();
    render(
      <TypesafeI18n locale="en">
        <ProductProvider client={client}>
          <DelayedRoutingHarness />
        </ProductProvider>
      </TypesafeI18n>,
    );

    await waitFor(() => expect(screen.getByTestId("profile")).toHaveTextContent("home"));
    fireEvent.click(screen.getByRole("button", { name: "Change routing" }));
    fireEvent.click(screen.getByRole("button", { name: "Change routing" }));
    expect(client.requestCount()).toBe(1);
    expect(screen.getByTestId("pending")).toHaveTextContent("true");

    act(() => client.publishReplacement());
    await waitFor(() => {
      expect(screen.getByTestId("profile")).toHaveTextContent("profile-replacement");
      expect(screen.getByTestId("pending")).toHaveTextContent("false");
    });

    fireEvent.click(screen.getByRole("button", { name: "Change routing" }));
    expect(client.requestCount()).toBe(2);
    expect(screen.getByTestId("pending")).toHaveTextContent("true");

    const retired = await new FixtureStatusClient().getSnapshot();
    retired.applicationOrder.order += 1;
    retired.routingMode = "direct";
    await act(async () => client.resolve(0, retired));
    expect(screen.getByTestId("pending")).toHaveTextContent("true");
    expect(screen.getByTestId("routing")).toHaveTextContent("rule");

    const current = await client.getSnapshot();
    current.applicationOrder.order += 1;
    current.routingMode = "global";
    await act(async () => client.resolve(1, current));
    await waitFor(() => {
      expect(screen.getByTestId("pending")).toHaveTextContent("false");
      expect(screen.getByTestId("routing")).toHaveTextContent("global");
    });
  });

  it("aggregates concurrent group feedback by completion order", async () => {
    const client = new ConcurrentGroupClient();
    await client.initialize();
    render(
      <TypesafeI18n locale="en">
        <ProductProvider client={client}>
          <ConcurrentGroupHarness />
        </ProductProvider>
      </TypesafeI18n>,
    );

    await waitFor(() => expect(screen.getByTestId("group-phase")).toHaveTextContent("idle"));
    fireEvent.click(screen.getByRole("button", { name: "Change proxy" }));
    fireEvent.click(screen.getByRole("button", { name: "Change streaming" }));
    expect(client.requestCount()).toBe(2);
    expect(screen.getByTestId("group-phase")).toHaveTextContent("pending");

    await act(async () => client.resolve(1));
    expect(screen.getByTestId("group-phase")).toHaveTextContent("pending");

    await act(async () => client.reject(0));
    await waitFor(() => expect(screen.getByTestId("group-phase")).toHaveTextContent("failure"));
  });
});
