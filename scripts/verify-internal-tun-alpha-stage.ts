import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  readTrustedReleasePolicy,
  verifyCandidateManifest,
  type CandidateManifest,
  type DispatchIdentity,
} from "./trusted-release-policy.ts";

const packageVersion = "0.1.0-internal-tun-alpha.6";
const dmgName = `Mish-Internal-TUN-Alpha-${packageVersion}-arm64.dmg`;
const packageManifestName = "internal-tun-alpha-package-manifest.json";
const sbomName = "internal-tun-alpha-sbom.spdx.json";
const provenanceName = "internal-tun-alpha-provenance.intoto.json";
const checksumsName = "SHA256SUMS.txt";
const verificationName = "internal-tun-alpha-verification.json";
const candidateManifestName = "trusted-candidate-manifest.json";
const finalManifestName = "internal-tun-alpha-stage-manifest.json";
const stageInputsName = "internal-tun-alpha-stage-inputs.json";
const candidateKind = "internal-tun-alpha-dmg-candidate";
const finalKind = "internal-tun-alpha-immutable-stage";
const sha256Digest = /^[0-9a-f]{64}$/u;
const numericId = /^[1-9][0-9]*$/u;
const sourceInputPaths = [
  "Cargo.lock",
  "Cargo.toml",
  "crates/platform-macos/Cargo.toml",
  "crates/platform-macos/src/bin/mish-internal-tun-alpha-ctl.rs",
  "crates/platform-macos/src/bin/mish-tun-helper.rs",
  "crates/platform-macos/src/tun_service.rs",
  "crates/runtime/src/tun_helper.rs",
  "package.json",
  "pnpm-lock.yaml",
  "resources/internal-tun-alpha/com.asuka109.mish.tun-helper.dev.plist.template",
  "resources/mihomo/macos-arm64.json",
  "scripts/development-mihomo.ts",
  "scripts/internal-tun-alpha-package.ts",
  "scripts/prepare-mihomo.ts",
  "skills-lock.json",
] as const;
const expectedPackageFiles = [
  { mode: 0o755, path: "Health Internal TUN Alpha.command", role: "health" },
  { mode: 0o755, path: "Install Internal TUN Alpha.command", role: "install" },
  { mode: 0o644, path: "LICENSE", role: "license" },
  { mode: 0o644, path: "README.txt", role: "notice" },
  { mode: 0o755, path: "Repair Internal TUN Alpha.command", role: "repair" },
  {
    mode: 0o755,
    path: "Resources/mish-internal-tun-alpha-ctl",
    role: "controller",
  },
  {
    mode: 0o644,
    path: "Resources/com.asuka109.mish.tun-helper.dev.plist.template",
    role: "launch-daemon-template",
  },
  { mode: 0o755, path: "Resources/mihomo", role: "core" },
  { mode: 0o755, path: "Resources/mish-tun-helper", role: "helper" },
  { mode: 0o755, path: "Status Internal TUN Alpha.command", role: "status" },
  { mode: 0o644, path: "THIRD_PARTY_NOTICES.md", role: "notices" },
  { mode: 0o755, path: "Uninstall Internal TUN Alpha.command", role: "uninstall" },
] as const;
const candidateRoles = {
  [checksumsName]: "sha256sums",
  [dmgName]: "internal-tun-alpha-dmg",
  [packageManifestName]: "package-manifest",
  [provenanceName]: "build-provenance",
  [sbomName]: "sbom",
} as const;
const finalRoles = {
  ...Object.fromEntries(
    Object.entries(candidateRoles).map(([file, role]) => [`candidate/${file}`, role]),
  ),
  [`candidate/${candidateManifestName}`]: "candidate-manifest",
  [stageInputsName]: "immutable-input-binding",
  [`verification/${verificationName}`]: "verification-evidence",
} as const;

type PackageManifestFile = {
  mode: number;
  path: string;
  role: string;
  sha256: string;
  size: number;
};

type PackageManifest = {
  allowTun: boolean;
  architecture: string;
  coreVersion: string;
  developerIdRequired: boolean;
  files: PackageManifestFile[];
  helperVersion: string;
  installationIdentityScheme: string;
  minimumMacosVersion: number;
  networkMutationEnabled: boolean;
  packageVersion: string;
  profile: string;
  protocolVersion: number;
  schemaVersion: number;
};

export type InternalTunAlphaVerificationEvidence = {
  candidateArtifact: {
    bundleSha256: string;
    id: string;
    name: string;
  };
  checks: string[];
  dmg: {
    format: "read-only-hfs-iso9660-hybrid-disk-image";
    name: string;
    sha256: string;
  };
  identity: DispatchIdentity;
  package: {
    controllerSha256: string;
    coreSha256: string;
    coreVersion: string;
    helperSha256: string;
    helperVersion: string;
    installationIdentityScheme: string;
    manifestSha256: string;
    plistTemplateSha256: string;
    profile: "internal-tun-alpha";
    protocolVersion: 3;
    version: string;
  };
  schemaVersion: 1;
  status: "verified";
};

type VerifyOptions = {
  artifactId: string;
  artifactName: string;
  directory: string;
  evidenceOutput?: string;
  identity: DispatchIdentity;
  sourceRoot: string;
};

type ConfirmOptions = {
  artifactId: string;
  artifactName: string;
  directory: string;
  identity: DispatchIdentity;
  sourceRoot: string;
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function fileSha256(file: string): string {
  return sha256(readFileSync(file));
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

function option(arguments_: string[], name: string): string {
  const index = arguments_.indexOf(name);
  invariant(index >= 0, `Missing required option ${name}.`);
  const value = arguments_[index + 1];
  invariant(value && !value.startsWith("--"), `Option ${name} requires a value.`);
  return value;
}

function identityFromArguments(arguments_: string[]): DispatchIdentity {
  return {
    actorId: option(arguments_, "--actor-id"),
    eventName: option(arguments_, "--event-name"),
    mainSha: option(arguments_, "--main-sha"),
    ref: option(arguments_, "--ref"),
    repository: option(arguments_, "--repository"),
    repositoryId: option(arguments_, "--repository-id"),
    repositoryOwnerId: option(arguments_, "--repository-owner-id"),
    runAttempt: option(arguments_, "--run-attempt"),
    runId: option(arguments_, "--run-id"),
    sourceIsAncestor: option(arguments_, "--source-is-ancestor") === "true",
    sourceSha: option(arguments_, "--source-sha"),
    toolingSha: option(arguments_, "--tooling-sha"),
    triggeringActorId: option(arguments_, "--triggering-actor-id"),
    workflowRef: option(arguments_, "--workflow-ref"),
    workflowSha: option(arguments_, "--workflow-sha"),
  };
}

function stagePolicy(manifestName = candidateManifestName) {
  const policy = structuredClone(readTrustedReleasePolicy());
  policy.artifact.manifestName = manifestName;
  return policy;
}

function assertExactObjectKeys(value: object, expected: string[], label: string): void {
  invariant(
    JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()),
    `${label} contains missing or unexpected fields.`,
  );
}

function assertIdentity(identity: DispatchIdentity, expected: DispatchIdentity): void {
  invariant(
    JSON.stringify(identity) === JSON.stringify(expected),
    "Internal TUN Alpha source, workflow, tooling, or run identity changed.",
  );
  invariant(
    identity.sourceSha === identity.mainSha &&
      identity.workflowSha === identity.mainSha &&
      identity.toolingSha === identity.workflowSha &&
      identity.sourceIsAncestor,
    "Internal TUN Alpha identity is stale or not frozen to reviewed main.",
  );
}

function assertPackageManifest(value: unknown): asserts value is PackageManifest {
  invariant(value && typeof value === "object", "Internal TUN Alpha package manifest is invalid.");
  const manifest = value as PackageManifest;
  assertExactObjectKeys(
    manifest,
    [
      "allowTun",
      "architecture",
      "coreVersion",
      "developerIdRequired",
      "files",
      "helperVersion",
      "installationIdentityScheme",
      "minimumMacosVersion",
      "networkMutationEnabled",
      "packageVersion",
      "profile",
      "protocolVersion",
      "schemaVersion",
    ],
    "Internal TUN Alpha package manifest",
  );
  invariant(
    manifest.schemaVersion === 1 &&
      manifest.profile === "internal-tun-alpha" &&
      manifest.packageVersion === packageVersion &&
      manifest.architecture === "arm64" &&
      manifest.minimumMacosVersion === 13 &&
      manifest.protocolVersion === 3 &&
      manifest.developerIdRequired === false &&
      manifest.allowTun === true &&
      manifest.networkMutationEnabled === true &&
      manifest.installationIdentityScheme === "sha256-helper-core-rendered-plist-v1" &&
      /^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(manifest.coreVersion) &&
      /^[1-9][0-9]*$/u.test(manifest.helperVersion),
    "Internal TUN Alpha package profile, version, or disabled boundary changed.",
  );
  invariant(
    Array.isArray(manifest.files) && manifest.files.length > expectedPackageFiles.length,
    "Internal TUN Alpha package layout differs from the accepted closed layout.",
  );
  const declared = new Map(
    manifest.files.map((file) => [
      file.path,
      { mode: file.mode, path: file.path, role: file.role },
    ]),
  );
  const applicationFiles = manifest.files.filter((file) => file.role === "application");
  invariant(
    declared.size === manifest.files.length &&
      JSON.stringify(expectedPackageFiles.map(({ path: file }) => declared.get(file))) ===
        JSON.stringify(expectedPackageFiles) &&
      manifest.files.length === expectedPackageFiles.length + applicationFiles.length &&
      applicationFiles.some((file) => file.path === "Mish.app/Contents/Info.plist") &&
      applicationFiles.some((file) => file.path === "Mish.app/Contents/MacOS/mish-desktop") &&
      applicationFiles.some(
        (file) => file.path === "Mish.app/Contents/Resources/mihomo-aarch64-apple-darwin",
      ) &&
      applicationFiles.every((file) => file.path.startsWith("Mish.app/")),
    "Internal TUN Alpha package application or fixed layout is incomplete.",
  );
  for (const file of manifest.files) {
    assertExactObjectKeys(
      file,
      ["mode", "path", "role", "sha256", "size"],
      "Internal TUN Alpha package file",
    );
    invariant(
      sha256Digest.test(file.sha256) &&
        (file.mode === 0o644 || file.mode === 0o755) &&
        Number.isSafeInteger(file.size) &&
        file.size > 0 &&
        file.size <= 256 * 1024 * 1024,
      "Internal TUN Alpha package file evidence is invalid or unbounded.",
    );
  }
}

function packageFileByRole(manifest: PackageManifest, role: string): PackageManifestFile {
  const matches = manifest.files.filter((file) => file.role === role);
  invariant(matches.length === 1, `Internal TUN Alpha package must contain exactly one ${role}.`);
  return matches[0];
}

function assertCandidateManifest(
  manifest: CandidateManifest,
  kind: string,
  roles: Record<string, string>,
): void {
  invariant(manifest.kind === kind, `Internal TUN Alpha manifest kind must be ${kind}.`);
  const observedRoles = manifest.files
    .map((file) => [file.path, file.role] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const expectedRoles = Object.entries(roles).sort(([left], [right]) => left.localeCompare(right));
  invariant(
    JSON.stringify(observedRoles) === JSON.stringify(expectedRoles),
    "Internal TUN Alpha artifact roles are missing, duplicated, or unexpected.",
  );
}

function assertChecksums(directory: string): void {
  const expectedNames = [dmgName, packageManifestName, provenanceName, sbomName];
  const expected = `${expectedNames
    .map((name) => `${fileSha256(path.join(directory, name))}  ${name}`)
    .join("\n")}\n`;
  invariant(
    readFileSync(path.join(directory, checksumsName), "utf8") === expected,
    "Internal TUN Alpha SHA-256 set is partial, duplicated, stale, or mismatched.",
  );
}

function recordValue(value: unknown, label: string): Record<string, unknown> {
  invariant(value && typeof value === "object" && !Array.isArray(value), `${label} is invalid.`);
  return value as Record<string, unknown>;
}

function assertProvenance(
  value: unknown,
  directory: string,
  sourceRoot: string,
  identity: DispatchIdentity,
  manifest: PackageManifest,
): void {
  const statement = recordValue(value, "Internal TUN Alpha provenance");
  const predicate = recordValue(statement.predicate, "Internal TUN Alpha provenance predicate");
  const definition = recordValue(
    predicate.buildDefinition,
    "Internal TUN Alpha provenance build definition",
  );
  const external = recordValue(
    definition.externalParameters,
    "Internal TUN Alpha provenance external parameters",
  );
  const internal = recordValue(
    definition.internalParameters,
    "Internal TUN Alpha provenance internal parameters",
  );
  const runDetails = recordValue(predicate.runDetails, "Internal TUN Alpha provenance run details");
  const builder = recordValue(runDetails.builder, "Internal TUN Alpha provenance builder");
  const metadata = recordValue(runDetails.metadata, "Internal TUN Alpha provenance metadata");
  const subject = statement.subject;
  assertExactObjectKeys(
    statement,
    ["_type", "predicate", "predicateType", "subject"],
    "Internal TUN Alpha provenance",
  );
  assertExactObjectKeys(
    predicate,
    ["buildDefinition", "runDetails"],
    "Internal TUN Alpha provenance predicate",
  );
  assertExactObjectKeys(
    definition,
    ["buildType", "externalParameters", "internalParameters", "resolvedDependencies"],
    "Internal TUN Alpha provenance build definition",
  );
  assertExactObjectKeys(
    external,
    ["architecture", "packageProfile", "packageVersion", "sourceSha"],
    "Internal TUN Alpha provenance external parameters",
  );
  assertExactObjectKeys(
    runDetails,
    ["builder", "metadata"],
    "Internal TUN Alpha provenance run details",
  );
  assertExactObjectKeys(builder, ["id"], "Internal TUN Alpha provenance builder");
  assertExactObjectKeys(metadata, ["invocationId"], "Internal TUN Alpha provenance metadata");
  invariant(
    statement._type === "https://in-toto.io/Statement/v1" &&
      statement.predicateType === "https://slsa.dev/provenance/v1" &&
      Array.isArray(subject) &&
      subject.length === 1 &&
      JSON.stringify(subject[0]) ===
        JSON.stringify({
          digest: { sha256: fileSha256(path.join(directory, dmgName)) },
          name: dmgName,
        }),
    "Internal TUN Alpha provenance does not bind the exact DMG subject.",
  );
  invariant(
    external.packageProfile === "internal-tun-alpha" &&
      external.packageVersion === packageVersion &&
      external.architecture === "arm64" &&
      external.sourceSha === identity.sourceSha,
    "Internal TUN Alpha provenance source or profile changed.",
  );
  const expectedInternal = {
    allowTun: true,
    controllerSha256: packageFileByRole(manifest, "controller").sha256,
    coreSha256: packageFileByRole(manifest, "core").sha256,
    coreVersion: manifest.coreVersion,
    developerIdRequired: false,
    helperSha256: packageFileByRole(manifest, "helper").sha256,
    helperVersion: manifest.helperVersion,
    installationIdentityScheme: manifest.installationIdentityScheme,
    minimumMacosVersion: 13,
    networkMutationEnabled: true,
    packageManifestSha256: fileSha256(path.join(directory, packageManifestName)),
    plistTemplateSha256: packageFileByRole(manifest, "launch-daemon-template").sha256,
    protocolVersion: 3,
  };
  invariant(
    JSON.stringify(internal) === JSON.stringify(expectedInternal),
    "Internal TUN Alpha Helper/Core/plist/version/installation provenance changed.",
  );
  invariant(
    builder.id ===
      `https://github.com/${identity.repository}/actions/workflows/` +
        `stage-macos-alpha-release.yml@${identity.workflowSha}` &&
      metadata.invocationId ===
        `https://github.com/${identity.repository}/actions/runs/` +
          `${identity.runId}/attempts/${identity.runAttempt}`,
    "Internal TUN Alpha workflow/tooling/run provenance changed.",
  );
  invariant(
    Array.isArray(definition.resolvedDependencies),
    "Internal TUN Alpha provenance dependencies are missing.",
  );
  const dependencies = definition.resolvedDependencies as Array<Record<string, unknown>>;
  const gitDependency = dependencies[0];
  invariant(
    JSON.stringify(gitDependency) ===
      JSON.stringify({
        digest: { gitCommit: identity.sourceSha },
        uri: `git+ssh://github.com/${identity.repository}.git`,
      }),
    "Internal TUN Alpha provenance source dependency changed.",
  );
  const fileDependencies = dependencies.slice(1);
  invariant(
    fileDependencies.length === sourceInputPaths.length &&
      fileDependencies.every((dependency, index) => {
        const relative = sourceInputPaths[index];
        return (
          dependency.uri === `file:${relative}` &&
          JSON.stringify(dependency.digest) ===
            JSON.stringify({ sha256: fileSha256(path.join(sourceRoot, relative)) })
        );
      }),
    "Internal TUN Alpha tooling, source inputs, or dependency lockfiles changed.",
  );
}

function assertSbom(value: unknown, directory: string, manifest: PackageManifest): void {
  const document = recordValue(value, "Internal TUN Alpha SBOM");
  assertExactObjectKeys(
    document,
    [
      "SPDXID",
      "creationInfo",
      "dataLicense",
      "documentNamespace",
      "files",
      "name",
      "packages",
      "relationships",
      "spdxVersion",
    ],
    "Internal TUN Alpha SBOM",
  );
  invariant(
    document.spdxVersion === "SPDX-2.3" &&
      document.SPDXID === "SPDXRef-DOCUMENT" &&
      document.dataLicense === "CC0-1.0" &&
      typeof document.documentNamespace === "string" &&
      document.documentNamespace.endsWith(`/${fileSha256(path.join(directory, dmgName))}`),
    "Internal TUN Alpha SBOM document identity changed.",
  );
  invariant(
    Array.isArray(document.files) && document.files.length === manifest.files.length + 1,
    "Internal TUN Alpha SBOM file inventory is partial or duplicated.",
  );
  const sbomFiles = document.files as Array<Record<string, unknown>>;
  for (const [index, file] of manifest.files.entries()) {
    const sbomFile = sbomFiles[index];
    invariant(
      sbomFile.fileName === file.path &&
        JSON.stringify(sbomFile.checksums) ===
          JSON.stringify([{ algorithm: "SHA256", checksumValue: file.sha256 }]),
      `Internal TUN Alpha SBOM differs for ${file.path}.`,
    );
  }
  const packageManifestFile = sbomFiles.at(-1);
  invariant(
    packageManifestFile?.fileName === "internal-tun-alpha-manifest.json" &&
      JSON.stringify(packageManifestFile.checksums) ===
        JSON.stringify([
          {
            algorithm: "SHA256",
            checksumValue: fileSha256(path.join(directory, packageManifestName)),
          },
        ]),
    "Internal TUN Alpha SBOM omits the exact package manifest.",
  );
  invariant(
    Array.isArray(document.packages) &&
      document.packages.length === 2 &&
      (document.packages as Array<Record<string, unknown>>).some(
        (candidate) =>
          candidate.name === "Mihomo Core" && candidate.versionInfo === manifest.coreVersion,
      ),
    "Internal TUN Alpha SBOM component versions are incomplete.",
  );
}

function verifyAdHocSignature(file: string): void {
  const result = spawnSync("/usr/bin/codesign", ["-d", "--verbose=4", file], {
    encoding: "utf8",
  });
  const evidence = `${result.stdout}\n${result.stderr}`;
  invariant(
    result.status === 0 &&
      /^Signature=adhoc$/mu.test(evidence) &&
      /^TeamIdentifier=not set$/mu.test(evidence) &&
      !/^Authority=/mu.test(evidence),
    `Internal TUN Alpha contains non-ad-hoc Mish code: ${path.basename(file)}`,
  );
}

function verifyArm64(file: string): void {
  const output = execFileSync("/usr/bin/file", ["-b", file], { encoding: "utf8" });
  invariant(
    /\bMach-O\b/u.test(output) && /\barm64\b/u.test(output) && !/\bx86_64\b/u.test(output),
    `Internal TUN Alpha executable is not thin ARM64: ${path.basename(file)}`,
  );
}

function validateMountedFile(
  root: string,
  ownerUid: number,
  ownerGid: number,
  evidence: PackageManifestFile,
): void {
  const absolute = path.join(root, evidence.path);
  const metadata = lstatSync(absolute);
  invariant(
    metadata.isFile() &&
      !metadata.isSymbolicLink() &&
      metadata.uid === ownerUid &&
      metadata.gid === ownerGid &&
      metadata.nlink === 1 &&
      (metadata.mode & 0o777) === evidence.mode &&
      metadata.size === evidence.size,
    `Internal TUN Alpha mounted metadata differs: ${evidence.path}`,
  );
  invariant(
    fileSha256(absolute) === evidence.sha256,
    `Internal TUN Alpha mounted digest differs: ${evidence.path}`,
  );
}

function walk(root: string, directory = root): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).split(path.sep).join("/");
      const metadata = lstatSync(absolute);
      invariant(!metadata.isSymbolicLink(), `Internal TUN Alpha DMG contains a link: ${relative}`);
      if (metadata.isDirectory()) return [relative, ...walk(root, absolute)];
      invariant(
        metadata.isFile() && metadata.nlink === 1,
        `Internal TUN Alpha DMG contains a hard link or special file: ${relative}`,
      );
      return [relative];
    })
    .sort();
}

function detach(mountpoint: string): void {
  const failures: string[] = [];
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const result = spawnSync("/usr/bin/hdiutil", ["detach", mountpoint], {
      encoding: "utf8",
    });
    if (result.status === 0) return;
    failures.push(String(result.stderr).trim());
  }
  throw new Error(`Internal TUN Alpha DMG detach failed: ${failures.join(" | ")}`);
}

function verifyMountedPackage(dmg: string, sourceRoot: string, manifest: PackageManifest): void {
  invariant(
    process.platform === "darwin" && process.arch === "arm64",
    "Internal TUN Alpha independent verification requires Apple Silicon macOS.",
  );
  const imageBytes = readFileSync(dmg);
  const sectorBytes = 2048;
  const fixedIsoDate = Buffer.concat([Buffer.from("2020010100000000", "ascii"), Buffer.from([0])]);
  const fixedIsoRecordDate = Buffer.from([120, 1, 1, 0, 0, 0, 0]);
  let foundPrimaryIso = false;
  let isoRecordDateFields = 0;
  let isoSuspDateFields = 0;
  const verifyIsoDirectory = (extent: number, size: number, visited: Set<number>): void => {
    const start = extent * sectorBytes;
    const end = start + size;
    invariant(
      extent > 0 && size > 0 && end <= imageBytes.length && !visited.has(extent),
      "Internal TUN Alpha ISO9660 directory graph is invalid.",
    );
    visited.add(extent);
    let cursor = start;
    while (cursor < end) {
      const recordLength = imageBytes[cursor];
      if (recordLength === 0) {
        cursor = Math.min(end, Math.ceil((cursor + 1) / sectorBytes) * sectorBytes);
        continue;
      }
      invariant(
        recordLength >= 34 &&
          cursor + recordLength <= end &&
          cursor + recordLength <= imageBytes.length &&
          imageBytes.subarray(cursor + 18, cursor + 25).equals(fixedIsoRecordDate),
        "Internal TUN Alpha ISO9660 directory record is mutable or invalid.",
      );
      isoRecordDateFields += 1;
      const nameLength = imageBytes[cursor + 32];
      invariant(
        nameLength > 0 && 33 + nameLength <= recordLength,
        "Internal TUN Alpha ISO9660 directory name is invalid.",
      );
      let systemUse = cursor + 33 + nameLength + (nameLength % 2 === 0 ? 1 : 0);
      while (systemUse + 4 <= cursor + recordLength) {
        const entryLength = imageBytes[systemUse + 2];
        if (entryLength === 0) break;
        invariant(
          entryLength >= 4 && systemUse + entryLength <= cursor + recordLength,
          "Internal TUN Alpha ISO9660 system-use entry is invalid.",
        );
        if (imageBytes.subarray(systemUse, systemUse + 2).toString("ascii") === "TF") {
          const flags = imageBytes[systemUse + 4];
          invariant(
            (flags & 0x80) === 0,
            "Internal TUN Alpha ISO9660 uses an unexpected long timestamp.",
          );
          const timestampCount = [0x01, 0x02, 0x04, 0x08, 0x10, 0x20, 0x40].filter(
            (flag) => (flags & flag) !== 0,
          ).length;
          invariant(
            entryLength === 5 + timestampCount * fixedIsoRecordDate.length,
            "Internal TUN Alpha ISO9660 timestamp entry is malformed.",
          );
          for (let index = 0; index < timestampCount; index += 1) {
            invariant(
              imageBytes
                .subarray(
                  systemUse + 5 + index * fixedIsoRecordDate.length,
                  systemUse + 5 + (index + 1) * fixedIsoRecordDate.length,
                )
                .equals(fixedIsoRecordDate),
              "Internal TUN Alpha ISO9660 system-use timestamp is mutable.",
            );
            isoSuspDateFields += 1;
          }
        }
        systemUse += entryLength;
      }
      const isDotEntry =
        nameLength === 1 && (imageBytes[cursor + 33] === 0 || imageBytes[cursor + 33] === 1);
      if ((imageBytes[cursor + 25] & 0x02) !== 0 && !isDotEntry) {
        verifyIsoDirectory(
          imageBytes.readUInt32LE(cursor + 2),
          imageBytes.readUInt32LE(cursor + 10),
          visited,
        );
      }
      cursor += recordLength;
    }
  };
  for (let sector = 16; sector * sectorBytes + sectorBytes <= imageBytes.length; sector += 1) {
    const descriptor = sector * sectorBytes;
    const type = imageBytes[descriptor];
    invariant(
      imageBytes.subarray(descriptor + 1, descriptor + 6).toString("ascii") === "CD001" &&
        imageBytes[descriptor + 6] === 1,
      "Internal TUN Alpha ISO9660 descriptor is invalid.",
    );
    if (type === 1 || type === 2) {
      if (type === 1) foundPrimaryIso = true;
      invariant(
        [813, 830, 864].every((offset) =>
          imageBytes
            .subarray(descriptor + offset, descriptor + offset + fixedIsoDate.length)
            .equals(fixedIsoDate),
        ),
        "Internal TUN Alpha ISO9660 descriptor date is mutable.",
      );
      const rootDirectoryRecord = descriptor + 156;
      invariant(
        imageBytes[rootDirectoryRecord] >= 34 &&
          imageBytes
            .subarray(rootDirectoryRecord + 18, rootDirectoryRecord + 25)
            .equals(fixedIsoRecordDate),
        "Internal TUN Alpha ISO9660 root directory record is invalid.",
      );
      isoRecordDateFields += 1;
      verifyIsoDirectory(
        imageBytes.readUInt32LE(rootDirectoryRecord + 2),
        imageBytes.readUInt32LE(rootDirectoryRecord + 10),
        new Set(),
      );
    }
    if (type === 255) break;
  }
  invariant(
    foundPrimaryIso && isoRecordDateFields === 38 && isoSuspDateFields === 112,
    "Internal TUN Alpha ISO9660 timestamp inventory is incomplete.",
  );
  const fixedHfsVolumeId = createHash("sha256")
    .update("Mish Internal TUN Alpha HFS volume v1")
    .digest()
    .subarray(0, 8);
  const fixedHfsTime = Buffer.alloc(4);
  fixedHfsTime.writeUInt32BE(
    Math.floor(new Date("2020-01-01T00:00:00.000Z").getTime() / 1000) + 2_082_844_800,
  );
  let hfsHeaders = 0;
  for (let offset = 0; offset + 112 <= imageBytes.length; offset += 512) {
    if (
      imageBytes[offset] === 0x48 &&
      imageBytes[offset + 1] === 0x2b &&
      imageBytes.readUInt16BE(offset + 2) === 4
    ) {
      invariant(
        imageBytes.subarray(offset + 104, offset + 112).equals(fixedHfsVolumeId) &&
          [16, 20, 24, 28].every((dateOffset) =>
            imageBytes.subarray(offset + dateOffset, offset + dateOffset + 4).equals(fixedHfsTime),
          ),
        "Internal TUN Alpha HFS+ volume identity or time is mutable.",
      );
      hfsHeaders += 1;
    }
  }
  invariant(
    hfsHeaders === 2,
    "Internal TUN Alpha DMG is not the deterministic HFS+/ISO9660 hybrid profile.",
  );
  const temporary = mkdtempSync(path.join(tmpdir(), "mish-internal-tun-alpha-verify-"));
  const mountpoint = path.join(temporary, "mount");
  mkdirSync(mountpoint, { mode: 0o700 });
  let attached = false;
  try {
    execFileSync(
      "/usr/bin/hdiutil",
      ["attach", "-readonly", "-nobrowse", "-noautoopen", "-mountpoint", mountpoint, dmg],
      { stdio: "pipe" },
    );
    attached = true;
    const mountEvidence = execFileSync("/sbin/mount", [], { encoding: "utf8" });
    const canonicalMountpoint = realpathSync(mountpoint);
    invariant(
      mountEvidence
        .split("\n")
        .some(
          (line) =>
            line.includes(` on ${canonicalMountpoint} `) &&
            line.includes("(hfs,") &&
            line.includes("read-only"),
        ),
      "Internal TUN Alpha verification did not mount the DMG read-only.",
    );
    const expectedEntries = new Set(["internal-tun-alpha-manifest.json"]);
    for (const file of manifest.files) {
      expectedEntries.add(file.path);
      let parent = path.posix.dirname(file.path);
      while (parent !== ".") {
        expectedEntries.add(parent);
        parent = path.posix.dirname(parent);
      }
    }
    invariant(
      JSON.stringify(walk(mountpoint)) === JSON.stringify([...expectedEntries].sort()),
      "Internal TUN Alpha DMG layout is partial, duplicated, substituted, or unexpected.",
    );
    const ownerUid = process.getuid?.();
    const ownerGid = process.getgid?.();
    invariant(
      ownerUid !== undefined && ownerGid !== undefined,
      "Internal TUN Alpha verifier cannot observe its UID/GID.",
    );
    for (const relative of ["", ...walk(mountpoint)]) {
      const directory = path.join(mountpoint, relative);
      const metadata = lstatSync(directory);
      if (!metadata.isDirectory()) continue;
      invariant(
        metadata.isDirectory() &&
          !metadata.isSymbolicLink() &&
          metadata.uid === ownerUid &&
          metadata.gid === ownerGid &&
          (metadata.mode & 0o777) === 0o755,
        `Internal TUN Alpha mounted directory metadata differs: ${directory}`,
      );
    }
    for (const file of manifest.files) {
      validateMountedFile(mountpoint, ownerUid, ownerGid, file);
    }
    const mountedManifest = path.join(mountpoint, "internal-tun-alpha-manifest.json");
    const manifestMetadata = lstatSync(mountedManifest);
    invariant(
      manifestMetadata.isFile() &&
        manifestMetadata.uid === ownerUid &&
        manifestMetadata.gid === ownerGid &&
        manifestMetadata.nlink === 1 &&
        (manifestMetadata.mode & 0o777) === 0o644 &&
        readFileSync(mountedManifest).equals(
          readFileSync(path.join(path.dirname(dmg), packageManifestName)),
        ),
      "Internal TUN Alpha mounted package manifest differs from staged evidence.",
    );

    for (const role of ["controller", "helper", "core"]) {
      verifyArm64(path.join(mountpoint, packageFileByRole(manifest, role).path));
    }
    verifyAdHocSignature(path.join(mountpoint, packageFileByRole(manifest, "controller").path));
    verifyAdHocSignature(path.join(mountpoint, packageFileByRole(manifest, "helper").path));
    const app = path.join(mountpoint, "Mish.app");
    const appExecutable = path.join(app, "Contents/MacOS/mish-desktop");
    verifyArm64(appExecutable);
    verifyAdHocSignature(app);
    const releaseEvidence = JSON.parse(
      execFileSync(appExecutable, ["--release-profile-evidence"], {
        encoding: "utf8",
        timeout: 5_000,
      }),
    ) as { profile?: string; tun?: string };
    invariant(
      releaseEvidence.profile === "internal-tun-alpha" && releaseEvidence.tun === "supported",
      "Internal TUN Alpha app does not expose the exact packaged TUN profile.",
    );

    for (const [role, source] of [
      ["license", "LICENSE"],
      ["notices", "THIRD_PARTY_NOTICES.md"],
      [
        "launch-daemon-template",
        "resources/internal-tun-alpha/com.asuka109.mish.tun-helper.dev.plist.template",
      ],
    ] as const) {
      invariant(
        readFileSync(path.join(mountpoint, packageFileByRole(manifest, role).path)).equals(
          readFileSync(path.join(sourceRoot, source)),
        ),
        `Internal TUN Alpha ${role} resource differs from frozen source.`,
      );
    }
    const readme = readFileSync(path.join(mountpoint, "README.txt"), "utf8");
    for (const requirement of [
      "explicitly trusted internal distribution",
      "not a public release",
      "Open Anyway",
      "administrator",
      "Apple Silicon",
      "macOS 13",
      "Repair Internal TUN Alpha.command",
      "Uninstall Internal TUN Alpha.command",
      "same user",
    ]) {
      invariant(
        readme.includes(requirement),
        `Internal TUN Alpha README is missing the ${requirement} boundary.`,
      );
    }
    const plist = readFileSync(
      path.join(mountpoint, packageFileByRole(manifest, "launch-daemon-template").path),
      "utf8",
    );
    invariant(
      plist.includes("<key>MISH_TUN_SERVICE_ALLOW_TUN</key><string>1</string>") &&
        !plist.includes("SMAppService") &&
        !plist.includes("MachServices") &&
        !plist.includes("BundleProgram"),
      "Internal TUN Alpha plist leaks a production or variable privileged profile.",
    );
  } finally {
    if (attached) detach(mountpoint);
    rmSync(temporary, { force: true, recursive: true });
  }
}

function assertSourceProtocol(sourceRoot: string, manifest: PackageManifest): void {
  const runtime = readFileSync(path.join(sourceRoot, "crates/runtime/src/tun_helper.rs"), "utf8");
  invariant(
    runtime.includes(`TUN_HELPER_EXPECTED_VERSION: &str = "${manifest.helperVersion}"`) &&
      runtime.includes("TUN_HELPER_PROTOCOL_VERSION: u16 = 3") &&
      runtime.includes("TUN_HELPER_MAX_MESSAGE_BYTES: usize = 16 * 1024"),
    "Internal TUN Alpha Helper version or closed protocol differs from frozen source.",
  );
  const controller = readFileSync(
    path.join(sourceRoot, "crates/platform-macos/src/bin/mish-internal-tun-alpha-ctl.rs"),
    "utf8",
  );
  const actions = [...controller.matchAll(/^\s*"([^"]+)" => Ok\(UserAction::/gmu)].map(
    (match) => match[1],
  );
  invariant(
    JSON.stringify(actions) ===
      JSON.stringify(["health", "install", "repair", "status", "uninstall"]),
    "Internal TUN Alpha controller protocol exposes an unexpected lifecycle action.",
  );
  const corePin = readJson(path.join(sourceRoot, "resources/mihomo/macos-arm64.json"));
  const coreRecord = recordValue(corePin, "Pinned Mihomo manifest");
  invariant(
    coreRecord.version === manifest.coreVersion &&
      coreRecord.binarySha256 === packageFileByRole(manifest, "core").sha256,
    "Internal TUN Alpha Core digest or version differs from the frozen pin.",
  );
}

function assertNoDevelopmentPathOrSecret(dmg: string, sourceRoot: string): void {
  const bytes = readFileSync(dmg);
  for (const marker of [
    sourceRoot,
    "/Users/runner/work/",
    "/Users/asuka/",
    "/home/runner/work/",
    ".release-tooling/",
    "-----BEGIN PRIVATE KEY-----",
  ]) {
    invariant(
      !bytes.includes(Buffer.from(marker)),
      `Internal TUN Alpha DMG contains a development path or private-key marker: ${marker}`,
    );
  }
}

function verificationEvidence(
  options: VerifyOptions,
  candidate: CandidateManifest,
  manifest: PackageManifest,
): InternalTunAlphaVerificationEvidence {
  return {
    candidateArtifact: {
      bundleSha256: candidate.bundleSha256,
      id: options.artifactId,
      name: options.artifactName,
    },
    checks: [
      "archive-layout",
      "ownership-mode-link-policy",
      "helper-core-exact-digests-and-versions",
      "closed-protocol",
      "enrollment-boundary",
      "profile-isolation",
      "legal-resources",
      "source-tooling-lockfiles",
      "sbom-provenance",
      "sha256",
    ],
    dmg: {
      format: "read-only-hfs-iso9660-hybrid-disk-image",
      name: dmgName,
      sha256: fileSha256(path.join(options.directory, dmgName)),
    },
    identity: options.identity,
    package: {
      controllerSha256: packageFileByRole(manifest, "controller").sha256,
      coreSha256: packageFileByRole(manifest, "core").sha256,
      coreVersion: manifest.coreVersion,
      helperSha256: packageFileByRole(manifest, "helper").sha256,
      helperVersion: manifest.helperVersion,
      installationIdentityScheme: manifest.installationIdentityScheme,
      manifestSha256: fileSha256(path.join(options.directory, packageManifestName)),
      plistTemplateSha256: packageFileByRole(manifest, "launch-daemon-template").sha256,
      profile: "internal-tun-alpha",
      protocolVersion: 3,
      version: packageVersion,
    },
    schemaVersion: 1,
    status: "verified",
  };
}

export function verifyInternalTunAlphaVerificationEvidence(options: {
  candidateArtifactId: string;
  candidateArtifactName: string;
  candidateBundleSha256: string;
  evidence: unknown;
  identity: DispatchIdentity;
  verificationArtifactId: string;
}): InternalTunAlphaVerificationEvidence {
  invariant(
    numericId.test(options.candidateArtifactId) && numericId.test(options.verificationArtifactId),
    "Internal TUN Alpha evidence requires immutable numeric artifact IDs.",
  );
  invariant(options.evidence && typeof options.evidence === "object", "Verification is missing.");
  const evidence = options.evidence as InternalTunAlphaVerificationEvidence;
  assertExactObjectKeys(
    evidence,
    ["candidateArtifact", "checks", "dmg", "identity", "package", "schemaVersion", "status"],
    "Internal TUN Alpha verification evidence",
  );
  invariant(
    evidence.schemaVersion === 1 &&
      evidence.status === "verified" &&
      JSON.stringify(evidence.candidateArtifact) ===
        JSON.stringify({
          bundleSha256: options.candidateBundleSha256,
          id: options.candidateArtifactId,
          name: options.candidateArtifactName,
        }) &&
      evidence.dmg.name === dmgName &&
      evidence.dmg.format === "read-only-hfs-iso9660-hybrid-disk-image" &&
      sha256Digest.test(evidence.dmg.sha256),
    "Internal TUN Alpha verification evidence is partial, stale, or mismatched.",
  );
  assertExactObjectKeys(
    evidence.candidateArtifact,
    ["bundleSha256", "id", "name"],
    "Internal TUN Alpha verified candidate identity",
  );
  assertExactObjectKeys(
    evidence.dmg,
    ["format", "name", "sha256"],
    "Internal TUN Alpha verified DMG identity",
  );
  assertExactObjectKeys(
    evidence.package,
    [
      "controllerSha256",
      "coreSha256",
      "coreVersion",
      "helperSha256",
      "helperVersion",
      "installationIdentityScheme",
      "manifestSha256",
      "plistTemplateSha256",
      "profile",
      "protocolVersion",
      "version",
    ],
    "Internal TUN Alpha verified package identity",
  );
  assertIdentity(evidence.identity, options.identity);
  invariant(
    JSON.stringify(evidence.checks) ===
      JSON.stringify([
        "archive-layout",
        "ownership-mode-link-policy",
        "helper-core-exact-digests-and-versions",
        "closed-protocol",
        "enrollment-boundary",
        "profile-isolation",
        "legal-resources",
        "source-tooling-lockfiles",
        "sbom-provenance",
        "sha256",
      ]),
    "Internal TUN Alpha verification checks are missing, duplicated, or reordered.",
  );
  invariant(
    evidence.package.profile === "internal-tun-alpha" &&
      evidence.package.version === packageVersion &&
      evidence.package.protocolVersion === 3 &&
      evidence.package.installationIdentityScheme === "sha256-helper-core-rendered-plist-v1" &&
      [
        evidence.package.controllerSha256,
        evidence.package.coreSha256,
        evidence.package.helperSha256,
        evidence.package.manifestSha256,
        evidence.package.plistTemplateSha256,
      ].every((digest) => sha256Digest.test(digest)),
    "Internal TUN Alpha verified package identity is invalid.",
  );
  return evidence;
}

export function verifyInternalTunAlphaCandidate(
  options: VerifyOptions,
): InternalTunAlphaVerificationEvidence {
  invariant(
    path.resolve(options.directory) === options.directory &&
      path.resolve(options.sourceRoot) === options.sourceRoot,
    "Internal TUN Alpha verification paths must be absolute and canonical.",
  );
  const candidate = verifyCandidateManifest({
    directory: options.directory,
    expectedArtifactId: options.artifactId,
    expectedArtifactName: options.artifactName,
    expectedIdentity: options.identity,
    policy: stagePolicy(),
    requiredRoles: Object.values(candidateRoles),
  });
  assertCandidateManifest(candidate, candidateKind, candidateRoles);
  const manifestValue = readJson(path.join(options.directory, packageManifestName));
  assertPackageManifest(manifestValue);
  const manifest = manifestValue;
  assertChecksums(options.directory);
  assertProvenance(
    readJson(path.join(options.directory, provenanceName)),
    options.directory,
    options.sourceRoot,
    options.identity,
    manifest,
  );
  assertSbom(readJson(path.join(options.directory, sbomName)), options.directory, manifest);
  assertSourceProtocol(options.sourceRoot, manifest);
  assertNoDevelopmentPathOrSecret(path.join(options.directory, dmgName), options.sourceRoot);
  verifyMountedPackage(path.join(options.directory, dmgName), options.sourceRoot, manifest);
  const evidence = verificationEvidence(options, candidate, manifest);
  if (options.evidenceOutput) {
    invariant(
      !existsSync(options.evidenceOutput),
      "Internal TUN Alpha verification evidence already exists and cannot be replaced.",
    );
    writeFileSync(options.evidenceOutput, `${JSON.stringify(evidence, null, 2)}\n`, {
      mode: 0o444,
    });
    chmodSync(options.evidenceOutput, 0o444);
  }
  return evidence;
}

export function confirmInternalTunAlphaStage(options: ConfirmOptions): {
  evidence: InternalTunAlphaVerificationEvidence;
  manifest: CandidateManifest;
} {
  const finalManifest = verifyCandidateManifest({
    directory: options.directory,
    expectedArtifactId: options.artifactId,
    expectedArtifactName: options.artifactName,
    expectedIdentity: options.identity,
    policy: stagePolicy(finalManifestName),
    requiredRoles: Object.values(finalRoles),
  });
  assertCandidateManifest(finalManifest, finalKind, finalRoles);
  const candidateDirectory = path.join(options.directory, "candidate");
  const evidenceValue = readJson(path.join(options.directory, "verification", verificationName));
  const evidenceRecord = recordValue(
    evidenceValue,
    "Internal TUN Alpha final verification evidence",
  );
  const candidateArtifact = recordValue(
    evidenceRecord.candidateArtifact,
    "Internal TUN Alpha candidate artifact identity",
  );
  invariant(
    typeof candidateArtifact.id === "string" &&
      typeof candidateArtifact.name === "string" &&
      typeof candidateArtifact.bundleSha256 === "string",
    "Internal TUN Alpha candidate artifact evidence is invalid.",
  );
  const candidate = verifyCandidateManifest({
    directory: candidateDirectory,
    expectedArtifactId: candidateArtifact.id,
    expectedArtifactName: candidateArtifact.name,
    expectedIdentity: options.identity,
    policy: stagePolicy(),
    requiredRoles: Object.values(candidateRoles),
  });
  assertCandidateManifest(candidate, candidateKind, candidateRoles);
  const stageInputs = recordValue(
    readJson(path.join(options.directory, stageInputsName)),
    "Internal TUN Alpha immutable input binding",
  );
  assertExactObjectKeys(
    stageInputs,
    ["candidateArtifact", "identity", "schemaVersion", "verificationArtifact"],
    "Internal TUN Alpha immutable input binding",
  );
  const boundCandidate = recordValue(
    stageInputs.candidateArtifact,
    "Internal TUN Alpha bound candidate",
  );
  const boundVerification = recordValue(
    stageInputs.verificationArtifact,
    "Internal TUN Alpha bound verification",
  );
  assertExactObjectKeys(
    boundCandidate,
    ["bundleSha256", "id", "name"],
    "Internal TUN Alpha bound candidate",
  );
  assertExactObjectKeys(
    boundVerification,
    ["evidenceSha256", "id", "name"],
    "Internal TUN Alpha bound verification",
  );
  invariant(
    stageInputs.schemaVersion === 1 &&
      JSON.stringify(stageInputs.identity) === JSON.stringify(options.identity) &&
      boundCandidate.id === candidateArtifact.id &&
      boundCandidate.name === candidateArtifact.name &&
      boundCandidate.bundleSha256 === candidate.bundleSha256 &&
      typeof boundVerification.id === "string" &&
      numericId.test(boundVerification.id) &&
      typeof boundVerification.name === "string" &&
      boundVerification.name.length > 0 &&
      boundVerification.evidenceSha256 ===
        fileSha256(path.join(options.directory, "verification", verificationName)),
    "Internal TUN Alpha immutable candidate or verification input binding differs.",
  );
  const evidence = verifyInternalTunAlphaVerificationEvidence({
    candidateArtifactId: candidateArtifact.id,
    candidateArtifactName: candidateArtifact.name,
    candidateBundleSha256: candidate.bundleSha256,
    evidence: evidenceValue,
    identity: options.identity,
    verificationArtifactId: boundVerification.id,
  });
  const rerun = verifyInternalTunAlphaCandidate({
    artifactId: candidateArtifact.id,
    artifactName: candidateArtifact.name,
    directory: candidateDirectory,
    identity: options.identity,
    sourceRoot: options.sourceRoot,
  });
  invariant(
    JSON.stringify(rerun) === JSON.stringify(evidence),
    "Internal TUN Alpha final artifact differs from independent verification evidence.",
  );
  invariant(
    evidence.dmg.sha256 === fileSha256(path.join(candidateDirectory, dmgName)),
    "Internal TUN Alpha final DMG digest changed after verification.",
  );
  return { evidence, manifest: finalManifest };
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  const common = {
    artifactId: option(arguments_, "--artifact-id"),
    artifactName: option(arguments_, "--artifact-name"),
    directory: path.resolve(option(arguments_, "--directory")),
    identity: identityFromArguments(arguments_),
    sourceRoot: path.resolve(option(arguments_, "--source-root")),
  };
  if (command === "verify") {
    const evidenceOutput = path.resolve(option(arguments_, "--evidence-output"));
    const evidence = verifyInternalTunAlphaCandidate({ ...common, evidenceOutput });
    console.log(JSON.stringify({ dmgSha256: evidence.dmg.sha256, ok: true }));
    return;
  }
  if (command === "confirm") {
    const result = confirmInternalTunAlphaStage(common);
    console.log(
      JSON.stringify({
        bundleSha256: result.manifest.bundleSha256,
        dmgSha256: result.evidence.dmg.sha256,
        ok: true,
      }),
    );
    return;
  }
  throw new Error("Usage: verify-internal-tun-alpha-stage.ts <verify|confirm> [options]");
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(
      error instanceof Error ? error.message : "Internal TUN Alpha verification failed.",
    );
    process.exitCode = 1;
  }
}
