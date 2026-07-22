import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream } from "node:fs";
import { access, mkdir, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, relative, resolve } from "node:path";
import process from "node:process";

const EXPECTED_PACKAGE_ID = "com.asuka109.mish";
const COMMAND_TIMEOUT_MS = 15_000;
const COMMAND_OUTPUT_LIMIT_BYTES = 128 * 1024;
const REDACTED_LOGCAT_LIMIT_BYTES = 32 * 1024;
const REDACTED_LOGCAT_LIMIT_LINES = 200;

export type CheckStatus = "not-run" | "passed" | "failed" | "inconclusive";

export interface CommandResult {
  exitCode: number | null;
  stderr: string;
  stdout: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface CommandRequest {
  args: string[];
  command: string;
  maxOutputBytes?: number;
  timeoutMs?: number;
}

export interface CommandRunner {
  close(): Promise<void>;
  run(request: CommandRequest): Promise<CommandResult>;
}

export interface CommandAttempt {
  command: string;
  exitCode: number | null;
  finishedAt: string;
  startedAt: string;
  timedOut: boolean;
  truncated: boolean;
}

export interface AdbBoundary {
  attempts: CommandAttempt[];
  close(): Promise<void>;
  listDevices(): Promise<CommandResult>;
  run(serial: string, args: string[]): Promise<CommandResult>;
}

interface CheckResult {
  detail: string;
  finishedAt: string;
  id: string;
  startedAt: string;
  status: CheckStatus;
}

interface DeviceRecord {
  attributes: Record<string, string>;
  serial: string;
  state: string;
}

interface DeviceEvidence {
  abiList: string[];
  androidRelease: string | null;
  androidSdk: number | null;
  buildFingerprintSha256: string | null;
  installedPackage: {
    installed: boolean;
    targetSdk: number | null;
    versionCode: string | null;
    versionName: string | null;
  };
  manufacturer: string | null;
  model: string | null;
  serialSha256: string;
}

interface ApkEvidence {
  abiList: string[];
  fileName: string;
  minSdk: number;
  packageId: string;
  sha256: string;
  signing: {
    certificateSha256: string;
    mode: "debug" | "non-debug";
    schemes: string[];
  };
  targetSdk: number;
  versionCode: string;
  versionName: string;
}

interface SourceEvidence {
  dirty: boolean;
  headSha: string;
  note: string;
}

interface HarnessOptions {
  apkPath: string;
  collectLogcat: boolean;
  install: boolean;
  serial: string;
}

interface DeviceInspectionOptions {
  apkAbis: string[];
  apkPath: string;
  collectLogcat: boolean;
  install: boolean;
  packageId: string;
  serial: string;
}

interface DeviceInspection {
  checks: CheckResult[];
  device: DeviceEvidence;
  logcat: string | null;
}

interface AcceptanceReport {
  apk: ApkEvidence;
  automatedOutcome: CheckStatus;
  claimBoundary: string[];
  commandAttempts: CommandAttempt[];
  createdAt: string;
  device: DeviceEvidence;
  finishedAt: string;
  manualAcceptance: CheckResult[];
  mode: {
    collectLogcat: boolean;
    install: boolean;
    readOnly: boolean;
  };
  schemaVersion: 1;
  source: SourceEvidence;
  automatedChecks: CheckResult[];
}

export class SubprocessCommandRunner implements CommandRunner {
  readonly #active = new Set<ChildProcess>();

  async run(request: CommandRequest): Promise<CommandResult> {
    const timeoutMs = request.timeoutMs ?? COMMAND_TIMEOUT_MS;
    const maxOutputBytes = request.maxOutputBytes ?? COMMAND_OUTPUT_LIMIT_BYTES;

    return await new Promise<CommandResult>((resolveResult) => {
      const child = spawn(request.command, request.args, {
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      this.#active.add(child);

      let exitCode: number | null = null;
      let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
      let timedOut = false;
      let truncated = false;
      let spawnError: Error | null = null;

      const append = (
        current: Buffer<ArrayBufferLike>,
        chunk: Buffer<ArrayBufferLike>,
      ): Buffer<ArrayBufferLike> => {
        const remaining = maxOutputBytes - current.byteLength;
        if (remaining <= 0) {
          truncated = true;
          return current;
        }
        if (chunk.byteLength > remaining) truncated = true;
        return Buffer.concat([current, chunk.subarray(0, remaining)]);
      };

      child.stdout.on("data", (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.on("error", (error) => {
        spawnError = error;
      });

      let forceKill: ReturnType<typeof setTimeout> | null = null;
      const timeout = setTimeout(() => {
        timedOut = true;
        child.kill("SIGTERM");
        forceKill = setTimeout(() => child.kill("SIGKILL"), 500);
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timeout);
        if (forceKill) clearTimeout(forceKill);
        this.#active.delete(child);
        exitCode = code;
        const errorText = spawnError ? `${spawnError.message}\n` : "";
        resolveResult({
          exitCode,
          stderr: `${errorText}${stderr.toString("utf8")}`,
          stdout: stdout.toString("utf8"),
          timedOut,
          truncated,
        });
      });
    });
  }

  async close(): Promise<void> {
    if (this.#active.size === 0) return;
    for (const child of this.#active) child.kill("SIGTERM");
    await new Promise((resolveClose) => setTimeout(resolveClose, 100));
    for (const child of this.#active) child.kill("SIGKILL");
    this.#active.clear();
  }
}

export class ProcessAdbBoundary implements AdbBoundary {
  readonly attempts: CommandAttempt[] = [];
  private readonly adbPath: string;
  private readonly runner: CommandRunner;

  constructor(adbPath: string, runner: CommandRunner) {
    this.adbPath = adbPath;
    this.runner = runner;
  }

  async listDevices(): Promise<CommandResult> {
    return await this.#run(["devices", "-l"], "adb devices -l");
  }

  async run(serial: string, args: string[]): Promise<CommandResult> {
    const displayArgs = args.map((argument) => redactCommandArgument(argument));
    return await this.#run(
      ["-s", serial, ...args],
      `adb -s <selected-device> ${displayArgs.join(" ")}`,
    );
  }

  async close(): Promise<void> {
    await this.runner.close();
  }

  async #run(args: string[], displayCommand: string): Promise<CommandResult> {
    const startedAt = new Date().toISOString();
    const result = await this.runner.run({ args, command: this.adbPath });
    this.attempts.push({
      command: displayCommand,
      exitCode: result.exitCode,
      finishedAt: new Date().toISOString(),
      startedAt,
      timedOut: result.timedOut,
      truncated: result.truncated,
    });
    return result;
  }
}

function redactCommandArgument(argument: string): string {
  if (argument.startsWith("--pid=")) return "--pid=<app-pid>";
  if (argument.endsWith(".apk") || argument.includes("/")) return "<apk>";
  return argument;
}

function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}

function boundedValue(value: string): string | null {
  const normalized = [...value]
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint < 32 || codePoint === 127 ? " " : character;
    })
    .join("")
    .trim();
  if (normalized.length === 0) return null;
  return normalized.slice(0, 160);
}

export function detectApkSigningMode(signingOutput: string): "debug" | "non-debug" {
  return /^Signer #\d+ certificate DN:.*(?:^|,\s*)CN=Android Debug(?:,|$)/imu.test(signingOutput)
    ? "debug"
    : "non-debug";
}

export function redactSensitiveText(input: string, serial?: string): string {
  const sensitiveLine =
    /(?:authorization|config|cookie|credential|password|passwd|profile|proxies|proxy-groups|proxy-providers|secret|subscription|token)\s*[:=]/iu;
  const redactedLines = input.split(/\r?\n/u).map((line) => {
    if (sensitiveLine.test(line)) return "[REDACTED_SENSITIVE_LINE]";
    let safe = line;
    if (serial) safe = safe.replaceAll(serial, "<selected-device>");
    safe = safe.replace(
      /\b(?:file|ftp|http|https|socks|ss|trojan|vless|vmess):\/\/[^\s"'<>]+/giu,
      "[REDACTED_URL]",
    );
    safe = safe.replace(/\b(?:Basic|Bearer)\s+\S+/giu, "[REDACTED_AUTH]");
    safe = safe.replace(/\/(?:data|sdcard|storage)\/[^\s"'<>]+/gu, "[REDACTED_PATH]");
    safe = safe.replace(/\b[A-Za-z0-9+/_-]{48,}={0,2}\b/gu, "[REDACTED_OPAQUE]");
    if (/^-{3,}\s/u.test(safe) || safe.length === 0) return safe;
    const logcatPrefix = safe.match(
      /^(\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d+\s+\d+\s+\d+\s+[VDIWEF]\s+[^:]{1,64}:)/u,
    )?.[1];
    return logcatPrefix ? `${logcatPrefix} [REDACTED_MESSAGE]` : "[REDACTED_UNPARSED_LINE]";
  });

  const limitedLines = redactedLines.slice(0, REDACTED_LOGCAT_LIMIT_LINES);
  let output = limitedLines.join("\n");
  if (Buffer.byteLength(output, "utf8") > REDACTED_LOGCAT_LIMIT_BYTES) {
    output = Buffer.from(output, "utf8").subarray(0, REDACTED_LOGCAT_LIMIT_BYTES).toString("utf8");
  }
  if (redactedLines.length > limitedLines.length) output += "\n[TRUNCATED]";
  return output;
}

export function parseAdbDevices(output: string): DeviceRecord[] {
  return output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(
      (line) =>
        line.length > 0 && !line.startsWith("List of devices attached") && !line.startsWith("*"),
    )
    .map((line) => {
      const [serial = "", state = "", ...attributeParts] = line.split(/\s+/u);
      const attributes: Record<string, string> = {};
      for (const part of attributeParts) {
        const separator = part.indexOf(":");
        if (separator <= 0) continue;
        attributes[part.slice(0, separator)] = part.slice(separator + 1);
      }
      return { attributes, serial, state };
    });
}

export function selectSingleDevice(records: DeviceRecord[], requestedSerial: string): DeviceRecord {
  if (records.length === 0) {
    throw new Error("ADB reported no devices; refusing acceptance collection.");
  }
  if (records.length > 1) {
    throw new Error(
      `ADB reported ${records.length} devices; disconnect extras before selecting exactly one device.`,
    );
  }

  const [device] = records;
  if (device.serial !== requestedSerial) {
    throw new Error("The only ADB device does not exactly match --serial.");
  }
  if (device.state === "unauthorized") {
    throw new Error("The selected ADB device is unauthorized.");
  }
  if (device.state === "offline") {
    throw new Error("The selected ADB device is offline.");
  }
  if (device.state !== "device") {
    throw new Error(`The selected ADB device is not usable (state: ${device.state || "unknown"}).`);
  }
  return device;
}

function check(
  id: string,
  status: CheckStatus,
  detail: string,
  startedAt = new Date().toISOString(),
): CheckResult {
  return {
    detail,
    finishedAt: new Date().toISOString(),
    id,
    startedAt,
    status,
  };
}

function commandSucceeded(result: CommandResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

async function readDeviceProperty(
  adb: AdbBoundary,
  serial: string,
  property: string,
): Promise<{ result: CommandResult; value: string | null }> {
  const result = await adb.run(serial, ["shell", "getprop", property]);
  return { result, value: commandSucceeded(result) ? boundedValue(result.stdout) : null };
}

function parseInstalledPackage(output: string): DeviceEvidence["installedPackage"] {
  if (/Unable to find package|not found/iu.test(output)) {
    return { installed: false, targetSdk: null, versionCode: null, versionName: null };
  }
  const versionCode = output.match(/\bversionCode=(\d+)/u)?.[1] ?? null;
  const versionName = boundedValue(output.match(/\bversionName=([^\s]+)/u)?.[1] ?? "");
  const targetSdkText = output.match(/\btargetSdk=(\d+)/u)?.[1] ?? null;
  return {
    installed: versionCode !== null || versionName !== null,
    targetSdk: targetSdkText ? Number.parseInt(targetSdkText, 10) : null,
    versionCode,
    versionName,
  };
}

function lifecycleSummary(output: string): string {
  const serviceMentions = output.match(/MishVpnService/gu)?.length ?? 0;
  const foregroundMentions = output.match(/(?:isForeground|foreground)=(?:true|1)/giu)?.length ?? 0;
  return `Target-package service mentions: ${serviceMentions}; foreground markers: ${foregroundMentions}. Raw dumpsys output was not retained.`;
}

export async function inspectDevice(
  adb: AdbBoundary,
  options: DeviceInspectionOptions,
): Promise<DeviceInspection> {
  const checks: CheckResult[] = [];
  const selectionStartedAt = new Date().toISOString();
  const listed = await adb.listDevices();
  if (!commandSucceeded(listed)) {
    throw new Error(
      listed.timedOut ? "ADB device discovery timed out." : "ADB device discovery failed.",
    );
  }
  const selected = selectSingleDevice(parseAdbDevices(listed.stdout), options.serial);
  checks.push(
    check(
      "adb-device-selection",
      "passed",
      "Exactly one authorized online device matched the explicit serial.",
      selectionStartedAt,
    ),
  );

  const metadataStartedAt = new Date().toISOString();
  const [release, sdk, abiList, manufacturer, model, fingerprint] = await Promise.all([
    readDeviceProperty(adb, options.serial, "ro.build.version.release"),
    readDeviceProperty(adb, options.serial, "ro.build.version.sdk"),
    readDeviceProperty(adb, options.serial, "ro.product.cpu.abilist"),
    readDeviceProperty(adb, options.serial, "ro.product.manufacturer"),
    readDeviceProperty(adb, options.serial, "ro.product.model"),
    readDeviceProperty(adb, options.serial, "ro.build.fingerprint"),
  ]);
  const metadataResults = [release, sdk, abiList, manufacturer, model, fingerprint];
  const metadataComplete = metadataResults.every(
    ({ result, value }) => commandSucceeded(result) && value !== null,
  );
  checks.push(
    check(
      "device-metadata",
      metadataComplete ? "passed" : "inconclusive",
      metadataComplete
        ? "Android release, SDK, ABI, model, manufacturer, and a hashed build fingerprint were collected."
        : "Device metadata collection was partial; timed-out or failed values were omitted.",
      metadataStartedAt,
    ),
  );

  const deviceAbis = abiList.value?.split(",").filter(Boolean) ?? [];
  if (deviceAbis.length === 0) {
    throw new Error("Device ABI could not be verified; refusing a potentially mismatched APK.");
  }
  const matchedAbi = options.apkAbis.find((abi) => deviceAbis.includes(abi));
  if (!matchedAbi) {
    throw new Error("The selected device ABI does not match any ABI packaged in the APK.");
  }
  checks.push(
    check("apk-device-abi-match", "passed", `APK and selected device share ABI ${matchedAbi}.`),
  );

  const installStartedAt = new Date().toISOString();
  if (!options.install) {
    checks.push(
      check(
        "apk-install",
        "not-run",
        "Installation requires the explicit --install flag.",
        installStartedAt,
      ),
    );
  } else {
    const installed = await adb.run(options.serial, ["install", "-r", options.apkPath]);
    checks.push(
      check(
        "apk-install",
        commandSucceeded(installed) ? "passed" : "failed",
        commandSucceeded(installed)
          ? "ADB reported a successful explicit installation."
          : "Explicit installation failed; raw ADB output was not retained.",
        installStartedAt,
      ),
    );
  }

  const packageStartedAt = new Date().toISOString();
  const installedResult = await adb.run(options.serial, [
    "shell",
    "dumpsys",
    "package",
    options.packageId,
  ]);
  const installedPackage = commandSucceeded(installedResult)
    ? parseInstalledPackage(installedResult.stdout)
    : { installed: false, targetSdk: null, versionCode: null, versionName: null };
  checks.push(
    check(
      "installed-package-inspection",
      commandSucceeded(installedResult) ? "passed" : "inconclusive",
      commandSucceeded(installedResult)
        ? installedPackage.installed
          ? "The target package is installed; only whitelisted package fields were retained."
          : "The target package is not installed."
        : "Installed-package inspection failed or timed out.",
      packageStartedAt,
    ),
  );

  if (installedPackage.installed) {
    const lifecycleStartedAt = new Date().toISOString();
    const lifecycle = await adb.run(options.serial, [
      "shell",
      "dumpsys",
      "activity",
      "services",
      options.packageId,
    ]);
    checks.push(
      check(
        "lifecycle-service-inspection",
        commandSucceeded(lifecycle) ? "passed" : "inconclusive",
        commandSucceeded(lifecycle)
          ? lifecycleSummary(lifecycle.stdout)
          : "Target-package lifecycle service inspection failed or timed out.",
        lifecycleStartedAt,
      ),
    );
  } else {
    checks.push(
      check(
        "lifecycle-service-inspection",
        "not-run",
        "The target package was not installed, so no lifecycle service was inspected.",
      ),
    );
  }

  let logcat: string | null = null;
  if (!options.collectLogcat) {
    checks.push(
      check(
        "target-process-logcat",
        "not-run",
        "Logcat collection requires the explicit --collect-logcat flag.",
      ),
    );
  } else if (!installedPackage.installed) {
    checks.push(
      check(
        "target-process-logcat",
        "inconclusive",
        "Logcat was requested, but the target package is not installed.",
      ),
    );
  } else {
    const logcatStartedAt = new Date().toISOString();
    const pidResult = await adb.run(options.serial, ["shell", "pidof", options.packageId]);
    const pid = commandSucceeded(pidResult) ? pidResult.stdout.trim().split(/\s+/u)[0] : "";
    if (!/^\d+$/u.test(pid)) {
      checks.push(
        check(
          "target-process-logcat",
          "inconclusive",
          "Logcat was requested, but the target application process was not running.",
          logcatStartedAt,
        ),
      );
    } else {
      const logcatResult = await adb.run(options.serial, [
        "logcat",
        "-d",
        "-t",
        String(REDACTED_LOGCAT_LIMIT_LINES),
        `--pid=${pid}`,
      ]);
      if (commandSucceeded(logcatResult)) {
        logcat = redactSensitiveText(logcatResult.stdout, options.serial);
      }
      checks.push(
        check(
          "target-process-logcat",
          commandSucceeded(logcatResult) ? "passed" : "inconclusive",
          commandSucceeded(logcatResult)
            ? "Collected bounded target-PID-only logcat; redaction ran before persistence."
            : "Target-PID logcat collection failed or timed out; no raw output was retained.",
          logcatStartedAt,
        ),
      );
    }
  }

  return {
    checks,
    device: {
      abiList: deviceAbis,
      androidRelease: release.value,
      androidSdk: sdk.value && /^\d+$/u.test(sdk.value) ? Number.parseInt(sdk.value, 10) : null,
      buildFingerprintSha256: fingerprint.value ? hashText(fingerprint.value) : null,
      installedPackage,
      manufacturer: manufacturer.value,
      model: model.value,
      serialSha256: hashText(selected.serial),
    },
    logcat,
  };
}

export async function withAdbBoundary<T>(
  adb: AdbBoundary,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } finally {
    await adb.close();
  }
}

function parseArguments(argv: string[]): HarnessOptions {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage:
  pnpm android:acceptance -- --apk /absolute/path/Mish-arm64-v8a-debug.apk --serial DEVICE_SERIAL [--install] [--collect-logcat]

Default behavior is read-only. --install changes device state. --collect-logcat reads only the
target application PID, bounds the result, and redacts it before writing under .scratch/.`);
    process.exit(0);
  }

  let apkPath: string | null = null;
  let serial: string | null = null;
  let install = false;
  let collectLogcat = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--install") {
      install = true;
      continue;
    }
    if (argument === "--collect-logcat") {
      collectLogcat = true;
      continue;
    }
    if (argument === "--apk" || argument === "--serial") {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`${argument} requires a value.`);
      if (argument === "--apk") apkPath = value;
      if (argument === "--serial") serial = value;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!apkPath) throw new Error("--apk is required.");
  if (!serial) throw new Error("--serial is required.");
  if (
    serial.includes("\r") ||
    serial.includes("\n") ||
    serial.includes(String.fromCharCode(0)) ||
    serial.length > 256
  ) {
    throw new Error("--serial contains invalid characters.");
  }
  return { apkPath: resolve(apkPath), collectLogcat, install, serial };
}

async function inspectApk(
  apkPath: string,
  runner: CommandRunner,
  attempts: CommandAttempt[],
): Promise<ApkEvidence> {
  await access(apkPath);
  const apkStat = await stat(apkPath);
  if (!apkStat.isFile()) throw new Error("--apk must identify a regular file.");
  if (!apkPath.endsWith(".apk")) throw new Error("--apk must identify an .apk file.");

  const sdkRoot = resolve(
    process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT ?? homedir(),
    process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT ? "." : "Library/Android/sdk",
  );
  const buildTools = resolve(sdkRoot, "build-tools/36.1.0");
  const aapt2 = resolve(buildTools, "aapt2");
  const apksigner = resolve(buildTools, "apksigner");
  await access(aapt2);
  await access(apksigner);

  const run = async (command: string, args: string[], displayCommand: string) => {
    const startedAt = new Date().toISOString();
    const result = await runner.run({ args, command });
    attempts.push({
      command: displayCommand,
      exitCode: result.exitCode,
      finishedAt: new Date().toISOString(),
      startedAt,
      timedOut: result.timedOut,
      truncated: result.truncated,
    });
    if (!commandSucceeded(result)) {
      throw new Error(`${displayCommand} failed${result.timedOut ? " (timeout)" : ""}.`);
    }
    return result.stdout;
  };

  const badging = await run(aapt2, ["dump", "badging", apkPath], "aapt2 dump badging <apk>");
  const signing = await run(
    apksigner,
    ["verify", "--verbose", "--print-certs", apkPath],
    "apksigner verify --verbose --print-certs <apk>",
  );
  const packageLine = badging.match(/^package:\s+(.+)$/mu)?.[1] ?? "";
  const packageId = packageLine.match(/\bname='([^']+)'/u)?.[1] ?? "";
  const versionCode = packageLine.match(/\bversionCode='([^']+)'/u)?.[1] ?? "";
  const versionName = packageLine.match(/\bversionName='([^']+)'/u)?.[1] ?? "";
  const minSdkText = badging.match(/^minSdkVersion:'(\d+)'$/mu)?.[1] ?? "";
  const targetSdkText = badging.match(/^targetSdkVersion:'(\d+)'$/mu)?.[1] ?? "";
  const nativeCodeLine = badging.match(/^native-code:\s*(.+)$/mu)?.[1] ?? "";
  const abiList = [...nativeCodeLine.matchAll(/'([^']+)'/gu)].map((match) => match[1]);
  if (packageId !== EXPECTED_PACKAGE_ID) {
    throw new Error(`APK package identity must be ${EXPECTED_PACKAGE_ID}.`);
  }
  if (!versionCode || !versionName || !minSdkText || !targetSdkText || abiList.length === 0) {
    throw new Error("APK metadata is incomplete; package, SDK, and ABI fields are required.");
  }

  const schemes = [...signing.matchAll(/^Verified using (v\d+) scheme[^:]*:\s*true$/gmu)].map(
    (match) => match[1],
  );
  const certificateSha256 =
    signing.match(/^Signer #1 certificate SHA-256 digest:\s*([a-f0-9]+)$/imu)?.[1] ?? "";
  if (schemes.length === 0 || !/^[a-f0-9]{64}$/u.test(certificateSha256)) {
    throw new Error("APK signature verification did not return a bounded signing identity.");
  }

  return {
    abiList,
    fileName: basename(apkPath),
    minSdk: Number.parseInt(minSdkText, 10),
    packageId,
    sha256: await sha256File(apkPath),
    signing: {
      certificateSha256,
      mode: detectApkSigningMode(signing),
      schemes,
    },
    targetSdk: Number.parseInt(targetSdkText, 10),
    versionCode,
    versionName,
  };
}

async function inspectSource(
  repositoryRoot: string,
  runner: CommandRunner,
  attempts: CommandAttempt[],
): Promise<SourceEvidence> {
  const run = async (args: string[], displayCommand: string) => {
    const startedAt = new Date().toISOString();
    const result = await runner.run({ args, command: "git" });
    attempts.push({
      command: displayCommand,
      exitCode: result.exitCode,
      finishedAt: new Date().toISOString(),
      startedAt,
      timedOut: result.timedOut,
      truncated: result.truncated,
    });
    if (!commandSucceeded(result)) throw new Error(`${displayCommand} failed.`);
    return result.stdout;
  };
  const headSha = (await run(["rev-parse", "HEAD"], "git rev-parse HEAD")).trim();
  const status = await run(["status", "--porcelain"], "git status --porcelain");
  if (!/^[a-f0-9]{40}$/u.test(headSha)) throw new Error("Git HEAD is not a full source SHA.");
  return {
    dirty: status.trim().length > 0,
    headSha,
    note: "This is the worktree HEAD observed during collection; the harness does not claim that the APK embeds or cryptographically proves this source SHA.",
  };
}

function manualAcceptanceChecks(): CheckResult[] {
  return [
    ["permission-denial", "Deny VPN consent and confirm stopped, actionable state."],
    ["permission-acceptance-no-start", "Accept VPN consent and confirm no service or VPN starts."],
    ["notification-permission", "Exercise notification allow and deny on clean app-data runs."],
    [
      "fixture-lifecycle",
      "Run and stop the lifecycle fixture; confirm vpnActive=false throughout.",
    ],
    ["activity-recreation", "Rotate, background, recreate, and reconcile a complete snapshot."],
    [
      "process-recovery",
      "Terminate during a transition and confirm recovery-required without replay.",
    ],
    ["vpn-revocation", "Revoke consent and confirm foreground cleanup and permission-required."],
    ["android-back", "Exercise gesture and three-button back without double-pop."],
    [
      "manual-package-network-review",
      "Review package, notification, services, and interfaces manually.",
    ],
  ].map(([id, detail]) => check(id, "not-run", detail));
}

function reportOutcome(checks: CheckResult[]): CheckStatus {
  if (checks.some(({ status }) => status === "failed")) return "failed";
  if (checks.some(({ status }) => status === "inconclusive")) return "inconclusive";
  if (checks.some(({ status }) => status === "passed")) return "passed";
  return "not-run";
}

function markdownCell(value: string | number | boolean | null): string {
  return String(value ?? "not collected")
    .replaceAll("|", "\\|")
    .replace(/[\r\n]+/gu, " ");
}

function reportMarkdown(report: AcceptanceReport): string {
  const checkRows = [...report.automatedChecks, ...report.manualAcceptance]
    .map(
      ({ id, status, detail }) => `| ${markdownCell(id)} | ${status} | ${markdownCell(detail)} |`,
    )
    .join("\n");
  const commandRows = report.commandAttempts
    .map(
      ({ command, exitCode, timedOut, truncated }) =>
        `| ${markdownCell(command)} | ${markdownCell(exitCode)} | ${timedOut} | ${truncated} |`,
    )
    .join("\n");
  return `# Android Phase 0 acceptance evidence

This report is bounded evidence for the Mish lifecycle fixture. It is not device-VPN evidence.

## Artifact and device

- Source HEAD: \`${report.source.headSha}\` (dirty: ${report.source.dirty})
- APK: \`${report.apk.fileName}\`
- APK SHA-256: \`${report.apk.sha256}\`
- Package: \`${report.apk.packageId}\` ${report.apk.versionName} (${report.apk.versionCode})
- APK ABI: ${report.apk.abiList.join(", ")}
- Signing: ${report.apk.signing.mode}, ${report.apk.signing.schemes.join(", ")}, certificate SHA-256 \`${report.apk.signing.certificateSha256}\`
- Device serial SHA-256: \`${report.device.serialSha256}\`
- Device: ${markdownCell(report.device.manufacturer)} ${markdownCell(report.device.model)}
- Android: ${markdownCell(report.device.androidRelease)} (SDK ${markdownCell(report.device.androidSdk)})
- Device ABI: ${report.device.abiList.join(", ")}
- Mode: ${report.mode.readOnly ? "read-only" : "state-changing"}; install=${report.mode.install}; collectLogcat=${report.mode.collectLogcat}
- Automated outcome: ${report.automatedOutcome}

## Checks

| Check | Status | Detail |
| --- | --- | --- |
${checkRows}

## Commands attempted

Serials, APK paths, PIDs, and command output are not recorded here.

| Command | Exit | Timed out | Output truncated |
| --- | ---: | --- | --- |
${commandRows}

## Claim boundary

${report.claimBoundary.map((boundary) => `- ${boundary}`).join("\n")}
`;
}

async function writeEvidence(
  repositoryRoot: string,
  report: AcceptanceReport,
  logcat: string | null,
): Promise<string> {
  const timestamp = report.createdAt.replace(/[:.]/gu, "-");
  const outputDirectory = resolve(
    repositoryRoot,
    ".scratch/android-acceptance",
    `${timestamp}-${report.device.serialSha256.slice(0, 12)}`,
  );
  const outputRelative = relative(repositoryRoot, outputDirectory);
  if (!outputRelative.startsWith(".scratch/android-acceptance/")) {
    throw new Error("Evidence output escaped the ignored .scratch directory.");
  }
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  await writeFile(resolve(outputDirectory, "report.json"), `${JSON.stringify(report, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await writeFile(resolve(outputDirectory, "summary.md"), reportMarkdown(report), {
    encoding: "utf8",
    mode: 0o600,
  });
  if (logcat !== null) {
    await writeFile(resolve(outputDirectory, "logcat.redacted.txt"), `${logcat}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  }
  return outputRelative;
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2));
  const repositoryRoot = resolve(import.meta.dirname, "..");
  const runner = new SubprocessCommandRunner();
  const attempts: CommandAttempt[] = [];
  const createdAt = new Date().toISOString();

  try {
    const [apk, source] = await Promise.all([
      inspectApk(options.apkPath, runner, attempts),
      inspectSource(repositoryRoot, runner, attempts),
    ]);
    const sdkRoot =
      process.env.ANDROID_HOME ??
      process.env.ANDROID_SDK_ROOT ??
      resolve(homedir(), "Library/Android/sdk");
    const adb = new ProcessAdbBoundary(resolve(sdkRoot, "platform-tools/adb"), runner);
    const inspection = await withAdbBoundary(
      adb,
      async () =>
        await inspectDevice(adb, {
          apkAbis: apk.abiList,
          apkPath: options.apkPath,
          collectLogcat: options.collectLogcat,
          install: options.install,
          packageId: apk.packageId,
          serial: options.serial,
        }),
    );
    attempts.push(...adb.attempts);

    const automatedChecks = [
      check("apk-file", "passed", "The explicit APK path exists and is a regular .apk file."),
      check(
        "apk-identity",
        "passed",
        `Package ${apk.packageId}, SDK ${apk.minSdk}-${apk.targetSdk}, ABI ${apk.abiList.join(", ")}.`,
      ),
      check(
        "apk-signature",
        "passed",
        `${apk.signing.mode} signing verified with ${apk.signing.schemes.join(", ")}.`,
      ),
      ...inspection.checks,
    ];
    const manualAcceptance = manualAcceptanceChecks();
    const automatedOutcome = reportOutcome(automatedChecks);
    const report: AcceptanceReport = {
      apk,
      automatedChecks,
      automatedOutcome,
      claimBoundary: [
        "The APK contains a Phase 0 lifecycle fixture. It does not establish a TUN or route traffic.",
        "A checksum-matched packaged Mobile Core identity proves package contents only; the fixture does not initialize or start that Core.",
        "Installation, permission, lifecycle, logcat, and UI observations do not prove TCP, UDP, DNS, routing, socket protection, recovery, or safe-stop VPN behavior.",
        "All manual acceptance checks remain not-run until a human performs and records them on the selected device.",
      ],
      commandAttempts: attempts,
      createdAt,
      device: inspection.device,
      finishedAt: new Date().toISOString(),
      manualAcceptance,
      mode: {
        collectLogcat: options.collectLogcat,
        install: options.install,
        readOnly: !options.install,
      },
      schemaVersion: 1,
      source,
    };
    const outputDirectory = await writeEvidence(repositoryRoot, report, inspection.logcat);
    console.log(`Android Phase 0 evidence written under ${outputDirectory}`);
    console.log(
      `Automated outcome: ${report.automatedOutcome}. Claim: lifecycle fixture only; not a device VPN.`,
    );
    if (report.automatedOutcome === "failed") process.exitCode = 2;
  } finally {
    await runner.close();
  }
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "Android acceptance harness failed.");
    process.exitCode = 1;
  });
}
