import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  createCandidateManifest,
  readTrustedReleasePolicy,
  verifyCandidateManifest,
  type CandidateManifest,
  type DispatchIdentity,
} from "./trusted-release-policy.ts";
import {
  internalTunAlphaManifestRelativePath,
  internalTunAlphaPackageVersion as embeddedInternalTunAlphaPackageVersion,
} from "./internal-tun-alpha-package.ts";
import { createMacOsDmg } from "./macos-dmg-presentation.ts";
import { verifyInternalTunAlphaVerificationEvidence } from "./verify-internal-tun-alpha-stage.ts";

export const internalTunAlphaStageKind = "internal-tun-alpha-immutable-stage";
export const internalTunAlphaCandidateKind = "internal-tun-alpha-dmg-candidate";
export const internalTunAlphaPackageVersion = embeddedInternalTunAlphaPackageVersion;
export const internalTunAlphaDmgName = `Mish-Internal-TUN-Alpha-${internalTunAlphaPackageVersion}-arm64.dmg`;
export const internalTunAlphaPackageManifestName = "internal-tun-alpha-package-manifest.json";
export const internalTunAlphaSbomName = "internal-tun-alpha-sbom.spdx.json";
export const internalTunAlphaProvenanceName = "internal-tun-alpha-provenance.intoto.json";
export const internalTunAlphaChecksumsName = "SHA256SUMS.txt";
export const internalTunAlphaVerificationName = "internal-tun-alpha-verification.json";
export const internalTunAlphaFinalManifestName = "internal-tun-alpha-stage-manifest.json";
export const internalTunAlphaStageInputsName = "internal-tun-alpha-stage-inputs.json";

const fixedTimestamp = new Date("2020-01-01T00:00:00.000Z");
const applicationMainExecutableRelativePath = "Contents/MacOS/mish-desktop";
const fullSha = /^[0-9a-f]{40}$/u;
const numericId = /^[1-9][0-9]*$/u;
const safeArtifactName = /^[A-Za-z0-9._-]+$/u;
const sha256Digest = /^[0-9a-f]{64}$/u;
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
  "resources/macos-dmg/mish-install.png",
  "resources/macos-dmg/mish-install.svg",
  "resources/macos-dmg/mish-installer-template.dmg",
  "resources/macos-dmg/presentation.json",
  "resources/mihomo/macos-arm64.json",
  "scripts/development-mihomo.ts",
  "scripts/internal-tun-alpha-package.ts",
  "scripts/macos-dmg-presentation.ts",
  "scripts/prepare-mihomo.ts",
  "skills-lock.json",
] as const;
const candidateRoles = {
  [internalTunAlphaChecksumsName]: "sha256sums",
  [internalTunAlphaDmgName]: "internal-tun-alpha-dmg",
  [internalTunAlphaPackageManifestName]: "package-manifest",
  [internalTunAlphaProvenanceName]: "build-provenance",
  [internalTunAlphaSbomName]: "sbom",
} as const;
const finalRoles = {
  ...Object.fromEntries(
    Object.entries(candidateRoles).map(([file, role]) => [`candidate/${file}`, role]),
  ),
  "candidate/trusted-candidate-manifest.json": "candidate-manifest",
  [internalTunAlphaStageInputsName]: "immutable-input-binding",
  [`verification/${internalTunAlphaVerificationName}`]: "verification-evidence",
} as const;

type PackageManifestFile = {
  mode: number;
  path: string;
  role: string;
  sha256: string;
  size: number;
};

type PackageManifest = {
  allowTun: true;
  architecture: "arm64";
  coreVersion: string;
  developerIdRequired: false;
  files: PackageManifestFile[];
  helperVersion: string;
  installationIdentityScheme: string;
  minimumMacosVersion: 13;
  networkMutationEnabled: true;
  packageVersion: string;
  profile: "internal-tun-alpha";
  protocolVersion: 3;
  schemaVersion: 1;
};

type PrepareOptions = {
  artifactName: string;
  identity: DispatchIdentity;
  outputDirectory: string;
  packageRoot: string;
  sourceRoot: string;
};

type FinalizeOptions = {
  candidateArtifactId: string;
  candidateArtifactName: string;
  candidateDirectory: string;
  finalArtifactName: string;
  identity: DispatchIdentity;
  outputDirectory: string;
  sourceRoot: string;
  verificationArtifactId: string;
  verificationArtifactName: string;
  verificationDirectory: string;
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

function stableJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (candidate && typeof candidate === "object") {
      return Object.fromEntries(
        Object.entries(candidate as Record<string, unknown>)
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, nested]) => [key, normalize(nested)]),
      );
    }
    return candidate;
  };
  return `${JSON.stringify(normalize(value), null, 2)}\n`;
}

function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, "utf8")) as T;
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

function assertIdentity(identity: DispatchIdentity): void {
  for (const [label, value] of [
    ["main", identity.mainSha],
    ["source", identity.sourceSha],
    ["tooling", identity.toolingSha],
    ["workflow", identity.workflowSha],
  ] as const) {
    invariant(fullSha.test(value), `Internal TUN Alpha ${label} SHA is invalid.`);
  }
  invariant(
    identity.sourceSha === identity.mainSha,
    "Internal TUN Alpha staging rejects stale or non-main source SHAs.",
  );
  invariant(
    identity.workflowSha === identity.mainSha && identity.toolingSha === identity.workflowSha,
    "Internal TUN Alpha staging requires one frozen main workflow/tooling revision.",
  );
  invariant(identity.sourceIsAncestor, "Internal TUN Alpha source ancestry was not confirmed.");
  invariant(
    numericId.test(identity.runId) && numericId.test(identity.runAttempt),
    "Internal TUN Alpha run identity is invalid.",
  );
}

function assertPackageManifest(value: PackageManifest): void {
  invariant(
    value.schemaVersion === 1 &&
      value.profile === "internal-tun-alpha" &&
      value.packageVersion === internalTunAlphaPackageVersion &&
      value.architecture === "arm64" &&
      value.minimumMacosVersion === 13 &&
      value.protocolVersion === 3 &&
      value.developerIdRequired === false &&
      value.allowTun === true &&
      value.networkMutationEnabled === true &&
      value.installationIdentityScheme === "sha256-helper-core-rendered-plist-v1" &&
      /^v[0-9]+\.[0-9]+\.[0-9]+$/u.test(value.coreVersion) &&
      /^[1-9][0-9]*$/u.test(value.helperVersion),
    "Internal TUN Alpha package manifest does not preserve the accepted profile.",
  );
  invariant(
    Array.isArray(value.files) &&
      value.files.length > 4 &&
      !value.files.some((file) => file.path === "Contents/MacOS/mish-desktop") &&
      value.files.every(
        (file) =>
          file &&
          Number.isSafeInteger(file.mode) &&
          (file.mode === 0o644 || file.mode === 0o755) &&
          Number.isSafeInteger(file.size) &&
          file.size > 0 &&
          sha256Digest.test(file.sha256),
      ),
    "Internal TUN Alpha package manifest file evidence is incomplete.",
  );
}

function packageFileByRole(manifest: PackageManifest, role: string): PackageManifestFile {
  const matches = manifest.files.filter((file) => file.role === role);
  invariant(matches.length === 1, `Internal TUN Alpha package must contain one ${role}.`);
  return matches[0];
}

function sourceInputs(sourceRoot: string): Array<{
  digest: { sha256: string };
  uri: string;
}> {
  return sourceInputPaths.map((relative) => {
    const absolute = path.join(sourceRoot, relative);
    invariant(
      existsSync(absolute) && lstatSync(absolute).isFile(),
      `Internal TUN Alpha source input is missing: ${relative}`,
    );
    return { digest: { sha256: fileSha256(absolute) }, uri: `file:${relative}` };
  });
}

function writeDmg(packageRoot: string, destination: string): void {
  invariant(process.platform === "darwin", "Internal TUN Alpha DMG creation requires macOS.");
  invariant(
    JSON.stringify(readdirSync(packageRoot).sort()) === JSON.stringify(["Mish.app"]),
    "Internal TUN Alpha package root contains unexpected installation items.",
  );
  const application = path.join(packageRoot, "Mish.app");
  invariant(
    lstatSync(application).isDirectory() && !lstatSync(application).isSymbolicLink(),
    "Internal TUN Alpha package root does not contain a real Mish.app bundle.",
  );
  createMacOsDmg(application, destination, { normalizeForDeterminism: true });
  chmodSync(destination, 0o644);
}

function createSbom(
  manifest: PackageManifest,
  applicationExecutableSha256: string,
  manifestSha256: string,
  identity: DispatchIdentity,
  dmgSha256: string,
): Record<string, unknown> {
  const files = [
    ...manifest.files.map((file, index) => ({
      SPDXID: `SPDXRef-File-${String(index + 1)}`,
      checksums: [{ algorithm: "SHA256", checksumValue: file.sha256 }],
      copyrightText: "NOASSERTION",
      fileName: file.path,
      fileTypes:
        file.role === "application" ||
        file.role === "controller" ||
        file.role === "core" ||
        file.role === "helper"
          ? ["BINARY"]
          : ["TEXT"],
      licenseConcluded: "NOASSERTION",
    })),
    {
      SPDXID: `SPDXRef-File-${String(manifest.files.length + 1)}`,
      checksums: [{ algorithm: "SHA256", checksumValue: applicationExecutableSha256 }],
      copyrightText: "NOASSERTION",
      fileName: applicationMainExecutableRelativePath,
      fileTypes: ["BINARY"],
      licenseConcluded: "NOASSERTION",
    },
    {
      SPDXID: `SPDXRef-File-${String(manifest.files.length + 2)}`,
      checksums: [{ algorithm: "SHA256", checksumValue: manifestSha256 }],
      copyrightText: "NOASSERTION",
      fileName: internalTunAlphaManifestRelativePath,
      fileTypes: ["TEXT"],
      licenseConcluded: "NOASSERTION",
    },
  ];
  return {
    SPDXID: "SPDXRef-DOCUMENT",
    creationInfo: {
      created: fixedTimestamp.toISOString(),
      creators: ["Tool: mish-internal-tun-alpha-staging-v1"],
    },
    dataLicense: "CC0-1.0",
    documentNamespace:
      `https://github.com/${identity.repository}/internal-tun-alpha/sbom/` +
      `${identity.sourceSha}/${dmgSha256}`,
    files,
    name: `Mish Internal TUN Alpha ${manifest.packageVersion} SBOM`,
    packages: [
      {
        SPDXID: "SPDXRef-Package-Mish-Internal-TUN-Alpha",
        checksums: [{ algorithm: "SHA256", checksumValue: dmgSha256 }],
        copyrightText: "NOASSERTION",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: true,
        licenseConcluded: "GPL-3.0-only",
        licenseDeclared: "GPL-3.0-only",
        name: "Mish Internal TUN Alpha",
        primaryPackagePurpose: "APPLICATION",
        supplier: "Organization: Mish",
        versionInfo: manifest.packageVersion,
      },
      {
        SPDXID: "SPDXRef-Package-Mihomo",
        checksums: [
          { algorithm: "SHA256", checksumValue: packageFileByRole(manifest, "core").sha256 },
        ],
        copyrightText: "NOASSERTION",
        downloadLocation: "NOASSERTION",
        filesAnalyzed: false,
        licenseConcluded: "NOASSERTION",
        licenseDeclared: "NOASSERTION",
        name: "Mihomo Core",
        primaryPackagePurpose: "APPLICATION",
        supplier: "Organization: MetaCubeX",
        versionInfo: manifest.coreVersion,
      },
    ],
    relationships: [
      {
        relatedSpdxElement: "SPDXRef-Package-Mish-Internal-TUN-Alpha",
        relationshipType: "DESCRIBES",
        spdxElementId: "SPDXRef-DOCUMENT",
      },
      ...files.map((file) => ({
        relatedSpdxElement: file.SPDXID,
        relationshipType: "CONTAINS",
        spdxElementId: "SPDXRef-Package-Mish-Internal-TUN-Alpha",
      })),
      {
        relatedSpdxElement: "SPDXRef-Package-Mihomo",
        relationshipType: "CONTAINS",
        spdxElementId: "SPDXRef-Package-Mish-Internal-TUN-Alpha",
      },
    ],
    spdxVersion: "SPDX-2.3",
  };
}

function createProvenance(
  manifest: PackageManifest,
  manifestSha256: string,
  identity: DispatchIdentity,
  dmgSha256: string,
  inputs: ReturnType<typeof sourceInputs>,
): Record<string, unknown> {
  const controller = packageFileByRole(manifest, "controller");
  const helper = packageFileByRole(manifest, "helper");
  const core = packageFileByRole(manifest, "core");
  const plist = packageFileByRole(manifest, "launch-daemon-template");
  return {
    _type: "https://in-toto.io/Statement/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://github.com/Asuka109/mish/internal-tun-alpha-dmg/v1",
        externalParameters: {
          architecture: manifest.architecture,
          packageProfile: manifest.profile,
          packageVersion: manifest.packageVersion,
          sourceSha: identity.sourceSha,
        },
        internalParameters: {
          allowTun: manifest.allowTun,
          controllerSha256: controller.sha256,
          coreSha256: core.sha256,
          coreVersion: manifest.coreVersion,
          developerIdRequired: manifest.developerIdRequired,
          helperSha256: helper.sha256,
          helperVersion: manifest.helperVersion,
          installationIdentityScheme: manifest.installationIdentityScheme,
          minimumMacosVersion: manifest.minimumMacosVersion,
          networkMutationEnabled: manifest.networkMutationEnabled,
          packageManifestSha256: manifestSha256,
          plistTemplateSha256: plist.sha256,
          protocolVersion: manifest.protocolVersion,
        },
        resolvedDependencies: [
          {
            digest: { gitCommit: identity.sourceSha },
            uri: `git+ssh://github.com/${identity.repository}.git`,
          },
          ...inputs,
        ],
      },
      runDetails: {
        builder: {
          id:
            `https://github.com/${identity.repository}/actions/workflows/` +
            `stage-macos-alpha-release.yml@${identity.workflowSha}`,
        },
        metadata: {
          invocationId:
            `https://github.com/${identity.repository}/actions/runs/` +
            `${identity.runId}/attempts/${identity.runAttempt}`,
        },
      },
    },
    predicateType: "https://slsa.dev/provenance/v1",
    subject: [{ digest: { sha256: dmgSha256 }, name: internalTunAlphaDmgName }],
  };
}

function stagePolicy(manifestName = "trusted-candidate-manifest.json") {
  const policy = structuredClone(readTrustedReleasePolicy());
  policy.artifact.manifestName = manifestName;
  return policy;
}

export function prepareInternalTunAlphaCandidate(options: PrepareOptions): CandidateManifest {
  assertIdentity(options.identity);
  invariant(
    path.resolve(options.sourceRoot) === options.sourceRoot &&
      path.resolve(options.packageRoot) === options.packageRoot &&
      path.resolve(options.outputDirectory) === options.outputDirectory,
    "Internal TUN Alpha staging paths must be absolute and canonical.",
  );
  invariant(
    !existsSync(options.outputDirectory),
    "Internal TUN Alpha candidate output already exists and cannot be replaced.",
  );
  const packageManifestPath = path.join(
    options.packageRoot,
    "Mish.app",
    internalTunAlphaManifestRelativePath,
  );
  const packageManifest = readJson<PackageManifest>(packageManifestPath);
  assertPackageManifest(packageManifest);
  const packageManifestBytes = readFileSync(packageManifestPath);
  const inputs = sourceInputs(options.sourceRoot);

  const parent = path.dirname(options.outputDirectory);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, ".internal-tun-alpha-candidate-"));
  try {
    const dmg = path.join(staging, internalTunAlphaDmgName);
    writeDmg(options.packageRoot, dmg);
    const dmgSha256 = fileSha256(dmg);
    const copiedManifest = path.join(staging, internalTunAlphaPackageManifestName);
    writeFileSync(copiedManifest, packageManifestBytes, { mode: 0o644 });
    const manifestSha256 = sha256(packageManifestBytes);
    const applicationExecutableSha256 = fileSha256(
      path.join(options.packageRoot, "Mish.app", applicationMainExecutableRelativePath),
    );
    writeFileSync(
      path.join(staging, internalTunAlphaSbomName),
      stableJson(
        createSbom(
          packageManifest,
          applicationExecutableSha256,
          manifestSha256,
          options.identity,
          dmgSha256,
        ),
      ),
      { mode: 0o644 },
    );
    writeFileSync(
      path.join(staging, internalTunAlphaProvenanceName),
      stableJson(
        createProvenance(packageManifest, manifestSha256, options.identity, dmgSha256, inputs),
      ),
      { mode: 0o644 },
    );
    const checksumFiles = [
      internalTunAlphaDmgName,
      internalTunAlphaPackageManifestName,
      internalTunAlphaProvenanceName,
      internalTunAlphaSbomName,
    ];
    writeFileSync(
      path.join(staging, internalTunAlphaChecksumsName),
      `${checksumFiles
        .map((name) => `${fileSha256(path.join(staging, name))}  ${name}`)
        .join("\n")}\n`,
      { mode: 0o644 },
    );
    const manifest = createCandidateManifest({
      artifactName: options.artifactName,
      directory: staging,
      identity: options.identity,
      kind: internalTunAlphaCandidateKind,
      policy: stagePolicy(),
      roles: candidateRoles,
    });
    renameSync(staging, options.outputDirectory);
    return manifest;
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  }
}

export function finalizeInternalTunAlphaStage(options: FinalizeOptions): CandidateManifest {
  assertIdentity(options.identity);
  invariant(
    numericId.test(options.candidateArtifactId) && numericId.test(options.verificationArtifactId),
    "Internal TUN Alpha finalization requires immutable candidate and verification IDs.",
  );
  invariant(
    safeArtifactName.test(options.verificationArtifactName),
    "Internal TUN Alpha verification artifact name is invalid.",
  );
  invariant(
    !existsSync(options.outputDirectory),
    "Internal TUN Alpha final stage already exists and cannot be replaced.",
  );
  const candidate = verifyCandidateManifest({
    directory: options.candidateDirectory,
    expectedArtifactId: options.candidateArtifactId,
    expectedArtifactName: options.candidateArtifactName,
    expectedIdentity: options.identity,
    policy: stagePolicy(),
    requiredRoles: Object.values(candidateRoles),
  });
  invariant(
    candidate.kind === internalTunAlphaCandidateKind,
    "Internal TUN Alpha candidate kind changed before staging.",
  );
  const verificationFile = path.join(
    options.verificationDirectory,
    internalTunAlphaVerificationName,
  );
  const verification = verifyInternalTunAlphaVerificationEvidence({
    candidateArtifactId: options.candidateArtifactId,
    candidateArtifactName: options.candidateArtifactName,
    candidateBundleSha256: candidate.bundleSha256,
    evidence: readJson(verificationFile),
    identity: options.identity,
    verificationArtifactId: options.verificationArtifactId,
  });
  invariant(verification.status === "verified", "Internal TUN Alpha verification is incomplete.");

  const parent = path.dirname(options.outputDirectory);
  mkdirSync(parent, { recursive: true });
  const staging = mkdtempSync(path.join(parent, ".internal-tun-alpha-stage-"));
  try {
    const stagedCandidate = path.join(staging, "candidate");
    const stagedVerification = path.join(staging, "verification");
    mkdirSync(stagedCandidate, { mode: 0o755 });
    mkdirSync(stagedVerification, { mode: 0o755 });
    for (const relative of [...Object.keys(candidateRoles), "trusted-candidate-manifest.json"]) {
      copyFileSync(
        path.join(options.candidateDirectory, relative),
        path.join(stagedCandidate, relative),
      );
    }
    copyFileSync(verificationFile, path.join(stagedVerification, internalTunAlphaVerificationName));
    writeFileSync(
      path.join(staging, internalTunAlphaStageInputsName),
      stableJson({
        candidateArtifact: {
          bundleSha256: candidate.bundleSha256,
          id: options.candidateArtifactId,
          name: options.candidateArtifactName,
        },
        identity: options.identity,
        schemaVersion: 1,
        verificationArtifact: {
          evidenceSha256: fileSha256(verificationFile),
          id: options.verificationArtifactId,
          name: options.verificationArtifactName,
        },
      }),
      { mode: 0o444 },
    );
    const manifest = createCandidateManifest({
      artifactName: options.finalArtifactName,
      directory: staging,
      identity: options.identity,
      kind: internalTunAlphaStageKind,
      policy: stagePolicy(internalTunAlphaFinalManifestName),
      roles: finalRoles,
    });
    verifyCandidateManifest({
      directory: staging,
      expectedArtifactId: "1",
      expectedArtifactName: options.finalArtifactName,
      expectedIdentity: options.identity,
      policy: stagePolicy(internalTunAlphaFinalManifestName),
      requiredRoles: Object.values(finalRoles),
    });
    renameSync(staging, options.outputDirectory);
    return manifest;
  } catch (error) {
    rmSync(staging, { force: true, recursive: true });
    throw error;
  }
}

function assertRequest(arguments_: string[]): void {
  const version = option(arguments_, "--version");
  const sourceSha = option(arguments_, "--source-sha");
  const mainSha = option(arguments_, "--main-sha");
  invariant(
    version === internalTunAlphaPackageVersion,
    `Internal TUN Alpha version must be exactly ${internalTunAlphaPackageVersion}.`,
  );
  invariant(
    fullSha.test(sourceSha) && sourceSha === mainSha,
    "Internal TUN Alpha staging requires the exact frozen main SHA.",
  );
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "assert-request") {
    assertRequest(arguments_);
    console.log(
      JSON.stringify({
        ok: true,
        packageVersion: internalTunAlphaPackageVersion,
        sourceSha: option(arguments_, "--source-sha"),
      }),
    );
    return;
  }
  if (command === "prepare") {
    const manifest = prepareInternalTunAlphaCandidate({
      artifactName: option(arguments_, "--artifact-name"),
      identity: identityFromArguments(arguments_),
      outputDirectory: path.resolve(option(arguments_, "--output-directory")),
      packageRoot: path.resolve(option(arguments_, "--package-root")),
      sourceRoot: path.resolve(option(arguments_, "--source-root")),
    });
    console.log(JSON.stringify({ bundleSha256: manifest.bundleSha256, ok: true }));
    return;
  }
  if (command === "finalize") {
    const manifest = finalizeInternalTunAlphaStage({
      candidateArtifactId: option(arguments_, "--candidate-artifact-id"),
      candidateArtifactName: option(arguments_, "--candidate-artifact-name"),
      candidateDirectory: path.resolve(option(arguments_, "--candidate-directory")),
      finalArtifactName: option(arguments_, "--final-artifact-name"),
      identity: identityFromArguments(arguments_),
      outputDirectory: path.resolve(option(arguments_, "--output-directory")),
      sourceRoot: path.resolve(option(arguments_, "--source-root")),
      verificationArtifactId: option(arguments_, "--verification-artifact-id"),
      verificationArtifactName: option(arguments_, "--verification-artifact-name"),
      verificationDirectory: path.resolve(option(arguments_, "--verification-directory")),
    });
    console.log(JSON.stringify({ bundleSha256: manifest.bundleSha256, ok: true }));
    return;
  }
  throw new Error(
    "Usage: internal-tun-alpha-staging.ts <assert-request|prepare|finalize> [options]",
  );
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Internal TUN Alpha staging failed.");
    process.exitCode = 1;
  }
}
