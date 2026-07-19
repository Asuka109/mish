import { StatusClientError, mishRpcMethods, type StatusSnapshotDto } from "@mish/contracts";
import { RpcClient, type WebSocketLike, type WebSocketLikeEventMap } from "@mish/rpc-client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FixtureStatusClient } from "./fixture-status-client";
import { RpcStatusClient } from "./rpc-status-client";

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

async function waitForRequest(transport: FakeTransport, index: number) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
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
    result: { authenticated: true, sessionId: "session" },
  });
}

async function flushMicrotasks() {
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

async function createRpcSnapshot(): Promise<StatusSnapshotDto> {
  const snapshot = await new FixtureStatusClient().getSnapshot();
  snapshot.adapterKind = "rpc";
  snapshot.profiles[0].label = "配置 🌏";
  snapshot.capabilities = { systemProxy: "supported", tun: "permission-required" };
  return snapshot;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RpcStatusClient", () => {
  it("sends remembered capture selection separately from aggregate active state", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcStatusClient(rpc);
    expect(client.supportsCommand("capture")).toBe(true);

    const selection = { systemProxy: false, tun: true };
    const command = client.setCapture(selection, false);
    await authenticate(transport);
    const request = await waitForRequest(transport, 1);
    expect(request).toMatchObject({
      method: "status.setCapture",
      params: { active: false, selection },
    });

    const snapshot = await createRpcSnapshot();
    snapshot.runtime.captureSelection = selection;
    snapshot.runtime.systemProxyEnabled = false;
    snapshot.runtime.tunEnabled = false;
    snapshot.runtime.phase = "inactive";
    transport.respond({ id: request.id, jsonrpc: "2.0", result: snapshot });

    await expect(command).resolves.toMatchObject({
      runtime: { captureSelection: selection, phase: "inactive" },
    });
    client.dispose();
  });

  it("sends a bounded typed System Proxy recovery action", async () => {
    const transport = new FakeTransport();
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      methods: mishRpcMethods,
      transportFactory: () => transport,
    });
    const client = new RpcStatusClient(rpc);

    const recovery = client.recoverSystemProxy("repair");
    await authenticate(transport);
    const request = await waitForRequest(transport, 1);
    expect(request).toMatchObject({
      method: "status.recoverSystemProxy",
      params: { action: "repair" },
    });
    const snapshot = await createRpcSnapshot();
    snapshot.runtime.systemProxy = {
      desired: true,
      failure: null,
      observed: "mish",
      phase: "applied",
      recoveryActions: [],
    };
    snapshot.runtime.systemProxyEnabled = true;
    transport.respond({ id: request.id, jsonrpc: "2.0", result: snapshot });

    await expect(recovery).resolves.toMatchObject({
      runtime: { systemProxy: { phase: "applied" } },
    });
    client.dispose();
  });

  it("drives snapshots, subscriptions, reconnect, commands, and typed failure end to end", async () => {
    vi.useFakeTimers();
    const snapshot = await createRpcSnapshot();
    const transports = [new FakeTransport(), new FakeTransport()];
    let transportIndex = 0;
    const rpc = new RpcClient({
      authentication: () => ({ clientName: "web", clientVersion: "test", token: "secret" }),
      backoff: { initialDelayMilliseconds: 5, maximumReconnectAttempts: 1 },
      methods: mishRpcMethods,
      transportFactory: () => transports[transportIndex++],
    });
    const client = new RpcStatusClient(rpc);
    const receivedSnapshots: StatusSnapshotDto[] = [];
    const connectionStates: string[] = [];
    const unsubscribeSnapshot = client.subscribeSnapshots((next) => receivedSnapshots.push(next));
    const unsubscribeConnection = client.subscribeConnection((state) =>
      connectionStates.push(`${state.phase}:${state.stale}`),
    );

    await authenticate(transports[0]);
    const subscribeRequest = await waitForRequest(transports[0], 1);
    expect(subscribeRequest.method).toBe("status.subscribe");
    transports[0].respond({
      id: subscribeRequest.id,
      jsonrpc: "2.0",
      result: { snapshot, subscriptionId: "subscription-1" },
    });
    await flushMicrotasks();
    transports[0].respond({
      jsonrpc: "2.0",
      method: "status.snapshot",
      params: { snapshot, subscriptionId: "subscription-1" },
    });
    expect(receivedSnapshots.at(-1)?.profiles[0].label).toBe("配置 🌏");
    expect(client.getConnectionState()).toMatchObject({ phase: "connected", stale: false });
    const snapshotsBeforeReconnect = receivedSnapshots.length;

    const getSnapshot = client.getSnapshot();
    const snapshotRequest = await waitForRequest(transports[0], 2);
    transports[0].respond({ id: snapshotRequest.id, jsonrpc: "2.0", result: snapshot });
    await expect(getSnapshot).resolves.toMatchObject({ adapterKind: "rpc" });

    const command = client.setRoutingMode("global");
    const commandRequest = await waitForRequest(transports[0], 3);
    transports[0].respond({
      error: { code: -32_009, message: "Routing mode is changing" },
      id: commandRequest.id,
      jsonrpc: "2.0",
    });
    const commandError = await command.catch((error: unknown) => error);
    expect(commandError).toEqual(
      expect.objectContaining<Partial<StatusClientError>>({
        code: "conflict",
        retryable: true,
      }),
    );

    transports[0].close(1006, "Lost");
    expect(client.getConnectionState()).toMatchObject({ phase: "reconnecting", stale: true });
    await vi.advanceTimersByTimeAsync(5);
    await authenticate(transports[1]);
    const resubscribeRequest = await waitForRequest(transports[1], 1);
    expect(resubscribeRequest.method).toBe("status.subscribe");
    transports[1].respond({
      id: resubscribeRequest.id,
      jsonrpc: "2.0",
      result: { snapshot, subscriptionId: "subscription-2" },
    });
    await flushMicrotasks();

    expect(receivedSnapshots).toHaveLength(snapshotsBeforeReconnect + 1);
    expect(client.getConnectionState()).toMatchObject({ phase: "connected", stale: false });
    expect(connectionStates).toContain("reconnecting:true");
    unsubscribeSnapshot();
    unsubscribeConnection();
    client.dispose();
    expect(rpc.getConnectionState().phase).toBe("disposed");
  });
});
