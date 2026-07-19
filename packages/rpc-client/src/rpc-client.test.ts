import { StatusSnapshotSchema, statusRpcMethods } from "@mish/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RpcCancelledError,
  RpcClient,
  RpcDisposedError,
  RpcMessageTooLargeError,
  RpcRemoteError,
  RpcValidationError,
  type WebSocketLike,
  type WebSocketLikeEventMap,
} from "./index";

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

  receiveRaw(data: unknown) {
    this.emit("message", { data });
  }

  send(data: string) {
    this.sent.push(data);
  }
}

function createSnapshot() {
  return StatusSnapshotSchema.parse({
    activeProfileId: "配置-α",
    adapterKind: "rpc",
    capabilities: { systemProxy: "supported", tun: "unavailable" },
    groups: [],
    groupUsage: [],
    metrics: {
      activeConnections: 0,
      effectiveRules: 0,
      memoryBytes: 0,
      uptimeSeconds: 0,
    },
    nodes: [],
    probeResults: [],
    profiles: [{ id: "配置-α", label: "工作 🌏" }],
    routingMode: "rule",
    runtime: {
      captureSelection: { systemProxy: false, tun: false },
      message: "Ready",
      phase: "healthy",
      systemProxy: {
        desired: false,
        failure: null,
        observed: "disabled",
        phase: "off",
        recoveryActions: [],
      },
      systemProxyEnabled: false,
      tunEnabled: false,
    },
    services: [],
    traffic: {
      downloadBytesPerSecond: 0,
      downloadSeries: [],
      downloadedBytes: 0,
      uploadBytesPerSecond: 0,
      uploadSeries: [],
      uploadedBytes: 0,
    },
  });
}

async function waitForSentMessage(transport: FakeTransport, index: number) {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    if (transport.sent[index]) return JSON.parse(transport.sent[index]);
    await Promise.resolve();
  }
  throw new Error(`RPC message ${index} was not sent`);
}

async function authenticate(transport: FakeTransport) {
  transport.open();
  const request = await waitForSentMessage(transport, 0);
  transport.respond({
    id: request.id,
    jsonrpc: "2.0",
    result: { authenticated: true, sessionId: "session" },
  });
}

function createClient(
  transportFactory: () => FakeTransport,
  onProtocolError: (error: Error) => void = () => undefined,
) {
  return new RpcClient({
    authentication: () => ({ clientName: "test", clientVersion: "1", token: "secret" }),
    methods: statusRpcMethods,
    onProtocolError,
    transportFactory,
  });
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RpcClient", () => {
  it("authenticates before returning a validated typed result", async () => {
    const transport = new FakeTransport();
    const client = createClient(() => transport);

    const resultPromise = client.request("status.getSnapshot", {});
    transport.open();

    const authentication = await waitForSentMessage(transport, 0);
    expect(authentication.method).toBe("rpc.authenticate");
    transport.respond({
      id: authentication.id,
      jsonrpc: "2.0",
      result: { authenticated: true, sessionId: "session" },
    });

    const request = await waitForSentMessage(transport, 1);
    expect(request.method).toBe("status.getSnapshot");
    transport.respond({ id: request.id, jsonrpc: "2.0", result: createSnapshot() });

    await expect(resultPromise).resolves.toMatchObject({
      activeProfileId: "配置-α",
      profiles: [{ label: "工作 🌏" }],
    });
    client.dispose();
  });

  it("rejects malformed results before they cross the client boundary", async () => {
    const protocolErrors: Error[] = [];
    const transport = new FakeTransport();
    const client = createClient(
      () => transport,
      (error) => protocolErrors.push(error),
    );
    const resultPromise = client.request("status.getSnapshot", {});
    await authenticate(transport);
    const request = await waitForSentMessage(transport, 1);

    transport.respond({ id: request.id, jsonrpc: "2.0", result: { adapterKind: "rpc" } });

    await expect(resultPromise).rejects.toBeInstanceOf(RpcValidationError);
    expect(protocolErrors.at(-1)?.message).toContain("Invalid result for status.getSnapshot");
    client.dispose();
  });

  it("rejects inconsistent System Proxy confirmation state", async () => {
    const transport = new FakeTransport();
    const client = createClient(() => transport);
    const resultPromise = client.request("status.getSnapshot", {});
    await authenticate(transport);
    const request = await waitForSentMessage(transport, 1);
    const snapshot = createSnapshot();
    snapshot.runtime.systemProxyEnabled = true;

    transport.respond({ id: request.id, jsonrpc: "2.0", result: snapshot });

    await expect(resultPromise).rejects.toBeInstanceOf(RpcValidationError);
    client.dispose();
  });

  it("reports malformed payloads and unknown or mismatched response IDs", async () => {
    const protocolErrors: Error[] = [];
    const transport = new FakeTransport();
    const client = createClient(
      () => transport,
      (error) => protocolErrors.push(error),
    );
    const resultPromise = client.request("status.getSnapshot", {});
    await authenticate(transport);
    const request = await waitForSentMessage(transport, 1);

    transport.receiveRaw("not-json");
    transport.respond({ id: `${request.id}`, jsonrpc: "2.0", result: createSnapshot() });
    transport.respond({ id: 999_999, jsonrpc: "2.0", result: createSnapshot() });
    transport.respond({ id: request.id, jsonrpc: "2.0", result: createSnapshot() });

    await expect(resultPromise).resolves.toMatchObject({ adapterKind: "rpc" });
    expect(protocolErrors.map((error) => error.message)).toEqual([
      "Malformed JSON-RPC payload",
      `Unknown RPC response id ${request.id}`,
      "Unknown RPC response id 999999",
    ]);
    client.dispose();
  });

  it("returns typed remote errors without accepting a result", async () => {
    const transport = new FakeTransport();
    const client = createClient(() => transport);
    const resultPromise = client.request("status.setRoutingMode", { mode: "global" });
    await authenticate(transport);
    const request = await waitForSentMessage(transport, 1);

    transport.respond({
      error: { code: -32_009, data: { current: "rule" }, message: "Command conflict" },
      id: request.id,
      jsonrpc: "2.0",
    });

    const error = await resultPromise.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(RpcRemoteError);
    expect(error).toMatchObject({
      code: -32_009,
      data: { current: "rule" },
      message: "Command conflict",
    });
    client.dispose();
  });

  it("validates subscription notifications before delivery", async () => {
    const protocolErrors: Error[] = [];
    const transport = new FakeTransport();
    const client = createClient(
      () => transport,
      (error) => protocolErrors.push(error),
    );
    const snapshots: unknown[] = [];
    const unsubscribe = client.onNotification("status.snapshot", StatusSnapshotSchema, (snapshot) =>
      snapshots.push(snapshot),
    );

    const connecting = client.connect();
    await authenticate(transport);
    await connecting;
    transport.respond({ jsonrpc: "2.0", method: "status.snapshot", params: { bad: true } });
    transport.respond({ jsonrpc: "2.0", method: "status.snapshot", params: createSnapshot() });

    expect(snapshots).toEqual([createSnapshot()]);
    expect(protocolErrors.at(-1)?.message).toBe(
      "Invalid parameters for notification status.snapshot",
    );
    unsubscribe();
    client.dispose();
  });

  it("reconnects with bounded backoff and stops after the configured limit", async () => {
    vi.useFakeTimers();
    const transports = [new FakeTransport(), new FakeTransport(), new FakeTransport()];
    let transportIndex = 0;
    const client = new RpcClient({
      authentication: () => ({ clientName: "test", clientVersion: "1", token: "secret" }),
      backoff: {
        initialDelayMilliseconds: 10,
        maximumDelayMilliseconds: 20,
        maximumReconnectAttempts: 2,
      },
      methods: statusRpcMethods,
      transportFactory: () => transports[transportIndex++],
    });
    const connectionStates: string[] = [];
    client.subscribeConnection((state) => connectionStates.push(`${state.phase}:${state.attempt}`));

    const connecting = client.connect();
    await authenticate(transports[0]);
    await connecting;
    transports[0].close(1006, "Lost");
    expect(client.getConnectionState()).toMatchObject({
      attempt: 1,
      phase: "reconnecting",
      stale: true,
    });

    await vi.advanceTimersByTimeAsync(10);
    transports[1].close(1006, "Still lost");
    await vi.advanceTimersByTimeAsync(20);
    transports[2].close(1006, "Unavailable");

    expect(client.getConnectionState()).toMatchObject({
      attempt: 2,
      phase: "disconnected",
      stale: true,
    });
    expect(connectionStates).toContain("connected:0");
    expect(transportIndex).toBe(3);
    client.dispose();
  });

  it("cancels pending work, sends cancellation metadata, and cleans up on disposal", async () => {
    const protocolErrors: Error[] = [];
    const transport = new FakeTransport();
    const client = createClient(
      () => transport,
      (error) => protocolErrors.push(error),
    );
    const controller = new AbortController();
    const resultPromise = client.request("status.getSnapshot", {}, { signal: controller.signal });
    await authenticate(transport);
    const request = await waitForSentMessage(transport, 1);

    controller.abort();
    await expect(resultPromise).rejects.toBeInstanceOf(RpcCancelledError);
    expect(JSON.parse(transport.sent[2])).toMatchObject({
      method: "rpc.cancel",
      params: { requestId: request.id },
    });

    const pending = client.request("status.getSnapshot", {});
    await waitForSentMessage(transport, 3);
    client.dispose();
    await expect(pending).rejects.toBeInstanceOf(RpcDisposedError);
    expect(client.getConnectionState().phase).toBe("disposed");
    expect(protocolErrors).toEqual([]);
  });

  it("enforces outbound and inbound message-size bounds", async () => {
    const protocolErrors: Error[] = [];
    const transport = new FakeTransport();
    const client = new RpcClient({
      authentication: () => ({ clientName: "test", clientVersion: "1", token: "secret" }),
      maxMessageBytes: 256,
      methods: statusRpcMethods,
      onProtocolError: (error) => protocolErrors.push(error),
      transportFactory: () => transport,
    });
    const connecting = client.connect();
    await authenticate(transport);
    await connecting;

    await expect(
      client.request("status.upsertServiceMonitor", {
        draft: { icon: "globe", label: "x".repeat(512), url: "https://example.com" },
      }),
    ).rejects.toBeInstanceOf(RpcMessageTooLargeError);

    transport.receiveRaw(
      JSON.stringify({ jsonrpc: "2.0", method: "status.snapshot", params: "x".repeat(512) }),
    );
    expect(protocolErrors.at(-1)?.message).toContain("size limit");
    expect(client.getConnectionState()).toMatchObject({ phase: "reconnecting", stale: true });
    client.dispose();
  });
});
