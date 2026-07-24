import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const APP_ID = "com.asuka109.mish";
const APP_NAME = "Mish";

export type MacOsAppCleanupInspection = {
  blockers: string[];
  existingTargets: string[];
  mountedMishImages: number;
};

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
    path.join(library, "Caches", APP_ID),
    path.join(library, "HTTPStorages", APP_ID),
    path.join(library, "HTTPStorages", `${APP_ID}.binarycookies`),
    path.join(library, "WebKit", APP_ID),
    path.join(library, "Logs", APP_ID),
    path.join(library, "Preferences", `${APP_ID}.plist`),
    path.join(library, "Saved Application State", `${APP_ID}.savedState`),
    path.join(library, "Cookies", `${APP_ID}.binarycookies`),
    path.join(library, "Containers", APP_ID),
    path.join(library, "Application Scripts", APP_ID),
    path.join(library, "LaunchAgents", `${APP_NAME}.plist`),
    path.join(library, "LaunchAgents", `${APP_ID}.plist`),
  ];
}

function byHostPreferences(homeDirectory: string): string[] {
  const directory = path.join(homeDirectory, "Library/Preferences/ByHost");
  try {
    const metadata = lstatSync(directory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return [];
  } catch {
    return [];
  }
  return readdirSync(directory)
    .filter((name) => /^com\.asuka109\.mish\.[A-Za-z0-9-]+\.plist$/u.test(name))
    .map((name) => path.join(directory, name));
}

function pathExists(candidate: string): boolean {
  try {
    lstatSync(candidate);
    return true;
  } catch {
    return false;
  }
}

function hasManagedProcess(processTable: string, appDataRoot: string): boolean {
  const managedRuntime = path.join(appDataRoot, "runtime");
  return processTable.split("\n").some((line) => {
    const command = line.trim().replace(/^\d+\s+/u, "");
    return (
      /(?:^|\/)mish-desktop(?:\s|$)/u.test(command) ||
      (command.includes(managedRuntime) && /(?:^|\/)mihomo(?:-|\s|$)/u.test(command))
    );
  });
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
  if (hasManagedProcess(options.processTable, appDataRoot)) {
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
    ...byHostPreferences(options.homeDirectory),
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

export function runMacOsAppCleanup(arguments_: string[] = process.argv.slice(2)): void {
  if (process.platform !== "darwin") {
    throw new Error("The Mish application cleanup is available only on macOS");
  }
  const normalized = arguments_.filter((argument) => argument !== "--");
  if (normalized.some((argument) => argument !== "--apply")) {
    throw new Error("Usage: pnpm macos:app:clean [-- --apply]");
  }
  const apply = normalized.includes("--apply");
  const inspection = inspectMacOsAppCleanup({
    homeDirectory: os.homedir(),
    mountedImages: readCommand("/usr/bin/hdiutil", ["info"]),
    processTable: readRequiredCommand("/bin/ps", ["-axo", "pid=,command="]),
    proxyState: readRequiredCommand("/usr/sbin/scutil", ["--proxy"]),
  });

  console.log(`Mish macOS application cleanup ${apply ? "apply" : "preview"}:`);
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
  if (inspection.blockers.length > 0) {
    for (const blocker of inspection.blockers) console.error(`BLOCKED: ${blocker}`);
    throw new Error("Resolve every blocker before cleaning the Mish application state");
  }
  if (!apply) {
    console.log(
      "Preview only. Re-run with `pnpm macos:app:clean -- --apply` to move these targets to the Trash.",
    );
    return;
  }
  applyMacOsAppCleanup(inspection);
  console.log(
    "Cleanup complete. Listed files remain recoverable from the Trash; user-selected exports/backups, mounted DMGs, and development TUN services were intentionally left untouched.",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  try {
    runMacOsAppCleanup();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Mish cleanup failed");
    process.exitCode = 1;
  }
}
