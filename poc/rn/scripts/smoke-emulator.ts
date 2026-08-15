import { existsSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const apk = `${root}/android/app/build/outputs/apk/debug/app-debug.apk`;
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
const adb = process.env.ADB ?? (sdk ? `${sdk}/platform-tools/adb` : "adb");
const emulator = process.env.EMULATOR ?? (sdk ? `${sdk}/emulator/emulator` : "emulator");
const packageName = "com.mish.rnadmission";
const activity = `${packageName}/.MainActivity`;
const adbTimeoutMs = 15_000;

if (!existsSync(apk)) throw new Error("Build the debug APK before emulator smoke");

const adbRun = (args: string[], allowFailure = false): string => {
  const result = spawnSync(adb, args, { encoding: "utf8", timeout: adbTimeoutMs });
  if (!allowFailure && result.status !== 0) {
    throw new Error(`adb ${args.join(" ")} failed: ${result.stderr}`);
  }
  return result.stdout;
};

const configuredSerial = process.env.MISH_RN_EMULATOR;
const isEmulatorSerial = (candidate: string): boolean => /^emulator-\d+$/.test(candidate);
if (configuredSerial && !isEmulatorSerial(configuredSerial)) {
  throw new Error(`Refusing non-emulator Android target ${configuredSerial}`);
}
let serial = configuredSerial;
let ownedEmulator: ReturnType<typeof spawn> | undefined;

if (!serial) {
  const devices = adbRun(["devices"], true)
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^emulator-\d+\tdevice$/.test(line));
  serial = devices?.split("\t")[0];
}

if (!serial) {
  const avd = process.env.MISH_RN_AVD ?? "codex_issue282_api36";
  ownedEmulator = spawn(emulator, ["-avd", avd, "-no-window", "-no-audio", "-no-boot-anim", "-read-only"], {
    stdio: "ignore",
    detached: true,
  });
  serial = `emulator-${process.env.MISH_RN_EMULATOR_PORT ?? "5554"}`;
}

const adbForDevice = (args: string[], allowFailure = false): string =>
  adbRun(["-s", serial!, ...args], allowFailure);

const waitForDevice = (attempts: number): void => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (adbForDevice(["get-state"], true).trim() === "device") return;
    spawnSync("sleep", ["1"]);
  }
  throw new Error(`Android emulator ${serial} did not become ready within ${attempts}s`);
};

const waitForBootCompleted = (attempts: number): void => {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const bootCompleted = adbForDevice(["shell", "getprop", "sys.boot_completed"], true).trim();
    const bootAnimation = adbForDevice(["shell", "getprop", "init.svc.bootanim"], true).trim();
    if (bootCompleted === "1" && (bootAnimation === "stopped" || bootAnimation === "")) return;
    spawnSync("sleep", ["1"]);
  }
  throw new Error(`Android emulator ${serial} did not finish boot within ${attempts}s`);
};

try {
  waitForDevice(90);
  waitForBootCompleted(120);
  if (adbForDevice(["shell", "getprop", "ro.kernel.qemu"], true).trim() !== "1") {
    throw new Error(`Android target ${serial} is not an emulator`);
  }
  if (adbForDevice(["shell", "id", "-u"], true).trim() === "0") {
    throw new Error(`Android target ${serial} is running an elevated shell`);
  }
  adbForDevice(["install", "-r", apk]);
  adbForDevice(["shell", "am", "force-stop", packageName], true);
  adbForDevice(["logcat", "-c"], true);
  adbForDevice(["shell", "am", "start", "-n", activity]);

  let uiDump = "";
  for (let attempt = 0; attempt < 40; attempt += 1) {
    adbForDevice(["shell", "uiautomator", "dump", "/sdcard/rn-admission-window.xml"], true);
    uiDump = adbForDevice(["shell", "cat", "/sdcard/rn-admission-window.xml"], true);
    if (uiDump.includes("RN_ADMISSION_OK")) break;
    // The polling is only for real emulator startup; deterministic replay is
    // covered separately and never sleeps on wall-clock time.
    spawnSync("sleep", ["1"]);
  }
  if (!uiDump.includes("RN_ADMISSION_OK")) {
    throw new Error(`RN renderer smoke did not reach RN_ADMISSION_OK: ${uiDump}`);
  }
  const logs = adbForDevice(["logcat", "-d", "-t", "80"], true);
  if (logs.includes("FATAL EXCEPTION")) throw new Error("RN emulator smoke logged a fatal exception");
  process.stdout.write(JSON.stringify({ serial, packageName, status: "RN_ADMISSION_OK" }) + "\n");
} finally {
  adbForDevice(["shell", "am", "force-stop", packageName], true);
  if (ownedEmulator) {
    adbForDevice(["emu", "kill"], true);
    ownedEmulator.unref();
  }
}
