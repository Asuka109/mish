import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

type Step = {
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Job = {
  environment?: { name?: string } | string;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, unknown>;
  permissions?: Record<string, string>;
  steps?: Step[];
};

type Workflow = {
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
          description?: string;
          options?: string[];
          required?: boolean;
          type?: string;
        }
      >;
    };
  };
  permissions?: Record<string, string>;
};

const repositoryRoot = resolve(import.meta.dirname, "..");
const workflowPath = resolve(repositoryRoot, ".github/workflows/stage-macos-alpha-release.yml");
const source = readFileSync(workflowPath, "utf8");
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
const alphaDmgVerifier = readFileSync(
  resolve(repositoryRoot, "scripts/verify-macos-alpha-ad-hoc-dmg.ts"),
  "utf8",
);
const alphaBundleBuilder = readFileSync(
  resolve(repositoryRoot, "scripts/build-macos-bundle.ts"),
  "utf8",
);
const document = parseDocument(source);

if (document.errors.length > 0) {
  throw new Error(`Invalid macOS release workflow YAML: ${document.errors.join("; ")}`);
}

const workflow = document.toJS() as Workflow;
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

const alphaCondition = "${{ inputs.profile == 'alpha-ad-hoc' }}";
const signedCondition = "${{ inputs.profile == 'signed-direct' }}";
const signedLiveCondition = "${{ inputs.profile == 'signed-direct' && inputs.dry_run == false }}";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

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
  const value = jobValue.steps?.findIndex((candidate) => candidate.name === name) ?? -1;
  invariant(value >= 0, `macOS release workflow is missing the ${name} step.`);
  return value;
}

function assertOrdered(jobValue: Job, names: string[], message: string): void {
  const indices = names.map((name) => index(jobValue, name));
  invariant(
    indices.every((value, position) => position === 0 || value > indices[position - 1]),
    message,
  );
}

function jobSource(jobValue: Job): string {
  return JSON.stringify(jobValue);
}

const triggers = Object.keys(workflow.on ?? {});
invariant(
  JSON.stringify(triggers) === JSON.stringify(["workflow_dispatch"]),
  "Release staging must be reachable only through workflow_dispatch.",
);
const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
invariant(
  JSON.stringify(Object.keys(inputs)) ===
    JSON.stringify(["profile", "version", "source_sha", "dry_run"]),
  "Run workflow must expose only profile, version, source_sha, and dry_run.",
);
invariant(
  inputs.profile?.required === true &&
    inputs.profile.type === "choice" &&
    inputs.profile.default === "alpha-ad-hoc" &&
    JSON.stringify(inputs.profile.options) === JSON.stringify(["alpha-ad-hoc", "signed-direct"]),
  "Run workflow must select alpha-ad-hoc or signed-direct explicitly.",
);
invariant(
  inputs.version?.required === true && inputs.version.type === "string",
  "Run workflow must require the prerelease version string.",
);
invariant(
  inputs.source_sha?.required === false && inputs.source_sha.type === "string",
  "Run workflow source SHA must be an optional string.",
);
invariant(
  inputs.dry_run?.required === true &&
    inputs.dry_run.type === "boolean" &&
    inputs.dry_run.default === true,
  "Run workflow must default its required dry-run guard to true.",
);
invariant(
  JSON.stringify(workflow.permissions) === JSON.stringify({ contents: "read" }),
  "Release workflow default permissions must be contents: read only.",
);
invariant(
  workflow.concurrency?.group?.includes("inputs.profile") &&
    workflow.concurrency.group.includes("inputs.version"),
  "Release concurrency must be scoped by explicit profile and version.",
);
invariant(
  workflow.concurrency?.["cancel-in-progress"] === false,
  "Release concurrency must never cancel another candidate.",
);

const expectedJobs = [
  "freeze-source",
  "verify-candidate",
  "staging-decision",
  "stage-draft",
  "verify-signed-plan",
  "execute-signed-release",
  "attest-signed-candidate",
  "signed-staging-decision",
  "stage-signed-draft",
];
invariant(
  JSON.stringify(Object.keys(workflow.jobs ?? {})) === JSON.stringify(expectedJobs),
  "Release workflow job boundary changed unexpectedly.",
);

for (const [name, candidate] of Object.entries(workflow.jobs ?? {})) {
  const contents = candidate.permissions?.contents ?? workflow.permissions?.contents;
  invariant(
    contents === (name === "stage-draft" || name === "stage-signed-draft" ? "write" : "read"),
    `${name} has the wrong contents permission.`,
  );
  for (const checkout of candidate.steps?.filter((candidateStep) =>
    candidateStep.uses?.startsWith("actions/checkout@"),
  ) ?? []) {
    invariant(
      checkout.with?.["persist-credentials"] === false,
      `${name} checkout must not persist the GitHub token.`,
    );
  }
  const runsNodeScript = (candidate.steps ?? []).some((candidateStep) =>
    /\bnode\s+/.test(candidateStep.run ?? ""),
  );
  if (runsNodeScript) {
    const setupIndex = (candidate.steps ?? []).findIndex((candidateStep) =>
      candidateStep.uses?.startsWith("actions/setup-node@"),
    );
    const firstNodeIndex = (candidate.steps ?? []).findIndex((candidateStep) =>
      /\bnode\s+/.test(candidateStep.run ?? ""),
    );
    const setupNode = candidate.steps?.[setupIndex];
    invariant(
      setupNode?.uses === "actions/setup-node@v7" &&
        String(setupNode.with?.["node-version"]) === "24" &&
        firstNodeIndex > setupIndex,
      `${name} must set up Node.js 24 before any TypeScript release script.`,
    );
  }
}

invariant(
  !source.includes("pull_request_target") && !source.includes("\npull_request:"),
  "Pull requests and forks must not reach release staging.",
);
invariant(
  releaseScript.includes("/releases?per_page=100&page=") &&
    !releaseScript.includes("/releases/tags/"),
  "Alpha release state must use authenticated listing so Drafts are visible.",
);
invariant(
  signedReleaseScript.includes("/releases?per_page=100&page=") &&
    !signedReleaseScript.includes("/releases/tags/"),
  "Signed release state must use authenticated listing so Drafts are visible.",
);
invariant(
  alphaBundleBuilder.includes('["desktop:bundle:verify:alpha-ad-hoc:macos"]') &&
    alphaBundleBuilder.includes('packageEnvironment.CI = "true"') &&
    alphaBundleBuilder.includes("delete packageEnvironment.TAURI_BUNDLER_DMG_IGNORE_CI") &&
    alphaDmgVerifier.includes('["attach", "-readonly", "-nobrowse", dmg]') &&
    alphaDmgVerifier.includes('["detach", mountpoint]') &&
    !alphaDmgVerifier.includes('["detach", "-force"'),
  "The Alpha headless read-only DMG inspection and clean detach contract changed.",
);

const freeze = job("freeze-source");
const sourceStep = step(freeze, "Resolve exact source and version");
invariant(
  step(freeze, "Check out current main").with?.ref === "main" &&
    step(freeze, "Check out current main").with?.["fetch-depth"] === 0,
  "Source freeze must check out complete main history.",
);
invariant(
  sourceStep.run?.includes('arguments+=(--source "$REQUESTED_SOURCE_SHA")') &&
    sourceStep.run.includes('node scripts/macos-alpha-release.ts "${arguments[@]}"') &&
    !sourceStep.run.includes("${{"),
  "Source resolution must pass optional dispatch input as one quoted environment argument.",
);
invariant(
  freeze.outputs?.tooling_sha === "${{ steps.source.outputs.main_sha }}",
  "Release tooling must freeze to the same main commit used for reachability.",
);
invariant(
  String(freeze.outputs?.signed_candidate_artifact_name).endsWith("-${{ github.run_attempt }}") &&
    String(freeze.outputs?.signed_protected_artifact_name).endsWith("-${{ github.run_attempt }}"),
  "Signed artifacts must be unique to each workflow run attempt.",
);
const alphaPreflight = step(freeze, "Fail fast on conflicting tag or Release");
const signedPreflight = step(freeze, "Fail fast on conflicting signed tag or Release");
invariant(
  alphaPreflight.if === alphaCondition &&
    alphaPreflight.run?.includes("scripts/macos-alpha-release.ts plan"),
  "Alpha preflight must preserve its existing read-only release decision.",
);
invariant(
  signedPreflight.if === signedCondition &&
    signedPreflight.run?.includes("scripts/macos-signed-release.ts preflight"),
  "Signed preflight must use the signed release contract independently.",
);

const alphaJobs = [job("verify-candidate"), job("staging-decision"), job("stage-draft")];
invariant(
  alphaJobs[0].if === alphaCondition &&
    alphaJobs[1].if === alphaCondition &&
    alphaJobs[2].if === "${{ inputs.profile == 'alpha-ad-hoc' && inputs.dry_run == false }}",
  "Alpha jobs must remain selected only by the explicit alpha-ad-hoc profile.",
);
for (const candidate of alphaJobs) {
  invariant(
    !jobSource(candidate).includes("${{ secrets."),
    "The Alpha path must remain credential-free.",
  );
}

const verify = job("verify-candidate");
invariant(verify.needs === "freeze-source", "Alpha verification must depend on source freeze.");
invariant(
  step(verify, "Check out frozen source").with?.ref ===
    "${{ needs.freeze-source.outputs.source_sha }}",
  "Alpha verification must check out only the frozen source SHA.",
);
for (const candidate of [
  verify,
  job("staging-decision"),
  job("stage-draft"),
  job("verify-signed-plan"),
  job("execute-signed-release"),
  job("attest-signed-candidate"),
  job("signed-staging-decision"),
  job("stage-signed-draft"),
]) {
  const tooling = step(candidate, "Check out frozen release tooling");
  invariant(
    tooling.with?.ref === "${{ needs.freeze-source.outputs.tooling_sha }}" &&
      tooling.with?.path === ".release-tooling",
    "Release jobs must use frozen main tooling in an isolated checkout.",
  );
}
invariant(
  step(verify, "Run complete repository validation").run === "pnpm check:all" &&
    step(verify, "Build and inspect Alpha DMG").run === "pnpm desktop:bundle:macos",
  "Alpha validation and #168 DMG build must remain unchanged.",
);
assertOrdered(
  verify,
  [
    "Run complete repository validation",
    "Build and inspect Alpha DMG",
    "Generate versioned candidate, checksums, and metadata",
    "Upload verified staging candidate",
  ],
  "Alpha validation, build, evidence, and upload are out of order.",
);
const alphaUpload = step(verify, "Upload verified staging candidate");
invariant(
  alphaUpload.uses === "actions/upload-artifact@v7" &&
    alphaUpload.if === undefined &&
    alphaUpload.with?.["if-no-files-found"] === "error" &&
    alphaUpload.with?.["retention-days"] === 1,
  "Alpha candidate upload must remain fail closed and short lived.",
);
invariant(
  JSON.stringify(job("staging-decision").needs) ===
    JSON.stringify(["freeze-source", "verify-candidate"]) &&
    step(job("staging-decision"), "Validate artifacts and decide staging").run?.includes(
      "--artifact-directory target/release-candidate",
    ),
  "Alpha dry-run staging must require and inspect the verified candidate.",
);
invariant(
  JSON.stringify(job("stage-draft").permissions) === JSON.stringify({ contents: "write" }) &&
    JSON.stringify(job("stage-draft").needs) ===
      JSON.stringify(["freeze-source", "verify-candidate", "staging-decision"]) &&
    step(job("stage-draft"), "Stage immutable tag and Draft Pre-release").run?.includes(
      ".release-tooling/scripts/macos-alpha-release.ts stage",
    ),
  "Alpha Draft staging must preserve its final isolated write boundary.",
);

const signedPlan = job("verify-signed-plan");
invariant(
  signedPlan.if === signedCondition &&
    signedPlan.needs === "freeze-source" &&
    signedPlan.environment === undefined,
  "Credential-free signed planning must not cross the protected Environment.",
);
invariant(
  step(signedPlan, "Run complete repository validation").run === "pnpm check:all" &&
    step(signedPlan, "Validate signed release boundary plan").run?.includes(
      "macos-signed-release.ts plan-boundary",
    ) &&
    step(signedPlan, "Verify updater artifact contract fixture").run ===
      "node .release-tooling/scripts/macos-updater-contract.ts fixture",
  "Signed planning must run complete validation and the credential-free boundary contract.",
);
assertOrdered(
  signedPlan,
  [
    "Run complete repository validation",
    "Validate signed release boundary plan",
    "Verify updater artifact contract fixture",
    "Write credential-free signed plan summary",
  ],
  "Signed planning and updater fixture verification are out of order.",
);
invariant(
  !jobSource(signedPlan).includes("${{ secrets.") &&
    jobSource(step(signedPlan, "Write credential-free signed plan summary")).includes(
      "not observed by this job",
    ),
  "Credential-free planning must not read secrets or claim a live Apple result.",
);

const execute = job("execute-signed-release");
invariant(
  execute.if === signedLiveCondition &&
    JSON.stringify(execute.needs) === JSON.stringify(["freeze-source", "verify-signed-plan"]) &&
    JSON.stringify(execute.environment) === JSON.stringify({ name: "macos-developer-id" }) &&
    JSON.stringify(execute.permissions) === JSON.stringify({ contents: "read" }),
  "Real signing must require explicit live selection and the protected Environment.",
);
const executeStep = step(execute, "Execute protected signed release");
const cleanupStep = step(execute, "Guarantee temporary signing cleanup");
const protectedUpload = step(execute, "Upload protected signed evidence");
const credentialNames = [
  "MISH_APPLE_CERTIFICATE_BASE64",
  "MISH_APPLE_CERTIFICATE_PASSWORD",
  "MISH_APPLE_SIGNING_IDENTITY",
  "MISH_APPLE_NOTARY_API_ISSUER_ID",
  "MISH_APPLE_NOTARY_API_KEY_ID",
  "MISH_APPLE_NOTARY_API_PRIVATE_KEY",
];
for (const credential of credentialNames) {
  invariant(
    executeStep.env?.[credential] === `\${{ secrets.${credential} }}`,
    `Protected execution must receive exact Environment secret ${credential}.`,
  );
  const occurrences = source.split(`secrets.${credential}`).length - 1;
  invariant(occurrences === 1, `${credential} must appear only at protected execution.`);
}
invariant(
  executeStep.run?.includes("macos-signed-release.ts execute") &&
    executeStep.run.includes("--dry-run false") &&
    cleanupStep.if === "${{ always() && steps.signed-release.outcome != 'skipped' }}" &&
    cleanupStep.run?.includes("macos-signed-release.ts cleanup"),
  "Protected execution and defense-in-depth cleanup are incomplete.",
);
assertOrdered(
  execute,
  [
    "Execute protected signed release",
    "Guarantee temporary signing cleanup",
    "Upload protected signed evidence",
  ],
  "Protected execution must clean up before any evidence upload.",
);
invariant(
  protectedUpload.uses === "actions/upload-artifact@v7" &&
    protectedUpload.with?.["if-no-files-found"] === "error" &&
    protectedUpload.with?.["retention-days"] === 1,
  "Protected signed evidence upload must fail closed and remain short lived.",
);

const attestation = job("attest-signed-candidate");
invariant(
  attestation.if === signedLiveCondition &&
    JSON.stringify(attestation.needs) ===
      JSON.stringify(["freeze-source", "execute-signed-release"]) &&
    JSON.stringify(attestation.permissions) ===
      JSON.stringify({
        "artifact-metadata": "write",
        attestations: "write",
        contents: "read",
        "id-token": "write",
      }),
  "Attestation must have only the GitHub permissions required for exact provenance.",
);
const provenance = step(attestation, "Generate exact DMG provenance");
const sbom = step(attestation, "Generate exact DMG SBOM attestation");
invariant(
  provenance.uses === "actions/attest@v4" &&
    sbom.uses === "actions/attest@v4" &&
    provenance.with?.["subject-path"] === sbom.with?.["subject-path"] &&
    sbom.with?.["sbom-path"] === "target/signed-release-candidate/macos-sbom.spdx.json",
  "Provenance and SBOM attestations must bind the same exact final DMG.",
);
assertOrdered(
  attestation,
  [
    "Download protected signed evidence",
    "Generate exact DMG provenance",
    "Generate exact DMG SBOM attestation",
    "Finalize attested candidate identity",
    "Upload exact signed staging candidate",
  ],
  "Signed candidate attestation, final identity, and upload are out of order.",
);
invariant(
  step(attestation, "Finalize attested candidate identity").run?.includes(
    "macos-signed-release.ts finalize-attestations",
  ) &&
    step(attestation, "Upload exact signed staging candidate").with?.["if-no-files-found"] ===
      "error",
  "The exact attested candidate must finalize and upload fail closed.",
);

const signedDecision = job("signed-staging-decision");
invariant(
  signedDecision.if === signedLiveCondition &&
    JSON.stringify(signedDecision.needs) ===
      JSON.stringify(["freeze-source", "attest-signed-candidate"]) &&
    step(signedDecision, "Verify downloaded DMG attestations").run?.includes(
      "gh attestation verify",
    ) &&
    step(signedDecision, "Verify downloaded DMG attestations").run?.includes(
      "https://spdx.dev/Document/v2.3",
    ) &&
    step(signedDecision, "Validate signed candidate and decide staging").run?.includes(
      "--artifact-directory target/signed-release-candidate",
    ) &&
    step(signedDecision, "Validate signed candidate and decide staging").run?.includes(
      '--candidate-artifact-id "$CANDIDATE_ARTIFACT_ID"',
    ),
  "Signed staging decisions must require the uploaded exact attested candidate.",
);
const signedStage = job("stage-signed-draft");
invariant(
  signedStage.if === signedLiveCondition &&
    JSON.stringify(signedStage.needs) ===
      JSON.stringify(["freeze-source", "attest-signed-candidate", "signed-staging-decision"]) &&
    JSON.stringify(signedStage.permissions) === JSON.stringify({ contents: "write" }) &&
    step(signedStage, "Stage immutable signed tag and Draft Pre-release").run?.includes(
      "macos-signed-release.ts stage",
    ) &&
    step(signedStage, "Stage immutable signed tag and Draft Pre-release").run?.includes(
      '--candidate-artifact-id "$CANDIDATE_ARTIFACT_ID"',
    ),
  "Signed Draft staging must be the final write boundary after all exact evidence gates.",
);

const liveExecution = signedReleaseScript.slice(
  signedReleaseScript.indexOf("export function executeProtectedSignedRelease"),
  signedReleaseScript.indexOf("export function finalizeSignedReleaseCandidate"),
);
const orderedCommands = [
  "importSigningIdentity",
  "verifyImportedIdentity",
  "desktop:bundle:signed-direct:macos",
  "createSignedDistribution",
  "submitAndCheckNotary",
  "stapler",
  "codesign",
  "spctl",
  "generateSignedReleaseSbom",
  "cleanupSigningMaterials",
];
let previous = -1;
for (const command of orderedCommands) {
  const current = liveExecution.indexOf(command, previous + 1);
  invariant(current > previous, `Signed release execution is missing ordered stage ${command}.`);
  previous = current;
}
for (const required of [
  "signedReleaseStages",
  "runUpdaterContractFixture",
  "temporary locked keychain created",
  "Apple notarization failed closed",
  "failed without exposing command arguments",
  "ticket-validated",
  "distribution-assessed",
  "artifact-identity-confirmed",
  "candidateUploaded",
  "rmSync(paths.root",
]) {
  invariant(
    signedReleaseScript.includes(required),
    `Signed release contract is missing ${required}.`,
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
  signedReleaseScript.includes("runSensitive(") &&
    !signedReleaseScript.includes('run("security", ["create-keychain"') &&
    !signedReleaseScript.includes('run("security", ["unlock-keychain"') &&
    !signedReleaseScript.includes('run("security", ["import"') &&
    !signedReleaseScript.includes('run("security", ["set-key-partition-list"'),
  "Protected certificate and keychain commands must fail without exposing secret arguments.",
);

const runSources = Object.values(workflow.jobs ?? {})
  .flatMap((candidate) => candidate.steps ?? [])
  .map((candidate) => candidate.run ?? "")
  .join("\n");
for (const forbidden of [
  "gh release create",
  "gh release edit",
  "git tag ",
  "git push ",
  "--force",
  "make_latest",
  "altool",
]) {
  invariant(
    !runSources.includes(forbidden),
    `Workflow shell must not contain unsafe or obsolete release mutation: ${forbidden}`,
  );
}

invariant(
  packageJson.scripts?.["release:macos:fixture"] ===
    "node scripts/macos-alpha-release.ts fixture" &&
    packageJson.scripts?.["test:macos:release"] ===
      "node --test scripts/macos-alpha-release.test.ts",
  "Existing Alpha deterministic fixtures must remain unchanged.",
);
invariant(
  packageJson.scripts?.["release:macos:signed:fixture"] ===
    "node scripts/macos-signed-release.ts fixture" &&
    packageJson.scripts?.["release:macos:updater:fixture"] ===
      "node scripts/macos-updater-contract.ts fixture" &&
    packageJson.scripts?.["test:macos:signed-release"] ===
      "node --test scripts/macos-signed-release.test.ts" &&
    packageJson.scripts?.["test:scripts"]?.includes("macos-signed-release.test.ts") &&
    packageJson.scripts?.["test:scripts"]?.includes("macos-updater-contract.test.ts"),
  "Credential-free signed release and updater fixtures must run in the Fast PR gate.",
);
invariant(
  packageJson.scripts?.["check:macos:release-workflow"] ===
    "node scripts/check-macos-alpha-release-workflow.ts",
  "The release workflow contract command is missing.",
);

console.log(
  "macOS release workflow contract valid: explicit profiles, unchanged Alpha path, credential-free updater fixtures, protected signed-direct execution, ordered evidence, cleanup, attestation, and Draft-only writes.",
);
