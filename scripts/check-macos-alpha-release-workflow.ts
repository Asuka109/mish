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
        { default?: unknown; description?: string; required?: boolean; type?: string }
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
  throw new Error(`Invalid macOS Alpha release workflow YAML: ${document.errors.join("; ")}`);
}

const workflow = document.toJS() as Workflow;
const packageJson = JSON.parse(readFileSync(resolve(repositoryRoot, "package.json"), "utf8")) as {
  scripts?: Record<string, string>;
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function job(name: string): Job {
  const value = workflow.jobs?.[name];
  invariant(value, `macOS Alpha release workflow is missing the ${name} job.`);
  return value;
}

function step(jobValue: Job, name: string): Step {
  const value = jobValue.steps?.find((candidate) => candidate.name === name);
  invariant(value, `macOS Alpha release workflow is missing the ${name} step.`);
  return value;
}

function index(jobValue: Job, name: string): number {
  const value = jobValue.steps?.findIndex((candidate) => candidate.name === name) ?? -1;
  invariant(value >= 0, `macOS Alpha release workflow is missing the ${name} step.`);
  return value;
}

const triggers = Object.keys(workflow.on ?? {});
invariant(
  JSON.stringify(triggers) === JSON.stringify(["workflow_dispatch"]),
  "Release staging must be reachable only through workflow_dispatch.",
);
const inputs = workflow.on?.workflow_dispatch?.inputs ?? {};
invariant(
  JSON.stringify(Object.keys(inputs)) === JSON.stringify(["version", "source_sha", "dry_run"]),
  "Run workflow must expose only version, source_sha, and dry_run.",
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
  workflow.concurrency?.group?.includes("inputs.version"),
  "Release concurrency must be scoped by requested version.",
);
invariant(
  workflow.concurrency?.["cancel-in-progress"] === false,
  "Release concurrency must never cancel another candidate.",
);

const expectedJobs = ["freeze-source", "verify-candidate", "staging-decision", "stage-draft"];
invariant(
  JSON.stringify(Object.keys(workflow.jobs ?? {})) === JSON.stringify(expectedJobs),
  "Release workflow job boundary changed unexpectedly.",
);

for (const [name, candidate] of Object.entries(workflow.jobs ?? {})) {
  const permission = candidate.permissions?.contents ?? workflow.permissions?.contents;
  invariant(
    permission === (name === "stage-draft" ? "write" : "read"),
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
    const setupNode = (candidate.steps ?? []).find((candidateStep) =>
      candidateStep.uses?.startsWith("actions/setup-node@"),
    );
    invariant(
      setupNode?.uses === "actions/setup-node@v7" &&
        String(setupNode.with?.["node-version"]) === "24",
      `${name} must set up Node.js 24 before running TypeScript release scripts.`,
    );
    const setupIndex = (candidate.steps ?? []).findIndex((candidateStep) =>
      candidateStep.uses?.startsWith("actions/setup-node@"),
    );
    const firstNodeIndex = (candidate.steps ?? []).findIndex((candidateStep) =>
      /\bnode\s+/.test(candidateStep.run ?? ""),
    );
    invariant(
      setupIndex >= 0 && firstNodeIndex > setupIndex,
      `${name} must run actions/setup-node before any node script.`,
    );
  }
}
invariant(
  !source.includes("${{ secrets."),
  "Credential-free Alpha staging must not reference repository or environment secrets.",
);
invariant(
  !source.includes("pull_request_target") && !source.includes("\npull_request:"),
  "Pull requests and forks must not reach release staging.",
);
invariant(
  !source.includes("MISH_APPLE_") &&
    !source.includes("APPLE_API_") &&
    !source.includes("APPLE_CERTIFICATE"),
  "Credential-free Alpha staging must not expose future Apple signing secrets.",
);
invariant(
  releaseScript.includes("/releases?per_page=100&page=") &&
    !releaseScript.includes("/releases/tags/"),
  "Release state must use the authenticated listing endpoint so Drafts are visible.",
);
invariant(
  alphaBundleBuilder.includes('["desktop:bundle:verify:alpha-ad-hoc:macos"]') &&
    alphaBundleBuilder.includes('packageEnvironment.CI = "true"') &&
    alphaBundleBuilder.includes("delete packageEnvironment.TAURI_BUNDLER_DMG_IGNORE_CI") &&
    alphaDmgVerifier.includes('["attach", "-readonly", "-nobrowse", dmg]') &&
    alphaDmgVerifier.includes('["detach", mountpoint]') &&
    !alphaDmgVerifier.includes('["detach", "-force"'),
  "The headless read-only DMG inspection and clean detach contract changed unexpectedly.",
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
    sourceStep.run.includes('node scripts/macos-alpha-release.ts "${arguments[@]}"'),
  "Source resolution must pass optional input as one quoted argument.",
);
invariant(
  !sourceStep.run?.includes("${{"),
  "Untrusted dispatch inputs must enter source resolution through environment variables.",
);
invariant(
  index(freeze, "Resolve exact source and version") <
    index(freeze, "Fail fast on conflicting tag or Release"),
  "Source and version validation must precede remote conflict checks.",
);
invariant(
  freeze.outputs?.tooling_sha === "${{ steps.source.outputs.main_sha }}",
  "Release tooling must freeze to the same main commit used for reachability.",
);

const verify = job("verify-candidate");
invariant(
  verify.needs === "freeze-source",
  "Candidate verification must depend on the frozen source.",
);
const verifyCheckout = step(verify, "Check out frozen source");
invariant(
  verifyCheckout.with?.ref === "${{ needs.freeze-source.outputs.source_sha }}",
  "Candidate verification must check out only the frozen source SHA.",
);
for (const candidate of [verify, job("staging-decision"), job("stage-draft")]) {
  const tooling = step(candidate, "Check out frozen release tooling");
  invariant(
    tooling.with?.ref === "${{ needs.freeze-source.outputs.tooling_sha }}" &&
      tooling.with?.path === ".release-tooling",
    "Release tooling must use the frozen main SHA in an isolated checkout.",
  );
}
invariant(
  step(verify, "Run complete repository validation").run === "pnpm check:all",
  "Release candidates must pass the complete repository validation.",
);
invariant(
  step(verify, "Build and inspect Alpha DMG").run === "pnpm desktop:bundle:macos",
  "Release candidates must preserve the #168 Alpha DMG contract.",
);
invariant(
  step(verify, "Build and inspect Alpha DMG").env?.GH_TOKEN === "${{ github.token }}",
  "The Alpha DMG build must authenticate only its pinned public Core download.",
);
const verifyOrder = [
  "Run complete repository validation",
  "Build and inspect Alpha DMG",
  "Generate versioned candidate, checksums, and metadata",
  "Upload verified staging candidate",
].map((name) => index(verify, name));
invariant(
  verifyOrder.every((value, position) => position === 0 || value > verifyOrder[position - 1]),
  "Validation, build inspection, metadata generation, and artifact upload are out of order.",
);
const artifactGeneration = step(verify, "Generate versioned candidate, checksums, and metadata");
invariant(
  artifactGeneration.run?.includes(
    "node .release-tooling/scripts/macos-alpha-release.ts prepare-artifacts",
  ) && artifactGeneration.env?.MISH_RELEASE_REPOSITORY_ROOT === "${{ github.workspace }}",
  "Artifact generation must use frozen tooling against the selected source checkout.",
);
const candidateUpload = step(verify, "Upload verified staging candidate");
invariant(
  candidateUpload.uses === "actions/upload-artifact@v7",
  "Verified candidates must use upload-artifact v7.",
);
invariant(
  candidateUpload.if === undefined,
  "Failed validation or packaging must never upload a staging candidate.",
);
invariant(
  candidateUpload.with?.["if-no-files-found"] === "error" &&
    candidateUpload.with?.["retention-days"] === 1,
  "Candidate artifact upload must fail closed and retain only one day.",
);

const decision = job("staging-decision");
invariant(
  JSON.stringify(decision.needs) === JSON.stringify(["freeze-source", "verify-candidate"]),
  "Dry-run staging decisions must require source freeze and candidate verification.",
);
const decisionStep = step(decision, "Validate artifacts and decide staging");
invariant(
  decisionStep.run?.includes(".release-tooling/scripts/macos-alpha-release.ts plan") &&
    decisionStep.run.includes("--artifact-directory target/release-candidate"),
  "Dry-run staging must inspect the complete verified artifact set.",
);
invariant(
  !decisionStep.run?.includes("${{"),
  "Validated staging values must enter the dry-run script through environment variables.",
);

const stage = job("stage-draft");
invariant(
  stage.if === "${{ inputs.dry_run == false }}",
  "The write boundary must remain disabled unless dry_run is explicitly false.",
);
invariant(
  JSON.stringify(stage.permissions) === JSON.stringify({ contents: "write" }),
  "Only final Draft staging may receive contents: write.",
);
invariant(
  JSON.stringify(stage.needs) ===
    JSON.stringify(["freeze-source", "verify-candidate", "staging-decision"]),
  "Draft staging must depend on every read-only verification boundary.",
);
const stageStep = step(stage, "Stage immutable tag and Draft Pre-release");
invariant(
  stageStep.run?.includes(".release-tooling/scripts/macos-alpha-release.ts stage") &&
    stageStep.run.includes("--artifact-directory target/release-candidate"),
  "Final staging must use the fail-closed repository script and verified artifacts.",
);
invariant(
  !stageStep.run?.includes("${{"),
  "Validated staging values must enter the write script through environment variables.",
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
]) {
  invariant(
    !runSources.includes(forbidden),
    `Workflow shell must not contain unsafe release mutation: ${forbidden}`,
  );
}

invariant(
  packageJson.scripts?.["release:macos:fixture"] === "node scripts/macos-alpha-release.ts fixture",
  "The deterministic release fixture command is missing.",
);
invariant(
  packageJson.scripts?.["test:macos:release"] === "node --test scripts/macos-alpha-release.test.ts",
  "The macOS release unit fixture command is missing.",
);
invariant(
  packageJson.scripts?.["check:macos:release-workflow"] ===
    "node scripts/check-macos-alpha-release-workflow.ts",
  "The release workflow contract command is missing.",
);

console.log(
  "macOS Alpha release workflow contract valid: manual-only, immutable-source, verified-before-write, and Draft-only.",
);
