import { OrpcSessionAuthority, WebSocketTransport } from "@mish/orpc-client";
import type { CutoverSessionFactory } from "../data/cutover-session-actor";

export interface WebStartup {
  readonly dispose: () => void;
  readonly session: CutoverSessionFactory;
}

interface WebSessionBootstrap {
  readonly authToken: string;
  readonly websocketUrl: string;
}

/** One production admission path: authenticated oRPC over a bounded WebSocket session. */
export async function resolveWebStartup(): Promise<WebStartup> {
  const response = await fetch("/browser-session", {
    cache: "no-store",
    credentials: "same-origin",
    headers: { Accept: "application/json" },
    method: "POST",
  });
  if (response.status === 401 || response.status === 403) throw new BrowserAuthenticationRequired();
  if (!response.ok) throw new WebSessionUnavailable(response.status);
  const bootstrap = parseWebSessionBootstrap(await response.json());
  return {
    dispose: () => undefined,
    session: {
      createAuthority: () =>
        new OrpcSessionAuthority({
          authToken: bootstrap.authToken,
          clientName: "web",
          clientVersion: "web-cutover-v1",
        }),
      createChannel: () => new WebSocketTransport(new WebSocket(bootstrap.websocketUrl)),
    },
  };
}

export class BrowserAuthenticationRequired extends Error {
  constructor() {
    super("Browser authentication required");
    this.name = "BrowserAuthenticationRequired";
  }
}

export class WebSessionUnavailable extends Error {
  constructor(readonly status: number) {
    super(`Web session unavailable (${status})`);
    this.name = "WebSessionUnavailable";
  }
}

function parseWebSessionBootstrap(value: unknown): WebSessionBootstrap {
  if (!value || typeof value !== "object") throw new WebSessionUnavailable(502);
  const record = value as Record<string, unknown>;
  if (typeof record.authToken !== "string" || record.authToken.length < 1) {
    throw new WebSessionUnavailable(502);
  }
  if (typeof record.websocketUrl !== "string") throw new WebSessionUnavailable(502);
  const endpoint = new URL(record.websocketUrl, window.location.href);
  if (endpoint.protocol !== "ws:" && endpoint.protocol !== "wss:") {
    throw new WebSessionUnavailable(502);
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw new WebSessionUnavailable(502);
  }
  return { authToken: record.authToken, websocketUrl: endpoint.href };
}
