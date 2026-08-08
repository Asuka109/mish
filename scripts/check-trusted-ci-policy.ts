import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { parseDocument } from "yaml";

import { readTrustedReleasePolicy, type TrustedReleasePolicy } from "./trusted-release-policy.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fullActionReference = /^(?<name>[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@(?<sha>[0-9a-f]{40})$/u;

interface WorkflowStep {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  environment?: unknown;
  if?: string;
  needs?: unknown;
  permissions?: Record<string, string>;
  "runs-on"?: string | string[];
  steps?: WorkflowStep[];
  uses?: string;
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
  on?: Record<string, unknown>;
  permissions?: Record<string, string>;
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function read(relative: string): string {
  return readFileSync(path.join(repositoryRoot, relative), "utf8");
}

function parseWorkflow(relative: string): { source: string; workflow: Workflow } {
  const source = read(relative);
  const document = parseDocument(source);
  invariant(
    document.errors.length === 0,
    `${relative} is invalid YAML: ${document.errors.join("; ")}`,
  );
  return { source, workflow: document.toJS() as Workflow };
}

function workflowUses(workflow: Workflow): string[] {
  return Object.values(workflow.jobs ?? {}).flatMap((job) => [
    ...(job.uses ? [job.uses] : []),
    ...(job.steps ?? []).flatMap((step) => (step.uses ? [step.uses] : [])),
  ]);
}

export function validateActionReferences(
  policy: TrustedReleasePolicy,
  references: string[],
): string[] {
  const errors: string[] = [];
  for (const reference of references) {
    if (reference.startsWith("./")) continue;
    const match = fullActionReference.exec(reference);
    if (!match?.groups) {
      errors.push(`Action or reusable workflow is not pinned by full SHA: ${reference}`);
      continue;
    }
    const expected = policy.actions.allowed[match.groups.name];
    if (!expected) {
      errors.push(`Action is not allowlisted: ${match.groups.name}`);
      continue;
    }
    if (expected !== match.groups.sha) {
      errors.push(`Action digest drifted: ${match.groups.name}`);
    }
  }
  return errors;
}

export function validateUntrustedWorkflowJob(
  policy: TrustedReleasePolicy,
  job: WorkflowJob,
): string[] {
  const errors: string[] = [];
  const runner = job["runs-on"];
  if (JSON.stringify(runner) !== JSON.stringify(policy.untrusted.runnerLabels[0])) {
    errors.push("untrusted job runner is not the isolated GitHub-hosted runner");
  }
  if (
    JSON.stringify(job.permissions ?? policy.untrusted.permissions) !==
    JSON.stringify(policy.untrusted.permissions)
  ) {
    errors.push("untrusted job permissions exceed contents: read");
  }
  const source = JSON.stringify(job);
  if (source.includes("self-hosted")) errors.push("untrusted job reaches a self-hosted runner");
  if (source.includes("${{ secrets.")) errors.push("untrusted job reads a secret");
  if (source.includes("id-token")) errors.push("untrusted job can mint OIDC tokens");
  if (source.includes("upload-artifact")) errors.push("untrusted job uploads an artifact");
  if (job.uses) errors.push("untrusted job calls a reusable workflow");
  return errors;
}

function assertActionPins(
  policy: TrustedReleasePolicy,
  relative: string,
  workflow: Workflow,
): void {
  const errors = validateActionReferences(policy, workflowUses(workflow));
  invariant(errors.length === 0, `${relative}: ${errors.join("; ")}`);
}

function assertCheckoutIsolation(relative: string, workflow: Workflow): void {
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (!step.uses?.startsWith("actions/checkout@")) continue;
      invariant(
        step.with?.["persist-credentials"] === false,
        `${relative} ${jobName} checkout must not persist the GitHub token.`,
      );
    }
  }
}

function assertNoProtectedExecution(relative: string, source: string, workflow: Workflow): void {
  invariant(
    !source.includes("${{ secrets."),
    `${relative} must not read any secret while disabled.`,
  );
  invariant(
    !source.includes("pull_request_target") &&
      !source.includes("workflow_run") &&
      !source.includes("repository_dispatch"),
    `${relative} contains a privileged or indirect untrusted trigger.`,
  );
  for (const [jobName, job] of Object.entries(workflow.jobs ?? {})) {
    invariant(
      job.environment === undefined,
      `${relative} ${jobName} must not enter an Environment.`,
    );
    for (const [permission, level] of Object.entries(
      job.permissions ?? workflow.permissions ?? {},
    )) {
      invariant(level !== "write", `${relative} ${jobName} grants ${permission}: write.`);
    }
    invariant(!job.uses, `${relative} ${jobName} must not call a reusable workflow.`);
  }
  for (const forbidden of [
    "macos-alpha-release.ts stage",
    "macos-signed-release.ts execute",
    "macos-signed-release.ts finalize-attestations",
    "macos-signed-release.ts stage",
    "gh release create",
    "gh release edit",
    "git push ",
    "git tag ",
  ]) {
    invariant(!source.includes(forbidden), `${relative} can mutate protected state: ${forbidden}`);
  }
}

const policy = readTrustedReleasePolicy();
invariant(policy.schemaVersion === 1, "Trusted release policy schema changed.");
invariant(
  policy.activation.enabled === false && policy.oidc.enabled === false,
  "Protected execution and OIDC must remain disabled until repository protections are available.",
);
invariant(
  policy.repository.name === "Asuka109/mish" &&
    policy.repository.id === "1304960811" &&
    policy.repository.ownerId === "18379948" &&
    policy.repository.trustedRef === "refs/heads/main",
  "Trusted repository identity changed.",
);
invariant(
  policy.dispatch.workflowRef ===
    "Asuka109/mish/.github/workflows/stage-macos-alpha-release.yml@refs/heads/main" &&
    policy.dispatch.toolingRevision === "github.workflow_sha",
  "Trusted workflow and tooling identity changed.",
);
invariant(
  policy.untrusted.allowSecrets === false &&
    policy.untrusted.allowOidc === false &&
    policy.untrusted.allowArtifactUpload === false &&
    policy.untrusted.allowSelfHosted === false &&
    policy.untrusted.allowReusableWorkflowCalls === false,
  "Untrusted CI capabilities must all remain disabled.",
);
invariant(
  policy.protected.allowSelfHosted === false &&
    policy.protected.artifactRetentionDays === 1 &&
    policy.actions.requireFullCommitSha === true &&
    policy.actions.allowedReusableWorkflows.length === 0,
  "Protected runner, artifact retention, action pin, or reusable workflow policy drifted.",
);
invariant(
  JSON.stringify(policy.internalTunAlpha) ===
    JSON.stringify({
      profile: "internal-tun-alpha",
      sourceMustEqualFrozenMain: true,
      candidateRetentionDays: 1,
      stagedRetentionDays: 14,
      requireIndependentReadOnlyVerification: true,
      allowOverwrite: false,
      allowDeveloperId: false,
      allowNotarization: false,
      allowPublicRelease: false,
      allowDeployment: false,
    }),
  "Internal TUN Alpha immutable-staging and internal-only policy drifted.",
);
for (const [name, environment] of Object.entries(policy.protected.environments)) {
  invariant(
    JSON.stringify(environment.requiredReviewerIds) === JSON.stringify(["18379948"]) &&
      environment.allowAdminBypass === false &&
      JSON.stringify(environment.branches) === JSON.stringify(["main"]),
    `${name} Environment protection contract changed.`,
  );
}

const workflowFiles = readdirSync(path.join(repositoryRoot, ".github/workflows"))
  .filter((name) => /\.ya?ml$/u.test(name))
  .sort();
invariant(
  JSON.stringify(workflowFiles) === JSON.stringify(["ci.yml", "stage-macos-alpha-release.yml"]),
  "Workflow inventory changed without extending the trusted CI policy.",
);

const ci = parseWorkflow(".github/workflows/ci.yml");
const release = parseWorkflow(".github/workflows/stage-macos-alpha-release.yml");
assertActionPins(policy, ".github/workflows/ci.yml", ci.workflow);
assertActionPins(policy, ".github/workflows/stage-macos-alpha-release.yml", release.workflow);
assertCheckoutIsolation(".github/workflows/ci.yml", ci.workflow);
assertCheckoutIsolation(".github/workflows/stage-macos-alpha-release.yml", release.workflow);
assertNoProtectedExecution(
  ".github/workflows/stage-macos-alpha-release.yml",
  release.source,
  release.workflow,
);

invariant(
  Object.hasOwn(ci.workflow.on ?? {}, "pull_request"),
  "CI must retain pull_request validation.",
);
const prGate = ci.workflow.jobs?.["pr-gate"];
invariant(prGate, "CI is missing the Fast PR gate.");
const untrustedErrors = validateUntrustedWorkflowJob(policy, prGate);
invariant(untrustedErrors.length === 0, untrustedErrors.join("; "));
invariant(
  prGate.if === "github.event_name == 'pull_request'" &&
    prGate.steps?.some((step) => step.run === "pnpm check:pr"),
  "The untrusted Fast PR gate must remain pull-request-only and run check:pr.",
);
invariant(
  !ci.source.includes("${{ secrets.") &&
    !ci.source.includes("pull_request_target") &&
    !ci.source.includes("workflow_run"),
  "Routine CI contains a secret or privileged trigger.",
);

invariant(
  JSON.stringify(Object.keys(release.workflow.on ?? {})) === JSON.stringify(["workflow_dispatch"]),
  "Release candidate validation must remain manual-only.",
);
invariant(
  JSON.stringify(Object.keys(release.workflow.jobs ?? {})) ===
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
  "Protected execution is disabled; the workflow may contain only credential-free validation and Internal TUN artifact staging jobs.",
);
invariant(
  !release.source.includes("dry_run") &&
    release.source.includes("github.repository_id == '1304960811'") &&
    release.source.includes("github.repository_owner_id == '18379948'") &&
    release.source.includes("github.actor_id == '18379948'") &&
    release.source.includes("github.triggering_actor == github.actor") &&
    release.source.includes("github.workflow_ref ==") &&
    release.source.includes("github.workflow_sha"),
  "Release dispatch does not bind repository, actor, workflow, and tooling identity.",
);
const freeze = release.workflow.jobs?.["freeze-source"];
invariant(
  freeze?.if?.includes("refs/heads/main") &&
    JSON.stringify(freeze.permissions) === JSON.stringify({ contents: "read" }),
  "Source freeze must fail closed on reviewed main with read-only contents.",
);
const verify = release.workflow.jobs?.["verify-candidate"];
const decision = release.workflow.jobs?.["staging-decision"];
const internalBuild = release.workflow.jobs?.["build-internal-tun-candidate"];
const internalVerify = release.workflow.jobs?.["verify-internal-tun-candidate"];
const internalStage = release.workflow.jobs?.["stage-internal-tun-alpha"];
const internalConfirm = release.workflow.jobs?.["confirm-internal-tun-stage"];
invariant(
  internalBuild?.steps?.some(
    (step) =>
      step.name === "Run required repository and package policy checks" &&
      step.run === "pnpm check:pr && pnpm test:macos:bundle",
  ),
  "Internal TUN staging must rerun the Fast PR contract and focused package policy suite.",
);
invariant(
  JSON.stringify(verify?.permissions) === JSON.stringify({ contents: "read" }) &&
    JSON.stringify(decision?.permissions) === JSON.stringify({ contents: "read" }) &&
    JSON.stringify(internalBuild?.permissions) === JSON.stringify({ contents: "read" }) &&
    JSON.stringify(internalVerify?.permissions) === JSON.stringify({ contents: "read" }) &&
    JSON.stringify(internalStage?.permissions) === JSON.stringify({ contents: "read" }) &&
    JSON.stringify(internalConfirm?.permissions) === JSON.stringify({ contents: "read" }),
  "Candidate validation and Internal TUN staging must retain read-only repository permissions.",
);
invariant(
  JSON.stringify(verify?.["runs-on"]) === JSON.stringify("macos-15") &&
    !JSON.stringify(verify).includes("self-hosted"),
  "Candidate code must run only on an unprivileged GitHub-hosted runner.",
);
invariant(
  release.source.includes("trusted-release-policy.ts create-manifest") &&
    release.source.includes("trusted-release-policy.ts verify-manifest") &&
    release.source.includes("artifact-ids: ${{ needs.verify-candidate.outputs.artifact_id }}") &&
    release.source.includes("merge-multiple: true") &&
    release.source.includes("retention-days: 1"),
  "Candidate manifest, immutable artifact ID, and bounded retention are incomplete.",
);
for (const requirement of [
  "internal-tun-alpha-staging.ts assert-request",
  "internal-tun-alpha-staging.ts prepare",
  "verify-internal-tun-alpha-stage.ts verify",
  "internal-tun-alpha-staging.ts finalize",
  "--verification-artifact-name",
  "verify-internal-tun-alpha-stage.ts confirm",
  "overwrite: false",
  "retention-days: 14",
  "Public release or deployment",
]) {
  invariant(
    release.source.includes(requirement),
    `Internal TUN immutable staging boundary is missing ${requirement}.`,
  );
}
invariant(
  internalBuild?.["runs-on"] === "macos-15" &&
    internalVerify?.["runs-on"] === "macos-15" &&
    internalStage?.["runs-on"] === "ubuntu-24.04" &&
    internalConfirm?.["runs-on"] === "macos-15" &&
    !JSON.stringify([internalBuild, internalVerify, internalStage, internalConfirm]).includes(
      "self-hosted",
    ),
  "Internal TUN staging must use only isolated GitHub-hosted runners.",
);

const codeowners = read(".github/CODEOWNERS");
for (const required of policy.codeowners.requiredPaths) {
  invariant(
    codeowners.split("\n").some((line) => line.trim() === `${required} ${policy.codeowners.owner}`),
    `CODEOWNERS does not protect ${required}.`,
  );
}

const packageJson = JSON.parse(read("package.json")) as {
  scripts?: Record<string, string>;
};
invariant(
  packageJson.scripts?.["check:ci"]?.includes("node scripts/check-trusted-ci-policy.ts"),
  "check:ci must run the trusted CI drift check.",
);
invariant(
  packageJson.scripts?.["check:pr"]?.includes("pnpm check:rust:pr") &&
    packageJson.scripts?.["check:rust:pr"] === "pnpm check:rust:clippy" &&
    packageJson.scripts?.["check:rust:clippy"] ===
      "cargo clippy --workspace --all-targets -- -D warnings",
  "The secretless Fast PR gate must retain the bounded workspace/all-target Clippy contract.",
);
invariant(
  packageJson.scripts?.["test:scripts"]?.includes("trusted-release-policy.test.ts"),
  "The Fast PR gate must run trusted release adversarial fixtures.",
);
invariant(
  packageJson.scripts?.["test:scripts"]?.includes("internal-tun-alpha-staging.test.ts"),
  "The Fast PR gate must run Internal TUN immutable-staging adversarial fixtures.",
);
invariant(
  packageJson.scripts?.["test:scripts"]?.includes("audit-github-trust-settings.test.ts"),
  "The Fast PR gate must verify live GitHub trust-settings parsing.",
);
invariant(
  packageJson.scripts?.["audit:ci:trust-settings"] ===
    "node scripts/audit-github-trust-settings.ts",
  "The live GitHub trust-settings audit command is missing.",
);
const renovate = JSON.parse(read(".github/renovate.json")) as {
  packageRules?: Array<Record<string, unknown>>;
};
invariant(
  renovate.packageRules?.some(
    (rule) =>
      JSON.stringify(rule.matchManagers) === JSON.stringify(["github-actions"]) &&
      rule.pinDigests === true,
  ),
  "Renovate must preserve full GitHub Actions digest pinning.",
);

console.log(
  "Trusted CI policy valid: untrusted jobs are secretless and GitHub-hosted; live protected identity is disabled; Internal TUN staging binds frozen workflow/tooling to immutable artifact IDs without signing or publication; action pin, CODEOWNERS, Environment, OIDC, and runner contracts are deterministic.",
);
