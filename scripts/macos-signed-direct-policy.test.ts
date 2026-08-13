import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type SignedDirectEvidence,
  SignedDirectTranscriptRecorder,
  alphaAdHocProfile,
  collectSignedDirectBundleEntries,
  collectSignedDirectSignature,
  parseDeveloperIdApplicationIdentity,
  protectedReleaseBoundary,
  recordSignedDirectStrictVerification,
  resolveMacOsReleaseProfile,
  signedDirectApplicationIdentifier,
  signedDirectMainExecutable,
  signedDirectMihomoExecutable,
  signedDirectMihomoIdentifier,
  signedDirectSigningOrder,
  signedDirectTranscriptMaxEvents,
  validateSignedDirectTranscript,
  verifyCompleteSignedDirectTranscript,
  verifySignedDirectEvidence,
  verifySignedDirectStrict,
} from "./macos-signed-direct-policy.ts";

const identity = "Developer ID Application: Mish Fixture (ABCDE12345)";
const macOsOnly = { skip: process.platform !== "darwin" };

function signedDirectEnvironment(): NodeJS.ProcessEnv {
  return {
    APPLE_SIGNING_IDENTITY: identity,
    MISH_EXPECTED_APPLE_TEAM_IDENTIFIER: "ABCDE12345",
    MISH_PROTECTED_RELEASE_ENVIRONMENT: protectedReleaseBoundary,
  };
}

function fixture(): SignedDirectEvidence {
  return {
    advertisedTun: false,
    entries: [
      {
        executable: false,
        kind: "directory",
        mode: 0o40555,
        nlink: 1,
        path: "Contents",
      },
      {
        executable: true,
        kind: "file",
        mode: 0o100555,
        nlink: 1,
        path: signedDirectMainExecutable,
      },
      {
        executable: true,
        kind: "file",
        mode: 0o100555,
        nlink: 1,
        path: signedDirectMihomoExecutable,
      },
      {
        executable: false,
        kind: "file",
        mode: 0o100444,
        nlink: 1,
        path: "Contents/Resources/web-dist/index.html",
      },
    ],
    expectedIdentity: {
      identity,
      teamIdentifier: "ABCDE12345",
    },
    signatures: [
      {
        entitlements: [],
        hardenedRuntime: true,
        identifier: signedDirectMihomoIdentifier,
        identity,
        path: signedDirectMihomoExecutable,
        signed: true,
        teamIdentifier: "ABCDE12345",
      },
      {
        entitlements: [],
        hardenedRuntime: true,
        identifier: signedDirectApplicationIdentifier,
        identity,
        path: "Mish.app",
        signed: true,
        teamIdentifier: "ABCDE12345",
      },
    ],
    signingOrder: [...signedDirectSigningOrder],
  };
}

test("release profile selection is explicit and independent from signing inputs", () => {
  assert.throws(
    () => resolveMacOsReleaseProfile([], {}),
    /Select an explicit macOS release profile/u,
  );
  assert.throws(
    () => resolveMacOsReleaseProfile([], signedDirectEnvironment()),
    /Select an explicit macOS release profile/u,
  );
  assert.deepEqual(resolveMacOsReleaseProfile(["--profile", alphaAdHocProfile], {}), {
    identity: "-",
    profile: alphaAdHocProfile,
    teamIdentifier: null,
  });
  assert.deepEqual(
    resolveMacOsReleaseProfile(["--profile", alphaAdHocProfile, "--open-dmg"], {
      APPLE_SIGNING_IDENTITY: "-",
    }),
    {
      identity: "-",
      profile: alphaAdHocProfile,
      teamIdentifier: null,
    },
  );
  assert.throws(
    () =>
      resolveMacOsReleaseProfile(["--profile", alphaAdHocProfile], {
        APPLE_SIGNING_IDENTITY: identity,
      }),
    /requires APPLE_SIGNING_IDENTITY=-/u,
  );
  assert.throws(
    () =>
      resolveMacOsReleaseProfile(["--profile", alphaAdHocProfile], {
        APPLE_SIGNING_IDENTITY: "-",
        MISH_APPLE_CERTIFICATE_BASE64: "fixture",
      }),
    /rejects Apple credential variable/u,
  );
});

test("signed-direct accepts only a protected synthetic Developer ID boundary", () => {
  assert.deepEqual(parseDeveloperIdApplicationIdentity(identity), {
    identity,
    teamIdentifier: "ABCDE12345",
  });
  assert.deepEqual(
    resolveMacOsReleaseProfile(["--profile", "signed-direct"], signedDirectEnvironment()),
    {
      identity,
      profile: "signed-direct",
      teamIdentifier: "ABCDE12345",
    },
  );
  assert.throws(
    () =>
      resolveMacOsReleaseProfile(["--profile", "signed-direct"], {
        APPLE_SIGNING_IDENTITY: identity,
        MISH_EXPECTED_APPLE_TEAM_IDENTIFIER: "ABCDE12345",
      }),
    /protected release boundary/u,
  );
  assert.throws(
    () =>
      resolveMacOsReleaseProfile(["--profile", "signed-direct"], {
        ...signedDirectEnvironment(),
        MISH_EXPECTED_APPLE_TEAM_IDENTIFIER: "ZZZZZ99999",
      }),
    /team identifier must match/u,
  );
  assert.throws(
    () =>
      resolveMacOsReleaseProfile(["--profile", "signed-direct"], {
        ...signedDirectEnvironment(),
        MISH_APPLE_CERTIFICATE_BASE64: "fixture",
      }),
    /must not receive raw credential/u,
  );
  assert.throws(
    () =>
      resolveMacOsReleaseProfile(["--profile", "signed-direct"], {
        ...signedDirectEnvironment(),
        APPLE_SIGNING_IDENTITY: "Apple Development: Fixture (ABCDE12345)",
      }),
    /requires a Developer ID Application identity/u,
  );
});

test("accepts the complete credential-free signed-direct contract fixture", () => {
  const recorder = new SignedDirectTranscriptRecorder();
  assert.doesNotThrow(() => verifySignedDirectEvidence(fixture(), recorder));
  recordSignedDirectStrictVerification(recorder, () => {});
  assert.deepEqual(verifyCompleteSignedDirectTranscript(recorder.snapshot()).events, [
    {
      effect: "profile-selection",
      result: "accepted",
      sequence: 1,
      subject: "release-profile",
    },
    {
      effect: "capability-probe",
      result: "tun-unavailable",
      sequence: 2,
      subject: "application",
    },
    {
      effect: "signing-order",
      result: "accepted",
      sequence: 3,
      subject: "nested-mihomo",
    },
    {
      effect: "signing-order",
      result: "accepted",
      sequence: 4,
      subject: "application",
    },
    {
      effect: "layout-inspection",
      result: "accepted",
      sequence: 5,
      subject: "bundle-layout",
    },
    {
      effect: "signature-inspection",
      result: "accepted",
      sequence: 6,
      subject: "nested-mihomo",
    },
    {
      effect: "signature-inspection",
      result: "accepted",
      sequence: 7,
      subject: "application",
    },
    {
      effect: "strict-verification",
      result: "strict-verified",
      sequence: 8,
      subject: "application",
    },
  ]);
  const checkedIn = JSON.parse(
    readFileSync(
      path.resolve(
        import.meta.dirname,
        "../docs/quality/fixtures/macos-signed-direct/signed-direct-transcript-v1.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(verifyCompleteSignedDirectTranscript(checkedIn), recorder.snapshot());
});

test("signed-direct transcript is closed, bounded, and contains no identity or path data", () => {
  const recorder = new SignedDirectTranscriptRecorder();
  verifySignedDirectEvidence(fixture(), recorder);
  recordSignedDirectStrictVerification(recorder, () => {});
  const serialized = JSON.stringify(recorder.snapshot());
  assert.ok(Buffer.byteLength(serialized, "utf8") < 4 * 1024);
  assert.doesNotMatch(serialized, /Developer ID|ABCDE12345|Contents\/|Mish\.app/u);
  assert.throws(
    () =>
      validateSignedDirectTranscript({
        ...recorder.snapshot(),
        identity,
      }),
    /unknown or missing fields/u,
  );
  assert.throws(
    () =>
      validateSignedDirectTranscript({
        ...recorder.snapshot(),
        events: [
          { effect: "arbitrary-command", result: "accepted", sequence: 1, subject: "application" },
        ],
      }),
    /open vocabulary/u,
  );
  const overflow = new SignedDirectTranscriptRecorder();
  for (let index = 0; index < signedDirectTranscriptMaxEvents; index += 1) {
    overflow.record("profile-selection", "release-profile", "accepted");
  }
  assert.throws(
    () => overflow.record("profile-selection", "release-profile", "accepted"),
    /event bound/u,
  );
});

test("signed-direct transcript terminates at the exact rejected boundary", () => {
  const tunEvidence = fixture();
  tunEvidence.advertisedTun = true;
  const tunRecorder = new SignedDirectTranscriptRecorder();
  assert.throws(() => verifySignedDirectEvidence(tunEvidence, tunRecorder), /TUN unavailable/u);
  assert.deepEqual(tunRecorder.snapshot().events.at(-1), {
    effect: "capability-probe",
    result: "rejected",
    sequence: 2,
    subject: "application",
  });

  const privilegedEvidence = fixture();
  privilegedEvidence.entries.push({
    executable: false,
    kind: "file",
    mode: 0o100444,
    nlink: 1,
    path: "Contents/Library/LaunchDaemons/com.asuka109.mish.plist",
  });
  const privilegedRecorder = new SignedDirectTranscriptRecorder();
  assert.throws(
    () => verifySignedDirectEvidence(privilegedEvidence, privilegedRecorder),
    /privileged content/u,
  );
  assert.deepEqual(privilegedRecorder.snapshot().events.at(-1), {
    effect: "layout-inspection",
    result: "rejected",
    sequence: 5,
    subject: "bundle-layout",
  });

  const strictRecorder = new SignedDirectTranscriptRecorder();
  verifySignedDirectEvidence(fixture(), strictRecorder);
  assert.throws(
    () =>
      recordSignedDirectStrictVerification(strictRecorder, () => {
        throw new Error("synthetic strict verification failed");
      }),
    /strict verification failed/u,
  );
  assert.deepEqual(strictRecorder.snapshot().events.at(-1), {
    effect: "strict-verification",
    result: "rejected",
    sequence: 8,
    subject: "application",
  });
  assert.throws(
    () => verifyCompleteSignedDirectTranscript(strictRecorder.snapshot()),
    /incomplete or out of order/u,
  );
});

test("scans a real credential-free Mach-O package fixture", macOsOnly, async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-signed-direct-package-"));
  const application = path.join(temporary.path, "Mish.app");
  const tauriRoot = path.resolve(import.meta.dirname, "../apps/desktop/src-tauri");
  const main = path.join(application, signedDirectMainExecutable);
  const mihomo = path.join(application, signedDirectMihomoExecutable);
  const webEntry = path.join(application, "Contents/Resources/web-dist/index.html");
  const info = path.join(application, "Contents/Info.plist");
  mkdirSync(path.dirname(main), { recursive: true });
  mkdirSync(path.dirname(mihomo), { recursive: true });
  mkdirSync(path.dirname(webEntry), { recursive: true });
  copyFileSync("/usr/bin/true", main);
  copyFileSync("/usr/bin/true", mihomo);
  writeFileSync(webEntry, "<!doctype html><title>Mish fixture</title>\n");
  writeFileSync(
    info,
    `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleExecutable</key><string>mish-desktop</string>
  <key>CFBundleIdentifier</key><string>${signedDirectApplicationIdentifier}</string>
  <key>CFBundleName</key><string>Mish</string>
  <key>CFBundlePackageType</key><string>APPL</string>
</dict>
</plist>
`,
  );
  chmodSync(main, 0o555);
  chmodSync(mihomo, 0o555);
  chmodSync(webEntry, 0o444);
  chmodSync(info, 0o444);
  execFileSync("codesign", [
    "--force",
    "--identifier",
    signedDirectMihomoIdentifier,
    "--options",
    "runtime",
    "--timestamp=none",
    "--sign",
    "-",
    mihomo,
  ]);
  execFileSync("codesign", [
    "--force",
    "--identifier",
    signedDirectApplicationIdentifier,
    "--options",
    "runtime",
    "--timestamp=none",
    "--entitlements",
    path.join(tauriRoot, "Entitlements.signed-direct.plist"),
    "--sign",
    "-",
    application,
  ]);
  verifySignedDirectStrict(application);

  const evidence = fixture();
  evidence.entries = await collectSignedDirectBundleEntries(application);
  evidence.signatures = [
    collectSignedDirectSignature(mihomo, signedDirectMihomoExecutable),
    collectSignedDirectSignature(application, "Mish.app"),
  ];
  for (const signature of evidence.signatures) {
    signature.identity = identity;
    signature.teamIdentifier = "ABCDE12345";
  }
  assert.doesNotThrow(() => verifySignedDirectEvidence(evidence));
});

test("signed-direct Tauri configuration pins hardened runtime and empty entitlements", () => {
  const root = path.resolve(import.meta.dirname, "../apps/desktop/src-tauri");
  const configuration = JSON.parse(
    readFileSync(path.join(root, "tauri.signed-direct.conf.json"), "utf8"),
  ) as {
    bundle?: {
      macOS?: {
        entitlements?: string;
        hardenedRuntime?: boolean;
      };
    };
  };
  assert.deepEqual(configuration, {
    bundle: {
      macOS: {
        entitlements: "./Entitlements.signed-direct.plist",
        hardenedRuntime: true,
      },
    },
  });
  const entitlements = readFileSync(path.join(root, "Entitlements.signed-direct.plist"), "utf8");
  assert.match(entitlements, /<dict\/>/u);
  assert.doesNotMatch(entitlements, /<key>/u);

  const builder = readFileSync(path.resolve(import.meta.dirname, "build-macos-bundle.ts"), "utf8");
  const nestedSigning = builder.indexOf(
    'execFileSync("codesign", signingArguments, { stdio: "inherit" })',
  );
  const applicationBundling = builder.indexOf(
    'execFileSync("pnpm", ["--filter", "@mish/desktop", bundleCommand]',
  );
  assert.ok(nestedSigning >= 0 && applicationBundling > nestedSigning);
  assert.match(builder, /resolveMacOsReleaseProfile\(arguments_, process\.env\)/u);
  assert.match(builder, /delete packageEnvironment\.MISH_MIHOMO_BIN/u);
  assert.match(
    builder,
    /const bundleMihomo = path\.resolve\("\.scratch\/macos-bundle\/mihomo-aarch64-apple-darwin"\)/u,
  );
  assert.match(builder, /readContainedReleaseFile\(mihomoGuard\)/u);
  assert.match(builder, /signingArguments\.push\("--sign", identity, stagedMihomo\.absolute\)/u);
  assert.match(builder, /Pinned Mihomo changed while staging the signed bundle resource/u);
  assert.doesNotMatch(builder, /signingArguments\.push\("--sign", identity, mihomo\)/u);

  const desktopRoot = path.resolve(import.meta.dirname, "../apps/desktop");
  const baseBundle = readFileSync(
    path.join(desktopRoot, "src-tauri/tauri.bundle.conf.json"),
    "utf8",
  );
  const pinnedCoreBundle = readFileSync(
    path.join(desktopRoot, "src-tauri/tauri.bundle.pinned-core.conf.json"),
    "utf8",
  );
  const signedCoreBundle = readFileSync(
    path.join(desktopRoot, "src-tauri/tauri.bundle.signed-core.conf.json"),
    "utf8",
  );
  const desktopPackage = JSON.parse(
    readFileSync(path.join(desktopRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  assert.doesNotMatch(baseBundle, /\.scratch\/mihomo/u);
  assert.match(pinnedCoreBundle, /\.scratch\/mihomo\/v1\.19\.29/u);
  assert.match(signedCoreBundle, /\.scratch\/macos-bundle\/mihomo-aarch64-apple-darwin/u);
  assert.match(
    desktopPackage.scripts["bundle:macos:internal-tun-alpha"] ?? "",
    /tauri\.bundle\.pinned-core\.conf\.json/u,
  );
  for (const script of [
    "bundle:macos",
    "bundle:macos:alpha-ad-hoc",
    "bundle:macos:production",
    "bundle:macos:signed-direct",
  ]) {
    assert.match(desktopPackage.scripts[script] ?? "", /tauri\.bundle\.signed-core\.conf\.json/u);
  }
  assert.doesNotMatch(builder, /const production\s*=\s*identity/u);

  const verifier = readFileSync(
    path.resolve(import.meta.dirname, "verify-macos-bundle.ts"),
    "utf8",
  );
  assert.match(verifier, /new SignedDirectTranscriptRecorder\(\)/u);
  assert.match(verifier, /recordSignedDirectStrictVerification/u);
  assert.match(verifier, /verifyCompleteSignedDirectTranscript/u);
  assert.match(verifier, /verifySignedDirectStrict\(application\)/u);

  const policy = readFileSync(
    path.resolve(import.meta.dirname, "macos-signed-direct-policy.ts"),
    "utf8",
  );
  assert.match(policy, /signedDirectCommandTimeoutMs = 120_000/u);
  assert.match(policy, /signedDirectCommandMaxOutputBytes = 64 \* 1024/u);
  assert.match(policy, /\["--verify", "--deep", "--strict", application\]/u);
  assert.match(policy, /maxBuffer: signedDirectCommandMaxOutputBytes/u);
  assert.match(policy, /timeout: signedDirectCommandTimeoutMs/u);
});

test("rejects identity, signing order, unsigned code, and entitlement drift", () => {
  const identityMismatch = fixture();
  identityMismatch.signatures[0].teamIdentifier = "ZZZZZ99999";
  assert.throws(() => verifySignedDirectEvidence(identityMismatch), /identity mismatch/u);

  const unordered = fixture();
  unordered.signingOrder.reverse();
  assert.throws(() => verifySignedDirectEvidence(unordered), /signed before/u);

  const unsigned = fixture();
  unsigned.signatures[0].signed = false;
  assert.throws(() => verifySignedDirectEvidence(unsigned), /unsigned code/u);

  const missingSignature = fixture();
  missingSignature.signatures.pop();
  assert.throws(
    () => verifySignedDirectEvidence(missingSignature),
    /unsigned or unexpected signed code/u,
  );

  const entitlementDrift = fixture();
  entitlementDrift.signatures[1].entitlements.push("com.apple.security.app-sandbox");
  assert.throws(() => verifySignedDirectEvidence(entitlementDrift), /unexpected entitlements/u);

  const noRuntime = fixture();
  noRuntime.signatures[1].hardenedRuntime = false;
  assert.throws(() => verifySignedDirectEvidence(noRuntime), /missing hardened runtime/u);
});

test("rejects privileged, mutable, linked, duplicate, and unexpected payloads", () => {
  for (const privilegedPath of [
    "Contents/Resources/mish-tun-helper",
    "Contents/Library/LaunchDaemons/com.asuka109.mish.plist",
    "Contents/Library/LoginItems/MishDevelopmentHelper.app",
    "Contents/XPCServices/com.asuka109.mish.smappservice.xpc",
    "Contents/Resources/enrollment.json",
    "Contents/Resources/tun-client-key.json",
    "Contents/Resources/installation-key-rotation.json",
    "Contents/Resources/mish-internal-tun-alpha-ctl",
    "Contents/Resources/internal-tun-alpha-manifest.json",
    "Contents/Resources/Install Internal TUN Alpha.command",
  ]) {
    const privileged = fixture();
    privileged.entries.push({
      executable: false,
      kind: "file",
      mode: 0o100444,
      nlink: 1,
      path: privilegedPath,
    });
    assert.throws(() => verifySignedDirectEvidence(privileged), /privileged content/u);
  }

  const mutable = fixture();
  mutable.entries[3].mode = 0o100666;
  assert.throws(() => verifySignedDirectEvidence(mutable), /mutable payload/u);

  const linked = fixture();
  linked.entries[3].nlink = 2;
  assert.throws(() => verifySignedDirectEvidence(linked), /duplicate hard links/u);

  const duplicate = fixture();
  duplicate.entries.push({ ...duplicate.entries[3] });
  assert.throws(() => verifySignedDirectEvidence(duplicate), /Duplicate bundle payload/u);

  const normalizedDuplicate = fixture();
  normalizedDuplicate.entries.push({
    ...normalizedDuplicate.entries[3],
    path: "Contents/Resources/web-dist/INDEX.HTML",
  });
  assert.throws(() => verifySignedDirectEvidence(normalizedDuplicate), /normalization-duplicate/u);

  const symlink = fixture();
  symlink.entries[3].kind = "symlink";
  assert.throws(() => verifySignedDirectEvidence(symlink), /contains a symlink/u);

  const unexpectedCode = fixture();
  unexpectedCode.entries.push({
    executable: true,
    kind: "file",
    mode: 0o100555,
    nlink: 1,
    path: "Contents/Resources/extra-tool",
  });
  assert.throws(() => verifySignedDirectEvidence(unexpectedCode), /unexpected nested code/u);

  const unexpectedSignature = fixture();
  unexpectedSignature.signatures.push({
    ...unexpectedSignature.signatures[0],
    identifier: "com.example.extra",
    path: "Contents/Resources/extra-tool",
  });
  assert.throws(
    () => verifySignedDirectEvidence(unexpectedSignature),
    /unsigned or unexpected signed code/u,
  );
});

test("rejects any signed-direct bundle that advertises TUN", () => {
  const evidence = fixture();
  evidence.advertisedTun = true;
  assert.throws(() => verifySignedDirectEvidence(evidence), /TUN unavailable/u);
});
