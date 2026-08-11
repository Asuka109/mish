import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  appleCredentialVariables,
  resolveMacOsReleaseProfile,
  signedDirectMihomoIdentifier,
} from "./macos-signed-direct-policy.ts";
import { createMacOsDmg, verifyMacOsDmgPresentation } from "./macos-dmg-presentation.ts";
import {
  assertPrivateNoFollowFile,
  assertPrivateNoFollowRoot,
  readContainedReleaseFile,
  writeContainedReleaseFile,
} from "./release-path-containment.ts";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("macOS bundles must be built on Apple Silicon macOS");
}

const arguments_ = process.argv.slice(2);
const productionFixture = arguments_.length === 1 && arguments_[0] === "--production-fixture";
const signedDirectFixture = arguments_.length === 1 && arguments_[0] === "--signed-direct-fixture";
const release =
  productionFixture || signedDirectFixture
    ? null
    : resolveMacOsReleaseProfile(arguments_, process.env);
const alphaAdHoc = release?.profile === "alpha-ad-hoc";
const signedDirect = release?.profile === "signed-direct" || signedDirectFixture;
const openDmg = alphaAdHoc && arguments_.includes("--open-dmg");
const identity = release?.identity ?? "-";
const mihomoRelease = JSON.parse(
  readFileSync(path.resolve("resources/mihomo/macos-arm64.json"), "utf8"),
) as {
  asset: string;
  binarySha256: string;
  version: string;
};
const mihomo = path.resolve(
  ".scratch/mihomo",
  mihomoRelease.version,
  mihomoRelease.asset.slice(0, -3),
);
const bundleMihomo = path.resolve(".scratch/macos-bundle/mihomo-aarch64-apple-darwin");
const expectedMihomoSha256 = mihomoRelease.binarySha256;
const productionRoot = path.resolve(".scratch/macos-production");

if (productionFixture || signedDirectFixture) {
  const fixtureName = productionFixture ? "production" : "signed-direct";
  if ((process.env.APPLE_SIGNING_IDENTITY?.trim() || "-") !== "-") {
    throw new Error(`The credential-free ${fixtureName} fixture cannot use a signing identity`);
  }
  for (const variable of [
    ...appleCredentialVariables,
    "MISH_EXPECTED_APPLE_TEAM_IDENTIFIER",
    "MISH_MACOS_PACKAGE_MODE",
    "MISH_MACOS_RELEASE_PROFILE",
    "MISH_PROTECTED_RELEASE_ENVIRONMENT",
  ]) {
    if (process.env[variable]) {
      throw new Error(`The credential-free ${fixtureName} fixture rejects inherited ${variable}`);
    }
  }
}

execFileSync("pnpm", ["prepare:mihomo"], { stdio: "inherit" });
const mihomoGuard = assertPrivateNoFollowFile(mihomo);
execFileSync("pnpm", ["geodata:verify-runtime"], {
  env: { ...process.env, MISH_MIHOMO_BIN: mihomo },
  stdio: "inherit",
});
const mihomoSha256 = createHash("sha256")
  .update(readContainedReleaseFile(mihomoGuard))
  .digest("hex");
if (mihomoSha256 !== expectedMihomoSha256) {
  throw new Error(
    `Prepared Mihomo checksum mismatch: expected ${expectedMihomoSha256}, received ${mihomoSha256}`,
  );
}
const bundleMihomoParent = path.dirname(bundleMihomo);
mkdirSync(bundleMihomoParent, { recursive: true, mode: 0o700 });
chmodSync(bundleMihomoParent, 0o700);
const bundleRoot = assertPrivateNoFollowRoot(bundleMihomoParent);
const stagedMihomo = writeContainedReleaseFile(
  bundleRoot,
  path.basename(bundleMihomo),
  readContainedReleaseFile(mihomoGuard),
  { mode: 0o755, overwrite: true },
);
const stagedMihomoSha256 = createHash("sha256")
  .update(readContainedReleaseFile(stagedMihomo))
  .digest("hex");
if (stagedMihomoSha256 !== expectedMihomoSha256) {
  throw new Error(
    `Staged Mihomo checksum mismatch: expected ${expectedMihomoSha256}, received ${stagedMihomoSha256}`,
  );
}

const signingArguments = ["--force", "--options", "runtime"];
if (identity === "-") {
  signingArguments.push("--timestamp=none");
} else {
  signingArguments.push("--timestamp");
}
if (signedDirect) {
  signingArguments.push("--identifier", signedDirectMihomoIdentifier);
}
stagedMihomo.assertCurrent();
signingArguments.push("--sign", identity, stagedMihomo.absolute);
execFileSync("codesign", signingArguments, { stdio: "inherit" });
bundleRoot.contain(path.basename(bundleMihomo), "executable").assertCurrent();
const pinnedMihomoSha256 = createHash("sha256")
  .update(readContainedReleaseFile(mihomoGuard))
  .digest("hex");
if (pinnedMihomoSha256 !== expectedMihomoSha256) {
  throw new Error(
    `Pinned Mihomo changed while staging the signed bundle resource: expected ${expectedMihomoSha256}, received ${pinnedMihomoSha256}`,
  );
}

const packageEnvironment = { ...process.env, APPLE_SIGNING_IDENTITY: identity };
delete packageEnvironment.MISH_MIHOMO_BIN;
if (release) {
  packageEnvironment.MISH_MACOS_PACKAGE_MODE = release.profile;
  packageEnvironment.MISH_MACOS_RELEASE_PROFILE = release.profile;
}
if (release?.profile === "signed-direct") {
  packageEnvironment.MISH_EXPECTED_APPLE_TEAM_IDENTIFIER = release.teamIdentifier;
}
if (signedDirectFixture) {
  packageEnvironment.MISH_EXPECTED_APPLE_TEAM_IDENTIFIER = "ABCDE12345";
  packageEnvironment.MISH_MACOS_PACKAGE_MODE = "signed-direct-fixture";
  packageEnvironment.MISH_MACOS_RELEASE_PROFILE = "signed-direct";
}
if (alphaAdHoc) {
  // Alpha builds create an app first. The checked-in Finder template is mounted with
  // -nobrowse/-noautoopen only, so routine packaging never invokes Finder or open.
  packageEnvironment.CI = "true";
  delete packageEnvironment.TAURI_BUNDLER_DMG_IGNORE_CI;
}
let bundleCommand = "bundle:macos";
if (productionFixture) {
  packageEnvironment.MISH_EXPECTED_APPLE_TEAM_IDENTIFIER = "ABCDE12345";
  packageEnvironment.MISH_MACOS_PACKAGE_MODE = "production-fixture";
  packageEnvironment.MISH_MACOS_RELEASE_PROFILE = "tun-production-fixture";
  execFileSync(
    "cargo",
    ["build", "--release", "-p", "mish-platform-macos", "--bin", "mish-production-tun-helper"],
    { env: packageEnvironment, stdio: "inherit" },
  );
  mkdirSync(productionRoot, { mode: 0o700, recursive: true });
  chmodSync(productionRoot, 0o700);
  const productionRootGuard = assertPrivateNoFollowRoot(productionRoot);
  const helperSource = assertPrivateNoFollowFile(
    path.resolve("target/release/mish-production-tun-helper"),
  );
  const plistSource = assertPrivateNoFollowFile(
    path.resolve("apps/desktop/src-tauri/macos/LaunchDaemons/com.asuka109.mish.tun-helper.plist"),
  );
  const helperGuard = writeContainedReleaseFile(
    productionRootGuard,
    "mish-tun-helper",
    readContainedReleaseFile(helperSource),
    { mode: 0o755, overwrite: true },
  );
  writeContainedReleaseFile(
    productionRootGuard,
    "com.asuka109.mish.tun-helper.plist",
    readContainedReleaseFile(plistSource),
    { mode: 0o644, overwrite: true },
  );
  execFileSync(
    "codesign",
    [
      "--force",
      "--identifier",
      "com.asuka109.mish.tun-helper",
      "--options",
      "runtime",
      "--timestamp=none",
      "--sign",
      identity,
      helperGuard.absolute,
    ],
    { stdio: "inherit" },
  );
  const signedHelper = productionRootGuard.contain("mish-tun-helper", "executable");
  signedHelper.assertCurrent();
  execFileSync("codesign", ["--verify", "--strict", signedHelper.absolute], { stdio: "inherit" });
  bundleCommand = "bundle:macos:production";
}

if (alphaAdHoc) {
  bundleCommand = "bundle:macos:alpha-ad-hoc";
} else if (signedDirect) {
  bundleCommand = "bundle:macos:signed-direct";
}

execFileSync("pnpm", ["--filter", "@mish/desktop", bundleCommand], {
  env: packageEnvironment,
  stdio: "inherit",
});
const application = path.resolve("target/release/bundle/macos/Mish.app");
const applicationRoot = assertPrivateNoFollowRoot(application);
const mainExecutable = applicationRoot.contain("Contents/MacOS/mish-desktop", "executable");
const applicationMihomo = applicationRoot.contain(
  "Contents/Resources/mihomo-aarch64-apple-darwin",
  "executable",
);
mainExecutable.assertCurrent();
applicationMihomo.assertCurrent();
const dmgName = alphaAdHoc
  ? "Mish_0.1.0_aarch64.dmg"
  : productionFixture
    ? "Mish-production-fixture_0.1.0_aarch64.dmg"
    : signedDirectFixture
      ? "Mish-signed-direct-fixture_0.1.0_aarch64.dmg"
      : "Mish-signed-direct_0.1.0_aarch64.dmg";
const dmg = path.resolve("target/release/bundle/dmg", dmgName);
mkdirSync(path.dirname(dmg), { recursive: true, mode: 0o700 });
chmodSync(path.dirname(dmg), 0o700);
const dmgParent = assertPrivateNoFollowRoot(path.dirname(dmg));
dmgParent.assertCurrent();
createMacOsDmg(application, dmg, { replaceExistingOutput: true });
const dmgGuard = assertPrivateNoFollowFile(dmg);
dmgGuard.assertCurrent();
if (alphaAdHoc) {
  execFileSync("pnpm", ["desktop:bundle:verify:alpha-ad-hoc:macos"], {
    env: packageEnvironment,
    stdio: "inherit",
  });
  if (openDmg) execFileSync("/usr/bin/open", [dmg], { stdio: "inherit" });
} else {
  verifyMacOsDmgPresentation(dmg, (mountedApplication) => {
    execFileSync("pnpm", ["desktop:bundle:verify:macos"], {
      env: { ...packageEnvironment, MISH_MACOS_APP_PATH: mountedApplication },
      stdio: "inherit",
    });
  });
}
