import { describe, expect, it, vi } from "vitest";
import {
  buildBrowserBackendUrl,
  discoverMishBrowserBackend,
  MISH_BROWSER_DISCOVERY_PROTOCOL_VERSION,
  MISH_BROWSER_DISCOVERY_SCHEMA_VERSION,
  MISH_BROWSER_DISCOVERY_SERVICE,
} from "./browser-backend-discovery";

function discoveryResponse(payload: unknown, status = 200) {
  return new Response(JSON.stringify(payload), {
    headers: { "Content-Type": "application/json" },
    status,
  });
}

const marker = {
  protocolVersion: MISH_BROWSER_DISCOVERY_PROTOCOL_VERSION,
  schemaVersion: MISH_BROWSER_DISCOVERY_SCHEMA_VERSION,
  service: MISH_BROWSER_DISCOVERY_SERVICE,
};

describe("browser backend discovery", () => {
  it("tries the current backend first and uses no browser credentials", async () => {
    const fetchRequest = vi.fn(async () => discoveryResponse(marker));

    await expect(
      discoverMishBrowserBackend({
        preferredPort: 6500,
        fetch: fetchRequest,
        maxPort: 6500,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ origin: "http://127.0.0.1:6500", phase: "found", port: 6500 });
    expect(fetchRequest).toHaveBeenCalledOnce();
    expect(fetchRequest).toHaveBeenCalledWith(
      "http://127.0.0.1:6500/browser-discovery",
      expect.objectContaining({
        credentials: "omit",
        headers: { Accept: "application/json" },
        redirect: "error",
      }),
    );
  });

  it("checks from 6474 upward and rejects unrelated listeners before a later Mish backend", async () => {
    const visited: number[] = [];
    const fetchRequest = vi.fn(async (input: string | URL | Request) => {
      const port = Number.parseInt(new URL(String(input)).port, 10);
      visited.push(port);
      if (port === 6474) return discoveryResponse({ status: "ok" });
      if (port === 6475) return discoveryResponse({ ...marker, service: "not-mish" });
      if (port === 6476) return discoveryResponse(marker);
      return discoveryResponse({}, 404);
    });

    await expect(
      discoverMishBrowserBackend({
        preferredPort: 6500,
        fetch: fetchRequest,
        maxPort: 6476,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ origin: "http://127.0.0.1:6476", phase: "found", port: 6476 });
    expect(visited).toEqual([6500, 6474, 6475, 6476]);
  });

  it("reports occupied candidates when every bounded listener is unrelated", async () => {
    const fetchRequest = vi.fn(async () => discoveryResponse({ service: "other" }));

    await expect(
      discoverMishBrowserBackend({
        preferredPort: 6500,
        fetch: fetchRequest,
        maxPort: 6476,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ emptyPorts: 0, occupiedPorts: 3, phase: "not-found" });
  });

  it("stops after five empty conventional ports", async () => {
    const emptyPorts: number[] = [];
    const fetchRequest = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const port = Number.parseInt(new URL(String(input)).port, 10);
      if (port === 5000) return discoveryResponse({ service: "other" });
      if (init?.mode === "no-cors") emptyPorts.push(port);
      throw new TypeError("connection refused");
    });

    await expect(
      discoverMishBrowserBackend({
        preferredPort: 5000,
        fetch: fetchRequest,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ emptyPorts: 5, occupiedPorts: 0, phase: "not-found" });
    expect(emptyPorts).toEqual([6474, 6475, 6476, 6477, 6478]);
  });

  it("uses credential-free opaque probes and stops after ten CORS-blocked listeners", async () => {
    const occupiedPorts: number[] = [];
    const fetchRequest = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const port = Number.parseInt(new URL(String(input)).port, 10);
      if (port === 5000) return discoveryResponse({ service: "other" });
      if (init?.mode !== "no-cors") throw new TypeError("CORS blocked");
      occupiedPorts.push(port);
      expect(init).toEqual(
        expect.objectContaining({
          credentials: "omit",
          mode: "no-cors",
          redirect: "follow",
          referrerPolicy: "no-referrer",
        }),
      );
      expect(init?.headers).toBeUndefined();
      return new Response(null, { status: 204 });
    });

    await expect(
      discoverMishBrowserBackend({
        preferredPort: 5000,
        fetch: fetchRequest,
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ emptyPorts: 0, occupiedPorts: 10, phase: "not-found" });
    expect(occupiedPorts).toEqual([6474, 6475, 6476, 6477, 6478, 6479, 6480, 6481, 6482, 6483]);
  });

  it("cancels pending probes", async () => {
    const controller = new AbortController();
    const fetchRequest = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            "abort",
            () => reject(new DOMException("cancelled", "AbortError")),
            { once: true },
          );
        }),
    );
    const discovery = discoverMishBrowserBackend({
      preferredPort: 6474,
      fetch: fetchRequest,
      probeTimeoutMilliseconds: 10_000,
      signal: controller.signal,
    });

    controller.abort();
    await expect(discovery).rejects.toMatchObject({ name: "AbortError" });
  });

  it("navigates to only a validated loopback origin without carrying fragments", () => {
    expect(
      buildBrowserBackendUrl(
        "http://127.0.0.1:6476",
        "http://127.0.0.1:6474/routes?view=groups#old-secret",
      ),
    ).toBe("http://127.0.0.1:6476/routes?view=groups");

    for (const origin of [
      "https://127.0.0.1:6476",
      "http://localhost:6476",
      "http://token@127.0.0.1:6476",
      "http://127.0.0.1:6476/path",
      "http://127.0.0.1:6476/?proof=secret",
    ]) {
      expect(() => buildBrowserBackendUrl(origin)).toThrow();
    }
  });
});
