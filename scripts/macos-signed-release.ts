import { createHash, randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import {
  GitHubApiError,
  isGitHubConflict,
  parsePrereleaseVersion,
  readDesktopVersionAt,
  readPinnedMihomoVersion,
} from "./macos-alpha-release.ts";
import {
  appleCredentialVariables,
  parseDeveloperIdApplicationIdentity,
  protectedReleaseBoundary,
  signedDirectApplicationIdentifier,
  signedDirectMihomoExecutable,
  signedDirectMihomoIdentifier,
  signedDirectProfile,
} from "./macos-signed-direct-policy.ts";
import { runUpdaterContractFixture } from "./macos-updater-contract.ts";
import {
  assertPrivateNoFollowFile,
  assertPrivateNoFollowRoot,
  readContainedReleaseFile,
  ReleasePathError,
  writeContainedReleaseFile,
} from "./release-path-containment.ts";

const apiVersion = "2026-03-10";
const architecture = "arm64";
const fullSha = /^[0-9a-f]{40}$/u;
const repositoryName = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const attestationUrl = /^https:\/\/github\.com\/[^/]+\/[^/]+\/attestations\/\d+$/u;
const safeDetail = /^[\u0020-\u007e]{1,300}$/u;
const checksumLine = /^([0-9a-f]{64})  ([A-Za-z0-9.+-]+)$/u;

export const signedReleaseEnvironment = protectedReleaseBoundary;
export const signedReleaseEvidenceName = "signed-release-evidence.json";
export const signedReleaseSbomName = "macos-sbom.spdx.json";
export const signedReleaseChecksumName = "SHA256SUMS.txt";
export const signedReleaseProvenanceBundleName = "provenance-attestation.sigstore.json";
export const signedReleaseSbomBundleName = "sbom-attestation.sigstore.json";

export const signedReleaseStages = [
  "trusted-boundary",
  "credentials-complete",
  "keychain-created",
  "certificate-imported",
  "identity-verified",
  "bundle-built",
  "bundle-verified",
  "distribution-created",
  "notary-submitted",
  "notary-accepted",
  "ticket-stapled",
  "ticket-validated",
  "codesign-assessed",
  "distribution-assessed",
  "sbom-generated",
  "cleanup-confirmed",
  "provenance-generated",
  "artifact-identity-confirmed",
] as const;

export type SignedReleaseStage = (typeof signedReleaseStages)[number];

export type SignedReleaseIdentity = {
  architecture: typeof architecture;
  dmgName: string;
  environment: typeof signedReleaseEnvironment;
  profile: typeof signedDirectProfile;
  sourceSha: string;
  tag: string;
  version: string;
};

export type SignedReleaseStageEvidence = {
  detail: string;
  stage: SignedReleaseStage;
  status: "confirmed";
};

export type SignedReleaseArtifactIdentity = {
  dmgSha256: string;
  evidenceSchemaVersion: 1;
  provenanceBundleSha256: string;
  sbomBundleSha256: string;
  sbomSha256: string;
};

export type SignedReleaseEvidence = {
  artifactIdentity?: SignedReleaseArtifactIdentity;
  attestations?: {
    provenance: { id: string; url: string };
    sbom: { id: string; url: string };
  };
  claims: {
    developerIdTrust: "observed-by-protected-workflow";
    distributionAssessment: "observed-by-protected-workflow";
    notarization: "observed-by-protected-workflow";
  };
  identity: SignedReleaseIdentity;
  notary: {
    issueCount: number;
    status: "Accepted";
    submissionId: string;
  };
  schemaVersion: 1;
  signing: {
    identity: string;
    teamIdentifier: string;
  };
  stages: SignedReleaseStageEvidence[];
};

export type SignedReleaseCredentials = {
  certificateBase64: string;
  certificatePassword: string;
  notaryApiIssuerId: string;
  notaryApiKeyId: string;
  notaryApiPrivateKey: string;
  signingIdentity: string;
};

export type SignedReleasePlanningBoundary = {
  contentsPermission: string;
  dryRun: boolean;
  environment: string;
  eventName: string;
  profile: string;
  ref: string;
  repository: string;
  sourceSha: string;
  version: string;
};

export type SignedReleaseRemoteAsset = {
  digest: string | null;
  id: number;
  name: string;
  size: number;
  state: string;
};

export type SignedReleaseRemoteRelease = {
  assets: SignedReleaseRemoteAsset[];
  draft: boolean;
  htmlUrl: string;
  id: number;
  name: string;
  prerelease: boolean;
  tagName: string;
  targetCommitish: string;
  uploadUrl: string;
};

export type SignedReleaseRemoteState = {
  release: SignedReleaseRemoteRelease | null;
  tagCommit: string | null;
};

export type SignedReleaseAsset = {
  content: Buffer;
  contentType: string;
  digest: string;
  name: string;
  path: string;
  size: number;
};

export type SignedReleaseStagingPlan = {
  action: "already-staged" | "create-release" | "create-tag-and-release" | "resume-release";
  createRelease: boolean;
  createTag: boolean;
  matchingAssets: string[];
  missingAssets: string[];
};

export type SignedReleaseRequest = {
  assets?: SignedReleaseAsset[];
  candidateUploaded: boolean;
  sourceSha: string;
  version: string;
};

export type SignedReleaseClient = {
  createRelease(request: SignedReleaseRequest): Promise<void>;
  createTag(tag: string, sourceSha: string): Promise<void>;
  getState(request: SignedReleaseRequest): Promise<SignedReleaseRemoteState>;
  uploadAsset(release: SignedReleaseRemoteRelease, asset: SignedReleaseAsset): Promise<void>;
};

type SigningMaterialPaths = {
  certificate: string;
  keychain: string;
  notaryKey: string;
  root: string;
  searchList: string;
};

type GitHubReleaseResponse = {
  assets?: Array<{
    digest?: string | null;
    id?: number;
    name?: string;
    size?: number;
    state?: string;
  }>;
  draft?: boolean;
  html_url?: string;
  id?: number;
  name?: string;
  prerelease?: boolean;
  tag_name?: string;
  target_commitish?: string;
  upload_url?: string;
};

type GitHubRefResponse = {
  object?: { sha?: string; type?: string };
};

type GitHubTagResponse = {
  object?: { sha?: string; type?: string };
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function sha256(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function sha1(content: Buffer): string {
  return createHash("sha1").update(content).digest("hex");
}

function boundedDetail(value: string): string {
  invariant(safeDetail.test(value), "Signed release evidence detail is not bounded ASCII.");
  return value;
}

function contentType(name: string): string {
  if (name.endsWith(".dmg")) return "application/x-apple-diskimage";
  if (name.endsWith(".json")) return "application/json";
  return "text/plain";
}

function expectedReleaseName(tag: string): string {
  return `Mish ${tag} signed-direct`;
}

export function signedReleaseDmgName(version: string): string {
  parsePrereleaseVersion(version);
  return `Mish-${version}-arm64.dmg`;
}

export function signedReleaseAssetNames(version: string): string[] {
  return [
    signedReleaseDmgName(version),
    signedReleaseSbomName,
    signedReleaseEvidenceName,
    signedReleaseProvenanceBundleName,
    signedReleaseSbomBundleName,
    signedReleaseChecksumName,
  ];
}

export function validateSignedReleasePlanningBoundary(
  boundary: SignedReleasePlanningBoundary,
  expectedRepository: string,
): SignedReleaseIdentity {
  invariant(
    boundary.profile === signedDirectProfile,
    "Signed release planning requires the explicit signed-direct profile.",
  );
  invariant(
    boundary.eventName === "workflow_dispatch",
    "Signed releases are trusted only from workflow_dispatch.",
  );
  invariant(
    boundary.ref === "refs/heads/main",
    "Signed releases must be dispatched from refs/heads/main.",
  );
  invariant(
    repositoryName.test(expectedRepository) && boundary.repository === expectedRepository,
    "Signed releases must run in the expected repository, not a fork.",
  );
  invariant(
    boundary.environment === signedReleaseEnvironment,
    `Signed releases require the protected ${signedReleaseEnvironment} Environment.`,
  );
  invariant(
    boundary.contentsPermission === "read",
    "Protected signing must run with contents: read before the Draft write boundary.",
  );
  invariant(fullSha.test(boundary.sourceSha), "Signed releases require one full source SHA.");
  const parsed = parsePrereleaseVersion(boundary.version);
  return {
    architecture,
    dmgName: signedReleaseDmgName(parsed.version),
    environment: signedReleaseEnvironment,
    profile: signedDirectProfile,
    sourceSha: boundary.sourceSha,
    tag: parsed.tag,
    version: parsed.version,
  };
}

export function validateCompleteSignedReleaseCredentials(credentials: SignedReleaseCredentials): {
  identity: string;
  teamIdentifier: string;
} {
  const values = Object.entries(credentials);
  invariant(
    values.every(([, value]) => value.length > 0),
    "The protected signed-release credential boundary is incomplete.",
  );
  invariant(
    /^[A-Za-z0-9+/]+={0,2}$/u.test(credentials.certificateBase64) &&
      Buffer.from(credentials.certificateBase64, "base64").length > 0,
    "The protected certificate is not valid base64.",
  );
  invariant(
    /^[A-Z0-9]{6,32}$/u.test(credentials.notaryApiKeyId),
    "The notary API key identifier is invalid.",
  );
  invariant(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
      credentials.notaryApiIssuerId,
    ),
    "The notary API issuer identifier is invalid.",
  );
  invariant(
    /^-----BEGIN PRIVATE KEY-----[\s\S]+-----END PRIVATE KEY-----\n?$/u.test(
      credentials.notaryApiPrivateKey,
    ),
    "The notary API private key is invalid.",
  );
  return parseDeveloperIdApplicationIdentity(credentials.signingIdentity);
}

export function validateSelectedSignedSource(sourceSha: string, cwd = process.cwd()): void {
  invariant(fullSha.test(sourceSha), "Signed source validation requires one full source SHA.");
  readDesktopVersionAt(sourceSha, cwd);
  const source = execFileSync("git", ["show", `${sourceSha}:package.json`], {
    cwd,
    encoding: "utf8",
  });
  const packageJson = JSON.parse(source) as { scripts?: Record<string, unknown> };
  invariant(
    packageJson.scripts?.["desktop:bundle:signed-direct:macos"] ===
      "node scripts/build-macos-bundle.ts --profile signed-direct",
    "Selected source does not preserve the signed-direct System Proxy-only build contract.",
  );
}

export class SignedReleaseRecorder {
  readonly identity: SignedReleaseIdentity;
  readonly stages: SignedReleaseStageEvidence[] = [];

  constructor(identity: SignedReleaseIdentity) {
    this.identity = identity;
  }

  confirm(stage: SignedReleaseStage, detail: string): void {
    const expected = signedReleaseStages[this.stages.length];
    invariant(
      stage === expected,
      `Signed release stage order drift: expected ${expected ?? "no further stage"}, received ${stage}.`,
    );
    this.stages.push({ detail: boundedDetail(detail), stage, status: "confirmed" });
  }
}

export function validateSignedReleaseEvidence(
  evidence: SignedReleaseEvidence,
  requireFinal = true,
): void {
  invariant(evidence.schemaVersion === 1, "Signed release evidence schema is unsupported.");
  invariant(
    JSON.stringify(evidence.claims) ===
      JSON.stringify({
        developerIdTrust: "observed-by-protected-workflow",
        distributionAssessment: "observed-by-protected-workflow",
        notarization: "observed-by-protected-workflow",
      }),
    "Signed release evidence must distinguish observed protected results from configuration.",
  );
  const expectedIdentity = validateSignedReleasePlanningBoundary(
    {
      contentsPermission: "read",
      dryRun: false,
      environment: evidence.identity.environment,
      eventName: "workflow_dispatch",
      profile: evidence.identity.profile,
      ref: "refs/heads/main",
      repository: "fixture/repository",
      sourceSha: evidence.identity.sourceSha,
      version: evidence.identity.version,
    },
    "fixture/repository",
  );
  invariant(
    JSON.stringify(evidence.identity) === JSON.stringify(expectedIdentity),
    "Signed release identity drifted across evidence stages.",
  );
  const observedStages = evidence.stages.map(({ stage }) => stage);
  const expectedStages = signedReleaseStages.slice(0, observedStages.length);
  invariant(
    JSON.stringify(observedStages) === JSON.stringify(expectedStages),
    "Signed release evidence stages are missing, duplicated, or out of order.",
  );
  invariant(
    evidence.stages.every(
      ({ detail, status }) => status === "confirmed" && safeDetail.test(detail),
    ),
    "Signed release evidence contains an unconfirmed or unbounded stage.",
  );
  invariant(
    evidence.notary.status === "Accepted" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(
        evidence.notary.submissionId,
      ) &&
      evidence.notary.issueCount === 0,
    "Signed release evidence does not contain an accepted, issue-free terminal notary result.",
  );
  const parsedIdentity = parseDeveloperIdApplicationIdentity(evidence.signing.identity);
  invariant(
    parsedIdentity.teamIdentifier === evidence.signing.teamIdentifier,
    "Signed release signing identity and team identifier disagree.",
  );
  if (!requireFinal) return;
  invariant(
    observedStages.length === signedReleaseStages.length,
    "Signed release evidence is not complete enough for Draft staging.",
  );
  invariant(evidence.artifactIdentity, "Signed release artifact identity is missing.");
  for (const digest of [
    evidence.artifactIdentity.dmgSha256,
    evidence.artifactIdentity.provenanceBundleSha256,
    evidence.artifactIdentity.sbomBundleSha256,
    evidence.artifactIdentity.sbomSha256,
  ]) {
    invariant(/^[0-9a-f]{64}$/u.test(digest), "Signed release artifact digest is invalid.");
  }
  invariant(
    evidence.artifactIdentity.evidenceSchemaVersion === evidence.schemaVersion,
    "Signed release artifact evidence schema drifted.",
  );
  invariant(
    evidence.attestations &&
      /^\d+$/u.test(evidence.attestations.provenance.id) &&
      /^\d+$/u.test(evidence.attestations.sbom.id) &&
      attestationUrl.test(evidence.attestations.provenance.url) &&
      attestationUrl.test(evidence.attestations.sbom.url),
    "Signed release provenance or SBOM attestation identity is missing.",
  );
}

export function validateAppleNotaryResult(
  submission: { id?: unknown; status?: unknown },
  log: { issues?: unknown; status?: unknown },
): { issueCount: number; status: "Accepted"; submissionId: string } {
  invariant(
    typeof submission.id === "string" &&
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(submission.id),
    "Apple notarization did not return a valid submission identifier.",
  );
  invariant(
    submission.status === "Accepted",
    `Apple notarization failed closed with terminal status ${String(submission.status)}.`,
  );
  const issues = log.issues;
  const issueCount = Array.isArray(issues) ? issues.length : issues == null ? 0 : 1;
  invariant(
    log.status === "Accepted" && issueCount === 0,
    "Apple notarization log is not accepted and issue-free.",
  );
  return { issueCount, status: "Accepted", submissionId: submission.id };
}

export async function withGuaranteedCleanup<T>(
  operation: () => Promise<T> | T,
  cleanup: () => Promise<void> | void,
): Promise<T> {
  try {
    return await operation();
  } finally {
    await cleanup();
  }
}

function signingMaterialPaths(root: string): SigningMaterialPaths {
  const absolute = path.resolve(root);
  const temporaryRoot = path.resolve(process.env.RUNNER_TEMP ?? path.dirname(absolute));
  const relative = path.relative(temporaryRoot, absolute);
  invariant(
    relative &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative) &&
      path.basename(absolute).startsWith("mish-signed-release-"),
    "Signing material cleanup is restricted to one Mish runner-temporary directory.",
  );
  try {
    assertPrivateNoFollowRoot(absolute);
  } catch (error) {
    if (!(error instanceof ReleasePathError) || error.classification !== "missing") throw error;
    assertPrivateNoFollowRoot(path.dirname(absolute));
  }
  return {
    certificate: path.join(absolute, "developer-id.p12"),
    keychain: path.join(absolute, "signing.keychain-db"),
    notaryKey: path.join(absolute, "notary-api-key.p8"),
    root: absolute,
    searchList: path.join(absolute, "original-keychains.json"),
  };
}

function parseSecurityKeychains(source: string): string[] {
  return [...source.matchAll(/"([^"]+)"/gu)].map((match) => match[1]);
}

export function cleanupSigningMaterials(root: string): void {
  const paths = signingMaterialPaths(root);
  if (!existsSync(paths.root)) return;
  let restorationFailed = false;
  if (existsSync(paths.searchList)) {
    try {
      const original = JSON.parse(readFileSync(paths.searchList, "utf8")) as unknown;
      invariant(
        Array.isArray(original) &&
          original.every((entry) => typeof entry === "string" && entry.length > 0),
        "Temporary keychain search list evidence is invalid.",
      );
      const restored = spawnSync("security", ["list-keychains", "-d", "user", "-s", ...original], {
        stdio: "ignore",
      });
      restorationFailed = restored.status !== 0;
    } catch {
      restorationFailed = true;
    }
  }
  if (existsSync(paths.keychain)) {
    spawnSync("security", ["lock-keychain", paths.keychain], { stdio: "ignore" });
    spawnSync("security", ["delete-keychain", paths.keychain], { stdio: "ignore" });
  }
  for (const sensitivePath of [
    paths.certificate,
    paths.keychain,
    paths.notaryKey,
    paths.searchList,
  ]) {
    rmSync(sensitivePath, { force: true });
  }
  detachDistribution(path.join(paths.root, "mounted"));
  rmSync(paths.root, { force: true, recursive: true });
  invariant(
    !restorationFailed,
    "Temporary keychain search list restoration failed after sensitive material removal.",
  );
}

function run(
  program: string,
  arguments_: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): string {
  return execFileSync(program, arguments_, {
    encoding: "utf8",
    env: options.env,
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function runSensitive(program: string, arguments_: string[], label: string): string {
  const result = spawnSync(program, arguments_, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  invariant(result.status === 0, `${label} failed without exposing command arguments.`);
  return result.stdout.trim();
}

function runInherited(
  program: string,
  arguments_: string[],
  options: { env?: NodeJS.ProcessEnv } = {},
): void {
  execFileSync(program, arguments_, { env: options.env, stdio: "inherit" });
}

function importSigningIdentity(
  paths: SigningMaterialPaths,
  credentials: SignedReleaseCredentials,
  keychainPassword: string,
): void {
  mkdirSync(paths.root, { mode: 0o700, recursive: false });
  const originalKeychains = parseSecurityKeychains(
    run("security", ["list-keychains", "-d", "user"]),
  );
  writeFileSync(paths.searchList, `${JSON.stringify(originalKeychains)}\n`, { mode: 0o600 });
  writeFileSync(paths.certificate, Buffer.from(credentials.certificateBase64, "base64"), {
    mode: 0o600,
  });
  writeFileSync(paths.notaryKey, credentials.notaryApiPrivateKey, { mode: 0o600 });
  chmodSync(paths.certificate, 0o600);
  chmodSync(paths.notaryKey, 0o600);
  runSensitive(
    "security",
    ["create-keychain", "-p", keychainPassword, paths.keychain],
    "Temporary keychain creation",
  );
  runSensitive(
    "security",
    ["set-keychain-settings", "-lut", "21600", paths.keychain],
    "Temporary keychain locking policy",
  );
  runSensitive(
    "security",
    ["unlock-keychain", "-p", keychainPassword, paths.keychain],
    "Temporary keychain unlock",
  );
  runSensitive(
    "security",
    [
      "import",
      paths.certificate,
      "-k",
      paths.keychain,
      "-P",
      credentials.certificatePassword,
      "-T",
      "/usr/bin/codesign",
      "-T",
      "/usr/bin/security",
    ],
    "Developer ID certificate import",
  );
  runSensitive(
    "security",
    [
      "set-key-partition-list",
      "-S",
      "apple-tool:,apple:",
      "-s",
      "-k",
      keychainPassword,
      paths.keychain,
    ],
    "Temporary keychain partition policy",
  );
  runSensitive(
    "security",
    ["list-keychains", "-d", "user", "-s", paths.keychain, ...originalKeychains],
    "Temporary keychain search list",
  );
}

function verifyImportedIdentity(keychain: string, expectedIdentity: string): void {
  const output = run("security", ["find-identity", "-v", "-p", "codesigning", keychain]);
  const identities = [...output.matchAll(/^\s*\d+\)\s+[0-9A-F]+\s+"([^"]+)"$/gmu)].map(
    (match) => match[1],
  );
  invariant(
    identities.length === 1 && identities[0] === expectedIdentity,
    "Temporary keychain does not contain exactly the expected Developer ID Application identity.",
  );
}

function sanitizedBuildEnvironment(
  credentials: SignedReleaseCredentials,
  teamIdentifier: string,
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const variable of appleCredentialVariables) delete environment[variable];
  environment.APPLE_SIGNING_IDENTITY = credentials.signingIdentity;
  environment.MISH_EXPECTED_APPLE_TEAM_IDENTIFIER = teamIdentifier;
  environment.MISH_PROTECTED_RELEASE_ENVIRONMENT = signedReleaseEnvironment;
  delete environment.MISH_MACOS_PACKAGE_MODE;
  delete environment.MISH_MACOS_RELEASE_PROFILE;
  return environment;
}

function createSignedDistribution(
  application: string,
  dmg: string,
  stagingRoot: string,
  identity: string,
): void {
  mkdirSync(stagingRoot, { mode: 0o700, recursive: true });
  chmodSync(stagingRoot, 0o700);
  const applicationRoot = assertPrivateNoFollowRoot(application);
  const staging = assertPrivateNoFollowRoot(stagingRoot);
  applicationRoot.assertCurrent();
  staging.assertCurrent();
  const stagedApplication = path.join(stagingRoot, "Mish.app");
  runInherited("ditto", [application, stagedApplication]);
  symlinkSync("/Applications", path.join(stagingRoot, "Applications"));
  runInherited("hdiutil", [
    "create",
    "-volname",
    "Mish",
    "-srcfolder",
    stagingRoot,
    "-ov",
    "-format",
    "UDZO",
    dmg,
  ]);
  runInherited("codesign", ["--force", "--timestamp", "--sign", identity, dmg]);
}

function notaryArguments(
  paths: SigningMaterialPaths,
  credentials: SignedReleaseCredentials,
): string[] {
  return [
    "--key",
    paths.notaryKey,
    "--key-id",
    credentials.notaryApiKeyId,
    "--issuer",
    credentials.notaryApiIssuerId,
  ];
}

function submitAndCheckNotary(
  dmg: string,
  paths: SigningMaterialPaths,
  credentials: SignedReleaseCredentials,
): ReturnType<typeof validateAppleNotaryResult> {
  const authentication = notaryArguments(paths, credentials);
  const submissionProcess = spawnSync(
    "xcrun",
    ["notarytool", "submit", dmg, ...authentication, "--wait", "--output-format", "json"],
    { encoding: "utf8" },
  );
  let submission: { id?: unknown; status?: unknown };
  try {
    submission = JSON.parse(submissionProcess.stdout || "{}") as {
      id?: unknown;
      status?: unknown;
    };
  } catch {
    throw new Error("Apple notarization returned malformed terminal JSON.");
  }
  invariant(
    typeof submission.id === "string",
    `Apple notarization submission failed before returning an identifier (exit ${submissionProcess.status ?? "signal"}).`,
  );
  const logProcess = spawnSync(
    "xcrun",
    ["notarytool", "log", submission.id, ...authentication, "--output-format", "json"],
    { encoding: "utf8" },
  );
  let log: { issues?: unknown; status?: unknown };
  try {
    log = JSON.parse(logProcess.stdout || "{}") as { issues?: unknown; status?: unknown };
  } catch {
    throw new Error("Apple notarization log returned malformed JSON.");
  }
  return validateAppleNotaryResult(submission, log);
}

function mountDistribution(dmg: string, mountpoint: string): void {
  mkdirSync(mountpoint, { mode: 0o700, recursive: true });
  runInherited("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mountpoint, dmg]);
}

function detachDistribution(mountpoint: string): void {
  if (!existsSync(mountpoint)) return;
  spawnSync("hdiutil", ["detach", mountpoint], { stdio: "ignore" });
}

function developerIdRequirement(identity: string, identifier: string): string {
  const parsed = parseDeveloperIdApplicationIdentity(identity);
  return `anchor apple generic and identifier "${identifier}" and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists and certificate leaf[subject.OU] = "${parsed.teamIdentifier}"`;
}

function collectSbomFiles(
  root: string,
  directory = root,
  rootGuard = assertPrivateNoFollowRoot(root),
): Array<{ name: string; sha1: string; sha256: string }> {
  const result: Array<{ name: string; sha1: string; sha256: string }> = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).split(path.sep).join("/");
    const guarded = rootGuard.contain(relative, entry.isDirectory() ? "directory" : "file");
    if (entry.isDirectory()) {
      result.push(...collectSbomFiles(root, absolute, rootGuard));
    } else if (entry.isFile()) {
      guarded.assertCurrent();
      const content = readContainedReleaseFile(guarded);
      result.push({
        name: `Mish.app/${relative}`,
        sha1: sha1(content),
        sha256: sha256(content),
      });
    }
  }
  return result.sort((left, right) => left.name.localeCompare(right.name));
}

function spdxId(prefix: string, value: string): string {
  return `SPDXRef-${prefix}-${createHash("sha256").update(value).digest("hex").slice(0, 16)}`;
}

export function generateSignedReleaseSbom(
  application: string,
  dmg: string,
  identity: SignedReleaseIdentity,
  output: string,
): void {
  const applicationRoot = assertPrivateNoFollowRoot(application);
  const dmgGuard = assertPrivateNoFollowFile(dmg);
  const outputRoot = assertPrivateNoFollowRoot(path.dirname(path.resolve(output)));
  const dmgDigest = sha256(readContainedReleaseFile(dmgGuard));
  const fileDigests = [
    {
      name: identity.dmgName,
      sha1: sha1(readContainedReleaseFile(dmgGuard)),
      sha256: dmgDigest,
    },
    ...collectSbomFiles(applicationRoot.absolute, applicationRoot.absolute, applicationRoot),
  ];
  const files = fileDigests.map((entry) => ({
    checksums: [
      { algorithm: "SHA1", checksumValue: entry.sha1 },
      { algorithm: "SHA256", checksumValue: entry.sha256 },
    ],
    fileName: entry.name,
    SPDXID: spdxId("File", entry.name),
  }));
  const packageVerificationCode = createHash("sha1")
    .update(
      fileDigests
        .map(({ sha1: digest }) => digest)
        .sort()
        .join(""),
    )
    .digest("hex");
  const mishPackage = "SPDXRef-Package-Mish";
  const mihomoPackage = "SPDXRef-Package-Mihomo";
  const document = {
    SPDXID: "SPDXRef-DOCUMENT",
    creationInfo: {
      created: new Date().toISOString(),
      creators: ["Tool: mish-macos-signed-release-stage1"],
    },
    dataLicense: "CC0-1.0",
    documentNamespace: `https://github.com/Asuka109/mish/sbom/${identity.sourceSha}/${dmgDigest}`,
    files,
    name: `Mish ${identity.version} macOS signed-direct SBOM`,
    packages: [
      {
        SPDXID: mishPackage,
        checksums: [{ algorithm: "SHA256", checksumValue: dmgDigest }],
        downloadLocation: "NOASSERTION",
        filesAnalyzed: true,
        licenseConcluded: "GPL-3.0-only",
        licenseDeclared: "GPL-3.0-only",
        name: "Mish",
        packageVerificationCode: { packageVerificationCodeValue: packageVerificationCode },
        supplier: "Organization: Mish contributors",
        versionInfo: identity.version,
      },
      {
        SPDXID: mihomoPackage,
        downloadLocation: "https://github.com/MetaCubeX/mihomo",
        filesAnalyzed: false,
        licenseConcluded: "GPL-3.0-only",
        licenseDeclared: "GPL-3.0-only",
        name: "Mihomo",
        supplier: "Organization: MetaCubeX",
        versionInfo: readPinnedMihomoVersion(),
      },
    ],
    relationships: [
      {
        relatedSpdxElement: mishPackage,
        relationshipType: "DESCRIBES",
        spdxElementId: "SPDXRef-DOCUMENT",
      },
      {
        relatedSpdxElement: mihomoPackage,
        relationshipType: "DEPENDS_ON",
        spdxElementId: mishPackage,
      },
      ...files.map((file) => ({
        relatedSpdxElement: file.SPDXID,
        relationshipType: "CONTAINS",
        spdxElementId: mishPackage,
      })),
    ],
    spdxVersion: "SPDX-2.3",
  };
  writeContainedReleaseFile(
    outputRoot,
    path.basename(path.resolve(output)),
    `${JSON.stringify(document, null, 2)}\n`,
    { mode: 0o644 },
  );
}

function readCredentials(environment: NodeJS.ProcessEnv): SignedReleaseCredentials {
  return {
    certificateBase64: environment.MISH_APPLE_CERTIFICATE_BASE64 ?? "",
    certificatePassword: environment.MISH_APPLE_CERTIFICATE_PASSWORD ?? "",
    notaryApiIssuerId: environment.MISH_APPLE_NOTARY_API_ISSUER_ID ?? "",
    notaryApiKeyId: environment.MISH_APPLE_NOTARY_API_KEY_ID ?? "",
    notaryApiPrivateKey: environment.MISH_APPLE_NOTARY_API_PRIVATE_KEY ?? "",
    signingIdentity: environment.MISH_APPLE_SIGNING_IDENTITY ?? "",
  };
}

export function executeProtectedSignedRelease(options: {
  boundary: SignedReleasePlanningBoundary;
  expectedRepository: string;
  outputDirectory: string;
  scratchRoot: string;
}): SignedReleaseEvidence {
  invariant(
    process.platform === "darwin" && process.arch === "arm64",
    "Protected signed releases require an Apple Silicon macOS runner.",
  );
  const identity = validateSignedReleasePlanningBoundary(
    options.boundary,
    options.expectedRepository,
  );
  invariant(!options.boundary.dryRun, "Dry runs must never enter protected signing execution.");
  validateSelectedSignedSource(identity.sourceSha);
  const credentials = readCredentials(process.env);
  const parsedIdentity = validateCompleteSignedReleaseCredentials(credentials);
  const recorder = new SignedReleaseRecorder(identity);
  recorder.confirm("trusted-boundary", "workflow_dispatch on main in macos-developer-id");
  recorder.confirm("credentials-complete", "complete protected credential boundary");

  const outputDirectory = path.resolve(options.outputDirectory);
  if (!existsSync(outputDirectory)) mkdirSync(outputDirectory, { mode: 0o700, recursive: true });
  chmodSync(outputDirectory, 0o700);
  const outputRoot = assertPrivateNoFollowRoot(outputDirectory);
  invariant(
    readdirSync(outputDirectory).length === 0,
    "Signed release output directory must be empty.",
  );
  const paths = signingMaterialPaths(options.scratchRoot);
  const application = path.resolve("target/release/bundle/macos/Mish.app");
  const dmg = path.join(outputDirectory, identity.dmgName);
  const sbom = path.join(outputDirectory, signedReleaseSbomName);
  const keychainPassword = randomBytes(32).toString("hex");
  const distributionRoot = path.join(paths.root, "distribution");
  const mountpoint = path.join(paths.root, "mounted");
  let notary: SignedReleaseEvidence["notary"] | undefined;
  let succeeded = false;

  try {
    importSigningIdentity(paths, credentials, keychainPassword);
    recorder.confirm("keychain-created", "temporary locked keychain created");
    recorder.confirm("certificate-imported", "certificate imported into temporary keychain");
    verifyImportedIdentity(paths.keychain, credentials.signingIdentity);
    recorder.confirm("identity-verified", "exact Developer ID Application identity verified");

    runInherited("pnpm", ["desktop:bundle:signed-direct:macos"], {
      env: sanitizedBuildEnvironment(credentials, parsedIdentity.teamIdentifier),
    });
    recorder.confirm("bundle-built", "signed-direct System Proxy-only application built");
    const applicationRoot = assertPrivateNoFollowRoot(application);
    const mainExecutable = applicationRoot.contain("Contents/MacOS/mish-desktop", "executable");
    const bundledMihomo = applicationRoot.contain(signedDirectMihomoExecutable, "executable");
    mainExecutable.assertCurrent();
    bundledMihomo.assertCurrent();
    recorder.confirm("bundle-verified", "bundle identity layout runtime and resources verified");

    createSignedDistribution(application, dmg, distributionRoot, credentials.signingIdentity);
    recorder.confirm("distribution-created", "Developer ID signed DMG created headlessly");
    assertPrivateNoFollowFile(dmg).assertCurrent();

    assertPrivateNoFollowFile(dmg).assertCurrent();
    notary = submitAndCheckNotary(dmg, paths, credentials);
    recorder.confirm("notary-submitted", `Apple notary submission ${notary.submissionId}`);
    recorder.confirm("notary-accepted", "terminal notary status Accepted with zero issues");

    assertPrivateNoFollowFile(dmg).assertCurrent();
    runInherited("xcrun", ["stapler", "staple", dmg]);
    recorder.confirm("ticket-stapled", "notary ticket stapled to exact DMG");
    assertPrivateNoFollowFile(dmg).assertCurrent();
    runInherited("xcrun", ["stapler", "validate", dmg]);
    recorder.confirm("ticket-validated", "stapler validated the final DMG ticket");

    assertPrivateNoFollowFile(dmg).assertCurrent();
    runInherited("codesign", ["--verify", "--strict", "--verbose=4", dmg]);
    assertPrivateNoFollowFile(dmg).assertCurrent();
    mountDistribution(dmg, mountpoint);
    const mountedApplication = path.join(mountpoint, "Mish.app");
    const mountedRoot = assertPrivateNoFollowRoot(mountedApplication);
    const mountedMihomo = mountedRoot.contain(signedDirectMihomoExecutable, "executable");
    mountedRoot.assertCurrent();
    mountedMihomo.assertCurrent();
    runInherited("codesign", ["--verify", "--deep", "--strict", "--verbose=4", mountedApplication]);
    mountedRoot.assertCurrent();
    runInherited("codesign", [
      "--verify",
      "--strict",
      "--verbose=4",
      "-R",
      developerIdRequirement(credentials.signingIdentity, signedDirectApplicationIdentifier),
      mountedApplication,
    ]);
    mountedMihomo.assertCurrent();
    runInherited("codesign", [
      "--verify",
      "--strict",
      "--verbose=4",
      "-R",
      developerIdRequirement(credentials.signingIdentity, signedDirectMihomoIdentifier),
      mountedMihomo.absolute,
    ]);
    recorder.confirm("codesign-assessed", "independent strict Developer ID assessment passed");
    assertPrivateNoFollowFile(dmg).assertCurrent();
    runInherited("spctl", [
      "--assess",
      "--type",
      "open",
      "--context",
      "context:primary-signature",
      "--verbose=4",
      dmg,
    ]);
    recorder.confirm("distribution-assessed", "Gatekeeper disk-image assessment passed");
    generateSignedReleaseSbom(mountedApplication, dmg, identity, sbom);
    recorder.confirm("sbom-generated", "SPDX 2.3 SBOM generated for the final DMG and bundle");
    succeeded = true;
  } finally {
    detachDistribution(mountpoint);
    cleanupSigningMaterials(paths.root);
  }

  invariant(succeeded && notary, "Protected signed release did not reach complete evidence.");
  recorder.confirm("cleanup-confirmed", "temporary keychain and signing material removed");
  const evidence: SignedReleaseEvidence = {
    claims: {
      developerIdTrust: "observed-by-protected-workflow",
      distributionAssessment: "observed-by-protected-workflow",
      notarization: "observed-by-protected-workflow",
    },
    identity,
    notary,
    schemaVersion: 1,
    signing: {
      identity: credentials.signingIdentity,
      teamIdentifier: parsedIdentity.teamIdentifier,
    },
    stages: recorder.stages,
  };
  validateSignedReleaseEvidence(evidence, false);
  writeContainedReleaseFile(
    outputRoot,
    signedReleaseEvidenceName,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o644 },
  );
  return evidence;
}

function assertAttestation(id: string, url: string, label: string): { id: string; url: string } {
  invariant(/^\d+$/u.test(id), `${label} attestation ID is invalid.`);
  invariant(attestationUrl.test(url), `${label} attestation URL is invalid.`);
  return { id, url };
}

export function finalizeSignedReleaseCandidate(options: {
  artifactDirectory: string;
  provenanceBundle: string;
  provenanceId: string;
  provenanceUrl: string;
  sbomBundle: string;
  sbomId: string;
  sbomUrl: string;
}): SignedReleaseEvidence {
  const directory = path.resolve(options.artifactDirectory);
  const artifactRoot = assertPrivateNoFollowRoot(directory);
  const evidencePath = artifactRoot.contain(signedReleaseEvidenceName, "file");
  const evidence = JSON.parse(
    readContainedReleaseFile(evidencePath).toString("utf8"),
  ) as SignedReleaseEvidence;
  validateSignedReleaseEvidence(evidence, false);
  invariant(
    evidence.stages.at(-1)?.stage === "cleanup-confirmed",
    "Attestations require complete protected execution and cleanup evidence.",
  );
  const provenance = assertAttestation(options.provenanceId, options.provenanceUrl, "Provenance");
  const sbomAttestation = assertAttestation(options.sbomId, options.sbomUrl, "SBOM");
  const provenanceSource = assertPrivateNoFollowFile(options.provenanceBundle);
  const sbomSource = assertPrivateNoFollowFile(options.sbomBundle);
  const provenanceDestination = writeContainedReleaseFile(
    artifactRoot,
    signedReleaseProvenanceBundleName,
    readContainedReleaseFile(provenanceSource),
    { mode: 0o644 },
  );
  const sbomDestination = writeContainedReleaseFile(
    artifactRoot,
    signedReleaseSbomBundleName,
    readContainedReleaseFile(sbomSource),
    { mode: 0o644 },
  );
  invariant(
    readContainedReleaseFile(provenanceDestination).length > 0 &&
      readContainedReleaseFile(sbomDestination).length > 0,
    "Signed release attestation bundle is empty.",
  );

  const recorder = new SignedReleaseRecorder(evidence.identity);
  recorder.stages.push(...evidence.stages);
  recorder.confirm(
    "provenance-generated",
    `GitHub provenance ${provenance.id} and SBOM ${sbomAttestation.id} attested`,
  );
  const dmg = artifactRoot.contain(evidence.identity.dmgName, "file");
  const sbom = artifactRoot.contain(signedReleaseSbomName, "file");
  evidence.artifactIdentity = {
    dmgSha256: sha256(readContainedReleaseFile(dmg)),
    evidenceSchemaVersion: evidence.schemaVersion,
    provenanceBundleSha256: sha256(readContainedReleaseFile(provenanceDestination)),
    sbomBundleSha256: sha256(readContainedReleaseFile(sbomDestination)),
    sbomSha256: sha256(readContainedReleaseFile(sbom)),
  };
  evidence.attestations = { provenance, sbom: sbomAttestation };
  recorder.confirm("artifact-identity-confirmed", "exact DMG SBOM and attestation digests frozen");
  evidence.stages = recorder.stages;
  writeContainedReleaseFile(
    artifactRoot,
    signedReleaseEvidenceName,
    `${JSON.stringify(evidence, null, 2)}\n`,
    { mode: 0o644, overwrite: true },
  );
  writeSignedReleaseChecksums(directory, evidence.identity.version);
  readSignedReleaseCandidate(directory, {
    sourceSha: evidence.identity.sourceSha,
    version: evidence.identity.version,
  });
  return evidence;
}

function parseChecksums(source: string): Map<string, string> {
  invariant(source.endsWith("\n"), "SHA256SUMS.txt must end with one newline.");
  const result = new Map<string, string>();
  for (const line of source.trimEnd().split("\n")) {
    const match = checksumLine.exec(line);
    invariant(match, `Invalid signed release checksum entry: ${line}`);
    invariant(!result.has(match[2]), `Duplicate signed release checksum entry: ${match[2]}`);
    result.set(match[2], match[1]);
  }
  return result;
}

export function writeSignedReleaseChecksums(directory: string, version: string): void {
  const root = assertPrivateNoFollowRoot(path.resolve(directory));
  const expected = signedReleaseAssetNames(version).filter(
    (name) => name !== signedReleaseChecksumName,
  );
  const actual = readdirSync(directory)
    .filter((name) => name !== signedReleaseChecksumName)
    .sort();
  invariant(
    JSON.stringify(actual) === JSON.stringify([...expected].sort()),
    `Signed release artifact set is wrong before checksums: ${actual.join(", ")}`,
  );
  const lines = expected
    .sort()
    .map((name) => `${sha256(readContainedReleaseFile(root.contain(name, "file")))}  ${name}`);
  writeContainedReleaseFile(root, signedReleaseChecksumName, `${lines.join("\n")}\n`, {
    mode: 0o644,
  });
}

export function readSignedReleaseCandidate(
  directory: string,
  request: { sourceSha: string; version: string },
): SignedReleaseAsset[] {
  invariant(fullSha.test(request.sourceSha), "Signed candidate requires one full source SHA.");
  const absolute = path.resolve(directory);
  const root = assertPrivateNoFollowRoot(absolute);
  const expectedNames = signedReleaseAssetNames(request.version);
  const actualNames = readdirSync(absolute).sort();
  invariant(
    JSON.stringify(actualNames) === JSON.stringify([...expectedNames].sort()),
    `Signed release artifact set is wrong: ${actualNames.join(", ")}`,
  );
  const evidence = JSON.parse(
    readContainedReleaseFile(root.contain(signedReleaseEvidenceName, "file")).toString("utf8"),
  ) as SignedReleaseEvidence;
  validateSignedReleaseEvidence(evidence);
  invariant(
    evidence.identity.sourceSha === request.sourceSha &&
      evidence.identity.version === request.version &&
      evidence.identity.dmgName === signedReleaseDmgName(request.version),
    "Signed candidate source, version, or DMG identity drifted.",
  );
  const checksums = parseChecksums(
    readContainedReleaseFile(root.contain(signedReleaseChecksumName, "file")).toString("utf8"),
  );
  const checksumTargets = expectedNames.filter((name) => name !== signedReleaseChecksumName).sort();
  invariant(
    JSON.stringify([...checksums.keys()].sort()) === JSON.stringify(checksumTargets),
    "Signed release checksum manifest must cover the exact candidate set.",
  );
  for (const [name, digest] of checksums) {
    invariant(
      sha256(readContainedReleaseFile(root.contain(name, "file"))) === digest,
      `Signed release checksum drift: ${name}.`,
    );
  }
  invariant(
    evidence.artifactIdentity?.dmgSha256 ===
      sha256(readContainedReleaseFile(root.contain(evidence.identity.dmgName, "file"))) &&
      evidence.artifactIdentity.sbomSha256 ===
        sha256(readContainedReleaseFile(root.contain(signedReleaseSbomName, "file"))) &&
      evidence.artifactIdentity.provenanceBundleSha256 ===
        sha256(readContainedReleaseFile(root.contain(signedReleaseProvenanceBundleName, "file"))) &&
      evidence.artifactIdentity.sbomBundleSha256 ===
        sha256(readContainedReleaseFile(root.contain(signedReleaseSbomBundleName, "file"))),
    "Signed release evidence and final artifact digests drifted.",
  );
  const sbom = JSON.parse(
    readContainedReleaseFile(root.contain(signedReleaseSbomName, "file")).toString("utf8"),
  ) as {
    documentNamespace?: unknown;
    name?: unknown;
    packages?: Array<{
      checksums?: Array<{ algorithm?: unknown; checksumValue?: unknown }>;
      name?: unknown;
      versionInfo?: unknown;
    }>;
    spdxVersion?: unknown;
  };
  const mishPackage = sbom.packages?.find((candidate) => candidate.name === "Mish");
  invariant(
    sbom.spdxVersion === "SPDX-2.3" &&
      sbom.name === `Mish ${request.version} macOS signed-direct SBOM` &&
      typeof sbom.documentNamespace === "string" &&
      sbom.documentNamespace.includes(request.sourceSha) &&
      mishPackage?.versionInfo === request.version &&
      mishPackage.checksums?.some(
        (checksum) =>
          checksum.algorithm === "SHA256" &&
          checksum.checksumValue === evidence.artifactIdentity?.dmgSha256,
      ),
    "Signed release SBOM does not describe the exact final DMG and source.",
  );
  return expectedNames.map((name) => {
    const guarded = root.contain(name, "file");
    const content = readContainedReleaseFile(guarded);
    invariant(content.length > 0, `Signed release asset is empty: ${name}`);
    return {
      content,
      contentType: contentType(name),
      digest: sha256(content),
      name,
      path: guarded.absolute,
      size: content.length,
    };
  });
}

export function planSignedReleaseStaging(
  request: SignedReleaseRequest,
  state: SignedReleaseRemoteState,
): SignedReleaseStagingPlan {
  const parsed = parsePrereleaseVersion(request.version);
  invariant(fullSha.test(request.sourceSha), "Signed Draft staging requires one full source SHA.");
  const expectedNames = signedReleaseAssetNames(request.version);
  const localAssets = new Map((request.assets ?? []).map((asset) => [asset.name, asset]));
  invariant(
    localAssets.size === (request.assets?.length ?? 0),
    "Signed release assets contain duplicate names.",
  );
  if (request.assets) {
    invariant(
      request.candidateUploaded,
      "Draft eligibility requires a successfully uploaded exact candidate.",
    );
    invariant(
      JSON.stringify([...localAssets.keys()].sort()) === JSON.stringify([...expectedNames].sort()),
      "Draft eligibility requires the complete signed candidate asset set.",
    );
  }
  if (state.tagCommit !== null) {
    invariant(
      state.tagCommit === request.sourceSha,
      `Tag ${parsed.tag} already points to ${state.tagCommit}, not ${request.sourceSha}.`,
    );
  }
  invariant(
    !(state.release && state.tagCommit === null),
    `Signed release ${parsed.tag} exists without its immutable tag.`,
  );
  if (!state.release) {
    return {
      action: state.tagCommit ? "create-release" : "create-tag-and-release",
      createRelease: true,
      createTag: state.tagCommit === null,
      matchingAssets: [],
      missingAssets: expectedNames,
    };
  }
  const release = state.release;
  invariant(release.tagName === parsed.tag, "Existing signed release tag conflicts.");
  invariant(fullSha.test(release.targetCommitish), "Existing signed release target is not a SHA.");
  invariant(
    release.targetCommitish === request.sourceSha,
    "Existing signed release targets a different source SHA.",
  );
  invariant(
    release.name === expectedReleaseName(parsed.tag),
    "Existing signed release name conflicts.",
  );
  invariant(release.draft, `Existing signed release ${parsed.tag} is not a Draft.`);
  invariant(release.prerelease, `Existing signed release ${parsed.tag} is not a Pre-release.`);

  const seen = new Set<string>();
  const matchingAssets: string[] = [];
  for (const asset of release.assets) {
    invariant(!seen.has(asset.name), `Existing signed release duplicates ${asset.name}.`);
    seen.add(asset.name);
    invariant(expectedNames.includes(asset.name), `Existing signed release has ${asset.name}.`);
    invariant(asset.state === "uploaded", `Existing signed asset ${asset.name} is not uploaded.`);
    const local = localAssets.get(asset.name);
    if (local) {
      invariant(asset.size === local.size, `Existing signed asset ${asset.name} size drifted.`);
      invariant(
        asset.digest === `sha256:${local.digest}`,
        `Existing signed asset ${asset.name} digest drifted.`,
      );
      matchingAssets.push(asset.name);
    }
  }
  const missingAssets = expectedNames.filter((name) => !seen.has(name));
  return {
    action: missingAssets.length === 0 ? "already-staged" : "resume-release",
    createRelease: false,
    createTag: false,
    matchingAssets,
    missingAssets,
  };
}

class GitHubSignedReleaseClient implements SignedReleaseClient {
  private readonly repository: string;
  private readonly token: string;

  constructor(repository: string, token: string) {
    invariant(repositoryName.test(repository), "GitHub repository must use owner/name.");
    invariant(token.length > 0, "GH_TOKEN is required for signed release state.");
    this.repository = repository;
    this.token = token;
  }

  private async request<T>(
    url: string,
    options: { body?: BodyInit; contentType?: string; method?: string } = {},
  ): Promise<T> {
    const response = await fetch(
      url.startsWith("https://") ? url : `https://api.github.com${url}`,
      {
        body: options.body,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.token}`,
          "Content-Type": options.contentType ?? "application/json",
          "X-GitHub-Api-Version": apiVersion,
        },
        method: options.method ?? "GET",
      },
    );
    if (!response.ok) {
      const detail = await response.text();
      throw new GitHubApiError(
        `GitHub API ${response.status} for ${options.method ?? "GET"} ${url}: ${detail.slice(0, 500)}`,
        response.status,
      );
    }
    return (await response.json()) as T;
  }

  private async optional<T>(url: string): Promise<T | null> {
    try {
      return await this.request<T>(url);
    } catch (error) {
      if (error instanceof GitHubApiError && error.status === 404) return null;
      throw error;
    }
  }

  private async resolveTagObject(type: string, sha: string): Promise<string> {
    let currentType = type;
    let currentSha = sha;
    for (let depth = 0; depth < 8; depth += 1) {
      if (currentType === "commit") {
        invariant(fullSha.test(currentSha), "GitHub tag resolved to an invalid commit SHA.");
        return currentSha;
      }
      invariant(currentType === "tag", `GitHub tag points to ${currentType}.`);
      const tag = await this.request<GitHubTagResponse>(
        `/repos/${this.repository}/git/tags/${currentSha}`,
      );
      invariant(tag.object?.type && tag.object.sha, "GitHub annotated tag response is incomplete.");
      currentType = tag.object.type;
      currentSha = tag.object.sha;
    }
    throw new Error("GitHub annotated tag chain is too deep.");
  }

  private normalizeRelease(response: GitHubReleaseResponse): SignedReleaseRemoteRelease {
    invariant(
      typeof response.id === "number" &&
        typeof response.tag_name === "string" &&
        typeof response.target_commitish === "string" &&
        typeof response.name === "string" &&
        typeof response.draft === "boolean" &&
        typeof response.prerelease === "boolean" &&
        typeof response.upload_url === "string" &&
        typeof response.html_url === "string",
      "GitHub signed release response is incomplete.",
    );
    return {
      assets: (response.assets ?? []).map((asset) => {
        invariant(
          typeof asset.id === "number" &&
            typeof asset.name === "string" &&
            typeof asset.size === "number" &&
            typeof asset.state === "string",
          "GitHub signed release asset response is incomplete.",
        );
        return {
          digest: asset.digest ?? null,
          id: asset.id,
          name: asset.name,
          size: asset.size,
          state: asset.state,
        };
      }),
      draft: response.draft,
      htmlUrl: response.html_url,
      id: response.id,
      name: response.name,
      prerelease: response.prerelease,
      tagName: response.tag_name,
      targetCommitish: response.target_commitish,
      uploadUrl: response.upload_url,
    };
  }

  private async releaseByTag(tag: string): Promise<SignedReleaseRemoteRelease | null> {
    const matches: SignedReleaseRemoteRelease[] = [];
    for (let page = 1; page <= 20; page += 1) {
      const responses = await this.request<GitHubReleaseResponse[]>(
        `/repos/${this.repository}/releases?per_page=100&page=${page}`,
      );
      for (const response of responses) {
        if (response.tag_name === tag) matches.push(this.normalizeRelease(response));
      }
      if (responses.length < 100) {
        invariant(matches.length <= 1, `GitHub has multiple releases for tag ${tag}.`);
        return matches[0] ?? null;
      }
    }
    throw new Error("GitHub signed release listing exceeded the pagination limit.");
  }

  private async resolveCommitish(commitish: string): Promise<string> {
    if (fullSha.test(commitish)) return commitish;
    const response = await this.request<{ sha?: string }>(
      `/repos/${this.repository}/commits/${encodeURIComponent(commitish)}`,
    );
    invariant(
      typeof response.sha === "string" && fullSha.test(response.sha),
      "GitHub did not resolve the signed release target to a full SHA.",
    );
    return response.sha;
  }

  async getState(request: SignedReleaseRequest): Promise<SignedReleaseRemoteState> {
    const tag = parsePrereleaseVersion(request.version).tag;
    const reference = await this.optional<GitHubRefResponse>(
      `/repos/${this.repository}/git/ref/tags/${encodeURIComponent(tag)}`,
    );
    const tagCommit = reference
      ? await this.resolveTagObject(reference.object?.type ?? "", reference.object?.sha ?? "")
      : null;
    const release = await this.releaseByTag(tag);
    return {
      release: release
        ? { ...release, targetCommitish: await this.resolveCommitish(release.targetCommitish) }
        : null,
      tagCommit,
    };
  }

  async createTag(tag: string, sourceSha: string): Promise<void> {
    await this.request(`/repos/${this.repository}/git/refs`, {
      body: JSON.stringify({ ref: `refs/tags/${tag}`, sha: sourceSha }),
      method: "POST",
    });
  }

  async createRelease(request: SignedReleaseRequest): Promise<void> {
    const parsed = parsePrereleaseVersion(request.version);
    await this.request(`/repos/${this.repository}/releases`, {
      body: JSON.stringify({
        draft: true,
        generate_release_notes: false,
        name: expectedReleaseName(parsed.tag),
        prerelease: true,
        tag_name: parsed.tag,
        target_commitish: request.sourceSha,
      }),
      method: "POST",
    });
  }

  async uploadAsset(release: SignedReleaseRemoteRelease, asset: SignedReleaseAsset): Promise<void> {
    const uploadUrl = new URL(release.uploadUrl.replace(/\{\?name,label\}$/u, ""));
    uploadUrl.searchParams.set("name", asset.name);
    await this.request(uploadUrl.toString(), {
      body: asset.content,
      contentType: asset.contentType,
      method: "POST",
    });
  }
}

export async function stageSignedRelease(
  client: SignedReleaseClient,
  request: SignedReleaseRequest,
  dryRun: boolean,
): Promise<{ plan: SignedReleaseStagingPlan; state: SignedReleaseRemoteState }> {
  invariant(request.assets, "Signed Draft staging requires verified local assets.");
  invariant(
    request.candidateUploaded,
    "Signed Draft staging requires successful candidate upload.",
  );
  let state = await client.getState(request);
  let plan = planSignedReleaseStaging(request, state);
  if (dryRun) return { plan, state };

  if (plan.createTag) {
    try {
      await client.createTag(parsePrereleaseVersion(request.version).tag, request.sourceSha);
    } catch (error) {
      if (!isGitHubConflict(error)) throw error;
    }
    state = await client.getState(request);
    plan = planSignedReleaseStaging(request, state);
    invariant(state.tagCommit === request.sourceSha, "Signed tag creation was not observable.");
  }
  if (plan.createRelease) {
    try {
      await client.createRelease(request);
    } catch (error) {
      if (!isGitHubConflict(error)) throw error;
    }
    state = await client.getState(request);
    plan = planSignedReleaseStaging(request, state);
    invariant(state.release, "Signed Draft creation was not observable.");
  }
  invariant(state.release, "Signed assets cannot upload before the Draft exists.");
  for (const name of plan.missingAssets) {
    const asset = request.assets.find((candidate) => candidate.name === name);
    invariant(asset, `Verified signed release asset is missing: ${name}`);
    await client.uploadAsset(state.release, asset);
    state = await client.getState(request);
    plan = planSignedReleaseStaging(request, state);
  }
  invariant(plan.action === "already-staged", "Signed Draft staging is incomplete.");
  return { plan, state };
}

export function runSignedReleaseFixture(): Record<string, string> {
  const identity = validateSignedReleasePlanningBoundary(
    {
      contentsPermission: "read",
      dryRun: true,
      environment: signedReleaseEnvironment,
      eventName: "workflow_dispatch",
      profile: signedDirectProfile,
      ref: "refs/heads/main",
      repository: "Asuka109/mish",
      sourceSha: "1".repeat(40),
      version: "0.1.0-alpha.1",
    },
    "Asuka109/mish",
  );
  const recorder = new SignedReleaseRecorder(identity);
  for (const stage of signedReleaseStages) recorder.confirm(stage, `fixture ${stage}`);
  const updater = runUpdaterContractFixture();
  const failures: Record<string, string> = {};
  for (const [name, operation] of [
    [
      "untrusted-event",
      () =>
        validateSignedReleasePlanningBoundary(
          {
            contentsPermission: "read",
            dryRun: true,
            environment: signedReleaseEnvironment,
            eventName: "pull_request",
            profile: signedDirectProfile,
            ref: "refs/heads/main",
            repository: "Asuka109/mish",
            sourceSha: "1".repeat(40),
            version: "0.1.0-alpha.1",
          },
          "Asuka109/mish",
        ),
    ],
    [
      "apple-rejection",
      () =>
        validateAppleNotaryResult(
          { id: "11111111-1111-1111-1111-111111111111", status: "Invalid" },
          { issues: [{ message: "fixture" }], status: "Invalid" },
        ),
    ],
    [
      "upload-failure",
      () =>
        planSignedReleaseStaging(
          {
            assets: [],
            candidateUploaded: false,
            sourceSha: "1".repeat(40),
            version: "0.1.0-alpha.1",
          },
          { release: null, tagCommit: null },
        ),
    ],
  ] as const) {
    try {
      operation();
      throw new Error(`${name} fixture unexpectedly passed.`);
    } catch (error) {
      failures[name] = error instanceof Error ? error.message : String(error);
    }
  }
  return {
    ...failures,
    profile: identity.profile,
    stages: recorder.stages.map(({ stage }) => stage).join(","),
    updaterArtifacts: updater.artifacts,
    updaterStage: updater.stage,
  };
}

function option(arguments_: string[], name: string, required = true): string | undefined {
  const index = arguments_.indexOf(name);
  if (index === -1) {
    invariant(!required, `Missing required option ${name}.`);
    return undefined;
  }
  const value = arguments_[index + 1];
  invariant(value && !value.startsWith("--"), `Option ${name} requires a value.`);
  return value;
}

function booleanOption(arguments_: string[], name: string): boolean {
  const value = option(arguments_, name);
  invariant(value === "true" || value === "false", `${name} must be true or false.`);
  return value === "true";
}

function appendOutput(values: Record<string, string | number>): void {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  const lines = Object.entries(values).map(([name, value]) => {
    const text = String(value);
    invariant(!text.includes("\n") && !text.includes("\r"), `Output ${name} contains a newline.`);
    return `${name}=${text}`;
  });
  writeFileSync(output, `${lines.join("\n")}\n`, { encoding: "utf8", flag: "a" });
}

function boundaryFromArguments(arguments_: string[]): SignedReleasePlanningBoundary {
  return {
    contentsPermission: option(arguments_, "--contents-permission") as string,
    dryRun: booleanOption(arguments_, "--dry-run"),
    environment: option(arguments_, "--environment") as string,
    eventName: option(arguments_, "--event-name") as string,
    profile: option(arguments_, "--profile") as string,
    ref: option(arguments_, "--ref") as string,
    repository: option(arguments_, "--repository") as string,
    sourceSha: option(arguments_, "--source-sha") as string,
    version: option(arguments_, "--version") as string,
  };
}

async function main(): Promise<void> {
  const [command, ...arguments_] = process.argv.slice(2);
  if (command === "fixture") {
    console.log(JSON.stringify(runSignedReleaseFixture(), null, 2));
    return;
  }
  if (command === "plan-boundary") {
    const boundary = boundaryFromArguments(arguments_);
    validateSelectedSignedSource(boundary.sourceSha);
    const identity = validateSignedReleasePlanningBoundary(
      boundary,
      option(arguments_, "--expected-repository") as string,
    );
    appendOutput({ dmg_name: identity.dmgName, profile: identity.profile, tag: identity.tag });
    console.log(JSON.stringify(identity, null, 2));
    return;
  }
  if (command === "execute") {
    const boundary = boundaryFromArguments(arguments_);
    const evidence = executeProtectedSignedRelease({
      boundary,
      expectedRepository: option(arguments_, "--expected-repository") as string,
      outputDirectory: option(arguments_, "--output-directory") as string,
      scratchRoot: option(arguments_, "--scratch-root") as string,
    });
    appendOutput({
      dmg_name: evidence.identity.dmgName,
      notary_submission_id: evidence.notary.submissionId,
      signing_identity: evidence.signing.identity,
    });
    console.log(
      JSON.stringify(
        {
          dmg: evidence.identity.dmgName,
          notarySubmissionId: evidence.notary.submissionId,
          stages: evidence.stages.map(({ stage }) => stage),
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "cleanup") {
    cleanupSigningMaterials(option(arguments_, "--scratch-root") as string);
    return;
  }
  if (command === "finalize-attestations") {
    const evidence = finalizeSignedReleaseCandidate({
      artifactDirectory: option(arguments_, "--artifact-directory") as string,
      provenanceBundle: option(arguments_, "--provenance-bundle") as string,
      provenanceId: option(arguments_, "--provenance-id") as string,
      provenanceUrl: option(arguments_, "--provenance-url") as string,
      sbomBundle: option(arguments_, "--sbom-bundle") as string,
      sbomId: option(arguments_, "--sbom-id") as string,
      sbomUrl: option(arguments_, "--sbom-url") as string,
    });
    appendOutput({
      dmg_sha256: evidence.artifactIdentity?.dmgSha256 ?? "",
      notary_submission_id: evidence.notary.submissionId,
    });
    console.log(
      JSON.stringify(
        {
          artifactIdentity: evidence.artifactIdentity,
          attestations: evidence.attestations,
          draftEligible: true,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (command === "preflight" || command === "plan" || command === "stage") {
    const repository = option(arguments_, "--repository") as string;
    const sourceSha = option(arguments_, "--source-sha") as string;
    const version = option(arguments_, "--version") as string;
    validateSelectedSignedSource(sourceSha);
    const artifactDirectory = option(arguments_, "--artifact-directory", command === "stage");
    const assets = artifactDirectory
      ? readSignedReleaseCandidate(artifactDirectory, { sourceSha, version })
      : undefined;
    const candidateArtifactId = option(arguments_, "--candidate-artifact-id", Boolean(assets));
    invariant(
      !assets || (candidateArtifactId != null && /^\d+$/u.test(candidateArtifactId)),
      "Signed Draft planning requires the uploaded candidate artifact ID.",
    );
    const request: SignedReleaseRequest = {
      assets,
      candidateUploaded: Boolean(assets && candidateArtifactId),
      sourceSha,
      version,
    };
    const client = new GitHubSignedReleaseClient(repository, process.env.GH_TOKEN ?? "");
    if (command === "preflight" || command === "plan") {
      const state = await client.getState(request);
      const plan = planSignedReleaseStaging(request, state);
      appendOutput({ action: plan.action, missing_assets: plan.missingAssets.join(",") });
      console.log(JSON.stringify(plan, null, 2));
      return;
    }
    const result = await stageSignedRelease(client, request, false);
    invariant(result.state.release, "Staged signed release is missing.");
    appendOutput({
      action: result.plan.action,
      release_id: result.state.release.id,
      release_url: result.state.release.htmlUrl,
    });
    console.log(
      JSON.stringify(
        {
          action: result.plan.action,
          releaseId: result.state.release.id,
          releaseUrl: result.state.release.htmlUrl,
        },
        null,
        2,
      ),
    );
    return;
  }
  throw new Error(
    "Usage: macos-signed-release.ts <fixture|plan-boundary|execute|cleanup|finalize-attestations|preflight|plan|stage> [options]",
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(import.meta.filename)) {
  await main();
}
