import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseDocument } from "yaml";

type Step = {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type Job = {
  env?: Record<string, unknown>;
  if?: string;
  needs?: unknown;
  "runs-on"?: string;
  steps?: Step[];
  "timeout-minutes"?: number;
};

type Workflow = {
  concurrency?: { group?: string };
  jobs?: Record<string, Job>;
  on?: {
    pull_request?: unknown;
    push?: { branches?: string[] };
    schedule?: Array<{ cron?: string }>;
    workflow_dispatch?: unknown;
  };
};

const workflowPath = resolve(import.meta.dirname, "../.github/workflows/ci.yml");
const source = readFileSync(workflowPath, "utf8");
const document = parseDocument(source);

if (document.errors.length > 0) {
  throw new Error(`Invalid CI workflow YAML: ${document.errors.join("; ")}`);
}

const workflow = document.toJS() as Workflow;
const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const mainOnly = "github.event_name == 'push' && github.ref == 'refs/heads/main'";
const pullRequestOnly = "github.event_name == 'pull_request'";
const inspectionOnly =
  "github.event_name == 'schedule' || github.event_name == 'workflow_dispatch'";

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function job(name: string): Job {
  const value = workflow.jobs?.[name];
  invariant(value, `CI workflow is missing the ${name} job.`);
  return value;
}

function step(jobValue: Job, name: string): Step {
  const value = jobValue.steps?.find((candidate) => candidate.name === name);
  invariant(value, `CI workflow is missing the ${name} step.`);
  return value;
}

function assertNodeCache(jobValue: Job, label: string): void {
  const pnpm = step(jobValue, "Set up pnpm");
  invariant(pnpm.uses === "pnpm/action-setup@v6", `${label} must use pnpm/action-setup v6.`);
  invariant(pnpm.with?.version === "11.13.1", `${label} must pin the workspace pnpm version.`);
  invariant(pnpm.with?.run_install === false, `${label} must keep dependency install explicit.`);

  const node = step(jobValue, "Set up Node.js");
  invariant(node.uses === "actions/setup-node@v7", `${label} must use setup-node v7.`);
  invariant(node.with?.cache === "pnpm", `${label} must restore the pnpm store cache.`);
  invariant(
    node.with?.["cache-dependency-path"] === "pnpm-lock.yaml",
    `${label} must key the pnpm cache from pnpm-lock.yaml.`,
  );
}

function assertRustCache(jobValue: Job, stepName: string, sharedKey: string): void {
  const cache = step(jobValue, stepName);
  invariant(cache.uses === "Swatinem/rust-cache@v2", `${stepName} must use rust-cache v2.`);
  invariant(
    cache.with?.["shared-key"] === sharedKey,
    `${stepName} has the wrong shared cache key.`,
  );
  invariant(
    cache.with?.["cache-on-failure"] === true,
    `${stepName} must retain useful failed-run outputs.`,
  );
}

invariant(
  workflow.on && Object.prototype.hasOwnProperty.call(workflow.on, "pull_request"),
  "CI must validate pull requests.",
);
invariant(
  JSON.stringify(workflow.on?.push?.branches) === JSON.stringify(["main"]),
  "Push CI must remain scoped to main.",
);
invariant(
  JSON.stringify(workflow.on?.schedule) === JSON.stringify([{ cron: "23 3 * * *" }]),
  "Full main inspection must run once per day at the pinned UTC time.",
);
invariant(
  workflow.on && Object.prototype.hasOwnProperty.call(workflow.on, "workflow_dispatch"),
  "Full main inspection must support manual dispatch.",
);
invariant(
  workflow.concurrency?.group?.includes("github.event_name"),
  "CI concurrency must not let an inspection cancel a package run.",
);

const prGate = job("pr-gate");
invariant(prGate.if === pullRequestOnly, "The fast gate must run only for pull requests.");
invariant(prGate["runs-on"] === "ubuntu-24.04", "The fast gate must use Ubuntu 24.04.");
invariant(prGate["timeout-minutes"] === 10, "The fast gate must retain its ten-minute ceiling.");
assertNodeCache(prGate, "The fast gate");
invariant(
  step(prGate, "Install dependencies").run === "pnpm install --frozen-lockfile",
  "The fast gate must install frozen dependencies.",
);
invariant(
  step(prGate, "Run fast pull-request gate").run === "pnpm validate:pr",
  "Pull requests must use the bounded validation command.",
);
const expectedPrValidation =
  "pnpm android:check && pnpm ci:check && pnpm i18n:check && pnpm lint && pnpm format:check && pnpm typecheck:ts && pnpm test:ts && pnpm rust:format:check && pnpm tokens:check && pnpm docs:links";
invariant(
  packageJson.scripts?.["validate:pr"] === expectedPrValidation,
  "validate:pr must stay bounded to fast static, TypeScript, unit, format, token, and documentation checks.",
);

const inspectMain = job("inspect-main");
invariant(inspectMain.if === inspectionOnly, "Heavy validation must be inspection-only.");
invariant(inspectMain["runs-on"] === "macos-15", "Main inspection must use macos-15.");
assertNodeCache(inspectMain, "Main inspection");
assertRustCache(inspectMain, "Cache Rust dependencies and build outputs", "main-inspection");
invariant(
  step(inspectMain, "Check out repository").with?.ref === "main",
  "Inspection must always check out the latest main branch.",
);
invariant(
  step(inspectMain, "Install Playwright Chromium").run === "pnpm test:browser:install",
  "Inspection must install the Playwright-pinned Chromium.",
);
invariant(
  step(inspectMain, "Run complete validation").run === "pnpm validate",
  "Inspection must run complete repository validation.",
);
invariant(
  step(inspectMain, "Run real-browser responsive suite").run === "pnpm test:browser",
  "Inspection must run the real-browser suite.",
);

const packageMacos = job("package-macos");
invariant(packageMacos["runs-on"] === "macos-15", "Packaging must use macos-15 ARM64.");
invariant(packageMacos.if === mainOnly, "Packaging must remain main-push-only.");
invariant(packageMacos.needs === undefined, "Packaging must remain independent from validation.");
assertNodeCache(packageMacos, "macOS packaging");
assertRustCache(packageMacos, "Cache Rust dependencies and build outputs", "macos-package");

const upload = step(packageMacos, "Upload Apple Silicon test package");
invariant(upload.id === "package-upload", "The upload step must expose traceable outputs.");
invariant(upload.uses === "actions/upload-artifact@v7", "Packaging must use upload-artifact v7.");
invariant(upload.if === mainOnly, "Artifact upload must remain main-push-only.");
invariant(upload.with?.["retention-days"] === 14, "The package must be retained for 14 days.");

for (const [jobName, candidateJob] of Object.entries(workflow.jobs ?? {})) {
  if (jobName === "package-macos" || jobName === "package-android") continue;
  invariant(
    !candidateJob.steps?.some((candidate) =>
      candidate.uses?.startsWith("actions/upload-artifact@"),
    ),
    `The ${jobName} job must not upload artifacts.`,
  );
}

const signing = step(packageMacos, "Configure Apple signing");
const signingScript = signing.run ?? "";
const signingSecrets = [
  "MISH_APPLE_CERTIFICATE_BASE64",
  "MISH_APPLE_CERTIFICATE_PASSWORD",
  "MISH_APPLE_SIGNING_IDENTITY",
  "MISH_APPLE_NOTARY_API_ISSUER_ID",
  "MISH_APPLE_NOTARY_API_KEY_ID",
  "MISH_APPLE_NOTARY_API_PRIVATE_KEY",
];
for (const secret of signingSecrets) {
  invariant(
    packageMacos.env?.[secret] === `\${{ secrets.${secret} }}`,
    `${secret} must come directly from its matching GitHub secret.`,
  );
  invariant(signingScript.includes(secret), `The signing gate must count ${secret}.`);
}
invariant(
  signingScript.includes('"$present" -ne 0 && "$present" -ne "${#values[@]}"'),
  "Partial Apple signing secrets must fail closed.",
);
invariant(
  signingScript.includes("umask 077"),
  "Temporary signing files must default to mode 0600.",
);
invariant(
  signingScript.includes('chmod 600 "$certificate" "$notary_key"'),
  "The temporary certificate and notary key must be explicitly mode 0600.",
);

const cleanup = step(packageMacos, "Remove temporary signing material");
invariant(cleanup.if === "always()", "Temporary signing material must always be cleaned up.");
invariant(
  cleanup.run?.includes("mish-developer-id.p12") && cleanup.run.includes("AuthKey_*.p8"),
  "Cleanup must cover the temporary certificate and notary key.",
);

const archive = step(packageMacos, "Create app archive");
invariant(
  archive.run?.includes("archive_sha256") && archive.run.includes("shasum -a 256"),
  "The app archive must publish its SHA-256 for the package summary.",
);

const summary = step(packageMacos, "Write package summary");
const summaryIndex = packageMacos.steps?.indexOf(summary) ?? -1;
const uploadIndex = packageMacos.steps?.indexOf(upload) ?? -1;
invariant(
  summaryIndex > uploadIndex,
  "The package summary must be written after a successful upload.",
);
const summarySource = JSON.stringify(summary);
for (const field of [
  "Short SHA",
  "Artifact name",
  "Artifact ID",
  "App ID",
  "Architecture",
  "Mihomo version",
  "Signing mode",
  "Notarized",
  "Archive SHA-256",
  "Retention",
]) {
  invariant(summarySource.includes(field), `The package summary is missing ${field}.`);
}
invariant(
  summarySource.includes("steps.package-upload.outputs.artifact-id"),
  "The package summary must use upload-artifact's real artifact ID output.",
);
invariant(
  !summarySource.includes("MISH_APPLE_") && !summarySource.includes("APPLE_API_"),
  "The package summary must not expose signing secret variables.",
);

const packageAndroid = job("package-android");
invariant(packageAndroid["runs-on"] === "ubuntu-24.04", "Android packaging must use Ubuntu 24.04.");
invariant(packageAndroid.if === mainOnly, "Android packaging must remain main-push-only.");
invariant(
  packageAndroid.needs === undefined,
  "Android packaging must remain independent from validation.",
);
assertNodeCache(packageAndroid, "Android packaging");
assertRustCache(
  packageAndroid,
  "Cache Rust dependencies and Android build outputs",
  "android-package",
);

const javaSetup = step(packageAndroid, "Set up Java");
invariant(javaSetup.with?.cache === "gradle", "Android packaging must cache Gradle dependencies.");
invariant(
  String(javaSetup.with?.["cache-dependency-path"]).includes("gradle-wrapper.properties"),
  "The Gradle cache key must include the wrapper and build scripts.",
);

const androidSetup = step(packageAndroid, "Install pinned Android components").run ?? "";
for (const component of [
  "platforms;android-36",
  "build-tools;36.1.0",
  "platform-tools",
  "ndk;29.0.14206865",
  "aarch64-linux-android",
  "x86_64-linux-android",
]) {
  invariant(androidSetup.includes(component), `Android setup must pin ${component}.`);
}

const androidBuild = step(packageAndroid, "Build Android debug APKs");
invariant(
  androidBuild.run === "pnpm mobile:android:build",
  "Android packaging must use the repository build command.",
);

const androidUpload = step(packageAndroid, "Upload Android non-production test APKs");
invariant(
  androidUpload.id === "android-package-upload",
  "Android upload must expose traceable outputs.",
);
invariant(
  androidUpload.uses === "actions/upload-artifact@v7",
  "Android packaging must use upload-artifact v7.",
);
invariant(androidUpload.if === mainOnly, "Android artifact upload must remain main-push-only.");
invariant(
  androidUpload.with?.["retention-days"] === 14,
  "Android test APKs must be retained for 14 days.",
);

const androidSummary = JSON.stringify(step(packageAndroid, "Write Android package summary"));
for (const field of [
  "Source revision",
  "Artifact ID",
  "Supported ABIs",
  "Signing mode",
  "Core",
  "ARM64 SHA-256",
  "x86_64 SHA-256",
  "Production use",
  "Retention",
]) {
  invariant(androidSummary.includes(field), `The Android package summary is missing ${field}.`);
}
invariant(
  !androidSummary.includes("subscription") && !androidSummary.includes("token"),
  "The Android package summary must not mention sensitive Profile material.",
);

console.log(
  "CI workflow contract valid: PRs use the fast gate, main pushes package, and scheduled/manual main inspections run the heavy suite.",
);
