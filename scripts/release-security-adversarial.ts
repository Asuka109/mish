import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  assertPrivateNoFollowRoot,
  readContainedReleaseFile,
  ReleasePathError,
} from "./release-path-containment.ts";
import {
  cleanupSigningMaterials,
  SignedReleaseCommandRunner,
  withGuaranteedCleanup,
  type SignedReleaseCommandExecutor,
} from "./macos-signed-release.ts";
import {
  AttestationVerificationError,
  dssePayloadType,
  inTotoStatementType,
  slsaProvenancePredicateType,
  verifyTrustedAttestation,
  type AttestationExpectation,
} from "./trusted-release-attestation.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const maxTranscriptEvents = 128;
const maxTranscriptBytes = 64 * 1024;
const artifactName = "Mish-0.1.0-alpha.1-arm64.dmg";
const artifactSha256 = createHash("sha256").update("synthetic signed artifact\n").digest("hex");
const sourceSha = "1".repeat(40);
const workflowPath = ".github/workflows/stage-macos-alpha-release.yml";
const workflowRef = `Asuka109/mish/${workflowPath}@refs/heads/main`;

const existingCoverage = [
  ["path-containment", "path-basic-rejections", "release-path-containment.test.ts"],
  ["path-containment", "path-symlink-and-hard-link", "release-path-containment.test.ts"],
  [
    "provenance-attestation",
    "signature-predicate-repository-workflow-commit-artifact",
    "macos-signed-release.test.ts",
  ],
  [
    "provenance-attestation",
    "malformed-envelope-and-trust-material",
    "macos-signed-release.test.ts",
  ],
  ["bounded-runner", "timeout-and-environment-scrub", "macos-signed-release.test.ts"],
  ["bounded-runner", "output-limit", "macos-signed-release.test.ts"],
  ["bounded-runner", "cleanup-success-failure-and-cancellation", "macos-signed-release.test.ts"],
] as const;

const dynamicScenarioIds = [
  "path-concurrent-overwrite-assert-use",
  "path-replacement-terminal",
  "path-removal-terminal",
  "provenance-repository-id-mismatch",
  "provenance-owner-id-mismatch",
  "provenance-workflow-branch-mismatch",
  "provenance-artifact-name-mismatch",
  "provenance-artifact-digest-mismatch",
  "provenance-malformed-json",
  "provenance-invalid-base64",
  "provenance-duplicate-dependency",
  "provenance-multiple-subjects",
  "provenance-oversized-bundle",
  "provenance-untrusted-signer",
  "runner-command-failure",
  "runner-spawn-failure",
  "runner-cancellation-cleanup",
  "runner-cleanup-timeout",
  "runner-cleanup-output-limit",
] as const;

type Contract = "path-containment" | "provenance-attestation" | "bounded-runner";
type RecordStatus = "covered" | "rejected" | "cleaned";

export type ReleaseSecurityMatrixRecord = {
  contract: Contract;
  expected: string;
  id: string;
  observed: string;
  source: "existing" | "matrix";
  status: RecordStatus;
  stderrBytes?: number;
  stdoutBytes?: number;
};

export type ReleaseSecurityGateReport = {
  records: ReleaseSecurityMatrixRecord[];
  schemaVersion: 1;
  transcript: {
    eventCount: number;
    maxBytes: number;
    maxEvents: number;
  };
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
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

function provenanceStatement(
  digest: string,
  overrides: {
    artifactName?: string;
    artifactDigest?: string;
    commit?: string;
    ownerId?: string;
    predicateExtra?: Record<string, unknown>;
    repositoryId?: string;
    ref?: string;
    subjects?: Array<Record<string, unknown>>;
  } = {},
): Record<string, unknown> {
  const ref = overrides.ref ?? "refs/heads/main";
  const subject = {
    digest: { sha256: overrides.artifactDigest ?? digest },
    name: overrides.artifactName ?? artifactName,
  };
  return {
    _type: inTotoStatementType,
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            path: workflowPath,
            ref,
            repository: "https://github.com/Asuka109/mish",
          },
        },
        internalParameters: {
          github: {
            event_name: "workflow_dispatch",
            repository_id: overrides.repositoryId ?? "1304960811",
            repository_owner_id: overrides.ownerId ?? "18379948",
            runner_environment: "github-hosted",
          },
        },
        resolvedDependencies: [
          {
            digest: { gitCommit: overrides.commit ?? sourceSha },
            uri: `git+https://github.com/Asuka109/mish@${ref}`,
          },
        ],
      },
      runDetails: {
        builder: { id: "https://github.com/actions/runner/github-hosted" },
        metadata: { invocationId: "https://github.com/Asuka109/mish/actions/runs/123/attempts/1" },
      },
      ...overrides.predicateExtra,
    },
    predicateType: slsaProvenancePredicateType,
    subject: overrides.subjects ?? [subject],
  };
}

function signedAttestation(
  statement: Record<string, unknown>,
  keyPair: { privateKey: KeyObject; publicKey: KeyObject },
): Buffer {
  const payload = Buffer.from(JSON.stringify(statement), "utf8");
  const signature = sign("sha256", pae(dssePayloadType, payload), keyPair.privateKey);
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
          rawBytes: keyPair.publicKey.export({ format: "der", type: "spki" }).toString("base64"),
        },
      },
    }),
    "utf8",
  );
}

function attestationExpectation(): AttestationExpectation {
  return {
    artifactName,
    artifactSha256,
    predicateType: slsaProvenancePredicateType,
    repository: "Asuka109/mish",
    repositoryId: "1304960811",
    repositoryOwnerId: "18379948",
    requireBuildIdentity: true,
    sourceSha,
    workflowRef,
  };
}

function recordRejected(
  records: ReleaseSecurityMatrixRecord[],
  id: string,
  contract: Contract,
  expected: string,
  observed: string,
): void {
  invariant(observed === expected, `${id} observed ${observed}, expected ${expected}.`);
  records.push({
    contract,
    expected,
    id,
    observed,
    source: "matrix",
    status: "rejected",
  });
}

function runPathContainmentMatrix(records: ReleaseSecurityMatrixRecord[]): void {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-release-security-path-"));
  const rootPath = path.join(temporary.path, "Mish.app");
  mkdirSync(rootPath, { mode: 0o700 });
  const root = assertPrivateNoFollowRoot(rootPath);

  const overwritePath = path.join(rootPath, "candidate");
  writeFileSync(overwritePath, "original\n", { mode: 0o600 });
  const overwriteGuard = root.contain("candidate", "file");
  overwriteGuard.assertCurrent();
  // This deterministic handoff represents a concurrent writer replacing the
  // admitted path before the guarded use. No timing race is needed.
  renameSync(overwritePath, path.join(temporary.path, "candidate-old"));
  writeFileSync(overwritePath, "replacement\n", { mode: 0o600 });
  let overwriteObserved = "accepted";
  try {
    readContainedReleaseFile(overwriteGuard);
  } catch (error) {
    overwriteObserved = error instanceof ReleasePathError ? error.classification : "unknown";
  }
  recordRejected(
    records,
    "path-concurrent-overwrite-assert-use",
    "path-containment",
    "replaced",
    overwriteObserved,
  );

  const parentPath = path.join(rootPath, "Contents");
  mkdirSync(parentPath, { mode: 0o700 });
  const parentTarget = path.join(parentPath, "terminal");
  writeFileSync(parentTarget, "terminal\n", { mode: 0o600 });
  const parentGuard = root.contain("Contents/terminal", "file");
  parentGuard.assertCurrent();
  renameSync(parentPath, path.join(temporary.path, "Contents-old"));
  mkdirSync(parentPath, { mode: 0o700 });
  writeFileSync(path.join(parentPath, "terminal"), "terminal replacement\n", { mode: 0o600 });
  let parentObserved = "accepted";
  try {
    readContainedReleaseFile(parentGuard);
  } catch (error) {
    parentObserved = error instanceof ReleasePathError ? error.classification : "unknown";
  }
  recordRejected(
    records,
    "path-replacement-terminal",
    "path-containment",
    "replaced",
    parentObserved,
  );

  const removedPath = path.join(rootPath, "removed");
  writeFileSync(removedPath, "removed\n", { mode: 0o600 });
  const removedGuard = root.contain("removed", "file");
  unlinkSync(removedPath);
  let removedObserved = "accepted";
  try {
    readContainedReleaseFile(removedGuard);
  } catch (error) {
    removedObserved = error instanceof ReleasePathError ? error.classification : "unknown";
  }
  recordRejected(records, "path-removal-terminal", "path-containment", "missing", removedObserved);
}

function verifyAttestationCase(
  records: ReleaseSecurityMatrixRecord[],
  id: string,
  source: Buffer | string,
  expected: string,
  trust: { publicKeySpki: KeyObject },
): void {
  let observed = "accepted";
  try {
    verifyTrustedAttestation(source, attestationExpectation(), trust);
  } catch (error) {
    observed = error instanceof AttestationVerificationError ? error.code : "malformed";
  }
  recordRejected(records, id, "provenance-attestation", expected, observed);
}

function runProvenanceMatrix(records: ReleaseSecurityMatrixRecord[]): void {
  const keyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const valid = signedAttestation(provenanceStatement(artifactSha256), keyPair);
  const validJson = JSON.parse(valid.toString("utf8")) as {
    dsseEnvelope: { payload: string };
  };
  const trust = { publicKeySpki: keyPair.publicKey };

  const repositoryId = provenanceStatement(artifactSha256, { repositoryId: "9999999999" });
  verifyAttestationCase(
    records,
    "provenance-repository-id-mismatch",
    signedAttestation(repositoryId, keyPair),
    "repository-mismatch",
    trust,
  );
  const ownerId = provenanceStatement(artifactSha256, { ownerId: "9999999999" });
  verifyAttestationCase(
    records,
    "provenance-owner-id-mismatch",
    signedAttestation(ownerId, keyPair),
    "repository-mismatch",
    trust,
  );
  const branch = provenanceStatement(artifactSha256, { ref: "refs/heads/release" });
  verifyAttestationCase(
    records,
    "provenance-workflow-branch-mismatch",
    signedAttestation(branch, keyPair),
    "workflow-mismatch",
    trust,
  );
  const artifactNameStatement = provenanceStatement(artifactSha256, { artifactName: "other.dmg" });
  verifyAttestationCase(
    records,
    "provenance-artifact-name-mismatch",
    signedAttestation(artifactNameStatement, keyPair),
    "artifact-mismatch",
    trust,
  );
  const artifactDigestStatement = provenanceStatement(artifactSha256, {
    artifactDigest: "0".repeat(64),
  });
  verifyAttestationCase(
    records,
    "provenance-artifact-digest-mismatch",
    signedAttestation(artifactDigestStatement, keyPair),
    "artifact-mismatch",
    trust,
  );
  verifyAttestationCase(records, "provenance-malformed-json", "{", "malformed", trust);
  const invalidBase64 = structuredClone(validJson);
  invalidBase64.dsseEnvelope.payload = "%";
  verifyAttestationCase(
    records,
    "provenance-invalid-base64",
    JSON.stringify(invalidBase64),
    "malformed",
    trust,
  );
  const duplicateDependency = provenanceStatement(artifactSha256);
  const duplicatePredicate = duplicateDependency.predicate as {
    buildDefinition: { resolvedDependencies: Array<Record<string, unknown>> };
  };
  const dependencies = duplicatePredicate.buildDefinition.resolvedDependencies;
  dependencies.push(structuredClone(dependencies[0]));
  verifyAttestationCase(
    records,
    "provenance-duplicate-dependency",
    signedAttestation(duplicateDependency, keyPair),
    "commit-mismatch",
    trust,
  );
  const multipleSubjects = provenanceStatement(artifactSha256, {
    subjects: [
      { digest: { sha256: artifactSha256 }, name: artifactName },
      { digest: { sha256: artifactSha256 }, name: "second.dmg" },
    ],
  });
  verifyAttestationCase(
    records,
    "provenance-multiple-subjects",
    signedAttestation(multipleSubjects, keyPair),
    "artifact-mismatch",
    trust,
  );
  verifyAttestationCase(
    records,
    "provenance-oversized-bundle",
    Buffer.concat([valid, Buffer.alloc(16 * 1024 * 1024)]),
    "malformed",
    trust,
  );
  const otherKeyPair = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  verifyAttestationCase(records, "provenance-untrusted-signer", valid, "untrusted-signer", {
    publicKeySpki: otherKeyPair.publicKey,
  });
}

function runnerRecord(
  records: ReleaseSecurityMatrixRecord[],
  id: string,
  expected: string,
  runner: SignedReleaseCommandRunner,
): void {
  const transcript = runner.transcript.at(-1);
  invariant(transcript, `${id} did not produce a bounded runner transcript.`);
  invariant(
    transcript.outcome === expected,
    `${id} observed ${transcript.outcome}, expected ${expected}.`,
  );
  records.push({
    contract: "bounded-runner",
    expected,
    id,
    observed: transcript.outcome,
    source: "matrix",
    status: "rejected",
    stderrBytes: transcript.stderrBytes,
    stdoutBytes: transcript.stdoutBytes,
  });
}

function runRunnerFailureCase(
  records: ReleaseSecurityMatrixRecord[],
  id: string,
  program: string,
  arguments_: string[],
  expected: string,
  timeoutMs: number,
  maxOutputBytes: number,
): void {
  const runner = new SignedReleaseCommandRunner();
  try {
    runner.run(program, arguments_, {
      label: id,
      maxOutputBytes,
      timeoutMs,
    });
  } catch {
    // The closed transcript below is the only evidence retained by the gate.
  }
  runnerRecord(records, id, expected, runner);
}

function syntheticCleanupExecutor(
  outcome: "success" | "timed-out" | "output-limit",
): SignedReleaseCommandExecutor & {
  readonly transcript: SignedReleaseCommandRunner["transcript"];
} {
  const runner = new SignedReleaseCommandRunner();
  return {
    transcript: runner.transcript,
    run(_program, _arguments_, options) {
      if (outcome === "success")
        return runner.run(process.execPath, ["-e", "process.exit(0)"], options);
      const code =
        outcome === "timed-out"
          ? "setTimeout(() => {}, 5_000)"
          : "process.stdout.write('x'.repeat(4096))";
      return runner.run(process.execPath, ["-e", code], {
        ...options,
        maxOutputBytes: outcome === "output-limit" ? 128 : options.maxOutputBytes,
        timeoutMs: outcome === "timed-out" ? 25 : options.timeoutMs,
      });
    },
  };
}

async function runCleanupCase(
  records: ReleaseSecurityMatrixRecord[],
  id: string,
  executor: SignedReleaseCommandExecutor & {
    readonly transcript?: SignedReleaseCommandRunner["transcript"];
  },
  cancellation: boolean,
): Promise<void> {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-release-security-cleanup-"));
  const scratchRoot = path.join(temporary.path, "mish-signed-release-matrix");
  mkdirSync(scratchRoot, { mode: 0o700 });
  writeFileSync(path.join(scratchRoot, "developer-id.p12"), "synthetic certificate\n", {
    mode: 0o600,
  });
  writeFileSync(path.join(scratchRoot, "notary-api-key.p8"), "synthetic private key\n", {
    mode: 0o600,
  });
  writeFileSync(path.join(scratchRoot, "signing.keychain-db"), "synthetic keychain\n", {
    mode: 0o600,
  });
  const previousRunnerTemp = process.env.RUNNER_TEMP;
  process.env.RUNNER_TEMP = temporary.path;
  let terminalObserved = "accepted";
  try {
    const operation = () => {
      if (cancellation) {
        const error = new Error("synthetic cancellation");
        error.name = "AbortError";
        throw error;
      }
      return "done";
    };
    await withGuaranteedCleanup(operation, () => cleanupSigningMaterials(scratchRoot, executor));
  } catch (error) {
    terminalObserved =
      cancellation && error instanceof Error && error.name === "AbortError"
        ? "cancelled"
        : "cleanup-failed";
  } finally {
    if (previousRunnerTemp === undefined) delete process.env.RUNNER_TEMP;
    else process.env.RUNNER_TEMP = previousRunnerTemp;
  }
  invariant(!existsSync(scratchRoot), `${id} left synthetic signing material behind.`);
  const expected = cancellation
    ? "cancelled"
    : id === "runner-cleanup-timeout"
      ? "timed-out"
      : "output-limit";
  const cleanupTranscript = executor.transcript?.at(-1);
  if (!cancellation && cleanupTranscript) {
    invariant(
      cleanupTranscript.outcome === expected,
      `${id} observed ${cleanupTranscript.outcome}, expected ${expected}.`,
    );
  }
  invariant(
    cancellation ? terminalObserved === expected : terminalObserved === "cleanup-failed",
    `${id} observed ${terminalObserved}, expected cleanup-failed terminal cleanup.`,
  );
  records.push({
    contract: "bounded-runner",
    expected,
    id,
    observed: cancellation ? terminalObserved : (cleanupTranscript?.outcome ?? "cleanup-failed"),
    source: "matrix",
    status: "cleaned",
  });
}

async function runRunnerMatrix(records: ReleaseSecurityMatrixRecord[]): Promise<void> {
  runRunnerFailureCase(
    records,
    "runner-command-failure",
    process.execPath,
    ["-e", "process.exit(7)"],
    "failed",
    5_000,
    1_024,
  );
  runRunnerFailureCase(
    records,
    "runner-spawn-failure",
    path.join(tmpdir(), "mish-no-such-release-command"),
    [],
    "failed",
    5_000,
    1_024,
  );
  await runCleanupCase(
    records,
    "runner-cancellation-cleanup",
    syntheticCleanupExecutor("success"),
    true,
  );
  await runCleanupCase(
    records,
    "runner-cleanup-timeout",
    syntheticCleanupExecutor("timed-out"),
    false,
  );
  await runCleanupCase(
    records,
    "runner-cleanup-output-limit",
    syntheticCleanupExecutor("output-limit"),
    false,
  );
}

function assertExistingCoverage(): ReleaseSecurityMatrixRecord[] {
  const packageJson = JSON.parse(
    readFileSync(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as {
    scripts?: Record<string, string>;
  };
  const script = packageJson.scripts?.["test:scripts"] ?? "";
  invariant(
    packageJson.scripts?.["check:release:security"] ===
      "node scripts/release-security-adversarial.ts",
    "The release security gate command is not registered in package scripts.",
  );
  invariant(
    script.includes("release-security-adversarial.test.ts"),
    "The release security gate test is not in test:unit.",
  );
  const requiredFiles = new Set(existingCoverage.map(([, , source]) => source));
  for (const file of requiredFiles) {
    invariant(script.includes(file), `Release adversarial coverage is not in test:unit: ${file}.`);
  }
  return existingCoverage.map(([contract, id, source]) => ({
    contract,
    expected: "covered",
    id,
    observed: "covered",
    source: "existing",
    status: "covered",
  }));
}

function assertGateReport(report: ReleaseSecurityGateReport): void {
  invariant(report.schemaVersion === 1, "Release security matrix schema is unsupported.");
  invariant(
    report.records.length === existingCoverage.length + dynamicScenarioIds.length,
    "Release security matrix is incomplete.",
  );
  const ids = report.records.map(({ id }) => id);
  invariant(
    new Set(ids).size === ids.length,
    "Release security matrix contains duplicate scenario IDs.",
  );
  for (const id of dynamicScenarioIds)
    invariant(ids.includes(id), `Release security matrix omits ${id}.`);
  invariant(
    report.transcript.eventCount <= maxTranscriptEvents,
    "Release security transcript exceeded its event bound.",
  );
  const serialized = JSON.stringify(report);
  invariant(
    Buffer.byteLength(serialized, "utf8") <= maxTranscriptBytes,
    "Release security transcript exceeded its byte bound.",
  );
  invariant(
    !/synthetic (?:private key|certificate)|\/tmp|process\.execPath/u.test(serialized),
    "Release security transcript leaked private fixture data.",
  );
}

export async function runReleaseSecurityGate(): Promise<ReleaseSecurityGateReport> {
  const records = assertExistingCoverage();
  runPathContainmentMatrix(records);
  runProvenanceMatrix(records);
  await runRunnerMatrix(records);
  const report: ReleaseSecurityGateReport = {
    records,
    schemaVersion: 1,
    transcript: {
      eventCount: records.filter(({ source }) => source === "matrix").length,
      maxBytes: maxTranscriptBytes,
      maxEvents: maxTranscriptEvents,
    },
  };
  assertGateReport(report);
  return report;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  const report = await runReleaseSecurityGate();
  process.stdout.write(`${JSON.stringify(report)}\n`);
}
