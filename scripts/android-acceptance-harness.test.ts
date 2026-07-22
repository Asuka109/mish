import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  detectApkSigningMode,
  inspectDevice,
  redactSensitiveText,
  type AdbBoundary,
  type CommandAttempt,
  type CommandResult,
  withAdbBoundary,
} from "./android-acceptance-harness.ts";

const serial = "device-secret-serial";

function result(stdout = "", overrides: Partial<CommandResult> = {}): CommandResult {
  return {
    exitCode: 0,
    stderr: "",
    stdout,
    timedOut: false,
    truncated: false,
    ...overrides,
  };
}

class FakeAdbBoundary implements AdbBoundary {
  readonly attempts: CommandAttempt[] = [];
  readonly calls: string[] = [];
  closed = false;
  private readonly devices: CommandResult;
  private readonly responses: Map<string, CommandResult>;

  constructor(devices: CommandResult, responses: Map<string, CommandResult>) {
    this.devices = devices;
    this.responses = responses;
  }

  async listDevices(): Promise<CommandResult> {
    this.calls.push("devices -l");
    return this.devices;
  }

  async run(requestedSerial: string, args: string[]): Promise<CommandResult> {
    assert.equal(requestedSerial, serial);
    const key = args.join(" ");
    this.calls.push(key);
    return this.responses.get(key) ?? result("", { exitCode: 1, stderr: "fake missing response" });
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

function baseResponses(): Map<string, CommandResult> {
  return new Map([
    ["shell getprop ro.build.version.release", result("16\n")],
    ["shell getprop ro.build.version.sdk", result("36\n")],
    ["shell getprop ro.product.cpu.abilist", result("arm64-v8a,armeabi-v7a\n")],
    ["shell getprop ro.product.manufacturer", result("Meizu\n")],
    ["shell getprop ro.product.model", result("Meizu 20 Pro\n")],
    ["shell getprop ro.build.fingerprint", result("vendor/device/private/build/fingerprint\n")],
    [
      "shell dumpsys package com.asuka109.mish",
      result("Unable to find package: com.asuka109.mish\n"),
    ],
  ]);
}

function options(overrides: Partial<Parameters<typeof inspectDevice>[1]> = {}) {
  return {
    apkAbis: ["arm64-v8a"],
    apkPath: "/private/example/Mish-arm64-v8a-debug.apk",
    collectLogcat: false,
    install: false,
    packageId: "com.asuka109.mish",
    serial,
    ...overrides,
  };
}

describe("Android acceptance fake ADB boundary", () => {
  test("refuses multiple devices even when the requested serial is present", async () => {
    const adb = new FakeAdbBoundary(
      result(
        `List of devices attached\n${serial} device model:Meizu_20_Pro\nemulator-5554 device model:sdk_gphone64_x86_64\n`,
      ),
      baseResponses(),
    );

    await assert.rejects(
      withAdbBoundary(adb, async () => await inspectDevice(adb, options())),
      /reported 2 devices/u,
    );
    assert.equal(adb.closed, true);
    assert.deepEqual(adb.calls, ["devices -l"]);
  });

  test("refuses zero, unauthorized, offline, and serial-mismatched devices", async () => {
    const cases = [
      ["List of devices attached\n", /reported no devices/u],
      [`List of devices attached\n${serial} unauthorized\n`, /unauthorized/u],
      [`List of devices attached\n${serial} offline\n`, /offline/u],
      ["List of devices attached\nanother-device device\n", /does not exactly match/u],
    ] as const;

    for (const [devices, expected] of cases) {
      const adb = new FakeAdbBoundary(result(devices), baseResponses());
      await assert.rejects(
        withAdbBoundary(adb, async () => await inspectDevice(adb, options())),
        expected,
      );
      assert.equal(adb.closed, true);
    }
  });

  test("marks a timed-out metadata command inconclusive and keeps bounded partial evidence", async () => {
    const responses = baseResponses();
    responses.set(
      "shell getprop ro.build.version.release",
      result("", { exitCode: null, timedOut: true }),
    );
    const adb = new FakeAdbBoundary(
      result(`List of devices attached\n${serial} device model:Meizu_20_Pro\n`),
      responses,
    );

    const inspection = await withAdbBoundary(adb, async () => await inspectDevice(adb, options()));

    assert.equal(inspection.device.androidRelease, null);
    assert.equal(inspection.device.model, "Meizu 20 Pro");
    assert.equal(
      inspection.checks.find(({ id }) => id === "device-metadata")?.status,
      "inconclusive",
    );
    assert.equal(adb.closed, true);
  });

  test("redacts all target-process message payloads before persistence", async () => {
    const responses = baseResponses();
    responses.set(
      "shell dumpsys package com.asuka109.mish",
      result("versionCode=1 targetSdk=36\nversionName=0.1.0\n"),
    );
    responses.set(
      "shell dumpsys activity services com.asuka109.mish",
      result("ServiceRecord MishVpnService isForeground=true\n"),
    );
    responses.set("shell pidof com.asuka109.mish", result("4242\n"));
    responses.set(
      "logcat -d -t 200 --pid=4242",
      result(
        `07-20 12:00:00.000  4242  4242 I MishVpn: ordinary lifecycle message\n` +
          `07-20 12:00:01.000  4242  4242 E MishVpn: token=top-secret ${serial}\n` +
          `07-20 12:00:02.000  4242  4242 I MishVpn: https://private.example/subscription\n`,
      ),
    );
    const adb = new FakeAdbBoundary(
      result(`List of devices attached\n${serial} device model:Meizu_20_Pro\n`),
      responses,
    );

    const inspection = await withAdbBoundary(
      adb,
      async () => await inspectDevice(adb, options({ collectLogcat: true })),
    );

    assert.ok(inspection.logcat);
    assert.doesNotMatch(inspection.logcat, /ordinary lifecycle message/u);
    assert.doesNotMatch(inspection.logcat, /top-secret|private\.example|device-secret/u);
    assert.match(inspection.logcat, /REDACTED/u);
    assert.equal(
      inspection.checks.find(({ id }) => id === "target-process-logcat")?.status,
      "passed",
    );
  });

  test("continues after a partial property failure and always closes the boundary", async () => {
    const responses = baseResponses();
    responses.set(
      "shell getprop ro.product.model",
      result("", { exitCode: 1, stderr: "property unavailable" }),
    );
    const adb = new FakeAdbBoundary(
      result(`List of devices attached\n${serial} device model:Meizu_20_Pro\n`),
      responses,
    );

    const inspection = await withAdbBoundary(adb, async () => await inspectDevice(adb, options()));

    assert.equal(inspection.device.model, null);
    assert.equal(inspection.device.manufacturer, "Meizu");
    assert.equal(inspection.device.installedPackage.installed, false);
    assert.equal(adb.closed, true);
  });

  test("does not install by default and requires an explicit install option", async () => {
    const readOnlyAdb = new FakeAdbBoundary(
      result(`List of devices attached\n${serial} device model:Meizu_20_Pro\n`),
      baseResponses(),
    );
    const readOnlyInspection = await withAdbBoundary(
      readOnlyAdb,
      async () => await inspectDevice(readOnlyAdb, options()),
    );
    assert.equal(
      readOnlyAdb.calls.some((call) => call.startsWith("install ")),
      false,
    );
    assert.equal(
      readOnlyInspection.checks.find(({ id }) => id === "apk-install")?.status,
      "not-run",
    );

    const installResponses = baseResponses();
    installResponses.set(
      "install -r /private/example/Mish-arm64-v8a-debug.apk",
      result("Success\n"),
    );
    const installAdb = new FakeAdbBoundary(
      result(`List of devices attached\n${serial} device model:Meizu_20_Pro\n`),
      installResponses,
    );
    const installInspection = await withAdbBoundary(
      installAdb,
      async () => await inspectDevice(installAdb, options({ install: true })),
    );
    assert.equal(installInspection.checks.find(({ id }) => id === "apk-install")?.status, "passed");
  });
});

test("redaction never preserves arbitrary unparsed content", () => {
  const redacted = redactSensitiveText(
    "raw profile bytes and password material\nhttps://private.example/path\n",
    serial,
  );
  assert.doesNotMatch(redacted, /profile bytes|password material|private\.example/u);
  assert.match(redacted, /REDACTED/u);
});

test("recognizes the Android debug certificate regardless of DN field order", () => {
  assert.equal(
    detectApkSigningMode("Signer #1 certificate DN: C=US, O=Android, CN=Android Debug\n"),
    "debug",
  );
  assert.equal(
    detectApkSigningMode("Signer #1 certificate DN: C=US, O=Mish, CN=Release\n"),
    "non-debug",
  );
});
