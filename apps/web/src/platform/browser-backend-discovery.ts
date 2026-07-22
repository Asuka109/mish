export const MISH_BROWSER_DISCOVERY_PATH = "/browser-discovery";
export const MISH_BROWSER_DISCOVERY_SERVICE = "mish-browser-backend";
export const MISH_BROWSER_DISCOVERY_SCHEMA_VERSION = 1;
export const MISH_BROWSER_DISCOVERY_PROTOCOL_VERSION = 1;

const FIRST_MISH_BROWSER_PORT = 6474;
const LAST_MISH_BROWSER_PORT = 65_535;
const DEFAULT_CONCURRENCY = 12;
const DEFAULT_PROBE_TIMEOUT_MILLISECONDS = 400;
const DEFAULT_SCAN_TIMEOUT_MILLISECONDS = 15_000;

interface DiscoveryOptions {
  concurrency?: number;
  currentPort: number;
  fetch?: typeof fetch;
  maxPort?: number;
  probeTimeoutMilliseconds?: number;
  scanTimeoutMilliseconds?: number;
  signal: AbortSignal;
}

export type BrowserBackendDiscoveryResult =
  | { origin: string; phase: "found"; port: number }
  | { phase: "not-found" };

export async function discoverMishBrowserBackend({
  concurrency = DEFAULT_CONCURRENCY,
  currentPort,
  fetch: fetchRequest = globalThis.fetch,
  maxPort = LAST_MISH_BROWSER_PORT,
  probeTimeoutMilliseconds = DEFAULT_PROBE_TIMEOUT_MILLISECONDS,
  scanTimeoutMilliseconds = DEFAULT_SCAN_TIMEOUT_MILLISECONDS,
  signal,
}: DiscoveryOptions): Promise<BrowserBackendDiscoveryResult> {
  assertPort(currentPort);
  assertPort(maxPort);
  if (maxPort < FIRST_MISH_BROWSER_PORT) throw new RangeError("Invalid discovery port range");
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new RangeError("Discovery concurrency must be between 1 and 32");
  }

  throwIfAborted(signal);
  const deadline = new AbortController();
  const deadlineTimer = setTimeout(() => deadline.abort(), scanTimeoutMilliseconds);
  try {
    const current = await probeMishBrowserBackend(
      currentPort,
      fetchRequest,
      [signal, deadline.signal],
      probeTimeoutMilliseconds,
    );
    throwIfAborted(signal);
    if (current) return current;
    if (deadline.signal.aborted) return { phase: "not-found" };

    for (let start = FIRST_MISH_BROWSER_PORT; start <= maxPort; start += concurrency) {
      const ports = Array.from(
        { length: Math.min(concurrency, maxPort - start + 1) },
        (_, index) => start + index,
      );
      const results = await Promise.all(
        ports.map((port) =>
          probeMishBrowserBackend(
            port,
            fetchRequest,
            [signal, deadline.signal],
            probeTimeoutMilliseconds,
          ),
        ),
      );
      throwIfAborted(signal);
      const found = results.find((candidate) => candidate !== null);
      if (found) return found;
      if (deadline.signal.aborted) return { phase: "not-found" };
    }
    return { phase: "not-found" };
  } finally {
    clearTimeout(deadlineTimer);
  }
}

async function probeMishBrowserBackend(
  port: number,
  fetchRequest: typeof fetch,
  cancellationSignals: AbortSignal[],
  timeoutMilliseconds: number,
) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const cancellationSignal of cancellationSignals) {
    cancellationSignal.addEventListener("abort", abort, { once: true });
  }
  const timeout = setTimeout(abort, timeoutMilliseconds);
  try {
    const origin = `http://127.0.0.1:${port}`;
    const response = await fetchRequest(`${origin}${MISH_BROWSER_DISCOVERY_PATH}`, {
      cache: "no-store",
      credentials: "omit",
      headers: { Accept: "application/json" },
      redirect: "error",
      referrerPolicy: "no-referrer",
      signal: controller.signal,
    });
    if (!response.ok || !response.headers.get("content-type")?.startsWith("application/json")) {
      return null;
    }
    const payload = await response.json();
    if (!isMishBrowserDiscoveryPayload(payload)) return null;
    return { origin, phase: "found", port } as const;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
    for (const cancellationSignal of cancellationSignals) {
      cancellationSignal.removeEventListener("abort", abort);
    }
  }
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
