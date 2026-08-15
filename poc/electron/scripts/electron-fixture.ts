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
import { createRequire } from "node:module";
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

function packageRootFromEntry(entry: string, expectedName: string): string | undefined {
  let directory = path.dirname(entry);
  while (directory !== path.dirname(directory)) {
    const manifest = path.join(directory, "package.json");
    try {
      const metadata = JSON.parse(readFileSync(manifest, "utf8")) as { readonly name?: unknown };
      if (metadata.name === expectedName) return directory;
    } catch {
      // Continue to the next parent while resolving through a normal package graph.
    }
    directory = path.dirname(directory);
  }
  return undefined;
}

function resolveInstalledPackage(name: string, fromDirectory: string): string | undefined {
  try {
    const require = createRequire(path.join(fromDirectory, "package.json"));
    const entry = require.resolve(name);
    return packageRootFromEntry(entry, name);
  } catch {
    // Some declared runtime dependencies are type-only packages without an
    // exportable entry point. Resolve their direct node_modules entry without
    // inspecting package-manager internals or selecting a version by prefix.
    let directory = fromDirectory;
    while (directory !== path.dirname(directory)) {
      const candidate = path.join(directory, "node_modules", name);
      try {
        const metadata = lstatSync(candidate);
        if (metadata.isDirectory() || metadata.isSymbolicLink()) {
          const resolved = realpathSync(candidate);
          const manifest = JSON.parse(
            readFileSync(path.join(resolved, "package.json"), "utf8"),
          ) as { readonly name?: unknown };
          if (manifest.name === name) return resolved;
        }
      } catch {
        // Continue with Node's next normal ancestor lookup.
      }
      directory = path.dirname(directory);
    }
    return undefined;
  }
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

function copyDeclaredDependencies(
  packageDirectory: string,
  destinationNodeModules: string,
  visited: Set<string>,
): void {
  const metadata = packageJson(packageDirectory);
  const dependencies = {
    ...metadata.dependencies,
    ...metadata.optionalDependencies,
    ...metadata.peerDependencies,
  };
  for (const dependencyName of Object.keys(dependencies)) {
    // Workspace packages are generated from the compiled source below.
    if (dependencyName === "electron" || dependencyName.startsWith("@mish/")) continue;
    const source = resolveInstalledPackage(dependencyName, packageDirectory);
    if (!source) {
      if (
        metadata.optionalDependencies?.[dependencyName] !== undefined ||
        metadata.peerDependencies?.[dependencyName] !== undefined
      ) {
        continue;
      }
      fail(`declared dependency ${dependencyName} for ${metadata.name} is unavailable`);
    }
    copyDependencyClosure(dependencyName, source, destinationNodeModules, visited);
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
  const packageRequire = createRequire(path.join(packageRoot, "package.json"));
  let viteDirectory: string | undefined;
  let viteEntry: string | undefined;
  try {
    // Vite is the normal peer of the package's declared Vitest dev dependency.
    // Resolve both through Node's package graph; never scan pnpm internals.
    const vitestEntry = packageRequire.resolve("vitest");
    viteEntry = createRequire(vitestEntry).resolve("vite");
    viteDirectory = packageRootFromEntry(viteEntry, "vite");
  } catch {
    viteDirectory = undefined;
  }
  if (!viteDirectory) {
    fail("the frozen workspace Vite bundler is unavailable; refusing to use a global package");
  }
  if (!viteEntry) fail("the frozen workspace Vite entry is unavailable");
  const vite = (await import(pathToFileURL(viteEntry).href)) as ViteBuildModule;
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
  for (const packageDirectory of [
    packageRoot,
    path.join(pocRoot, "orpc"),
    path.join(pocRoot, "query-store"),
  ]) {
    copyDeclaredDependencies(packageDirectory, nodeModules, visited);
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

const ELECTRON_LAUNCHER_SOURCE = String.raw`
import { spawn } from "node:child_process";

const [executable, appRoot, userData, timeoutText] = process.argv.slice(1);
const timeoutMs = Number(timeoutText);
const maxOutput = 2 * 1024 * 1024;
let output = "";
let child;
let settled = false;
let timedOut = false;
let deadline;
let killDeadline;

function append(chunk) {
  if (output.length >= maxOutput) return;
  output += String(chunk).slice(0, maxOutput - output.length);
}

function killGroup(signal) {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    // The child already exited or the process group was reaped.
  }
}

const result = await new Promise((resolve) => {
  child = spawn(
    executable,
    [appRoot, "--disable-gpu", "--user-data-dir=" + userData],
    {
      cwd: appRoot,
      detached: true,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MISH_ELECTRON_FIXTURE: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearTimeout(killDeadline);
    resolve(value);
  };
  child.on("error", (error) => finish({ status: "error", code: error.code ?? "spawn" }));
  child.on("close", (code, signal) => {
    finish({
      status: timedOut ? "timeout" : "exited",
      exitCode: code ?? 1,
      signal: signal ?? null,
      output,
    });
  });
  deadline = setTimeout(() => {
    timedOut = true;
    append("MISH_ELECTRON_LAUNCHER deadline=" + timeoutMs + "ms\n");
    killGroup("SIGTERM");
    killDeadline = setTimeout(() => killGroup("SIGKILL"), 1_500);
  }, timeoutMs);
});

console.log(JSON.stringify(result));
`;

function boundedLaunchOutput(output: string): string {
  const limit = 8 * 1024;
  if (output.length <= limit) return output;
  return `${output.slice(0, limit)}\n[truncated]`;
}

export function launchAndQuitElectronFixture(
  application: string,
  userData: string,
  timeoutMs = 30_000,
): { readonly exitCode: number; readonly output: string } {
  const executable = path.join(application, "Contents", "MacOS", "Electron");
  const appRoot = path.join(application, "Contents", "Resources", "app");
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      ELECTRON_LAUNCHER_SOURCE,
      executable,
      appRoot,
      userData,
      String(timeoutMs),
    ],
    {
      cwd: appRoot,
      env: process.env,
      encoding: "utf8",
      timeout: timeoutMs + 5_000,
      maxBuffer: 2 * 1024 * 1024,
    },
  );
  if (result.error) {
    const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
    throw new Error(
      `Electron launcher failed: ${result.error.code ?? result.error.message}\n${boundedLaunchOutput(output)}`,
    );
  }
  const launcherOutput = `${result.stdout ?? ""}`.trim();
  let launch: {
    readonly status: "error" | "exited" | "timeout";
    readonly code?: string;
    readonly exitCode?: number;
    readonly signal?: string | null;
    readonly output?: string;
  };
  try {
    launch = JSON.parse(launcherOutput) as typeof launch;
  } catch {
    throw new Error(
      `Electron launcher emitted invalid result\n${boundedLaunchOutput(launcherOutput)}`,
    );
  }
  if (launch.status === "timeout") {
    throw new Error(
      `Electron launch deadline exceeded after ${timeoutMs}ms\n${boundedLaunchOutput(launch.output ?? "")}`,
    );
  }
  if (launch.status === "error") {
    throw new Error(`Electron launcher failed: ${launch.code ?? "spawn"}`);
  }
  return {
    exitCode: launch.exitCode ?? 1,
    output: launch.output ?? "",
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
    readonly stage?: string;
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
  if (payload.stage !== "quit") fail("Electron did not reach the clean quit stage");
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
