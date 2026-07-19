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
};

type Workflow = {
  jobs?: Record<string, Job>;
  on?: {
    pull_request?: unknown;
    push?: { branches?: string[] };
  };
};

const workflowPath = resolve(import.meta.dirname, "../.github/workflows/ci.yml");
const source = readFileSync(workflowPath, "utf8");
const document = parseDocument(source);

if (document.errors.length > 0) {
  throw new Error(`Invalid CI workflow YAML: ${document.errors.join("; ")}`);
}

const workflow = document.toJS() as Workflow;
const mainOnly = "github.event_name == 'push' && github.ref == 'refs/heads/main'";

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

invariant(
  workflow.on && Object.prototype.hasOwnProperty.call(workflow.on, "pull_request"),
  "CI must validate pull requests.",
);
invariant(
  JSON.stringify(workflow.on?.push?.branches) === JSON.stringify(["main"]),
  "Push CI must remain scoped to main.",
);

const validate = job("validate");
invariant(validate["runs-on"] === "macos-15", "Validation must use macos-15.");
const validateSteps = validate.steps ?? [];
const installDependenciesIndex = validateSteps.findIndex(
  (candidate) => candidate.run === "pnpm install --frozen-lockfile",
);
const installBrowserIndex = validateSteps.findIndex(
  (candidate) => candidate.run === "pnpm test:browser:install",
);
const repositoryValidationIndex = validateSteps.findIndex(
  (candidate) => candidate.run === "pnpm validate",
);
const browserTestIndex = validateSteps.findIndex(
  (candidate) => candidate.run === "pnpm test:browser",
);
invariant(installDependenciesIndex >= 0, "Validation must install frozen dependencies.");
invariant(
  installBrowserIndex > installDependenciesIndex,
  "Validation must install the Playwright-pinned Chromium after dependencies.",
);
invariant(
  repositoryValidationIndex > installBrowserIndex,
  "Repository validation must run after Chromium installation.",
);
invariant(
  browserTestIndex > repositoryValidationIndex,
  "The real-browser suite must run in the validation job.",
);

const packageMacos = job("package-macos");
invariant(packageMacos["runs-on"] === "macos-15", "Packaging must use macos-15 ARM64.");
invariant(packageMacos.if === mainOnly, "Packaging must remain main-push-only.");
invariant(packageMacos.needs === undefined, "Packaging must remain independent from validation.");

const upload = step(packageMacos, "Upload Apple Silicon test package");
invariant(upload.id === "package-upload", "The upload step must expose traceable outputs.");
invariant(upload.uses === "actions/upload-artifact@v7", "Packaging must use upload-artifact v7.");
invariant(upload.if === mainOnly, "Artifact upload must remain main-push-only.");
invariant(upload.with?.["retention-days"] === 14, "The package must be retained for 14 days.");

for (const [jobName, candidateJob] of Object.entries(workflow.jobs ?? {})) {
  if (jobName === "package-macos") continue;
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

console.log(
  "CI workflow contract valid: PR validation includes pinned Chromium; packaging and upload are main-only; signing fails closed.",
);
