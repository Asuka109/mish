import { describe, expect, it, vi } from "vitest";
import type { SettingsSnapshotDto, mishRpcMethods } from "@mish/contracts";
import type { RpcClient } from "@mish/rpc-client";
import type { RpcConnectionState } from "@mish/rpc-client";
import { createFixtureSettingsSnapshot } from "./fixture-settings-client";
import { RpcSettingsClient } from "./rpc-settings-client";

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
    const request = vi.fn(async (..._arguments: unknown[]) => ({ adapterKind: "rpc" }));
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
    let current = createFixtureSettingsSnapshot();
    current.adapterKind = "rpc";
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
    current.preferences.closeOldConnectionsAfterGroupSwitch = true;
    connection.listener?.({ attempt: 0, phase: "connected", stale: false });
    for (let index = 0; index < 5; index += 1) await Promise.resolve();

    expect(request.mock.calls.filter(([method]) => method === "settings.subscribe")).toHaveLength(
      2,
    );
    expect(delivered.at(-1)?.preferences.closeOldConnectionsAfterGroupSwitch).toBe(true);
  });
});
