import { describe, expect, it, vi } from "vitest";
import type { mishRpcMethods } from "@mish/contracts";
import type { RpcClient } from "@mish/rpc-client";
import { RpcSettingsClient } from "./rpc-settings-client";

describe("RPC settings client", () => {
  it("keeps native window capabilities unavailable in a browser RPC client", async () => {
    const request = vi.fn(async () => ({
      capabilities: {
        backupRestore: "supported",
        nativeSidebarMaterial: "supported",
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
      launchProxyWhenMishLaunches: false,
      loginLaunchBehavior: "background",
    });
    await client.setWindowCloseBehavior("quit");
    await client.setWindowSurface("opaque");
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
            launchProxyWhenMishLaunches: false,
            loginLaunchBehavior: "background",
          },
        },
      ],
      ["settings.setWindowCloseBehavior", { behavior: "quit" }],
      ["settings.setWindowSurface", { surface: "opaque" }],
      ["settings.refreshNetworkDns", {}],
    ]);
  });
});
