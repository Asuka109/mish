import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const canonicalEvidenceRoot = resolve(repositoryRoot, "mobile-core/evidence/android-v1.19.29");
const defaultSourceRoot = resolve(repositoryRoot, ".scratch/mobile-core/pass-1/android");
const defaultDestinationRoot = resolve(
  repositoryRoot,
  "apps/mobile/src-tauri/gen/android/app/src/main/jniLibs",
);
const defaultAdmissionManifest = resolve(
  repositoryRoot,
  "apps/mobile/src-tauri/gen/android/app/src/main/assets/mish-mobile-core-admission.json",
);

interface AndroidArtifact {
  abi: "arm64-v8a" | "x86_64";
  elfMachine: number;
  relativePath: string;
}

const artifacts: AndroidArtifact[] = [
  {
    abi: "arm64-v8a",
    elfMachine: 183,
    relativePath: "arm64-v8a/libmish_mobile_core.so",
  },
  {
    abi: "x86_64",
    elfMachine: 62,
    relativePath: "x86_64/libmish_mobile_core.so",
  },
];

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function selectedArtifacts(): AndroidArtifact[] {
  const requested: string[] = [];
  for (let index = 0; index < process.argv.length; index++) {
    if (process.argv[index] !== "--abi") continue;
    const value = process.argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--abi requires a value");
    requested.push(value);
  }
  if (requested.length === 0) return artifacts;
  const unique = new Set(requested);
  const selected = artifacts.filter(({ abi }) => unique.has(abi));
  if (selected.length !== unique.size) {
    throw new Error("--abi must be arm64-v8a or x86_64");
  }
  return selected;
}

function expectedChecksums(evidenceRoot: string): Map<string, string> {
  const lines = readFileSync(resolve(evidenceRoot, "SHA256SUMS"), "utf8").trim().split("\n");
  return new Map(
    lines.map((line) => {
      const match = line.match(/^([a-f0-9]{64})\s+android\/(.+)$/u);
      if (!match) throw new Error("Mobile Core checksum evidence is malformed");
      return [match[2], match[1]];
    }),
  );
}

function writeAdmissionManifest(evidenceRoot: string, destination: string): void {
  const sourceManifest = JSON.parse(
    readFileSync(resolve(repositoryRoot, "mobile-core/source-manifest.json"), "utf8"),
  ) as {
    schemaVersion: number;
    abiVersion: number;
    wrapperRevision: string;
    mihomo: { commit: string; version: string };
    android: {
      signing: {
        admissionSchemaVersion: number;
        policy: string;
        scheme: string;
        verification: string;
        signerSha256: string;
      };
      artifacts: Array<{ abi: string }>;
    };
  };
  if (
    sourceManifest.schemaVersion !== 1 ||
    sourceManifest.abiVersion !== 1 ||
    sourceManifest.wrapperRevision !== "mish-mobile-core-v1"
  ) {
    throw new Error("Mobile Core source manifest is not the pinned admission schema");
  }
  const sourceAbis = sourceManifest.android.artifacts.map(({ abi }) => abi);
  if (
    sourceManifest.android.signing.admissionSchemaVersion !== 2 ||
    sourceManifest.android.signing.policy !== "synthetic-debug-v1" ||
    sourceManifest.android.signing.scheme !== "android-package-signature-v1" ||
    sourceManifest.android.signing.verification !== "package-signer" ||
    !/^[a-f0-9]{64}$/u.test(sourceManifest.android.signing.signerSha256)
  ) {
    throw new Error("Mobile Core source manifest signer pin is not a bounded synthetic policy");
  }
  if (
    sourceAbis.length !== artifacts.length ||
    new Set(sourceAbis).size !== sourceAbis.length ||
    artifacts.some(({ abi }) => !sourceAbis.includes(abi))
  ) {
    throw new Error(
      "Mobile Core source manifest ABI set differs from the Android staging contract",
    );
  }
  const checksums = expectedChecksums(evidenceRoot);
  const manifestArtifacts = sourceManifest.android.artifacts.map((artifact) => {
    const relativePath = `${artifact.abi}/libmish_mobile_core.so`;
    const sha256 = checksums.get(relativePath);
    if (!sha256) throw new Error(`Missing ${artifact.abi} Mobile Core checksum evidence`);
    return { abi: artifact.abi, sha256 };
  });
  const manifest = {
    schemaVersion: sourceManifest.android.signing.admissionSchemaVersion,
    abiVersion: sourceManifest.abiVersion,
    sourceCommit: sourceManifest.mihomo.commit,
    sourceVersion: sourceManifest.mihomo.version,
    wrapperRevision: sourceManifest.wrapperRevision,
    wrapperContractVersion: 1,
    artifacts: manifestArtifacts,
    signatureScheme: sourceManifest.android.signing.scheme,
    signatureVerification: sourceManifest.android.signing.verification,
    signerSha256: sourceManifest.android.signing.signerSha256,
  };
  mkdirSync(dirname(destination), { recursive: true });
  writeFileSync(destination, `${JSON.stringify(manifest)}\n`);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function verifyElf(path: string, artifact: AndroidArtifact): void {
  const bytes = readFileSync(path);
  if (bytes.length < 64 || bytes.subarray(0, 4).toString("hex") !== "7f454c46") {
    throw new Error(`${artifact.abi} Mobile Core is not an ELF binary`);
  }
  if (bytes[4] !== 2 || bytes[5] !== 1 || bytes.readUInt16LE(18) !== artifact.elfMachine) {
    throw new Error(`${artifact.abi} Mobile Core has the wrong ELF architecture`);
  }
}

function main(): void {
  const sourceRoot = resolve(argument("--source-dir") ?? defaultSourceRoot);
  const destinationRoot = resolve(argument("--destination-dir") ?? defaultDestinationRoot);
  const evidenceRoot = resolve(argument("--evidence-dir") ?? canonicalEvidenceRoot);
  const admissionManifest = resolve(argument("--admission-manifest") ?? defaultAdmissionManifest);
  execFileSync(
    process.execPath,
    [
      resolve(repositoryRoot, "scripts/verify-mobile-core.ts"),
      "--evidence-dir",
      evidenceRoot,
      "--artifact-dir",
      sourceRoot,
      "--require-release-eligible",
    ],
    { stdio: "inherit" },
  );
  const checksums = expectedChecksums(evidenceRoot);

  for (const artifact of selectedArtifacts()) {
    const source = resolve(sourceRoot, artifact.relativePath);
    const destination = resolve(destinationRoot, artifact.relativePath);
    if (!existsSync(source)) {
      throw new Error(`Missing ${artifact.abi} Mobile Core. Run pnpm mobile-core:build first.`);
    }
    verifyElf(source, artifact);
    const actual = sha256(source);
    const expected = checksums.get(artifact.relativePath);
    if (!expected || actual !== expected) {
      throw new Error(`${artifact.abi} Mobile Core does not match selected build evidence`);
    }
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(source, destination);
    console.log(`Staged verified ${artifact.abi} Mobile Core at ${destination}`);
  }
  writeAdmissionManifest(evidenceRoot, admissionManifest);
}

main();
