import { mishRpcMethods, type NotificationSnapshotDto } from "@mish/contracts";
import { RpcClient, type WebSocketLike, type WebSocketLikeEventMap } from "@mish/rpc-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RpcNotificationClient } from "./rpc-notification-client";

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

function snapshot(revision: number): NotificationSnapshotDto {
  return {
    notifications:
      revision === 0
        ? []
        : [
            {
              createdRevision: 1,
              dedupeKey: "profile.saved",
              id: "notification:1",
              observedAt: 1,
              params: {},
              read: false,
              resolved: false,
              revision,
              severity: "success",
              type: "profile.saved",
            },
          ],
    revision,
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

describe("RpcNotificationClient", () => {
  it("treats a publication that races initial subscription as baseline history", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcNotificationClient(rpc);
    const publication = client.publish({
      dedupeKey: "profile.saved",
      params: {},
      replaces: [],
      resolved: false,
      severity: "success",
      type: "profile.saved",
    });

    await authenticate(transport);
    const publishRequest = await waitForRequest(transport, 1);
    transport.respond({ id: publishRequest.id, jsonrpc: "2.0", result: snapshot(1) });
    await publication;

    const deliveries: string[] = [];
    client.subscribeSnapshots(({ kind, snapshot }) =>
      deliveries.push(`${kind}:${snapshot.revision}`),
    );
    const subscribeRequest = await waitForRequest(transport, 2);
    transport.respond({
      id: subscribeRequest.id,
      jsonrpc: "2.0",
      result: { snapshot: snapshot(1), subscriptionId: "notifications-1" },
    });
    await flushMicrotasks();
    expect(deliveries).toEqual(["baseline:1"]);

    client.dispose();
    rpc.dispose();
  });

  it("delivers explicit baselines, rejects stale revisions, and resubscribes without replay", async () => {
    vi.useFakeTimers();
    const transports = [new FakeTransport(), new FakeTransport()];
    let transportIndex = 0;
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      backoff: { initialDelayMilliseconds: 5, maximumReconnectAttempts: 1 },
      methods: mishRpcMethods,
      transportFactory: () => transports[transportIndex++],
    });
    const client = new RpcNotificationClient(rpc);
    const deliveries: string[] = [];
    client.subscribeSnapshots(({ kind, snapshot }) =>
      deliveries.push(`${kind}:${snapshot.revision}`),
    );

    await authenticate(transports[0]);
    const firstSubscribe = await waitForRequest(transports[0], 1);
    transports[0].respond({
      id: firstSubscribe.id,
      jsonrpc: "2.0",
      result: { snapshot: snapshot(1), subscriptionId: "notifications-1" },
    });
    await flushMicrotasks();
    transports[0].respond({
      jsonrpc: "2.0",
      method: "notifications.snapshot",
      params: { snapshot: snapshot(2), subscriptionId: "notifications-1" },
    });
    transports[0].respond({
      jsonrpc: "2.0",
      method: "notifications.snapshot",
      params: { snapshot: snapshot(2), subscriptionId: "notifications-1" },
    });
    await flushMicrotasks();
    expect(deliveries).toEqual(["baseline:1", "update:2"]);

    transports[0].close(1006, "gap");
    await vi.advanceTimersByTimeAsync(5);
    await authenticate(transports[1]);
    const secondSubscribe = await waitForRequest(transports[1], 1);
    transports[1].respond({
      id: secondSubscribe.id,
      jsonrpc: "2.0",
      result: { snapshot: snapshot(3), subscriptionId: "notifications-2" },
    });
    await flushMicrotasks();
    expect(deliveries).toEqual(["baseline:1", "update:2", "baseline:3"]);

    client.dispose();
    rpc.dispose();
  });
});
