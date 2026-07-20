import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

interface ArtifactEvidence {
  abi: string;
  path: string;
  sha256: string;
  exportedSymbols: string[];
}

interface Provenance {
  abiVersion: number;
  source: { commit: string; version: string; tree: string };
  wrapper: { revision: string; sha256: string };
  toolchains: { go: { version: string }; androidNdk: { revision: string } };
  artifacts: ArtifactEvidence[];
}

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(
  readFileSync(path.join(repositoryRoot, "mobile-core/source-manifest.json"), "utf8"),
);
const evidenceDirectory = path.join(repositoryRoot, "mobile-core/evidence/android-v1.19.29");
const provenance = JSON.parse(
  readFileSync(path.join(evidenceDirectory, "build-provenance.json"), "utf8"),
) as Provenance;
const checksums = readFileSync(path.join(evidenceDirectory, "SHA256SUMS"), "utf8");
const symbols = readFileSync(path.join(evidenceDirectory, "abi-symbols.txt"), "utf8")
  .trim()
  .split("\n")
  .sort();
const sbom = JSON.parse(readFileSync(path.join(evidenceDirectory, "sbom.spdx.json"), "utf8"));

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

assert(provenance.abiVersion === manifest.abiVersion, "ABI provenance mismatch");
assert(provenance.source.commit === manifest.mihomo.commit, "Mihomo commit mismatch");
assert(provenance.source.tree === manifest.mihomo.tree, "Mihomo tree mismatch");
assert(provenance.source.version === manifest.mihomo.version, "Mihomo version mismatch");
assert(provenance.wrapper.revision === manifest.wrapperRevision, "wrapper revision mismatch");
assert(/^[a-f0-9]{64}$/u.test(provenance.wrapper.sha256), "wrapper digest is invalid");
assert(provenance.toolchains.go.version.includes(manifest.go.version), "Go provenance mismatch");
assert(
  provenance.toolchains.androidNdk.revision === manifest.android.ndkVersion,
  "NDK provenance mismatch",
);
assert(provenance.artifacts.length === 2, "expected two Android artifacts");
for (const artifact of provenance.artifacts) {
  assert(["arm64-v8a", "x86_64"].includes(artifact.abi), `unexpected ABI ${artifact.abi}`);
  assert(/^[a-f0-9]{64}$/u.test(artifact.sha256), `${artifact.abi} checksum is invalid`);
  assert(
    checksums.includes(`${artifact.sha256}  ${artifact.path}`),
    `${artifact.abi} checksum manifest entry is missing`,
  );
  assert(
    artifact.exportedSymbols.slice().sort().join("\n") === symbols.join("\n"),
    `${artifact.abi} exported symbols differ from the contract`,
  );
  assert(
    sbom.files.some(
      (file: { fileName: string; checksums: Array<{ checksumValue: string }> }) =>
        file.fileName === `./${artifact.path}` &&
        file.checksums.some((checksum) => checksum.checksumValue === artifact.sha256),
    ),
    `${artifact.abi} is missing from the SBOM`,
  );
}
assert(
  sbom.packages.some(
    (entry: { name: string; versionInfo: string }) =>
      entry.name === "github.com/metacubex/mihomo" && entry.versionInfo === manifest.mihomo.version,
  ),
  "Mihomo package is missing from the SBOM",
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

const artifactDirectoryIndex = process.argv.indexOf("--artifact-dir");
const scratchDirectory =
  artifactDirectoryIndex === -1
    ? undefined
    : path.resolve(process.argv[artifactDirectoryIndex + 1] ?? "");
if (scratchDirectory) {
  assert(
    existsSync(scratchDirectory),
    "artifact verification requested but build output is absent",
  );
  for (const artifact of provenance.artifacts) {
    const artifactPath = path.join(scratchDirectory, artifact.path);
    assert(existsSync(artifactPath), `${artifact.abi} build output is absent`);
    const digest = createHash("sha256").update(readFileSync(artifactPath)).digest("hex");
    assert(
      digest === artifact.sha256,
      `${artifact.abi} build output checksum differs from evidence`,
    );
  }
}

console.log("mobile core provenance and SBOM evidence: ok");
