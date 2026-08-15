import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  ELECTRON_DARWIN_ARM64_SHA256,
  ELECTRON_VERSION,
  verifyElectronArchive,
  type ElectronArchiveEvidence,
} from "../src/archive.ts";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const repositoryRoot = path.resolve(packageRoot, "../..");
const distRoot = path.join(packageRoot, "dist");

interface ViteModule {
  readonly build: (options: { readonly configFile: string }) => Promise<unknown>;
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

function assertBundle(application: string): void {
  const contents = path.join(application, "Contents");
  const executable = path.join(contents, "MacOS", "Electron");
  const appRoot = path.join(contents, "Resources", "app");
  if (!statSync(executable).isFile() || (statSync(executable).mode & 0o111) === 0) {
    fail("Electron app executable is missing or not runnable");
  }
  for (const file of ["package.json", "main.mjs", "preload.mjs", "renderer.mjs", "index.html"]) {
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

async function buildDesktop(): Promise<void> {
  const packageRequire = createRequire(path.join(packageRoot, "package.json"));
  const viteEntry = packageRequire.resolve("vite");
  const vite = (await import(pathToFileURL(viteEntry).href)) as ViteModule;
  await vite.build({ configFile: path.join(packageRoot, "vite.config.ts") });
  await vite.build({ configFile: path.join(packageRoot, "vite.preload.config.ts") });
}

async function stageApplication(
  extractedElectronApp: string,
  fixtureRoot: string,
): Promise<string> {
  const application = path.join(fixtureRoot, "Mish.app");
  execFileSync("/usr/bin/ditto", [extractedElectronApp, application], { stdio: "pipe" });
  const appRoot = path.join(application, "Contents", "Resources", "app");
  mkdirSync(appRoot, { recursive: true, mode: 0o755 });
  for (const entry of readdirSync(distRoot, { withFileTypes: true })) {
    cpSync(path.join(distRoot, entry.name), path.join(appRoot, entry.name), {
      recursive: true,
      dereference: true,
      force: true,
    });
  }
  writeFileSync(
    path.join(appRoot, "package.json"),
    `${JSON.stringify({
      name: "mish-electron-fixture",
      version: "0.0.0",
      type: "module",
      main: "main.mjs",
    })}\n`,
    { mode: 0o644 },
  );
  assertBundle(application);
  return application;
}

async function dmgTools(): Promise<{
  readonly createMacOsDmg: (
    application: string,
    output: string,
    options: {
      readonly replaceExistingOutput?: boolean;
      readonly normalizeForDeterminism?: boolean;
    },
  ) => void;
  readonly verifyMacOsDmgPresentation: (
    dmg: string,
    verifyApplication?: (application: string) => void,
  ) => void;
}> {
  if (process.platform !== "darwin") fail("DMG fixture requires macOS");
  process.chdir(repositoryRoot);
  const tools = (await import(
    pathToFileURL(path.join(repositoryRoot, "scripts/macos-dmg-presentation.ts")).href
  )) as {
    readonly createMacOsDmg: (
      application: string,
      output: string,
      options: {
        readonly replaceExistingOutput?: boolean;
        readonly normalizeForDeterminism?: boolean;
      },
    ) => void;
    readonly verifyMacOsDmgPresentation: (
      dmg: string,
      verifyApplication?: (application: string) => void,
    ) => void;
  };
  return tools;
}

export async function assembleElectronFixture(options: {
  readonly archive: string;
  readonly output?: string;
}): Promise<ElectronFixturePaths> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    fail("the isolated DMG fixture is restricted to macOS arm64");
  }
  const archive = verifyElectronArchive(options.archive);
  if (!existsSync(path.join(distRoot, "main.mjs"))) await buildDesktop();
  const root = mkdtempSync(path.join(tmpdir(), "mish-electron-admission-"));
  const extracted = path.join(root, "extracted");
  mkdirSync(extracted, { recursive: true, mode: 0o700 });
  execFileSync("/usr/bin/unzip", ["-q", archive.archive, "-d", extracted], { stdio: "pipe" });
  const application = await stageApplication(path.join(extracted, "Electron.app"), root);
  const userData = path.join(root, "user-data");
  mkdirSync(userData, { recursive: true, mode: 0o700 });
  const dmg = options.output
    ? path.resolve(options.output)
    : path.join(root, "Mish-electron-fixture.dmg");
  const { createMacOsDmg, verifyMacOsDmgPresentation } = await dmgTools();
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
let childExited = false;
let childExitCode = null;
let childExitSignal = null;
let deadline;
let grace;
let killDeadline;

function append(chunk) {
  if (output.length >= maxOutput) return;
  output += String(chunk).slice(0, maxOutput - output.length);
}

function ownedProcessGroup(signal) {
  if (!child?.pid || !Number.isSafeInteger(child.pid) || child.pid <= 0) return;
  try {
    process.kill(child.pid, 0);
    process.kill(-child.pid, signal);
  } catch {
    // The child exited or its owned process group was already reaped.
  }
}

const result = await new Promise((resolve) => {
  child = spawn(executable, [appRoot, "--disable-gpu", "--user-data-dir=" + userData], {
    cwd: appRoot,
    detached: true,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "", MISH_ELECTRON_FIXTURE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", append);
  child.stderr.on("data", append);
  append("MISH_ELECTRON_LAUNCHER spawned pid=" + String(child.pid) + "\n");
  const finish = (value) => {
    if (settled) return;
    settled = true;
    clearTimeout(deadline);
    clearTimeout(grace);
    clearTimeout(killDeadline);
    resolve(value);
  };
  child.on("error", (error) => {
    append("MISH_ELECTRON_LAUNCHER error=" + (error.code ?? error.message) + "\n");
    finish({ status: "error", code: error.code ?? "spawn" });
  });
  child.on("exit", (code, signal) => {
    childExited = true;
    childExitCode = code;
    childExitSignal = signal;
    append("MISH_ELECTRON_LAUNCHER exit code=" + String(code) + " signal=" + String(signal) + "\n");
    if (!timedOut) {
      setTimeout(() => finish({ status: "exited", exitCode: childExitCode ?? 1, signal: childExitSignal, output }), 250);
    }
  });
  child.on("close", (code, signal) => {
    if (!childExited) {
      childExited = true;
      childExitCode = code;
      childExitSignal = signal;
    }
    finish({ status: timedOut ? "timeout" : "exited", exitCode: childExitCode ?? 1, signal: childExitSignal, output });
  });
  deadline = setTimeout(() => {
    grace = setTimeout(() => {
      if (childExited && childExitCode === 0) {
        finish({ status: "exited", exitCode: childExitCode, signal: childExitSignal, output });
        return;
      }
      append("MISH_ELECTRON_LAUNCHER deadline=" + timeoutMs + "ms\n");
      timedOut = true;
      ownedProcessGroup("SIGTERM");
      killDeadline = setTimeout(() => ownedProcessGroup("SIGKILL"), 1_500);
    }, 500);
  }, timeoutMs);
});

console.log(JSON.stringify(result));
`;

function boundedOutput(output: string): string {
  const limit = 8 * 1024;
  return output.length <= limit ? output : `${output.slice(0, limit)}\n[truncated]`;
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
    throw new Error(
      `Electron launcher failed: ${result.error.message}\n${boundedOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`)}`,
    );
  }
  let launch: {
    readonly status: string;
    readonly code?: string;
    readonly exitCode?: number;
    readonly output?: string;
  };
  try {
    launch = JSON.parse(String(result.stdout ?? "").trim()) as typeof launch;
  } catch {
    throw new Error(
      `Electron launcher emitted invalid result\n${boundedOutput(String(result.stdout ?? ""))}`,
    );
  }
  if (launch.status === "timeout")
    fail(
      `Electron launch deadline exceeded after ${timeoutMs}ms\n${boundedOutput(launch.output ?? "")}`,
    );
  if (launch.status === "error") fail(`Electron launcher failed: ${launch.code ?? "spawn"}`);
  return { exitCode: launch.exitCode ?? 1, output: launch.output ?? "" };
}

export async function launchMountedDmgAndQuit(
  fixture: ElectronFixturePaths,
  userData = fixture.userData,
): Promise<{ readonly exitCode: number; readonly output: string }> {
  const { verifyMacOsDmgPresentation } = await dmgTools();
  let launch: { readonly exitCode: number; readonly output: string } | undefined;
  verifyMacOsDmgPresentation(fixture.dmg, (mountedApplication) => {
    launch = launchAndQuitElectronFixture(mountedApplication, userData);
  });
  if (!launch) fail("read-only DMG verification did not expose Mish.app");
  return launch;
}

export function verifyTranscript(output: string): void {
  const line = output
    .split("\n")
    .find((candidate) => candidate.startsWith("MISH_ELECTRON_TRANSCRIPT "));
  if (!line) fail(`Electron did not emit a bounded transcript\n${boundedOutput(output)}`);
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
  if (!Array.isArray(payload.transcript) || payload.transcript.length > 128)
    fail("Electron transcript is missing or unbounded");
  if (payload.metrics?.activeStreams !== 0 || (payload.metrics.cleanupCount ?? 0) < 1)
    fail("Event Iterator cleanup was not observed");
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
    payload.security.nodeIntegration !== false ||
    payload.stage !== "quit"
  ) {
    fail("Electron security or clean-quit evidence is missing");
  }
  const serialized = JSON.stringify(payload);
  if (serialized.includes("fixture-token") || serialized.includes("authToken"))
    fail("transcript contains authentication material");
}

export function cleanupElectronFixture(root: string): void {
  if (!existsSync(root)) return;
  execFileSync("trash", [root], { stdio: "ignore" });
}

async function main(): Promise<void> {
  const archiveFlag = process.argv.indexOf("--archive");
  const archive =
    archiveFlag >= 0 ? process.argv[archiveFlag + 1] : process.env.MISH_ELECTRON_ARCHIVE;
  if (process.argv.includes("--build")) {
    await buildDesktop();
    for (const file of ["index.html", "index.mjs", "main.mjs", "preload.mjs", "renderer.mjs"]) {
      assertRegularFile(path.join(distRoot, file), `Electron build output ${file}`);
    }
    console.log(JSON.stringify({ electron: ELECTRON_VERSION, build: "bounded", network: "none" }));
    return;
  }
  if (!archive) fail("explicit --archive or MISH_ELECTRON_ARCHIVE is required");
  const fixture = await assembleElectronFixture({ archive });
  try {
    const runs = [];
    for (let index = 0; index < 2; index += 1) {
      const userData = path.join(fixture.root, `user-data-${index + 1}`);
      mkdirSync(userData, { recursive: true, mode: 0o700 });
      // Runs stay sequential so the mounted volume and owned process group
      // from one acceptance run are fully cleaned before the next begins.
      // oxlint-disable-next-line no-await-in-loop
      const launch = await launchMountedDmgAndQuit(fixture, userData);
      if (launch.exitCode !== 0) fail(`Electron exited with code ${launch.exitCode}`);
      verifyTranscript(launch.output);
      runs.push({ run: index + 1, exitCode: launch.exitCode, transcript: "valid" });
    }
    console.log(JSON.stringify({ archive: fixture.archive, dmg: fixture.dmg, runs }));
  } finally {
    cleanupElectronFixture(fixture.root);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}

export { ELECTRON_DARWIN_ARM64_SHA256, verifyElectronArchive };
