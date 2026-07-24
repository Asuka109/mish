import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { verifyMacOsPrivilegedBundle } from "./macos-privileged-bundle.ts";
import { detachMacOsDiskImage } from "./verify-macos-alpha-ad-hoc-dmg.ts";

function applicationFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "mish-alpha-ad-hoc-"));
  const application = path.join(root, "Mish.app");
  mkdirSync(path.join(application, "Contents", "Resources"), { recursive: true });
  return application;
}

test("alpha-ad-hoc rejects SMAppService and development helper payloads", async () => {
  const application = applicationFixture();
  const xpc = path.join(application, "Contents", "XPCServices", "Mish.xpc");
  mkdirSync(xpc, { recursive: true });
  await assert.rejects(verifyMacOsPrivilegedBundle(application, "ad-hoc"), /privileged artifacts/u);
});

test("alpha-ad-hoc rejects linked privileged directories", async () => {
  const application = applicationFixture();
  const outside = path.join(path.dirname(application), "outside");
  mkdirSync(outside);
  symlinkSync(outside, path.join(application, "Contents", "Library"));
  await assert.rejects(verifyMacOsPrivilegedBundle(application, "ad-hoc"), /privileged artifacts/u);
});

test("alpha-ad-hoc retries ordinary DMG detach without forcing it", async () => {
  const calls: string[][] = [];
  const statuses = [16, 16, 0];
  const pauses: number[] = [];
  await detachMacOsDiskImage(
    "/Volumes/Mish",
    (command, arguments_) => {
      calls.push([command, ...arguments_]);
      return { status: statuses.shift() ?? 1, stderr: "resource busy" };
    },
    async (milliseconds) => {
      pauses.push(milliseconds);
    },
  );
  assert.deepEqual(calls, [
    ["hdiutil", "detach", "/Volumes/Mish"],
    ["hdiutil", "detach", "/Volumes/Mish"],
    ["hdiutil", "detach", "/Volumes/Mish"],
  ]);
  assert.equal(calls.flat().includes("-force"), false);
  assert.deepEqual(pauses, [250, 500]);
});

test("alpha-ad-hoc fails after bounded ordinary DMG detach retries", async () => {
  let calls = 0;
  await assert.rejects(
    detachMacOsDiskImage(
      "/Volumes/Mish",
      () => {
        calls += 1;
        return { status: 16, stderr: "resource busy" };
      },
      async () => {},
    ),
    /after 5 attempts/u,
  );
  assert.equal(calls, 5);
});
