import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseDocument } from "yaml";

interface Step {
  env?: Record<string, unknown>;
  id?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Job {
  environment?: unknown;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, string>;
  "runs-on"?: string | string[];
  steps?: Step[];
}

interface Workflow {
  concurrency?: {
    "cancel-in-progress"?: boolean;
    group?: string;
  };
  jobs?: Record<string, Job>;
  on?: {
    workflow_dispatch?: {
      inputs?: Record<
        string,
        {
          default?: unknown;
          options?: string[];
          required?: boolean;
          type?: string;
        }
      >;
    };
  };
  permissions?: Record<string, string>;
}

const repositoryRoot = resolve(import.meta.dirname, "..");
const workflowSource = readFileSync(
  resolve(repositoryRoot, ".github/workflows/stage-macos-alpha-release.yml"),
  "utf8",
);
const releaseScript = readFileSync(
  resolve(repositoryRoot, "scripts/macos-alpha-release.ts"),
  "utf8",
);
const signedReleaseScript = readFileSync(
  resolve(repositoryRoot, "scripts/macos-signed-release.ts"),
  "utf8",
);
const updaterContractScript = readFileSync(
  resolve(repositoryRoot, "scripts/macos-updater-contract.ts"),
  "utf8",
);
const trustedPolicyScript = readFileSync(
  resolve(repositoryRoot, "scripts/trusted-release-policy.ts"),
  "utf8",
);
const document = parseDocument(workflowSource);
const pinnedActions = {
  checkout: "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
  download: "actions/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c",
  node: "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
  pnpm: "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271",
  rust: "Swatinem/rust-cache@e18b497796c12c097a38f9edb9d0641fb99eee32",
  upload: "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a",
} as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

invariant(
  document.errors.length === 0,
  `Invalid macOS release workflow YAML: ${document.errors.join("; ")}`,
);
const workflow = document.toJS() as Workflow;
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

function job(name: string): Job {
  const value = workflow.jobs?.[name];
  invariant(value, `macOS release workflow is missing the ${name} job.`);
  return value;
}

function step(jobValue: Job, name: string): Step {
  const value = jobValue.steps?.find((candidate) => candidate.name === name);
  invariant(value, `macOS release workflow is missing the ${name} step.`);
  return value;
}

function index(jobValue: Job, name: string): number {
  const result = jobValue.steps?.findIndex((candidate) => candidate.name === name) ?? -1;
  invariant(result >= 0, `macOS release workflow is missing the ${name} step.`);
  return result;
}

function assertOrdered(jobValue: Job, names: string[], message: string): void {
  const indices = names.map((name) => index(jobValue, name));
  invariant(
    indices.every((value, position) => position === 0 || value > indices[position - 1]),
    message,
  );
}

invariant(
  JSON.stringify(Object.keys(workflow.on ?? {})) === JSON.stringify(["workflow_dispatch"]),
  "Release candidate validation must remain manual-only.",
);
const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
invariant(
  JSON.stringify(Object.keys(inputs)) === JSON.stringify(["profile", "version", "source_sha"]),
  "Release validation may expose only profile, version, and source_sha.",
);
invariant(
  inputs.profile?.required === true &&
    inputs.profile.type === "choice" &&
    inputs.profile.default === "alpha-ad-hoc" &&
    JSON.stringify(inputs.profile.options) ===
      JSON.stringify(["alpha-ad-hoc", "internal-tun-alpha", "signed-direct"]),
  "Release validation must require one explicit credential-free profile.",
);
invariant(
  inputs.version?.required === true &&
    inputs.version.type === "string" &&
    inputs.source_sha?.required === false &&
    inputs.source_sha.type === "string",
  "Release validation must require a version and accept only an optional source SHA.",
);
invariant(
  JSON.stringify(workflow.permissions) === JSON.stringify({ contents: "read" }),
  "Release workflow default permission must remain contents: read.",
);
invariant(
  workflow.concurrency?.group?.includes("inputs.profile") &&
    workflow.concurrency.group.includes("inputs.version") &&
    workflow.concurrency["cancel-in-progress"] === false,
  "Release candidate concurrency must be profile/version scoped and non-cancelling.",
);
invariant(
  JSON.stringify(Object.keys(workflow.jobs ?? {})) ===
    JSON.stringify([
      "freeze-source",
      "verify-candidate",
      "staging-decision",
      "build-internal-tun-candidate",
      "verify-internal-tun-candidate",
      "stage-internal-tun-alpha",
      "confirm-internal-tun-stage",
      "verify-signed-plan",
    ]),
  "The disabled release workflow may contain only credential-free validation jobs.",
);

for (const [name, candidate] of Object.entries(workflow.jobs ?? {})) {
  invariant(candidate.environment === undefined, `${name} must not enter a protected Environment.`);
  invariant(
    JSON.stringify(candidate.permissions) === JSON.stringify({ contents: "read" }),
    `${name} must independently retain contents: read.`,
  );
  invariant(
    candidate["runs-on"] === "ubuntu-24.04" || candidate["runs-on"] === "macos-15",
    `${name} must run on a GitHub-hosted immutable image.`,
  );
  const candidateSource = JSON.stringify(candidate);
  invariant(
    !candidateSource.includes("self-hosted"),
    `${name} must not reach a self-hosted runner.`,
  );
  invariant(!candidateSource.includes("${{ secrets."), `${name} must not read secrets.`);
  for (const checkout of candidate.steps?.filter((candidateStep) =>
    candidateStep.uses?.startsWith("actions/checkout@"),
  ) ?? []) {
    invariant(
      checkout.uses === pinnedActions.checkout && checkout.with?.["persist-credentials"] === false,
      `${name} must pin checkout and never persist the GitHub token.`,
    );
  }
}
for (const forbidden of [
  "pull_request_target",
  "\npull_request:",
  "workflow_run",
  "repository_dispatch",
  "contents: write",
  "id-token: write",
  "attestations: write",
  "macos-alpha-release.ts stage",
  "macos-signed-release.ts execute",
  "macos-signed-release.ts finalize-attestations",
  "macos-signed-release.ts stage",
  "gh release create",
  "git push ",
  "git tag ",
]) {
  invariant(
    !workflowSource.includes(forbidden),
    `Disabled release workflow contains protected trigger, permission, or mutation: ${forbidden}`,
  );
}

const freeze = job("freeze-source");
invariant(
  freeze.if?.includes("github.repository == 'Asuka109/mish'") &&
    freeze.if.includes("github.repository_id == '1304960811'") &&
    freeze.if.includes("github.repository_owner_id == '18379948'") &&
    freeze.if.includes("github.ref == 'refs/heads/main'") &&
    freeze.if.includes("github.actor_id == '18379948'") &&
    freeze.if.includes("github.triggering_actor == github.actor") &&
    freeze.if.includes("github.workflow_ref ==") &&
    freeze.if.includes("github.workflow_sha == github.sha"),
  "Source freeze must bind repository, event, actor, main ref, and workflow identity before allocation.",
);
invariant(
  freeze.outputs?.tooling_sha === "${{ github.workflow_sha }}" &&
    step(freeze, "Check out frozen main").with?.ref === "${{ github.workflow_sha }}" &&
    step(freeze, "Check out frozen main").with?.["fetch-depth"] === 0,
  "Release tooling must be the exact full-history workflow revision.",
);
const resolveSource = step(freeze, "Resolve exact source and version");
invariant(
  resolveSource.run?.includes('arguments+=(--source "$REQUESTED_SOURCE_SHA")') &&
    resolveSource.run.includes('node scripts/macos-alpha-release.ts "${arguments[@]}"') &&
    !resolveSource.run.includes("${{"),
  "Source resolution must quote the optional input and use reviewed tooling.",
);
const dispatchVerification = step(freeze, "Verify trusted dispatch and frozen ancestry");
for (const binding of [
  "--repository-id",
  "--repository-owner-id",
  "--actor-id",
  "--workflow-ref",
  "--workflow-sha",
  "--tooling-sha",
  "--source-sha",
  "--run-id",
  "--run-attempt",
]) {
  invariant(
    dispatchVerification.run?.includes(binding),
    `Trusted dispatch verification is missing ${binding}.`,
  );
}
invariant(
  step(freeze, "Require exact frozen main for Internal TUN Alpha").run?.includes(
    "internal-tun-alpha-staging.ts assert-request",
  ),
  "Internal TUN Alpha must reject stale or non-main source revisions before building.",
);

const verify = job("verify-candidate");
invariant(
  verify.if === "${{ inputs.profile == 'alpha-ad-hoc' }}" &&
    verify.needs === "freeze-source" &&
    verify["runs-on"] === "macos-15",
  "Alpha candidate build must be explicit, frozen, and GitHub-hosted.",
);
invariant(
  step(verify, "Set up pnpm").uses === pinnedActions.pnpm &&
    step(verify, "Set up Node.js").uses === pinnedActions.node &&
    step(verify, "Cache Rust dependencies and build outputs").uses === pinnedActions.rust,
  "Alpha candidate dependencies must be pinned to reviewed action commits.",
);
assertOrdered(
  verify,
  [
    "Run complete repository validation",
    "Build and inspect Alpha DMG",
    "Generate versioned candidate and release metadata",
    "Bind candidate files to frozen source and tooling",
    "Upload untrusted credential-free candidate",
  ],
  "Alpha validation, build, manifest, and upload order changed.",
);
const candidateUpload = step(verify, "Upload untrusted credential-free candidate");
invariant(
  candidateUpload.id === "candidate-upload" &&
    candidateUpload.uses === pinnedActions.upload &&
    candidateUpload.with?.["if-no-files-found"] === "error" &&
    candidateUpload.with?.["retention-days"] === 1 &&
    verify.outputs?.artifact_id === "${{ steps.candidate-upload.outputs.artifact-id }}",
  "Alpha upload must be exact, immutable-ID-addressed, fail-closed, and one-day retained.",
);

const decision = job("staging-decision");
invariant(
  JSON.stringify(decision.needs) === JSON.stringify(["freeze-source", "verify-candidate"]) &&
    decision["runs-on"] === "ubuntu-24.04",
  "Alpha decision must depend on the exact built candidate.",
);
const download = step(decision, "Download exact immutable candidate");
invariant(
  download.uses === pinnedActions.download &&
    download.with?.["artifact-ids"] === "${{ needs.verify-candidate.outputs.artifact_id }}" &&
    download.with?.["merge-multiple"] === true &&
    download.with?.name === undefined,
  "Alpha decision must download by immutable artifact ID into the exact verified directory, never mutable name.",
);
invariant(
  step(decision, "Verify candidate identity and complete digest set").run?.includes(
    "trusted-release-policy.ts verify-manifest",
  ) &&
    step(decision, "Validate Alpha candidate without mutation").run?.includes(
      "--artifact-directory target/release-candidate",
    ) &&
    JSON.stringify(step(decision, "Write credential-free decision summary")).includes(
      "Project-trusted release",
    ),
  "Alpha decision must rebind the complete candidate and state that it is untrusted.",
);

const internalBuild = job("build-internal-tun-candidate");
const internalBuildSource = JSON.stringify(internalBuild);
invariant(
  internalBuild.if === "${{ inputs.profile == 'internal-tun-alpha' }}" &&
    internalBuild.needs === "freeze-source" &&
    internalBuild["runs-on"] === "macos-15" &&
    !internalBuildSource.includes("GH_TOKEN") &&
    !internalBuildSource.includes("github.token") &&
    !internalBuildSource.includes("${{ secrets."),
  "Internal TUN candidate build must be explicit, frozen, credential-free, and GitHub-hosted.",
);
assertOrdered(
  internalBuild,
  [
    "Run complete repository validation",
    "Build accepted Internal TUN Alpha package",
    "Build deterministic DMG, SBOM, provenance, and immutable candidate manifest",
    "Upload immutable-ID-addressed Internal TUN candidate",
  ],
  "Internal TUN validation, package, evidence, and upload order changed.",
);
const internalCandidateUpload = step(
  internalBuild,
  "Upload immutable-ID-addressed Internal TUN candidate",
);
invariant(
  internalCandidateUpload.id === "candidate-upload" &&
    internalCandidateUpload.uses === pinnedActions.upload &&
    internalCandidateUpload.with?.overwrite === false &&
    internalCandidateUpload.with?.["if-no-files-found"] === "error" &&
    internalCandidateUpload.with?.["retention-days"] === 1 &&
    internalBuild.outputs?.artifact_id === "${{ steps.candidate-upload.outputs.artifact-id }}",
  "Internal TUN candidate upload must be fail-closed, non-overwriting, and ID-addressed.",
);

const internalVerify = job("verify-internal-tun-candidate");
invariant(
  JSON.stringify(internalVerify.needs) ===
    JSON.stringify(["freeze-source", "build-internal-tun-candidate"]) &&
    internalVerify["runs-on"] === "macos-15",
  "Independent Internal TUN verification must use the exact candidate on macOS.",
);
invariant(
  step(internalVerify, "Download exact immutable Internal TUN candidate").with?.["artifact-ids"] ===
    "${{ needs.build-internal-tun-candidate.outputs.artifact_id }}" &&
    step(
      internalVerify,
      "Verify archive, layout, identity, protocol, SBOM, and provenance read-only",
    ).run?.includes("verify-internal-tun-alpha-stage.ts verify"),
  "Internal TUN verification must download by immutable ID and use the independent verifier.",
);
const verificationUpload = step(internalVerify, "Upload immutable verification evidence");
invariant(
  verificationUpload.id === "verification-upload" &&
    verificationUpload.uses === pinnedActions.upload &&
    verificationUpload.with?.overwrite === false &&
    verificationUpload.with?.["retention-days"] === 1,
  "Internal TUN verification evidence must be immutable and one-day retained.",
);

const internalStage = job("stage-internal-tun-alpha");
invariant(
  JSON.stringify(internalStage.needs) ===
    JSON.stringify([
      "freeze-source",
      "build-internal-tun-candidate",
      "verify-internal-tun-candidate",
    ]) && internalStage["runs-on"] === "ubuntu-24.04",
  "Internal TUN staging must depend on both immutable candidate and verification artifacts.",
);
assertOrdered(
  internalStage,
  [
    "Download exact candidate by immutable ID",
    "Download exact verification by immutable ID",
    "Bind candidate and verification into one final immutable stage",
    "Upload final immutable Internal TUN Alpha stage",
  ],
  "Internal TUN final staging order changed.",
);
const stageUpload = step(internalStage, "Upload final immutable Internal TUN Alpha stage");
invariant(
  step(
    internalStage,
    "Bind candidate and verification into one final immutable stage",
  ).run?.includes("--verification-artifact-name") &&
    stageUpload.id === "stage-upload" &&
    stageUpload.uses === pinnedActions.upload &&
    stageUpload.with?.overwrite === false &&
    stageUpload.with?.["if-no-files-found"] === "error" &&
    stageUpload.with?.["retention-days"] === 14 &&
    internalStage.outputs?.artifact_id === "${{ steps.stage-upload.outputs.artifact-id }}",
  "Internal TUN final stage must be non-overwriting, ID-addressed, and 14-day retained.",
);

const internalConfirmation = job("confirm-internal-tun-stage");
invariant(
  JSON.stringify(internalConfirmation.needs) ===
    JSON.stringify(["freeze-source", "stage-internal-tun-alpha"]) &&
    internalConfirmation["runs-on"] === "macos-15",
  "Internal TUN success must require a final read-only macOS confirmation.",
);
assertOrdered(
  internalConfirmation,
  [
    "Download final stage by immutable ID",
    "Reverify final stage and DMG read-only",
    "Write successful Internal TUN Alpha staging summary",
  ],
  "Internal TUN final confirmation and success-summary order changed.",
);
invariant(
  step(internalConfirmation, "Reverify final stage and DMG read-only").run?.includes(
    "verify-internal-tun-alpha-stage.ts confirm",
  ) &&
    JSON.stringify(
      step(internalConfirmation, "Write successful Internal TUN Alpha staging summary"),
    ).includes("Public release or deployment"),
  "Internal TUN success must follow immutable-ID reverification and preserve internal-only copy.",
);

const signedPlan = job("verify-signed-plan");
invariant(
  signedPlan.if === "${{ inputs.profile == 'signed-direct' }}" &&
    signedPlan.needs === "freeze-source" &&
    signedPlan["runs-on"] === "macos-15",
  "Signed-direct validation must remain explicit and credential-free.",
);
assertOrdered(
  signedPlan,
  [
    "Run complete repository validation",
    "Validate credential-free signed boundary plan",
    "Run adversarial trusted-boundary fixtures",
    "Verify updater artifact contract fixture",
    "Write disabled protected-path summary",
  ],
  "Signed planning, adversarial fixtures, updater fixture, and summary are out of order.",
);
invariant(
  step(signedPlan, "Validate credential-free signed boundary plan").run?.includes(
    "--dry-run true",
  ) &&
    step(signedPlan, "Run adversarial trusted-boundary fixtures").run ===
      "node .release-tooling/scripts/trusted-release-policy.ts fixture" &&
    JSON.stringify(step(signedPlan, "Write disabled protected-path summary")).includes(
      "Protected signing / notarization",
    ),
  "Signed validation must be fixture-only and state that all protected paths are disabled.",
);

for (const action of Object.values(pinnedActions)) {
  invariant(workflowSource.includes(action), `Workflow is missing reviewed action pin ${action}.`);
}
for (const required of [
  "runTrustedReleaseAdversarialFixture",
  "validateProtectedCandidate",
  "validateProtectedRequest",
  "verifyCandidateManifest",
  "protected execution is disabled",
  "reusable workflow caller is not trusted",
  "Candidate files, sizes, roles, or digests changed",
]) {
  invariant(
    trustedPolicyScript.includes(required),
    `Trusted release policy is missing ${required}.`,
  );
}
invariant(
  releaseScript.includes("/releases?per_page=100&page=") &&
    !releaseScript.includes("/releases/tags/") &&
    signedReleaseScript.includes("/releases?per_page=100&page=") &&
    !signedReleaseScript.includes("/releases/tags/"),
  "Read-only release planning must continue to observe Draft releases.",
);
for (const required of [
  "Signed release evidence",
  "runSensitive(",
  "cleanupSigningMaterials",
  "artifact-identity-confirmed",
  "candidateUploaded",
]) {
  invariant(
    signedReleaseScript.includes(required),
    `Offline signed-release contract is missing ${required}.`,
  );
}
for (const required of [
  "Mish-${version}-aarch64.app.tar.gz",
  "mish-${channel}.json",
  "darwin-aarch64",
  "artifact_sha256",
  "source_sha",
  'privateKey: "not-present"',
  'network: "not-used"',
]) {
  invariant(
    updaterContractScript.includes(required),
    `Updater artifact contract is missing ${required}.`,
  );
}
invariant(
  packageJson.scripts?.["release:macos:fixture"] ===
    "node scripts/macos-alpha-release.ts fixture" &&
    packageJson.scripts?.["release:macos:signed:fixture"] ===
      "node scripts/macos-signed-release.ts fixture" &&
    packageJson.scripts?.["release:macos:updater:fixture"] ===
      "node scripts/macos-updater-contract.ts fixture" &&
    packageJson.scripts?.["release:trusted-boundary:fixture"] ===
      "node scripts/trusted-release-policy.ts fixture" &&
    packageJson.scripts?.["test:macos:internal-tun-alpha"]?.includes(
      "internal-tun-alpha-staging.test.ts",
    ),
  "Credential-free release and trusted-boundary fixture commands are incomplete.",
);

console.log(
  "macOS release workflow valid: frozen reviewed main, exact source/tooling identity, immutable Internal TUN Alpha candidate/verification/stage IDs, credential-free fixtures, and no live signing, notarization, public release, or deployment path.",
);
