import { describe, expect, it, vi } from "vitest";
import { resolveMobileStartup } from "./mobile-runtime-bootstrap";

const fixture = {
  adapterKind: "native",
  contractVersion: 1,
  core: { availability: "unavailable", kind: "fixture" },
  message: "Native fixture connected. VPN and embedded Core are not implemented.",
  platform: "android",
  targetAbis: ["arm64-v8a", "x86_64"],
  vpn: { availability: "unavailable", kind: "fixture" },
};

describe("mobile native fixture bootstrap", () => {
  it("constructs native mobile clients without desktop bootstrap or sockets", async () => {
    const invokeBootstrap = vi.fn(async () => fixture);
    const startup = await resolveMobileStartup({ invokeBootstrap });

    expect(invokeBootstrap).toHaveBeenCalledOnce();
    expect(startup.runtime).toBe("mobile");
    expect(startup.mobileFixture).toEqual(fixture);
    await expect(startup.client?.getSnapshot()).resolves.toMatchObject({
      adapterKind: "native",
      capabilities: { systemProxy: "unavailable", tun: "unavailable" },
      runtime: { phase: "inactive", systemProxyEnabled: false, tunEnabled: false },
    });
  });

  it("rejects malformed or capability-inflating native messages", async () => {
    await expect(
      resolveMobileStartup({
        invokeBootstrap: async () => ({ ...fixture, vpn: { availability: "supported" } }),
      }),
    ).rejects.toThrow();
  });
});
