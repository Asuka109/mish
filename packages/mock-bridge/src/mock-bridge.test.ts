import {
  BRIDGE_INFO_REQUEST,
  BRIDGE_PROTOCOL_VERSION,
  BRIDGE_PUBLIC_RPC_METHODS,
  BRIDGE_STATUS_COMMAND_CAPABILITY_FIELDS,
  BRIDGE_TRAFFIC_COMMAND_CAPABILITY_FIELDS,
  BridgeInfoSchema,
  mishRpcMethods,
  resolveBridgeProtocolCompatibility,
} from "@mish/contracts";
import { RpcClient, RpcCompatibilityError, type WebSocketLike } from "@mish/rpc-client";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { type MockBridgeHandle, startMockBridge } from "./index.ts";

const TOKEN = "mock-token-123456789";
const ORIGIN = "http://mish.test";
const handles = new Set<MockBridgeHandle>();

afterEach(async () => {
  await Promise.all([...handles].map((handle) => handle.close()));
  handles.clear();
});

async function bridge(options: Parameters<typeof startMockBridge>[0] = { authToken: TOKEN }) {
  const handle = await startMockBridge({ allowedOrigins: [ORIGIN], ...options });
  handles.add(handle);
  return handle;
}

function client(url: string) {
  return new RpcClient({
    authentication: () => ({ clientName: "mock-test", clientVersion: "1", token: TOKEN }),
    compatibility: {
      method: "bridge.getInfo",
      outcome: (result) => resolveBridgeProtocolCompatibility(BridgeInfoSchema.parse(result)),
      params: BRIDGE_INFO_REQUEST,
      resultSchema: BridgeInfoSchema,
    },
    methods: mishRpcMethods,
    transportFactory: () => new WebSocket(url, { origin: ORIGIN }) as unknown as WebSocketLike,
  });
}

function connectRaw(url: string, origin = ORIGIN) {
  return new Promise<WebSocket>((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once("open", () => resolve(socket));
    socket.once("error", reject);
  });
}

function rawRequest(socket: WebSocket, payload: unknown) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const onError = (error: Error) => reject(error);
    socket.once("error", onError);
    socket.once("message", (data) => {
      socket.off("error", onError);
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.send(JSON.stringify(payload));
  });
}

function expectHandshakeRejected(url: string, origin: string) {
  return new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(url, { origin });
    socket.once("open", () => reject(new Error("Unexpected WebSocket connection")));
    socket.once("error", () => resolve());
  });
}

describe("mock bridge", () => {
  it("keeps the generated public method list identical to the TypeScript contract", () => {
    expect(Object.keys(mishRpcMethods).sort()).toEqual([...BRIDGE_PUBLIC_RPC_METHODS]);
    expect(Object.keys(BridgeInfoSchema.shape.statusCommands.shape).sort()).toEqual([
      ...BRIDGE_STATUS_COMMAND_CAPABILITY_FIELDS,
    ]);
    expect(Object.keys(BridgeInfoSchema.shape.trafficCommands.shape).sort()).toEqual([
      ...BRIDGE_TRAFFIC_COMMAND_CAPABILITY_FIELDS,
    ]);
  });

  it("serves generated protocol metadata and exact mock capability defaults", async () => {
    const handle = await bridge();
    const rpc = client(handle.rpcUrl);
    const info = await rpc.request("bridge.getInfo", BRIDGE_INFO_REQUEST);
    expect(info).toMatchObject({
      compatibility: "compatible",
      minimumClientProtocolVersion: BRIDGE_PROTOCOL_VERSION,
      protocolVersion: BRIDGE_PROTOCOL_VERSION,
    });
    expect(Object.keys(info.statusCommands).sort()).toEqual([
      ...BRIDGE_STATUS_COMMAND_CAPABILITY_FIELDS,
    ]);
    expect(Object.values(info.statusCommands)).toEqual(
      BRIDGE_STATUS_COMMAND_CAPABILITY_FIELDS.map(() => false),
    );
    expect(Object.keys(info.trafficCommands).sort()).toEqual([
      ...BRIDGE_TRAFFIC_COMMAND_CAPABILITY_FIELDS,
    ]);
    expect(Object.values(info.trafficCommands)).toEqual(
      BRIDGE_TRAFFIC_COMMAND_CAPABILITY_FIELDS.map(() => false),
    );
    rpc.dispose();
  });

  it("serves static contract snapshots and subscription framing through the real client", async () => {
    const handle = await bridge();
    const rpc = client(handle.rpcUrl);

    const initial = await rpc.request("status.getSnapshot", {});
    expect(initial).toMatchObject({
      adapterKind: "rpc",
      capabilities: { systemProxy: "fixture-only", tun: "fixture-only" },
      routingMode: "rule",
      runtime: { phase: "inactive", systemProxyEnabled: false, tunEnabled: false },
    });
    const subscription = await rpc.request("status.subscribe", {});
    expect(subscription.snapshot).toEqual(initial);
    await expect(
      rpc.request("status.unsubscribe", { subscriptionId: subscription.subscriptionId }),
    ).resolves.toBe(true);
    await expect(
      rpc.request("status.unsubscribe", { subscriptionId: subscription.subscriptionId }),
    ).resolves.toBe(false);
    await expect(rpc.request("core.getStatus", {})).resolves.toMatchObject({
      phase: "stopped",
      pid: null,
    });
    rpc.dispose();
  });

  it("fails unsupported application commands without inventing Core or Capture state", async () => {
    const handle = await bridge();
    const rpc = client(handle.rpcUrl);

    await expect(rpc.request("status.setRoutingMode", { mode: "global" })).rejects.toMatchObject({
      code: -32020,
      message: "The transport-only mock does not implement application lifecycle commands",
    });
    const snapshot = await rpc.request("status.getSnapshot", {});
    expect(snapshot.routingMode).toBe("rule");
    expect(snapshot.runtime.captureOperation.phase).toBe("idle");
    rpc.dispose();
  });

  it("preserves explicit per-method failure injection", async () => {
    const handle = await bridge({
      authToken: TOKEN,
      failMethods: { "status.getSnapshot": { code: -32040, message: "Injected failure" } },
    });
    const rpc = client(handle.rpcUrl);
    await expect(rpc.request("status.getSnapshot", {})).rejects.toMatchObject({
      code: -32040,
      message: "Injected failure",
    });
    rpc.dispose();
  });

  it("enforces authentication and schema framing and records valid cancellation notifications", async () => {
    const handle = await bridge();
    const socket = await connectRaw(handle.rpcUrl);

    await expect(
      rawRequest(socket, { id: 1, jsonrpc: "2.0", method: "status.getSnapshot", params: {} }),
    ).resolves.toMatchObject({ error: { code: -32001 }, id: 1 });
    await expect(
      rawRequest(socket, {
        id: 2,
        jsonrpc: "2.0",
        method: "rpc.authenticate",
        params: { clientName: "raw", clientVersion: "1", token: "wrong" },
      }),
    ).resolves.toMatchObject({ error: { code: -32002 }, id: 2 });
    await expect(
      rawRequest(socket, {
        id: 3,
        jsonrpc: "2.0",
        method: "rpc.authenticate",
        params: { clientName: "raw", clientVersion: "1", token: TOKEN },
      }),
    ).resolves.toMatchObject({ result: { authenticated: true }, id: 3 });
    await expect(
      rawRequest(socket, {
        id: 31,
        jsonrpc: "2.0",
        method: "bridge.getInfo",
        params: BRIDGE_INFO_REQUEST,
      }),
    ).resolves.toMatchObject({ result: { compatibility: "compatible" }, id: 31 });
    await expect(
      rawRequest(socket, { id: 4, jsonrpc: "2.0", method: "status.unsubscribe", params: {} }),
    ).resolves.toMatchObject({ error: { code: -32602 }, id: 4 });

    socket.send(JSON.stringify({ jsonrpc: "2.0", method: "rpc.cancel", params: { requestId: 4 } }));
    await expect.poll(() => handle.cancellationCount).toBe(1);
    socket.close();
  });

  it("recognizes every generated public method instead of falling through to method-not-found", async () => {
    const handle = await bridge();
    const socket = await connectRaw(handle.rpcUrl);
    await rawRequest(socket, {
      id: 1,
      jsonrpc: "2.0",
      method: "rpc.authenticate",
      params: { clientName: "parity", clientVersion: "1", token: TOKEN },
    });
    await rawRequest(socket, {
      id: 2,
      jsonrpc: "2.0",
      method: "bridge.getInfo",
      params: BRIDGE_INFO_REQUEST,
    });

    let id = 3;
    for (const method of BRIDGE_PUBLIC_RPC_METHODS) {
      const response = await rawRequest(socket, {
        id,
        jsonrpc: "2.0",
        method,
        params: method === "bridge.getInfo" ? BRIDGE_INFO_REQUEST : {},
      });
      expect(response).not.toMatchObject({ error: { code: -32601 } });
      id += 1;
    }
    socket.close();
  });

  it("fails closed with explicit client-too-old and backend-too-old outcomes", async () => {
    const current = await bridge();
    const oldClient = await connectRaw(current.rpcUrl);
    await rawRequest(oldClient, {
      id: 1,
      jsonrpc: "2.0",
      method: "rpc.authenticate",
      params: { clientName: "old-client", clientVersion: "1", token: TOKEN },
    });
    await expect(
      rawRequest(oldClient, {
        id: 2,
        jsonrpc: "2.0",
        method: "bridge.getInfo",
        params: { clientProtocolVersion: BRIDGE_PROTOCOL_VERSION - 1 },
      }),
    ).resolves.toMatchObject({ result: { compatibility: "client-too-old" } });
    await expect(
      rawRequest(oldClient, {
        id: 3,
        jsonrpc: "2.0",
        method: "status.getSnapshot",
        params: {},
      }),
    ).resolves.toMatchObject({
      error: { code: -32003, data: { compatibility: "client-too-old" } },
    });
    oldClient.close();

    const oldBackend = await bridge({
      authToken: TOKEN,
      protocolVersion: BRIDGE_PROTOCOL_VERSION - 1,
    });
    const rpc = client(oldBackend.rpcUrl);
    await expect(rpc.request("status.getSnapshot", {})).rejects.toBeInstanceOf(
      RpcCompatibilityError,
    );
    expect(rpc.getConnectionState()).toMatchObject({ phase: "backend-too-old", stale: true });
    rpc.dispose();
  });

  it("rejects untrusted origins and non-RPC paths during the WebSocket handshake", async () => {
    const handle = await bridge();
    await expect(expectHandshakeRejected(handle.rpcUrl, "http://untrusted.test")).resolves.toBe(
      undefined,
    );
    await expect(
      expectHandshakeRejected(handle.rpcUrl.replace(/\/rpc$/, "/other"), ORIGIN),
    ).resolves.toBe(undefined);
  });
});
