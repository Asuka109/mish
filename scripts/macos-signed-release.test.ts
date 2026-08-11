import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { existsSync, mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type SignedReleaseAsset,
  type SignedReleaseClient,
  type SignedReleaseCommandExecutor,
  type SignedReleaseCredentials,
  type SignedReleaseEvidence,
  type SignedReleaseAttestationTrust,
  type SignedReleaseRemoteRelease,
  type SignedReleaseRemoteState,
  SignedReleaseCommandRunner,
  SignedReleaseRecorder,
  cleanupSigningMaterials,
  finalizeSignedReleaseCandidate,
  generateSignedReleaseSbom,
  planSignedReleaseStaging,
  readSignedReleaseCandidate,
  runSignedReleaseFixture,
  signedReleaseAssetNames,
  signedReleaseChecksumName,
  signedReleaseDmgName,
  signedReleaseEnvironment,
  signedReleaseEvidenceName,
  signedReleaseSbomName,
  signedReleaseStages,
  stageSignedRelease,
  validateAppleNotaryResult,
  validateCompleteSignedReleaseCredentials,
  validateSignedReleaseEvidence,
  validateSignedReleasePlanningBoundary,
  withGuaranteedCleanup,
} from "./macos-signed-release.ts";
import {
  dssePayloadType,
  inTotoStatementType,
  slsaProvenancePredicateType,
  spdxPredicateType,
  verifyTrustedAttestation,
} from "./trusted-release-attestation.ts";

const sourceSha = "1".repeat(40);
const version = "0.1.0-alpha.1";
const identity = "Developer ID Application: Mish Fixture (ABCDE12345)";
const submissionId = "11111111-1111-1111-1111-111111111111";
const workflowPath = ".github/workflows/stage-macos-alpha-release.yml";
const workflowRef = `Asuka109/mish/${workflowPath}@refs/heads/main`;
const fixtureKeyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });

function attestationTrust(
  overrides: Partial<SignedReleaseAttestationTrust> = {},
): SignedReleaseAttestationTrust {
  return {
    publicKeySpki: fixtureKeyPair.publicKey,
    repository: "Asuka109/mish",
    repositoryId: "1304960811",
    repositoryOwnerId: "18379948",
    workflowRef,
    ...overrides,
  };
}

function pae(payloadType: string, payload: Buffer): Buffer {
  const type = Buffer.from(payloadType, "utf8");
  return Buffer.concat([
    Buffer.from("DSSEv1 ", "utf8"),
    Buffer.from(`${type.length} `, "ascii"),
    type,
    Buffer.from(` ${payload.length} `, "ascii"),
    payload,
  ]);
}

function signedAttestation(statement: Record<string, unknown>): Buffer {
  const payload = Buffer.from(JSON.stringify(statement), "utf8");
  const signature = sign("sha256", pae(dssePayloadType, payload), fixtureKeyPair.privateKey);
  return Buffer.from(
    JSON.stringify({
      dsseEnvelope: {
        payload: payload.toString("base64"),
        payloadType: dssePayloadType,
        signatures: [{ sig: signature.toString("base64") }],
      },
      mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
      verificationMaterial: {
        publicKey: {
          keyDetails: "PKIX_ECDSA_P256_SHA_256",
          rawBytes: fixtureKeyPair.publicKey
            .export({ format: "der", type: "spki" })
            .toString("base64"),
        },
      },
    }),
    "utf8",
  );
}

function provenanceStatement(
  artifactSha256: string,
  overrides: {
    commit?: string;
    path?: string;
    predicateType?: string;
    repository?: string;
    ref?: string;
  } = {},
): Record<string, unknown> {
  const repository = overrides.repository ?? "Asuka109/mish";
  const ref = overrides.ref ?? "refs/heads/main";
  const pathValue = overrides.path ?? workflowPath;
  return {
    _type: inTotoStatementType,
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            path: pathValue,
            ref,
            repository: `https://github.com/${repository}`,
          },
        },
        internalParameters: {
          github: {
            event_name: "workflow_dispatch",
            repository_id: "1304960811",
            repository_owner_id: "18379948",
            runner_environment: "github-hosted",
          },
        },
        resolvedDependencies: [
          {
            digest: { gitCommit: overrides.commit ?? sourceSha },
            uri: `git+https://github.com/${repository}@${ref}`,
          },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: {
          invocationId: "https://github.com/Asuka109/mish/actions/runs/123/attempts/1",
        },
      },
    },
    predicateType: overrides.predicateType ?? slsaProvenancePredicateType,
    subject: [{ digest: { sha256: artifactSha256 }, name: signedReleaseDmgName(version) }],
  };
}

function sbomStatement(artifactSha256: string): Record<string, unknown> {
  return {
    _type: inTotoStatementType,
    predicate: { spdxVersion: "SPDX-2.3" },
    predicateType: spdxPredicateType,
    subject: [{ digest: { sha256: artifactSha256 }, name: signedReleaseDmgName(version) }],
  };
}

function boundary(overrides: Record<string, unknown> = {}) {
  return {
    contentsPermission: "read",
    dryRun: true,
    environment: signedReleaseEnvironment,
    eventName: "workflow_dispatch",
    profile: "signed-direct",
    ref: "refs/heads/main",
    repository: "Asuka109/mish",
    sourceSha,
    version,
    ...overrides,
  };
}

function credentials(overrides: Partial<SignedReleaseCredentials> = {}): SignedReleaseCredentials {
  return {
    certificateBase64: Buffer.from("fixture p12").toString("base64"),
    certificatePassword: "fixture-password",
    notaryApiIssuerId: "11111111-1111-1111-1111-111111111111",
    notaryApiKeyId: "ABCDEF1234",
    notaryApiPrivateKey: "-----BEGIN PRIVATE KEY-----\nZmFrZQ==\n-----END PRIVATE KEY-----\n",
    signingIdentity: identity,
    ...overrides,
  };
}

function prefixEvidence(stageCount: number): SignedReleaseEvidence {
  const releaseIdentity = validateSignedReleasePlanningBoundary(boundary(), "Asuka109/mish");
  const recorder = new SignedReleaseRecorder(releaseIdentity);
  for (const stage of signedReleaseStages.slice(0, stageCount)) {
    recorder.confirm(stage, `fixture ${stage}`);
  }
  return {
    claims: {
      developerIdTrust: "observed-by-protected-workflow",
      distributionAssessment: "observed-by-protected-workflow",
      notarization: "observed-by-protected-workflow",
    },
    identity: releaseIdentity,
    notary: { issueCount: 0, status: "Accepted", submissionId },
    schemaVersion: 1,
    signing: { identity, teamIdentifier: "ABCDE12345" },
    stages: recorder.stages,
  };
}

function writePreliminaryCandidate(directory: string): void {
  const evidence = prefixEvidence(signedReleaseStages.indexOf("provenance-generated"));
  const dmg = path.join(directory, evidence.identity.dmgName);
  writeFileSync(dmg, "signed dmg fixture\n");
  const dmgSha256 = createHash("sha256").update(readFileSync(dmg)).digest("hex");
  writeFileSync(
    path.join(directory, signedReleaseSbomName),
    `${JSON.stringify({
      documentNamespace: `https://github.com/Asuka109/mish/sbom/${sourceSha}/${dmgSha256}`,
      name: `Mish ${version} macOS signed-direct SBOM`,
      packages: [
        {
          checksums: [{ algorithm: "SHA256", checksumValue: dmgSha256 }],
          name: "Mish",
          versionInfo: version,
        },
      ],
      spdxVersion: "SPDX-2.3",
    })}\n`,
  );
  writeFileSync(
    path.join(directory, signedReleaseEvidenceName),
    `${JSON.stringify(evidence, null, 2)}\n`,
  );
}

function completeCandidate(): {
  assets: SignedReleaseAsset[];
  directory: string;
  dispose: () => void;
} {
  const temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-signed-candidate-"));
  const candidate = path.join(temporary.path, "candidate");
  mkdirSync(candidate);
  writePreliminaryCandidate(candidate);
  const provenance = path.join(temporary.path, "source-provenance.json");
  const sbom = path.join(temporary.path, "source-sbom.json");
  const dmgSha256 = createHash("sha256")
    .update(readFileSync(path.join(candidate, signedReleaseDmgName(version))))
    .digest("hex");
  writeFileSync(provenance, signedAttestation(provenanceStatement(dmgSha256)));
  writeFileSync(sbom, signedAttestation(sbomStatement(dmgSha256)));
  finalizeSignedReleaseCandidate({
    artifactDirectory: candidate,
    provenanceBundle: provenance,
    provenanceId: "123",
    provenanceUrl: "https://github.com/Asuka109/mish/attestations/123",
    sbomBundle: sbom,
    sbomId: "456",
    sbomUrl: "https://github.com/Asuka109/mish/attestations/456",
    attestationTrust: attestationTrust(),
  });
  return {
    assets: readSignedReleaseCandidate(candidate, { sourceSha, version }),
    directory: candidate,
    dispose: () => temporary[Symbol.dispose](),
  };
}

function remoteRelease(
  assets: SignedReleaseRemoteRelease["assets"] = [],
): SignedReleaseRemoteRelease {
  return {
    assets,
    draft: true,
    htmlUrl: "https://example.invalid/draft",
    id: 1,
    name: `Mish v${version} signed-direct`,
    prerelease: true,
    tagName: `v${version}`,
    targetCommitish: sourceSha,
    uploadUrl: "https://uploads.example.invalid{?name,label}",
  };
}

class FakeClient implements SignedReleaseClient {
  readonly mutations: string[] = [];
  state: SignedReleaseRemoteState = { release: null, tagCommit: null };
  failUpload = false;

  async getState(): Promise<SignedReleaseRemoteState> {
    return this.state;
  }

  async createTag(tag: string, sha: string): Promise<void> {
    this.mutations.push(`tag:${tag}:${sha}`);
    this.state = { ...this.state, tagCommit: sha };
  }

  async createRelease(): Promise<void> {
    this.mutations.push("release");
    this.state = { ...this.state, release: remoteRelease() };
  }

  async uploadAsset(release: SignedReleaseRemoteRelease, asset: SignedReleaseAsset): Promise<void> {
    this.mutations.push(`upload:${asset.name}`);
    if (this.failUpload) throw new Error("fixture upload failure");
    release.assets.push({
      digest: `sha256:${asset.digest}`,
      id: release.assets.length + 1,
      name: asset.name,
      size: asset.size,
      state: "uploaded",
    });
  }
}

test("profile selection and trusted execution are explicit and independent from secrets", () => {
  assert.equal(
    validateSignedReleasePlanningBoundary(boundary(), "Asuka109/mish").profile,
    "signed-direct",
  );
  for (const candidate of [
    boundary({ profile: "alpha-ad-hoc" }),
    boundary({ eventName: "pull_request" }),
    boundary({ ref: "refs/pull/173/merge" }),
    boundary({ repository: "fork/mish" }),
    boundary({ environment: "" }),
    boundary({ contentsPermission: "write" }),
  ]) {
    assert.throws(
      () => validateSignedReleasePlanningBoundary(candidate, "Asuka109/mish"),
      /signed-direct|workflow_dispatch|refs\/heads\/main|repository|protected|contents: read/u,
    );
  }
  assert.doesNotThrow(() => validateSignedReleasePlanningBoundary(boundary(), "Asuka109/mish"));
});

test("complete credentials fail closed before effects when any field or identity drifts", () => {
  assert.deepEqual(validateCompleteSignedReleaseCredentials(credentials()), {
    identity,
    teamIdentifier: "ABCDE12345",
  });
  for (const key of Object.keys(credentials()) as Array<keyof SignedReleaseCredentials>) {
    assert.throws(
      () => validateCompleteSignedReleaseCredentials(credentials({ [key]: "" })),
      /incomplete/u,
    );
  }
  assert.throws(
    () =>
      validateCompleteSignedReleaseCredentials(
        credentials({ signingIdentity: "Apple Development: Fixture (ABCDE12345)" }),
      ),
    /Developer ID Application/u,
  );
});

test("ordered evidence rejects profile drift, reordering, Apple rejection, and missing ticket", () => {
  const evidence = prefixEvidence(signedReleaseStages.length);
  evidence.artifactIdentity = {
    dmgSha256: "1".repeat(64),
    evidenceSchemaVersion: 1,
    provenanceBundleSha256: "2".repeat(64),
    sbomBundleSha256: "3".repeat(64),
    sbomSha256: "4".repeat(64),
  };
  evidence.attestations = {
    provenance: {
      id: "123",
      url: "https://github.com/Asuka109/mish/attestations/123",
    },
    sbom: { id: "456", url: "https://github.com/Asuka109/mish/attestations/456" },
  };
  assert.doesNotThrow(() => validateSignedReleaseEvidence(evidence));

  const reordered = structuredClone(evidence);
  reordered.stages.reverse();
  assert.throws(() => validateSignedReleaseEvidence(reordered), /out of order/u);

  const drifted = structuredClone(evidence);
  drifted.identity.profile = "alpha-ad-hoc" as "signed-direct";
  assert.throws(() => validateSignedReleaseEvidence(drifted), /signed-direct/u);

  assert.throws(
    () =>
      validateAppleNotaryResult(
        { id: submissionId, status: "Invalid" },
        { issues: [{ message: "fixture rejection" }], status: "Invalid" },
      ),
    /terminal status Invalid/u,
  );
  const missingTicket = structuredClone(evidence);
  missingTicket.stages = missingTicket.stages.filter(({ stage }) => stage !== "ticket-validated");
  assert.throws(() => validateSignedReleaseEvidence(missingTicket), /out of order|not complete/u);
});

test("cleanup is guaranteed on success, failure, and cancellation-shaped errors", async () => {
  for (const outcome of ["success", "failure", "cancellation"] as const) {
    const trace: string[] = [];
    const operation = async () => {
      trace.push("operation");
      if (outcome === "failure") throw new Error("fixture failure");
      if (outcome === "cancellation") {
        const error = new Error("fixture cancellation");
        error.name = "AbortError";
        throw error;
      }
      return "ok";
    };
    const promise = withGuaranteedCleanup(operation, () => {
      trace.push("cleanup");
    });
    if (outcome === "success") {
      assert.equal(await promise, "ok");
    } else {
      await assert.rejects(promise, /fixture/);
    }
    assert.deepEqual(trace, ["operation", "cleanup"]);
  }

  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-signed-cleanup-"));
  const scratchRoot = path.join(temporary.path, "mish-signed-release-fixture");
  mkdirSync(scratchRoot);
  writeFileSync(path.join(scratchRoot, "developer-id.p12"), "fixture certificate");
  writeFileSync(path.join(scratchRoot, "notary-api-key.p8"), "fixture private key");
  writeFileSync(path.join(scratchRoot, "original-keychains.json"), "{interrupted");
  const originalRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = temporary.path;
  try {
    assert.throws(
      () => cleanupSigningMaterials(scratchRoot),
      /restoration failed after sensitive material removal/u,
    );
    assert.equal(existsSync(scratchRoot), false);
  } finally {
    if (originalRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = originalRunnerTemp;
    }
  }
});

test("protected command runner bounds time/output and records only safe metadata", () => {
  const runner = new SignedReleaseCommandRunner();
  const success = runner.run(process.execPath, ["-e", "process.stdout.write('fixture-result')"], {
    label: "fixture-success",
    maxOutputBytes: 1024,
    timeoutMs: 5_000,
  });
  assert.equal(success.stdout, "fixture-result");
  assert.deepEqual(runner.transcript[0], {
    label: "fixture-success",
    outcome: "success",
    signal: null,
    status: 0,
    stderrBytes: 0,
    stdoutBytes: Buffer.byteLength("fixture-result"),
  });

  assert.throws(
    () =>
      runner.run(
        process.execPath,
        ["-e", "process.stdout.write('fixture-secret-output'.repeat(1024))"],
        { label: "fixture-output-limit", maxOutputBytes: 128, timeoutMs: 5_000 },
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Signed release command fixture-output-limit failed (output-limit)." &&
      !error.message.includes("fixture-secret-output"),
  );
  assert.equal(runner.transcript.at(-1)?.outcome, "output-limit");

  assert.throws(
    () =>
      runner.run(process.execPath, ["-e", "setTimeout(() => {}, 5_000)", "fixture-private-key"], {
        label: "fixture-timeout",
        maxOutputBytes: 1024,
        timeoutMs: 25,
      }),
    (error: unknown) =>
      error instanceof Error &&
      error.message === "Signed release command fixture-timeout failed (timed-out)." &&
      !error.message.includes("fixture-private-key"),
  );
  assert.equal(runner.transcript.at(-1)?.outcome, "timed-out");

  const environment = runner.run(
    process.execPath,
    [
      "-e",
      "process.stdout.write([process.env.MISH_APPLE_CERTIFICATE_PASSWORD, process.env.GH_TOKEN].filter(Boolean).join(',') || 'absent')",
    ],
    {
      env: {
        ...process.env,
        GH_TOKEN: "fixture-token",
        MISH_APPLE_CERTIFICATE_PASSWORD: "fixture-secret",
      },
      label: "fixture-env-scrub",
      maxOutputBytes: 1024,
      timeoutMs: 5_000,
    },
  );
  assert.equal(environment.stdout, "absent");
});

test("cleanup removes sensitive files even when bounded effect cleanup fails", () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-signed-cleanup-failure-"));
  const scratchRoot = path.join(temporary.path, "mish-signed-release-fixture");
  mkdirSync(scratchRoot);
  writeFileSync(path.join(scratchRoot, "developer-id.p12"), "fixture certificate");
  writeFileSync(path.join(scratchRoot, "notary-api-key.p8"), "fixture private key");
  writeFileSync(path.join(scratchRoot, "signing.keychain-db"), "fixture keychain");
  const failingRunner: SignedReleaseCommandExecutor = {
    run() {
      throw new Error("fixture command failure");
    },
  };

  const originalRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = temporary.path;
  try {
    assert.throws(
      () => cleanupSigningMaterials(scratchRoot, failingRunner),
      /Temporary signing cleanup failed after sensitive material removal/u,
    );
    assert.equal(existsSync(scratchRoot), false);
  } finally {
    if (originalRunnerTemp === undefined) {
      delete process.env.RUNNER_TEMP;
    } else {
      process.env.RUNNER_TEMP = originalRunnerTemp;
    }
  }
});

test("final candidate binds the exact DMG, SBOM, attestations, and checksum manifest", () => {
  const candidate = completeCandidate();
  try {
    assert.deepEqual(
      candidate.assets.map(({ name }) => name).sort(),
      signedReleaseAssetNames(version).sort(),
    );
    const evidence = JSON.parse(
      readFileSync(path.join(candidate.directory, signedReleaseEvidenceName), "utf8"),
    ) as SignedReleaseEvidence;
    assert.equal(evidence.stages.at(-1)?.stage, "artifact-identity-confirmed");
    assert.equal(evidence.identity.dmgName, signedReleaseDmgName(version));

    writeFileSync(
      path.join(candidate.directory, signedReleaseDmgName(version)),
      "artifact drift\n",
    );
    assert.throws(
      () => readSignedReleaseCandidate(candidate.directory, { sourceSha, version }),
      /checksum drift|digests drifted/u,
    );
  } finally {
    candidate.dispose();
  }
});

test("offline attestation verification accepts only trusted, exact provenance", () => {
  const artifactSha256 = createHash("sha256").update("signed dmg fixture\n").digest("hex");
  const expectation = {
    artifactName: signedReleaseDmgName(version),
    artifactSha256,
    predicateType: slsaProvenancePredicateType,
    repository: "Asuka109/mish",
    repositoryId: "1304960811",
    repositoryOwnerId: "18379948",
    sourceSha,
    workflowRef,
    requireBuildIdentity: true,
  };
  const trustMaterial = { publicKeySpki: fixtureKeyPair.publicKey };
  const valid = signedAttestation(provenanceStatement(artifactSha256));
  assert.doesNotThrow(() => verifyTrustedAttestation(valid, expectation, trustMaterial));
  assert.doesNotThrow(() =>
    verifyTrustedAttestation(
      signedAttestation(sbomStatement(artifactSha256)),
      { ...expectation, predicateType: spdxPredicateType, requireBuildIdentity: false },
      trustMaterial,
    ),
  );

  const invalidSignature = JSON.parse(valid.toString("utf8")) as {
    dsseEnvelope: { signatures: Array<{ sig: string }> };
  };
  invalidSignature.dsseEnvelope.signatures[0].sig = `${"A".repeat(86)}==`;
  assert.throws(
    () => verifyTrustedAttestation(JSON.stringify(invalidSignature), expectation, trustMaterial),
    (error: unknown) =>
      error instanceof Error && error.message === "Attestation rejected (signature-invalid).",
  );

  const rejected = [
    [
      "predicate",
      signedAttestation(
        provenanceStatement(artifactSha256, { predicateType: "https://example.invalid/predicate" }),
      ),
      "predicate-mismatch",
    ],
    [
      "repository",
      signedAttestation(provenanceStatement(artifactSha256, { repository: "fork/mish" })),
      "repository-mismatch",
    ],
    [
      "workflow",
      signedAttestation(
        provenanceStatement(artifactSha256, { path: ".github/workflows/other.yml" }),
      ),
      "workflow-mismatch",
    ],
    [
      "commit",
      signedAttestation(provenanceStatement(artifactSha256, { commit: "2".repeat(40) })),
      "commit-mismatch",
    ],
    ["artifact", signedAttestation(provenanceStatement("0".repeat(64))), "artifact-mismatch"],
  ] as const;
  for (const [, source, code] of rejected) {
    assert.throws(
      () => verifyTrustedAttestation(source, expectation, trustMaterial),
      (error: unknown) =>
        error instanceof Error && error.message === `Attestation rejected (${code}).`,
    );
  }

  const missingMediaType = JSON.parse(valid.toString("utf8")) as Record<string, unknown>;
  delete missingMediaType.mediaType;
  assert.throws(
    () => verifyTrustedAttestation(JSON.stringify(missingMediaType), expectation, trustMaterial),
    /Attestation rejected \(malformed\)/u,
  );
  const unknownField = JSON.parse(valid.toString("utf8")) as Record<string, unknown>;
  unknownField.untrusted = "fixture";
  assert.throws(
    () => verifyTrustedAttestation(JSON.stringify(unknownField), expectation, trustMaterial),
    /Attestation rejected \(malformed\)/u,
  );
  assert.throws(
    () => verifyTrustedAttestation(valid, expectation, {}),
    /Attestation rejected \(trust-material-missing\)/u,
  );
});

test("SPDX package verification uses the sorted SHA-1 digest set", () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-signed-sbom-"));
  const application = path.join(temporary.path, "Mish.app");
  const dmg = path.join(temporary.path, signedReleaseDmgName(version));
  const output = path.join(temporary.path, signedReleaseSbomName);
  mkdirSync(application);
  writeFileSync(path.join(application, "fixture"), "signed application fixture\n");
  writeFileSync(dmg, "signed dmg fixture\n");
  generateSignedReleaseSbom(
    application,
    dmg,
    validateSignedReleasePlanningBoundary(boundary(), "Asuka109/mish"),
    output,
  );
  const sbom = JSON.parse(readFileSync(output, "utf8")) as {
    files: Array<{
      checksums: Array<{ algorithm: string; checksumValue: string }>;
    }>;
    packages: Array<{
      name: string;
      packageVerificationCode?: { packageVerificationCodeValue?: string };
    }>;
  };
  const sha1Digests = sbom.files.map((file) => {
    const checksum = file.checksums.find(({ algorithm }) => algorithm === "SHA1");
    assert.match(checksum?.checksumValue ?? "", /^[0-9a-f]{40}$/u);
    assert.match(
      file.checksums.find(({ algorithm }) => algorithm === "SHA256")?.checksumValue ?? "",
      /^[0-9a-f]{64}$/u,
    );
    return checksum?.checksumValue as string;
  });
  const expected = createHash("sha1").update(sha1Digests.sort().join("")).digest("hex");
  assert.equal(
    sbom.packages.find(({ name }) => name === "Mish")?.packageVerificationCode
      ?.packageVerificationCodeValue,
    expected,
  );
});

test("checksum, assessment, and Draft gating fail closed", () => {
  const candidate = completeCandidate();
  try {
    const checksum = path.join(candidate.directory, signedReleaseChecksumName);
    writeFileSync(checksum, readFileSync(checksum, "utf8").replace(/^[0-9a-f]/u, "f"));
    assert.throws(
      () => readSignedReleaseCandidate(candidate.directory, { sourceSha, version }),
      /checksum drift/u,
    );
  } finally {
    candidate.dispose();
  }

  const assessmentFailure = prefixEvidence(signedReleaseStages.length);
  assessmentFailure.stages = assessmentFailure.stages.filter(
    ({ stage }) => stage !== "distribution-assessed",
  );
  assert.throws(
    () => validateSignedReleaseEvidence(assessmentFailure),
    /out of order|not complete/u,
  );
  assert.throws(
    () =>
      planSignedReleaseStaging(
        { assets: [], candidateUploaded: false, sourceSha, version },
        { release: null, tagCommit: null },
      ),
    /successfully uploaded/u,
  );
});

test("upload failure stops before Draft eligibility and never resumes silently", async () => {
  const candidate = completeCandidate();
  try {
    const client = new FakeClient();
    client.failUpload = true;
    await assert.rejects(
      stageSignedRelease(
        client,
        { assets: candidate.assets, candidateUploaded: true, sourceSha, version },
        false,
      ),
      /fixture upload failure/u,
    );
    assert.deepEqual(client.mutations.slice(0, 3), [
      `tag:v${version}:${sourceSha}`,
      "release",
      `upload:${signedReleaseDmgName(version)}`,
    ]);
    assert.notEqual(
      planSignedReleaseStaging(
        { assets: candidate.assets, candidateUploaded: true, sourceSha, version },
        client.state,
      ).action,
      "already-staged",
    );
  } finally {
    candidate.dispose();
  }
});

test("same-source retries verify every remote digest before considering Draft staged", () => {
  const candidate = completeCandidate();
  try {
    const assets = candidate.assets.map((asset, index) => ({
      digest: `sha256:${asset.digest}`,
      id: index + 1,
      name: asset.name,
      size: asset.size,
      state: "uploaded",
    }));
    assert.equal(
      planSignedReleaseStaging(
        { assets: candidate.assets, candidateUploaded: true, sourceSha, version },
        { release: remoteRelease(assets), tagCommit: sourceSha },
      ).action,
      "already-staged",
    );
    assets[0] = { ...assets[0], digest: `sha256:${"0".repeat(64)}` };
    assert.throws(
      () =>
        planSignedReleaseStaging(
          { assets: candidate.assets, candidateUploaded: true, sourceSha, version },
          { release: remoteRelease(assets), tagCommit: sourceSha },
        ),
      /digest drifted/u,
    );
  } finally {
    candidate.dispose();
  }
});

test("deterministic credential-free fixture covers required boundaries without external effects", () => {
  const result = runSignedReleaseFixture();
  assert.equal(result.profile, "signed-direct");
  assert.match(result["untrusted-event"], /workflow_dispatch/u);
  assert.match(result["apple-rejection"], /terminal status Invalid/u);
  assert.match(result["upload-failure"], /successfully uploaded/u);
  assert.equal(result.stages, signedReleaseStages.join(","));
  assert.equal(result.updaterStage, "contract-only");
  assert.equal(
    result.updaterArtifacts,
    "Mish-0.1.1-alpha.2-aarch64.app.tar.gz,Mish-0.1.1-alpha.2-aarch64.app.tar.gz.sig,mish-alpha.json,mish-alpha.json.sig",
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /Developer ID trust confirmed|Gatekeeper accepted live release|https?:|dW50cnVzdGVk/u,
  );
});
