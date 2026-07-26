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
  const outputDirectory = path.join(temporary.path, "output");
  mkdirSync(outputDirectory);
  const result = prepareUpdaterArtifacts({
    artifact: path.join(fixtures, updaterArtifactName(updaterFixtureVersion)),
    artifactSignature: path.join(fixtures, `${updaterArtifactName(updaterFixtureVersion)}.sig`),
    channel: "alpha",
    metadataSignature: path.join(fixtures, "mish-alpha.json.sig"),
    outputDirectory,
    publicKey: readFileSync(path.join(fixtures, "updater-fixture.key.pub"), "utf8").trim(),
    sourceSha: updaterFixtureSourceSha,
    version: updaterFixtureVersion,
  });
  invariant(
    readFileSync(path.join(outputDirectory, result.metadataName)).equals(
      readFileSync(path.join(fixtures, result.metadataName)),
    ),
    "Generated updater metadata differs from the signed deterministic fixture.",
  );
  return {
    artifacts: updaterArtifactNames(result.version, result.channel).join(","),
    channel: result.channel,
    network: "not-used",
    privateKey: "not-present",
    stage: "contract-only",
    version: result.version,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  invariant(
    process.argv.length === 3 && process.argv[2] === "fixture",
    "Usage: macos-updater-contract.ts fixture",
  );
  console.log(JSON.stringify(runUpdaterContractFixture(), null, 2));
}
