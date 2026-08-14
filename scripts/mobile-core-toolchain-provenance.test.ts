import assert from "node:assert/strict";
import test from "node:test";
import {
  callerSuppliedGoToolchainProvenance,
  officialGoToolchainProvenance,
  verifyGoToolchainProvenance,
  type GoToolchainManifest,
} from "./mobile-core-toolchain-provenance.ts";

const officialArchiveSha256 = "a".repeat(64);
const officialExecutableSha256 = "b".repeat(64);
const customExecutableSha256 = "c".repeat(64);
const manifest: GoToolchainManifest = {
  version: "go1.26.0",
  archives: {
    "darwin-arm64": {
      sha256: officialArchiveSha256,
      executableSha256: officialExecutableSha256,
    },
  },
};
const version = "go version go1.26.0 darwin/arm64";

test("accepts a bounded honest local override but keeps it out of release admission", () => {
  const provenance = callerSuppliedGoToolchainProvenance(version, customExecutableSha256);

  assert.deepEqual(
    verifyGoToolchainProvenance(provenance, manifest, { expectedHost: "darwin-arm64" }),
    provenance,
  );
  assert.deepEqual(Object.keys(provenance).toSorted(), ["executableSha256", "source", "version"]);
  assert.deepEqual(Object.keys(provenance.source).toSorted(), [
    "identity",
    "kind",
    "releaseEligible",
    "trust",
  ]);
  assert.throws(
    () =>
      verifyGoToolchainProvenance(provenance, manifest, {
        expectedHost: "darwin-arm64",
        requireReleaseEligible: true,
      }),
    /not release eligible/u,
  );
});

test("accepts pinned archive and verified cache only with the official executable identity", () => {
  for (const kind of ["pinned-archive", "verified-cache"] as const) {
    const provenance = officialGoToolchainProvenance(
      kind,
      version,
      "darwin-arm64",
      manifest.archives["darwin-arm64"],
    );
    assert.deepEqual(
      verifyGoToolchainProvenance(provenance, manifest, { requireReleaseEligible: true }),
      provenance,
    );
  }
});

test("rejects a same-version custom executable falsely claiming official archive identity", () => {
  const falseClaim = {
    version,
    executableSha256: customExecutableSha256,
    source: {
      kind: "verified-cache",
      host: "darwin-arm64",
      archiveSha256: officialArchiveSha256,
      releaseEligible: true,
    },
  };

  assert.throws(
    () => verifyGoToolchainProvenance(falseClaim, manifest, { requireReleaseEligible: true }),
    /does not match the verified official archive/u,
  );
});

test("rejects arbitrary paths, raw output, and unknown source classifications", () => {
  const provenance = callerSuppliedGoToolchainProvenance(version, customExecutableSha256);
  assert.throws(
    () =>
      verifyGoToolchainProvenance(
        { ...provenance, executablePath: "/private/toolchain/bin/go" },
        manifest,
      ),
    /must contain only/u,
  );
  assert.throws(
    () =>
      verifyGoToolchainProvenance(
        { ...provenance, source: { ...provenance.source, rawOutput: "go env output" } },
        manifest,
      ),
    /must contain only/u,
  );
  assert.throws(
    () =>
      verifyGoToolchainProvenance(
        { ...provenance, source: { kind: "official", releaseEligible: true } },
        manifest,
      ),
    /source kind is not supported/u,
  );
});
