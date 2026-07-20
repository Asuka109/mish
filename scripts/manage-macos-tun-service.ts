import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, constants, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type InstallerFailureKind =
  | "authorization-cancelled"
  | "installation-failed"
  | "preparation-failed";

type InstallerResult =
  | { ok: true; stage: "completed" | "prepared" }
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
const sourceCore = path.resolve(".scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29");
const runtimeRoot = path.join(
  os.homedir(),
  "Library/Application Support/com.asuka109.mish/runtime",
);
const installerRoot = path.join(runtimeRoot, "tun-service-installer");
const plist = path.join(installerRoot, `${label}.plist`);
const resultReceipt = path.join(installerRoot, "last-result.json");

const action = process.argv[2];
if (!new Set(["install", "prepare", "repair", "status", "uninstall"]).has(action)) {
  throw new Error(
    "Usage: node scripts/manage-macos-tun-service.ts <install|prepare|repair|status|uninstall>",
  );
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

async function prepare(uid: number) {
  await mkdir(runtimeRoot, { recursive: true, mode: 0o700 });
  await chmod(runtimeRoot, 0o700);
  await mkdir(installerRoot, { recursive: true, mode: 0o700 });
  await chmod(installerRoot, 0o700);
  try {
    await access(sourceCore, constants.X_OK);
  } catch {
    throw new InstallerFailure("preparation-failed", "core-artifact", "pinned-core-missing");
  }

  let cargo: string;
  try {
    cargo = execFileSync("/opt/homebrew/bin/rustup", ["which", "cargo", "--toolchain", "stable"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch {
    throw new InstallerFailure("preparation-failed", "cargo", "stable-cargo-unavailable");
  }
  try {
    execFileSync(cargo, ["build", "-p", "mish-platform-macos", "--bin", "mish-tun-helper"], {
      env: { ...process.env, PATH: `${path.dirname(cargo)}:${process.env.PATH ?? ""}` },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    throw new InstallerFailure("preparation-failed", "helper-build", "cargo-build-failed");
  }

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
  return { helperSource, installationId, socket };
}

async function main() {
  const uid = process.getuid?.();
  if (process.platform !== "darwin" || process.arch !== "arm64" || uid === undefined) {
    throw new InstallerFailure("preparation-failed", "platform", "unsupported-development-host");
  }

  if (action === "status") {
    const status = run("/bin/launchctl", ["print", `system/${label}`], { allowFailure: true });
    if (!status) throw new Error("Development TUN service is not installed");
    process.stdout.write(status);
    return;
  }

  if (action === "uninstall") {
    const socket = `/var/run/com.asuka109.mish.tun-helper.${uid}.sock`;
    const commands = [
      tolerantAuthorizedCommand("/bin/launchctl", ["bootout", `system/${label}`]),
      ...[plistTarget, helperTarget, coreTarget, socket].map((target) =>
        tolerantAuthorizedCommand("/usr/bin/trash", [target]),
      ),
    ];
    runAuthorized(commands.join("\n"));
    run("/usr/bin/trash", [installerRoot], { allowFailure: true });
    await report({ ok: true, stage: "completed" });
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
      sourceCore,
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
