import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  buildDevelopmentServiceUninstallScript,
  buildInstallationDiscoveryRequest,
  buildRotationRequest,
  canonicalRotationTranscript,
  classifyDevelopmentTunInstallation,
  classifyDevelopmentTunSocketArtifacts,
  ensureInstallationClientKey,
  finalizePendingKeyIfEnrolled,
  parseDevelopmentServiceArguments,
  resolveStableCargo,
  safeDevelopmentTunSocketMetadata,
  selectDevelopmentTunLifecycleAction,
  selectObservedClientIdentity,
} from "./manage-macos-tun-service.ts";

test("classifies a running Mish service with installed artifacts and a missing enrollment as safe partial", () => {
  for (const discovery of ["matching", "missing"] as const) {
    assert.deepEqual(
      classifyDevelopmentTunInstallation({
        artifacts: "mish-owned",
        clientIdentity: "present",
        discovery,
        enrollmentIdentity: "missing",
        service: "running",
      }),
      {
        installation: "repair-required",
        reason: "missing-enrollment",
      },
    );
  }
});

test("keeps a complete development TUN identity distinct from version and protocol mismatch", () => {
  const complete = {
    artifacts: "mish-owned" as const,
    clientIdentity: "present" as const,
    enrollmentIdentity: "matches-client" as const,
    service: "running" as const,
  };

  assert.deepEqual(classifyDevelopmentTunInstallation({ ...complete, discovery: "matching" }), {
    installation: "installed",
    reason: "healthy",
  });
  assert.deepEqual(
    classifyDevelopmentTunInstallation({ ...complete, discovery: "version-mismatch" }),
    { installation: "repair-required", reason: "version-mismatch" },
  );
  assert.deepEqual(
    classifyDevelopmentTunInstallation({ ...complete, discovery: "protocol-mismatch" }),
    { installation: "repair-required", reason: "protocol-mismatch" },
  );
  assert.deepEqual(classifyDevelopmentTunInstallation({ ...complete, discovery: "missing" }), {
    installation: "repair-required",
    reason: "missing-socket",
  });
});

test("replays an interrupted committed key rotation as serialized repair, not foreign recovery", () => {
  const active = { keyId: "a".repeat(64), publicKeySpki: "active" };
  const pending = { keyId: "b".repeat(64), publicKeySpki: "pending" };
  assert.deepEqual(selectObservedClientIdentity(active, pending, pending.keyId), {
    clientIdentity: "pending-commit",
    ...pending,
  });
  assert.deepEqual(selectObservedClientIdentity(active, pending, "c".repeat(64)), {
    clientIdentity: "present",
    ...active,
  });
  assert.deepEqual(selectObservedClientIdentity(undefined, pending, "c".repeat(64)), {
    clientIdentity: "present",
    ...pending,
  });
  assert.deepEqual(
    classifyDevelopmentTunInstallation({
      artifacts: "mish-owned",
      clientIdentity: "pending-commit",
      discovery: "matching",
      enrollmentIdentity: "matches-client",
      service: "running",
    }),
    {
      installation: "repair-required",
      reason: "pending-client-key",
    },
  );
  assert.deepEqual(
    classifyDevelopmentTunInstallation({
      artifacts: "mish-owned",
      clientIdentity: "present",
      discovery: "matching",
      enrollmentIdentity: "mismatches-client",
      service: "running",
    }),
    {
      installation: "recovery-required",
      reason: "client-enrollment-mismatch",
    },
  );
});

test("promotes successful reset and rotation private and public records together", async () => {
  using fixture = mkdtempDisposableSync(path.join(tmpdir(), "mish-tun-key-promotion-"));
  const uid = process.getuid!();
  const records = {
    activeClientKey: path.join(fixture.path, "client.json"),
    activeEnrollment: path.join(fixture.path, "enrollment.json"),
    pendingClientKey: path.join(fixture.path, "client.pending.json"),
    pendingEnrollment: path.join(fixture.path, "enrollment.pending.json"),
  };
  const pending = await ensureInstallationClientKey(records.pendingClientKey, uid);
  const installationId = "c".repeat(64);
  const candidate = {
    algorithm: "p256-sha256",
    helperInstallationId: installationId,
    installingUid: uid,
    keyId: pending.keyId,
    publicKeySpki: pending.publicKeySpki,
    schemaVersion: 1,
  };
  writeFileSync(records.pendingEnrollment, `${JSON.stringify(candidate)}\n`, { mode: 0o600 });
  chmodSync(records.pendingEnrollment, 0o600);

  await finalizePendingKeyIfEnrolled(
    "/unused-by-known-discovery.sock",
    uid,
    {
      algorithm: "p256-sha256",
      generation: 2,
      helperVersion: "6",
      installationId,
      keyId: pending.keyId,
      protocolVersion: 3,
    },
    records,
  );

  assert.deepEqual(JSON.parse(readFileSync(records.activeClientKey, "utf8")), pending);
  assert.deepEqual(JSON.parse(readFileSync(records.activeEnrollment, "utf8")), candidate);
  assert.equal(existsSync(records.pendingClientKey), false);
  assert.equal(existsSync(records.pendingEnrollment), false);
  assert.deepEqual(
    classifyDevelopmentTunInstallation({
      artifacts: "mish-owned",
      clientIdentity: "present",
      discovery: "matching",
      enrollmentIdentity: "matches-client",
      service: "running",
    }),
    { installation: "installed", reason: "healthy" },
  );
});

test("accepts only the production user-owned development socket metadata contract", () => {
  const uid = 501;
  const productionSocket = {
    isSocket: () => true,
    isSymbolicLink: () => false,
    mode: 0o140600,
    nlink: 1,
    uid,
  };
  assert.equal(safeDevelopmentTunSocketMetadata(productionSocket, uid), true);
  assert.equal(safeDevelopmentTunSocketMetadata({ ...productionSocket, uid: 0 }, uid), false);
  assert.equal(
    safeDevelopmentTunSocketMetadata({ ...productionSocket, mode: 0o140666 }, uid),
    false,
  );
  assert.equal(
    safeDevelopmentTunSocketMetadata({ ...productionSocket, isSymbolicLink: () => true }, uid),
    false,
  );
});

test("fails closed when the reserved socket survives clean artifact removal", () => {
  assert.equal(classifyDevelopmentTunSocketArtifacts("absent", "absent"), "absent");
  const orphanedSocketArtifacts = classifyDevelopmentTunSocketArtifacts("absent", "safe");
  assert.equal(orphanedSocketArtifacts, "ambiguous");
  assert.equal(classifyDevelopmentTunSocketArtifacts("absent", "unsafe"), "ambiguous");
  assert.equal(classifyDevelopmentTunSocketArtifacts("mish-owned", "safe"), "mish-owned");
  assert.equal(classifyDevelopmentTunSocketArtifacts("mish-owned", "unsafe"), "ambiguous");
  assert.deepEqual(
    classifyDevelopmentTunInstallation({
      artifacts: orphanedSocketArtifacts,
      clientIdentity: "missing",
      discovery: "missing",
      enrollmentIdentity: "missing",
      service: "not-running",
    }),
    { installation: "recovery-required", reason: "ambiguous-artifacts" },
  );
});

test("routes a lost client key through the existing serialized reset-key repair", () => {
  const missingClientKey = classifyDevelopmentTunInstallation({
    artifacts: "mish-owned",
    clientIdentity: "missing",
    discovery: "missing",
    enrollmentIdentity: "missing",
    service: "running",
  });
  assert.equal(selectDevelopmentTunLifecycleAction("repair", missingClientKey), "reset-key");
  assert.equal(
    selectDevelopmentTunLifecycleAction("repair", {
      installation: "repair-required",
      reason: "missing-enrollment",
    }),
    "repair",
  );
  assert.equal(
    selectDevelopmentTunLifecycleAction("install", {
      installation: "repair-required",
      reason: "missing-client-key",
    }),
    "install",
  );
  assert.throws(
    () =>
      selectDevelopmentTunLifecycleAction("repair", {
        installation: "recovery-required",
        reason: "ambiguous-artifacts",
      }),
    /repair-identity-not-admitted/u,
  );
});

test("status never traverses the root-only enrollment directory", () => {
  const source = readFileSync(new URL("./manage-macos-tun-service.ts", import.meta.url), "utf8");
  const observation = source.slice(
    source.indexOf("async function observeDevelopmentTunInstallation"),
    source.indexOf("type ToolchainEnvironment"),
  );
  assert.doesNotMatch(observation, /lstat\(enrollmentTarget\)/u);
  assert.ok(
    observation.indexOf("classifyObservedEnrollment(") <
      observation.lastIndexOf("observeDevelopmentTunSocket(socketPath"),
    "the user-owned enrollment candidate must preserve missing-socket classification",
  );
});

test("keeps clean absence, verified Mish-owned partial identity, and unsafe artifacts distinct", () => {
  assert.deepEqual(
    classifyDevelopmentTunInstallation({
      artifacts: "absent",
      clientIdentity: "missing",
      discovery: "missing",
      enrollmentIdentity: "missing",
      service: "not-running",
    }),
    { installation: "not-installed", reason: "clean-absence" },
  );
  assert.deepEqual(
    classifyDevelopmentTunInstallation({
      artifacts: "partial",
      clientIdentity: "present",
      discovery: "missing",
      enrollmentIdentity: "missing",
      service: "running",
    }),
    { installation: "recovery-required", reason: "partial-artifacts" },
  );
  assert.deepEqual(
    classifyDevelopmentTunInstallation({
      artifacts: "mish-owned",
      clientIdentity: "missing",
      discovery: "missing",
      enrollmentIdentity: "missing",
      service: "not-running",
    }),
    { installation: "repair-required", reason: "missing-client-key" },
  );
  for (const artifacts of ["ambiguous", "foreign"] as const) {
    assert.deepEqual(
      classifyDevelopmentTunInstallation({
        artifacts,
        clientIdentity: "present",
        discovery: "mismatched",
        enrollmentIdentity: "mismatches-client",
        service: "running",
      }),
      {
        installation: "recovery-required",
        reason: artifacts === "foreign" ? "foreign-artifacts" : "ambiguous-artifacts",
      },
    );
  }
  assert.deepEqual(
    classifyDevelopmentTunInstallation({
      artifacts: "mish-owned",
      clientIdentity: "present",
      discovery: "mismatched",
      enrollmentIdentity: "stale-installation",
      service: "running",
    }),
    { installation: "repair-required", reason: "installation-identity-mismatch" },
  );
  assert.deepEqual(
    classifyDevelopmentTunInstallation({
      artifacts: "mish-owned",
      clientIdentity: "present",
      discovery: "mismatched",
      enrollmentIdentity: "mismatches-client",
      service: "running",
    }),
    { installation: "recovery-required", reason: "client-enrollment-mismatch" },
  );
});

test("discovery request uses the Rust enum field names at the framed boundary", () => {
  const requestId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(buildInstallationDiscoveryRequest(requestId), {
    command: { kind: "health" },
    kind: "discovery",
    protocol_version: 3,
    request_id: requestId,
  });
  assert.equal(buildInstallationDiscoveryRequest(requestId, 2).protocol_version, 2);
});

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

test("uninstall deletes the public enrollment and moves only non-key targets to Trash", () => {
  const script = buildDevelopmentServiceUninstallScript(
    501,
    20,
    "/Users/developer/.Trash/Mish Core Host Uninstall fixture",
  );

  assert.match(script, /launchctl' 'bootout' 'system\/com\.asuka109\.mish\.tun-helper\.dev/u);
  assert.match(
    script,
    /if \[ -x '\/Library\/PrivilegedHelperTools\/com\.asuka109\.mish\.tun-helper\.dev' \]; then '\/usr\/bin\/env' 'MISH_TUN_SERVICE_ALLOWED_UID=501' 'MISH_TUN_SERVICE_ENROLLMENT_RECORD=\/Library\/Application Support\/com\.asuka109\.mish\/tun-helper-dev\/enrollment\.json' '\/Library\/PrivilegedHelperTools\/com\.asuka109\.mish\.tun-helper\.dev' '--remove-enrollment'/u,
  );
  assert.match(
    script,
    /else '\/bin\/rmdir' '\/Library\/Application Support\/com\.asuka109\.mish\/tun-helper-dev' >\/dev\/null 2>&1 \|\| true; fi/u,
  );
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
  assert.doesNotMatch(
    script,
    /'\/bin\/mv' '\/Library\/Application Support\/com\.asuka109\.mish\/tun-helper-dev'/u,
  );
  assert.doesNotMatch(script, /'\/bin\/rm'|\/usr\/bin\/trash/u);
});

test("accepts TUN only behind exact development or Tart boundaries", () => {
  assert.deepEqual(parseDevelopmentServiceArguments(["install"]), {
    action: "install",
    developmentTun: false,
    tartTerminalAuthorization: false,
    tartTunAcceptance: false,
  });
  assert.deepEqual(parseDevelopmentServiceArguments(["install", "--development-tun"]), {
    action: "install",
    developmentTun: true,
    tartTerminalAuthorization: false,
    tartTunAcceptance: false,
  });
  assert.deepEqual(parseDevelopmentServiceArguments(["install", "--tart-tun-acceptance"]), {
    action: "install",
    developmentTun: false,
    tartTerminalAuthorization: false,
    tartTunAcceptance: true,
  });
  assert.deepEqual(parseDevelopmentServiceArguments(["rotate-key"]), {
    action: "rotate-key",
    developmentTun: false,
    tartTerminalAuthorization: false,
    tartTunAcceptance: false,
  });
  assert.deepEqual(
    parseDevelopmentServiceArguments([
      "reset-key",
      "--tart-tun-acceptance",
      "--tart-terminal-authorization",
    ]),
    {
      action: "reset-key",
      developmentTun: false,
      tartTerminalAuthorization: true,
      tartTunAcceptance: true,
    },
  );
  assert.deepEqual(
    parseDevelopmentServiceArguments([
      "install",
      "--tart-tun-acceptance",
      "--tart-terminal-authorization",
    ]),
    {
      action: "install",
      developmentTun: false,
      tartTerminalAuthorization: true,
      tartTunAcceptance: true,
    },
  );
  for (const arguments_ of [
    ["install", "--tun"],
    ["install", "--tart-tun-acceptance=true"],
    ["install", "--tart-tun-acceptance", "--tart-tun-acceptance"],
    ["install", "--development-tun", "--tart-tun-acceptance"],
    ["install", "--tart-terminal-authorization"],
    ["prepare", "--tart-tun-acceptance", "--tart-terminal-authorization"],
  ]) {
    assert.throws(() => parseDevelopmentServiceArguments(arguments_), /Usage:/u);
  }
});

test("persists one reusable P-256 client key in a user-owned mode-0600 record", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish installation key "));
  const runtime = path.join(temporary.path, "runtime");
  mkdirSync(runtime, { mode: 0o700 });
  const uid = process.getuid!();
  const keyPath = path.join(runtime, "tun-client-key.json");

  const first = await ensureInstallationClientKey(keyPath, uid);
  const second = await ensureInstallationClientKey(keyPath, uid);

  assert.equal(first.algorithm, "p256-sha256");
  assert.equal(first.schemaVersion, 1);
  assert.match(first.keyId, /^[a-f0-9]{64}$/u);
  assert.equal(second.keyId, first.keyId);
  assert.equal(second.privateKeyPkcs8, first.privateKeyPkcs8);
  const metadata = statSync(keyPath);
  assert.equal(metadata.uid, uid);
  assert.equal(metadata.mode & 0o777, 0o600);
  assert.equal(metadata.nlink, 1);
});

test("rotation transcript matches Rust and both signatures cover the replacement", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish rotation keys "));
  const runtime = path.join(temporary.path, "runtime");
  mkdirSync(runtime, { mode: 0o700 });
  const uid = process.getuid!();
  const current = await ensureInstallationClientKey(path.join(runtime, "current.json"), uid);
  const replacement = await ensureInstallationClientKey(
    path.join(runtime, "replacement.json"),
    uid,
  );
  const request = buildRotationRequest(
    current,
    replacement,
    {
      algorithm: "p256-sha256",
      generation: 7,
      installationId: "a".repeat(64),
      keyId: current.keyId,
      protocolVersion: 3,
    },
    uid,
  );
  assert.notEqual(request.oldSignature, request.newSignature);
  assert.equal(request.currentGeneration, 7);
  assert.equal(request.replacementKeyId, replacement.keyId);

  const vector = {
    ...request,
    currentKeyId: "b".repeat(64),
    installingUid: 501,
    newSignature: "",
    oldSignature: "",
    replacementKeyId: "c".repeat(64),
    replacementPublicKeySpki: Buffer.from([1, 2, 3]).toString("base64"),
  };
  assert.equal(
    createHash("sha256").update(canonicalRotationTranscript(vector)).digest("hex"),
    "dc0e227c96271cf1f957732e703b489bea0d41c3318284fb332aa23b45ebfd57",
  );
});

test(
  "prepares development TUN without authorization, installation, Core download, or network mutation",
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
      [path.resolve("scripts/manage-macos-tun-service.ts"), "prepare", "--development-tun"],
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
    const preparedPlist = readFileSync(
      path.join(
        workspace,
        "home/Library/Application Support/com.asuka109.mish/runtime/tun-service-installer/com.asuka109.mish.tun-helper.dev.plist",
      ),
      "utf8",
    );
    assert.match(preparedPlist, /<key>MISH_TUN_SERVICE_ALLOW_TUN<\/key><string>1<\/string>/u);
    assert.match(
      preparedPlist,
      /<key>MISH_TUN_SERVICE_ENROLLMENT_RECORD<\/key><string>\/Library\/Application Support\/com\.asuka109\.mish\/tun-helper-dev\/enrollment\.json<\/string>/u,
    );
    const preparedPrivateKey = readFileSync(
      path.join(
        workspace,
        "home/Library/Application Support/com.asuka109.mish/runtime/tun-client-key.json",
      ),
      "utf8",
    );
    const preparedEnrollment = readFileSync(
      path.join(
        workspace,
        "home/Library/Application Support/com.asuka109.mish/runtime/tun-service-installer/enrollment.json",
      ),
      "utf8",
    );
    assert.equal(
      statSync(
        path.join(
          workspace,
          "home/Library/Application Support/com.asuka109.mish/runtime/tun-client-key.json",
        ),
      ).mode & 0o777,
      0o600,
    );
    assert.match(preparedPrivateKey, /"privateKeyPkcs8":/u);
    assert.doesNotMatch(preparedEnrollment, /privateKey|privateKeyPkcs8/u);
    assert.doesNotMatch(preparedPlist, /privateKey|privateKeyPkcs8/u);
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
