import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const fullSha = /^[0-9a-f]{40}$/u;
const sha256Digest = /^[0-9a-f]{64}$/u;
const numericId = /^[1-9][0-9]*$/u;
const safeRelativePath = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._+/-]+$/u;
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const maximumCandidateEntries = 256;
const maximumCandidateDepth = 8;
const maximumManifestBytes = 1024 * 1024;

export interface TrustedReleasePolicy {
  schemaVersion: number;
  activation: {
    enabled: boolean;
    reason: string;
  };
  repository: {
    name: string;
    id: string;
    ownerId: string;
    defaultBranch: string;
    trustedRef: string;
  };
  dispatch: {
    event: string;
    actorIds: string[];
    requireTriggeringActorMatch: boolean;
    workflowPath: string;
    workflowRef: string;
    toolingRevision: string;
    sourceRevision: string;
  };
  untrusted: {
    allowedEvents: string[];
    runnerLabels: string[];
    permissions: Record<string, string>;
    allowSecrets: boolean;
    allowOidc: boolean;
    allowArtifactUpload: boolean;
    allowSelfHosted: boolean;
    allowReusableWorkflowCalls: boolean;
  };
  protected: {
    jobKinds: string[];
    runnerLabels: string[];
    allowSelfHosted: boolean;
    environments: Record<
      string,
      {
        requiredReviewerIds: string[];
        preventSelfReview: boolean;
        allowAdminBypass: boolean;
        branches: string[];
      }
    >;
    requiredPredecessors: string[];
    artifactRetentionDays: number;
  };
  oidc: {
    enabled: boolean;
    requiredClaims: string[];
    subjectMustBindEnvironment: boolean;
    subjectMustBindTrustedWorkflow: boolean;
  };
  actions: {
    requireFullCommitSha: boolean;
    allowed: Record<string, string>;
    allowedReusableWorkflows: string[];
  };
  artifact: {
    schemaVersion: number;
    manifestName: string;
    digest: string;
    requiredProtectedRoles: string[];
    rejectSymlinks: boolean;
    rejectUnexpectedFiles: boolean;
    requireImmutableArtifactId: boolean;
  };
  codeowners: {
    owner: string;
    requiredPaths: string[];
  };
}

export interface DispatchIdentity {
  repository: string;
  repositoryId: string;
  repositoryOwnerId: string;
  eventName: string;
  ref: string;
  actorId: string;
  triggeringActorId: string;
  workflowRef: string;
  workflowSha: string;
  toolingSha: string;
  sourceSha: string;
  mainSha: string;
  sourceIsAncestor: boolean;
  runId: string;
  runAttempt: string;
}

export interface ProtectedRequest extends DispatchIdentity {
  jobKind: string;
  environment: string;
  runnerLabel: string;
  callerWorkflowRef: string | null;
  candidateArtifactId: string;
  candidateBundleSha256: string;
}

export interface CandidateFile {
  path: string;
  role: string;
  size: number;
  sha256: string;
}

export interface CandidateManifest {
  schemaVersion: number;
  kind: string;
  artifactName: string;
  identity: DispatchIdentity;
  files: CandidateFile[];
  bundleSha256: string;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

function canonicalBundle(files: CandidateFile[]): string {
  return files.map((file) => `${file.path}\0${file.role}\0${file.size}\0${file.sha256}\n`).join("");
}

function option(arguments_: string[], name: string): string {
  const index = arguments_.indexOf(name);
  invariant(index >= 0, `Missing required option ${name}.`);
  const value = arguments_[index + 1];
  invariant(value && !value.startsWith("--"), `Option ${name} requires a value.`);
  return value;
}

function booleanOption(arguments_: string[], name: string): boolean {
  const value = option(arguments_, name);
  invariant(value === "true" || value === "false", `${name} must be true or false.`);
  return value === "true";
}

function normalizeRelativePath(root: string, absolute: string): string {
  const relative = path.relative(root, absolute).split(path.sep).join("/");
  invariant(safeRelativePath.test(relative), `Candidate path is unsafe: ${relative}`);
  return relative;
}

function filesUnder(root: string, directory = root, depth = 0, state = { entries: 0 }): string[] {
  invariant(depth <= maximumCandidateDepth, "Candidate directory nesting is too deep.");
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const absolute = path.join(directory, entry.name);
      state.entries += 1;
      invariant(state.entries <= maximumCandidateEntries, "Candidate contains too many entries.");
      invariant(!entry.isSymbolicLink(), `Candidate contains a symlink: ${absolute}`);
      if (entry.isDirectory()) return filesUnder(root, absolute, depth + 1, state);
      invariant(entry.isFile(), `Candidate contains an unsupported entry: ${absolute}`);
      invariant(lstatSync(absolute).nlink === 1, `Candidate contains a hard link: ${absolute}`);
      return [absolute];
    })
    .sort((left, right) =>
      normalizeRelativePath(root, left).localeCompare(normalizeRelativePath(root, right)),
    );
}

function collectCandidateFiles(
  directory: string,
  manifestName: string,
  roles: Record<string, string> = {},
): CandidateFile[] {
  const files = filesUnder(directory)
    .map((absolute): CandidateFile | null => {
      const relative = normalizeRelativePath(directory, absolute);
      if (relative === manifestName) return null;
      const content = readFileSync(absolute);
      return {
        path: relative,
        role: roles[relative] ?? "payload",
        size: content.byteLength,
        sha256: sha256(content),
      };
    })
    .filter((file): file is CandidateFile => file !== null);
  const foldedPaths = files.map((file) => file.path.toLowerCase());
  invariant(
    new Set(foldedPaths).size === foldedPaths.length,
    "Candidate contains case-colliding paths.",
  );
  return files;
}

function assertDispatchShape(identity: DispatchIdentity): void {
  for (const [name, value] of [
    ["workflow SHA", identity.workflowSha],
    ["tooling SHA", identity.toolingSha],
    ["source SHA", identity.sourceSha],
    ["main SHA", identity.mainSha],
  ] as const) {
    invariant(fullSha.test(value), `Trusted ${name} must be one full lowercase commit SHA.`);
  }
  invariant(numericId.test(identity.runId), "Trusted run ID must be numeric.");
  invariant(numericId.test(identity.runAttempt), "Trusted run attempt must be numeric.");
}

export function readTrustedReleasePolicy(root = repositoryRoot): TrustedReleasePolicy {
  return JSON.parse(
    readFileSync(path.join(root, ".github/trusted-release-policy.json"), "utf8"),
  ) as TrustedReleasePolicy;
}

export function validateDispatchIdentity(
  policy: TrustedReleasePolicy,
  identity: DispatchIdentity,
): string[] {
  const errors: string[] = [];
  const expect = (condition: boolean, message: string) => {
    if (!condition) errors.push(message);
  };

  try {
    assertDispatchShape(identity);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  expect(identity.repository === policy.repository.name, "repository identity mismatch");
  expect(identity.repositoryId === policy.repository.id, "repository ID mismatch");
  expect(identity.repositoryOwnerId === policy.repository.ownerId, "repository owner ID mismatch");
  expect(identity.eventName === policy.dispatch.event, "untrusted event");
  expect(identity.ref === policy.repository.trustedRef, "untrusted branch, tag, or merge ref");
  expect(policy.dispatch.actorIds.includes(identity.actorId), "untrusted actor");
  if (policy.dispatch.requireTriggeringActorMatch) {
    expect(identity.triggeringActorId === identity.actorId, "triggering actor mismatch");
  }
  expect(identity.workflowRef === policy.dispatch.workflowRef, "untrusted workflow ref");
  expect(identity.workflowSha === identity.mainSha, "workflow SHA is not frozen main");
  expect(identity.toolingSha === identity.workflowSha, "tooling SHA differs from workflow SHA");
  expect(identity.sourceIsAncestor, "source SHA is not an ancestor of frozen main");
  return errors;
}

export function validateProtectedRequest(
  policy: TrustedReleasePolicy,
  request: ProtectedRequest,
): string[] {
  const errors = validateDispatchIdentity(policy, request);
  const expect = (condition: boolean, message: string) => {
    if (!condition) errors.push(message);
  };

  expect(policy.activation.enabled, "protected execution is disabled");
  expect(policy.protected.jobKinds.includes(request.jobKind), "unsupported protected job kind");
  expect(
    Object.hasOwn(policy.protected.environments, request.environment),
    "untrusted protected environment",
  );
  expect(policy.protected.runnerLabels.includes(request.runnerLabel), "untrusted protected runner");
  expect(
    policy.protected.allowSelfHosted || request.runnerLabel !== "self-hosted",
    "self-hosted protected runner is forbidden",
  );
  expect(request.callerWorkflowRef === null, "reusable workflow caller is not trusted");
  expect(numericId.test(request.candidateArtifactId), "immutable artifact ID is invalid");
  expect(sha256Digest.test(request.candidateBundleSha256), "candidate bundle digest is invalid");
  return errors;
}

export function validateProtectedCandidate(
  policy: TrustedReleasePolicy,
  request: ProtectedRequest,
  manifest: CandidateManifest,
): string[] {
  const errors = validateProtectedRequest(policy, request);
  const expect = (condition: boolean, message: string) => {
    if (!condition) errors.push(message);
  };
  expect(
    request.candidateBundleSha256 === manifest.bundleSha256,
    "protected request and candidate bundle digest differ",
  );
  expect(
    JSON.stringify(manifest.identity) ===
      JSON.stringify({
        actorId: request.actorId,
        eventName: request.eventName,
        mainSha: request.mainSha,
        ref: request.ref,
        repository: request.repository,
        repositoryId: request.repositoryId,
        repositoryOwnerId: request.repositoryOwnerId,
        runAttempt: request.runAttempt,
        runId: request.runId,
        sourceIsAncestor: request.sourceIsAncestor,
        sourceSha: request.sourceSha,
        toolingSha: request.toolingSha,
        triggeringActorId: request.triggeringActorId,
        workflowRef: request.workflowRef,
        workflowSha: request.workflowSha,
      }),
    "protected request and candidate provenance identity differ",
  );
  for (const role of policy.artifact.requiredProtectedRoles) {
    expect(
      manifest.files.filter((file) => file.role === role).length === 1,
      `protected candidate must contain exactly one ${role} file`,
    );
  }
  return errors;
}

export function createCandidateManifest(options: {
  directory: string;
  kind: string;
  artifactName: string;
  identity: DispatchIdentity;
  roles?: Record<string, string>;
  policy?: TrustedReleasePolicy;
}): CandidateManifest {
  const policy = options.policy ?? readTrustedReleasePolicy();
  assertDispatchShape(options.identity);
  const directory = path.resolve(options.directory);
  invariant(
    lstatSync(directory).isDirectory(),
    "Candidate manifest input must be a real directory.",
  );
  const files = collectCandidateFiles(directory, policy.artifact.manifestName, options.roles);
  invariant(files.length > 0, "Candidate manifest cannot describe an empty artifact.");
  const manifest: CandidateManifest = {
    schemaVersion: policy.artifact.schemaVersion,
    kind: options.kind,
    artifactName: options.artifactName,
    identity: options.identity,
    files,
    bundleSha256: sha256(canonicalBundle(files)),
  };
  writeFileSync(
    path.join(directory, policy.artifact.manifestName),
    `${JSON.stringify(manifest, null, 2)}\n`,
    { mode: 0o444 },
  );
  return manifest;
}

export function verifyCandidateManifest(options: {
  directory: string;
  expectedIdentity: DispatchIdentity;
  expectedArtifactName: string;
  expectedArtifactId: string;
  requiredRoles?: string[];
  policy?: TrustedReleasePolicy;
}): CandidateManifest {
  const policy = options.policy ?? readTrustedReleasePolicy();
  invariant(
    numericId.test(options.expectedArtifactId),
    "Candidate verification requires an immutable numeric artifact ID.",
  );
  const directory = path.resolve(options.directory);
  const manifestPath = path.join(directory, policy.artifact.manifestName);
  const manifestMetadata = lstatSync(manifestPath);
  invariant(
    manifestMetadata.isFile() && !manifestMetadata.isSymbolicLink() && manifestMetadata.nlink === 1,
    "Candidate manifest must be one regular unlinked file.",
  );
  invariant(
    manifestMetadata.size <= maximumManifestBytes,
    "Candidate manifest exceeds its size limit.",
  );
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as CandidateManifest;
  invariant(
    manifest.schemaVersion === policy.artifact.schemaVersion,
    "Candidate manifest schema is unsupported.",
  );
  invariant(
    manifest.artifactName === options.expectedArtifactName,
    "Candidate artifact name changed.",
  );
  invariant(
    JSON.stringify(manifest.identity) === JSON.stringify(options.expectedIdentity),
    "Candidate source, workflow, tooling, actor, or run identity changed.",
  );
  const observedFiles = collectCandidateFiles(
    directory,
    policy.artifact.manifestName,
    Object.fromEntries(manifest.files.map((file) => [file.path, file.role])),
  );
  invariant(
    JSON.stringify(observedFiles) === JSON.stringify(manifest.files),
    "Candidate files, sizes, roles, or digests changed.",
  );
  invariant(
    sha256(canonicalBundle(observedFiles)) === manifest.bundleSha256 &&
      sha256Digest.test(manifest.bundleSha256),
    "Candidate bundle digest changed.",
  );
  for (const role of options.requiredRoles ?? []) {
    invariant(
      manifest.files.filter((file) => file.role === role).length === 1,
      `Candidate must contain exactly one ${role} file.`,
    );
  }
  return manifest;
}

function identityFromArguments(arguments_: string[]): DispatchIdentity {
  return {
    actorId: option(arguments_, "--actor-id"),
    eventName: option(arguments_, "--event-name"),
    mainSha: option(arguments_, "--main-sha"),
    ref: option(arguments_, "--ref"),
    repository: option(arguments_, "--repository"),
    repositoryId: option(arguments_, "--repository-id"),
    repositoryOwnerId: option(arguments_, "--repository-owner-id"),
    runAttempt: option(arguments_, "--run-attempt"),
    runId: option(arguments_, "--run-id"),
    sourceIsAncestor: booleanOption(arguments_, "--source-is-ancestor"),
    sourceSha: option(arguments_, "--source-sha"),
    toolingSha: option(arguments_, "--tooling-sha"),
    triggeringActorId: option(arguments_, "--triggering-actor-id"),
    workflowRef: option(arguments_, "--workflow-ref"),
    workflowSha: option(arguments_, "--workflow-sha"),
  };
}

function gitSha(reference: string): string {
  return execFileSync("git", ["rev-parse", reference], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

function isAncestor(ancestor: string, descendant: string): boolean {
  return (
    spawnSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd: repositoryRoot,
      stdio: "ignore",
    }).status === 0
  );
}

export function runTrustedReleaseAdversarialFixture(): Record<string, string> {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-trusted-release-fixture-"));
  const policy = readTrustedReleasePolicy();
  const activePolicy = structuredClone(policy);
  activePolicy.activation.enabled = true;
  const identity: DispatchIdentity = {
    actorId: policy.dispatch.actorIds[0],
    eventName: policy.dispatch.event,
    mainSha: "1".repeat(40),
    ref: policy.repository.trustedRef,
    repository: policy.repository.name,
    repositoryId: policy.repository.id,
    repositoryOwnerId: policy.repository.ownerId,
    runAttempt: "1",
    runId: "123",
    sourceIsAncestor: true,
    sourceSha: "2".repeat(40),
    toolingSha: "1".repeat(40),
    triggeringActorId: policy.dispatch.actorIds[0],
    workflowRef: policy.dispatch.workflowRef,
    workflowSha: "1".repeat(40),
  };
  const failures: Record<string, string> = {};
  const reject = (name: string, mutate: (request: ProtectedRequest) => void) => {
    const request: ProtectedRequest = {
      ...identity,
      callerWorkflowRef: null,
      candidateArtifactId: "456",
      candidateBundleSha256: "3".repeat(64),
      environment: "macos-developer-id",
      jobKind: "sign",
      runnerLabel: "macos-15",
    };
    mutate(request);
    const errors = validateProtectedRequest(activePolicy, request);
    invariant(errors.length > 0, `${name} adversarial request unexpectedly passed.`);
    failures[name] = errors.join("; ");
  };

  reject("fork-repository", (request) => {
    request.repository = "attacker/mish";
  });
  reject("pull-request-event", (request) => {
    request.eventName = "pull_request";
  });
  reject("merge-ref", (request) => {
    request.ref = "refs/pull/270/merge";
  });
  reject("untrusted-actor", (request) => {
    request.actorId = "999";
  });
  reject("workflow-revision", (request) => {
    request.workflowRef =
      "Asuka109/mish/.github/workflows/stage-macos-alpha-release.yml@refs/heads/feature";
  });
  reject("tooling-revision", (request) => {
    request.toolingSha = "4".repeat(40);
  });
  reject("source-ancestry", (request) => {
    request.sourceIsAncestor = false;
  });
  reject("self-hosted-runner", (request) => {
    request.runnerLabel = "self-hosted";
  });
  reject("reusable-workflow", (request) => {
    request.callerWorkflowRef = "attacker/repo/.github/workflows/release.yml@refs/heads/main";
  });
  const disabledErrors = validateProtectedRequest(policy, {
    ...identity,
    callerWorkflowRef: null,
    candidateArtifactId: "456",
    candidateBundleSha256: "3".repeat(64),
    environment: "macos-developer-id",
    jobKind: "sign",
    runnerLabel: "macos-15",
  });
  invariant(
    disabledErrors.includes("protected execution is disabled"),
    "Current policy must reject every protected execution.",
  );
  failures["disabled-boundary"] = disabledErrors.join("; ");

  const candidate = path.join(temporary.path, "candidate");
  mkdirSync(candidate, { recursive: true });
  writeFileSync(path.join(candidate, "Mish.app.tar"), "fixture unsigned app\n");
  writeFileSync(path.join(candidate, "macos-sbom.spdx.json"), '{"fixture":true}\n');
  writeFileSync(path.join(candidate, "build-provenance.json"), '{"fixture":true}\n');
  const roles = {
    "Mish.app.tar": "unsigned-application",
    "build-provenance.json": "build-provenance",
    "macos-sbom.spdx.json": "sbom",
  };
  const manifest = createCandidateManifest({
    artifactName: "fixture-candidate",
    directory: candidate,
    identity,
    kind: "unsigned-macos-candidate",
    policy: activePolicy,
    roles,
  });
  verifyCandidateManifest({
    directory: candidate,
    expectedArtifactId: "456",
    expectedArtifactName: "fixture-candidate",
    expectedIdentity: identity,
    policy: activePolicy,
    requiredRoles: activePolicy.artifact.requiredProtectedRoles,
  });
  writeFileSync(path.join(candidate, "Mish.app.tar"), "substituted app\n");
  try {
    verifyCandidateManifest({
      directory: candidate,
      expectedArtifactId: "456",
      expectedArtifactName: "fixture-candidate",
      expectedIdentity: identity,
      policy: activePolicy,
      requiredRoles: activePolicy.artifact.requiredProtectedRoles,
    });
    throw new Error("artifact substitution fixture unexpectedly passed.");
  } catch (error) {
    failures["artifact-substitution"] = error instanceof Error ? error.message : String(error);
  }

  return {
    ...failures,
    fixtureBundleSha256: manifest.bundleSha256,
  };
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  const policy = readTrustedReleasePolicy();
  if (command === "verify-dispatch") {
    const sourceSha = option(arguments_, "--source-sha");
    const mainSha = gitSha("HEAD");
    const identity = {
      ...identityFromArguments([
        ...arguments_,
        "--main-sha",
        mainSha,
        "--source-is-ancestor",
        String(isAncestor(sourceSha, mainSha)),
      ]),
      mainSha,
      sourceIsAncestor: isAncestor(sourceSha, mainSha),
    };
    const errors = validateDispatchIdentity(policy, identity);
    invariant(errors.length === 0, `Trusted dispatch rejected: ${errors.join("; ")}`);
    console.log(JSON.stringify(identity, null, 2));
    return;
  }
  if (command === "create-manifest") {
    const manifest = createCandidateManifest({
      artifactName: option(arguments_, "--artifact-name"),
      directory: option(arguments_, "--directory"),
      identity: identityFromArguments(arguments_),
      kind: option(arguments_, "--kind"),
      policy,
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (command === "verify-manifest") {
    const manifest = verifyCandidateManifest({
      directory: option(arguments_, "--directory"),
      expectedArtifactId: option(arguments_, "--artifact-id"),
      expectedArtifactName: option(arguments_, "--artifact-name"),
      expectedIdentity: identityFromArguments(arguments_),
      policy,
    });
    console.log(JSON.stringify(manifest, null, 2));
    return;
  }
  if (command === "fixture") {
    console.log(JSON.stringify(runTrustedReleaseAdversarialFixture(), null, 2));
    return;
  }
  throw new Error(
    "Usage: trusted-release-policy.ts <verify-dispatch|create-manifest|verify-manifest|fixture> [options]",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
