import { existsSync, realpathSync } from "node:fs";
import path from "node:path";

import { rendererAssetPath, type RendererPolicy } from "./security";

const extensionPattern = /\.[a-z0-9]{1,12}$/u;

/** Resolve only a checked renderer asset; never let a request choose a path. */
export function resolveMishAsset(requestUrl: string, policy: RendererPolicy): string | null {
  const candidate = rendererAssetPath(requestUrl, policy);
  if (!candidate) return null;
  const asset = existsSync(candidate)
    ? candidate
    : extensionPattern.test(candidate)
      ? null
      : path.join(policy.webRoot, "index.html");
  if (!asset || !existsSync(asset)) return null;
  try {
    const root = realpathSync(policy.webRoot);
    const resolved = realpathSync(asset);
    const relative = path.relative(root, resolved);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      return null;
    }
    return resolved;
  } catch {
    return null;
  }
}

export function contentTypeForAsset(asset: string): string {
  switch (path.extname(asset).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
    case ".map":
    case ".webmanifest":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".woff":
      return "font/woff";
    case ".woff2":
      return "font/woff2";
    default:
      return "application/octet-stream";
  }
}
