import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StatusClientError, type RoutingMode, type StatusSnapshotDto } from "@mish/contracts";
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
