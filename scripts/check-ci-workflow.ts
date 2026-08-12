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
  name?: string;
  env?: Record<string, unknown>;
  if?: string;
  needs?: unknown;
  "runs-on"?: string | string[];
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
    workflow_dispatch?: {
      inputs?: {
        task?: { default?: string; options?: string[]; required?: boolean; type?: string };
      };
    };
  };
};

export const requiredCiJobIds = [
  "pr-gate",
  "platform-macos-gate",
  "platform-android-gate",
  "inspect-main",
  "inspect-browser",
  "package-macos",
  "package-android",
] as const;

export const requiredCiJobNames = {
  "pr-gate": "Fast PR gate",
  "platform-macos-gate": "macOS platform Rust gate",
  "platform-android-gate": "Android platform Rust gate",
  "inspect-main": "Inspect main",
  "inspect-browser": "Inspect browser",
  "package-macos": "Package macOS ARM64",
  "package-android": "Package Android test APKs",
} as const;

export function validateCiWorkflowJobInventory(
  jobs: Record<string, unknown> | undefined,
  expectedJobIds: readonly string[] = requiredCiJobIds,
): string[] {
  const actualJobIds = Object.keys(jobs ?? {});
  const expected = new Set(expectedJobIds);
  const errors: string[] = [];
  for (const jobId of expectedJobIds) {
    if (!actualJobIds.includes(jobId)) {
      errors.push(`CI workflow is missing reviewed job: ${jobId}.`);
    }
  }
  for (const jobId of actualJobIds) {
    if (!expected.has(jobId)) {
      errors.push(`CI workflow contains unreviewed job: ${jobId}.`);
    }
  }
  return errors;
}

export function validateCiWorkflowJobNames(
  jobs: Record<string, unknown> | undefined,
  expectedJobNames: Readonly<Record<string, string>> = requiredCiJobNames,
): string[] {
  const errors: string[] = [];
  for (const [jobId, expectedName] of Object.entries(expectedJobNames)) {
    const candidate = jobs?.[jobId];
    const actualName =
      typeof candidate === "object" && candidate !== null && !Array.isArray(candidate)
        ? (candidate as { name?: unknown }).name
        : undefined;
    if (actualName !== expectedName) {
      errors.push(`CI workflow job ${jobId} must retain reviewed name: ${expectedName}.`);
    }
  }
  return errors;
}

const workflowPath = resolve(import.meta.dirname, "../.github/workflows/ci.yml");
const source = readFileSync(workflowPath, "utf8");
const document = parseDocument(source);

if (document.errors.length > 0) {
  throw new Error(`Invalid CI workflow YAML: ${document.errors.join("; ")}`);
}

const workflow = document.toJS() as Workflow;
const jobInventoryErrors = validateCiWorkflowJobInventory(workflow.jobs);
invariant(jobInventoryErrors.length === 0, jobInventoryErrors.join("; "));
const jobNameErrors = validateCiWorkflowJobNames(workflow.jobs);
invariant(jobNameErrors.length === 0, jobNameErrors.join("; "));
const packageJson = JSON.parse(
  readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const pullRequestOnly = "github.event_name == 'pull_request'";
const inspectionOnly =
  "github.event_name == 'schedule' || (github.event_name == 'workflow_dispatch' && (inputs.task == 'inspection' || inputs.task == 'all'))";
const packageTrigger =
  "(github.event_name == 'push' && github.ref == 'refs/heads/main') || (github.event_name == 'workflow_dispatch' && (inputs.task == 'packages' || inputs.task == 'all'))";
const pnpmAction = "pnpm/action-setup@0ebf47130e4866e96fce0953f49152a61190b271";
const setupNodeAction = "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020";
const rustCacheAction = "Swatinem/rust-cache@e18b497796c12c097a38f9edb9d0641fb99eee32";
const uploadArtifactAction = "actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a";
const setupJavaAction = "actions/setup-java@03ad4de0992f5dab5e18fcb136590ce7c4a0ac95";
const setupAndroidAction = "android-actions/setup-android@40fd30fb8d7440372e1316f5d1809ec01dcd3699";

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
  invariant(pnpm.uses === pnpmAction, `${label} must pin the reviewed pnpm setup action.`);
  invariant(pnpm.with?.version === "11.13.1", `${label} must pin the workspace pnpm version.`);
  invariant(pnpm.with?.run_install === false, `${label} must keep dependency install explicit.`);

  const node = step(jobValue, "Set up Node.js");
  invariant(node.uses === setupNodeAction, `${label} must pin the reviewed Node setup action.`);
  invariant(node.with?.["node-version"] === "24.10.0", `${label} must pin Node.js 24.10.0.`);
  invariant(node.with?.cache === "pnpm", `${label} must restore the pnpm store cache.`);
  invariant(
    node.with?.["cache-dependency-path"] === "pnpm-lock.yaml",
    `${label} must key the pnpm cache from pnpm-lock.yaml.`,
  );
}

function assertRustCache(jobValue: Job, stepName: string, sharedKey: string): void {
  const cache = step(jobValue, stepName);
  invariant(cache.uses === rustCacheAction, `${stepName} must pin the reviewed Rust cache action.`);
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
const dispatchTask = workflow.on?.workflow_dispatch?.inputs?.task;
invariant(dispatchTask?.type === "choice", "Manual CI dispatch must use a bounded task choice.");
invariant(dispatchTask.required === true, "Manual CI dispatch must require an explicit task.");
invariant(dispatchTask.default === "inspection", "Manual CI dispatch must default to inspection.");
invariant(
  JSON.stringify(dispatchTask.options) === JSON.stringify(["inspection", "packages", "all"]),
  "Manual CI dispatch must support inspection, packages, or both.",
);
invariant(
  workflow.concurrency?.group?.includes("github.event_name"),
  "CI concurrency must not let an inspection cancel a package run.",
);

const prGate = job("pr-gate");
invariant(prGate.if === pullRequestOnly, "The fast gate must run only for pull requests.");
invariant(
  prGate["runs-on"] === "ubuntu-24.04",
  "The untrusted fast gate must use an isolated GitHub-hosted runner.",
);
invariant(prGate["timeout-minutes"] === 10, "The fast gate must retain its ten-minute ceiling.");
assertNodeCache(prGate, "The fast gate");
assertRustCache(prGate, "Cache Rust dependencies and build outputs", "pr-gate");
invariant(
  step(prGate, "Install dependencies").run === "pnpm install --frozen-lockfile",
  "The fast gate must install frozen dependencies.",
);
invariant(
  step(prGate, "Run fast pull-request gate").run === "pnpm check:pr",
  "Pull requests must use the bounded validation command.",
);
invariant(
  step(prGate, "Install Playwright Chromium").run === "pnpm test:browser:install",
  "The fast gate must install the Playwright-pinned Chromium.",
);
const simulatedApplicationContract =
  "cargo test -p mish-simulated-host --all-features -- --test-threads=1 && pnpm test:browser:simulated-host";
const rustInspectionContract = "cargo clippy --workspace --all-targets -- -D warnings";
const rustPullRequestContract =
  "cargo clippy --workspace --all-targets --exclude mish-desktop --exclude mish-mobile --exclude tauri-plugin-mish-vpn --exclude mish-platform-macos --exclude mish-simulated-host --exclude mish-updater --exclude mish-bridge --no-deps -- -D warnings && cargo clippy -p mish-updater --lib -- -D warnings";
const expectedPrValidation =
  "pnpm check:android && pnpm check:android-platform-facts && pnpm check:bridge-protocol && pnpm check:ci && pnpm check:i18n && pnpm check:lint && pnpm check:styles && pnpm check:format && pnpm check:types:ts && pnpm test:unit && pnpm check:rust:format && pnpm check:rust:pr && pnpm check:rust:simulated-host && pnpm test:application:simulated-host && pnpm check:tokens && pnpm check:docs";
invariant(
  packageJson.scripts?.["check:pr"] === expectedPrValidation,
  "check:pr must stay bounded to its generated contracts, static, unit, Rust Clippy, simulated application, token, and documentation checks.",
);
invariant(
  packageJson.scripts?.["check:rust:pr"] === rustPullRequestContract &&
    packageJson.scripts?.["check:rust:clippy"] === rustInspectionContract,
  "The Fast PR gate must deny warnings across portable workspace/all-target Rust compilation while main inspection retains every host application target.",
);
invariant(
  packageJson.scripts?.["test:application:simulated-host"] === simulatedApplicationContract,
  "The Fast PR gate must run the exact bounded simulated application contract.",
);
invariant(
  packageJson.scripts?.["test:unit"]?.includes("pnpm test:scripts") &&
    packageJson.scripts?.["test:scripts"]?.includes("macos-signed-direct-policy.test.ts") &&
    packageJson.scripts?.["test:scripts"]?.includes("macos-signed-release.test.ts") &&
    packageJson.scripts?.["test:scripts"]?.includes("macos-updater-contract.test.ts"),
  "The Fast PR gate must execute the credential-free signed-direct package, release, and updater fixtures.",
);

const platformMacos = job("platform-macos-gate");
invariant(platformMacos.if === inspectionOnly, "macOS platform coverage must be inspection-only.");
invariant(platformMacos["runs-on"] === "macos-15", "macOS platform coverage must use macos-15.");
invariant(
  platformMacos["timeout-minutes"] === 30,
  "macOS platform coverage must retain its thirty-minute ceiling.",
);
assertNodeCache(platformMacos, "macOS platform coverage");
assertRustCache(platformMacos, "Cache Rust dependencies and build outputs", "pr-platform-macos");
invariant(
  step(platformMacos, "Check out repository").with?.ref === "main",
  "macOS platform coverage must inspect the latest main branch.",
);
invariant(
  step(platformMacos, "Install dependencies").run === "pnpm install --frozen-lockfile",
  "macOS platform coverage must install frozen dependencies.",
);
for (const [stepName, command] of [
  ["Build desktop web bundle", "pnpm --filter @mish/web build:desktop"],
  ["Check desktop Rust target", "pnpm check:rust:desktop"],
  ["Test desktop Rust target", "pnpm test:rust:desktop"],
  ["Check macOS platform Rust target", "pnpm check:rust:platform-macos"],
  ["Test macOS platform Rust target", "pnpm test:rust:platform-macos"],
] as const) {
  invariant(
    step(platformMacos, stepName).run === command,
    `macOS platform coverage must run ${command}.`,
  );
}

const platformAndroid = job("platform-android-gate");
invariant(
  platformAndroid.if === pullRequestOnly,
  "Android platform coverage must run on pull requests.",
);
invariant(
  platformAndroid["runs-on"] === "ubuntu-24.04",
  "Android platform coverage must use Ubuntu 24.04.",
);
invariant(
  platformAndroid["timeout-minutes"] === 30,
  "Android platform coverage must retain its thirty-minute ceiling.",
);
assertNodeCache(platformAndroid, "Android platform coverage");
invariant(
  step(platformAndroid, "Install dependencies").run === "pnpm install --frozen-lockfile",
  "Android platform coverage must install frozen dependencies.",
);
const platformAndroidJavaSetup = step(platformAndroid, "Set up Java");
invariant(
  platformAndroidJavaSetup.uses === setupJavaAction &&
    platformAndroidJavaSetup.with?.distribution === "temurin" &&
    platformAndroidJavaSetup.with?.["java-version"] === 17,
  "Android platform coverage must pin Java 17.",
);
const platformAndroidTools = step(platformAndroid, "Set up Android SDK tools");
invariant(
  platformAndroidTools.uses === setupAndroidAction &&
    platformAndroidTools.with?.["cmdline-tools-version"] === 14742923 &&
    platformAndroidTools.with?.packages === "",
  "Android platform coverage must pin Android setup without implicit packages.",
);
const platformAndroidToolchain = step(
  platformAndroid,
  "Install pinned Android Rust target toolchain",
).run;
for (const requirement of [
  "platforms;android-36",
  "build-tools;36.1.0",
  "ndk;29.0.14206865",
  "aarch64-linux-android",
  "x86_64-linux-android",
  "CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER",
  "CARGO_TARGET_X86_64_LINUX_ANDROID_LINKER",
]) {
  invariant(
    platformAndroidToolchain?.includes(requirement),
    `Android platform coverage must pin ${requirement}.`,
  );
}
assertRustCache(
  platformAndroid,
  "Cache Rust dependencies and build outputs",
  "pr-platform-android",
);
invariant(
  step(platformAndroid, "Check mobile Rust targets").run === "pnpm check:rust:mobile" &&
    step(platformAndroid, "Compile mobile Rust test targets").run === "pnpm test:rust:mobile",
  "Android platform coverage must run compile, Clippy, and test-target commands.",
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
  step(inspectMain, "Run complete validation").run === "pnpm check:all",
  "Inspection must run complete repository validation.",
);

const inspectBrowser = job("inspect-browser");
invariant(inspectBrowser.if === inspectionOnly, "Browser inspection must be inspection-only.");
invariant(
  inspectBrowser["runs-on"] === "ubuntu-24.04",
  "Browser inspection must use a deterministic GitHub-hosted runner.",
);
invariant(
  inspectBrowser["timeout-minutes"] === 15,
  "Browser inspection must retain its fifteen-minute ceiling.",
);
assertNodeCache(inspectBrowser, "Browser inspection");
invariant(
  step(inspectBrowser, "Check out repository").with?.ref === "main",
  "Browser inspection must always check out the latest main branch.",
);
invariant(
  step(inspectBrowser, "Install dependencies").run === "pnpm install --frozen-lockfile",
  "Browser inspection must install frozen dependencies.",
);
invariant(
  step(inspectBrowser, "Install Playwright Chromium").run === "pnpm test:browser:install",
  "Browser inspection must install the Playwright-pinned Chromium.",
);
invariant(
  step(inspectBrowser, "Run real-browser responsive suite").run === "pnpm test:browser",
  "Browser inspection must run the real-browser suite.",
);

const packageMacos = job("package-macos");
invariant(packageMacos["runs-on"] === "macos-15", "Packaging must use macos-15 ARM64.");
invariant(
  packageMacos.if === packageTrigger,
  "Packaging must use only main push or manual package dispatch.",
);
invariant(packageMacos.needs === undefined, "Packaging must remain independent from validation.");
assertNodeCache(packageMacos, "macOS packaging");
assertRustCache(packageMacos, "Cache Rust dependencies and build outputs", "macos-package");

const upload = step(packageMacos, "Upload Apple Silicon test package");
invariant(upload.id === "package-upload", "The upload step must expose traceable outputs.");
invariant(
  upload.uses === uploadArtifactAction,
  "Packaging must pin the reviewed upload-artifact action.",
);
invariant(upload.if === packageTrigger, "Artifact upload must follow the bounded package trigger.");
invariant(upload.with?.["retention-days"] === 14, "The package must be retained for 14 days.");
invariant(
  step(packageMacos, "Build and verify application bundle").run === "pnpm desktop:build:macos",
  "Routine macOS packaging must use the explicit alpha-ad-hoc command.",
);
invariant(
  packageJson.scripts?.["desktop:build:macos"] ===
    "node scripts/build-macos-bundle.ts --profile alpha-ad-hoc",
  "Routine macOS packaging must select alpha-ad-hoc independently from signing secrets.",
);

for (const [jobName, candidateJob] of Object.entries(workflow.jobs ?? {})) {
  if (jobName === "package-macos" || jobName === "package-android") continue;
  invariant(
    !candidateJob.steps?.some((candidate) =>
      candidate.uses?.startsWith("actions/upload-artifact@"),
    ),
    `The ${jobName} job must not upload artifacts.`,
  );
}

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
    !source.includes(`secrets.${secret}`),
    `Routine CI must not read protected signed-release input ${secret}.`,
  );
}
invariant(
  !packageMacos.steps?.some((candidate) => candidate.name === "Configure Apple signing"),
  "Routine CI must not infer a release profile from Apple signing inputs.",
);

const archive = step(packageMacos, "Create app archive");
invariant(
  archive.run?.includes("archive_sha256") && archive.run.includes("shasum -a 256"),
  "The app archive must publish its SHA-256 for the package summary.",
);
invariant(
  archive.run?.includes("hdiutil attach -readonly -nobrowse -noautoopen") &&
    archive.run.includes("trap cleanup EXIT"),
  "The app archive must mount the verified DMG headlessly and always detach it.",
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
  "Release profile",
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
  summarySource.includes("alpha-ad-hoc") &&
    summarySource.includes("ad-hoc") &&
    summarySource.includes("Notarized"),
  "The routine package summary must report the explicit unnotarized Alpha profile.",
);
invariant(
  !summarySource.includes("MISH_APPLE_") && !summarySource.includes("APPLE_API_"),
  "The package summary must not expose signing secret variables.",
);

const packageAndroid = job("package-android");
invariant(packageAndroid["runs-on"] === "ubuntu-24.04", "Android packaging must use Ubuntu 24.04.");
invariant(
  packageAndroid.if === packageTrigger,
  "Android packaging must use only main push or manual package dispatch.",
);
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
invariant(
  javaSetup.uses === setupJavaAction && javaSetup.with?.cache === "gradle",
  "Android packaging must pin Java setup and cache Gradle dependencies.",
);
invariant(
  String(javaSetup.with?.["cache-dependency-path"]).includes("gradle-wrapper.properties"),
  "The Gradle cache key must include the wrapper and build scripts.",
);

const androidTools = step(packageAndroid, "Set up Android SDK tools");
invariant(
  androidTools.uses === setupAndroidAction,
  "Android packaging must pin the reviewed Android setup action.",
);
invariant(
  androidTools.with?.["cmdline-tools-version"] === 14742923,
  "Android command-line tools must use the pinned upstream build.",
);
invariant(
  androidTools.with?.packages === "",
  "The setup action must not install unpinned Android packages implicitly.",
);

const androidSetup = step(packageAndroid, "Install pinned Android components").run ?? "";
invariant(
  !androidSetup.includes("sdkmanager --licenses"),
  "The setup action must own Android SDK license acceptance.",
);
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
const mobileCoreBuild = step(packageAndroid, "Build and stage verified Mobile Core");
for (const command of [
  "pnpm mobile-core:build",
  "pnpm mobile-core:verify -- --evidence-dir .scratch/mobile-core/evidence --artifact-dir .scratch/mobile-core/pass-1/android",
  "pnpm mobile-core:stage:android -- --evidence-dir .scratch/mobile-core/evidence",
]) {
  invariant(
    mobileCoreBuild.run?.includes(command),
    `Android packaging must run ${command} before the application build.`,
  );
}
invariant(
  (packageAndroid.steps?.indexOf(mobileCoreBuild) ?? -1) <
    (packageAndroid.steps?.indexOf(androidBuild) ?? -1),
  "Verified Mobile Core staging must finish before the Android application build.",
);
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
  androidUpload.uses === uploadArtifactAction,
  "Android packaging must pin the reviewed upload-artifact action.",
);
invariant(
  androidUpload.if === packageTrigger,
  "Android artifact upload must follow the bounded package trigger.",
);
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

const androidVerification = step(packageAndroid, "Verify Android debug APKs").run ?? "";
for (const requirement of [
  "libmish_mobile_core.so",
  "libmish_vpn_jni.so",
  ".scratch/mobile-core/evidence/SHA256SUMS",
  "actual_core",
  "expected_core",
  'pnpm android:verify-signer -- --apk "$apk"',
]) {
  invariant(
    androidVerification.includes(requirement),
    `Android package verification must retain ${requirement}.`,
  );
}
invariant(
  !androidVerification.includes("mobile-core/evidence/android-v1.19.29/SHA256SUMS"),
  "CI must verify packaged Core hashes against the current host build evidence.",
);

console.log(
  "CI workflow contract valid: PRs use the fast gate, main pushes package, and scheduled/manual main inspections run the heavy suite.",
);
