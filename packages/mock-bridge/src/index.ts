import {
  type CoreStatusDto,
  type RpcStatusSnapshotDto,
  type ServiceMonitorDto,
  mishRpcMethods,
} from "@mish/contracts";
import type * as z from "zod";
import { WebSocket, WebSocketServer } from "ws";

type RpcFailure = { code: number; data?: unknown; message: string };

export interface MockBridgeOptions {
  allowedOrigins?: string[];
  authToken: string;
  failMethods?: Partial<Record<keyof typeof mishRpcMethods, RpcFailure>>;
  host?: string;
  maxMessageBytes?: number;
  port?: number;
}

export interface MockBridgeHandle {
  close(): Promise<void>;
  readonly rpcUrl: string;
}

type MethodDefinition = { params: z.ZodType; result: z.ZodType };
const methods: Record<string, MethodDefinition> = mishRpcMethods;

const defaultService: ServiceMonitorDto = {
  icon: "cloudflare",
  id: "connectivity",
  label: "Connectivity",
  url: "https://cp.cloudflare.com/generate_204",
};

export function createMockStatusSnapshot(): RpcStatusSnapshotDto {
  return {
    activeProfileId: "home",
    adapterKind: "rpc",
    capabilities: { systemProxy: "fixture-only", tun: "fixture-only" },
    groups: [
      {
        childIds: ["hkg-01", "nrt-01"],
        id: "proxy",
        label: "🌐 Proxy 代理",
        selectedChildId: "hkg-01",
        type: "selector",
      },
    ],
    groupUsage: [{ groupId: "proxy", observedConnectionCount: 4 }],
    metrics: {
      activeConnections: 4,
      effectiveRules: 128,
      memoryBytes: 16_777_216,
      uptimeSeconds: 60,
    },
    nodes: [
      { id: "hkg-01", label: "🇭🇰 HKG-01", latencyMilliseconds: 42, protocol: "Hysteria2" },
      { id: "nrt-01", label: "🇯🇵 NRT-01", latencyMilliseconds: 71, protocol: "VLESS" },
    ],
    probeResults: [
      {
        latencyMilliseconds: 31,
        monitorId: defaultService.id,
        observedAt: "2026-07-18T08:00:00Z",
        routeTarget: "fixture-only",
        status: "healthy",
      },
    ],
    profiles: [
      { id: "home", label: "Home" },
      { id: "travel", label: "旅行 ✈️" },
    ],
    routingMode: "rule",
    runtime: {
      captureSelection: { systemProxy: true, tun: false },
      message: "Mock transport is connected",
      phase: "inactive",
      systemProxyEnabled: false,
      tunEnabled: false,
    },
    services: [structuredClone(defaultService)],
    traffic: {
      downloadBytesPerSecond: 1024,
      downloadSeries: [1, 2, 3],
      downloadedBytes: 4096,
      uploadBytesPerSecond: 512,
      uploadSeries: [1, 1, 2],
      uploadedBytes: 2048,
    },
  };
}

export async function startMockBridge(options: MockBridgeOptions): Promise<MockBridgeHandle> {
  const host = options.host ?? "127.0.0.1";
  if (host !== "127.0.0.1" && host !== "::1" && host !== "localhost") {
    throw new Error("The mock bridge may only bind to a loopback host");
  }
  if (options.authToken.length < 16) throw new Error("The mock token must contain 16 characters");

  let snapshot = createMockStatusSnapshot();
  let core: CoreStatusDto = {
    error: null,
    phase: "stopped",
    pid: null,
    version: "Mihomo Meta mock",
  };
  const subscriptions = new WeakMap<WebSocket, Set<string>>();
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  const server = new WebSocketServer({
    host,
    maxPayload: options.maxMessageBytes ?? 1_048_576,
    port: options.port ?? 0,
    verifyClient: ({ origin, req }, done) => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : options.port;
      const validHost =
        req.headers.host === `${host}:${port}` || req.headers.host === `localhost:${port}`;
      const validOrigin =
        allowedOrigins.size === 0
          ? origin === `http://${host}:${port}` || origin === `http://localhost:${port}`
          : allowedOrigins.has(origin);
      done(Boolean(validHost && validOrigin), 403, "Forbidden");
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("The mock bridge has no TCP address");

  const broadcastSnapshot = () => {
    for (const client of server.clients) {
      if (client.readyState !== WebSocket.OPEN) continue;
      for (const subscriptionId of subscriptions.get(client) ?? []) {
        client.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "status.snapshot",
            params: { snapshot, subscriptionId },
          }),
        );
      }
    }
  };

  server.on("connection", (socket) => {
    let authenticated = false;
    subscriptions.set(socket, new Set());
    socket.on("message", (data, isBinary) => {
      if (isBinary) return sendError(socket, null, -32600, "Binary messages are not supported");
      let request: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
          throw new Error("Expected an object");
        request = parsed as Record<string, unknown>;
      } catch (error) {
        return sendError(socket, null, -32700, "Parse error", { detail: String(error) });
      }
      const id =
        typeof request.id === "string" || typeof request.id === "number" || request.id === null
          ? request.id
          : null;
      if (
        !("id" in request) &&
        request.jsonrpc === "2.0" &&
        request.method === "rpc.cancel" &&
        authenticated
      ) {
        return;
      }
      if (request.jsonrpc !== "2.0" || typeof request.method !== "string" || !("id" in request)) {
        return sendError(socket, id, -32600, "Invalid Request");
      }
      if (!authenticated && request.method !== "rpc.authenticate") {
        return sendError(socket, id, -32001, "Authentication required");
      }
      if (request.method === "rpc.authenticate") {
        authenticated = false;
        const params = request.params;
        if (
          !params ||
          typeof params !== "object" ||
          Array.isArray(params) ||
          (params as Record<string, unknown>).token !== options.authToken ||
          typeof (params as Record<string, unknown>).clientName !== "string" ||
          typeof (params as Record<string, unknown>).clientVersion !== "string"
        ) {
          return sendError(socket, id, -32002, "Authentication failed");
        }
        authenticated = true;
        return sendResult(socket, id, {
          authenticated: true,
          sessionId: `mock-${crypto.randomUUID()}`,
        });
      }

      const definition = methods[request.method];
      if (!definition) return sendError(socket, id, -32601, "Method not found");
      const params = definition.params.safeParse(request.params ?? {});
      if (!params.success)
        return sendError(socket, id, -32602, "Invalid params", params.error.flatten());
      const failure = options.failMethods?.[request.method as keyof typeof mishRpcMethods];
      if (failure) return sendError(socket, id, failure.code, failure.message, failure.data);

      try {
        const result = dispatch(request.method, params.data);
        const validated = definition.result.safeParse(result);
        if (!validated.success) return sendError(socket, id, -32603, "Internal contract violation");
        sendResult(socket, id, validated.data);
        if (
          request.method.startsWith("status.") &&
          !request.method.includes("Snapshot") &&
          !request.method.includes("subscribe")
        )
          broadcastSnapshot();
      } catch (error) {
        const failure =
          error instanceof MockRpcError ? error : new MockRpcError(-32603, String(error));
        sendError(socket, id, failure.code, failure.message);
      }

      function dispatch(method: string, params: unknown): unknown {
        const values = params as Record<string, unknown>;
        switch (method) {
          case "bridge.getInfo":
            return { bridgeVersion: "mock", coreConfigured: true, protocolVersion: 2 };
          case "core.getStatus":
            return core;
          case "core.start":
            core = { ...core, phase: "running", pid: 4242 };
            return core;
          case "core.stop":
            core = { ...core, phase: "stopped", pid: null };
            return core;
          case "status.getSnapshot":
            return structuredClone(snapshot);
          case "status.setRoutingMode":
            snapshot.routingMode = values.mode as RpcStatusSnapshotDto["routingMode"];
            return structuredClone(snapshot);
          case "status.setCapture": {
            const active = Boolean(values.active);
            const selection =
              values.selection as RpcStatusSnapshotDto["runtime"]["captureSelection"];
            const systemProxyEnabled = active && selection.systemProxy;
            const tunEnabled = active && selection.tun;
            const captureActive = systemProxyEnabled || tunEnabled;
            snapshot.runtime = {
              captureSelection: { ...selection },
              message: captureActive ? "Mock capture is active" : "Mock capture is inactive",
              phase: captureActive ? "healthy" : "inactive",
              systemProxyEnabled,
              tunEnabled,
            };
            return structuredClone(snapshot);
          }
          case "status.setActiveProfile": {
            const profileId = String(values.profileId);
            if (!snapshot.profiles.some((profile) => profile.id === profileId))
              throw new MockRpcError(-32004, "Profile not found");
            snapshot.activeProfileId = profileId;
            return structuredClone(snapshot);
          }
          case "status.selectGroupChild": {
            const group = snapshot.groups.find((candidate) => candidate.id === values.groupId);
            if (
              !group ||
              group.type !== "selector" ||
              !group.childIds.includes(String(values.childId))
            )
              throw new MockRpcError(-32602, "Invalid group child");
            group.selectedChildId = String(values.childId);
            return structuredClone(snapshot);
          }
          case "status.upsertServiceMonitor": {
            const draft = values.draft as ServiceMonitorDto;
            const monitor = { ...draft, id: draft.id ?? crypto.randomUUID() };
            const index = snapshot.services.findIndex((service) => service.id === monitor.id);
            if (index === -1) snapshot.services.push(monitor);
            else snapshot.services[index] = monitor;
            return structuredClone(snapshot);
          }
          case "status.removeServiceMonitor": {
            snapshot.services = snapshot.services.filter(
              (service) => service.id !== values.monitorId,
            );
            snapshot.probeResults = snapshot.probeResults.filter(
              (probe) => probe.monitorId !== values.monitorId,
            );
            return structuredClone(snapshot);
          }
          case "status.restoreDefaultServices":
            snapshot.services = [structuredClone(defaultService)];
            return structuredClone(snapshot);
          case "status.subscribe": {
            const subscriptionId = `status-${crypto.randomUUID()}`;
            subscriptions.get(socket)?.add(subscriptionId);
            return { snapshot: structuredClone(snapshot), subscriptionId };
          }
          case "status.unsubscribe":
            return subscriptions.get(socket)?.delete(String(values.subscriptionId)) ?? false;
          default:
            throw new MockRpcError(-32601, "Method not found");
        }
      }
    });
  });

  return {
    close: () => closeServer(server),
    rpcUrl: `ws://${host}:${address.port}/rpc`,
  };
}

class MockRpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

function sendResult(socket: WebSocket, id: unknown, result: unknown) {
  socket.send(JSON.stringify({ jsonrpc: "2.0", id, result }));
}

function sendError(socket: WebSocket, id: unknown, code: number, message: string, data?: unknown) {
  socket.send(
    JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message, ...(data === undefined ? {} : { data }) },
    }),
  );
}

function closeServer(server: WebSocketServer): Promise<void> {
  for (const client of server.clients) client.close(1001, "Mock bridge disposed");
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
