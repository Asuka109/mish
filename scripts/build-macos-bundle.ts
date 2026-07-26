import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

import {
  appleCredentialVariables,
  resolveMacOsReleaseProfile,
  signedDirectMihomoIdentifier,
} from "./macos-signed-direct-policy.ts";

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
const styledDmg = alphaAdHoc && arguments_.includes("--styled-dmg");
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
execFileSync("pnpm", ["geodata:verify-runtime"], {
  env: { ...process.env, MISH_MIHOMO_BIN: mihomo },
  stdio: "inherit",
});
const mihomoSha256 = createHash("sha256").update(readFileSync(mihomo)).digest("hex");
if (mihomoSha256 !== expectedMihomoSha256) {
  throw new Error(
    `Prepared Mihomo checksum mismatch: expected ${expectedMihomoSha256}, received ${mihomoSha256}`,
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
signingArguments.push("--sign", identity, mihomo);
execFileSync("codesign", signingArguments, { stdio: "inherit" });

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
  // Tauri maps CI=true to create-dmg's --skip-jenkins flag. Routine local and automated
  // verification must stay headless even when the caller inherited the escape hatch.
  packageEnvironment.CI = "true";
  delete packageEnvironment.TAURI_BUNDLER_DMG_IGNORE_CI;
  if (styledDmg) {
    packageEnvironment.TAURI_BUNDLER_DMG_IGNORE_CI = "true";
  }
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
  mkdirSync(productionRoot, { recursive: true });
  const helper = path.join(productionRoot, "mish-tun-helper");
  const plist = path.join(productionRoot, "com.asuka109.mish.tun-helper.plist");
  if (existsSync(helper)) chmodSync(helper, 0o755);
  if (existsSync(plist)) chmodSync(plist, 0o644);
  copyFileSync(path.resolve("target/release/mish-production-tun-helper"), helper);
  copyFileSync(
    path.resolve("apps/desktop/src-tauri/macos/LaunchDaemons/com.asuka109.mish.tun-helper.plist"),
    plist,
  );
  chmodSync(plist, 0o644);
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
      helper,
    ],
    { stdio: "inherit" },
  );
  chmodSync(helper, 0o755);
  execFileSync("codesign", ["--verify", "--strict", helper], { stdio: "inherit" });
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
if (alphaAdHoc) {
  execFileSync("pnpm", ["desktop:bundle:verify:alpha-ad-hoc:macos"], {
    env: packageEnvironment,
    stdio: "inherit",
  });
} else {
  execFileSync("pnpm", ["desktop:bundle:verify:macos"], {
    env: packageEnvironment,
    stdio: "inherit",
  });
}
