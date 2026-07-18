import { invoke, isTauri } from "@tauri-apps/api/core";
import { statusRpcMethods, type StatusClient } from "@mish/contracts";
import { RpcClient } from "@mish/rpc-client";
import { RpcStatusClient } from "../data/rpc-status-client";

interface RuntimeBootstrapPayload {
  authToken: string;
  rpcUrl: string;
}

interface BootstrapDependencies {
  invokeBootstrap(): Promise<unknown>;
  isDesktop(): boolean;
  openWebSocket(url: string): WebSocket;
}

export interface StartupStatusClient {
  client?: StatusClient;
  dispose(): void;
  runtime: "browser" | "desktop";
}

const defaultDependencies: BootstrapDependencies = {
  invokeBootstrap: () => invoke("runtime_bootstrap"),
  isDesktop: isTauri,
  openWebSocket: (url) => new WebSocket(url),
};

export async function resolveStartupStatusClient(
  dependencies: BootstrapDependencies = defaultDependencies,
): Promise<StartupStatusClient> {
  if (!dependencies.isDesktop()) return { dispose: () => undefined, runtime: "browser" };

  const bootstrap = parseRuntimeBootstrap(await dependencies.invokeBootstrap());
  const rpc = new RpcClient({
    authentication: () => ({
      clientName: "mish-desktop-webview",
      clientVersion: "bootstrap-v1",
      token: bootstrap.authToken,
    }),
    methods: statusRpcMethods,
    transportFactory: () => dependencies.openWebSocket(bootstrap.rpcUrl),
  });
  const client = new RpcStatusClient(rpc);
  return { client, dispose: () => client.dispose(), runtime: "desktop" };
}

export function parseRuntimeBootstrap(value: unknown): RuntimeBootstrapPayload {
  if (!value || typeof value !== "object") throw new Error("Invalid desktop bootstrap");
  const { authToken, rpcUrl } = value as Record<string, unknown>;
  if (typeof authToken !== "string" || authToken.length < 32) {
    throw new Error("Invalid desktop authentication token");
  }
  if (typeof rpcUrl !== "string") throw new Error("Invalid desktop RPC endpoint");

  const endpoint = new URL(rpcUrl);
  if (
    endpoint.protocol !== "ws:" ||
    endpoint.hostname !== "127.0.0.1" ||
    !endpoint.port ||
    endpoint.pathname !== "/rpc" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  ) {
    throw new Error("Desktop RPC must use an uncredentialed IPv4 loopback WebSocket URL");
  }
  return { authToken, rpcUrl: endpoint.href };
}
