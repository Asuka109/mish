import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { detachMacOsDiskImage } from "./macos-dmg-presentation.ts";
import { verifyMacOsPrivilegedBundle } from "./macos-privileged-bundle.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

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
  await assert.rejects(
    verifyMacOsPrivilegedBundle(application, "ad-hoc"),
    /privileged artifacts|release-path-rejected:symlink/u,
  );
});

test("macOS DMG retries ordinary detach with bounded backoff and no force", () => {
  const calls: string[][] = [];
  const statuses = [16, 16, 0];
  const pauses: number[] = [];
  detachMacOsDiskImage(
    "/Volumes/Mish",
    (command, arguments_) => {
      calls.push([command, ...arguments_]);
      return { status: statuses.shift() ?? 1, stderr: "resource busy" };
    },
    (milliseconds) => {
      pauses.push(milliseconds);
    },
  );
  assert.deepEqual(calls, [
    ["/usr/bin/hdiutil", "detach", "/Volumes/Mish"],
    ["/usr/bin/hdiutil", "detach", "/Volumes/Mish"],
    ["/usr/bin/hdiutil", "detach", "/Volumes/Mish"],
  ]);
  assert.equal(calls.flat().includes("-force"), false);
  assert.deepEqual(pauses, [250, 500]);
});

test("macOS DMG fails after bounded ordinary detach retries", () => {
  let calls = 0;
  assert.throws(
    () =>
      detachMacOsDiskImage(
        "/Volumes/Mish",
        () => {
          calls += 1;
          return { status: 16, stderr: "resource busy" };
        },
        () => {},
      ),
    /after 5 attempts/u,
  );
  assert.equal(calls, 5);
});

test("routine Alpha packaging is headless and opening is an explicit hands-on action", () => {
  const rootPackage = JSON.parse(
    readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as { scripts?: Record<string, string> };
  const builder = readFileSync(path.join(repositoryRoot, "scripts/build-macos-bundle.ts"), "utf8");

  assert.equal(
    rootPackage.scripts?.["desktop:bundle:macos"],
    "node scripts/build-macos-bundle.ts --profile alpha-ad-hoc",
  );
  assert.equal(
    rootPackage.scripts?.["desktop:bundle:macos:open"],
    "node scripts/build-macos-bundle.ts --profile alpha-ad-hoc --open-dmg",
  );
  assert.match(builder, /packageEnvironment\.CI = "true"/u);
  assert.match(builder, /delete packageEnvironment\.TAURI_BUNDLER_DMG_IGNORE_CI/u);
  assert.match(builder, /createMacOsDmg\(application, dmg, \{ replaceExistingOutput: true \}\)/u);
  assert.match(builder, /if \(openDmg\) execFileSync\("\/usr\/bin\/open"/u);
  assert.doesNotMatch(builder, /styledDmg|TAURI_BUNDLER_DMG_IGNORE_CI =/u);
});
