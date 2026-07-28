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

function assertTrustedSelfHostedJob(
  policy: TrustedReleasePolicy,
  relative: string,
  jobName: string,
  job: WorkflowJob,
): void {
  invariant(
    JSON.stringify(job["runs-on"]) === JSON.stringify(policy.trustedSelfHostedCi.runnerLabels),
    `${relative} ${jobName} does not use the exact dedicated runner labels.`,
  );
  invariant(
    JSON.stringify(job.permissions ?? { contents: "read" }) ===
      JSON.stringify({ contents: "read" }),
    `${relative} ${jobName} must retain contents: read.`,
  );
  invariant(!job.uses, `${relative} ${jobName} must not call a reusable workflow.`);
  const source = JSON.stringify(job);
  invariant(!source.includes("${{ secrets."), `${relative} ${jobName} reads a secret.`);
  invariant(!source.includes("id-token"), `${relative} ${jobName} can mint OIDC tokens.`);
  const boundary = job.steps?.[0];
  invariant(
    boundary?.name === "Verify dedicated runner boundary" &&
      boundary.run?.includes(`"$RUNNER_NAME" = "${policy.trustedSelfHostedCi.runnerName}"`) &&
      boundary.run.includes(`"$(id -un)" = "${policy.trustedSelfHostedCi.runnerUser}"`) &&
      boundary.run.includes("ACTIONS_RUNNER_HOOK_JOB_STARTED") &&
      boundary.run.includes("ACTIONS_RUNNER_HOOK_JOB_COMPLETED") &&
      boundary.run.includes("/dev/console"),
    `${relative} ${jobName} does not fail closed on runner identity, account, hooks, and console isolation.`,
  );
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
  policy.untrusted.allowedEvents.length === 0 &&
    policy.untrusted.runnerLabels.length === 0 &&
    policy.untrusted.allowSecrets === false &&
    policy.untrusted.allowOidc === false &&
    policy.untrusted.allowArtifactUpload === false &&
    policy.untrusted.allowSelfHosted === false &&
    policy.untrusted.allowReusableWorkflowCalls === false,
  "Untrusted CI capabilities must all remain disabled.",
);
invariant(
  policy.trustedSelfHostedCi.enabled === true &&
    policy.trustedSelfHostedCi.repositoryOnly === true &&
    policy.trustedSelfHostedCi.runnerName === "mish-macos-arm64-01" &&
    policy.trustedSelfHostedCi.runnerUser === "mish-ci" &&
    JSON.stringify(policy.trustedSelfHostedCi.runnerLabels) ===
      JSON.stringify(["self-hosted", "macOS", "ARM64", "mish", "trusted-ci"]) &&
    JSON.stringify(policy.trustedSelfHostedCi.allowedEvents) ===
      JSON.stringify(["pull_request_target", "push", "schedule", "workflow_dispatch"]) &&
    JSON.stringify(policy.trustedSelfHostedCi.actorIds) === JSON.stringify(["18379948"]) &&
    policy.trustedSelfHostedCi.trustedRef === "refs/heads/main" &&
    policy.trustedSelfHostedCi.concurrencyGroup === "mish-self-hosted-ci" &&
    policy.trustedSelfHostedCi.pullRequest.event === "pull_request_target" &&
    policy.trustedSelfHostedCi.pullRequest.baseBranch === "main" &&
    policy.trustedSelfHostedCi.pullRequest.requireSameRepository === true &&
    policy.trustedSelfHostedCi.pullRequest.checkoutHeadSha === true &&
    policy.trustedSelfHostedCi.pullRequest.allowForks === false &&
    policy.trustedSelfHostedCi.pullRequest.allowMergeRefs === false &&
    policy.trustedSelfHostedCi.hooks.requireInactiveConsoleUser === true &&
    policy.trustedSelfHostedCi.allowSecrets === false &&
    policy.trustedSelfHostedCi.allowOidc === false &&
    policy.trustedSelfHostedCi.allowReusableWorkflowCalls === false &&
    policy.trustedSelfHostedCi.offlinePolicy === "queue-without-hosted-fallback",
  "Trusted self-hosted CI identity, routing, hook, or offline policy drifted.",
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
for (const [jobName, job] of Object.entries(ci.workflow.jobs ?? {})) {
  assertTrustedSelfHostedJob(policy, ".github/workflows/ci.yml", jobName, job);
}
for (const [jobName, job] of Object.entries(release.workflow.jobs ?? {})) {
  assertTrustedSelfHostedJob(
    policy,
    ".github/workflows/stage-macos-alpha-release.yml",
    jobName,
    job,
  );
}

invariant(
  Object.hasOwn(ci.workflow.on ?? {}, "pull_request_target") &&
    !Object.hasOwn(ci.workflow.on ?? {}, "pull_request"),
  "CI must use the default-branch pull_request_target definition, never an unreviewed merge-ref workflow.",
);
const prGate = ci.workflow.jobs?.["pr-gate"];
invariant(prGate, "CI is missing the Fast PR gate.");
const prCheckout = prGate.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
invariant(
  prGate.if?.includes("github.event_name == 'pull_request_target'") &&
    prGate.if.includes("github.actor_id == '18379948'") &&
    prGate.if.includes("github.event.pull_request.head.repo.id == 1304960811") &&
    prGate.if.includes("github.event.pull_request.head.repo.full_name == 'Asuka109/mish'") &&
    prGate.if.includes("github.workflow_ref ==") &&
    prGate.if.includes("github.workflow_sha == github.sha") &&
    prCheckout?.with?.ref === "${{ github.event.pull_request.head.sha }}" &&
    prGate.steps?.some((step) => step.run === "pnpm check:pr"),
  "The trusted Fast PR gate must bind owner, same-repository head SHA, default workflow, and check:pr.",
);
invariant(
  !ci.source.includes("${{ secrets.") &&
    !ci.source.includes("\n  pull_request:\n") &&
    !ci.source.includes("refs/pull/") &&
    !ci.source.includes("workflow_run"),
  "Routine CI contains a secret, merge-ref trigger, or indirect trigger.",
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
  JSON.stringify(verify?.permissions) === JSON.stringify({ contents: "read" }) &&
    JSON.stringify(decision?.permissions) === JSON.stringify({ contents: "read" }) &&
    JSON.stringify(internalBuild?.permissions) === JSON.stringify({ contents: "read" }) &&
    JSON.stringify(internalVerify?.permissions) === JSON.stringify({ contents: "read" }) &&
    JSON.stringify(internalStage?.permissions) === JSON.stringify({ contents: "read" }) &&
    JSON.stringify(internalConfirm?.permissions) === JSON.stringify({ contents: "read" }),
  "Candidate validation and Internal TUN staging must retain read-only repository permissions.",
);
invariant(
  JSON.stringify(verify?.["runs-on"]) === JSON.stringify(policy.trustedSelfHostedCi.runnerLabels),
  "Credential-free candidate code must use the exact dedicated trusted runner.",
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
  [internalBuild, internalVerify, internalStage, internalConfirm].every(
    (job) =>
      JSON.stringify(job?.["runs-on"]) === JSON.stringify(policy.trustedSelfHostedCi.runnerLabels),
  ),
  "Internal TUN staging must use only the exact dedicated trusted runner.",
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
  packageJson.scripts?.["test:scripts"]?.includes("self-hosted-runner-policy.test.ts"),
  "The Fast PR gate must verify self-hosted runner hygiene and no-GUI policy.",
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
  "Trusted CI policy valid: every job uses the dedicated owner-only macOS runner, PRs use the default workflow and exact same-repository head SHA, external/untrusted execution is disabled, protected signing remains disabled, and action, hook, cleanup, CODEOWNERS, Environment, OIDC, and immutable-artifact contracts are deterministic.",
);
