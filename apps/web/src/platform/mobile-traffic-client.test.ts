import { describe, expect, it, vi } from "vitest";
import type { TrafficDataSnapshotDto } from "@mish/contracts";
import { MobileTrafficClient } from "./mobile-traffic-client";

function snapshot(overrides: Partial<TrafficDataSnapshotDto> = {}): TrafficDataSnapshotDto {
  return {
    activeConnections: [
      {
        destinationHost: "traffic.fixture.invalid",
        destinationIp: "192.0.2.44",
        destinationPort: 443,
        downloadBytes: "2048",
        id: "fixture-connection-current",
        matchedRule: { payload: "fixture.invalid", type: "DomainSuffix" },
        network: "tcp",
        processName: "Fixture App",
        processPath: null,
        protocol: "Tun",
        providerChain: [],
        remoteDestination: null,
        routeChain: ["Fixture Group", "Fixture Exit"],
        sniffHost: null,
        sourceIp: null,
        sourcePort: 40000,
        startedAt: "2026-08-13T00:00:00Z",
        uploadBytes: "1024",
      },
    ],
    adapterKind: "native",
    applicationOrder: { authorityId: "runtime-a", epoch: 1, order: 1 },
    phase: "ready",
    profileId: "profile-a",
    reconnectCount: 0,
    rules: [],
    sequence: 1,
    sessionId: "traffic-a",
    ...overrides,
  };
}

describe("MobileTrafficClient", () => {
  it("projects one native close with the provider operation identity", async () => {
    const initial = snapshot();
    const closed = snapshot({
      activeConnections: [],
      applicationOrder: { authorityId: "runtime-a", epoch: 1, order: 2 },
      sequence: 2,
    });
    const invoke = vi.fn(async (command: string) => {
      if (command === "get_traffic_snapshot") return initial;
      if (command === "close_traffic_connection") {
        return {
          failure: null,
          operation: "close-connection",
          operationId: "provider-operation",
          remainingConnectionIds: [],
          snapshot: closed,
          status: "success",
          targetCount: 1,
        };
      }
      throw new Error(`unexpected command ${command}`);
    });
    const client = new MobileTrafficClient({
      clearInterval: vi.fn(),
      invoke,
      setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
    });
    await client.getSnapshot();
    const result = await client.closeConnection(
      { profileId: "profile-a", sequence: 1, sessionId: "traffic-a" },
      "fixture-connection-current",
      { operationId: "provider-operation" },
    );
    expect(invoke).toHaveBeenLastCalledWith("close_traffic_connection", {
      request: {
        connectionId: "fixture-connection-current",
        operationId: "provider-operation",
        profileId: "profile-a",
        runtimeAuthorityId: "runtime-a",
        sequence: 1,
        sessionId: "traffic-a",
      },
    });
    expect(result).toMatchObject({ status: "success", snapshot: { activeConnections: [] } });
  });

  it("exposes only close-one and marks polling failures stale", async () => {
    let reject = false;
    const connectionStates: boolean[] = [];
    let poll: (() => void) | undefined;
    const client = new MobileTrafficClient({
      clearInterval: vi.fn(),
      invoke: vi.fn(async () => {
        if (reject) throw new Error("native boundary unavailable");
        return snapshot();
      }),
      setInterval: vi.fn((callback) => {
        poll = callback;
        return 1 as unknown as ReturnType<typeof setInterval>;
      }),
    });
    client.subscribeConnection((state) => connectionStates.push(state.stale));
    client.subscribeSnapshots(() => {});
    await vi.waitFor(() => expect(connectionStates.at(-1)).toBe(false));
    reject = true;
    poll?.();
    await vi.waitFor(() => expect(connectionStates.at(-1)).toBe(true));
    expect(client.supportsCommand("close-connection")).toBe(true);
    expect(client.supportsCommand("close-all-active")).toBe(false);
    expect(client.supportsCommand("close-filtered-visible")).toBe(false);
    expect(connectionStates).toEqual([true, false, true]);
  });

  it("cancels before dispatch without crossing the native mutation boundary", async () => {
    const invoke = vi.fn(async () => snapshot());
    const client = new MobileTrafficClient({
      clearInterval: vi.fn(),
      invoke,
      setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
    });
    await client.getSnapshot();
    const controller = new AbortController();
    controller.abort();
    const result = await client.closeConnection(
      { profileId: "profile-a", sequence: 1, sessionId: "traffic-a" },
      "fixture-connection-current",
      { operationId: "cancelled-operation", signal: controller.signal },
    );
    expect(result.failure).toBe("disconnected");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("accepts an authoritative close snapshot even when cancellation races after dispatch", async () => {
    const controller = new AbortController();
    const closed = snapshot({ activeConnections: [], sequence: 2 });
    const snapshots: number[] = [];
    const client = new MobileTrafficClient({
      clearInterval: vi.fn(),
      invoke: vi.fn(async (command) => {
        if (command === "get_traffic_snapshot") return snapshot();
        controller.abort();
        return {
          failure: null,
          operation: "close-connection",
          operationId: "racing-operation",
          remainingConnectionIds: [],
          snapshot: closed,
          status: "success",
          targetCount: 1,
        };
      }),
      setInterval: vi.fn(() => 1 as unknown as ReturnType<typeof setInterval>),
    });
    client.subscribeSnapshots((value) => snapshots.push(value.sequence));
    await client.getSnapshot();
    const result = await client.closeConnection(
      { profileId: "profile-a", sequence: 1, sessionId: "traffic-a" },
      "fixture-connection-current",
      { operationId: "racing-operation", signal: controller.signal },
    );
    expect(result.failure).toBe("disconnected");
    expect(snapshots).toContain(2);
    expect((await client.getSnapshot()).activeConnections).toEqual([]);
  });
});
