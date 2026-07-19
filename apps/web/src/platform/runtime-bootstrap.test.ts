import { describe, expect, it, vi } from "vitest";
import { parseRuntimeBootstrap, resolveStartupStatusClient } from "./runtime-bootstrap";

const token = "0123456789abcdef".repeat(4);

describe("desktop runtime bootstrap", () => {
  it("leaves ordinary browser startup fixture-backed and does not invoke IPC", async () => {
    const invokeBootstrap = vi.fn();
    const invokeLocalProfilePreflight = vi.fn();
    const startup = await resolveStartupStatusClient({
      invokeBootstrap,
      invokeLocalProfilePreflight,
      isDesktop: () => false,
      openWebSocket: vi.fn(),
    });

    expect(startup.client).toBeUndefined();
    expect(startup.profileClient).toBeUndefined();
    expect(startup.nativeSidebarMaterial).toBe(false);
    expect(startup.runtime).toBe("browser");
    expect(invokeBootstrap).not.toHaveBeenCalled();
    expect(invokeLocalProfilePreflight).not.toHaveBeenCalled();
  });

  it("routes local profile preflight only through the injected native boundary", async () => {
    const invokeLocalProfilePreflight = vi.fn(async () => null);
    const startup = await resolveStartupStatusClient({
      invokeBootstrap: async () => ({
        authToken: token,
        nativeSidebarMaterial: true,
        rpcUrl: "ws://127.0.0.1:43123/rpc",
      }),
      invokeLocalProfilePreflight,
      isDesktop: () => true,
      openWebSocket: vi.fn(),
    });

    await expect(startup.profileClient?.preflightLocal("Local profile")).resolves.toBeNull();
    expect(invokeLocalProfilePreflight).toHaveBeenCalledWith("Local profile");
    startup.dispose();
  });

  it("accepts only an uncredentialed loopback WebSocket endpoint", () => {
    expect(
      parseRuntimeBootstrap({
        authToken: token,
        nativeSidebarMaterial: true,
        rpcUrl: "ws://127.0.0.1:43123/rpc",
      }),
    ).toEqual({
      authToken: token,
      nativeSidebarMaterial: true,
      rpcUrl: "ws://127.0.0.1:43123/rpc",
    });

    for (const rpcUrl of [
      "wss://127.0.0.1:43123/rpc",
      "ws://localhost:43123/rpc",
      "ws://192.168.1.2:43123/rpc",
      "ws://token@127.0.0.1:43123/rpc",
      "ws://127.0.0.1:43123/rpc?token=secret",
      "ws://127.0.0.1:43123/other",
    ]) {
      expect(() =>
        parseRuntimeBootstrap({ authToken: token, nativeSidebarMaterial: true, rpcUrl }),
      ).toThrow();
    }
  });

  it("requires an explicit native material capability instead of inferring one from Tauri", () => {
    expect(() =>
      parseRuntimeBootstrap({ authToken: token, rpcUrl: "ws://127.0.0.1:43123/rpc" }),
    ).toThrow("Invalid native sidebar material capability");
    expect(() =>
      parseRuntimeBootstrap({
        authToken: token,
        nativeSidebarMaterial: "macos",
        rpcUrl: "ws://127.0.0.1:43123/rpc",
      }),
    ).toThrow("Invalid native sidebar material capability");
  });

  it("keeps the token in the RPC authentication message instead of the endpoint", async () => {
    const transport = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      readyState: 0,
      removeEventListener: vi.fn(),
      send: vi.fn(),
    };
    const openWebSocket = vi.fn((_url: string) => transport as unknown as WebSocket);
    const startup = await resolveStartupStatusClient({
      invokeBootstrap: async () => ({
        authToken: token,
        nativeSidebarMaterial: true,
        rpcUrl: "ws://127.0.0.1:43123/rpc",
      }),
      invokeLocalProfilePreflight: vi.fn(),
      isDesktop: () => true,
      openWebSocket,
    });

    const request = startup.client?.getSnapshot();
    expect(startup.runtime).toBe("desktop");
    expect(startup.nativeSidebarMaterial).toBe(true);
    expect(openWebSocket).toHaveBeenCalledWith("ws://127.0.0.1:43123/rpc");
    expect(openWebSocket.mock.calls[0][0]).not.toContain(token);
    startup.dispose();
    await expect(request).rejects.toMatchObject({ code: "disconnected" });
  });
});
