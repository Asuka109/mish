import { mishRpcMethods, type EventsSnapshotDto } from "@mish/contracts";
import { RpcClient, type WebSocketLike, type WebSocketLikeEventMap } from "@mish/rpc-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcEventsClient } from "./rpc-events-client";

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

function eventsSnapshot(overrides: Partial<EventsSnapshotDto> = {}): EventsSnapshotDto {
  const sessionId = overrides.sessionId ?? "events-session-1";
  const epoch = Number(sessionId?.match(/(\d+)$/u)?.[1] ?? 1);
  return {
    adapterKind: "rpc",
    applicationOrder: {
      authorityId: "events-application",
      epoch,
      order: overrides.sequence ?? 1,
    },
    events: [],
    phase: "ready",
    profileId: "fixture-profile",
    reconnectCount: 0,
    sequence: 1,
    sessionId: "events-session-1",
    sourceStatuses: ["application", "core", "platform", "rpc"].map((source) => ({
      detail: null,
      phase: source === "core" ? ("ready" as const) : ("unavailable" as const),
      source: source as "application" | "core" | "platform" | "rpc",
    })),
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

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

afterEach(() => vi.useRealTimers());

describe("RpcEventsClient", () => {
  it("lets a zero-listener reconnect read establish B without reopening delayed A", async () => {
    vi.useFakeTimers();
    const transports = [new FakeTransport(), new FakeTransport()];
    let transportIndex = 0;
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      backoff: { initialDelayMilliseconds: 5, maximumReconnectAttempts: 1 },
      methods: mishRpcMethods,
      transportFactory: () => transports[transportIndex++],
    });
    const client = new RpcEventsClient(rpc);

    const firstRead = client.getSnapshot();
    await authenticate(transports[0]);
    const firstRequest = await waitForRequest(transports[0], 1);
    const authorityA = eventsSnapshot();
    authorityA.applicationOrder.authorityId = "events-authority-A";
    transports[0].respond({ id: firstRequest.id, jsonrpc: "2.0", result: authorityA });
    await expect(firstRead).resolves.toMatchObject({
      applicationOrder: { authorityId: "events-authority-A" },
    });

    transports[0].close(1006, "restart");
    await vi.advanceTimersByTimeAsync(5);
    await authenticate(transports[1]);
    expect(client.getConnectionState().stale).toBe(true);

    const secondRead = client.getSnapshot();
    const secondRequest = await waitForRequest(transports[1], 1);
    const authorityB = eventsSnapshot();
    authorityB.applicationOrder = { authorityId: "events-authority-B", epoch: 1, order: 1 };
    transports[1].respond({ id: secondRequest.id, jsonrpc: "2.0", result: authorityB });
    await expect(secondRead).resolves.toMatchObject({
      applicationOrder: { authorityId: "events-authority-B" },
    });
    expect(client.getConnectionState().stale).toBe(false);

    const lateRead = client.getSnapshot();
    const lateRequest = await waitForRequest(transports[1], 2);
    const delayedA = structuredClone(authorityA);
    delayedA.applicationOrder.order = 99;
    transports[1].respond({ id: lateRequest.id, jsonrpc: "2.0", result: delayedA });
    await expect(lateRead).resolves.toMatchObject({
      applicationOrder: { authorityId: "events-authority-B" },
    });

    client.dispose();
    rpc.dispose();
  });

  it("resubscribes with an authoritative new session and exposes reconnect as stale", async () => {
    vi.useFakeTimers();
    const transports = [new FakeTransport(), new FakeTransport()];
    let transportIndex = 0;
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      backoff: { initialDelayMilliseconds: 5, maximumReconnectAttempts: 1 },
      methods: mishRpcMethods,
      transportFactory: () => transports[transportIndex++],
    });
    const client = new RpcEventsClient(rpc);
    const snapshots: EventsSnapshotDto[] = [];
    const deliveries: Array<string | undefined> = [];
    const states: string[] = [];
    client.subscribeSnapshots((snapshot, delivery) => {
      snapshots.push(snapshot);
      deliveries.push(delivery);
    });
    client.subscribeConnection((state) => states.push(`${state.phase}:${state.stale}`));

    await authenticate(transports[0]);
    const firstSubscribe = await waitForRequest(transports[0], 1);
    transports[0].respond({
      id: firstSubscribe.id,
      jsonrpc: "2.0",
      result: { snapshot: eventsSnapshot(), subscriptionId: "events-1" },
    });
    await flushMicrotasks();
    expect(snapshots.at(-1)?.sessionId).toBe("events-session-1");
    expect(deliveries).toEqual(["baseline"]);

    transports[0].close(1006, "gap");
    expect(states.at(-1)).toContain("true");
    await vi.advanceTimersByTimeAsync(5);
    await authenticate(transports[1]);
    const secondSubscribe = await waitForRequest(transports[1], 1);
    transports[1].respond({
      id: secondSubscribe.id,
      jsonrpc: "2.0",
      result: {
        snapshot: eventsSnapshot({
          reconnectCount: 1,
          sequence: 1,
          sessionId: "events-session-2",
        }),
        subscriptionId: "events-2",
      },
    });
    await flushMicrotasks();

    expect(snapshots.at(-1)?.sessionId).toBe("events-session-2");
    expect(deliveries).toEqual(["baseline", "baseline"]);
    expect(states.at(-1)).toBe("connected:false");
    const lateOldSnapshot = eventsSnapshot({
      sessionId: "events-session-1",
      sequence: 99,
    });
    transports[1].respond({
      jsonrpc: "2.0",
      method: "events.snapshot",
      params: { snapshot: lateOldSnapshot, subscriptionId: "events-1" },
    });
    expect(snapshots.at(-1)?.sessionId).toBe("events-session-2");
    client.dispose();
    rpc.dispose();
  });

  it("rejects duplicate and equal-order conflicting event deliveries", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcEventsClient(rpc);
    const snapshots: EventsSnapshotDto[] = [];
    const states: string[] = [];
    client.subscribeSnapshots((snapshot) => snapshots.push(snapshot));
    client.subscribeConnection((state) => states.push(`${state.phase}:${state.stale}`));

    await authenticate(transport);
    const subscribe = await waitForRequest(transport, 1);
    const baseline = eventsSnapshot();
    transport.respond({
      id: subscribe.id,
      jsonrpc: "2.0",
      result: { snapshot: baseline, subscriptionId: "events-1" },
    });
    await flushMicrotasks();
    expect(snapshots).toHaveLength(1);

    transport.respond({
      jsonrpc: "2.0",
      method: "events.snapshot",
      params: { snapshot: structuredClone(baseline), subscriptionId: "events-1" },
    });
    expect(snapshots).toHaveLength(1);
    expect(states.at(-1)).toBe("connected:false");

    const conflict = structuredClone(baseline);
    conflict.phase = "stale";
    transport.respond({
      jsonrpc: "2.0",
      method: "events.snapshot",
      params: { snapshot: conflict, subscriptionId: "events-1" },
    });
    expect(snapshots).toHaveLength(1);
    expect(states.at(-1)).toBe("connected:true");

    const newer = structuredClone(baseline);
    newer.applicationOrder.order = 2;
    newer.sequence = 2;
    transport.respond({
      jsonrpc: "2.0",
      method: "events.snapshot",
      params: { snapshot: newer, subscriptionId: "events-1" },
    });
    expect(snapshots.at(-1)?.applicationOrder.order).toBe(2);
    expect(states.at(-1)).toBe("connected:false");
    client.dispose();
    rpc.dispose();
  });

  it("rejects malformed Events results at the authenticated RPC boundary", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcEventsClient(rpc);
    const requestPromise = client.getSnapshot();
    await authenticate(transport);
    const request = await waitForRequest(transport, 1);
    transport.respond({
      id: request.id,
      jsonrpc: "2.0",
      result: { ...eventsSnapshot(), events: [{ id: "missing-fields" }] },
    });

    await expect(requestPromise).rejects.toMatchObject({ code: "validation" });
    client.dispose();
    rpc.dispose();
  });
});
