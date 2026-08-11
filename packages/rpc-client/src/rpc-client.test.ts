import {
  BRIDGE_INFO_REQUEST,
  BRIDGE_PROTOCOL_VERSION,
  BridgeInfoSchema,
  StatusSnapshotSchema,
  mishRpcMethods,
  resolveBridgeProtocolCompatibility,
  statusRpcMethods,
  type BridgeProtocolCompatibility,
} from "@mish/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  RpcCancelledError,
  RpcClient,
  RpcCompatibilityError,
  RpcDisposedError,
  RpcMessageTooLargeError,
  RpcRequestIdCollisionError,
  RpcRemoteError,
  RpcTimeoutError,
  RpcValidationError,
  type RpcRequestIdFactory,
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
    applicationOrder: {
      authorityId: "rpc-client-test-application",
      epoch: 1,
      order: 1,
    },
    capabilities: { systemProxy: "supported", tun: "unavailable" },
    groups: [],
    groupDelayPolicy: {
      id: "fixture-only",
      timeoutMilliseconds: 5_000,
      url: "https://www.gstatic.com/generate_204",
    },
    groupDelayTest: {
      children: [],
      finishedAt: null,
      groupId: null,
      phase: "idle",
      profileId: null,
      startedAt: null,
      testId: null,
    },
    groupSelectionOperation: {
      catalogRevision: "",
      cleanupFailure: null,
      cleanupMode: "off",
      cleanupPhase: "idle",
      closedCount: 0,
      controllerSessionRevision: 0,
      failedCount: 0,
      membershipRevision: "",
      operationId: null,
      scanCount: 0,
      selectionConfirmed: false,
      targetCount: 0,
    },
    groupSelectionAvailability: "available",
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
    recentTraffic: {
      authorityId: "rpc-client-test-authority",
      revision: 0,
      phase: "idle",
      sessionId: null,
      profileId: null,
      cadenceMilliseconds: 1_000,
      windowMilliseconds: 60_000,
      downloadedBytes: 0,
      uploadedBytes: 0,
      downloadBytesPerSecond: 0,
      uploadBytesPerSecond: 0,
      samples: [],
    },
    routingMode: "rule",
    runtime: {
      captureOperation: {
        failure: null,
        operationId: null,
        phase: "idle",
        scopeEpoch: "rpc-client-test-capture-scope",
      },
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
      tun: {
        desired: false,
        failure: null,
        observation: null,
        observed: "disabled",
        phase: "off",
      },
      tunEnabled: false,
    },
    serviceProbePolicy: { intervalSeconds: 60 },
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
  options: {
    requestDeadlineMilliseconds?: number;
    requestIdFactory?: RpcRequestIdFactory;
  } = {},
) {
  return new RpcClient({
    authentication: () => ({ clientName: "test", clientVersion: "1", token: "secret" }),
    methods: statusRpcMethods,
    onProtocolError,
    ...options,
    transportFactory,
  });
}

function bridgeInfo(compatibility: BridgeProtocolCompatibility) {
  return {
    bridgeVersion: "test",
    compatibility,
    coreConfigured: true,
    minimumClientProtocolVersion: BRIDGE_PROTOCOL_VERSION,
    protocolVersion: BRIDGE_PROTOCOL_VERSION,
    statusCommands: {
      group: true,
      groupDelay: true,
      profile: true,
      routing: true,
      services: true,
    },
    trafficCommands: {
      closeAllActive: true,
      closeConnection: true,
      closeFilteredVisible: true,
    },
    updaterConfigured: true,
  };
}

function compatibilityPolicy() {
  return {
    method: "bridge.getInfo",
    outcome: (result: unknown) =>
      resolveBridgeProtocolCompatibility(BridgeInfoSchema.parse(result)),
    params: BRIDGE_INFO_REQUEST,
    resultSchema: BridgeInfoSchema,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("RpcClient", () => {
  it.each(["client-too-old", "backend-too-old"] as const)(
    "blocks simultaneous product surfaces on explicit %s compatibility",
    async (compatibility) => {
      const transport = new FakeTransport();
      const client = new RpcClient({
        authentication: () => ({ clientName: "test", clientVersion: "1", token: "secret" }),
        compatibility: compatibilityPolicy(),
        methods: mishRpcMethods,
        transportFactory: () => transport,
      });
      const requests = [
        client.request("status.getSnapshot", {}),
        client.request("traffic.getSnapshot", {}),
        client.request("profiles.getSnapshot", {}),
        client.request("settings.getSnapshot", {}),
        client.request("events.getSnapshot", {}),
        client.request("notifications.getSnapshot", {}),
        client.request("updater.getSnapshot", {}),
      ];
      await authenticate(transport);
      const negotiation = await waitForSentMessage(transport, 1);
      expect(negotiation).toMatchObject({ method: "bridge.getInfo", params: BRIDGE_INFO_REQUEST });
      transport.respond({
        id: negotiation.id,
        jsonrpc: "2.0",
        result: bridgeInfo(compatibility),
      });

      for (const request of requests) {
        await expect(request).rejects.toMatchObject({
          outcome: compatibility,
          name: "RpcCompatibilityError",
        });
      }
      expect(transport.sent).toHaveLength(2);
      expect(client.getConnectionState()).toMatchObject({ phase: compatibility, stale: true });
      client.dispose();
    },
  );

  it("renegotiates after reconnect and does not accept an incompatible replacement backend", async () => {
    vi.useFakeTimers();
    const transports = [new FakeTransport(), new FakeTransport()];
    let index = 0;
    const client = new RpcClient({
      authentication: () => ({ clientName: "test", clientVersion: "1", token: "secret" }),
      backoff: { initialDelayMilliseconds: 1, maximumReconnectAttempts: 1 },
      compatibility: compatibilityPolicy(),
      methods: mishRpcMethods,
      transportFactory: () => transports[index++],
    });
    const connecting = client.connect();
    await authenticate(transports[0]);
    const firstNegotiation = await waitForSentMessage(transports[0], 1);
    transports[0].respond({
      id: firstNegotiation.id,
      jsonrpc: "2.0",
      result: bridgeInfo("compatible"),
    });
    await connecting;
    expect(client.getConnectionState().phase).toBe("connected");

    transports[0].close(1006, "replaced");
    await vi.advanceTimersByTimeAsync(1);
    const reconnecting = client.connect();
    await authenticate(transports[1]);
    const secondNegotiation = await waitForSentMessage(transports[1], 1);
    transports[1].respond({
      id: secondNegotiation.id,
      jsonrpc: "2.0",
      result: bridgeInfo("backend-too-old"),
    });
    await expect(reconnecting).rejects.toBeInstanceOf(RpcCompatibilityError);
    expect(client.getConnectionState().phase).toBe("backend-too-old");
    await vi.advanceTimersByTimeAsync(10);
    expect(index).toBe(2);
    await expect(client.connect()).rejects.toBeInstanceOf(RpcCompatibilityError);
    client.dispose();
  });

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

  it("rejects an applied TUN state without complete privileged observations", async () => {
    const transport = new FakeTransport();
    const client = createClient(() => transport);
    const resultPromise = client.request("status.getSnapshot", {});
    await authenticate(transport);
    const request = await waitForSentMessage(transport, 1);
    const snapshot = createSnapshot();
    snapshot.runtime.tun = {
      desired: true,
      failure: null,
      observation: {
        core: "confirmed",
        dns: "confirmed",
        interface: "confirmed",
        observedAt: Date.now(),
        routes: "partial",
        schemaVersion: 1,
      },
      observed: "enabled",
      phase: "applied",
    };
    snapshot.runtime.tunEnabled = true;

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
    transport.respond({ id: `${request.id}-mismatch`, jsonrpc: "2.0", result: createSnapshot() });
    transport.respond({ id: 999_999, jsonrpc: "2.0", result: createSnapshot() });
    transport.respond({ id: request.id, jsonrpc: "2.0", result: createSnapshot() });

    await expect(resultPromise).resolves.toMatchObject({ adapterKind: "rpc" });
    expect(protocolErrors.map((error) => error.message)).toEqual([
      "Malformed JSON-RPC payload",
      `Unknown RPC response id ${request.id}-mismatch`,
      "Unknown RPC response id 999999",
    ]);
    client.dispose();
  });

  it("rejects malformed response envelopes before they can settle a request", async () => {
    const protocolErrors: Error[] = [];
    const transport = new FakeTransport();
    const client = createClient(
      () => transport,
      (error) => protocolErrors.push(error),
    );
    const resultPromise = client.request("status.getSnapshot", {});
    await authenticate(transport);
    const request = await waitForSentMessage(transport, 1);

    transport.respond({
      error: { code: -32_000, message: "wrong envelope" },
      id: request.id,
      jsonrpc: "2.0",
      result: createSnapshot(),
    });
    transport.respond({ id: null, jsonrpc: "2.0", result: createSnapshot() });
    transport.respond({ id: request.id, jsonrpc: "1.0", result: createSnapshot() });

    expect(protocolErrors.map((error) => error.message)).toEqual([
      "Malformed JSON-RPC message",
      "Malformed JSON-RPC message",
      "Malformed JSON-RPC message",
    ]);

    transport.respond({ id: request.id, jsonrpc: "2.0", result: createSnapshot() });
    await expect(resultPromise).resolves.toMatchObject({ adapterKind: "rpc" });
    client.dispose();
  });

  it("correlates responses by identity instead of delivery order", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = createClient(
      () => transport,
      () => undefined,
      {
        requestDeadlineMilliseconds: 25,
      },
    );
    const first = client.request("status.getSnapshot", {});
    await authenticate(transport);
    const firstRequest = await waitForSentMessage(transport, 1);
    const second = client.request("status.getSnapshot", {});
    const secondRequest = await waitForSentMessage(transport, 2);

    transport.respond({ id: secondRequest.id, jsonrpc: "2.0", result: createSnapshot() });
    await expect(second).resolves.toMatchObject({ adapterKind: "rpc" });
    expect(firstRequest.id).not.toBe(secondRequest.id);

    const firstTimeout = expect(first).rejects.toBeInstanceOf(RpcTimeoutError);
    await vi.advanceTimersByTimeAsync(25);
    await firstTimeout;
    client.dispose();
  });

  it("rejects a duplicate response after the original response has settled", async () => {
    const protocolErrors: Error[] = [];
    const transport = new FakeTransport();
    const client = createClient(
      () => transport,
      (error) => protocolErrors.push(error),
    );
    const resultPromise = client.request("status.getSnapshot", {});
    await authenticate(transport);
    const request = await waitForSentMessage(transport, 1);
    const response = { id: request.id, jsonrpc: "2.0", result: createSnapshot() };

    transport.respond(response);
    await expect(resultPromise).resolves.toMatchObject({ adapterKind: "rpc" });
    transport.respond(response);

    expect(protocolErrors.at(-1)?.message).toBe(`Unknown RPC response id ${request.id}`);
    client.dispose();
  });

  it("times out, cancels, and rejects a late response without reopening the request", async () => {
    vi.useFakeTimers();
    const protocolErrors: Error[] = [];
    const transport = new FakeTransport();
    const client = createClient(
      () => transport,
      (error) => protocolErrors.push(error),
      { requestDeadlineMilliseconds: 20 },
    );
    const resultPromise = client.request("status.getSnapshot", {});
    await authenticate(transport);
    const request = await waitForSentMessage(transport, 1);

    const timeout = expect(resultPromise).rejects.toMatchObject({
      deadlineMilliseconds: 20,
      name: "RpcTimeoutError",
      requestId: request.id,
    });
    await vi.advanceTimersByTimeAsync(20);
    await timeout;
    expect(JSON.parse(transport.sent[2])).toMatchObject({
      method: "rpc.cancel",
      params: { requestId: request.id },
    });

    transport.respond({ id: request.id, jsonrpc: "2.0", result: createSnapshot() });
    expect(protocolErrors.at(-1)?.message).toBe(`Unknown RPC response id ${request.id}`);
    client.dispose();
  });

  it("does not overwrite an in-flight request when identities collide", async () => {
    const transport = new FakeTransport();
    const requestIds = ["auth-request", "same-request-id", "same-request-id", "same-request-id"];
    let requestIdIndex = 0;
    const client = createClient(
      () => transport,
      () => undefined,
      {
        requestIdFactory: () => requestIds[requestIdIndex++] ?? "fallback-request-id",
      },
    );
    const first = client.request("status.getSnapshot", {});
    await authenticate(transport);
    const request = await waitForSentMessage(transport, 1);

    const second = client.request("status.getSnapshot", {});
    const secondError = await second.catch((reason: unknown) => reason);
    expect(secondError).toBeInstanceOf(RpcRequestIdCollisionError);
    expect(secondError).toMatchObject({ requestId: request.id });
    expect(transport.sent).toHaveLength(2);

    transport.respond({ id: request.id, jsonrpc: "2.0", result: createSnapshot() });
    await expect(first).resolves.toMatchObject({ adapterKind: "rpc" });
    const lateReuse = client.request("status.getSnapshot", {});
    await expect(lateReuse).rejects.toBeInstanceOf(RpcRequestIdCollisionError);
    client.dispose();
  });

  it("bounds a connection that never reaches the open or authenticated state", async () => {
    vi.useFakeTimers();
    const transport = new FakeTransport();
    const client = createClient(
      () => transport,
      () => undefined,
      {
        requestDeadlineMilliseconds: 15,
      },
    );
    const connection = client.connect();

    const timeout = expect(connection).rejects.toMatchObject({
      deadlineMilliseconds: 15,
      name: "RpcTimeoutError",
    });
    await vi.advanceTimersByTimeAsync(15);
    await timeout;
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
        draft: {
          icon: "https://example.com/custom-service.svg",
          label: "x".repeat(512),
          url: "https://example.com",
        },
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
