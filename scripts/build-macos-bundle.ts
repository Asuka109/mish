import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("macOS bundles must be built on Apple Silicon macOS");
}

const arguments_ = process.argv.slice(2);
const alphaAdHoc =
  arguments_.length === 2 && arguments_[0] === "--profile" && arguments_[1] === "alpha-ad-hoc";
const identity = process.env.APPLE_SIGNING_IDENTITY?.trim() || "-";
const mihomo = path.resolve(".scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29");
const expectedMihomoSha256 = "ec66e3e883bdc3fca06753784e324e08921e13239f8e945587cb1bfbf4c6b936";
const production = identity !== "-";
const productionFixture = process.argv.includes("--production-fixture");
const productionLayout = production || productionFixture;
const productionRoot = path.resolve(".scratch/macos-production");

if (production && productionFixture) {
  throw new Error("The credential-free production fixture cannot use a signing identity");
}

if (alphaAdHoc && productionFixture) {
  throw new Error("The alpha-ad-hoc profile cannot use the production fixture");
}

const alphaCredentialVariables = [
  "APPLE_CERTIFICATE",
  "APPLE_CERTIFICATE_PASSWORD",
  "APPLE_API_ISSUER",
  "APPLE_API_KEY",
  "APPLE_API_KEY_PATH",
  "MISH_APPLE_CERTIFICATE_BASE64",
  "MISH_APPLE_CERTIFICATE_PASSWORD",
  "MISH_APPLE_SIGNING_IDENTITY",
  "MISH_APPLE_NOTARY_API_ISSUER_ID",
  "MISH_APPLE_NOTARY_API_KEY_ID",
  "MISH_APPLE_NOTARY_API_PRIVATE_KEY",
] as const;

if (alphaAdHoc) {
  if (identity !== "-") {
    throw new Error("The alpha-ad-hoc profile requires APPLE_SIGNING_IDENTITY=-");
  }
  for (const variable of alphaCredentialVariables) {
    if (process.env[variable]) {
      throw new Error(`The alpha-ad-hoc profile rejects Apple credential variable ${variable}`);
    }
  }
  for (const variable of ["MISH_EXPECTED_APPLE_TEAM_IDENTIFIER", "MISH_MACOS_PACKAGE_MODE"]) {
    if (process.env[variable]) {
      throw new Error(`The alpha-ad-hoc profile rejects inherited package variable ${variable}`);
    }
  }
}

function teamIdentifier(signingIdentity: string) {
  const match = /\(([A-Z0-9]{10})\)\s*$/u.exec(signingIdentity);
  if (!match) {
    throw new Error("The Developer ID signing identity must end with its 10-character team ID");
  }
  return match[1];
}

execFileSync("pnpm", ["prepare:mihomo"], { stdio: "inherit" });
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
signingArguments.push("--sign", identity, mihomo);
execFileSync("codesign", signingArguments, { stdio: "inherit" });

const packageEnvironment = { ...process.env, APPLE_SIGNING_IDENTITY: identity };
if (alphaAdHoc) {
  packageEnvironment.MISH_MACOS_PACKAGE_MODE = "alpha-ad-hoc";
  packageEnvironment.MISH_MACOS_RELEASE_PROFILE = "alpha-ad-hoc";
}
let bundleCommand = "bundle:macos";
if (productionLayout) {
  const expectedTeamIdentifier = production ? teamIdentifier(identity) : "ABCDE12345";
  packageEnvironment.MISH_EXPECTED_APPLE_TEAM_IDENTIFIER = expectedTeamIdentifier;
  packageEnvironment.MISH_MACOS_PACKAGE_MODE = production ? "production" : "production-fixture";
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
      ...(production ? ["--timestamp"] : ["--timestamp=none"]),
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
