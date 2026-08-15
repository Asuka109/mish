import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  createMacOsDmg,
  verifyMacOsDmgPresentation,
} from "../../../scripts/macos-dmg-presentation.ts";
import {
  ELECTRON_DARWIN_ARM64_SHA256,
  ELECTRON_VERSION,
  verifyElectronArchive,
} from "../src/archive.ts";
export { ELECTRON_DARWIN_ARM64_SHA256, ELECTRON_VERSION, verifyElectronArchive };

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const pocRoot = path.resolve(packageRoot, "..");
const tscPath = path.join(packageRoot, "node_modules", ".bin", "tsc");

interface RuntimeBundle {
  readonly output: readonly {
    readonly type: string;
    readonly code?: string;
  }[];
}

interface ViteBuildModule {
  readonly build: (
    config: Record<string, unknown>,
  ) => Promise<RuntimeBundle | readonly RuntimeBundle[]>;
}

export interface ElectronFixturePaths {
  readonly root: string;
  readonly application: string;
  readonly dmg: string;
  readonly userData: string;
  readonly archive: ElectronArchiveEvidence;
}

function fail(message: string): never {
  throw new Error(`Electron fixture: ${message}`);
}

function assertRegularFile(file: string, description: string): void {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(file);
  } catch {
    fail(`${description} is missing: ${file}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${description} must be a regular file: ${file}`);
  }
}

function copyWithoutNodeModules(source: string, destination: string): void {
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    cpSync(path.join(source, entry.name), path.join(destination, entry.name), {
      recursive: true,
      dereference: true,
      force: true,
    });
  }
}

function packageJson(packageDirectory: string): {
  readonly name: string;
  readonly dependencies?: Record<string, string>;
  readonly optionalDependencies?: Record<string, string>;
  readonly peerDependencies?: Record<string, string>;
} {
  return JSON.parse(readFileSync(path.join(packageDirectory, "package.json"), "utf8")) as {
    readonly name: string;
    readonly dependencies?: Record<string, string>;
    readonly optionalDependencies?: Record<string, string>;
    readonly peerDependencies?: Record<string, string>;
  };
}

function resolveInstalledPackage(name: string, fromDirectory: string): string | undefined {
  const nodeModulesMarker = `${path.sep}node_modules${path.sep}`;
  const directories = [fromDirectory];
  try {
    const realDirectory = realpathSync(fromDirectory);
    if (realDirectory !== fromDirectory) directories.push(realDirectory);
  } catch {
    // The lstat candidates below provide the final deterministic failure.
  }
  const nearestNodeModules = directories.flatMap((directory) => {
    const markerIndex = directory.lastIndexOf(nodeModulesMarker);
    return markerIndex >= 0 ? [directory.slice(0, markerIndex + nodeModulesMarker.length - 1)] : [];
  });
  const candidates = [
    path.join(fromDirectory, "node_modules", name),
    ...nearestNodeModules.map((directory) => path.join(directory, name)),
    path.join(packageRoot, "node_modules", name),
    path.join(pocRoot, "node_modules", name),
  ];
  const pnpmDirectory = path.join(pocRoot, "node_modules", ".pnpm");
  if (existsSync(pnpmDirectory)) {
    const prefix = `${name.replace("/", "+")}@`;
    for (const entry of readdirSync(pnpmDirectory)) {
      if (entry.startsWith(prefix)) {
        candidates.push(path.join(pnpmDirectory, entry, "node_modules", name));
      }
    }
  }
  for (const candidate of candidates) {
    try {
      const metadata = lstatSync(candidate);
      if (metadata.isSymbolicLink()) return path.resolve(candidate);
      if (metadata.isDirectory()) return candidate;
    } catch {
      // Try the next deterministic package root.
    }
  }
  return undefined;
}

function copyDependencyClosure(
  name: string,
  sourceDirectory: string,
  destinationNodeModules: string,
  visited: Set<string>,
): void {
  if (visited.has(name)) return;
  visited.add(name);
  const destination = path.join(destinationNodeModules, name);
  copyWithoutNodeModules(sourceDirectory, destination);
  const metadata = packageJson(sourceDirectory);
  const dependencies = {
    ...metadata.dependencies,
    ...metadata.optionalDependencies,
    ...metadata.peerDependencies,
  };
  for (const dependencyName of Object.keys(dependencies)) {
    const dependencyDirectory = resolveInstalledPackage(dependencyName, sourceDirectory);
    if (!dependencyDirectory) {
      if (
        metadata.optionalDependencies?.[dependencyName] !== undefined ||
        metadata.peerDependencies?.[dependencyName] !== undefined
      ) {
        continue;
      }
      fail(`dependency ${dependencyName} for ${name} is unavailable in the frozen install`);
    }
    copyDependencyClosure(dependencyName, dependencyDirectory, destinationNodeModules, visited);
  }
}

function writeGeneratedPackage(
  name: "@mish/poc-orpc" | "@mish/poc-query-store",
  compiledSource: string,
  destinationNodeModules: string,
): void {
  const destination = path.join(destinationNodeModules, name);
  mkdirSync(destination, { recursive: true, mode: 0o755 });
  cpSync(compiledSource, path.join(destination, "src"), { recursive: true, force: true });
  writeFileSync(
    path.join(destination, "package.json"),
    JSON.stringify(
      {
        name,
        version: "0.0.0",
        private: true,
        type: "module",
        exports: {
          ".": {
            types: "./src/index.js",
            import: "./src/index.js",
          },
        },
      },
      null,
      2,
    ) + "\n",
  );
}

async function bundleRuntime(
  entry: string,
  output: string,
  root: string,
  format: "cjs" | "es",
  external: readonly string[] = [],
): Promise<void> {
  const viteDirectory = resolveInstalledPackage("vite", packageRoot);
  if (!viteDirectory) {
    fail("the frozen workspace Vite bundler is unavailable; refusing to use a global package");
  }
  const vitePath = path.join(viteDirectory, "dist", "node", "index.js");
  const vite = (await import(pathToFileURL(vitePath).href)) as ViteBuildModule;
  const result = await vite.build({
    configFile: false,
    root,
    mode: "production",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
    logLevel: "error",
    build: {
      write: false,
      emptyOutDir: false,
      minify: false,
      sourcemap: false,
      reportCompressedSize: false,
      target: "es2022",
      rollupOptions: {
        input: entry,
        external,
        output: {
          entryFileNames: path.basename(output),
          format,
        },
      },
    },
  });
  const outputs = Array.isArray(result) ? result.flatMap((item) => item.output) : result.output;
  if (outputs.length !== 1 || outputs[0]?.type !== "chunk" || typeof outputs[0].code !== "string") {
    fail(`bundled runtime has unexpected output shape for ${entry}`);
  }
  writeFileSync(output, outputs[0].code);
}

function compileRuntime(compiledRoot: string): void {
  if (!existsSync(tscPath)) fail(`TypeScript compiler is missing: ${tscPath}`);
  mkdirSync(compiledRoot, { recursive: true, mode: 0o700 });
  const sourceFiles = [
    "electron/src/main.ts",
    "electron/src/preload.ts",
    "electron/src/renderer.tsx",
    "electron/src/electron-api.ts",
    "electron/src/transcript.ts",
    "orpc/src/index.ts",
    "orpc/src/contract.ts",
    "orpc/src/transcript.ts",
    "orpc/src/transport.ts",
    "query-store/src/index.ts",
    "query-store/src/event-iterator.ts",
    "query-store/src/query.ts",
    "query-store/src/store.ts",
  ];
  execFileSync(
    tscPath,
    [
      "--ignoreConfig",
      "--target",
      "ES2022",
      "--module",
      "NodeNext",
      "--moduleResolution",
      "NodeNext",
      "--strict",
      "--skipLibCheck",
      "--verbatimModuleSyntax",
      "--isolatedModules",
      "--resolveJsonModule",
      "--forceConsistentCasingInFileNames",
      "--rewriteRelativeImportExtensions",
      "--jsx",
      "react-jsx",
      "--typeRoots",
      path.join(packageRoot, "node_modules", "@types"),
      "--lib",
      "ES2022,DOM,DOM.Iterable",
      "--outDir",
      compiledRoot,
      "--rootDir",
      pocRoot,
      ...sourceFiles,
    ],
    { cwd: pocRoot, stdio: "pipe" },
  );
}

async function stageApplication(
  extractedElectronApp: string,
  compiledRoot: string,
  fixtureRoot: string,
): Promise<string> {
  const application = path.join(fixtureRoot, "Mish.app");
  // Preserve Electron's relative framework symlinks. Node's fs.cpSync rewrites
  // them to absolute extraction paths on this host, so use Apple's archive
  // copier for the app bundle itself. Absolute links would lose ICU/framework
  // resources after the bundle is moved into the DMG.
  execFileSync("/usr/bin/ditto", [extractedElectronApp, application], { stdio: "pipe" });
  const appRoot = path.join(application, "Contents", "Resources", "app");
  const nodeModules = path.join(appRoot, "node_modules");
  mkdirSync(nodeModules, { recursive: true, mode: 0o755 });
  cpSync(path.join(packageRoot, "assets", "index.html"), path.join(appRoot, "index.html"));
  cpSync(path.join(compiledRoot, "electron", "src", "main.js"), path.join(appRoot, "main.js"));
  cpSync(
    path.join(compiledRoot, "electron", "src", "preload.js"),
    path.join(appRoot, "preload.mjs"),
  );
  cpSync(
    path.join(compiledRoot, "electron", "src", "renderer.js"),
    path.join(appRoot, "renderer.js"),
  );
  cpSync(
    path.join(compiledRoot, "electron", "src", "electron-api.js"),
    path.join(appRoot, "electron-api.js"),
  );
  cpSync(
    path.join(compiledRoot, "electron", "src", "transcript.js"),
    path.join(appRoot, "transcript.js"),
  );
  writeFileSync(
    path.join(appRoot, "package.json"),
    JSON.stringify({
      name: "mish-electron-fixture",
      version: "0.0.0",
      type: "module",
      main: "main.js",
    }) + "\n",
  );

  const visited = new Set<string>();
  for (const dependency of [
    "@orpc/client",
    "@orpc/contract",
    "@orpc/server",
    "@orpc/tanstack-query",
    "@tanstack/query-core",
    "@tanstack/store",
    "react",
    "react-dom",
    "scheduler",
    "ws",
  ]) {
    const source = resolveInstalledPackage(dependency, pocRoot);
    if (!source) fail(`direct dependency ${dependency} is unavailable`);
    copyDependencyClosure(dependency, source, nodeModules, visited);
  }
  writeGeneratedPackage("@mish/poc-orpc", path.join(compiledRoot, "orpc", "src"), nodeModules);
  writeGeneratedPackage(
    "@mish/poc-query-store",
    path.join(compiledRoot, "query-store", "src"),
    nodeModules,
  );
  await bundleRuntime(
    path.join(appRoot, "renderer.js"),
    path.join(appRoot, "renderer.js"),
    appRoot,
    "es",
  );
  await bundleRuntime(
    path.join(appRoot, "preload.mjs"),
    path.join(appRoot, "preload.mjs"),
    appRoot,
    "cjs",
    ["electron"],
  );
  return application;
}

function assertBundle(application: string): void {
  const contents = path.join(application, "Contents");
  const executable = path.join(contents, "MacOS", "Electron");
  const appRoot = path.join(contents, "Resources", "app");
  if (!statSync(executable).isFile()) fail("Electron app executable is missing");
  if ((statSync(executable).mode & 0o111) === 0) fail("Electron app executable is not runnable");
  for (const file of ["package.json", "main.js", "preload.mjs", "renderer.js", "index.html"]) {
    assertRegularFile(path.join(appRoot, file), `app bundle ${file}`);
  }
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const current = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) fail(`app bundle contains a symlink: ${current}`);
      if (entry.isDirectory()) walk(current);
    }
  };
  walk(appRoot);
}

export async function assembleElectronFixture(options: {
  readonly archive: string;
  readonly output?: string;
}): Promise<ElectronFixturePaths> {
  if (process.platform !== "darwin") fail("DMG fixture requires macOS");
  const archive = verifyElectronArchive(options.archive);
  const root = mkdtempSync(path.join(tmpdir(), "mish-electron-admission-"));
  const extracted = path.join(root, "extracted");
  const compiled = path.join(root, "compiled");
  mkdirSync(extracted, { recursive: true, mode: 0o700 });
  execFileSync("/usr/bin/unzip", ["-q", archive.archive, "-d", extracted], { stdio: "pipe" });
  compileRuntime(compiled);
  const application = await stageApplication(path.join(extracted, "Electron.app"), compiled, root);
  assertBundle(application);
  const userData = path.join(root, "user-data");
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const dmg = options.output
    ? path.resolve(options.output)
    : path.join(root, "Mish-electron-fixture.dmg");
  createMacOsDmg(application, dmg, { replaceExistingOutput: true, normalizeForDeterminism: true });
  verifyMacOsDmgPresentation(dmg, (mountedApplication) => assertBundle(mountedApplication));
  return { root, application, dmg, userData, archive };
}

export function launchAndQuitElectronFixture(
  application: string,
  userData: string,
  timeoutMs = 30_000,
): { readonly exitCode: number; readonly output: string } {
  const executable = path.join(application, "Contents", "MacOS", "Electron");
  const appRoot = path.join(application, "Contents", "Resources", "app");
  const result = spawnSync(executable, [appRoot, "--disable-gpu", `--user-data-dir=${userData}`], {
    cwd: appRoot,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: "",
      MISH_ELECTRON_FIXTURE: "1",
    },
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 2 * 1024 * 1024,
  });
  if (result.error) throw result.error;
  return {
    exitCode: result.status ?? 1,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

export function launchMountedDmgAndQuit(fixture: ElectronFixturePaths): {
  readonly exitCode: number;
  readonly output: string;
} {
  let launch: { readonly exitCode: number; readonly output: string } | undefined;
  verifyMacOsDmgPresentation(fixture.dmg, (mountedApplication) => {
    launch = launchAndQuitElectronFixture(mountedApplication, fixture.userData);
  });
  if (!launch) fail("read-only DMG verification did not expose Mish.app");
  return launch;
}

export function verifyTranscript(output: string): void {
  const line = output
    .split("\n")
    .find((candidate) => candidate.startsWith("MISH_ELECTRON_TRANSCRIPT "));
  if (!line) fail("Electron did not emit a bounded transcript");
  const payload = JSON.parse(line.slice("MISH_ELECTRON_TRANSCRIPT ".length)) as {
    readonly transcript?: readonly unknown[];
    readonly metrics?: { readonly activeStreams?: number; readonly cleanupCount?: number };
    readonly security?: {
      readonly sandbox?: boolean;
      readonly contextIsolation?: boolean;
      readonly nodeIntegration?: boolean;
    };
  };
  if (!Array.isArray(payload.transcript) || payload.transcript.length > 128) {
    fail("Electron transcript is missing or unbounded");
  }
  if (payload.metrics?.activeStreams !== 0 || (payload.metrics?.cleanupCount ?? 0) < 1) {
    fail("Electron Event Iterator cleanup was not observed");
  }
  const operations = new Set(
    payload.transcript.flatMap((event) => {
      if (!event || typeof event !== "object") return [];
      const operation = (event as { readonly operation?: unknown }).operation;
      return typeof operation === "string" ? [operation] : [];
    }),
  );
  for (const required of ["orpc.handshake", "orpc.invoke", "orpc.events", "renderer.store"]) {
    if (!operations.has(required)) fail(`Electron transcript is missing ${required}`);
  }
  if (
    payload.security?.sandbox !== true ||
    payload.security.contextIsolation !== true ||
    payload.security.nodeIntegration !== false
  ) {
    fail("Electron BrowserWindow security contract was not observed");
  }
  const serialized = JSON.stringify(payload);
  if (serialized.includes("fixture-token") || serialized.includes("authToken")) {
    fail("Electron transcript contains authentication material");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const archiveFlag = process.argv.indexOf("--archive");
  const archive =
    archiveFlag >= 0 ? process.argv[archiveFlag + 1] : process.env.MISH_ELECTRON_ARCHIVE;
  if (!archive) fail("explicit --archive or MISH_ELECTRON_ARCHIVE is required");
  const fixture = await assembleElectronFixture({ archive });
  const launch = launchAndQuitElectronFixture(fixture.application, fixture.userData);
  verifyTranscript(launch.output);
  if (launch.exitCode !== 0) fail(`Electron exited with code ${launch.exitCode}`);
  console.log(JSON.stringify({ dmg: fixture.dmg, archive: fixture.archive, launch: "clean" }));
}
