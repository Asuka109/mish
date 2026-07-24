import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  applyMacOsAppCleanup,
  forceStopMish,
  hasEnabledLoopbackSystemProxy,
  inspectMacOsAppCleanup,
  parseMacOsAppCleanupArguments,
  restoreOwnedSystemProxy,
  safelyStopMish,
} from "./clean-macos-app.ts";

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "mish-macos-app-cleanup-"));
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

  const inspection = inspectMacOsAppCleanup({
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
  const inspection = inspectMacOsAppCleanup({
    homeDirectory: home,
    processTable: `42 1 /Applications/Mish.app/Contents/MacOS/mish-desktop
43 42 /tmp/mihomo -d ${path.join(data, "runtime/candidates/id/home")}`,
    proxyState: `HTTPEnable : 1
HTTPProxy : 127.0.0.1`,
    systemApplicationsDirectory: applications,
  });

  assert.equal(inspection.blockers.length, 3);
  assert.throws(() => applyMacOsAppCleanup(inspection), /blocked/u);
});

test("loopback proxy detection requires an enabled supported proxy kind", () => {
  assert.equal(hasEnabledLoopbackSystemProxy("HTTPEnable : 0\nHTTPProxy : 127.0.0.1\n"), false);
  assert.equal(hasEnabledLoopbackSystemProxy("HTTPEnable : 1\nHTTPProxy : proxy.example\n"), false);
  assert.equal(hasEnabledLoopbackSystemProxy("SOCKSEnable : 1\nSOCKSProxy : localhost\n"), true);
});

test("apply unregisters launch agents and trashes only inspected targets", () => {
  const calls: string[][] = [];
  const targets = ["/fixture/Applications/Mish.app", "/fixture/Library/LaunchAgents/Mish.plist"];

  applyMacOsAppCleanup(
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
      applyMacOsAppCleanup(
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

test("subcommands require explicit apply for every mutating action", () => {
  assert.deepEqual(parseMacOsAppCleanupArguments([]), { action: "inspect", apply: false });
  assert.deepEqual(parseMacOsAppCleanupArguments(["--", "all", "--apply"]), {
    action: "all",
    apply: true,
  });
  assert.throws(() => parseMacOsAppCleanupArguments(["inspect", "--apply"]), /Usage/u);
  assert.throws(() => parseMacOsAppCleanupArguments(["unknown"]), /Usage/u);
});

test("safe stop uses only application-level Quit and waits for owned processes", async () => {
  let running = true;
  const calls: string[][] = [];
  await safelyStopMish({
    appDataRoot: "/fixture/Library/Application Support/com.asuka109.mish",
    installedDesktopExecutables: ["/Applications/Mish.app/Contents/MacOS/mish-desktop"],
    pause: async () => {},
    readProcessTable: () =>
      running ? "42 1 /Applications/Mish.app/Contents/MacOS/mish-desktop" : "",
    run: (executable, arguments_) => {
      calls.push([executable, ...arguments_]);
      running = false;
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [
    ["/usr/bin/osascript", "-e", 'tell application "/Applications/Mish.app" to quit'],
  ]);
  assert.equal(calls.flat().includes("/bin/kill"), false);
});

test("force stop targets only re-confirmed Mish PIDs with TERM then KILL", async () => {
  const alive = new Set([42, 43]);
  const calls: string[][] = [];
  const processTable = () =>
    [...alive]
      .map((pid) =>
        pid === 42
          ? `${pid} 1 /Applications/Mish.app/Contents/MacOS/mish-desktop`
          : `${pid} 42 /tmp/mihomo-darwin -d /fixture/Library/Application Support/com.asuka109.mish/runtime/candidates/id/home`,
      )
      .join("\n");

  await forceStopMish({
    appDataRoot: "/fixture/Library/Application Support/com.asuka109.mish",
    installedDesktopExecutables: ["/Applications/Mish.app/Contents/MacOS/mish-desktop"],
    pause: async () => {},
    readProcessTable: processTable,
    run: (executable, arguments_) => {
      calls.push([executable, ...arguments_]);
      if (arguments_[0] === "-KILL") alive.delete(Number(arguments_[1]));
      return { status: 0 };
    },
  });

  assert.deepEqual(calls, [
    ["/bin/kill", "-TERM", "42"],
    ["/bin/kill", "-TERM", "43"],
    ["/bin/kill", "-KILL", "42"],
    ["/bin/kill", "-KILL", "43"],
  ]);
});

test("process controls refuse a Mish instance running from another worktree", async () => {
  const options = {
    appDataRoot: "/fixture/Library/Application Support/com.asuka109.mish",
    installedDesktopExecutables: ["/Applications/Mish.app/Contents/MacOS/mish-desktop"],
    pause: async () => {},
    readProcessTable: () =>
      `42 1 /fixture/worktree/target/release/mish-desktop
43 42 /tmp/mihomo-darwin -d /fixture/Library/Application Support/com.asuka109.mish/runtime/candidates/id/home`,
    run: () => ({ status: 0 }),
  };

  await assert.rejects(() => safelyStopMish(options), /No running installed Mish/u);
  await assert.rejects(() => forceStopMish(options), /No running installed Mish/u);
});

test("proxy reset delegates exact restoration to the journal-aware platform adapter", () => {
  const { home } = fixture();
  const appDataRoot = path.join(home, "Library/Application Support/com.asuka109.mish");
  const journal = path.join(appDataRoot, "system-proxy-journal.json");
  mkdirSync(appDataRoot, { recursive: true });
  writeFileSync(journal, '{"fixture":true}');
  writeFileSync(
    path.join(appDataRoot, "settings.json"),
    JSON.stringify({ preferences: { managedPorts: { proxy: 7890 } } }),
  );
  const calls: string[][] = [];

  restoreOwnedSystemProxy(
    home,
    appDataRoot,
    (executable, arguments_) => {
      calls.push([executable, ...arguments_]);
      unlinkSync(journal);
      return { status: 0 };
    },
    "/fixture/cargo",
  );

  assert.deepEqual(calls, [
    [
      "/fixture/cargo",
      "run",
      "--quiet",
      "-p",
      "mish-platform-macos",
      "--bin",
      "mish-macos-proxy-reset",
      "--",
      journal,
      "7890",
    ],
  ]);
});
