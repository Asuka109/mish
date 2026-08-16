import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const errors: string[] = [];

const retiredPaths = [
  "Cargo.toml",
  "Cargo.lock",
  ".cargo",
  "rust-toolchain",
  "rust-toolchain.toml",
  "rustfmt.toml",
  "clippy.toml",
  "crates",
  "mobile-core",
  "apps/desktop/src-tauri",
  "apps/mobile/src-tauri",
  "packages/rpc-client",
  "packages/bridge-protocol",
  "packages/brand-assets/generated/tauri",
] as const;
for (const relative of retiredPaths) {
  if (existsSync(resolve(root, relative))) errors.push(`retired path still exists: ${relative}`);
}

const productionManifests = [
  "package.json",
  "pnpm-workspace.yaml",
  "pnpm-lock.yaml",
  "apps/web/package.json",
  "apps/desktop/package.json",
  "apps/mobile/package.json",
  "packages/contracts/package.json",
  "packages/domain/package.json",
  "packages/orpc-client/package.json",
  "packages/ui-state/package.json",
] as const;
const manifestForbidden =
  /(?:@tauri-apps|tauri-plugin|src-tauri|packages\/(?:rpc-client|bridge-protocol)|(?:^|[^a-z])cargo(?:$|[^a-z]))/iu;
for (const relative of productionManifests) {
  const source = readFileSync(resolve(root, relative), "utf8");
  if (manifestForbidden.test(source))
    errors.push(`production manifest contains retired dependency: ${relative}`);
}

function candidates(file: string): string[] {
  const extension = extname(file);
  if (extension) {
    const withoutExtension = file.slice(0, -extension.length);
    if (extension === ".js" || extension === ".jsx") {
      return [
        file,
        `${withoutExtension}.ts`,
        `${withoutExtension}.tsx`,
        `${withoutExtension}.js`,
        `${withoutExtension}.jsx`,
      ];
    }
    return [file];
  }
  return [".ts", ".tsx", ".js", ".jsx", ".css", "/index.ts", "/index.tsx", "/index.js"].map(
    (suffix) => `${file}${suffix}`,
  );
}

function resolveImport(from: string, specifier: string): string | undefined {
  if (specifier.startsWith("@mish/")) {
    const [name, ...parts] = specifier.slice("@mish/".length).split("/");
    const packageRoot = resolve(root, "packages", name ?? "");
    const packagePath =
      parts.length > 0 ? resolve(packageRoot, "src", ...parts) : resolve(packageRoot, "src/index");
    return candidates(packagePath).find((candidate) => existsSync(candidate));
  }
  if (!specifier.startsWith(".")) return undefined;
  return candidates(resolve(dirname(from), specifier)).find((candidate) => existsSync(candidate));
}

const importPattern =
  /(?:from\s*["']([^"']+)["']|import\s*\(["']([^"']+)["']\)|import\s*["']([^"']+)["'])/gu;
const forbiddenReachable =
  /@tauri-apps|tauri-plugin|src-tauri|JSON[- ]RPC|bridge-protocol|\b(?:mishRpc|RpcSessionAuthority|MobileVpnClient|snapshot-authority)\b/u;
const entries = [
  "apps/web/src/main.tsx",
  "apps/web/src/window-startup.ts",
  "apps/web/appearance-bootstrap.js",
  "apps/desktop/src/main.ts",
  "apps/desktop/src/preload.ts",
  "apps/desktop/src/renderer.tsx",
  "apps/mobile/index.ts",
  "apps/mobile/src/App.tsx",
] as const;
const visited = new Set<string>();
const queue = entries.map((relative) => resolve(root, relative));
while (queue.length > 0) {
  const file = queue.shift()!;
  if (visited.has(file) || !existsSync(file)) {
    if (!existsSync(file))
      errors.push(`production entry/import is missing: ${file.slice(root.length + 1)}`);
    continue;
  }
  visited.add(file);
  if (/(?:^|\/)(?:.*\.test|.*\.spec)\.[cm]?[jt]sx?$/u.test(file)) {
    errors.push(`production graph reaches test-only source: ${file.slice(root.length + 1)}`);
  }
  const source = readFileSync(file, "utf8");
  if (forbiddenReachable.test(source))
    errors.push(
      `retired protocol/effect marker in reachable source: ${file.slice(root.length + 1)}`,
    );
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2] ?? match[3];
    if (!specifier) continue;
    const imported = resolveImport(file, specifier);
    if (imported) queue.push(imported);
    else if (specifier.startsWith(".") || specifier.startsWith("@mish/")) {
      errors.push(`unresolved production import ${specifier} from ${file.slice(root.length + 1)}`);
    }
  }
}

const workspace = readFileSync(resolve(root, "pnpm-workspace.yaml"), "utf8");
if (/\bpoc\b/iu.test(workspace)) errors.push("POC must not be a production workspace member");
const rootPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};
if (rootPackage.scripts?.["poc:admission"] !== "node scripts/check-poc-admission.ts") {
  errors.push("POC must be reachable only through the isolated admission command");
}
if (visited.size < 10) errors.push(`production graph is unexpectedly small: ${visited.size} files`);

if (errors.length > 0) {
  for (const error of errors) console.error(`RETIREMENT_GRAPH_ERROR ${error}`);
  process.exitCode = 1;
} else {
  console.log(`RETIREMENT_GRAPH_OK reachable=${visited.size} entries=${entries.length}`);
}
