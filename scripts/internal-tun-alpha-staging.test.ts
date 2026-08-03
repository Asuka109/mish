import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  finalizeInternalTunAlphaStage,
  internalTunAlphaChecksumsName,
  internalTunAlphaDmgName,
  internalTunAlphaPackageManifestName,
  internalTunAlphaProvenanceName,
  internalTunAlphaSbomName,
  internalTunAlphaStageInputsName,
  internalTunAlphaVerificationName,
} from "./internal-tun-alpha-staging.ts";
import { createCandidateManifest, type DispatchIdentity } from "./trusted-release-policy.ts";
import type { InternalTunAlphaVerificationEvidence } from "./verify-internal-tun-alpha-stage.ts";

const identity: DispatchIdentity = {
  actorId: "18379948",
  eventName: "workflow_dispatch",
  mainSha: "1".repeat(40),
  ref: "refs/heads/main",
  repository: "Asuka109/mish",
  repositoryId: "1304960811",
  repositoryOwnerId: "18379948",
  runAttempt: "1",
  runId: "123",
  sourceIsAncestor: true,
  sourceSha: "1".repeat(40),
  toolingSha: "1".repeat(40),
  triggeringActorId: "18379948",
  workflowRef: "Asuka109/mish/.github/workflows/stage-macos-alpha-release.yml@refs/heads/main",
  workflowSha: "1".repeat(40),
};
const candidateArtifactId = "456";
const verificationArtifactId = "789";
const candidateArtifactName = "mish-internal-tun-alpha-candidate-fixture";
const verificationArtifactName = "mish-internal-tun-alpha-verification-fixture";
const finalArtifactName = "mish-internal-tun-alpha-stage-fixture";
const roles = {
  [internalTunAlphaChecksumsName]: "sha256sums",
  [internalTunAlphaDmgName]: "internal-tun-alpha-dmg",
  [internalTunAlphaPackageManifestName]: "package-manifest",
  [internalTunAlphaProvenanceName]: "build-provenance",
  [internalTunAlphaSbomName]: "sbom",
} as const;

function fixture() {
  const temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-internal-stage-test-"));
  const candidate = path.join(temporary.path, "candidate");
  const verification = path.join(temporary.path, "verification");
  const output = path.join(temporary.path, "stage");
  mkdirSync(candidate);
  mkdirSync(verification);
  for (const name of Object.keys(roles)) writeFileSync(path.join(candidate, name), `${name}\n`);
  const manifest = createCandidateManifest({
    artifactName: candidateArtifactName,
    directory: candidate,
    identity,
    kind: "internal-tun-alpha-dmg-candidate",
    roles,
  });
  const evidence: InternalTunAlphaVerificationEvidence = {
    candidateArtifact: {
      bundleSha256: manifest.bundleSha256,
      id: candidateArtifactId,
      name: candidateArtifactName,
    },
    checks: [
      "focused-install-surface",
      "embedded-package-layout",
      "ownership-mode-link-policy",
      "helper-core-exact-digests-and-versions",
      "closed-protocol",
      "enrollment-boundary",
      "profile-isolation",
      "source-tooling-lockfiles",
      "sbom-provenance",
      "sha256",
    ],
    dmg: {
      format: "read-only-macos-installer-disk-image",
      name: internalTunAlphaDmgName,
      sha256: "2".repeat(64),
    },
    identity,
    package: {
      controllerSha256: "3".repeat(64),
      coreSha256: "4".repeat(64),
      coreVersion: "v1.19.29",
      helperSha256: "5".repeat(64),
      helperVersion: "3",
      installationIdentityScheme: "sha256-helper-core-rendered-plist-v1",
      manifestSha256: "6".repeat(64),
      plistTemplateSha256: "7".repeat(64),
      profile: "internal-tun-alpha",
      protocolVersion: 3,
      version: "0.1.0-internal-tun-alpha.7",
    },
    schemaVersion: 1,
    status: "verified",
  };
  writeFileSync(
    path.join(verification, internalTunAlphaVerificationName),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
  return {
    [Symbol.dispose]: () => temporary[Symbol.dispose](),
    candidate,
    evidence,
    finalize: (overrides: Record<string, unknown> = {}) =>
      finalizeInternalTunAlphaStage({
        candidateArtifactId,
        candidateArtifactName,
        candidateDirectory: candidate,
        finalArtifactName,
        identity,
        outputDirectory: output,
        sourceRoot: temporary.path,
        verificationArtifactId,
        verificationArtifactName,
        verificationDirectory: verification,
        ...overrides,
      }),
    output,
    temporary,
    verification,
  };
}

test("final stage binds immutable candidate and independent verification evidence", () => {
  using value = fixture();
  const manifest = value.finalize();
  assert.equal(manifest.kind, "internal-tun-alpha-immutable-stage");
  assert.equal(manifest.artifactName, finalArtifactName);
  assert.deepEqual(
    [...Object.keys(roles), "trusted-candidate-manifest.json"].map((name) =>
      readFileSync(path.join(value.candidate, name)),
    ),
    [...Object.keys(roles), "trusted-candidate-manifest.json"].map((name) =>
      readFileSync(path.join(value.output, "candidate", name)),
    ),
  );
  assert.deepEqual(
    readFileSync(path.join(value.verification, internalTunAlphaVerificationName)),
    readFileSync(path.join(value.output, "verification", internalTunAlphaVerificationName)),
  );
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(value.output, internalTunAlphaStageInputsName), "utf8")),
    {
      candidateArtifact: {
        bundleSha256: value.evidence.candidateArtifact.bundleSha256,
        id: candidateArtifactId,
        name: candidateArtifactName,
      },
      identity,
      schemaVersion: 1,
      verificationArtifact: {
        evidenceSha256: manifest.files.find(
          (file) => file.path === `verification/${internalTunAlphaVerificationName}`,
        )?.sha256,
        id: verificationArtifactId,
        name: verificationArtifactName,
      },
    },
  );
});

test("final stage fails closed on stale, substituted, unexpected, missing, or mutable input", () => {
  {
    using value = fixture();
    assert.throws(
      () =>
        value.finalize({
          identity: { ...identity, sourceSha: "8".repeat(40) },
        }),
      /stale|main/u,
    );
  }
  {
    using value = fixture();
    writeFileSync(path.join(value.candidate, internalTunAlphaDmgName), "substituted\n");
    assert.throws(() => value.finalize(), /changed/u);
  }
  {
    using value = fixture();
    writeFileSync(path.join(value.candidate, "unexpected"), "unexpected\n");
    assert.throws(() => value.finalize(), /changed/u);
  }
  {
    using value = fixture();
    writeFileSync(
      path.join(value.verification, internalTunAlphaVerificationName),
      `${JSON.stringify({
        ...value.evidence,
        candidateArtifact: { ...value.evidence.candidateArtifact, id: "999" },
      })}\n`,
    );
    assert.throws(() => value.finalize(), /partial|stale|mismatched/u);
  }
  {
    using value = fixture();
    mkdirSync(value.output);
    assert.throws(() => value.finalize(), /already exists|replaced/u);
  }
  {
    using value = fixture();
    assert.throws(
      () => value.finalize({ verificationArtifactName: "../mutable" }),
      /artifact name is invalid/u,
    );
  }
});

test("final stage rejects duplicate required roles and missing verification", () => {
  {
    using value = fixture();
    writeFileSync(path.join(value.candidate, "duplicate-sbom.json"), "{}\n");
    chmodSync(path.join(value.candidate, "trusted-candidate-manifest.json"), 0o644);
    createCandidateManifest({
      artifactName: candidateArtifactName,
      directory: value.candidate,
      identity,
      kind: "internal-tun-alpha-dmg-candidate",
      roles: { ...roles, "duplicate-sbom.json": "sbom" },
    });
    assert.throws(() => value.finalize(), /exactly one sbom/u);
  }
  {
    using value = fixture();
    assert.throws(
      () =>
        value.finalize({
          verificationDirectory: path.join(value.temporary.path, "missing"),
        }),
      /ENOENT/u,
    );
  }
});
