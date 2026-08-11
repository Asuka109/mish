import {
  mishRpcMethods,
  type NotificationPresentationClaimDto,
  type NotificationSnapshotDto,
} from "@mish/contracts";
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
              pinned: false,
              presentation: { actionIds: [], data: {}, kind: "profile.saved" },
              presentationState: { phase: "unpresented" },
              read: false,
              resolved: false,
              revision,
              severity: "success",
            },
          ],
    revision,
  };
}

function presentingSnapshot(revision: number, leaseGeneration: number): NotificationSnapshotDto {
  const value = snapshot(revision);
  const record = value.notifications[0];
  if (record) {
    record.presentationState = {
      leaseExpiresAt: 90_000,
      leaseGeneration,
      phase: "presenting",
    };
  }
  return value;
}

function claimFor(snapshot: NotificationSnapshotDto): NotificationPresentationClaimDto {
  const record = snapshot.notifications[0];
  if (!record || record.presentationState.phase !== "presenting") {
    throw new Error("A presenting notification is required");
  }
  return {
    id: record.id,
    leaseExpiresAt: record.presentationState.leaseExpiresAt,
    leaseGeneration: record.presentationState.leaseGeneration,
    revision: record.revision,
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
  it("keeps an unclaimed subscription baseline historical until the server returns a lease", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcNotificationClient(rpc);
    const publication = client.publish({
      dedupeKey: "profile.saved",
      pinned: false,
      presentation: { actionIds: [], data: {}, kind: "profile.saved" },
      replaces: [],
      resolved: false,
      severity: "success",
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
    expect(subscribeRequest.params).toEqual({
      clientId: expect.stringMatching(/^notification-client-/),
      sessionId: expect.stringMatching(/^notification-session-/),
    });
    transport.respond({
      id: subscribeRequest.id,
      jsonrpc: "2.0",
      result: { claim: null, snapshot: snapshot(1), subscriptionId: "notifications-1" },
    });
    await flushMicrotasks();
    expect(deliveries).toEqual(["baseline:1"]);

    client.dispose();
    rpc.dispose();
  });

  it("binds completion acknowledgements to the subscription identity and ignores equal snapshots", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcNotificationClient(rpc);
    const deliveries: Array<{
      claim: NotificationPresentationClaimDto | null | undefined;
      kind: string;
    }> = [];
    client.subscribeSnapshots(({ claim, kind }) => deliveries.push({ claim, kind }));

    await authenticate(transport);
    const subscribeRequest = await waitForRequest(transport, 1);
    const activeSnapshot = presentingSnapshot(1, 1);
    const claim = claimFor(activeSnapshot);
    transport.respond({
      id: subscribeRequest.id,
      jsonrpc: "2.0",
      result: { claim, snapshot: activeSnapshot, subscriptionId: "notifications-1" },
    });
    await flushMicrotasks();
    expect(deliveries).toEqual([{ claim, kind: "baseline" }]);

    transport.respond({
      jsonrpc: "2.0",
      method: "notifications.snapshot",
      params: { snapshot: activeSnapshot, subscriptionId: "notifications-1" },
    });
    await flushMicrotasks();
    expect(deliveries).toHaveLength(1);

    const completion = client.completePresentation(claim, "dismissed");
    const completionRequest = await waitForRequest(transport, 2);
    expect(completionRequest.params).toEqual({
      ...subscribeRequest.params,
      id: claim.id,
      leaseGeneration: claim.leaseGeneration,
      outcome: "dismissed",
      revision: claim.revision,
    });
    const foldedSnapshot = snapshot(2);
    const folded = foldedSnapshot.notifications[0];
    if (folded) {
      folded.presentationState = {
        foldReason: "dismissed",
        foldedAt: 1,
        phase: "folded",
      };
    }
    transport.respond({
      id: completionRequest.id,
      jsonrpc: "2.0",
      result: { accepted: true, snapshot: foldedSnapshot },
    });
    await expect(completion).resolves.toMatchObject({ accepted: true });
    await flushMicrotasks();
    expect(deliveries).toEqual([
      { claim, kind: "baseline" },
      { claim: undefined, kind: "update" },
    ]);

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
      result: { claim: null, snapshot: snapshot(1), subscriptionId: "notifications-1" },
    });
    await flushMicrotasks();

    const conflict = snapshot(1);
    conflict.notifications[0]!.read = true;
    transports[0].respond({
      jsonrpc: "2.0",
      method: "notifications.snapshot",
      params: { snapshot: conflict, subscriptionId: "notifications-1" },
    });
    await flushMicrotasks();
    expect(deliveries).toEqual(["baseline:1"]);
    expect(client.getConnectionState()).toMatchObject({ phase: "connected", stale: true });

    transports[0].respond({
      jsonrpc: "2.0",
      method: "notifications.snapshot",
      params: { snapshot: snapshot(2), subscriptionId: "notifications-1" },
    });
    transports[0].respond({
      jsonrpc: "2.0",
      method: "notifications.snapshot",
      params: { snapshot: snapshot(1), subscriptionId: "notifications-1" },
    });
    transports[0].respond({
      jsonrpc: "2.0",
      method: "notifications.snapshot",
      params: { snapshot: snapshot(2), subscriptionId: "notifications-1" },
    });
    await flushMicrotasks();
    expect(deliveries).toEqual(["baseline:1", "update:2"]);
    expect(client.getConnectionState()).toMatchObject({ phase: "connected", stale: false });

    transports[0].close(1006, "gap");
    await vi.advanceTimersByTimeAsync(5);
    await authenticate(transports[1]);
    const secondSubscribe = await waitForRequest(transports[1], 1);
    expect(secondSubscribe.params.clientId).toBe(firstSubscribe.params.clientId);
    expect(secondSubscribe.params.sessionId).not.toBe(firstSubscribe.params.sessionId);
    transports[1].respond({
      id: secondSubscribe.id,
      jsonrpc: "2.0",
      result: { claim: null, snapshot: snapshot(3), subscriptionId: "notifications-2" },
    });
    await flushMicrotasks();
    expect(deliveries).toEqual(["baseline:1", "update:2", "baseline:3"]);

    client.dispose();
    rpc.dispose();
  });
});
