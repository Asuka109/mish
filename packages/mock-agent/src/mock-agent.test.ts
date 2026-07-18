import { mishRpcMethods, statusRpcNotifications } from "@mish/contracts";
import { RpcClient, type WebSocketLike } from "@mish/rpc-client";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { type MockAgentHandle, startMockAgent } from "./index.ts";

const TOKEN = "mock-token-123456789";
const ORIGIN = "http://mish.test";
const handles = new Set<MockAgentHandle>();

afterEach(async () => {
  await Promise.all([...handles].map((handle) => handle.close()));
  handles.clear();
});

async function agent(options: Parameters<typeof startMockAgent>[0] = { authToken: TOKEN }) {
  const handle = await startMockAgent({ allowedOrigins: [ORIGIN], ...options });
  handles.add(handle);
  return handle;
}

function client(url: string) {
  return new RpcClient({
    authentication: () => ({ clientName: "mock-test", clientVersion: "1", token: TOKEN }),
    methods: mishRpcMethods,
    transportFactory: () => new WebSocket(url, { origin: ORIGIN }) as unknown as WebSocketLike,
  });
}

describe("mock agent", () => {
  it("drives snapshots, subscriptions, commands, and core state through the real client", async () => {
    const handle = await agent();
    const rpc = client(handle.rpcUrl);
    const initial = await rpc.request("status.getSnapshot", {});
    expect(initial.groups[0]?.label).toBe("🌐 Proxy 代理");

    const notification = new Promise<string>((resolve) => {
      rpc.onNotification(
        "status.snapshot",
        statusRpcNotifications["status.snapshot"],
        ({ snapshot }) => resolve(snapshot.routingMode),
      );
    });
    await rpc.request("status.subscribe", {});
    const changed = await rpc.request("status.setRoutingMode", { mode: "direct" });
    expect(changed.routingMode).toBe("direct");
    await expect(notification).resolves.toBe("direct");

    const selection = { systemProxy: false, tun: true };
    const paused = await rpc.request("status.setCapture", { active: false, selection });
    expect(paused.runtime).toMatchObject({
      captureSelection: selection,
      phase: "inactive",
      systemProxyEnabled: false,
      tunEnabled: false,
    });
    const resumed = await rpc.request("status.setCapture", { active: true, selection });
    expect(resumed.runtime).toMatchObject({
      captureSelection: selection,
      phase: "healthy",
      systemProxyEnabled: false,
      tunEnabled: true,
    });

    const core = await rpc.request("core.start", {});
    expect(core).toMatchObject({ phase: "running", pid: 4242 });
    rpc.dispose();
  });

  it("returns typed failures without mutating command state", async () => {
    const handle = await agent({
      authToken: TOKEN,
      failMethods: { "status.setRoutingMode": { code: -32040, message: "Injected failure" } },
    });
    const rpc = client(handle.rpcUrl);
    await expect(rpc.request("status.setRoutingMode", { mode: "global" })).rejects.toMatchObject({
      code: -32040,
      message: "Injected failure",
    });
    const snapshot = await rpc.request("status.getSnapshot", {});
    expect(snapshot.routingMode).toBe("rule");
    rpc.dispose();
  });
});
