import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { access, chmod, constants, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { accessSync, constants as syncConstants, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

type MacOsMihomoRelease = {
  archiveSha256: string;
  asset: string;
  binarySha256: string;
  repository: string;
  schemaVersion: 1;
  version: string;
};

type InstallerFailureKind =
  | "authorization-cancelled"
  | "installation-failed"
  | "preparation-failed";

type InstallerResult =
  | {
      ok: true;
      service?: "installed" | "not-installed";
      stage: "completed" | "prepared" | "status";
    }
  | { code: string; kind: InstallerFailureKind; ok: false; stage: string };

class InstallerFailure extends Error {
  readonly code: string;
  readonly kind: InstallerFailureKind;
  readonly stage: string;

  constructor(kind: InstallerFailureKind, stage: string, code: string) {
    super(`${stage}: ${code}`);
    this.code = code;
    this.kind = kind;
    this.stage = stage;
  }
}

const label = "com.asuka109.mish.tun-helper.dev";
const helperTarget = `/Library/PrivilegedHelperTools/${label}`;
const helperDirectory = path.dirname(helperTarget);
const coreTarget = "/Library/PrivilegedHelperTools/com.asuka109.mish.mihomo.dev";
const plistTarget = `/Library/LaunchDaemons/${label}.plist`;
const releaseManifestPath = path.resolve("resources/mihomo/macos-arm64.json");
const runtimeRoot = path.join(
  os.homedir(),
  "Library/Application Support/com.asuka109.mish/runtime",
);
const installerRoot = path.join(runtimeRoot, "tun-service-installer");
const plist = path.join(installerRoot, `${label}.plist`);
const resultReceipt = path.join(installerRoot, "last-result.json");

type ToolchainEnvironment = Record<string, string | undefined>;

export type ToolchainDiscovery = {
  cargo: string;
  rustup: string;
};

export type ToolchainDiscoveryOptions = {
  environment?: ToolchainEnvironment;
  homeDirectory?: string;
  execute?: (executable: string, args: string[], environment: ToolchainEnvironment) => string;
  isExecutable?: (candidate: string) => boolean;
};

const action = process.argv[2];

function installerEnvironment(environment: ToolchainEnvironment): ToolchainEnvironment {
  const allowed = ["HOME", "PATH", "CARGO_HOME", "RUSTUP_HOME", "TMPDIR"] as const;
  return Object.fromEntries(
    allowed.flatMap((name) => {
      const value = environment[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function executableFile(candidate: string) {
  try {
    return (
      path.isAbsolute(candidate) &&
      statSync(candidate).isFile() &&
      (() => {
        accessSync(candidate, syncConstants.X_OK);
        return true;
      })()
    );
  } catch {
    return false;
  }
}

function rustupCandidates(environment: ToolchainEnvironment, homeDirectory: string) {
  const candidates: Array<{ path: string }> = [];
  const injected = environment.MISH_TUN_RUSTUP;
  if (injected !== undefined) candidates.push({ path: injected });

  const cargoHome = environment.CARGO_HOME;
  if (cargoHome !== undefined && path.isAbsolute(cargoHome)) {
    candidates.push({ path: path.join(cargoHome, "bin", "rustup") });
  }
  candidates.push(
    { path: path.join(homeDirectory, ".cargo", "bin", "rustup") },
    { path: "/opt/homebrew/bin/rustup" },
    { path: "/usr/local/bin/rustup" },
  );
  for (const directory of (environment.PATH ?? "").split(path.delimiter)) {
    if (path.isAbsolute(directory)) {
      candidates.push({ path: path.join(directory, "rustup") });
    }
  }
  return candidates.filter(
    (candidate, index, all) => all.findIndex((other) => other.path === candidate.path) === index,
  );
}

export function resolveStableCargo(options: ToolchainDiscoveryOptions = {}): ToolchainDiscovery {
  const environment = options.environment ?? process.env;
  const commandEnvironment = installerEnvironment(environment);
  const executable = options.isExecutable ?? executableFile;
  const execute =
    options.execute ??
    ((file, args, env) =>
      execFileSync(file, args, { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }));
  const candidates = rustupCandidates(environment, options.homeDirectory ?? os.homedir());
  const selected = candidates.find((candidate) => executable(candidate.path));
  if (!selected) {
    const injected = environment.MISH_TUN_RUSTUP;
    if (injected !== undefined) {
      throw new InstallerFailure("preparation-failed", "rustup", "rustup-candidate-invalid");
    }
    throw new InstallerFailure("preparation-failed", "rustup", "rustup-unavailable");
  }

  let output: string;
  try {
    output = execute(
      selected.path,
      ["which", "cargo", "--toolchain", "stable"],
      commandEnvironment,
    );
  } catch {
    throw new InstallerFailure("preparation-failed", "cargo", "stable-cargo-unavailable");
  }
  const cargo = output.trim();
  if (!cargo || cargo.includes("\n") || cargo.includes("\r") || !path.isAbsolute(cargo)) {
    throw new InstallerFailure("preparation-failed", "cargo", "stable-cargo-invalid");
  }
  if (!executable(cargo)) {
    throw new InstallerFailure("preparation-failed", "cargo", "stable-cargo-invalid");
  }
  return { cargo, rustup: selected.path };
}

function buildHelper(cargo: string, environment: ToolchainEnvironment = process.env) {
  try {
    const commandEnvironment = installerEnvironment(environment);
    commandEnvironment.PATH = `${path.dirname(cargo)}:${commandEnvironment.PATH ?? ""}`;
    execFileSync(
      cargo,
      [
        "build",
        "-p",
        "mish-platform-macos",
        "--features",
        "development-core-host",
        "--bin",
        "mish-tun-helper",
        "--bin",
        "mish-core-host-ctl",
      ],
      {
        env: commandEnvironment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw new InstallerFailure("preparation-failed", "helper-build", "cargo-build-failed");
  }
}

const run = (executable: string, args: string[], options: { allowFailure?: boolean } = {}) => {
  try {
    return execFileSync(executable, args, {
      encoding: "utf8",
      env: process.env,
      stdio: options.allowFailure ? "pipe" : "inherit",
    });
  } catch (error) {
    if (options.allowFailure) return "";
    throw error;
  }
};

function quoteShellArgument(value: string) {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function authorizedCommand(executable: string, args: string[]) {
  return [executable, ...args].map(quoteShellArgument).join(" ");
}

function runAuthorized(script: string) {
  let response: string;
  try {
    response = execFileSync(
      "/usr/bin/osascript",
      [
        "-e",
        "on run argv",
        "-e",
        "try",
        "-e",
        "do shell script (item 1 of argv) with administrator privileges",
        "-e",
        'return "ok"',
        "-e",
        "on error errorMessage number errorNumber",
        "-e",
        'return "error:" & (errorNumber as string)',
        "-e",
        "end try",
        "-e",
        "end run",
        "--",
        script,
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    ).trim();
  } catch {
    throw new InstallerFailure("installation-failed", "authorization", "osascript-failed");
  }
  if (response === "ok") return;
  if (response === "error:-128") {
    throw new InstallerFailure(
      "authorization-cancelled",
      "authorization",
      "administrator-prompt-cancelled",
    );
  }
  throw new InstallerFailure(
    "installation-failed",
    "privileged-install",
    response.startsWith("error:") ? `macos-${response}` : "unexpected-authorization-result",
  );
}

function tolerantAuthorizedCommand(executable: string, args: string[]) {
  return `${authorizedCommand(executable, args)} >/dev/null 2>&1 || true`;
}

function moveIfPresentAuthorizedCommand(source: string, destination: string) {
  const sourceArgument = quoteShellArgument(source);
  return `if [ -e ${sourceArgument} ] || [ -L ${sourceArgument} ]; then ${authorizedCommand(
    "/bin/mv",
    [source, destination],
  )}; fi`;
}

export function buildDevelopmentServiceUninstallScript(
  uid: number,
  gid: number,
  quarantine: string,
) {
  if (
    !Number.isSafeInteger(uid) ||
    uid < 1 ||
    !Number.isSafeInteger(gid) ||
    gid < 1 ||
    !path.isAbsolute(quarantine)
  ) {
    throw new InstallerFailure("preparation-failed", "uninstall", "invalid-uninstall-identity");
  }
  const socket = `/var/run/com.asuka109.mish.tun-helper.${uid}.sock`;
  const targets = [plistTarget, helperTarget, coreTarget, socket, `${socket}.state`];
  return [
    tolerantAuthorizedCommand("/bin/launchctl", ["bootout", `system/${label}`]),
    authorizedCommand("/usr/bin/install", [
      "-d",
      "-o",
      uid.toString(),
      "-g",
      gid.toString(),
      "-m",
      "0700",
      quarantine,
    ]),
    ...targets.map((target) =>
      moveIfPresentAuthorizedCommand(target, path.join(quarantine, path.basename(target))),
    ),
    authorizedCommand("/usr/sbin/chown", ["-R", `${uid}:${gid}`, quarantine]),
  ].join(" &&\n");
}

async function moveInstallerReceiptToTrash(quarantine: string) {
  try {
    await access(installerRoot);
  } catch {
    return;
  }
  await mkdir(path.dirname(quarantine), { recursive: true, mode: 0o700 });
  await rename(installerRoot, path.join(quarantine, "tun-service-installer"));
}

async function writeResult(result: InstallerResult) {
  await mkdir(installerRoot, { recursive: true, mode: 0o700 });
  await chmod(installerRoot, 0o700);
  await writeFile(resultReceipt, `${JSON.stringify(result)}\n`, { mode: 0o600 });
  await chmod(resultReceipt, 0o600);
}

async function report(result: InstallerResult) {
  try {
    await writeResult(result);
  } catch {
    // The stdout result remains authoritative when the bounded receipt cannot be written.
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

function printResult(result: InstallerResult) {
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

async function prepare(uid: number) {
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  await mkdir(installerRoot, { recursive: true, mode: 0o700 });
  await chmod(installerRoot, 0o700);
  let release: MacOsMihomoRelease;
  try {
    release = JSON.parse(await readFile(releaseManifestPath, "utf8")) as MacOsMihomoRelease;
  } catch {
    throw new InstallerFailure(
      "preparation-failed",
      "core-manifest",
      "pinned-core-manifest-invalid",
    );
  }
  const sourceCore = path.resolve(
    ".scratch/mihomo",
    release.version,
    release.asset.replace(/\.gz$/u, ""),
  );
  try {
    await access(sourceCore, constants.X_OK);
  } catch {
    throw new InstallerFailure("preparation-failed", "core-artifact", "pinned-core-missing");
  }
  const coreDigest = createHash("sha256")
    .update(await readFile(sourceCore))
    .digest("hex");
  if (
    release.schemaVersion !== 1 ||
    !/^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(release.version) ||
    !/^[a-f0-9]{64}$/u.test(release.binarySha256) ||
    coreDigest !== release.binarySha256
  ) {
    throw new InstallerFailure(
      "preparation-failed",
      "core-artifact",
      "pinned-core-digest-mismatch",
    );
  }
  let reportedVersion: string;
  try {
    reportedVersion = execFileSync(sourceCore, ["-v"], {
      encoding: "utf8",
      env: installerEnvironment(process.env),
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 5_000,
    });
  } catch {
    throw new InstallerFailure(
      "preparation-failed",
      "core-artifact",
      "pinned-core-version-unavailable",
    );
  }
  if (!reportedVersion.split(/\s+/u).includes(release.version)) {
    throw new InstallerFailure(
      "preparation-failed",
      "core-artifact",
      "pinned-core-version-mismatch",
    );
  }

  const { cargo } = resolveStableCargo();
  buildHelper(cargo);

  const helperSource = path.resolve("target/debug/mish-tun-helper");
  const escapeXml = (value: string) =>
    value
      .replaceAll("&", "&amp;")
      .replaceAll('"', "&quot;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  const installationIdPlaceholder = "MISH_TUN_SERVICE_INSTALLATION_ID_PLACEHOLDER";
  const socket = `/var/run/com.asuka109.mish.tun-helper.${uid}.sock`;
  const plistTemplate = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array><string>${helperTarget}</string></array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>MISH_TUN_SERVICE_ALLOWED_UID</key><string>${uid}</string>
    <key>MISH_TUN_SERVICE_CORE_BINARY</key><string>${coreTarget}</string>
    <key>MISH_TUN_SERVICE_INSTALLATION_ID</key><string>${installationIdPlaceholder}</string>
    <key>MISH_TUN_SERVICE_RUNTIME_ROOT</key><string>${escapeXml(runtimeRoot)}</string>
    <key>MISH_TUN_SERVICE_SOCKET</key><string>${socket}</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
</dict>
</plist>
`;
  let installationId: string;
  try {
    installationId = createHash("sha256")
      .update(await readFile(helperSource))
      .update(await readFile(sourceCore))
      .update(plistTemplate)
      .digest("hex");
    await writeFile(plist, plistTemplate.replace(installationIdPlaceholder, installationId), {
      mode: 0o600,
    });
    await chmod(plist, 0o600);
  } catch {
    throw new InstallerFailure("preparation-failed", "installer-receipt", "receipt-write-failed");
  }
  return { helperSource, installationId, socket, sourceCore };
}

async function main() {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  if (
    process.platform !== "darwin" ||
    process.arch !== "arm64" ||
    uid === undefined ||
    gid === undefined
  ) {
    throw new InstallerFailure("preparation-failed", "platform", "unsupported-development-host");
  }

  if (action === "status") {
    const status = run("/bin/launchctl", ["print", `system/${label}`], { allowFailure: true });
    printResult({
      ok: true,
      service: status ? "installed" : "not-installed",
      stage: "status",
    });
    return;
  }

  if (action === "uninstall") {
    const quarantine = path.join(
      os.homedir(),
      ".Trash",
      `Mish Core Host Uninstall ${Date.now()} ${randomUUID()}`,
    );
    runAuthorized(buildDevelopmentServiceUninstallScript(uid, gid, quarantine));
    try {
      await moveInstallerReceiptToTrash(quarantine);
    } catch {
      throw new InstallerFailure(
        "installation-failed",
        "uninstall-receipt",
        "receipt-trash-failed",
      );
    }
    printResult({ ok: true, service: "not-installed", stage: "completed" });
    return;
  }

  const prepared = await prepare(uid);
  if (action === "prepare") {
    await report({ ok: true, stage: "prepared" });
    return;
  }

  const installCommands = [
    tolerantAuthorizedCommand("/bin/launchctl", ["bootout", `system/${label}`]),
    authorizedCommand("/usr/bin/install", [
      "-d",
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0755",
      helperDirectory,
    ]),
    authorizedCommand("/usr/bin/install", [
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0555",
      prepared.helperSource,
      helperTarget,
    ]),
    authorizedCommand("/usr/bin/install", [
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0555",
      prepared.sourceCore,
      coreTarget,
    ]),
    authorizedCommand("/usr/bin/install", [
      "-o",
      "root",
      "-g",
      "wheel",
      "-m",
      "0644",
      plist,
      plistTarget,
    ]),
    authorizedCommand("/bin/launchctl", ["bootstrap", "system", plistTarget]),
    authorizedCommand("/bin/launchctl", ["kickstart", `system/${label}`]),
  ];
  runAuthorized(installCommands.join(" &&\n"));
  await report({ ok: true, stage: "completed" });
}

if (import.meta.main) {
  if (!new Set(["install", "prepare", "repair", "status", "uninstall"]).has(action)) {
    throw new Error(
      "Usage: node scripts/manage-macos-tun-service.ts <install|prepare|repair|status|uninstall>",
    );
  }
  try {
    await main();
  } catch (error) {
    if (error instanceof InstallerFailure) {
      await report({
        code: error.code,
        kind: error.kind,
        ok: false,
        stage: error.stage,
      });
    } else {
      await report({
        code: "unexpected-installer-failure",
        kind: "preparation-failed",
        ok: false,
        stage: "installer",
      });
    }
    process.exitCode = 1;
  }
}
