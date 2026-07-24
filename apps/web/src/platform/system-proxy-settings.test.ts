import { describe, expect, it, vi } from "vitest";
import { openSystemProxySettings } from "./system-proxy-settings";

describe("System Proxy settings native boundary", () => {
  it("invokes only the fixed zero-argument command in the desktop WebView", async () => {
    const invoke = vi.fn(async () => "opened");

    await expect(openSystemProxySettings({ invoke, isTauri: () => true })).resolves.toBe("opened");
    expect(invoke).toHaveBeenCalledExactlyOnceWith("open_system_proxy_settings");
  });

  it("does not invoke a native destination outside the desktop WebView", async () => {
    const invoke = vi.fn();

    await expect(openSystemProxySettings({ invoke, isTauri: () => false })).resolves.toBe(
      "unsupported-version",
    );
    expect(invoke).not.toHaveBeenCalled();
  });

  it("does not turn an unknown native response into a success claim", async () => {
    await expect(
      openSystemProxySettings({
        invoke: async () => ({ destination: "arbitrary" }),
        isTauri: () => true,
      }),
    ).resolves.toBe("dispatch-failed");
  });
});
