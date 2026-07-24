import { execFileSync, spawnSync } from "node:child_process";
import { accessSync, constants, lstatSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as wait } from "node:timers/promises";

const APP_ID = "com.asuka109.mish";
const APP_NAME = "Mish";

export type MacOsAppCleanupInspection = {
  blockers: string[];
  existingTargets: string[];
  mountedMishImages: number;
};

export type ManagedMishProcess = {
  command: string;
  kind: "core" | "desktop";
  parentPid: number;
  pid: number;
};

export type MacOsAppCleanupAction =
  | "all"
  | "clean"
  | "force-stop"
  | "inspect"
  | "reset-proxy"
  | "stop";

type InspectOptions = {
  homeDirectory: string;
  mountedImages?: string;
  processTable: string;
  proxyState: string;
  systemApplicationsDirectory?: string;
};

type CommandResult = {
  status: number | null;
  stderr?: Buffer | string | null;
};

type CleanupRunner = (executable: string, arguments_: string[]) => CommandResult;

function knownTargets(homeDirectory: string, systemApplicationsDirectory: string): string[] {
  const library = path.join(homeDirectory, "Library");
  return [
    path.join(systemApplicationsDirectory, "Mish.app"),
    path.join(homeDirectory, "Applications/Mish.app"),
    path.join(library, "Application Support", APP_ID),
    path.join(library, "Application Support", "mish-desktop"),
    path.join(library, "Caches", APP_ID),
    path.join(library, "Caches", "mish-desktop"),
    path.join(library, "HTTPStorages", APP_ID),
    path.join(library, "HTTPStorages", `${APP_ID}.binarycookies`),
    path.join(library, "HTTPStorages", "mish-desktop"),
    path.join(library, "HTTPStorages", "mish-desktop.binarycookies"),
    path.join(library, "WebKit", APP_ID),
    path.join(library, "WebKit", "mish-desktop"),
    path.join(library, "Logs", APP_ID),
    path.join(library, "Logs", "mish-desktop"),
    path.join(library, "Preferences", `${APP_ID}.plist`),
    path.join(library, "Preferences", "mish-desktop.plist"),
    path.join(library, "Saved Application State", `${APP_ID}.savedState`),
    path.join(library, "Saved Application State", "mish-desktop.savedState"),
    path.join(library, "Cookies", `${APP_ID}.binarycookies`),
    path.join(library, "Cookies", "mish-desktop.binarycookies"),
    path.join(library, "Containers", APP_ID),
    path.join(library, "Containers", "mish-desktop"),
    path.join(library, "Application Scripts", APP_ID),
    path.join(library, "Application Scripts", "mish-desktop"),
    path.join(library, "LaunchAgents", `${APP_NAME}.plist`),
    path.join(library, "LaunchAgents", `${APP_ID}.plist`),
  ];
}

function matchingChildren(directory: string, pattern: RegExp): string[] {
  try {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => pattern.test(name))
    .map((name) => path.join(directory, name));
}

function generatedMacOsTargets(homeDirectory: string): string[] {
  const library = path.join(homeDirectory, "Library");
  return [
    ...matchingChildren(
      path.join(library, "Preferences/ByHost"),
      /^(?:com\.asuka109\.mish|mish-desktop)\.[A-Za-z0-9-]+\.plist$/u,
    ),
    ...matchingChildren(
      path.join(library, "Application Support/CrashReporter"),
      /^mish-desktop_[A-Za-z0-9-]+\.plist$/u,
    ),
    ...matchingChildren(
      path.join(library, "Logs/DiagnosticReports"),
      /^(?:Mish|mish-desktop)[_-].+\.(?:crash|diag|hang|ips|spin)$/u,
    ),
  ];
}

function pathExists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function appleScriptString(value: string): string {
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function managedMishProcesses(
  processTable: string,
  appDataRoot: string,
): ManagedMishProcess[] {
  const managedRuntime = path.join(appDataRoot, "runtime");
  const processes: ManagedMishProcess[] = [];
  for (const line of processTable.split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(.+)$/u.exec(line);
    if (!match) continue;
    const pid = Number(match[1]);
    const parentPid = Number(match[2]);
    const command = match[3];
    const kind = /(?:^|\/)mish-desktop(?:\s|$)/u.test(command)
      ? "desktop"
      : command.includes(managedRuntime) && /(?:^|\/)mihomo(?:-|\s|$)/u.test(command)
        ? "core"
        : undefined;
    if (
      kind &&
      Number.isSafeInteger(pid) &&
      pid > 1 &&
      Number.isSafeInteger(parentPid) &&
      parentPid >= 0
    ) {
      processes.push({ command, kind, parentPid, pid });
    }
  }
  return processes;
}

export function hasEnabledLoopbackSystemProxy(proxyState: string): boolean {
  const values = new Map<string, string>();
  for (const line of proxyState.split("\n")) {
    const match = /^\s*([A-Za-z0-9]+)\s*:\s*(.*?)\s*$/u.exec(line);
    if (match) values.set(match[1], match[2]);
  }
  return ["HTTP", "HTTPS", "SOCKS"].some((kind) => {
    const host = values.get(`${kind}Proxy`)?.toLowerCase();
    return (
      values.get(`${kind}Enable`) === "1" &&
      (host === "127.0.0.1" || host === "::1" || host === "localhost")
    );
  });
}

export function inspectMacOsAppCleanup(options: InspectOptions): MacOsAppCleanupInspection {
  const systemApplicationsDirectory = options.systemApplicationsDirectory ?? "/Applications";
  if (
    !path.isAbsolute(options.homeDirectory) ||
    path.parse(options.homeDirectory).root === path.resolve(options.homeDirectory) ||
    !path.isAbsolute(systemApplicationsDirectory)
  ) {
    throw new Error("Cleanup roots must be explicit bounded absolute directories");
  }
  const appDataRoot = path.join(options.homeDirectory, "Library/Application Support", APP_ID);
  const blockers: string[] = [];
  if (managedMishProcesses(options.processTable, appDataRoot).length > 0) {
    blockers.push(
      "A Mish desktop or managed Mihomo process is still running. Quit it normally before cleanup.",
    );
  }
  if (pathExists(path.join(appDataRoot, "system-proxy-journal.json"))) {
    blockers.push(
      "The System Proxy recovery journal still exists. Reopen Mish and complete its offered recovery before deleting state.",
    );
  }
  if (hasEnabledLoopbackSystemProxy(options.proxyState)) {
    blockers.push(
      "An enabled loopback System Proxy is still observable. Confirm and disable it before cleanup.",
    );
  }
  const existingTargets = [
    ...knownTargets(options.homeDirectory, systemApplicationsDirectory),
    ...generatedMacOsTargets(options.homeDirectory),
  ].filter((target, index, all) => pathExists(target) && all.indexOf(target) === index);
  const mountedMishImages = (options.mountedImages ?? "")
    .split("\n")
    .filter((line) => /^\s*\/dev\/disk\S+\s+.+\s+\/Volumes\/Mish(?: \d+)?\s*$/u.test(line)).length;
  return { blockers, existingTargets, mountedMishImages };
}

export function applyMacOsAppCleanup(
  inspection: MacOsAppCleanupInspection,
  options: {
    getUid?: () => number;
    run?: CleanupRunner;
  } = {},
): void {
  if (inspection.blockers.length > 0) {
    throw new Error("Cleanup is blocked by unresolved Mish ownership");
  }
  const run =
    options.run ??
    ((executable, arguments_) =>
      spawnSync(executable, arguments_, { encoding: "utf8", stdio: "pipe" }));
  const uid = (options.getUid ?? (() => process.getuid?.() ?? -1))();
  if (uid < 0) throw new Error("Could not resolve the current macOS user");

  for (const target of inspection.existingTargets.filter((candidate) =>
    candidate.endsWith(".plist"),
  )) {
    if (!target.includes(`${path.sep}Library${path.sep}LaunchAgents${path.sep}`)) continue;
    const label = path.basename(target, ".plist");
    const bootout = run("/bin/launchctl", ["bootout", `gui/${uid}`, target]);
    if (bootout.status !== 0 && bootout.status !== 5) {
      throw new Error(`Could not unregister the Mish LaunchAgent: ${target}`);
    }
    if (run("/bin/launchctl", ["print", `gui/${uid}/${label}`]).status === 0) {
      throw new Error(`The Mish LaunchAgent is still registered: ${target}`);
    }
  }
  for (const target of inspection.existingTargets) {
    const result = run("/usr/bin/trash", ["--stopOnError", target]);
    if (result.status !== 0) {
      throw new Error(`Could not move Mish state to the Trash: ${target}`);
    }
  }
}

type ProcessControlOptions = {
  appDataRoot: string;
  installedDesktopExecutables: string[];
  pause?: (milliseconds: number) => Promise<unknown>;
  readProcessTable: () => string;
  run: CleanupRunner;
};

function controllableInstalledProcesses(
  processTable: string,
  options: Pick<ProcessControlOptions, "appDataRoot" | "installedDesktopExecutables">,
): ManagedMishProcess[] {
  const processes = managedMishProcesses(processTable, options.appDataRoot);
  const installedDesktops = processes.filter(
    ({ command, kind }) =>
      kind === "desktop" &&
      options.installedDesktopExecutables.some(
        (executable) => command === executable || command.startsWith(`${executable} `),
      ),
  );
  const desktopPids = new Set(installedDesktops.map(({ pid }) => pid));
  return [
    ...installedDesktops,
    ...processes.filter(({ kind, parentPid }) => kind === "core" && desktopPids.has(parentPid)),
  ];
}

async function waitForOwnedProcesses(
  options: ProcessControlOptions,
  ownedProcesses: ManagedMishProcess[],
  maximumMilliseconds: number,
): Promise<ManagedMishProcess[]> {
  const pause = options.pause ?? wait;
  for (let elapsed = 0; elapsed < maximumMilliseconds; elapsed += 250) {
    const current = managedMishProcesses(options.readProcessTable(), options.appDataRoot);
    const processes = ownedProcesses.filter((owned) =>
      current.some(
        ({ command, kind, pid }) =>
          pid === owned.pid && kind === owned.kind && command === owned.command,
      ),
    );
    if (processes.length === 0) return [];
    await pause(250);
  }
  const current = managedMishProcesses(options.readProcessTable(), options.appDataRoot);
  return ownedProcesses.filter((owned) =>
    current.some(
      ({ command, kind, pid }) =>
        pid === owned.pid && kind === owned.kind && command === owned.command,
    ),
  );
}

export async function safelyStopMish(options: ProcessControlOptions): Promise<void> {
  const processTable = options.readProcessTable();
  const allProcesses = managedMishProcesses(processTable, options.appDataRoot);
  if (allProcesses.length === 0) return;
  const processes = controllableInstalledProcesses(processTable, options);
  const desktops = processes.filter(({ kind }) => kind === "desktop");
  if (desktops.length === 0) {
    throw new Error("No running installed Mish instance can be safely controlled");
  }
  for (const desktop of desktops) {
    const executable = options.installedDesktopExecutables.find(
      (candidate) => desktop.command === candidate || desktop.command.startsWith(`${candidate} `),
    );
    if (!executable) throw new Error("The installed Mish executable identity changed");
    const applicationPath = path.dirname(path.dirname(path.dirname(executable)));
    const result = options.run("/usr/bin/osascript", [
      "-e",
      `tell application ${appleScriptString(applicationPath)} to quit`,
    ]);
    if (result.status !== 0) {
      throw new Error("Installed Mish did not accept the application-level Quit request");
    }
  }
  if ((await waitForOwnedProcesses(options, processes, 15_000)).length > 0) {
    throw new Error("Installed Mish did not complete its safe shutdown within 15 seconds");
  }
}

export async function forceStopMish(options: ProcessControlOptions): Promise<void> {
  const processTable = options.readProcessTable();
  const allProcesses = managedMishProcesses(processTable, options.appDataRoot);
  if (allProcesses.length === 0) return;
  const processes = controllableInstalledProcesses(processTable, options);
  if (processes.length === 0) {
    throw new Error("No running installed Mish instance has process ownership authority");
  }
  for (const process of processes) {
    const { pid } = process;
    const stillOwned = managedMishProcesses(options.readProcessTable(), options.appDataRoot).some(
      (candidate) =>
        candidate.pid === pid &&
        candidate.kind === process.kind &&
        candidate.command === process.command,
    );
    if (!stillOwned) continue;
    const result = options.run("/bin/kill", ["-TERM", String(pid)]);
    if (result.status !== 0) throw new Error(`Could not send TERM to owned Mish PID ${pid}`);
  }
  const remaining = await waitForOwnedProcesses(options, processes, 3_000);
  for (const process of remaining) {
    const { pid } = process;
    const stillOwned = managedMishProcesses(options.readProcessTable(), options.appDataRoot).some(
      (candidate) =>
        candidate.pid === pid &&
        candidate.kind === process.kind &&
        candidate.command === process.command,
    );
    if (!stillOwned) continue;
    const result = options.run("/bin/kill", ["-KILL", String(pid)]);
    if (result.status !== 0) throw new Error(`Could not send KILL to owned Mish PID ${pid}`);
  }
  if ((await waitForOwnedProcesses(options, processes, 3_000)).length > 0) {
    throw new Error("Owned Mish processes remain after the bounded force-stop sequence");
  }
}

export function parseMacOsAppCleanupArguments(arguments_: string[]): {
  action: MacOsAppCleanupAction;
  apply: boolean;
} {
  const normalized = arguments_.filter((argument) => argument !== "--");
  const apply = normalized.includes("--apply");
  const positional = normalized.filter((argument) => argument !== "--apply");
  const action = positional[0] ?? "inspect";
  const actions: MacOsAppCleanupAction[] = [
    "inspect",
    "stop",
    "force-stop",
    "reset-proxy",
    "clean",
    "all",
  ];
  if (
    positional.length > 1 ||
    !actions.includes(action as MacOsAppCleanupAction) ||
    (action === "inspect" && apply)
  ) {
    throw new Error(
      "Usage: pnpm macos:app:clean -- <inspect|stop|force-stop|reset-proxy|clean|all> [--apply]",
    );
  }
  return { action: action as MacOsAppCleanupAction, apply };
}

function resolveCargo(homeDirectory: string): string {
  const candidates = [
    process.env.CARGO,
    path.join(homeDirectory, ".cargo/bin/cargo"),
    "/opt/homebrew/bin/cargo",
    "/usr/local/bin/cargo",
  ].filter((candidate): candidate is string => Boolean(candidate && path.isAbsolute(candidate)));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  throw new Error("A trusted Cargo executable is required for exact System Proxy restoration");
}

function managedProxyPort(settingsPath: string): number {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(settingsPath, "utf8"));
  } catch {
    throw new Error("Mish settings are required to identify the journaled proxy endpoint");
  }
  const port = (
    value as {
      preferences?: { managedPorts?: { proxy?: unknown } };
    }
  ).preferences?.managedPorts?.proxy;
  if (!Number.isInteger(port) || Number(port) < 1 || Number(port) > 65_535) {
    throw new Error("The managed proxy port is unavailable in Mish settings");
  }
  return Number(port);
}

export function restoreOwnedSystemProxy(
  homeDirectory: string,
  appDataRoot: string,
  run: CleanupRunner,
  cargoExecutable?: string,
): void {
  const journal = path.join(appDataRoot, "system-proxy-journal.json");
  if (!pathExists(journal)) return;
  const port = managedProxyPort(path.join(appDataRoot, "settings.json"));
  const result = run(cargoExecutable ?? resolveCargo(homeDirectory), [
    "run",
    "--quiet",
    "-p",
    "mish-platform-macos",
    "--bin",
    "mish-macos-proxy-reset",
    "--",
    journal,
    String(port),
  ]);
  if (result.status !== 0 || pathExists(journal)) {
    throw new Error("The journaled System Proxy state could not be restored exactly");
  }
}

function readCommand(executable: string, arguments_: string[]): string {
  try {
    return execFileSync(executable, arguments_, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return "";
  }
}

function readRequiredCommand(executable: string, arguments_: string[]): string {
  return execFileSync(executable, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

export async function runMacOsAppCleanup(
  arguments_: string[] = process.argv.slice(2),
): Promise<void> {
  if (process.platform !== "darwin") {
    throw new Error("The Mish application cleanup is available only on macOS");
  }
  const { action, apply } = parseMacOsAppCleanupArguments(arguments_);
  const homeDirectory = os.homedir();
  const appDataRoot = path.join(homeDirectory, "Library/Application Support", APP_ID);
  const readProcessTable = () => readRequiredCommand("/bin/ps", ["-axo", "pid=,ppid=,command="]);
  const run: CleanupRunner = (executable, commandArguments) =>
    spawnSync(executable, commandArguments, { encoding: "utf8", stdio: "pipe" });
  const inspect = () =>
    inspectMacOsAppCleanup({
      homeDirectory,
      mountedImages: readCommand("/usr/bin/hdiutil", ["info"]),
      processTable: readProcessTable(),
      proxyState: readRequiredCommand("/usr/sbin/scutil", ["--proxy"]),
    });
  const printInspection = (inspection: MacOsAppCleanupInspection) => {
    console.log(`Mish macOS application state (${action}${apply ? ", apply" : ", preview"}):`);
    if (inspection.existingTargets.length === 0) {
      console.log("- No account-local Mish application or state targets were found.");
    } else {
      for (const target of inspection.existingTargets) console.log(`- ${target}`);
    }
    if (inspection.mountedMishImages > 0) {
      console.log(
        `- Left ${inspection.mountedMishImages} mounted Mish disk image(s) untouched; this script never detaches images from other worktrees.`,
      );
    }
  };

  let inspection = inspect();
  printInspection(inspection);
  if (action === "inspect") {
    for (const blocker of inspection.blockers) console.error(`BLOCKED: ${blocker}`);
    return;
  }
  if (!apply) {
    console.log(
      `Preview only. Re-run with \`pnpm macos:app:clean -- ${action} --apply\` to execute this subcommand.`,
    );
    return;
  }
  const processControl: ProcessControlOptions = {
    appDataRoot,
    installedDesktopExecutables: [
      "/Applications/Mish.app/Contents/MacOS/mish-desktop",
      path.join(homeDirectory, "Applications/Mish.app/Contents/MacOS/mish-desktop"),
    ],
    readProcessTable,
    run,
  };
  if (action === "stop") {
    await safelyStopMish(processControl);
    if (pathExists(path.join(appDataRoot, "system-proxy-journal.json"))) {
      throw new Error("Mish exited but its System Proxy recovery journal still requires attention");
    }
    console.log("Mish completed the application-level safe shutdown.");
    return;
  }
  if (action === "force-stop") {
    await forceStopMish(processControl);
    console.log(
      "Owned Mish processes were force-stopped. Run reset-proxy before deleting application state.",
    );
    return;
  }
  if (action === "reset-proxy") {
    if (managedMishProcesses(readProcessTable(), appDataRoot).length > 0) {
      throw new Error("Stop Mish and its managed Core before restoring System Proxy");
    }
    const ownedJournal = pathExists(path.join(appDataRoot, "system-proxy-journal.json"));
    restoreOwnedSystemProxy(homeDirectory, appDataRoot, run);
    if (
      !ownedJournal &&
      hasEnabledLoopbackSystemProxy(readRequiredCommand("/usr/sbin/scutil", ["--proxy"]))
    ) {
      throw new Error(
        "A loopback System Proxy exists without Mish recovery authority and was left unchanged",
      );
    }
    console.log(
      ownedJournal
        ? "The journaled pre-Mish System Proxy configuration was restored exactly."
        : "No Mish-owned System Proxy transaction required restoration.",
    );
    return;
  }
  if (action === "all") {
    try {
      await safelyStopMish(processControl);
    } catch (error) {
      console.error(
        `${error instanceof Error ? error.message : "Safe shutdown failed"}; entering the explicit force-stop fallback.`,
      );
      await forceStopMish(processControl);
    }
    if (managedMishProcesses(readProcessTable(), appDataRoot).length > 0) {
      throw new Error(
        "Another Mish instance still owns the shared runtime; System Proxy and application state were left unchanged",
      );
    }
    restoreOwnedSystemProxy(homeDirectory, appDataRoot, run);
    inspection = inspect();
  }
  if (action === "clean" || action === "all") {
    if (inspection.blockers.length > 0) {
      for (const blocker of inspection.blockers) console.error(`BLOCKED: ${blocker}`);
      throw new Error("Resolve every blocker before cleaning the Mish application state");
    }
    applyMacOsAppCleanup(inspection, { run });
    console.log(
      "Cleanup complete. Listed files remain recoverable from the Trash; user-selected exports/backups, mounted DMGs, and development TUN services were intentionally left untouched.",
    );
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    await runMacOsAppCleanup();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Mish cleanup failed");
    process.exitCode = 1;
  }
}
