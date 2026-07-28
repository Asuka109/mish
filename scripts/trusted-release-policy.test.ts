import assert from "node:assert/strict";
import { linkSync, mkdtempDisposableSync, mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { validateActionReferences } from "./check-trusted-ci-policy.ts";
import {
  createCandidateManifest,
  readTrustedReleasePolicy,
  runTrustedReleaseAdversarialFixture,
  validateDispatchIdentity,
  validateProtectedCandidate,
  validateProtectedRequest,
  verifyCandidateManifest,
  type DispatchIdentity,
  type ProtectedRequest,
} from "./trusted-release-policy.ts";

const policy = readTrustedReleasePolicy();
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
  sourceSha: "2".repeat(40),
  toolingSha: "1".repeat(40),
  triggeringActorId: "18379948",
  workflowRef: "Asuka109/mish/.github/workflows/stage-macos-alpha-release.yml@refs/heads/main",
  workflowSha: "1".repeat(40),
};

test("trusted dispatch rejects fork, PR, merge ref, actor, source, workflow, and tooling drift", () => {
  const cases: Array<[keyof DispatchIdentity, DispatchIdentity[keyof DispatchIdentity]]> = [
    ["repository", "attacker/mish"],
    ["eventName", "pull_request"],
    ["ref", "refs/pull/270/merge"],
    ["actorId", "999"],
    ["sourceIsAncestor", false],
    [
      "workflowRef",
      "Asuka109/mish/.github/workflows/stage-macos-alpha-release.yml@refs/heads/feature",
    ],
    ["toolingSha", "3".repeat(40)],
  ];
  for (const [field, value] of cases) {
    const candidate = { ...identity, [field]: value };
    assert.notEqual(
      validateDispatchIdentity(policy, candidate).length,
      0,
      `${field} drift must fail closed`,
    );
  }
});

test("current policy rejects every protected request before credentials or identity exist", () => {
  const request: ProtectedRequest = {
    ...identity,
    callerWorkflowRef: null,
    candidateArtifactId: "456",
    candidateBundleSha256: "3".repeat(64),
    environment: "macos-developer-id",
    jobKind: "sign",
    runnerLabel: "macos-15",
  };
  assert.ok(validateProtectedRequest(policy, request).includes("protected execution is disabled"));
});

test("protected contract rejects self-hosted and attacker-controlled reusable workflows", () => {
  const active = structuredClone(policy);
  active.activation.enabled = true;
  const base: ProtectedRequest = {
    ...identity,
    callerWorkflowRef: null,
    candidateArtifactId: "456",
    candidateBundleSha256: "3".repeat(64),
    environment: "macos-developer-id",
    jobKind: "sign",
    runnerLabel: "macos-15",
  };
  assert.deepEqual(validateProtectedRequest(active, base), []);
  assert.ok(validateProtectedRequest(active, { ...base, runnerLabel: "self-hosted" }).length > 0);
  assert.ok(
    validateProtectedRequest(active, {
      ...base,
      callerWorkflowRef: "attacker/repo/.github/workflows/release.yml@refs/heads/main",
    }).length > 0,
  );
});

test("candidate manifest binds exact source, workflow, tooling, files, roles, and digest", () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-candidate-test-"));
  const directory = path.join(temporary.path, "candidate");
  mkdirSync(directory);
  writeFileSync(path.join(directory, "Mish.app.tar"), "fixture unsigned app\n");
  writeFileSync(path.join(directory, "macos-sbom.spdx.json"), '{"fixture":true}\n');
  writeFileSync(path.join(directory, "build-provenance.json"), '{"fixture":true}\n');
  const roles = {
    "Mish.app.tar": "unsigned-application",
    "build-provenance.json": "build-provenance",
    "macos-sbom.spdx.json": "sbom",
  };
  createCandidateManifest({
    artifactName: "fixture-candidate",
    directory,
    identity,
    kind: "unsigned-macos-candidate",
    roles,
  });
  const verified = verifyCandidateManifest({
    directory,
    expectedArtifactId: "456",
    expectedArtifactName: "fixture-candidate",
    expectedIdentity: identity,
    requiredRoles: policy.artifact.requiredProtectedRoles,
  });
  assert.match(verified.bundleSha256, /^[0-9a-f]{64}$/u);
  const active = structuredClone(policy);
  active.activation.enabled = true;
  const protectedRequest: ProtectedRequest = {
    ...identity,
    callerWorkflowRef: null,
    candidateArtifactId: "456",
    candidateBundleSha256: verified.bundleSha256,
    environment: "macos-developer-id",
    jobKind: "sign",
    runnerLabel: "macos-15",
  };
  assert.deepEqual(validateProtectedCandidate(active, protectedRequest, verified), []);
  assert.ok(
    validateProtectedCandidate(
      active,
      { ...protectedRequest, candidateBundleSha256: "f".repeat(64) },
      verified,
    ).includes("protected request and candidate bundle digest differ"),
  );

  writeFileSync(path.join(directory, "unexpected"), "injected\n");
  assert.throws(
    () =>
      verifyCandidateManifest({
        directory,
        expectedArtifactId: "456",
        expectedArtifactName: "fixture-candidate",
        expectedIdentity: identity,
        requiredRoles: policy.artifact.requiredProtectedRoles,
      }),
    /changed/u,
  );
});

test("candidate manifest rejects symlink substitution", () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-symlink-test-"));
  const directory = path.join(temporary.path, "candidate");
  mkdirSync(directory);
  writeFileSync(path.join(temporary.path, "outside"), "outside\n");
  symlinkSync(path.join(temporary.path, "outside"), path.join(directory, "candidate"));
  assert.throws(
    () =>
      createCandidateManifest({
        artifactName: "fixture-candidate",
        directory,
        identity,
        kind: "unsigned-macos-candidate",
      }),
    /symlink/u,
  );
});

test("candidate manifest rejects hard-link substitution", () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-hardlink-test-"));
  const directory = path.join(temporary.path, "candidate");
  mkdirSync(directory);
  const outside = path.join(temporary.path, "outside");
  writeFileSync(outside, "outside\n");
  linkSync(outside, path.join(directory, "candidate"));
  assert.throws(
    () =>
      createCandidateManifest({
        artifactName: "fixture-candidate",
        directory,
        identity,
        kind: "unsigned-macos-candidate",
      }),
    /hard link/u,
  );
});

test("workflow dependency policy rejects tags, drifted digests, and unknown actions", () => {
  assert.deepEqual(
    validateActionReferences(policy, [
      `actions/checkout@${policy.actions.allowed["actions/checkout"]}`,
    ]),
    [],
  );
  assert.equal(validateActionReferences(policy, ["actions/checkout@v6"]).length, 1);
  assert.equal(validateActionReferences(policy, [`actions/checkout@${"f".repeat(40)}`]).length, 1);
  assert.equal(validateActionReferences(policy, [`attacker/action@${"f".repeat(40)}`]).length, 1);
});

test("aggregate adversarial fixture covers every protected trust dimension", () => {
  const evidence = runTrustedReleaseAdversarialFixture();
  for (const name of [
    "fork-repository",
    "pull-request-event",
    "merge-ref",
    "untrusted-actor",
    "workflow-revision",
    "tooling-revision",
    "source-ancestry",
    "self-hosted-runner",
    "reusable-workflow",
    "disabled-boundary",
    "artifact-substitution",
  ]) {
    assert.ok(evidence[name], `Missing ${name} fixture evidence.`);
  }
});
