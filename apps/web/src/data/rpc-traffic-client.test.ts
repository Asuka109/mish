import { mishRpcMethods, type TrafficDataSnapshotDto } from "@mish/contracts";
import { RpcClient, type WebSocketLike, type WebSocketLikeEventMap } from "@mish/rpc-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcTrafficClient } from "./rpc-traffic-client";

class FakeTransport implements WebSocketLike {
  readonly sent: string[] = [];
  readyState = 0;
  private listeners = new Map<keyof WebSocketLikeEventMap, Set<(event: never) => void>>();

  addEventListener<Type extends keyof WebSocketLikeEventMap>(
    type: Type,
    listener: (event: WebSocketLikeEventMap[Type]) => void,
  ) {
    const listeners = this.listeners.get(type) ?? new Set();
    listeners.add(listener as (event: never) => void);
    this.listeners.set(type, listeners);
  }

  close(code = 1000, reason = "") {
    this.readyState = 3;
    this.emit("close", { code, reason, wasClean: code === 1000 });
  }

  emit<Type extends keyof WebSocketLikeEventMap>(type: Type, event: WebSocketLikeEventMap[Type]) {
    for (const listener of this.listeners.get(type) ?? []) listener(event as never);
  }

  open() {
    this.readyState = 1;
    this.emit("open", {});
  }

  removeEventListener<Type extends keyof WebSocketLikeEventMap>(
    type: Type,
    listener: (event: WebSocketLikeEventMap[Type]) => void,
  ) {
    this.listeners.get(type)?.delete(listener as (event: never) => void);
  }

  respond(payload: unknown) {
    this.emit("message", { data: JSON.stringify(payload) });
  }

  send(data: string) {
    this.sent.push(data);
  }
}

function trafficSnapshot(overrides: Partial<TrafficDataSnapshotDto> = {}): TrafficDataSnapshotDto {
  return {
    activeConnections: [],
    adapterKind: "rpc",
    phase: "ready",
    profileId: "fixture-profile",
    reconnectCount: 0,
    rules: [],
    sequence: 1,
    sessionId: "controller-1",
    ...overrides,
  };
}

async function waitForRequest(transport: FakeTransport, index: number) {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (transport.sent[index]) return JSON.parse(transport.sent[index]);
    await Promise.resolve();
  }
  throw new Error(`RPC request ${index} was not sent`);
}

async function authenticate(transport: FakeTransport) {
  transport.open();
  const request = await waitForRequest(transport, 0);
  transport.respond({
    id: request.id,
    jsonrpc: "2.0",
    result: { authenticated: true, sessionId: "rpc-session" },
  });
}

async function advertiseTrafficCommands(
  transport: FakeTransport,
  supported = true,
  requestIndex = 1,
) {
  const request = await waitForRequest(transport, requestIndex);
  expect(request.method).toBe("bridge.getInfo");
  transport.respond({
    id: request.id,
    jsonrpc: "2.0",
    result: {
      bridgeVersion: "test",
      coreConfigured: true,
      protocolVersion: 10,
      statusCommands: { group: false, groupDelay: false, routing: false },
      trafficCommands: { closeAllActive: supported, closeConnection: supported },
    },
  });
  await flushMicrotasks();
}

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("RpcTrafficClient", () => {
  it("exposes strictly typed close commands in the RPC method map", () => {
    expect("traffic.closeConnection" in mishRpcMethods).toBe(true);
    expect("traffic.closeAllActive" in mishRpcMethods).toBe(true);
  });

  it("resubscribes with an authoritative snapshot and exposes the reconnect gap as stale", async () => {
    vi.useFakeTimers();
    const transports = [new FakeTransport(), new FakeTransport()];
    let transportIndex = 0;
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      backoff: { initialDelayMilliseconds: 5, maximumReconnectAttempts: 1 },
      methods: mishRpcMethods,
      transportFactory: () => transports[transportIndex++],
    });
    const client = new RpcTrafficClient(rpc);
    const snapshots: TrafficDataSnapshotDto[] = [];
    const states: string[] = [];
    client.subscribeSnapshots((snapshot) => snapshots.push(snapshot));
    client.subscribeConnection((state) => states.push(`${state.phase}:${state.stale}`));

    await authenticate(transports[0]);
    await advertiseTrafficCommands(transports[0]);
    const firstSubscribe = await waitForRequest(transports[0], 2);
    transports[0].respond({
      id: firstSubscribe.id,
      jsonrpc: "2.0",
      result: { snapshot: trafficSnapshot(), subscriptionId: "traffic-1" },
    });
    await flushMicrotasks();
    expect(snapshots.at(-1)?.sessionId).toBe("controller-1");

    transports[0].close(1006, "gap");
    expect(states.at(-1)).toContain("true");
    await vi.advanceTimersByTimeAsync(5);
    await authenticate(transports[1]);
    await advertiseTrafficCommands(transports[1]);
    const secondSubscribe = await waitForRequest(transports[1], 2);
    transports[1].respond({
      id: secondSubscribe.id,
      jsonrpc: "2.0",
      result: {
        snapshot: trafficSnapshot({ reconnectCount: 1, sequence: 2, sessionId: "controller-2" }),
        subscriptionId: "traffic-2",
      },
    });
    await flushMicrotasks();

    expect(snapshots.at(-1)?.sessionId).toBe("controller-2");
    expect(states.at(-1)).toBe("connected:false");
    client.dispose();
    rpc.dispose();
  });

  it("rejects malformed Traffic results at the RPC boundary", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcTrafficClient(rpc);
    const requestPromise = client.getSnapshot();
    await authenticate(transport);
    await advertiseTrafficCommands(transport);
    const request = await waitForRequest(transport, 2);
    transport.respond({
      id: request.id,
      jsonrpc: "2.0",
      result: { ...trafficSnapshot(), activeConnections: [{ id: "missing-fields" }] },
    });

    await expect(requestPromise).rejects.toMatchObject({ code: "validation" });
    client.dispose();
    rpc.dispose();
  });

  it("cancels an in-flight snapshot without accepting a late result", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcTrafficClient(rpc);
    const controller = new AbortController();
    const requestPromise = client.getSnapshot({ signal: controller.signal });
    await authenticate(transport);
    await advertiseTrafficCommands(transport);
    const request = await waitForRequest(transport, 2);
    controller.abort();

    await expect(requestPromise).rejects.toMatchObject({ code: "cancelled" });
    expect(JSON.parse(transport.sent.at(-1) ?? "{}")).toMatchObject({
      method: "rpc.cancel",
      params: { requestId: request.id },
    });
    transport.respond({ id: request.id, jsonrpc: "2.0", result: trafficSnapshot() });
    client.dispose();
    rpc.dispose();
  });

  it("sends only stable snapshot authority and accepts a confirmed typed result", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcTrafficClient(rpc);
    const authority = { profileId: "profile-a", sequence: 7, sessionId: "controller-1" };
    const command = client.closeConnection(authority, "stable-connection-id");
    await authenticate(transport);
    await advertiseTrafficCommands(transport);
    const request = await waitForRequest(transport, 2);
    expect(request).toMatchObject({
      method: "traffic.closeConnection",
      params: { authority, connectionId: "stable-connection-id" },
    });
    expect(JSON.stringify(request.params)).not.toMatch(/destination|process|path|url/iu);
    transport.respond({
      id: request.id,
      jsonrpc: "2.0",
      result: {
        failure: null,
        operation: "close-connection",
        remainingConnectionIds: [],
        snapshot: trafficSnapshot({ activeConnections: [], sequence: 8 }),
        status: "success",
        targetCount: 1,
      },
    });

    await expect(command).resolves.toMatchObject({ status: "success", targetCount: 1 });
    expect(client.supportsCommand("close-connection")).toBe(true);
    client.dispose();
    rpc.dispose();
  });
});
