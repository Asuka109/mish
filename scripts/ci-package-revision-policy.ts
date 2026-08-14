import { parseDocument } from "yaml";

interface WorkflowStep {
  "continue-on-error"?: boolean;
  env?: Record<string, unknown>;
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

interface PackageJobContract {
  buildStep: string;
  jobId: "package-android" | "package-macos";
  metadataStep: string;
  uploadStep: string;
}

const checkoutAction = "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803";
const acceptedRevision = "${{ steps.package-source.outputs.accepted_sha }}";
const verifiedRevision = "${{ steps.package-head.outputs.source_sha }}";
const verifiedShortRevision = "${{ steps.package-head.outputs.short_sha }}";

const packageContracts: readonly PackageJobContract[] = [
  {
    buildStep: "Build and verify application bundle",
    jobId: "package-macos",
    metadataStep: "Create app archive",
    uploadStep: "Upload Apple Silicon test package",
  },
  {
    buildStep: "Build and stage verified Mobile Core",
    jobId: "package-android",
    metadataStep: "Verify Android debug APKs",
    uploadStep: "Upload Android non-production test APKs",
  },
];

function findStep(job: WorkflowJob, name: string): WorkflowStep | undefined {
  return job.steps?.find((candidate) => candidate.name === name);
}

function stepIndex(job: WorkflowJob, name: string): number {
  return job.steps?.findIndex((candidate) => candidate.name === name) ?? -1;
}

function normalizedRun(step: WorkflowStep | undefined): string {
  return step?.run?.trim() ?? "";
}

function requireStep(
  errors: string[],
  job: WorkflowJob,
  jobId: string,
  name: string,
): WorkflowStep | undefined {
  const candidate = findStep(job, name);
  if (candidate) return candidate;
  errors.push(`${jobId}: missing required package revision step: ${name}.`);
  return undefined;
}

function validateSelectionStep(
  errors: string[],
  job: WorkflowJob,
  jobId: string,
): WorkflowStep | undefined {
  const selection = requireStep(errors, job, jobId, "Select accepted package revision");
  if (!selection) return undefined;

  if (selection.id !== "package-source") {
    errors.push(`${jobId}: package revision selection must expose package-source outputs.`);
  }
  if (selection.if !== undefined || selection["continue-on-error"] !== undefined) {
    errors.push(`${jobId}: package revision selection cannot be conditional or bypassed.`);
  }
  if (
    selection.env?.EVENT_NAME !== "${{ github.event_name }}" ||
    selection.env?.EVENT_REF !== "${{ github.ref }}" ||
    selection.env?.EVENT_SHA !== "${{ github.sha }}"
  ) {
    errors.push(`${jobId}: package revision selection must consume the triggering event identity.`);
  }

  const run = normalizedRun(selection);
  for (const requirement of [
    'case "$EVENT_NAME" in',
    "push|workflow_dispatch)",
    'test "$EVENT_REF" = "refs/heads/main"',
    '[[ "$EVENT_SHA" =~ ^[0-9a-f]{40}$ ]]',
    'echo "accepted_sha=$EVENT_SHA" >> "$GITHUB_OUTPUT"',
  ]) {
    if (run.includes(requirement)) continue;
    errors.push(`${jobId}: package revision selection is missing closed guard: ${requirement}.`);
  }
  return selection;
}

function validateCheckoutAndHead(errors: string[], job: WorkflowJob, jobId: string): void {
  const checkout = requireStep(errors, job, jobId, "Check out repository");
  if (checkout) {
    if (
      checkout.uses !== checkoutAction ||
      checkout.with?.ref !== acceptedRevision ||
      checkout.with?.["fetch-depth"] !== 1 ||
      checkout.with?.["persist-credentials"] !== false
    ) {
      errors.push(`${jobId}: checkout must fetch only the frozen accepted package SHA.`);
    }
  }

  const head = requireStep(errors, job, jobId, "Verify checked-out package revision");
  if (!head) return;
  if (head.id !== "package-head" || head.env?.FROZEN_SOURCE_SHA !== acceptedRevision) {
    errors.push(`${jobId}: verified HEAD outputs must derive from the frozen accepted SHA.`);
  }
  if (head.if !== undefined || head["continue-on-error"] !== undefined) {
    errors.push(`${jobId}: checked-out HEAD verification cannot be conditional or bypassed.`);
  }
  const run = normalizedRun(head);
  for (const requirement of [
    'source_sha="$(git rev-parse HEAD)"',
    'test "$source_sha" = "$FROZEN_SOURCE_SHA"',
    'echo "source_sha=$source_sha" >> "$GITHUB_OUTPUT"',
    'echo "short_sha=${source_sha:0:7}" >> "$GITHUB_OUTPUT"',
  ]) {
    if (run.includes(requirement)) continue;
    errors.push(`${jobId}: checked-out HEAD verification is missing: ${requirement}.`);
  }
}

function validatePolicyAtHead(errors: string[], job: WorkflowJob, jobId: string): void {
  const validation = requireStep(errors, job, jobId, "Validate package source policy");
  if (!validation) return;
  if (validation.env?.VERIFIED_SOURCE_SHA !== verifiedRevision) {
    errors.push(`${jobId}: source-policy validation must consume verified HEAD.`);
  }
  if (validation.if !== undefined || validation["continue-on-error"] !== undefined) {
    errors.push(`${jobId}: source-policy validation cannot be conditional or bypassed.`);
  }
  const run = normalizedRun(validation);
  if (
    !run.includes('test "$(git rev-parse HEAD)" = "$VERIFIED_SOURCE_SHA"') ||
    !run.includes("pnpm check:ci")
  ) {
    errors.push(`${jobId}: source-policy validation must assert verified HEAD before check:ci.`);
  }
}

function validateBeforeUpload(
  errors: string[],
  job: WorkflowJob,
  contract: PackageJobContract,
): void {
  const verification = requireStep(
    errors,
    job,
    contract.jobId,
    "Verify package revision before upload",
  );
  if (!verification) return;
  if (
    verification.env?.SOURCE_SHA !== verifiedRevision ||
    verification.env?.SHORT_SHA !== verifiedShortRevision
  ) {
    errors.push(`${contract.jobId}: pre-upload verification must consume verified HEAD outputs.`);
  }
  const run = normalizedRun(verification);
  for (const requirement of [
    'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"',
    'test "$SHORT_SHA" = "${SOURCE_SHA:0:7}"',
  ]) {
    if (run.includes(requirement)) continue;
    errors.push(`${contract.jobId}: pre-upload verification is missing: ${requirement}.`);
  }
  if (verification.if !== undefined || verification["continue-on-error"] !== undefined) {
    errors.push(`${contract.jobId}: pre-upload revision verification cannot be bypassed.`);
  }
}

function validateStepOrder(errors: string[], job: WorkflowJob, contract: PackageJobContract): void {
  const selectionIndex = stepIndex(job, "Select accepted package revision");
  const checkoutIndex = stepIndex(job, "Check out repository");
  const headIndex = stepIndex(job, "Verify checked-out package revision");
  const policyIndex = stepIndex(job, "Validate package source policy");
  const buildIndex = stepIndex(job, contract.buildStep);
  const metadataIndex = stepIndex(job, contract.metadataStep);
  const preUploadIndex = stepIndex(job, "Verify package revision before upload");
  const uploadIndex = stepIndex(job, contract.uploadStep);

  if (!(selectionIndex === 0 && checkoutIndex === 1 && headIndex === 2)) {
    errors.push(
      `${contract.jobId}: revision selection, checkout, and HEAD verification must run first.`,
    );
  }
  if (!(headIndex < policyIndex && policyIndex < buildIndex)) {
    errors.push(`${contract.jobId}: verified source policy must pass before package build.`);
  }
  if (!(metadataIndex < preUploadIndex && preUploadIndex < uploadIndex)) {
    errors.push(
      `${contract.jobId}: HEAD and package metadata must be verified immediately before upload.`,
    );
  }
}

function validateMetadataSources(errors: string[], job: WorkflowJob, jobId: string): void {
  const downstreamSource = JSON.stringify(job.steps?.slice(1) ?? []);
  if (downstreamSource.includes("GITHUB_SHA") || downstreamSource.includes("${{ github.sha }}")) {
    errors.push(`${jobId}: package metadata cannot read the unverified event SHA after selection.`);
  }

  const packageSource = JSON.stringify(job);
  if (!packageSource.includes(verifiedRevision) || !packageSource.includes(verifiedShortRevision)) {
    errors.push(`${jobId}: package metadata and summary must consume verified HEAD outputs.`);
  }
}

function validateMetadataBinding(
  errors: string[],
  job: WorkflowJob,
  contract: PackageJobContract,
): void {
  const metadata = findStep(job, contract.metadataStep);
  const upload = findStep(job, contract.uploadStep);
  const summaryName =
    contract.jobId === "package-macos" ? "Write package summary" : "Write Android package summary";
  const summary = findStep(job, summaryName);

  if (
    metadata?.id !== "package-metadata" ||
    metadata.env?.SOURCE_SHA !== verifiedRevision ||
    metadata.env?.SHORT_SHA !== verifiedShortRevision ||
    !normalizedRun(metadata).includes('test "$(git rev-parse HEAD)" = "$SOURCE_SHA"') ||
    !normalizedRun(metadata).includes('test "$SHORT_SHA" = "${SOURCE_SHA:0:7}"')
  ) {
    errors.push(`${contract.jobId}: package names and checksums must derive at verified HEAD.`);
  }

  const metadataRun = normalizedRun(metadata);
  const verificationRun = normalizedRun(findStep(job, "Verify package revision before upload"));
  const metadataRequirements =
    contract.jobId === "package-macos"
      ? [
          ".scratch/artifacts/Mish-${SHORT_SHA}.app.zip",
          'artifact_name="mish-macos-arm64-${SHORT_SHA}"',
          'echo "archive_sha256=$archive_sha256" >> "$GITHUB_OUTPUT"',
        ]
      : [
          "Mish-${SHORT_SHA}-arm64-v8a-debug.apk",
          "Mish-${SHORT_SHA}-x86_64-debug.apk",
          'echo "artifact_name=mish-android-test-${SHORT_SHA}"',
          'echo "arm64_sha256=$arm64_sha256"',
          'echo "x86_64_sha256=$x86_64_sha256"',
        ];
  const verificationRequirements =
    contract.jobId === "package-macos"
      ? [
          'test "$ARTIFACT_NAME" = "mish-macos-arm64-$SHORT_SHA"',
          'test "$ARCHIVE" = ".scratch/artifacts/Mish-$SHORT_SHA.app.zip"',
          'test "$(shasum -a 256 "$ARCHIVE" | awk \'{print $1}\')" = "$ARCHIVE_SHA256"',
        ]
      : [
          'test "$ARTIFACT_NAME" = "mish-android-test-$SHORT_SHA"',
          "Mish-$SHORT_SHA-arm64-v8a-debug.apk",
          "Mish-$SHORT_SHA-x86_64-debug.apk",
          'test "$(sha256sum "$arm64_apk" | awk \'{print $1}\')" = "$ARM64_SHA256"',
          'test "$(sha256sum "$x86_64_apk" | awk \'{print $1}\')" = "$X86_64_SHA256"',
        ];
  for (const requirement of metadataRequirements) {
    if (metadataRun.includes(requirement)) continue;
    errors.push(`${contract.jobId}: verified package metadata is missing: ${requirement}.`);
  }
  for (const requirement of verificationRequirements) {
    if (verificationRun.includes(requirement)) continue;
    errors.push(`${contract.jobId}: pre-upload metadata verification is missing: ${requirement}.`);
  }

  if (upload?.with?.name !== "${{ steps.package-metadata.outputs.artifact_name }}") {
    errors.push(`${contract.jobId}: upload artifact name must use verified package metadata.`);
  }
  if (
    contract.jobId === "package-macos" &&
    upload?.with?.path !== "${{ steps.package-metadata.outputs.archive }}"
  ) {
    errors.push("package-macos: upload path must use the verified archive output.");
  }
  if (
    contract.jobId === "package-android" &&
    upload?.with?.path !== ".scratch/artifacts/android/*.apk"
  ) {
    errors.push("package-android: upload path must retain the verified APK set.");
  }

  if (
    summary?.env?.SOURCE_SHA !== verifiedRevision ||
    summary?.env?.SHORT_SHA !== verifiedShortRevision ||
    summary?.env?.ARTIFACT_NAME !== "${{ steps.package-metadata.outputs.artifact_name }}"
  ) {
    errors.push(`${contract.jobId}: package summary must use verified HEAD and upload metadata.`);
  }

  const jobSource = JSON.stringify(job);
  if (jobSource.includes("secrets.") || jobSource.includes("MISH_APPLE_")) {
    errors.push(
      `${contract.jobId}: non-production package provenance must remain credential-free.`,
    );
  }
}

export function validatePackageRevisionPolicy(source: string): string[] {
  const document = parseDocument(source);
  if (document.errors.length > 0) {
    return [
      `Package revision policy received invalid workflow YAML: ${document.errors.join("; ")}`,
    ];
  }

  const workflow = document.toJS() as Workflow;
  const errors: string[] = [];
  for (const contract of packageContracts) {
    const job = workflow.jobs?.[contract.jobId];
    if (!job) {
      errors.push(`Missing package job: ${contract.jobId}.`);
      continue;
    }
    validateSelectionStep(errors, job, contract.jobId);
    validateCheckoutAndHead(errors, job, contract.jobId);
    validatePolicyAtHead(errors, job, contract.jobId);
    validateBeforeUpload(errors, job, contract);
    validateStepOrder(errors, job, contract);
    validateMetadataSources(errors, job, contract.jobId);
    validateMetadataBinding(errors, job, contract);
  }
  return errors;
}
