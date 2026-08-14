import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  verifyGoToolchainProvenance,
  type GoToolchainProvenance,
} from "./mobile-core-toolchain-provenance.ts";

interface GoArchive {
  filename: string;
  sha256: string;
  executableSha256: string;
}

interface ArtifactTarget {
  abi: string;
  goArch: string;
  goAmd64?: string;
  targetTriple: string;
  path: string;
}

interface SourceManifest {
  abiVersion: number;
  wrapperRevision: string;
  mihomo: {
    repository: string;
    version: string;
    commit: string;
    tree: string;
    commitDate: string;
    sourceDateEpoch: number;
    license: string;
    correspondingSource: string;
  };
  go: { version: string; archives: Record<string, GoArchive> };
  android: {
    ndkVersion: string;
    minimumApi: number;
    buildTags: string[];
    artifacts: ArtifactTarget[];
  };
}

interface ArtifactEvidence extends ArtifactTarget {
  exportedSymbols: string[];
  machine: string;
  sha256: string;
  size: number;
}

interface Provenance {
  schemaVersion: number;
  abiVersion: number;
  source: SourceManifest["mihomo"];
  wrapper: { revision: string; sha256: string };
  toolchains: {
    go: GoToolchainProvenance;
    androidNdk: { revision: string; pathRecorded: boolean };
  };
  build: {
    minimumApi: number;
    tags: string[];
    flags: string[];
    sourceDateEpoch: number;
    cCompiler: string;
    moduleMode: string;
  };
  artifacts: ArtifactEvidence[];
}

interface SPDXFile {
  fileName: string;
  checksums: Array<{ algorithm: string; checksumValue: string }>;
}

interface SPDXPackage {
  name: string;
  versionInfo: string;
}

interface SPDXDocument {
  files?: SPDXFile[];
  packages?: SPDXPackage[];
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const canonicalEvidenceDirectory = path.join(
  repositoryRoot,
  "mobile-core/evidence/android-v1.19.29",
);
const manifest = JSON.parse(
  readFileSync(path.join(repositoryRoot, "mobile-core/source-manifest.json"), "utf8"),
) as SourceManifest;
const expectedBuildFlags = [
  "-buildmode=c-shared",
  "-buildvcs=false",
  "-trimpath",
  "-gcflags=github.com/metacubex/mihomo/mish-mobile-core-wrapper=-lang=go1.26",
  "-ldflags=-buildid= -s -w",
];
const expectedMachines: Record<string, string> = {
  "arm64-v8a": "AArch64",
  x86_64: "Advanced Micro Devices X86-64",
};

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
  return value;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertObject(value: unknown, label: string): asserts value is Record<string, unknown> {
  assert(isRecord(value), `${label} must be an object`);
}

function assertKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  assert(
    Object.keys(value).every((key) => allowed.has(key)),
    `${label} contains an unknown field`,
  );
  assert(
    required.every((key) => key in value),
    `${label} is missing a required field`,
  );
}

function parseProvenance(value: unknown): Provenance {
  assertObject(value, "Mobile Core provenance");
  assertKeys(
    value,
    [
      "schemaVersion",
      "abiVersion",
      "source",
      "wrapper",
      "toolchains",
      "build",
      "correspondingSource",
      "license",
      "artifacts",
    ],
    "Mobile Core provenance",
  );
  assertObject(value.source, "Mihomo source provenance");
  assertKeys(
    value.source,
    [
      "repository",
      "version",
      "commit",
      "tree",
      "commitDate",
      "sourceDateEpoch",
      "license",
      "correspondingSource",
    ],
    "Mihomo source provenance",
  );
  assertObject(value.wrapper, "Mobile Core wrapper provenance");
  assertKeys(value.wrapper, ["revision", "sha256"], "Mobile Core wrapper provenance");
  assertObject(value.toolchains, "Mobile Core toolchain provenance");
  assertKeys(value.toolchains, ["go", "androidNdk"], "Mobile Core toolchain provenance");
  assertObject(value.toolchains.androidNdk, "Android NDK provenance");
  assertKeys(value.toolchains.androidNdk, ["revision", "pathRecorded"], "Android NDK provenance");
  assertObject(value.build, "Mobile Core build provenance");
  assertKeys(
    value.build,
    ["minimumApi", "tags", "flags", "sourceDateEpoch", "cCompiler", "moduleMode"],
    "Mobile Core build provenance",
  );
  assert(Array.isArray(value.artifacts), "Mobile Core artifacts provenance must be an array");
  for (const artifact of value.artifacts) {
    assertObject(artifact, "Mobile Core artifact provenance");
    assertKeys(
      artifact,
      ["abi", "goArch", "targetTriple", "path", "exportedSymbols", "machine", "sha256", "size"],
      "Mobile Core artifact provenance",
      ["goAmd64"],
    );
    assert(
      Array.isArray(artifact.exportedSymbols) &&
        artifact.exportedSymbols.every((symbol) => typeof symbol === "string"),
      "Mobile Core artifact symbols must be a string array",
    );
  }
  return value as unknown as Provenance;
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function listFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files.sort();
}

function wrapperDigest(): string {
  const roots = [
    path.join(repositoryRoot, "mobile-core/abi"),
    path.join(repositoryRoot, "mobile-core/wrapper"),
  ];
  const hash = createHash("sha256");
  for (const file of roots.flatMap(listFiles).filter((file) => !file.endsWith("_test.go"))) {
    const relative = path.relative(repositoryRoot, file).split(path.sep).join("/");
    hash.update(relative);
    hash.update("\0");
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function currentHostKey(): string {
  const platform =
    process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : "";
  const architecture = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "amd64" : "";
  assert(platform && architecture, `unsupported Go host ${process.platform}-${process.arch}`);
  return `${platform}-${architecture}`;
}

function resolveNdk(): string {
  const candidates = [
    process.env.ANDROID_NDK_HOME,
    process.env.ANDROID_NDK_ROOT,
    process.env.ANDROID_HOME &&
      path.join(process.env.ANDROID_HOME, "ndk", manifest.android.ndkVersion),
    process.env.ANDROID_SDK_ROOT &&
      path.join(process.env.ANDROID_SDK_ROOT, "ndk", manifest.android.ndkVersion),
    path.join(os.homedir(), "Library/Android/sdk/ndk", manifest.android.ndkVersion),
    path.join(os.homedir(), "Android/Sdk/ndk", manifest.android.ndkVersion),
  ].filter((candidate): candidate is string => Boolean(candidate));
  const ndk = candidates.find((candidate) => existsSync(path.join(candidate, "source.properties")));
  assert(ndk, `Android NDK ${manifest.android.ndkVersion} is required to inspect build output`);
  const properties = readFileSync(path.join(ndk, "source.properties"), "utf8");
  const revision = properties.match(/^Pkg\.Revision\s*=\s*(.+)$/mu)?.[1]?.trim();
  assert(revision === manifest.android.ndkVersion, `expected NDK ${manifest.android.ndkVersion}`);
  return ndk;
}

function ndkToolchain(ndk: string): string {
  const prebuilt = path.join(ndk, "toolchains/llvm/prebuilt");
  const hosts = readdirSync(prebuilt).filter((entry) => !entry.startsWith("."));
  assert(hosts.length === 1, `expected one NDK host toolchain, received ${hosts.join(", ")}`);
  return path.join(prebuilt, hosts[0]);
}

function parseChecksums(source: string): Map<string, string> {
  const lines = source.trim().split("\n");
  const entries = lines.map((line) => {
    const match = line.match(
      /^([a-f0-9]{64})  (android\/(?:arm64-v8a|x86_64)\/libmish_mobile_core\.so)$/u,
    );
    assert(match, "Mobile Core checksum evidence is malformed");
    return [match[2], match[1]] as const;
  });
  const checksums = new Map(entries);
  assert(lines.length === manifest.android.artifacts.length, "unexpected checksum evidence count");
  assert(checksums.size === manifest.android.artifacts.length, "unexpected checksum evidence set");
  return checksums;
}

function resolveArtifactPath(artifactDirectory: string, relativePath: string): string {
  const direct = path.join(artifactDirectory, relativePath);
  if (existsSync(direct)) return direct;
  return path.join(artifactDirectory, relativePath.replace(/^android\//u, ""));
}

function inspectArtifact(
  artifactPath: string,
  artifact: ArtifactEvidence,
  expectedSymbols: string[],
  toolchain: string,
): void {
  const readelf = path.join(toolchain, "bin/llvm-readelf");
  const nm = path.join(toolchain, "bin/llvm-nm");
  const header = execFileSync(readelf, ["-h", artifactPath], { encoding: "utf8" });
  const machine = header.match(/^\s*Machine:\s*(.+)$/mu)?.[1]?.trim();
  assert(machine === expectedMachines[artifact.abi], `${artifact.abi} ELF machine mismatch`);
  const exported = execFileSync(nm, ["-D", "--defined-only", artifactPath], { encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim().split(/\s+/u).at(-1) ?? "")
    .filter((symbol) => expectedSymbols.includes(symbol))
    .sort();
  assert(
    exported.join("\n") === expectedSymbols.join("\n"),
    `${artifact.abi} binary symbols differ from the v1 contract`,
  );
}

function verifyEvidence(
  evidenceDirectory: string,
  artifactDirectory?: string,
  requireReleaseEligible = false,
): void {
  const provenance = parseProvenance(
    JSON.parse(readFileSync(path.join(evidenceDirectory, "build-provenance.json"), "utf8")),
  );
  const checksums = parseChecksums(
    readFileSync(path.join(evidenceDirectory, "SHA256SUMS"), "utf8"),
  );
  const expectedSymbols = readFileSync(
    path.join(canonicalEvidenceDirectory, "abi-symbols.txt"),
    "utf8",
  )
    .trim()
    .split("\n")
    .sort();
  const evidenceSymbols = readFileSync(path.join(evidenceDirectory, "abi-symbols.txt"), "utf8")
    .trim()
    .split("\n")
    .sort();
  const sbom = JSON.parse(
    readFileSync(path.join(evidenceDirectory, "sbom.spdx.json"), "utf8"),
  ) as SPDXDocument;
  const isCanonical = path.resolve(evidenceDirectory) === path.resolve(canonicalEvidenceDirectory);

  assert(isCanonical || artifactDirectory, "runtime evidence verification requires --artifact-dir");
  assert(provenance.schemaVersion === 2, "unsupported provenance schema");
  assert(provenance.abiVersion === manifest.abiVersion, "ABI provenance mismatch");
  assert(
    JSON.stringify(provenance.source) === JSON.stringify(manifest.mihomo),
    "Mihomo source provenance mismatch",
  );
  assert(provenance.wrapper.revision === manifest.wrapperRevision, "wrapper revision mismatch");
  assert(provenance.wrapper.sha256 === wrapperDigest(), "wrapper source digest mismatch");

  verifyGoToolchainProvenance(provenance.toolchains.go, manifest.go, {
    expectedHost: isCanonical ? undefined : currentHostKey(),
    requireReleaseEligible: isCanonical || requireReleaseEligible,
  });
  assert(
    provenance.toolchains.androidNdk.revision === manifest.android.ndkVersion &&
      provenance.toolchains.androidNdk.pathRecorded === false,
    "NDK provenance mismatch",
  );
  assert(provenance.build.minimumApi === manifest.android.minimumApi, "minimum API mismatch");
  assert(
    JSON.stringify(provenance.build.tags) === JSON.stringify(manifest.android.buildTags),
    "build tags mismatch",
  );
  assert(
    JSON.stringify(provenance.build.flags) === JSON.stringify(expectedBuildFlags),
    "build flags mismatch",
  );
  assert(
    provenance.build.sourceDateEpoch === manifest.mihomo.sourceDateEpoch,
    "source date epoch mismatch",
  );
  assert(
    provenance.build.cCompiler === "NDK clang with an explicit --target triple and API suffix",
    "C compiler provenance mismatch",
  );
  assert(
    provenance.build.moduleMode === "wrapper copied into the pinned Mihomo module tree",
    "Go module mode mismatch",
  );
  assert(
    provenance.correspondingSource === manifest.mihomo.correspondingSource &&
      provenance.license === "GPL-3.0-only",
    "Mobile Core corresponding source or license provenance mismatch",
  );
  assert(
    evidenceSymbols.join("\n") === expectedSymbols.join("\n"),
    "evidence symbols differ from the committed ABI contract",
  );
  assert(
    provenance.artifacts.length === manifest.android.artifacts.length,
    "unexpected Android artifact evidence set",
  );
  assert(sbom.files?.length === manifest.android.artifacts.length, "unexpected SBOM file set");

  const toolchain = artifactDirectory ? ndkToolchain(resolveNdk()) : undefined;
  for (const target of manifest.android.artifacts) {
    const artifact = provenance.artifacts.find((candidate) => candidate.abi === target.abi);
    assert(artifact, `missing ${target.abi} provenance`);
    for (const field of ["abi", "goArch", "goAmd64", "targetTriple", "path"] as const) {
      assert(artifact[field] === target[field], `${target.abi} ${field} provenance mismatch`);
    }
    assert(artifact.machine === expectedMachines[target.abi], `${target.abi} machine mismatch`);
    assert(
      Number.isSafeInteger(artifact.size) && artifact.size > 0,
      `${target.abi} size is invalid`,
    );
    assert(/^[a-f0-9]{64}$/u.test(artifact.sha256), `${target.abi} checksum is invalid`);
    assert(
      checksums.get(artifact.path) === artifact.sha256,
      `${target.abi} checksum manifest entry is missing`,
    );
    assert(
      artifact.exportedSymbols.slice().sort().join("\n") === expectedSymbols.join("\n"),
      `${target.abi} exported symbols differ from the contract`,
    );
    assert(
      sbom.files?.some(
        (file) =>
          file.fileName === `./${artifact.path}` &&
          file.checksums.some(
            (checksum) =>
              checksum.algorithm === "SHA256" && checksum.checksumValue === artifact.sha256,
          ),
      ),
      `${target.abi} is missing from the SBOM`,
    );
    if (!artifactDirectory || !toolchain) continue;
    const artifactPath = resolveArtifactPath(artifactDirectory, artifact.path);
    assert(existsSync(artifactPath), `${target.abi} build output is absent`);
    assert(sha256(artifactPath) === artifact.sha256, `${target.abi} build output checksum differs`);
    inspectArtifact(artifactPath, artifact, expectedSymbols, toolchain);
  }
  assert(
    sbom.packages?.some(
      (entry) =>
        entry.name === "github.com/metacubex/mihomo" &&
        entry.versionInfo === manifest.mihomo.version,
    ),
    "Mihomo package is missing from the SBOM",
  );
}

const evidenceDirectory = path.resolve(argument("--evidence-dir") ?? canonicalEvidenceDirectory);
const artifactArgument = argument("--artifact-dir");
const artifactDirectory = artifactArgument ? path.resolve(artifactArgument) : undefined;
verifyEvidence(
  evidenceDirectory,
  artifactDirectory,
  process.argv.includes("--require-release-eligible"),
);

const tracked = execFileSync("git", ["ls-files", "mobile-core"], {
  cwd: repositoryRoot,
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);
const forbidden = tracked.filter((file) => /\.(?:aar|a|dylib|so|xcframework)$/u.test(file));
assert(forbidden.length === 0, `tracked native binaries are forbidden: ${forbidden.join(", ")}`);

console.log(
  artifactDirectory
    ? `mobile core evidence and ${manifest.android.artifacts.length} build outputs: ok`
    : "mobile core provenance and SBOM evidence: ok",
);
