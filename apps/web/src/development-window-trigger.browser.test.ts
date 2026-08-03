import { describe, expect, test, vi } from "vitest";
import clientSource from "../../../crates/desktop-bridge/assets/development-window-trigger-client.js?raw";

interface TriggerClient {
  activateDevelopmentWindow(options: {
    crypto: Crypto;
    fetch: typeof fetch;
    history: Pick<History, "replaceState">;
    location: Pick<Location, "hash" | "pathname">;
    status: Pick<HTMLElement, "textContent">;
  }): Promise<boolean>;
}

async function loadTriggerClient(): Promise<TriggerClient> {
  const bytes = new TextEncoder().encode(clientSource);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const module = await import(
    /* @vite-ignore */ `data:text/javascript;base64,${window.btoa(binary)}`
  );
  return module as TriggerClient;
}

describe("development desktop-window trigger client in Chromium", () => {
  test("clears the capability fragment before sending one bounded activation request", async () => {
    const events: string[] = [];
    const fetchRequest = vi.fn<typeof fetch>(async (_input, _init) => {
      events.push("fetch");
      return new Response(null, { status: 204 });
    });
    const history = {
      replaceState: vi.fn(() => events.push("replace")),
    };
    const status = document.createElement("p");
    const capability = "a".repeat(43);
    const client = await loadTriggerClient();

    await expect(
      client.activateDevelopmentWindow({
        crypto: window.crypto,
        fetch: fetchRequest,
        history,
        location: {
          hash: `#mish-desktop-window-trigger=${capability}`,
          pathname: "/__openWindow",
        },
        status,
      }),
    ).resolves.toBe(true);

    expect(events).toEqual(["replace", "fetch"]);
    expect(history.replaceState).toHaveBeenCalledWith(null, "", "/__openWindow");
    const request = fetchRequest.mock.calls[0];
    expect(request?.[0]).toBe("/__openWindow");
    expect(request?.[1]).toMatchObject({
      cache: "no-store",
      credentials: "omit",
      method: "POST",
    });
    const body = JSON.parse(String(request?.[1]?.body));
    expect(body.capability).toBe(capability);
    expect(body.requestId).toMatch(/^[A-Za-z0-9_-]{43}$/u);
    expect(status.textContent).toBe("Mish is opening. You can close this page.");
  });

  test("fails malformed and rejected capabilities without exposing backend credentials", async () => {
    const client = await loadTriggerClient();
    const malformedFetch = vi.fn<typeof fetch>();
    const malformedStatus = document.createElement("p");

    await expect(
      client.activateDevelopmentWindow({
        crypto: window.crypto,
        fetch: malformedFetch,
        history: { replaceState: vi.fn() },
        location: { hash: "#mish-desktop-window-trigger=short", pathname: "/trigger" },
        status: malformedStatus,
      }),
    ).resolves.toBe(false);
    expect(malformedFetch).not.toHaveBeenCalled();
    expect(malformedStatus.textContent).toContain("invalid");

    const rejectedStatus = document.createElement("p");
    await expect(
      client.activateDevelopmentWindow({
        crypto: window.crypto,
        fetch: vi.fn(async () => new Response(null, { status: 409 })),
        history: { replaceState: vi.fn() },
        location: {
          hash: `#mish-desktop-window-trigger=${"b".repeat(43)}`,
          pathname: "/__openWindow",
        },
        status: rejectedStatus,
      }),
    ).resolves.toBe(false);
    expect(rejectedStatus.textContent).toContain("expired or was already used");
    expect(clientSource).not.toContain("authToken");
    expect(clientSource).not.toContain("browser-bootstrap");
  });
});
