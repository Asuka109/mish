import { describe, expect, it, vi } from "vitest";
import type { mishRpcMethods } from "@mish/contracts";
import type { RpcClient } from "@mish/rpc-client";
import { RpcSettingsClient } from "./rpc-settings-client";

describe("RPC settings client", () => {
  it("sends only bounded typed preference commands", async () => {
    const request = vi.fn(async (..._arguments: unknown[]) => ({ adapterKind: "rpc" }));
    const client = new RpcSettingsClient({ request } as unknown as RpcClient<
      typeof mishRpcMethods
    >);

    await client.setAppearance("dark");
    await client.setLanguage("zh");
    await client.setStartup({ launchAtLogin: true, loginLaunchBehavior: "background" });

    expect(request.mock.calls.map(([method, params]) => [method, params])).toEqual([
      ["settings.setAppearance", { appearance: "dark" }],
      ["settings.setLanguage", { language: "zh" }],
      [
        "settings.setStartup",
        { startup: { launchAtLogin: true, loginLaunchBehavior: "background" } },
      ],
    ]);
  });
});
