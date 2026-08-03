import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";

import {
  productionHelperRelativePath,
  verifyMacOsPrivilegedBundle,
} from "./macos-privileged-bundle.ts";
import {
  collectSignedDirectBundleEntries,
  collectSignedDirectSignature,
  signedDirectApplicationIdentifier,
  signedDirectMainExecutable,
  signedDirectMihomoExecutable,
  signedDirectMihomoIdentifier,
  signedDirectSigningOrder,
  verifySignedDirectEvidence,
} from "./macos-signed-direct-policy.ts";

const application = path.resolve(
  process.env.MISH_MACOS_APP_PATH ?? "target/release/bundle/macos/Mish.app",
);
const contents = path.join(application, "Contents");
const resources = path.join(contents, "Resources");
const bundledMihomo = path.join(resources, "mihomo-aarch64-apple-darwin");
const pinnedMihomo = path.resolve(".scratch/mihomo/v1.19.29/mihomo-darwin-arm64-v1.19.29");
const preparedMihomo = path.resolve(".scratch/macos-bundle/mihomo-aarch64-apple-darwin");
const mihomoManifest = JSON.parse(
  await readFile(path.resolve("resources/mihomo/macos-arm64.json"), "utf8"),
) as { binarySha256: string };
const bundledWeb = path.join(resources, "web-dist");
const sourceWeb = path.resolve("apps/web/dist");
const bundledGeodata = path.join(resources, "geodata/snapshot");
const sourceGeodata = path.resolve("resources/geodata/snapshot");
const legalResources = [
  "LICENSE",
  "THIRD_PARTY_NOTICES.md",
  "THIRD_PARTY_LICENSES/Remix-Icon-v4.8.0-Apache-2.0.txt",
] as const;
const canonicalGplV3Sha256 = "3972dc9744f6499f0f9b2dbf76696f2ae7ad8af9b23dde66d6af86c9dfb36986";
const production = process.env.MISH_MACOS_PACKAGE_MODE === "production";
const productionFixture = process.env.MISH_MACOS_PACKAGE_MODE === "production-fixture";
const alphaAdHoc = process.env.MISH_MACOS_PACKAGE_MODE === "alpha-ad-hoc";
const signedDirect = process.env.MISH_MACOS_PACKAGE_MODE === "signed-direct";
const signedDirectFixture = process.env.MISH_MACOS_PACKAGE_MODE === "signed-direct-fixture";
const productionLayout = production || productionFixture;

if (
  [production, productionFixture, alphaAdHoc, signedDirect, signedDirectFixture].filter(Boolean)
    .length !== 1
) {
  throw new Error("Bundle verification requires exactly one explicit macOS package mode");
}

function command(program: string, arguments_: string[]) {
  return execFileSync(program, arguments_, { encoding: "utf8" }).trim();
}

async function sha256(file: string) {
  return createHash("sha256")
    .update(await readFile(file))
    .digest("hex");
}

async function files(root: string, directory = root): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const discovered = await Promise.all(
    entries.map(async (entry) => {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        return files(root, absolute);
      }
      if (!entry.isFile()) {
        throw new Error(`Unexpected non-file bundle resource: ${absolute}`);
      }
      return [path.relative(root, absolute)];
    }),
  );
  return discovered.flat().sort();
}

const identifier = command("plutil", [
  "-extract",
  "CFBundleIdentifier",
  "raw",
  "-o",
  "-",
  path.join(contents, "Info.plist"),
]);
if (identifier !== "com.asuka109.mish") {
  throw new Error(`Unexpected bundle identifier: ${identifier}`);
}

const executableName = command("plutil", [
  "-extract",
  "CFBundleExecutable",
  "raw",
  "-o",
  "-",
  path.join(contents, "Info.plist"),
]);
const executable = path.join(contents, "MacOS", executableName);
const productionHelper = path.join(application, productionHelperRelativePath);
await verifyMacOsPrivilegedBundle(application, productionLayout ? "production" : "ad-hoc");
for (const binary of [executable, bundledMihomo, ...(productionLayout ? [productionHelper] : [])]) {
  const description = command("file", [binary]);
  if (!description.includes("Mach-O 64-bit executable arm64")) {
    throw new Error(`Bundle contains a non-ARM64 executable: ${description}`);
  }
  if ((await stat(binary)).mode & 0o111) {
    continue;
  }
  throw new Error(`Bundle executable is not executable: ${binary}`);
}

const mihomoDigest = await sha256(bundledMihomo);
const preparedMihomoDigest = await sha256(preparedMihomo);
const pinnedMihomoDigest = await sha256(pinnedMihomo);
if (pinnedMihomoDigest !== mihomoManifest.binarySha256) {
  throw new Error(
    `Pinned Mihomo checksum mismatch after bundle staging: expected ${mihomoManifest.binarySha256}, received ${pinnedMihomoDigest}`,
  );
}
if (mihomoDigest !== preparedMihomoDigest) {
  throw new Error(
    `Bundled Mihomo checksum mismatch: expected ${preparedMihomoDigest}, received ${mihomoDigest}`,
  );
}
const mihomoVersion = command(bundledMihomo, ["-v"]);
if (!mihomoVersion.includes("v1.19.29 darwin arm64")) {
  throw new Error(`Unexpected bundled Mihomo version: ${mihomoVersion}`);
}

const sourceWebFiles = await files(sourceWeb);
const bundledWebFiles = await files(bundledWeb);
if (
  sourceWebFiles.length === 0 ||
  JSON.stringify(sourceWebFiles) !== JSON.stringify(bundledWebFiles)
) {
  throw new Error("The bundled offline Web resource set is incomplete");
}
for (const relative of sourceWebFiles) {
  const sourceDigest = await sha256(path.join(sourceWeb, relative));
  const bundledDigest = await sha256(path.join(bundledWeb, relative));
  if (sourceDigest !== bundledDigest) {
    throw new Error(`Bundled Web resource checksum mismatch: ${relative}`);
  }
}
const index = await readFile(path.join(bundledWeb, "index.html"), "utf8");
if (/\b(?:src|href)=["']https?:\/\//iu.test(index)) {
  throw new Error("The bundled Web entry point references a remote asset");
}

const geodataManifest = JSON.parse(
  await readFile(path.join(sourceGeodata, "manifest.json"), "utf8"),
) as {
  assets: Array<{ bytes: number; name: string; runtimeName: string; sha256: string }>;
  schemaVersion: number;
};
const requiredGeodataAssets = ["geosite.dat", "geoip.dat", "geoip.metadb", "GeoLite2-ASN.mmdb"];
const requiredGeodataRuntimeNames = ["GeoSite.dat", "GeoIP.dat", "geoip.metadb", "ASN.mmdb"];
const expectedGeodataFiles = [...requiredGeodataAssets, "manifest.json"].sort();
if (
  geodataManifest.schemaVersion !== 2 ||
  JSON.stringify(geodataManifest.assets.map((asset) => asset.name)) !==
    JSON.stringify(requiredGeodataAssets) ||
  JSON.stringify(geodataManifest.assets.map((asset) => asset.runtimeName)) !==
    JSON.stringify(requiredGeodataRuntimeNames) ||
  JSON.stringify(await files(sourceGeodata)) !== JSON.stringify(expectedGeodataFiles) ||
  JSON.stringify(await files(bundledGeodata)) !== JSON.stringify(expectedGeodataFiles)
) {
  throw new Error("The bundled GeoData resource set is incomplete");
}
for (const asset of geodataManifest.assets) {
  const source = path.join(sourceGeodata, asset.name);
  const bundled = path.join(bundledGeodata, asset.name);
  if (
    (await stat(source)).size !== asset.bytes ||
    (await stat(bundled)).size !== asset.bytes ||
    (await sha256(source)) !== asset.sha256 ||
    (await sha256(bundled)) !== asset.sha256
  ) {
    throw new Error(`Bundled GeoData resource checksum mismatch: ${asset.name}`);
  }
}
if (
  (await sha256(path.join(sourceGeodata, "manifest.json"))) !==
  (await sha256(path.join(bundledGeodata, "manifest.json")))
) {
  throw new Error("The bundled GeoData manifest does not match the repository");
}

for (const legalResource of legalResources) {
  const source = path.resolve(legalResource);
  const bundled = path.join(resources, legalResource);
  if ((await sha256(source)) !== (await sha256(bundled))) {
    throw new Error(`Bundled legal resource does not match the repository: ${legalResource}`);
  }
}
if ((await sha256(path.join(resources, "LICENSE"))) !== canonicalGplV3Sha256) {
  throw new Error("The bundled LICENSE is not the declared GPL version 3 text");
}
const notices = await readFile(path.join(resources, "THIRD_PARTY_NOTICES.md"), "utf8");
for (const requiredNotice of [
  "MetaCubeX/mihomo",
  "v1.19.29",
  "e26714a181ac0e2fa803453c0a8e9a9ce94e31cb",
  "MetaCubeX/meta-rules-dat",
  "GPL-3.0",
  "8e543a8983790c20d7d8c696ae74023c69f379b7",
  "Apache-2.0",
]) {
  if (!notices.includes(requiredNotice)) {
    throw new Error(`The bundled third-party notices omit ${requiredNotice}`);
  }
}

if (productionLayout) {
  const teamIdentifier = process.env.MISH_EXPECTED_APPLE_TEAM_IDENTIFIER;
  if (!teamIdentifier || !/^[A-Z0-9]{10}$/u.test(teamIdentifier)) {
    throw new Error("Production bundle verification requires the exact Apple team identifier");
  }
  const requirement = (identifier: string) =>
    `anchor apple generic and identifier \"${identifier}\" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = \"${teamIdentifier}\"`;
  const signedArtifacts = [
    [identifier, application],
    ["com.asuka109.mish.tun-helper", productionHelper],
  ] as const;
  for (const [signingIdentifier, artifact] of signedArtifacts) {
    const arguments_ = ["--verify", "--strict", "-R", requirement(signingIdentifier), artifact];
    if (production) {
      execFileSync("codesign", arguments_, { stdio: "inherit" });
    } else if (spawnSync("codesign", arguments_, { stdio: "ignore" }).status === 0) {
      throw new Error(`Credential-free fixture unexpectedly satisfied Developer ID: ${artifact}`);
    }
  }
  if (command(productionHelper, ["--version"]) !== "5") {
    throw new Error("The production TUN helper reports an unexpected version");
  }
  if (command(productionHelper, ["--protocol-version"]) !== "3") {
    throw new Error("The production TUN helper reports an unexpected protocol version");
  }
}

execFileSync("codesign", ["--verify", "--strict", bundledMihomo], {
  stdio: "inherit",
});
if (signedDirect || signedDirectFixture) {
  const teamIdentifier = process.env.MISH_EXPECTED_APPLE_TEAM_IDENTIFIER;
  const identity = process.env.APPLE_SIGNING_IDENTITY;
  if (!teamIdentifier || !identity) {
    throw new Error("signed-direct verification requires protected identity and team inputs");
  }
  const requirement = (signingIdentifier: string) =>
    `anchor apple generic and identifier "${signingIdentifier}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${teamIdentifier}"`;
  const developerIdRequirements = [
    [requirement(signedDirectMihomoIdentifier), bundledMihomo],
    [requirement(signedDirectApplicationIdentifier), application],
  ] as const;
  for (const [developerIdRequirement, artifact] of developerIdRequirements) {
    const arguments_ = [
      "--verify",
      ...(artifact === application ? ["--deep"] : []),
      "--strict",
      "-R",
      developerIdRequirement,
      artifact,
    ];
    if (signedDirect) {
      execFileSync("codesign", arguments_, { stdio: "inherit" });
    } else if (spawnSync("codesign", arguments_, { stdio: "ignore" }).status === 0) {
      throw new Error(`Credential-free fixture unexpectedly satisfied Developer ID: ${artifact}`);
    }
  }
  const runtimeEvidence = JSON.parse(command(executable, ["--release-profile-evidence"])) as {
    profile?: unknown;
    tun?: unknown;
    updater?: unknown;
  };
  if (runtimeEvidence.profile !== "signed-direct") {
    throw new Error("signed-direct executable reports an unexpected release profile");
  }
  if (runtimeEvidence.updater !== "contract-only") {
    throw new Error("signed-direct executable must report the updater as contract-only");
  }
  const signatures = [
    collectSignedDirectSignature(bundledMihomo, signedDirectMihomoExecutable),
    collectSignedDirectSignature(application, "Mish.app"),
  ];
  if (signedDirectFixture) {
    for (const signature of signatures) {
      signature.identity = "Developer ID Application: Mish Fixture (ABCDE12345)";
      signature.teamIdentifier = "ABCDE12345";
    }
  }
  verifySignedDirectEvidence({
    advertisedTun: runtimeEvidence.tun !== "unavailable",
    entries: await collectSignedDirectBundleEntries(application),
    expectedIdentity: {
      identity: signedDirectFixture
        ? "Developer ID Application: Mish Fixture (ABCDE12345)"
        : identity,
      teamIdentifier,
    },
    signatures,
    signingOrder: [...signedDirectSigningOrder],
  });
  if (
    path.relative(application, executable).split(path.sep).join("/") !== signedDirectMainExecutable
  ) {
    throw new Error("signed-direct main executable path changed unexpectedly");
  }
}
execFileSync("codesign", ["--verify", "--deep", "--strict", application], {
  stdio: "inherit",
});

console.log(
  `Verified ${application}: ${identifier}, ARM64, Mihomo v1.19.29, ${geodataManifest.assets.length} pinned GeoData assets, ${sourceWebFiles.length} offline Web files, GPL notices, ${production ? "production TUN gate" : productionFixture ? "credential-free negative production TUN fixture" : alphaAdHoc ? "alpha-ad-hoc System Proxy-only" : signedDirectFixture ? "credential-free signed-direct identity/layout fixture" : "signed-direct Developer ID System Proxy-only"}`,
);
