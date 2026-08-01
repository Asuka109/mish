import { createHash, createPublicKey, verify } from "node:crypto";
import {
  copyFileSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

export const updaterTarget = "darwin-aarch64" as const;
export const updaterSchemaVersion = 1 as const;
export const updaterFixtureVersion = "0.1.1-alpha.2";
export const updaterFixtureSourceSha = "1".repeat(40);
export const updaterStableFixtureVersion = "0.1.1";
export const updaterStableFixtureSourceSha = "2".repeat(40);

export type UpdaterChannel = "alpha" | "stable";

export type UpdaterArtifactSet = {
  artifactName: string;
  artifactSha256: string;
  artifactSignatureName: string;
  channel: UpdaterChannel;
  metadataName: string;
  metadataSha256: string;
  metadataSignatureName: string;
  sourceSha: string;
  version: string;
};

export interface UpdaterPublicationFixture {
  alphaListVisible: boolean;
  channel: UpdaterChannel;
  draft: boolean;
  immutable: boolean;
  published: boolean;
  stableLatestVisible: boolean;
  timeline: string[];
  verifiedAssets: string[];
  version: string;
}

export interface UpdaterReleaseFixture {
  assetDigests: Record<string, string>;
  channel: UpdaterChannel;
  draft: boolean;
  immutable: boolean;
  latest: boolean;
  prerelease: boolean;
  published: boolean;
  version: string;
}

export interface UpdaterHighWaterFixture {
  digest: string;
  version: string;
}

export type UpdaterDiscoveryFixture =
  | { disposition: "available"; digest: string; version: string }
  | { disposition: "unchanged"; digest: string; version: string };

type UpdaterMetadata = {
  version: string;
  platforms: {
    [updaterTarget]: {
      url: string;
      signature: string;
    };
  };
  mish: {
    schema_version: typeof updaterSchemaVersion;
    channel: UpdaterChannel;
    source_sha: string;
    artifact_name: string;
    artifact_sha256: string;
    artifact_size: number;
  };
};

const strictStable = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u;
const strictAlpha = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)-alpha\.(?:0|[1-9]\d*)$/u;
const fullSourceSha = /^[0-9a-f]{40}$/u;
const tauriSignature = /^[A-Za-z0-9+/]+={0,2}$/u;
const minisignPublicKeyPrefix = Buffer.from("302a300506032b6570032100", "hex");

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function compareUpdaterVersions(left: string, right: string, channel: UpdaterChannel): number {
  validateUpdaterVersion(left, channel);
  validateUpdaterVersion(right, channel);
  const components = (version: string) =>
    version
      .replace("-alpha.", ".")
      .split(".")
      .map((value) => BigInt(value));
  const leftComponents = components(left);
  const rightComponents = components(right);
  for (let index = 0; index < leftComponents.length; index += 1) {
    if (leftComponents[index] < rightComponents[index]) return -1;
    if (leftComponents[index] > rightComponents[index]) return 1;
  }
  return 0;
}

function releaseFixtureDigest(release: UpdaterReleaseFixture): string {
  const entries = Object.entries(release.assetDigests).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  return sha256(Buffer.from(JSON.stringify(entries)));
}

function validateReleaseFixtureAssets(release: UpdaterReleaseFixture): void {
  const expected = updaterArtifactNames(release.version, release.channel).sort();
  const actual = Object.keys(release.assetDigests).sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify(expected) &&
      Object.values(release.assetDigests).every((digest) => /^[0-9a-f]{64}$/u.test(digest)),
    "Updater Release fixture is partial, duplicated, or malformed.",
  );
}

export function simulateUpdaterPublication(options: {
  assetDigests: Record<string, string>;
  channel: UpdaterChannel;
  interruptAfterVerifiedAssets?: number;
  version: string;
}): UpdaterPublicationFixture {
  const release: UpdaterReleaseFixture = {
    assetDigests: options.assetDigests,
    channel: options.channel,
    draft: true,
    immutable: false,
    latest: false,
    prerelease: options.channel === "alpha",
    published: false,
    version: options.version,
  };
  validateUpdaterVersion(release.version, release.channel);
  validateReleaseFixtureAssets(release);
  const timeline = ["draft-created"];
  const verifiedAssets: string[] = [];
  const names = updaterArtifactNames(release.version, release.channel);
  for (const name of names) {
    timeline.push(`uploaded:${name}`);
    invariant(
      /^[0-9a-f]{64}$/u.test(release.assetDigests[name] ?? ""),
      "Updater Draft asset read-back digest is invalid.",
    );
    timeline.push(`read-back-verified:${name}`);
    verifiedAssets.push(name);
    if (verifiedAssets.length === options.interruptAfterVerifiedAssets) {
      timeline.push("interrupted-draft-hidden");
      return {
        alphaListVisible: false,
        channel: release.channel,
        draft: true,
        immutable: false,
        published: false,
        stableLatestVisible: false,
        timeline,
        verifiedAssets,
        version: release.version,
      };
    }
  }
  timeline.push("published-immutable");
  return {
    alphaListVisible: release.channel === "alpha",
    channel: release.channel,
    draft: false,
    immutable: true,
    published: true,
    stableLatestVisible: release.channel === "stable",
    timeline,
    verifiedAssets,
    version: release.version,
  };
}

export function discoverUpdaterReleaseFixture(
  releases: UpdaterReleaseFixture[],
  channel: UpdaterChannel,
  highWater?: UpdaterHighWaterFixture,
): UpdaterDiscoveryFixture {
  const visible = releases.filter(
    (release) =>
      release.channel === channel &&
      !release.draft &&
      release.immutable &&
      release.published &&
      release.prerelease === (channel === "alpha") &&
      (channel === "alpha" || release.latest),
  );
  invariant(visible.length > 0, "No canonical published updater Release is visible.");
  for (const release of visible) validateReleaseFixtureAssets(release);
  const selected = visible.reduce((current, release) =>
    compareUpdaterVersions(release.version, current.version, channel) > 0 ? release : current,
  );
  invariant(
    visible.filter((release) => release.version === selected.version).length === 1,
    "Updater Release version is duplicated.",
  );
  const digest = releaseFixtureDigest(selected);
  if (!highWater) return { disposition: "available", digest, version: selected.version };
  const ordering = compareUpdaterVersions(selected.version, highWater.version, channel);
  invariant(ordering >= 0, "Updater Release listing is stale below the high-water mark.");
  if (ordering > 0) return { disposition: "available", digest, version: selected.version };
  invariant(digest === highWater.digest, "Updater Release version has a conflicting digest.");
  return { disposition: "unchanged", digest, version: selected.version };
}

function decodeTauriText(value: string, description: string): string {
  invariant(tauriSignature.test(value), `${description} is missing or malformed.`);
  const decoded = Buffer.from(value, "base64");
  invariant(decoded.toString("base64") === value, `${description} is not canonical Base64.`);
  return decoded.toString("utf8");
}

function parseMinisignPublicKey(encodedPublicKey: string): {
  keyId: Buffer;
  publicKey: ReturnType<typeof createPublicKey>;
} {
  const lines = decodeTauriText(encodedPublicKey, "Updater public key").trimEnd().split("\n");
  invariant(lines.length === 2, "Updater public key has an invalid Minisign envelope.");
  const key = Buffer.from(lines[1], "base64");
  invariant(
    key.length === 42 &&
      key.subarray(0, 2).equals(Buffer.from("Ed")) &&
      key.subarray(2, 10).length === 8,
    "Updater public key has an unsupported Minisign format.",
  );
  return {
    keyId: key.subarray(2, 10),
    publicKey: createPublicKey({
      format: "der",
      key: Buffer.concat([minisignPublicKeyPrefix, key.subarray(10)]),
      type: "spki",
    }),
  };
}

function verifyMinisign(content: Buffer, encodedSignature: string, encodedPublicKey: string): void {
  const { keyId, publicKey } = parseMinisignPublicKey(encodedPublicKey);
  const lines = decodeTauriText(encodedSignature, "Updater signature").trimEnd().split("\n");
  invariant(
    lines.length === 4 && lines[2].startsWith("trusted comment: "),
    "Updater signature has an invalid Minisign envelope.",
  );
  const signature = Buffer.from(lines[1], "base64");
  const globalSignature = Buffer.from(lines[3], "base64");
  invariant(
    signature.length === 74 &&
      signature.subarray(0, 2).equals(Buffer.from("ED")) &&
      signature.subarray(2, 10).equals(keyId) &&
      globalSignature.length === 64,
    "Updater signature has an unsupported Minisign format.",
  );
  const messageSignature = signature.subarray(10);
  const digest = createHash("blake2b512").update(content).digest();
  invariant(
    verify(null, digest, publicKey, messageSignature),
    "Updater signature does not verify the expected content.",
  );
  const trustedComment = Buffer.from(lines[2].slice("trusted comment: ".length));
  invariant(
    verify(null, Buffer.concat([messageSignature, trustedComment]), publicKey, globalSignature),
    "Updater signature trusted comment is invalid.",
  );
}

export function updaterArtifactName(version: string): string {
  return `Mish-${version}-aarch64.app.tar.gz`;
}

export function updaterMetadataName(channel: UpdaterChannel): string {
  return `mish-${channel}.json`;
}

export function updaterArtifactNames(version: string, channel: UpdaterChannel): string[] {
  const artifactName = updaterArtifactName(version);
  const metadataName = updaterMetadataName(channel);
  return [artifactName, `${artifactName}.sig`, metadataName, `${metadataName}.sig`];
}

export function validateUpdaterVersion(version: string, channel: UpdaterChannel): void {
  invariant(
    (channel === "stable" ? strictStable : strictAlpha).test(version),
    `Updater ${channel} version is not strict SemVer.`,
  );
}

export function prepareUpdaterArtifacts(options: {
  artifact: string;
  artifactSignature: string;
  channel: UpdaterChannel;
  metadataSignature: string;
  outputDirectory: string;
  publicKey: string;
  sourceSha: string;
  version: string;
}): UpdaterArtifactSet {
  validateUpdaterVersion(options.version, options.channel);
  invariant(fullSourceSha.test(options.sourceSha), "Updater source must be one full commit SHA.");

  const artifact = readFileSync(options.artifact);
  const artifactName = updaterArtifactName(options.version);
  invariant(
    path.basename(options.artifact) === artifactName,
    "Updater payload name does not match its version and architecture.",
  );
  const artifactSignature = readFileSync(options.artifactSignature, "utf8").trim();
  const metadataSignature = readFileSync(options.metadataSignature, "utf8").trim();
  invariant(
    tauriSignature.test(artifactSignature) && tauriSignature.test(metadataSignature),
    "Updater fixture signature is missing or malformed.",
  );

  const metadataName = updaterMetadataName(options.channel);
  const metadata: UpdaterMetadata = {
    version: options.version,
    platforms: {
      [updaterTarget]: {
        url: `https://github.com/Asuka109/mish/releases/download/v${options.version}/${artifactName}`,
        signature: artifactSignature,
      },
    },
    mish: {
      schema_version: updaterSchemaVersion,
      channel: options.channel,
      source_sha: options.sourceSha,
      artifact_name: artifactName,
      artifact_sha256: sha256(artifact),
      artifact_size: artifact.length,
    },
  };
  const metadataContent = Buffer.from(`${JSON.stringify(metadata, null, 2)}\n`);

  mkdirSync(options.outputDirectory, { recursive: true });
  invariant(
    readdirSync(options.outputDirectory).length === 0,
    "Updater output directory must be empty.",
  );
  copyFileSync(options.artifact, path.join(options.outputDirectory, artifactName));
  writeFileSync(path.join(options.outputDirectory, `${artifactName}.sig`), artifactSignature);
  writeFileSync(path.join(options.outputDirectory, metadataName), metadataContent);
  writeFileSync(path.join(options.outputDirectory, `${metadataName}.sig`), metadataSignature);

  const result = {
    artifactName,
    artifactSha256: sha256(artifact),
    artifactSignatureName: `${artifactName}.sig`,
    channel: options.channel,
    metadataName,
    metadataSha256: sha256(metadataContent),
    metadataSignatureName: `${metadataName}.sig`,
    sourceSha: options.sourceSha,
    version: options.version,
  };
  verifyUpdaterArtifacts(options.outputDirectory, result, options.publicKey);
  return result;
}

export function verifyUpdaterArtifacts(
  directory: string,
  expected: UpdaterArtifactSet,
  publicKey: string,
): UpdaterArtifactSet {
  const expectedNames = updaterArtifactNames(expected.version, expected.channel).sort();
  const actualNames = readdirSync(directory).sort();
  invariant(
    JSON.stringify(actualNames) === JSON.stringify(expectedNames),
    "Updater artifact set is incomplete or contains unexpected files.",
  );
  const artifact = readFileSync(path.join(directory, expected.artifactName));
  const metadataContent = readFileSync(path.join(directory, expected.metadataName));
  const metadata = JSON.parse(metadataContent.toString("utf8")) as UpdaterMetadata;
  const artifactSignature = readFileSync(
    path.join(directory, expected.artifactSignatureName),
    "utf8",
  );
  const metadataSignature = readFileSync(
    path.join(directory, expected.metadataSignatureName),
    "utf8",
  );

  invariant(
    metadata.version === expected.version &&
      metadata.mish.schema_version === updaterSchemaVersion &&
      metadata.mish.channel === expected.channel &&
      metadata.mish.source_sha === expected.sourceSha &&
      metadata.mish.artifact_name === expected.artifactName &&
      metadata.mish.artifact_sha256 === expected.artifactSha256 &&
      metadata.mish.artifact_size === artifact.length,
    "Updater metadata identity or provenance drifted.",
  );
  invariant(
    metadata.platforms[updaterTarget]?.signature === artifactSignature &&
      metadata.platforms[updaterTarget].url ===
        `https://github.com/Asuka109/mish/releases/download/v${expected.version}/${expected.artifactName}`,
    "Tauri static metadata does not bind the exact updater payload.",
  );
  invariant(
    sha256(artifact) === expected.artifactSha256 &&
      sha256(metadataContent) === expected.metadataSha256,
    "Updater artifact digest drifted.",
  );
  invariant(
    tauriSignature.test(artifactSignature) && tauriSignature.test(metadataSignature),
    "Updater detached signature is missing or malformed.",
  );
  verifyMinisign(artifact, artifactSignature, publicKey);
  verifyMinisign(metadataContent, metadataSignature, publicKey);
  return expected;
}

export function runUpdaterContractFixture(): Record<string, string> {
  const fixtures = path.resolve(import.meta.dirname, "fixtures/macos-updater");
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-updater-contract-"));
  const publicKey = readFileSync(path.join(fixtures, "updater-fixture.key.pub"), "utf8").trim();
  const alphaDirectory = path.join(temporary.path, "alpha");
  const stableDirectory = path.join(temporary.path, "stable");
  mkdirSync(alphaDirectory);
  mkdirSync(stableDirectory);
  const alpha = prepareUpdaterArtifacts({
    artifact: path.join(fixtures, updaterArtifactName(updaterFixtureVersion)),
    artifactSignature: path.join(fixtures, `${updaterArtifactName(updaterFixtureVersion)}.sig`),
    channel: "alpha",
    metadataSignature: path.join(fixtures, "mish-alpha.json.sig"),
    outputDirectory: alphaDirectory,
    publicKey,
    sourceSha: updaterFixtureSourceSha,
    version: updaterFixtureVersion,
  });
  const stable = prepareUpdaterArtifacts({
    artifact: path.join(fixtures, updaterArtifactName(updaterStableFixtureVersion)),
    artifactSignature: path.join(
      fixtures,
      `${updaterArtifactName(updaterStableFixtureVersion)}.sig`,
    ),
    channel: "stable",
    metadataSignature: path.join(fixtures, "mish-stable.json.sig"),
    outputDirectory: stableDirectory,
    publicKey,
    sourceSha: updaterStableFixtureSourceSha,
    version: updaterStableFixtureVersion,
  });
  invariant(
    [
      [alphaDirectory, alpha.metadataName],
      [stableDirectory, stable.metadataName],
    ].every(([directory, name]) =>
      readFileSync(path.join(directory, name)).equals(readFileSync(path.join(fixtures, name))),
    ),
    "Generated updater metadata differs from its signed deterministic fixture.",
  );

  const release = (directory: string, artifactSet: UpdaterArtifactSet): UpdaterReleaseFixture => ({
    assetDigests: Object.fromEntries(
      updaterArtifactNames(artifactSet.version, artifactSet.channel).map((name) => [
        name,
        sha256(readFileSync(path.join(directory, name))),
      ]),
    ),
    channel: artifactSet.channel,
    draft: false,
    immutable: true,
    latest: artifactSet.channel === "stable",
    prerelease: artifactSet.channel === "alpha",
    published: true,
    version: artifactSet.version,
  });
  const alphaRelease = release(alphaDirectory, alpha);
  const stableRelease = release(stableDirectory, stable);
  const alphaPublication = simulateUpdaterPublication({
    assetDigests: alphaRelease.assetDigests,
    channel: "alpha",
    version: alpha.version,
  });
  const stablePublication = simulateUpdaterPublication({
    assetDigests: stableRelease.assetDigests,
    channel: "stable",
    version: stable.version,
  });
  const interrupted = simulateUpdaterPublication({
    assetDigests: alphaRelease.assetDigests,
    channel: "alpha",
    interruptAfterVerifiedAssets: 2,
    version: alpha.version,
  });
  const discovered = discoverUpdaterReleaseFixture([alphaRelease], "alpha");
  const rediscovered = discoverUpdaterReleaseFixture([alphaRelease], "alpha", {
    digest: discovered.digest,
    version: discovered.version,
  });
  invariant(
    alphaPublication.alphaListVisible &&
      stablePublication.stableLatestVisible &&
      !interrupted.alphaListVisible &&
      interrupted.draft &&
      rediscovered.disposition === "unchanged",
    "Updater publication/discovery lifecycle fixture did not reach its fail-closed boundaries.",
  );
  return {
    artifacts: updaterArtifactNames(alpha.version, alpha.channel).join(","),
    alphaArtifacts: updaterArtifactNames(alpha.version, alpha.channel).join(","),
    alphaVisibility: "published-list-only",
    channel: "alpha,stable",
    interruption: "draft-hidden",
    network: "not-used",
    privateKey: "not-present",
    rediscovery: rediscovered.disposition,
    stableArtifacts: updaterArtifactNames(stable.version, stable.channel).join(","),
    stableVisibility: "published-latest-only",
    publicationStage: "contract-only-release-fixture",
    stage: "contract-only",
    version: `${alpha.version},${stable.version}`,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  invariant(
    process.argv.length === 3 && process.argv[2] === "fixture",
    "Usage: macos-updater-contract.ts fixture",
  );
  console.log(JSON.stringify(runUpdaterContractFixture(), null, 2));
}
