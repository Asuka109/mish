import { describe, expect, it, vi } from "vitest";
import type { SettingsSnapshotDto, mishRpcMethods } from "@mish/contracts";
import type { RpcClient } from "@mish/rpc-client";
import type { RpcConnectionState } from "@mish/rpc-client";
import { createFixtureSettingsSnapshot } from "./fixture-settings-client";
import { RpcSettingsClient } from "./rpc-settings-client";

function rpcSnapshot(authorityId = "settings-authority-a", order = 1, revision = 1) {
  return {
    ...createFixtureSettingsSnapshot(),
    adapterKind: "rpc" as const,
    applicationOrder: { authorityId, epoch: 1, order },
    revision,
  };
}

describe("RPC settings client", () => {
  it("keeps native window capabilities unavailable in a browser RPC client", async () => {
    const request = vi.fn(async () => ({
      capabilities: {
        backupRestore: "supported",
        nativeSidebarMaterial: "supported",
        tun: "supported",
        windowLifecycle: "supported",
      },
    }));
    const client = new RpcSettingsClient(
      { request } as unknown as RpcClient<typeof mishRpcMethods>,
      false,
    );

    await expect(client.getSnapshot()).resolves.toMatchObject({
      capabilities: {
        backupRestore: "unavailable",
        nativeSidebarMaterial: "unavailable",
        tun: "supported",
        windowLifecycle: "unavailable",
      },
    });
  });

  it("sends only bounded typed preference commands", async () => {
    let order = 0;
    const request = vi.fn(async (..._arguments: unknown[]) =>
      rpcSnapshot("settings", ++order, order),
    );
    const client = new RpcSettingsClient({ request } as unknown as RpcClient<
      typeof mishRpcMethods
    >);

    await client.setAppearance("dark");
    await client.setLanguage("zh-CN");
    await client.setOnboardingWelcomeState("dismiss");
    await client.setStartup({
      launchAtLogin: true,
      launchBehavior: "off",
      loginLaunchBehavior: "background",
    });
    await client.setWindowCloseBehavior("quit");
    await client.setWindowSurface("opaque");
    await client.setSystemProxyTakeoverPolicy("replace-reversible-pac-or-auto-discovery");
    await client.setProcessDiscoveryMode("strict");
    await client.setCloseOldConnectionsAfterGroupSwitch(true);
    await client.refreshNetworkDns();

    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["settings.setAppearance", { appearance: "dark" }],
      ["settings.setLanguage", { language: "zh-CN" }],
      ["settings.setOnboardingWelcomeState", { action: "dismiss" }],
      [
        "settings.setStartup",
        {
          startup: {
            launchAtLogin: true,
            launchBehavior: "off",
            loginLaunchBehavior: "background",
          },
        },
      ],
      ["settings.setWindowCloseBehavior", { behavior: "quit" }],
      ["settings.setWindowSurface", { surface: "opaque" }],
      [
        "settings.setSystemProxyTakeoverPolicy",
        { policy: "replace-reversible-pac-or-auto-discovery" },
      ],
      ["settings.setProcessDiscoveryMode", { mode: "strict" }],
      ["settings.setCloseOldConnectionsAfterGroupSwitch", { enabled: true }],
      ["settings.refreshNetworkDns", {}],
    ]);
  });

  it("resubscribes after reconnect and projects the authoritative cleanup preference", async () => {
    const connection = {
      listener: null as ((state: RpcConnectionState) => void) | null,
    };
    let subscriptionNumber = 0;
    let current = rpcSnapshot();
    current.capabilities.policyGroupConnectionCleanup = "supported";
    const request = vi.fn(async (method: string) => {
      if (method === "settings.subscribe") {
        subscriptionNumber += 1;
        return {
          snapshot: structuredClone(current),
          subscriptionId: `settings-${subscriptionNumber}`,
        };
      }
      return true;
    });
    const client = new RpcSettingsClient({
      request,
      onNotification: () => () => undefined,
      subscribeConnection: (listener: (state: RpcConnectionState) => void) => {
        connection.listener = listener;
        return () => {
          connection.listener = null;
        };
      },
    } as unknown as RpcClient<typeof mishRpcMethods>);
    const delivered: SettingsSnapshotDto[] = [];
    client.subscribeSnapshots((snapshot) => delivered.push(snapshot));
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(delivered.at(-1)?.preferences.closeOldConnectionsAfterGroupSwitch).toBe(false);

    current = structuredClone(current);
    current.revision += 1;
    current.applicationOrder.order += 1;
    current.preferences.closeOldConnectionsAfterGroupSwitch = true;
    connection.listener?.({ attempt: 0, phase: "connected", stale: false });
    for (let index = 0; index < 5; index += 1) await Promise.resolve();

    expect(request.mock.calls.filter(([method]) => method === "settings.subscribe")).toHaveLength(
      2,
    );
    expect(delivered.at(-1)?.preferences.closeOldConnectionsAfterGroupSwitch).toBe(true);
  });

  it("accepts a lower preference revision from a replacement Rust authority and retires late A", async () => {
    const connection = {
      listener: null as ((state: RpcConnectionState) => void) | null,
    };
    const notifications = {
      listener: null as
        | ((notification: { snapshot: SettingsSnapshotDto; subscriptionId: string }) => void)
        | null,
    };
    let subscription = 0;
    let current = rpcSnapshot("rust-a", 8, 8);
    const request = vi.fn(async (method: string) => {
      if (method === "settings.subscribe") {
        subscription += 1;
        return {
          snapshot: structuredClone(current),
          subscriptionId: `settings-${subscription}`,
        };
      }
      return true;
    });
    const client = new RpcSettingsClient({
      request,
      onNotification: (
        _method: string,
        _schema: unknown,
        listener: (notification: { snapshot: SettingsSnapshotDto; subscriptionId: string }) => void,
      ) => {
        notifications.listener = listener;
        return () => {
          notifications.listener = null;
        };
      },
      subscribeConnection: (listener: (state: RpcConnectionState) => void) => {
        connection.listener = listener;
        return () => {
          connection.listener = null;
        };
      },
    } as unknown as RpcClient<typeof mishRpcMethods>);
    const delivered: Array<{ delivery: string | undefined; snapshot: SettingsSnapshotDto }> = [];
    client.subscribeSnapshots((snapshot, delivery) => delivered.push({ delivery, snapshot }));
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(delivered.at(-1)?.snapshot.revision).toBe(8);

    current = rpcSnapshot("rust-b", 1, 1);
    current.networkDns.phase = "stale";
    connection.listener?.({ attempt: 0, phase: "connected", stale: false });
    for (let index = 0; index < 5; index += 1) await Promise.resolve();

    expect(delivered.at(-1)).toMatchObject({
      delivery: "baseline",
      snapshot: {
        applicationOrder: { authorityId: "rust-b", order: 1 },
        revision: 1,
      },
    });

    const lateRetired = rpcSnapshot("rust-a", 99, 99);
    lateRetired.networkDns.phase = "failed";
    notifications.listener?.({ snapshot: lateRetired, subscriptionId: "settings-2" });
    expect(delivered.at(-1)?.snapshot.applicationOrder.authorityId).toBe("rust-b");

    const newerObservation = structuredClone(current);
    newerObservation.applicationOrder.order = 2;
    newerObservation.networkDns.phase = "ready";
    notifications.listener?.({ snapshot: newerObservation, subscriptionId: "settings-2" });
    expect(delivered.at(-1)?.snapshot).toMatchObject({
      applicationOrder: { authorityId: "rust-b", order: 2 },
      networkDns: { phase: "ready" },
      revision: 1,
    });
  });

  it("ignores a retired transport baseline that resolves after a later reconnect", async () => {
    const connection = {
      listener: null as ((state: RpcConnectionState) => void) | null,
    };
    let resolveRetired:
      | ((value: { snapshot: SettingsSnapshotDto; subscriptionId: string }) => void)
      | undefined;
    const retired = new Promise<{ snapshot: SettingsSnapshotDto; subscriptionId: string }>(
      (resolve) => {
        resolveRetired = resolve;
      },
    );
    let subscription = 0;
    let current = rpcSnapshot("rust-a", 5, 5);
    const request = vi.fn(async (method: string) => {
      if (method !== "settings.subscribe") return true;
      subscription += 1;
      if (subscription === 2) return retired;
      return {
        snapshot: structuredClone(current),
        subscriptionId: `settings-${subscription}`,
      };
    });
    const client = new RpcSettingsClient({
      request,
      onNotification: () => () => undefined,
      subscribeConnection: (listener: (state: RpcConnectionState) => void) => {
        connection.listener = listener;
        return () => {
          connection.listener = null;
        };
      },
    } as unknown as RpcClient<typeof mishRpcMethods>);
    const delivered: SettingsSnapshotDto[] = [];
    client.subscribeSnapshots((snapshot) => delivered.push(snapshot));
    for (let index = 0; index < 5; index += 1) await Promise.resolve();
    expect(delivered.at(-1)?.applicationOrder.authorityId).toBe("rust-a");

    connection.listener?.({ attempt: 1, phase: "connected", stale: false });
    await Promise.resolve();
    current = rpcSnapshot("rust-b", 1, 1);
    connection.listener?.({ attempt: 2, phase: "connected", stale: false });
    resolveRetired?.({
      snapshot: rpcSnapshot("retired-transport", 99, 99),
      subscriptionId: "settings-retired",
    });
    for (let index = 0; index < 10; index += 1) await Promise.resolve();

    expect(delivered.at(-1)).toMatchObject({
      applicationOrder: { authorityId: "rust-b", order: 1 },
      revision: 1,
    });
    expect(
      delivered.some(
        ({ applicationOrder }) => applicationOrder.authorityId === "retired-transport",
      ),
    ).toBe(false);
  });
});
