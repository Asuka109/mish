import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildDevelopmentServiceUninstallScript,
  resolveStableCargo,
} from "./manage-macos-tun-service.ts";

function writePinnedCoreFixture(workspace: string) {
  const sourceCore = path.join(workspace, ".scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29");
  const contents = "#!/bin/sh\nprintf 'Mihomo Meta v1.19.29 darwin arm64\\n'\n";
  mkdirSync(path.dirname(sourceCore), { recursive: true });
  writeFileSync(sourceCore, contents);
  chmodSync(sourceCore, 0o755);
  const manifest = {
    schemaVersion: 1,
    repository: "MetaCubeX/mihomo",
    version: "v1.19.29",
    asset: "mihomo-darwin-arm64-v1.19.29.gz",
    archiveSha256: "a".repeat(64),
    binarySha256: createHash("sha256").update(contents).digest("hex"),
  };
  const manifestPath = path.join(workspace, "resources/mihomo/macos-arm64.json");
  mkdirSync(path.dirname(manifestPath), { recursive: true });
  writeFileSync(manifestPath, JSON.stringify(manifest));
  return { manifestPath, sourceCore };
}

function discoveryFixture(executables: string[], output: string) {
  const calls: Array<{ args: string[]; executable: string }> = [];
  return {
    calls,
    options: {
      environment: {
        HOME: "/users/developer",
        MISH_TUN_RUSTUP: "/injected tools/rustup",
        PATH: "/path tools:/usr/bin",
      },
      execute: (executable: string, args: string[]) => {
        calls.push({ executable, args });
        return output;
      },
      isExecutable: (candidate: string) => executables.includes(candidate),
    },
  };
}

test("uses the explicit Rustup injection before Cargo home, Homebrew, and PATH", () => {
  const fixture = discoveryFixture(
    ["/injected tools/rustup", "/cargo with spaces/bin/cargo"],
    "/cargo with spaces/bin/cargo\n",
  );
  fixture.options.environment.CARGO_HOME = "/other-cargo";
  assert.deepEqual(resolveStableCargo(fixture.options), {
    cargo: "/cargo with spaces/bin/cargo",
    rustup: "/injected tools/rustup",
  });
  assert.deepEqual(fixture.calls, [
    {
      executable: "/injected tools/rustup",
      args: ["which", "cargo", "--toolchain", "stable"],
    },
  ]);
});

test("discovers rustup.rs Cargo home, both Homebrew prefixes, and absolute PATH entries", () => {
  const layouts = [
    { rustup: "/users/developer/.cargo/bin/rustup", environment: {} },
    { rustup: "/custom-cargo/bin/rustup", environment: { CARGO_HOME: "/custom-cargo" } },
    { rustup: "/opt/homebrew/bin/rustup", environment: {} },
    { rustup: "/usr/local/bin/rustup", environment: {} },
    { rustup: "/custom tools/rustup", environment: { PATH: "/custom tools:relative:/usr/bin" } },
  ];
  for (const layout of layouts) {
    const calls: string[] = [];
    const cargo = "/stable/bin/cargo";
    assert.deepEqual(
      resolveStableCargo({
        environment: { HOME: "/users/developer", ...layout.environment },
        homeDirectory: "/users/developer",
        execute: (executable) => {
          calls.push(executable);
          return `${cargo}\n`;
        },
        isExecutable: (candidate) => candidate === layout.rustup || candidate === cargo,
      }),
      { cargo, rustup: layout.rustup },
    );
    assert.deepEqual(calls, [layout.rustup]);
  }
});

test("reports bounded typed failures for unavailable, invalid, malformed, and absent stable Cargo", () => {
  assert.throws(
    () =>
      resolveStableCargo({
        environment: { HOME: "/users/developer", PATH: "relative" },
        isExecutable: () => false,
      }),
    /rustup: rustup-unavailable/u,
  );
  assert.throws(
    () =>
      resolveStableCargo({
        environment: { MISH_TUN_RUSTUP: "/not-executable" },
        isExecutable: () => false,
      }),
    /rustup: rustup-candidate-invalid/u,
  );
  const malformed = discoveryFixture(["/injected tools/rustup"], "not-an-absolute-path\n");
  assert.throws(() => resolveStableCargo(malformed.options), /cargo: stable-cargo-invalid/u);
  const missingStable = discoveryFixture(["/injected tools/rustup"], "/stable/bin/cargo\n");
  missingStable.options.execute = () => {
    throw new Error("stable is not installed");
  };
  assert.throws(
    () => resolveStableCargo(missingStable.options),
    /cargo: stable-cargo-unavailable/u,
  );
});

test("uninstall moves only fixed service targets into a recoverable Trash quarantine", () => {
  const script = buildDevelopmentServiceUninstallScript(
    501,
    20,
    "/Users/developer/.Trash/Mish Core Host Uninstall fixture",
  );

  assert.match(script, /launchctl' 'bootout' 'system\/com\.asuka109\.mish\.tun-helper\.dev/u);
  for (const target of [
    "/Library/LaunchDaemons/com.asuka109.mish.tun-helper.dev.plist",
    "/Library/PrivilegedHelperTools/com.asuka109.mish.tun-helper.dev",
    "/Library/PrivilegedHelperTools/com.asuka109.mish.mihomo.dev",
    "/var/run/com.asuka109.mish.tun-helper.501.sock",
    "/var/run/com.asuka109.mish.tun-helper.501.sock.state",
  ]) {
    assert.ok(script.includes(`'${target}'`));
  }
  assert.match(script, /'\/bin\/mv'/u);
  assert.match(script, /'\/usr\/sbin\/chown' '-R' '501:20'/u);
  assert.doesNotMatch(script, /\/bin\/rm|\/usr\/bin\/trash/u);
});

test(
  "prepares with injected executables without authorization, installation, Core download, or network mutation",
  { skip: process.platform !== "darwin" },
  () => {
    using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish tun toolchain "));
    const workspace = temporary.path;
    const tools = path.join(workspace, "tool chain");
    const cargo = path.join(tools, "cargo stable");
    const rustup = path.join(tools, "rustup");
    const commandLog = path.join(workspace, "commands.log");
    writePinnedCoreFixture(workspace);
    mkdirSync(tools, { recursive: true });
    writeFileSync(
      cargo,
      `#!/bin/sh\nprintf 'cargo:%s\\n' "$*" >> '${commandLog}'\nmkdir -p target/debug\nprintf helper > target/debug/mish-tun-helper\nchmod 755 target/debug/mish-tun-helper\n`,
    );
    writeFileSync(
      rustup,
      `#!/bin/sh\nprintf 'rustup:%s\\n' "$*" >> '${commandLog}'\nprintf '%s\\n' '${cargo}'\n`,
    );
    chmodSync(cargo, 0o755);
    chmodSync(rustup, 0o755);

    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/manage-macos-tun-service.ts"), "prepare"],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          HOME: path.join(workspace, "home"),
          MISH_TUN_RUSTUP: rustup,
          PATH: process.env.PATH,
        },
      },
    );
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { ok: true, stage: "prepared" });
    assert.deepEqual(readFileSync(commandLog, "utf8").trim().split("\n"), [
      "rustup:which cargo --toolchain stable",
      "cargo:build -p mish-platform-macos --features development-core-host --bin mish-tun-helper --bin mish-core-host-ctl",
    ]);
  },
);

test(
  "returns a typed Cargo build failure without entering the privileged installation path",
  { skip: process.platform !== "darwin" },
  () => {
    using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish tun cargo failure "));
    const workspace = temporary.path;
    const rustup = path.join(workspace, "rustup");
    const cargo = path.join(workspace, "cargo");
    writePinnedCoreFixture(workspace);
    writeFileSync(cargo, "#!/bin/sh\nexit 1\n");
    writeFileSync(rustup, `#!/bin/sh\nprintf '%s\\n' '${cargo}'\n`);
    chmodSync(cargo, 0o755);
    chmodSync(rustup, 0o755);

    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/manage-macos-tun-service.ts"), "prepare"],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          HOME: path.join(workspace, "home"),
          MISH_TUN_RUSTUP: rustup,
          PATH: process.env.PATH,
        },
      },
    );
    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      code: "cargo-build-failed",
      kind: "preparation-failed",
      ok: false,
      stage: "helper-build",
    });
  },
);

test(
  "rejects a replaced pinned Core before toolchain discovery or authorization",
  { skip: process.platform !== "darwin" },
  () => {
    using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish core digest failure "));
    const workspace = temporary.path;
    const { sourceCore } = writePinnedCoreFixture(workspace);
    writeFileSync(
      sourceCore,
      "#!/bin/sh\nprintf 'Mihomo Meta v1.19.29 darwin arm64 replaced\\n'\n",
    );
    chmodSync(sourceCore, 0o755);

    const result = spawnSync(
      process.execPath,
      [path.resolve("scripts/manage-macos-tun-service.ts"), "prepare"],
      {
        cwd: workspace,
        encoding: "utf8",
        env: {
          HOME: path.join(workspace, "home"),
          PATH: process.env.PATH,
        },
      },
    );

    assert.equal(result.status, 1);
    assert.deepEqual(JSON.parse(result.stdout), {
      code: "pinned-core-digest-mismatch",
      kind: "preparation-failed",
      ok: false,
      stage: "core-artifact",
    });
  },
);
