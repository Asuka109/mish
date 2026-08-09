import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");

function source(path: string): string {
  return readFileSync(resolve(repositoryRoot, path), "utf8");
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function normalDependencies(manifest: string): Set<string> {
  const dependencies = new Set<string>();
  let normalSection = false;
  let tableDependency: string | undefined;
  for (const line of manifest.split("\n")) {
    const header = line.trim().match(/^\[(.+)\]$/u)?.[1];
    if (header) {
      const dependencySection = header.match(
        /^(?:target\..+\.)?dependencies(?:\.([A-Za-z0-9_-]+))?$/u,
      );
      normalSection = dependencySection !== null;
      tableDependency = dependencySection?.[1];
      if (tableDependency) dependencies.add(tableDependency);
      continue;
    }
    if (!normalSection || line.trimStart().startsWith("#")) continue;
    if (!tableDependency) {
      const dependency = line.match(/^\s*([A-Za-z0-9_-]+)\s*=/u)?.[1];
      if (dependency) dependencies.add(dependency);
    }
    const packageName = line.match(/\bpackage\s*=\s*"([^"]+)"/u)?.[1];
    if (packageName) dependencies.add(packageName);
  }
  return dependencies;
}

function rustSources(relative: string): string[] {
  const sources: string[] = [];
  for (const entry of readdirSync(resolve(repositoryRoot, relative), { withFileTypes: true })) {
    const path = `${relative}/${entry.name}`;
    if (entry.isDirectory()) {
      sources.push(...rustSources(path));
    } else if (entry.name.endsWith(".rs")) {
      sources.push(source(path));
    }
  }
  return sources;
}

function workspaceDependencyGraph(): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const root of ["crates", "apps"]) {
    const visit = (relative: string): void => {
      for (const entry of readdirSync(resolve(repositoryRoot, relative), { withFileTypes: true })) {
        const path = `${relative}/${entry.name}`;
        if (entry.isDirectory()) {
          visit(path);
          continue;
        }
        if (entry.name !== "Cargo.toml") continue;
        const manifest = source(path);
        const packageName = manifest.match(/^name\s*=\s*"([^"]+)"/mu)?.[1];
        if (packageName) graph.set(packageName, normalDependencies(manifest));
      }
    };
    visit(root);
  }
  return graph;
}

function hasDependencyPath(
  graph: ReadonlyMap<string, ReadonlySet<string>>,
  from: string,
  target: string,
): boolean {
  const pending = [from];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop();
    if (!current || visited.has(current)) continue;
    visited.add(current);
    for (const dependency of graph.get(current) ?? []) {
      if (dependency === target) return true;
      if (graph.has(dependency)) pending.push(dependency);
    }
  }
  return false;
}

export function checkPlatformDependencyBoundary(): void {
  const graph = workspaceDependencyGraph();
  invariant(
    !hasDependencyPath(graph, "mish-platform-macos", "mish-bridge"),
    "mish-platform-macos must not reach the full mish-bridge through normal dependencies.",
  );

  const platformManifest = source("crates/platform-macos/Cargo.toml");
  const platformSources = rustSources("crates/platform-macos/src");
  const platformCoreHost = source("crates/platform-macos/src/tun_service.rs");
  const platformIcon = source("crates/platform-macos/src/process_icon.rs");
  const runtimeCorePort = source("crates/runtime/src/privileged_core.rs");
  const runtimeIconPort = source("crates/runtime/src/process_icon.rs");
  const bridgeProcess = source("crates/desktop-bridge/src/managed_process.rs");
  const bridgeServer = source("crates/desktop-bridge/src/server.rs");
  const desktopHost = source("apps/desktop/src-tauri/src/lib.rs");

  invariant(
    !platformManifest.includes("mish-bridge") &&
      platformSources.every((contents) => !contents.includes("mish_bridge")),
    "The macOS platform adapter must not import or declare the full Desktop Bridge.",
  );
  for (const contract of [
    "pub struct PrivilegedCoreLaunchRequest",
    "pub struct PrivilegedCoreProcess",
    "pub enum PrivilegedCoreHostError",
    "pub trait PrivilegedCoreHost",
  ]) {
    invariant(runtimeCorePort.includes(contract), `Runtime is missing ${contract}.`);
  }
  invariant(
    runtimeCorePort.includes("fn start(") &&
      runtimeCorePort.includes("fn observe(") &&
      runtimeCorePort.includes("fn stop(") &&
      runtimeCorePort.includes("fn owns_listener("),
    "The Runtime privileged Core port must retain launch, observation, cleanup, and ownership proof.",
  );
  invariant(
    runtimeIconPort.includes("pub struct ProcessIcon") &&
      runtimeIconPort.includes("pub trait ProcessIconResolver") &&
      runtimeIconPort.includes("PROCESS_ICON_MAX_BYTES") &&
      runtimeIconPort.includes("PROCESS_ICON_PNG_SIGNATURE"),
    "Runtime is missing the bounded process-icon contract.",
  );
  invariant(
    platformCoreHost.includes("impl PrivilegedCoreHost for MacOsTunServiceClient") &&
      platformIcon.includes("impl ProcessIconResolver for MacOsProcessIconResolver"),
    "macOS must retain the concrete privileged Core and process-icon adapters.",
  );
  invariant(
    bridgeProcess.includes("PrivilegedCoreHost") &&
      bridgeServer.includes("ProcessIconResolver") &&
      !bridgeProcess.includes("pub trait PrivilegedCoreHost") &&
      !bridgeServer.includes("pub trait ProcessIconResolver"),
    "Desktop Bridge must consume lower ports without owning or re-declaring them.",
  );
  invariant(
    desktopHost.includes("Arc<dyn PrivilegedCoreHost>") &&
      desktopHost.includes("MacOsProcessIconResolver::default()"),
    "The desktop host must compose the concrete macOS adapters into Bridge consumers.",
  );
}

if (process.argv[1] === import.meta.filename) {
  checkPlatformDependencyBoundary();
  console.log(
    "Platform dependency boundary valid: macOS adapters implement Runtime ports without reaching Desktop Bridge.",
  );
}
