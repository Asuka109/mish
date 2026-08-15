import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath, URL as NodeUrl } from "node:url";

const root = fileURLToPath(new NodeUrl("..", import.meta.url));
const apk = `${root}/android/app/build/outputs/apk/debug/app-debug.apk`;
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const adb = process.env.ADB ?? (sdk ? `${sdk}/platform-tools/adb` : "adb");
const emulator = process.env.EMULATOR ?? (sdk ? `${sdk}/emulator/emulator` : "emulator");
const packageName = "com.asuka109.mish.rn";
const activity = `${packageName}/.MainActivity`;
const adbTimeoutMs = 15_000;
const defaultTotalTimeoutMs = 180_000;
const minimumTotalTimeoutMs = 60_000;
const cleanupReserveMs = 30_000;

const parseTimeoutMs = (name: string, raw: string | undefined, fallback: number): number => {
  const value = raw ?? String(fallback);
  if (!/^\d+$/.test(value)) throw new Error(`${name} must be an integer number of milliseconds`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimumTotalTimeoutMs) {
    throw new Error(`${name} must be at least ${minimumTotalTimeoutMs}ms`);
  }
  return parsed;
};

const totalTimeoutMs = parseTimeoutMs(
  "MISH_RN_TOTAL_TIMEOUT_MS",
  process.env.MISH_RN_TOTAL_TIMEOUT_MS,
  defaultTotalTimeoutMs,
);
const smokeStartedAt = Date.now();
const totalDeadline = smokeStartedAt + totalTimeoutMs;
const workDeadline = totalDeadline - Math.min(cleanupReserveMs, Math.floor(totalTimeoutMs / 2));

const remainingUntil = (deadline: number): number => deadline - Date.now();
const requireWorkTime = (stage: string): number => {
  const remaining = remainingUntil(workDeadline);
  if (remaining <= 0) {
    throw new Error(`RN emulator smoke exceeded total wall-clock deadline during ${stage}`);
  }
  return remaining;
};

const boundedSleep = (stage: string): void => {
  const remaining = requireWorkTime(stage);
  const result = spawnSync("sleep", ["1"], { timeout: Math.min(1_000, remaining) });
  if (result.error && (result.error as NodeJS.ErrnoException).code !== "ETIMEDOUT") {
    throw new Error(`RN emulator smoke sleep failed during ${stage}: ${result.error.message}`);
  }
  requireWorkTime(stage);
};

if (!existsSync(apk)) throw new Error("Build the debug APK before emulator smoke");

const adbRun = (args: string[], allowFailure = false): string => {
  const remaining = remainingUntil(totalDeadline);
  if (remaining <= 0) {
    if (allowFailure) return "";
    throw new Error(`adb ${args.join(" ")} exceeded RN emulator smoke total wall-clock deadline`);
  }
  const result = spawnSync(adb, args, {
    encoding: "utf8",
    timeout: Math.min(adbTimeoutMs, remaining),
  });
  if (!allowFailure && result.status !== 0) {
    throw new Error(
      `adb ${args.join(" ")} failed: ${result.stderr ?? result.error?.message ?? "unknown error"}`,
    );
  }
  return result.stdout ?? "";
};

const parseEmulatorPort = (raw: string, name: string): number => {
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must contain only decimal digits`);
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port < 5554 || port > 65534 || port % 2 !== 0) {
    throw new Error(`${name} must be an even emulator port between 5554 and 65534`);
  }
  return port;
};

const configuredPortRaw = process.env.MISH_RN_EMULATOR_PORT;
const emulatorPort = parseEmulatorPort(configuredPortRaw ?? "5554", "MISH_RN_EMULATOR_PORT");
const expectedSerial = `emulator-${emulatorPort}`;
const configuredSerial = process.env.MISH_RN_EMULATOR;
const isEmulatorSerial = (candidate: string): boolean => /^emulator-\d+$/.test(candidate);
if (configuredSerial && !isEmulatorSerial(configuredSerial)) {
  throw new Error(`Refusing non-emulator Android target ${configuredSerial}`);
}
if (configuredSerial) {
  const configuredSerialPort = parseEmulatorPort(
    configuredSerial.slice("emulator-".length),
    "MISH_RN_EMULATOR",
  );
  if (configuredPortRaw !== undefined && configuredSerialPort !== emulatorPort) {
    throw new Error(
      `MISH_RN_EMULATOR_PORT ${emulatorPort} does not match configured serial ${configuredSerial}`,
    );
  }
}

let serial = configuredSerial;
let ownedEmulator: ReturnType<typeof spawn> | undefined;
let ownedIdentity: { pid: number; serial: string } | undefined;

if (!serial) {
  const availableSerials = adbRun(["devices"], true)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^emulator-\d+\tdevice$/.test(line))
    .map((line) => line.split("\t")[0]);
  serial = configuredPortRaw
    ? availableSerials.find((candidate) => candidate === expectedSerial)
    : availableSerials[0];
}

if (!serial) {
  const avd = process.env.MISH_RN_AVD ?? "codex_issue282_api36";
  ownedEmulator = spawn(
    emulator,
    [
      "-avd",
      avd,
      "-port",
      String(emulatorPort),
      "-no-window",
      "-no-audio",
      "-no-boot-anim",
      "-read-only",
    ],
    {
      stdio: "ignore",
      detached: true,
    },
  );
  if (ownedEmulator.pid === undefined) {
    ownedEmulator.kill();
    throw new Error("Self-started Android emulator did not expose a PID");
  }
  serial = expectedSerial;
  ownedIdentity = { pid: ownedEmulator.pid, serial: expectedSerial };
}

const isOwnedEmulator = (): boolean => {
  if (
    ownedEmulator === undefined ||
    ownedIdentity === undefined ||
    ownedEmulator.pid !== ownedIdentity.pid ||
    serial !== ownedIdentity.serial ||
    ownedEmulator.exitCode !== null
  ) {
    return false;
  }
  try {
    process.kill(ownedIdentity.pid, 0);
    return true;
  } catch {
    return false;
  }
};

const adbForDevice = (args: string[], allowFailure = false): string => {
  if (!serial) {
    if (allowFailure) return "";
    throw new Error("RN emulator smoke has no selected emulator serial");
  }
  return adbRun(["-s", serial, ...args], allowFailure);
};

const waitForDevice = (attempts: number): void => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    requireWorkTime("emulator startup");
    if (adbForDevice(["get-state"], true).trim() === "device") return;
    boundedSleep("emulator startup");
  }
  throw new Error(`Android emulator ${serial} did not become ready within ${attempts}s`);
};

const waitForBootCompleted = (attempts: number): void => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    requireWorkTime("Android boot");
    const bootCompleted = adbForDevice(["shell", "getprop", "sys.boot_completed"], true).trim();
    const bootAnimation = adbForDevice(["shell", "getprop", "init.svc.bootanim"], true).trim();
    if (bootCompleted === "1" && (bootAnimation === "stopped" || bootAnimation === "")) return;
    boundedSleep("Android boot");
  }
  throw new Error(`Android emulator ${serial} did not finish boot within ${attempts}s`);
};

try {
  waitForDevice(90);
  waitForBootCompleted(120);
  requireWorkTime("renderer preflight");
  if (adbForDevice(["shell", "getprop", "ro.kernel.qemu"], true).trim() !== "1") {
    throw new Error(`Android target ${serial} is not an emulator`);
  }
  if (adbForDevice(["shell", "id", "-u"], true).trim() === "0") {
    throw new Error(`Android target ${serial} is running an elevated shell`);
  }
  requireWorkTime("APK install");
  adbForDevice(["install", "-r", apk]);
  adbForDevice(["shell", "am", "force-stop", packageName], true);
  adbForDevice(["logcat", "-c"], true);
  requireWorkTime("renderer startup");
  adbForDevice(["shell", "am", "start", "-n", activity]);

  let uiDump = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    requireWorkTime("RN renderer");
    adbForDevice(["shell", "uiautomator", "dump", "/sdcard/rn-host-window.xml"], true);
    uiDump = adbForDevice(["shell", "cat", "/sdcard/rn-host-window.xml"], true);
    if (uiDump.includes("RN_ADMISSION_OK")) break;
    // The polling is only for real emulator startup; deterministic replay is
    // covered separately and never sleeps on wall-clock time.
    boundedSleep("RN renderer");
  }
  if (!uiDump.includes("RN_ADMISSION_OK")) {
    throw new Error(`RN renderer smoke did not reach RN_ADMISSION_OK: ${uiDump}`);
  }
  requireWorkTime("renderer log inspection");
  const logs = adbForDevice(["logcat", "-d", "-t", "80"], true);
  if (logs.includes("FATAL EXCEPTION"))
    throw new Error("RN emulator smoke logged a fatal exception");
  process.stdout.write(JSON.stringify({ serial, packageName, status: "RN_ADMISSION_OK" }) + "\n");
} finally {
  // The work deadline leaves a bounded reserve inside totalDeadline for this
  // cleanup. adbRun keeps its per-call timeout and refuses unbounded cleanup.
  adbForDevice(["shell", "am", "force-stop", packageName], true);
  if (isOwnedEmulator()) {
    adbForDevice(["emu", "kill"], true);
    if (ownedEmulator?.exitCode === null) ownedEmulator.kill("SIGTERM");
    ownedEmulator?.unref();
  }
}
