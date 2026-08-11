import {
  BRIDGE_MINIMUM_CLIENT_PROTOCOL_VERSION,
  BRIDGE_MOCK_UNAVAILABLE_RPC_METHODS,
  BRIDGE_PROTOCOL_VERSION,
  SERVICE_ICON_URLS,
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
  protocolVersion?: number;
  statusSnapshot?: RpcStatusSnapshotDto;
}

export interface MockBridgeHandle {
  readonly cancellationCount: number;
  close(): Promise<void>;
  readonly rpcUrl: string;
}

type MethodDefinition = { params: z.ZodType; result: z.ZodType };
const methods: Record<string, MethodDefinition> = mishRpcMethods;
const mockUnavailableMethods = new Set<string>(BRIDGE_MOCK_UNAVAILABLE_RPC_METHODS);
const unavailableFailure: RpcFailure = {
  code: -32020,
  message: "The transport-only mock does not implement application lifecycle commands",
};

const defaultService: ServiceMonitorDto = {
  icon: SERVICE_ICON_URLS.cloudflare,
  id: "connectivity",
  label: "Connectivity",
  url: "https://cp.cloudflare.com/generate_204",
};

export function createMockStatusSnapshot(): RpcStatusSnapshotDto {
  return {
    activeProfileId: "home",
    adapterKind: "rpc",
    applicationOrder: { authorityId: "mock-status-application", epoch: 1, order: 1 },
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
    recentTraffic: {
      authorityId: "mock-status-authority",
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
        scopeEpoch: "mock-capture-scope",
      },
      captureSelection: { systemProxy: false, tun: false },
      message: "Transport fixture; no Core or Capture lifecycle is running",
      phase: "inactive",
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
    serviceProbePolicy: { intervalSeconds: 5 },
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
  const protocolVersion = options.protocolVersion ?? BRIDGE_PROTOCOL_VERSION;
  if (!Number.isInteger(protocolVersion) || protocolVersion < 1) {
    throw new Error("The mock protocol version must be a positive integer");
  }

  const snapshot = structuredClone(options.statusSnapshot ?? createMockStatusSnapshot());
  const core: CoreStatusDto = {
    error: null,
    phase: "stopped",
    pid: null,
    version: "Transport fixture",
  };
  const subscriptions = new WeakMap<WebSocket, Set<string>>();
  const allowedOrigins = new Set(options.allowedOrigins ?? []);
  let cancellationCount = 0;
  let sessionId = 0;
  let subscriptionId = 0;
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
      done(Boolean(req.url === "/rpc" && validHost && validOrigin), 403, "Forbidden");
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("The mock bridge has no TCP address");
  }

  server.on("connection", (socket) => {
    let authenticated = false;
    let protocolCompatibility: "compatible" | "client-too-old" | "backend-too-old" | null = null;
    subscriptions.set(socket, new Set());
    socket.on("message", (data, isBinary) => {
      if (isBinary) return sendError(socket, null, -32600, "Binary messages are not supported");
      let request: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(data.toString());
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("Expected an object");
        }
        request = parsed as Record<string, unknown>;
      } catch (error) {
        return sendError(socket, null, -32700, "Parse error", { detail: String(error) });
      }
      const id =
        typeof request.id === "string" || typeof request.id === "number" || request.id === null
          ? request.id
          : null;
      if (!("id" in request) && request.jsonrpc === "2.0" && request.method === "rpc.cancel") {
        const params = request.params;
        if (
          authenticated &&
          params &&
          typeof params === "object" &&
          !Array.isArray(params) &&
          isRpcRequestId((params as Record<string, unknown>).requestId)
        ) {
          cancellationCount += 1;
        }
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
        protocolCompatibility = null;
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
        sessionId += 1;
        return sendResult(socket, id, {
          authenticated: true,
          sessionId: `mock-session-${sessionId}`,
        });
      }

      if (request.method !== "bridge.getInfo" && protocolCompatibility !== "compatible") {
        return sendError(socket, id, -32003, "Bridge protocol compatibility is required", {
          compatibility: protocolCompatibility,
          protocolVersion,
        });
      }

      const definition = methods[request.method];
      if (!definition) return sendError(socket, id, -32601, "Method not found");
      const params = definition.params.safeParse(request.params ?? {});
      if (!params.success) {
        return sendError(socket, id, -32602, "Invalid params", params.error.flatten());
      }
      const configuredFailure =
        options.failMethods?.[request.method as keyof typeof mishRpcMethods];
      if (configuredFailure) {
        return sendError(
          socket,
          id,
          configuredFailure.code,
          configuredFailure.message,
          configuredFailure.data,
        );
      }

      try {
        const values = params.data as Record<string, unknown>;
        const result = (() => {
          switch (request.method) {
            case "bridge.getInfo":
              protocolCompatibility = compatibilityForClient(
                Number(values.clientProtocolVersion),
                protocolVersion,
              );
              return {
                bridgeVersion: "transport-only-mock",
                compatibility: protocolCompatibility,
                coreConfigured: false,
                minimumClientProtocolVersion: Math.min(
                  BRIDGE_MINIMUM_CLIENT_PROTOCOL_VERSION,
                  protocolVersion,
                ),
                protocolVersion,
                statusCommands: {
                  group: false,
                  groupDelay: false,
                  profile: false,
                  routing: false,
                  services: false,
                },
                trafficCommands: {
                  closeAllActive: false,
                  closeConnection: false,
                  closeFilteredVisible: false,
                },
                updaterConfigured: false,
              };
            case "core.getStatus":
              return core;
            case "status.getSnapshot":
              return structuredClone(snapshot);
            case "status.subscribe": {
              subscriptionId += 1;
              const id = `status-subscription-${subscriptionId}`;
              subscriptions.get(socket)?.add(id);
              return { snapshot: structuredClone(snapshot), subscriptionId: id };
            }
            case "status.unsubscribe":
              return subscriptions.get(socket)?.delete(String(values.subscriptionId)) ?? false;
            case "traffic.getProcessIcon":
              return { dataUrl: null };
            default:
              if (mockUnavailableMethods.has(request.method)) {
                throw new MockRpcError(unavailableFailure.code, unavailableFailure.message);
              }
              throw new MockRpcError(-32601, "Method not found");
          }
        })();
        const validated = definition.result.safeParse(result);
        if (!validated.success) {
          return sendError(socket, id, -32603, "Internal contract violation");
        }
        sendResult(socket, id, validated.data);
      } catch (error) {
        const failure =
          error instanceof MockRpcError ? error : new MockRpcError(-32603, String(error));
        sendError(socket, id, failure.code, failure.message);
      }
    });
  });

  return {
    get cancellationCount() {
      return cancellationCount;
    },
    close: () => closeServer(server),
    rpcUrl: `ws://${host}:${address.port}/rpc`,
  };
}

function isRpcRequestId(value: unknown): value is string | number {
  return (
    (typeof value === "string" && value.length > 0) ||
    (typeof value === "number" && Number.isSafeInteger(value))
  );
}

function compatibilityForClient(
  clientProtocolVersion: number,
  backendProtocolVersion: number,
): "compatible" | "client-too-old" | "backend-too-old" {
  const minimumClientProtocolVersion = Math.min(
    BRIDGE_MINIMUM_CLIENT_PROTOCOL_VERSION,
    backendProtocolVersion,
  );
  if (clientProtocolVersion < minimumClientProtocolVersion) return "client-too-old";
  if (clientProtocolVersion > backendProtocolVersion) return "backend-too-old";
  return "compatible";
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
