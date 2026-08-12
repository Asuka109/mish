import { act, render, waitFor } from "@testing-library/react";
import type {
  TrafficCommandAuthorityDto,
  TrafficCommandOperation,
  TrafficCommandResultDto,
  TrafficClient,
  TrafficConnectionState,
  TrafficDataSnapshotDto,
} from "@mish/contracts";
import { describe, expect, it } from "vitest";
import { FixtureTrafficClient } from "./fixture-traffic-client";
import { TrafficProvider, useTraffic } from "./traffic-provider";
import { MobileTrafficClient } from "../platform/mobile-traffic-client";

let traffic: ReturnType<typeof useTraffic> | null = null;

function Probe() {
  traffic = useTraffic();
  return null;
}

class CommandTrafficClient extends FixtureTrafficClient {
  receivedAuthority: TrafficCommandAuthorityDto | null = null;

  override supportsCommand(_command: TrafficCommandOperation) {
    return true;
  }

  override async closeConnection(
    authority: TrafficCommandAuthorityDto,
    connectionId: string,
  ): Promise<TrafficCommandResultDto> {
    this.receivedAuthority = authority;
    const snapshot = await this.getSnapshot();
    const next = {
      ...snapshot,
      activeConnections: snapshot.activeConnections.filter(({ id }) => id !== connectionId),
      sequence: snapshot.sequence + 1,
    };
    this.publishSnapshot(next);
    return {
      failure: null,
      operation: "close-connection",
      remainingConnectionIds: [],
      snapshot: next,
      status: "success",
      targetCount: 1,
    };
  }
}

class DelayedTrafficClient extends FixtureTrafficClient {
  private readonly localConnectionListeners = new Set<(state: TrafficConnectionState) => void>();
  private readonly requests: Array<{
    connectionId: string;
    resolve(result: TrafficCommandResultDto): void;
  }> = [];
  private readonly localSnapshotListeners = new Set<
    (snapshot: TrafficDataSnapshotDto, delivery?: "baseline" | "update") => void
  >();
  private connectionState: TrafficConnectionState = {
    attempt: 0,
    phase: "fixture",
    stale: false,
  };
  private snapshotState!: TrafficDataSnapshotDto;

  async initialize() {
    this.snapshotState = await super.getSnapshot();
  }

  override closeConnection(
    _authority: TrafficCommandAuthorityDto,
    connectionId: string,
  ): Promise<TrafficCommandResultDto> {
    return new Promise((resolve) => {
      this.requests.push({ connectionId, resolve });
    });
  }

  override getConnectionState() {
    return this.connectionState;
  }

  override async getSnapshot() {
    return structuredClone(this.snapshotState);
  }

  override supportsCommand(command: TrafficCommandOperation) {
    return command === "close-connection";
  }

  override subscribeConnection(listener: (state: TrafficConnectionState) => void) {
    this.localConnectionListeners.add(listener);
    listener(this.connectionState);
    return () => this.localConnectionListeners.delete(listener);
  }

  override subscribeSnapshots(
    listener: (snapshot: TrafficDataSnapshotDto, delivery?: "baseline" | "update") => void,
  ) {
    this.localSnapshotListeners.add(listener);
    return () => this.localSnapshotListeners.delete(listener);
  }

  emitConnection(state: TrafficConnectionState) {
    this.connectionState = state;
    for (const listener of this.localConnectionListeners) listener(state);
  }

  publishBaseline() {
    for (const listener of this.localSnapshotListeners) {
      listener(structuredClone(this.snapshotState), "baseline");
    }
  }

  publishUpdate(snapshot: TrafficDataSnapshotDto) {
    this.snapshotState = structuredClone(snapshot);
    for (const listener of this.localSnapshotListeners) {
      listener(structuredClone(snapshot), "update");
    }
  }

  resolve(index: number, snapshot: TrafficDataSnapshotDto, commit = false) {
    const request = this.requests[index];
    if (!request) throw new Error(`Missing Traffic request ${index}`);
    if (commit) this.snapshotState = structuredClone(snapshot);
    request.resolve({
      failure: null,
      operation: "close-connection",
      remainingConnectionIds: [],
      snapshot: structuredClone(snapshot),
      status: "success",
      targetCount: 1,
    });
  }

  requestCount() {
    return this.requests.length;
  }
}

function renderProvider(client: TrafficClient) {
  traffic = null;
  return render(
    <TrafficProvider client={client}>
      <Probe />
    </TrafficProvider>,
  );
}

describe("TrafficProvider displayed snapshot", () => {
  it("accepts a mobile command delivery without superseding its own pending close", async () => {
    const initialClient = new FixtureTrafficClient();
    const initial = await initialClient.getSnapshot();
    const closed = {
      ...initial,
      activeConnections: initial.activeConnections.slice(1),
      adapterKind: "native" as const,
      applicationOrder: { ...initial.applicationOrder, order: initial.applicationOrder.order + 1 },
      sequence: initial.sequence + 1,
    };
    const client = new MobileTrafficClient({
      clearInterval: () => {},
      invoke: async (command, args) => {
        if (command === "get_traffic_snapshot") return { ...initial, adapterKind: "native" };
        const operationId = (args?.request as { operationId: string }).operationId;
        return {
          failure: null,
          operation: "close-connection",
          operationId,
          remainingConnectionIds: [],
          snapshot: closed,
          status: "success",
          targetCount: 1,
        };
      },
      setInterval: () => 1 as unknown as ReturnType<typeof setInterval>,
    });
    renderProvider(client);
    await waitFor(() => expect(traffic?.snapshot?.adapterKind).toBe("native"));

    let result: TrafficCommandResultDto | null | undefined;
    await act(async () => {
      result = await traffic?.closeConnection(initial.activeConnections[0]!.id);
    });

    expect(result?.status).toBe("success");
    expect(traffic?.isCloseConnectionPending(initial.activeConnections[0]!.id)).toBe(false);
    expect(traffic?.authoritativeSnapshot?.activeConnections).toHaveLength(
      initial.activeConnections.length - 1,
    );
  });

  it("retains current authority while one complete displayed snapshot is paused, then resumes atomically", async () => {
    const client = new FixtureTrafficClient();
    const initial = await client.getSnapshot();
    renderProvider(client);
    await waitFor(() => expect(traffic?.snapshot?.sequence).toBe(initial.sequence));

    act(() => traffic?.toggleViewPause());
    act(() => {
      client.publishSnapshot({
        ...initial,
        activeConnections: initial.activeConnections.slice(0, 1),
        rules: initial.rules.slice(0, 1),
        sequence: initial.sequence + 1,
      });
    });

    expect(traffic?.isViewPaused).toBe(true);
    expect(traffic?.snapshot?.activeConnections).toHaveLength(initial.activeConnections.length);
    expect(traffic?.snapshot?.rules).toHaveLength(initial.rules.length);
    expect(traffic?.authoritativeSnapshot?.activeConnections).toHaveLength(1);
    expect(traffic?.pausedUpdateCount).toBe(1);

    act(() => traffic?.toggleViewPause());
    expect(traffic?.isViewPaused).toBe(false);
    expect(traffic?.snapshot).toEqual(traffic?.authoritativeSnapshot);
  });

  it("expires a paused capture at a profile or Traffic-session boundary", async () => {
    const client = new FixtureTrafficClient();
    const initial = await client.getSnapshot();
    renderProvider(client);
    await waitFor(() => expect(traffic?.snapshot).not.toBeNull());

    act(() => traffic?.toggleViewPause());
    act(() => {
      client.publishSnapshot({
        ...initial,
        activeConnections: initial.activeConnections.slice(0, 1),
        profileId: "replacement-profile",
        sessionId: "replacement-session",
        sequence: 1,
      });
    });

    expect(traffic?.isViewPaused).toBe(false);
    expect(traffic?.snapshot?.profileId).toBe("replacement-profile");
    expect(traffic?.snapshot?.sessionId).toBe("replacement-session");
  });

  it("uses latest authority for a command initiated from a frozen connection", async () => {
    const client = new CommandTrafficClient();
    const initial = await client.getSnapshot();
    client.publishSnapshot({ ...initial, adapterKind: "rpc" });
    renderProvider(client);
    await waitFor(() => expect(traffic?.snapshot?.adapterKind).toBe("rpc"));

    act(() => traffic?.toggleViewPause());
    act(() => client.publishSnapshot({ ...initial, adapterKind: "rpc", sequence: 7 }));
    await act(async () => {
      await traffic?.closeConnection(initial.activeConnections[0]!.id);
    });

    expect(client.receivedAuthority).toMatchObject({ sequence: 7, sessionId: initial.sessionId });
    expect(traffic?.snapshot?.activeConnections).toHaveLength(initial.activeConnections.length);
    expect(traffic?.authoritativeSnapshot?.activeConnections).toHaveLength(
      initial.activeConnections.length - 1,
    );
  });

  it("does not let an older subscription snapshot restore a connection closed while paused", async () => {
    const client = new CommandTrafficClient();
    const initial = await client.getSnapshot();
    client.publishSnapshot({ ...initial, adapterKind: "rpc" });
    renderProvider(client);
    await waitFor(() => expect(traffic?.snapshot?.adapterKind).toBe("rpc"));

    act(() => traffic?.toggleViewPause());
    act(() => client.publishSnapshot({ ...initial, adapterKind: "rpc", sequence: 7 }));
    await act(async () => {
      await traffic?.closeConnection(initial.activeConnections[0]!.id);
    });
    act(() => client.publishSnapshot({ ...initial, adapterKind: "rpc", sequence: 7 }));
    act(() => traffic?.toggleViewPause());

    expect(traffic?.snapshot?.activeConnections.map(({ id }) => id)).not.toContain(
      initial.activeConnections[0]!.id,
    );
  });

  it("isolates disconnect, reconnect, duplicate, and remount feedback by operation identity", async () => {
    const client = new DelayedTrafficClient();
    await client.initialize();
    const initial = await client.getSnapshot();
    const rendered = renderProvider(client);
    await waitFor(() => expect(traffic?.snapshot?.sessionId).toBe(initial.sessionId));
    const firstId = initial.activeConnections[0]!.id;

    let duplicate: TrafficCommandResultDto | null | undefined;
    await act(async () => {
      void traffic?.closeConnection(firstId);
      duplicate = await traffic?.closeConnection(firstId);
    });
    expect(client.requestCount()).toBe(1);
    expect(duplicate).toBeNull();
    expect(traffic?.isCloseConnectionPending(firstId)).toBe(true);

    act(() => client.emitConnection({ attempt: 1, phase: "disconnected", stale: true }));
    await waitFor(() => expect(traffic?.isCloseConnectionPending(firstId)).toBe(false));

    act(() => {
      client.emitConnection({ attempt: 1, phase: "connected", stale: true });
      client.emitConnection({ attempt: 0, phase: "connected", stale: false });
      client.publishBaseline();
    });
    await waitFor(() => expect(traffic?.connection.stale).toBe(false));

    act(() => {
      void traffic?.closeConnection(firstId);
    });
    expect(client.requestCount()).toBe(2);
    expect(traffic?.isCloseConnectionPending(firstId)).toBe(true);

    const retired = {
      ...structuredClone(initial),
      activeConnections: initial.activeConnections.filter(({ id }) => id !== firstId),
      applicationOrder: { ...initial.applicationOrder, order: initial.applicationOrder.order + 1 },
      sequence: initial.sequence + 1,
    };
    await act(async () => client.resolve(0, retired));
    expect(traffic?.isCloseConnectionPending(firstId)).toBe(true);
    expect(traffic?.authoritativeSnapshot?.activeConnections.map(({ id }) => id)).toContain(
      firstId,
    );

    const current = {
      ...structuredClone(initial),
      activeConnections: initial.activeConnections.filter(({ id }) => id !== firstId),
      applicationOrder: { ...initial.applicationOrder, order: initial.applicationOrder.order + 2 },
      sequence: initial.sequence + 2,
    };
    await act(async () => client.resolve(1, current, true));
    await waitFor(() => expect(traffic?.isCloseConnectionPending(firstId)).toBe(false));
    expect(traffic?.authoritativeSnapshot?.activeConnections.map(({ id }) => id)).not.toContain(
      firstId,
    );

    const secondId = current.activeConnections[0]!.id;
    act(() => {
      void traffic?.closeConnection(secondId);
    });
    expect(client.requestCount()).toBe(3);
    const authoritativeCorrection = {
      ...structuredClone(current),
      applicationOrder: { ...current.applicationOrder, order: current.applicationOrder.order + 1 },
      sequence: current.sequence + 1,
    };
    act(() => client.publishUpdate(authoritativeCorrection));
    await waitFor(() => expect(traffic?.isCloseConnectionPending(secondId)).toBe(false));

    const staleAfterCorrection = {
      ...structuredClone(authoritativeCorrection),
      activeConnections: authoritativeCorrection.activeConnections.filter(
        ({ id }) => id !== secondId,
      ),
      applicationOrder: {
        ...authoritativeCorrection.applicationOrder,
        order: authoritativeCorrection.applicationOrder.order + 1,
      },
      sequence: authoritativeCorrection.sequence + 1,
    };
    await act(async () => client.resolve(2, staleAfterCorrection));
    expect(traffic?.authoritativeSnapshot?.activeConnections.map(({ id }) => id)).toContain(
      secondId,
    );

    act(() => {
      void traffic?.closeConnection(secondId);
    });
    expect(client.requestCount()).toBe(4);
    rendered.unmount();
    const staleAfterUnmount = {
      ...structuredClone(authoritativeCorrection),
      activeConnections: authoritativeCorrection.activeConnections.filter(
        ({ id }) => id !== secondId,
      ),
      applicationOrder: {
        ...authoritativeCorrection.applicationOrder,
        order: authoritativeCorrection.applicationOrder.order + 1,
      },
      sequence: authoritativeCorrection.sequence + 1,
    };
    await act(async () => client.resolve(3, staleAfterUnmount));

    renderProvider(client);
    await waitFor(() =>
      expect(traffic?.authoritativeSnapshot?.activeConnections.map(({ id }) => id)).toContain(
        secondId,
      ),
    );
  });
});
