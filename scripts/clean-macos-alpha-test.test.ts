import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyMacOsAlphaCleanup,
  hasEnabledLoopbackSystemProxy,
  inspectMacOsAlphaCleanup,
} from "./clean-macos-alpha-test.ts";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "mish-alpha-cleanup-"));
  const home = path.join(root, "home");
  const applications = path.join(root, "Applications");
  mkdirSync(home);
  mkdirSync(applications);
  return { applications, home };
}

test("cleanup inspection is bounded to exact app and account-local targets", () => {
  const { applications, home } = fixture();
  const app = path.join(applications, "Mish.app");
  const data = path.join(home, "Library/Application Support/com.asuka109.mish");
  const unrelated = path.join(home, "Library/Application Support/com.example.unrelated");
  const byHost = path.join(home, "Library/Preferences/ByHost");
  mkdirSync(app);
  mkdirSync(data, { recursive: true });
  mkdirSync(unrelated, { recursive: true });
  mkdirSync(byHost, { recursive: true });
  writeFileSync(path.join(byHost, "com.asuka109.mish.UUID-1.plist"), "fixture");
  writeFileSync(path.join(byHost, "com.example.unrelated.UUID-1.plist"), "fixture");

  const inspection = inspectMacOsAlphaCleanup({
    homeDirectory: home,
    processTable: "",
    proxyState: "",
    systemApplicationsDirectory: applications,
  });

  assert.deepEqual(inspection.blockers, []);
  assert.deepEqual(
    inspection.existingTargets.sort(),
    [app, data, path.join(byHost, "com.asuka109.mish.UUID-1.plist")].sort(),
  );
  assert.equal(inspection.existingTargets.includes(unrelated), false);
});

test("cleanup refuses running ownership, recovery journals, and loopback proxy state", () => {
  const { applications, home } = fixture();
  const data = path.join(home, "Library/Application Support/com.asuka109.mish");
  mkdirSync(data, { recursive: true });
  writeFileSync(path.join(data, "system-proxy-journal.json"), "fixture");
  const inspection = inspectMacOsAlphaCleanup({
    homeDirectory: home,
    processTable: `42 /Applications/Mish.app/Contents/MacOS/mish-desktop
43 /tmp/mihomo -d ${path.join(data, "runtime/candidates/id/home")}`,
    proxyState: `HTTPEnable : 1
HTTPProxy : 127.0.0.1`,
    systemApplicationsDirectory: applications,
  });

  assert.equal(inspection.blockers.length, 3);
  assert.throws(() => applyMacOsAlphaCleanup(inspection), /blocked/u);
});

test("loopback proxy detection requires an enabled supported proxy kind", () => {
  assert.equal(hasEnabledLoopbackSystemProxy("HTTPEnable : 0\nHTTPProxy : 127.0.0.1\n"), false);
  assert.equal(hasEnabledLoopbackSystemProxy("HTTPEnable : 1\nHTTPProxy : proxy.example\n"), false);
  assert.equal(hasEnabledLoopbackSystemProxy("SOCKSEnable : 1\nSOCKSProxy : localhost\n"), true);
});

test("apply unregisters launch agents and trashes only inspected targets", () => {
  const calls: string[][] = [];
  const targets = ["/fixture/Applications/Mish.app", "/fixture/Library/LaunchAgents/Mish.plist"];

  applyMacOsAlphaCleanup(
    { blockers: [], existingTargets: targets, mountedMishImages: 2 },
    {
      getUid: () => 501,
      run: (executable, arguments_) => {
        calls.push([executable, ...arguments_]);
        if (executable !== "/bin/launchctl") return { status: 0 };
        return { status: arguments_[0] === "bootout" ? 5 : 113 };
      },
    },
  );

  assert.deepEqual(calls, [
    ["/bin/launchctl", "bootout", "gui/501", targets[1]],
    ["/bin/launchctl", "print", "gui/501/Mish"],
    ["/usr/bin/trash", "--stopOnError", targets[0]],
    ["/usr/bin/trash", "--stopOnError", targets[1]],
  ]);
  assert.equal(calls.flat().includes("hdiutil"), false);
  assert.equal(calls.flat().includes("-force"), false);
});

test("apply refuses to trash a launch agent that remains registered", () => {
  const calls: string[][] = [];
  assert.throws(
    () =>
      applyMacOsAlphaCleanup(
        {
          blockers: [],
          existingTargets: ["/fixture/Library/LaunchAgents/Mish.plist"],
          mountedMishImages: 0,
        },
        {
          getUid: () => 501,
          run: (executable, arguments_) => {
            calls.push([executable, ...arguments_]);
            return { status: 0 };
          },
        },
      ),
    /still registered/u,
  );
  assert.equal(
    calls.some(([executable]) => executable === "/usr/bin/trash"),
    false,
  );
});
