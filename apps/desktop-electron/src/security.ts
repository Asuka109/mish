import path from "node:path";

export const MISH_PROTOCOL = "mish";
export const MISH_PROTOCOL_HOST = "app";

/**
 * Keep these values in one object so the smoke test and the BrowserWindow
 * construction cannot silently drift apart. Electron's sandbox is an
 * additional process boundary; it is not a replacement for context isolation.
 */
export const HARDENED_WEB_PREFERENCES = Object.freeze({
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
  webSecurity: true,
  webviewTag: false,
} as const);

export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "base-uri 'none'",
  "connect-src 'self' ws://127.0.0.1:* wss://127.0.0.1:*",
  "font-src 'self' data:",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "img-src 'self' data: blob:",
  "object-src 'none'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join("; ");

export type RendererPolicy = {
  customScheme: typeof MISH_PROTOCOL;
  customSchemeHost: typeof MISH_PROTOCOL_HOST;
  webRoot: string;
  developmentOrigin: string | null;
};

export function createRendererPolicy(
  webRoot: string,
  developmentOrigin: string | null = null,
): RendererPolicy {
  return {
    customScheme: MISH_PROTOCOL,
    customSchemeHost: MISH_PROTOCOL_HOST,
    webRoot: path.resolve(webRoot),
    developmentOrigin,
  };
}

export function parseDevelopmentOrigin(value: string | undefined): string | null {
  if (!value) return null;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error("Electron development origin is invalid");
  }
  if (
    parsed.protocol !== "http:" ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("Electron development origin must be an uncredentialed IPv4 loopback URL");
  }
  const port = parsed.port ? Number.parseInt(parsed.port, 10) : 80;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Electron development origin port is invalid");
  }
  return parsed.origin;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

export function rendererAssetPath(
  requestUrl: string,
  policy: Pick<RendererPolicy, "customScheme" | "customSchemeHost" | "webRoot">,
): string | null {
  const rawPath = requestUrl.split(/[?#]/u, 1)[0] ?? "";
  if (/(?:^|\/)(?:\.\.?)(?:\/|$)/u.test(rawPath) || /%2e/iu.test(rawPath)) return null;
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return null;
  }
  if (
    parsed.protocol !== `${policy.customScheme}:` ||
    parsed.hostname !== policy.customSchemeHost ||
    parsed.port ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return null;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    return null;
  }
  if (pathname.includes("\0")) return null;
  const segments = pathname.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "..")) return null;
  const relative = segments.length === 0 ? "index.html" : segments.join("/");
  const candidate = path.resolve(policy.webRoot, relative);
  return isWithinRoot(candidate, policy.webRoot) ? candidate : null;
}

export function isAllowedRendererUrl(requestUrl: string, policy: RendererPolicy): boolean {
  let parsed: URL;
  try {
    parsed = new URL(requestUrl);
  } catch {
    return false;
  }
  if (parsed.protocol === `${policy.customScheme}:`) {
    return rendererAssetPath(requestUrl, policy) !== null;
  }
  return (
    policy.developmentOrigin !== null &&
    !parsed.username &&
    !parsed.password &&
    parsed.origin === policy.developmentOrigin
  );
}

export function denyWindowOpen(): { action: "deny" } {
  return { action: "deny" };
}
