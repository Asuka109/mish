export const MISH_BROWSER_DISCOVERY_PATH = "/browser-discovery";
export const MISH_BROWSER_DISCOVERY_SERVICE = "mish-browser-backend";
export const MISH_BROWSER_DISCOVERY_SCHEMA_VERSION = 1;
export const MISH_BROWSER_DISCOVERY_PROTOCOL_VERSION = 1;

const FIRST_MISH_BROWSER_PORT = 6474;
const LAST_MISH_BROWSER_PORT = 65_535;
const DEFAULT_MAX_EMPTY_PORTS = 5;
const DEFAULT_MAX_OCCUPIED_PORTS = 10;
const DEFAULT_PROBE_TIMEOUT_MILLISECONDS = 400;
const DEFAULT_SCAN_TIMEOUT_MILLISECONDS = 15_000;

interface DiscoveryOptions {
  fetch?: typeof fetch;
  maxEmptyPorts?: number;
  maxOccupiedPorts?: number;
  maxPort?: number;
  preferredPort: number;
  probeTimeoutMilliseconds?: number;
  scanTimeoutMilliseconds?: number;
  signal: AbortSignal;
}

export type BrowserBackendDiscoveryResult =
  | { origin: string; phase: "found"; port: number }
  | { emptyPorts: number; occupiedPorts: number; phase: "not-found" };

type BrowserBackendProbeResult =
  | { origin: string; phase: "found"; port: number }
  | { phase: "empty" | "occupied" };

export async function discoverMishBrowserBackend({
  fetch: fetchRequest = globalThis.fetch,
  maxEmptyPorts = DEFAULT_MAX_EMPTY_PORTS,
  maxOccupiedPorts = DEFAULT_MAX_OCCUPIED_PORTS,
  maxPort = LAST_MISH_BROWSER_PORT,
  preferredPort,
  probeTimeoutMilliseconds = DEFAULT_PROBE_TIMEOUT_MILLISECONDS,
  scanTimeoutMilliseconds = DEFAULT_SCAN_TIMEOUT_MILLISECONDS,
  signal,
}: DiscoveryOptions): Promise<BrowserBackendDiscoveryResult> {
  assertPort(preferredPort);
  assertPort(maxPort);
  if (maxPort < FIRST_MISH_BROWSER_PORT) throw new RangeError("Invalid discovery port range");
  assertPositiveInteger(maxEmptyPorts, "empty-port limit");
  assertPositiveInteger(maxOccupiedPorts, "occupied-port limit");

  throwIfAborted(signal);
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), scanTimeoutMilliseconds);
  try {
    const current = await probeMishBrowserBackend(
      preferredPort,
      fetchRequest,
      [signal, deadline.signal],
      probeTimeoutMilliseconds,
    );
    throwIfAborted(signal);
    if (current.phase === "found") return current;
    if (deadline.signal.aborted) return notFound(0, 0);

    let emptyPorts = 0;
    let occupiedPorts = 0;
    for (let port = FIRST_MISH_BROWSER_PORT; port <= maxPort; port += 1) {
      if (port === preferredPort) continue;
      const result = await probeMishBrowserBackend(
        port,
        fetchRequest,
        [signal, deadline.signal],
        probeTimeoutMilliseconds,
      );
      throwIfAborted(signal);
      if (result.phase === "found") return result;
      if (result.phase === "occupied") occupiedPorts += 1;
      else emptyPorts += 1;
      if (
        deadline.signal.aborted ||
        emptyPorts >= maxEmptyPorts ||
        occupiedPorts >= maxOccupiedPorts
      ) {
        return notFound(emptyPorts, occupiedPorts);
      }
    }
    return notFound(emptyPorts, occupiedPorts);
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function probeMishBrowserBackend(
  port: number,
  fetchRequest: typeof fetch,
  cancellationSignals: AbortSignal[],
  timeoutMilliseconds: number,
): Promise<BrowserBackendProbeResult> {
  const origin = `http://127.0.0.1:${port}`;
  const url = `${origin}${MISH_BROWSER_DISCOVERY_PATH}`;
  const markerMatches = await fetchWithTimeout(
    fetchRequest,
    url,
    {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      redirect: "error",
      referrerPolicy: "no-referrer",
    },
    cancellationSignals,
    timeoutMilliseconds,
    async (response) => {
      if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
        return false;
      }
      try {
        return isMishBrowserDiscoveryPayload(await response.json());
      } catch {
        return false;
      }
    },
  );
  if (markerMatches === true) return { origin, phase: "found", port };
  if (markerMatches === false) return { phase: "occupied" };
  if (cancellationSignals.some((signal) => signal.aborted)) return { phase: "empty" };

  const opaqueResponse = await fetchWithTimeout(
    fetchRequest,
    url,
    {
      cache: "no-store",
      credentials: "omit",
      mode: "no-cors",
      redirect: "follow",
      referrerPolicy: "no-referrer",
    },
    cancellationSignals,
    timeoutMilliseconds,
    async () => true,
  );
  return { phase: opaqueResponse ? "occupied" : "empty" };
}

async function fetchWithTimeout(
  fetchRequest: typeof fetch,
  url: string,
  init: RequestInit,
  cancellationSignals: AbortSignal[],
  timeoutMilliseconds: number,
  consume: (response: Response) => Promise<boolean>,
): Promise<boolean | null> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const cancellationSignal of cancellationSignals) {
    cancellationSignal.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(abort, timeoutMilliseconds);
  try {
    const response = await fetchRequest(url, {
      ...init,
      signal: controller.signal,
    });
    return await consume(response);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    for (const cancellationSignal of cancellationSignals) {
      cancellationSignal.removeEventListener("abort", abort);
    }
  }
}

function notFound(emptyPorts: number, occupiedPorts: number): BrowserBackendDiscoveryResult {
  return { emptyPorts, occupiedPorts, phase: "not-found" };
}

function isMishBrowserDiscoveryPayload(value: unknown) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  return (
    Object.keys(payload).length === 3 &&
    payload.service === MISH_BROWSER_DISCOVERY_SERVICE &&
    payload.schemaVersion === MISH_BROWSER_DISCOVERY_SCHEMA_VERSION &&
    payload.protocolVersion === MISH_BROWSER_DISCOVERY_PROTOCOL_VERSION
  );
}

function assertPort(port: number) {
  if (!Number.isInteger(port) || port < 1 || port > LAST_MISH_BROWSER_PORT) {
    throw new RangeError("Invalid browser backend port");
  }
}

function assertPositiveInteger(value: number, label: string) {
  if (!Number.isInteger(value) || value < 1) throw new RangeError(`Invalid discovery ${label}`);
}

function throwIfAborted(signal: AbortSignal) {
  if (signal.aborted)
    throw new DOMException("Browser backend discovery was cancelled", "AbortError");
}

export function buildBrowserBackendUrl(origin: string, currentHref = window.location.href) {
  const backend = new URL(origin);
  if (
    backend.protocol !== "http:" ||
    backend.hostname !== "127.0.0.1" ||
    !backend.port ||
    backend.username ||
    backend.password ||
    backend.pathname !== "/" ||
    backend.search ||
    backend.hash
  ) {
    throw new TypeError("Invalid Mish browser backend origin");
  }
  const target = new URL(currentHref);
  target.protocol = backend.protocol;
  target.hostname = backend.hostname;
  target.port = backend.port;
  target.hash = "";
  return target.href;
}
