import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import { parseDocument } from "yaml";

import { readTrustedReleasePolicy, type TrustedReleasePolicy } from "./trusted-release-policy.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fullSha = /^[0-9a-f]{40}$/u;
const referenceIdentifier = /^[A-Za-z0-9_.-]+$/u;
const fullExternalReference = /^(?<left>[^@\s]+)@(?<ref>[^@\s]+)$/u;
const localWorkflowPath = /^\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml$/u;

export interface WorkflowStep {
  id?: string;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
  shell?: string;
  "working-directory"?: string;
  "timeout-minutes"?: number;
  "continue-on-error"?: boolean | string;
}

export interface WorkflowJob {
  name?: string;
  environment?: unknown;
  if?: string;
  needs?: string | string[];
  permissions?: Record<string, string>;
  "runs-on"?: string | string[];
  "timeout-minutes"?: number;
  steps?: WorkflowStep[];
  uses?: string;
  with?: Record<string, unknown>;
  secrets?: Record<string, unknown> | "inherit";
  strategy?: Record<string, unknown>;
  "continue-on-error"?: boolean | string;
  container?: unknown;
  services?: Record<string, unknown>;
  env?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  outputs?: Record<string, string>;
  concurrency?: unknown;
}

export interface Workflow {
  name?: string;
  "run-name"?: string;
  jobs?: Record<string, WorkflowJob>;
  on?: unknown;
  permissions?: Record<string, string>;
  env?: Record<string, unknown>;
  defaults?: Record<string, unknown>;
  concurrency?: unknown;
}

export interface ParsedWorkflow {
  relative: string;
  source: string;
  workflow: Workflow;
}

export type WorkflowReferenceKind =
  | "local-action"
  | "external-action"
  | "local-reusable-workflow"
  | "external-reusable-workflow"
  | "unsupported";

export interface WorkflowReference {
  kind: WorkflowReferenceKind;
  reference: string;
  location: "step" | "job";
  workflowPath: string;
  jobName: string;
  stepIndex?: number;
  repository?: string;
  path?: string;
  ref?: string;
  reason?: string;
}

export interface RunStepInspection {
  kind: "run";
  location: "step";
  workflowPath: string;
  jobName: string;
  stepIndex: number;
}

export type WorkflowStepInspection = RunStepInspection | WorkflowReference;

export interface WorkflowValidationOptions {
  knownWorkflowPaths?: Iterable<string>;
}

export interface PlatformWorkspaceRootPolicy {
  prefix: string;
  family: string;
}

export interface PlatformPackagePolicy {
  name: string;
  manifest: string;
  family: string;
  targets: string[];
  runner: string;
  workflow: string;
  job: string;
  checkScript: string;
  testScript: string;
  testMode: "run" | "compile-only";
  hostLimitation: string;
  compileCommands: string[];
  clippyCommands: string[];
  testCommands: string[];
}

export interface PlatformWorkflowCoverage {
  workflow: string;
  job: string;
  if: string;
  runner: string;
  commands: string[];
  scriptRequirements: Record<string, string[]>;
}

export interface PlatformTargetPolicy {
  schemaVersion: number;
  workspaceRoots: PlatformWorkspaceRootPolicy[];
  packages: PlatformPackagePolicy[];
  workflowCoverage: PlatformWorkflowCoverage[];
}

export interface CargoWorkspacePackage {
  name: string;
  manifest_path: string;
}

export interface PlatformTargetValidationInput {
  policy: PlatformTargetPolicy;
  workflows: ParsedWorkflow[];
  packageScripts: Record<string, string>;
  cargoPackages: CargoWorkspacePackage[];
}

const workflowKeys = new Set([
  "name",
  "run-name",
  "on",
  "permissions",
  "env",
  "defaults",
  "concurrency",
  "jobs",
]);
const normalJobKeys = new Set([
  "name",
  "if",
  "needs",
  "permissions",
  "runs-on",
  "timeout-minutes",
  "steps",
  "strategy",
  "continue-on-error",
  "container",
  "services",
  "env",
  "defaults",
  "outputs",
  "concurrency",
  "environment",
]);
const reusableJobKeys = new Set([
  "name",
  "if",
  "needs",
  "permissions",
  "uses",
  "with",
  "secrets",
  "strategy",
  "concurrency",
]);
const stepKeys = new Set([
  "id",
  "if",
  "name",
  "run",
  "uses",
  "with",
  "env",
  "shell",
  "working-directory",
  "timeout-minutes",
  "continue-on-error",
]);

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function read(relative: string): string {
  return readFileSync(path.join(repositoryRoot, relative), "utf8");
}

export function readPlatformTargetPolicy(): PlatformTargetPolicy {
  const value = JSON.parse(read(".github/platform-target-policy.json")) as unknown;
  invariant(isRecord(value), "Platform target policy must contain a mapping.");
  return value as PlatformTargetPolicy;
}

function repositoryRelativeManifest(manifestPath: string): string {
  const absolute = path.isAbsolute(manifestPath)
    ? manifestPath
    : path.resolve(repositoryRoot, manifestPath);
  return path.relative(repositoryRoot, absolute).split(path.sep).join("/");
}

function packageManifestByName(
  packages: CargoWorkspacePackage[],
): Map<string, CargoWorkspacePackage> {
  return new Map(packages.map((package_) => [package_.name, package_]));
}

const supportedPlatformRunners = new Set(["macos-15", "ubuntu-24.04"]);

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isStringArrayMap(value: unknown): value is Record<string, string[]> {
  return isRecord(value) && Object.values(value).every((entry) => isStringArray(entry));
}

function isPlatformWorkspaceRootPolicy(value: unknown): value is PlatformWorkspaceRootPolicy {
  return isRecord(value) && isNonEmptyString(value.prefix) && isNonEmptyString(value.family);
}

function isPlatformPackagePolicy(value: unknown): value is PlatformPackagePolicy {
  return (
    isRecord(value) &&
    isNonEmptyString(value.name) &&
    isNonEmptyString(value.manifest) &&
    isNonEmptyString(value.family) &&
    isStringArray(value.targets) &&
    isNonEmptyString(value.runner) &&
    isNonEmptyString(value.workflow) &&
    isNonEmptyString(value.job) &&
    isNonEmptyString(value.checkScript) &&
    isNonEmptyString(value.testScript) &&
    (value.testMode === "run" || value.testMode === "compile-only") &&
    isNonEmptyString(value.hostLimitation) &&
    isStringArray(value.compileCommands) &&
    isStringArray(value.clippyCommands) &&
    isStringArray(value.testCommands)
  );
}

function isPlatformWorkflowCoverage(value: unknown): value is PlatformWorkflowCoverage {
  return (
    isRecord(value) &&
    isNonEmptyString(value.workflow) &&
    isNonEmptyString(value.job) &&
    isNonEmptyString(value.if) &&
    isNonEmptyString(value.runner) &&
    isStringArray(value.commands) &&
    isStringArrayMap(value.scriptRequirements)
  );
}

function workflowRunCommands(workflow: ParsedWorkflow, jobName: string): string[] {
  return (workflow.workflow.jobs?.[jobName]?.steps ?? [])
    .map((step) => step.run)
    .filter((run): run is string => typeof run === "string");
}

export function validatePlatformTargetCoverage({
  policy,
  workflows,
  packageScripts,
  cargoPackages,
}: PlatformTargetValidationInput): string[] {
  const errors: string[] = [];
  if (policy.schemaVersion !== 1) {
    errors.push("Platform target policy schema changed.");
  }
  if (!Array.isArray(policy.workspaceRoots) || policy.workspaceRoots.length === 0) {
    errors.push("Platform target policy must declare workspace roots.");
  }
  if (!Array.isArray(policy.packages) || policy.packages.length === 0) {
    errors.push("Platform target policy must declare covered workspace packages.");
  }
  if (!Array.isArray(policy.workflowCoverage) || policy.workflowCoverage.length === 0) {
    errors.push("Platform target policy must declare workflow coverage.");
  }
  if (errors.length > 0) return errors;

  const workspaceRoots = policy.workspaceRoots as unknown[];
  const validWorkspaceRoots: PlatformWorkspaceRootPolicy[] = [];
  for (const [index, root] of workspaceRoots.entries()) {
    if (!isPlatformWorkspaceRootPolicy(root)) {
      errors.push(`Platform target policy workspace root ${index} is malformed.`);
      continue;
    }
    if (!root.prefix.endsWith("/") && !root.prefix.endsWith("-")) {
      errors.push(
        `Platform target policy workspace root ${root.prefix} must end with / or a family separator.`,
      );
    }
    if (validWorkspaceRoots.some((candidate) => candidate.prefix === root.prefix)) {
      errors.push(`Platform target policy duplicates workspace root ${root.prefix}.`);
    }
    validWorkspaceRoots.push(root);
  }

  const rawPackages = policy.packages as unknown[];
  const validPackages: PlatformPackagePolicy[] = [];
  for (const [index, packagePolicy] of rawPackages.entries()) {
    if (!isPlatformPackagePolicy(packagePolicy)) {
      errors.push(`Platform target policy package ${index} is malformed.`);
      continue;
    }
    validPackages.push(packagePolicy);
  }

  const rawWorkflowCoverage = policy.workflowCoverage as unknown[];
  const validWorkflowCoverage: PlatformWorkflowCoverage[] = [];
  for (const [index, coverage] of rawWorkflowCoverage.entries()) {
    if (!isPlatformWorkflowCoverage(coverage)) {
      errors.push(`Platform target workflow coverage ${index} is malformed.`);
      continue;
    }
    validWorkflowCoverage.push(coverage);
  }

  const packageNames = new Set<string>();
  const manifests = new Set<string>();
  const packageByName = packageManifestByName(cargoPackages);
  const workflowByPath = new Map<string, ParsedWorkflow>();
  for (const workflow of workflows) {
    if (workflowByPath.has(workflow.relative)) {
      errors.push(`Workflow parser returned duplicate workflow ${workflow.relative}.`);
    }
    workflowByPath.set(workflow.relative, workflow);
  }
  const coverageByJob = new Map<string, PlatformWorkflowCoverage>();
  for (const coverage of validWorkflowCoverage) {
    const key = `${coverage.workflow}#${coverage.job}`;
    if (coverageByJob.has(key)) {
      errors.push(`Platform workflow coverage duplicates ${key}.`);
    }
    coverageByJob.set(key, coverage);
  }

  for (const packagePolicy of validPackages) {
    if (packageNames.has(packagePolicy.name)) {
      errors.push(`Platform package policy duplicates ${packagePolicy.name}.`);
    }
    packageNames.add(packagePolicy.name);

    const manifest = repositoryRelativeManifest(packagePolicy.manifest);
    if (manifests.has(manifest)) {
      errors.push(`Platform package policy duplicates manifest ${manifest}.`);
    }
    manifests.add(manifest);

    if (
      packagePolicy.targets.length === 0 ||
      packagePolicy.runner.length === 0 ||
      packagePolicy.hostLimitation.length === 0
    ) {
      errors.push(`${packagePolicy.name} must declare targets, runner, and host limitation.`);
    }
    if (!supportedPlatformRunners.has(packagePolicy.runner)) {
      errors.push(
        `${packagePolicy.name} uses unsupported platform runner ${packagePolicy.runner}.`,
      );
    }
    if (packagePolicy.compileCommands.length === 0) {
      errors.push(`${packagePolicy.name} must declare compile commands.`);
    }
    if (packagePolicy.clippyCommands.length === 0) {
      errors.push(`${packagePolicy.name} must declare Clippy commands.`);
    }
    if (packagePolicy.testCommands.length === 0) {
      errors.push(`${packagePolicy.name} must declare test commands.`);
    }
    if (packagePolicy.testMode === "compile-only") {
      for (const command of packagePolicy.testCommands) {
        if (!command.includes("--no-run")) {
          errors.push(`${packagePolicy.name} compile-only test is missing --no-run.`);
        }
      }
    }
    const packageCommands = [
      ...packagePolicy.compileCommands,
      ...packagePolicy.clippyCommands,
      ...packagePolicy.testCommands,
    ];
    for (const command of packageCommands) {
      if (!command.includes(`-p ${packagePolicy.name}`)) {
        errors.push(
          `${packagePolicy.name} policy command is not scoped to that package: ${command}.`,
        );
      }
    }
    for (const target of packagePolicy.targets) {
      if (target === "host") continue;
      const targetToken = `--target ${target}`;
      if (!packagePolicy.compileCommands.some((command) => command.includes(targetToken))) {
        errors.push(`${packagePolicy.name} compile policy does not cover target ${target}.`);
      }
      if (!packagePolicy.clippyCommands.some((command) => command.includes(targetToken))) {
        errors.push(`${packagePolicy.name} Clippy policy does not cover target ${target}.`);
      }
      if (!packagePolicy.testCommands.some((command) => command.includes(targetToken))) {
        errors.push(`${packagePolicy.name} test policy does not cover target ${target}.`);
      }
    }

    const matchingRoots = validWorkspaceRoots.filter((root) =>
      repositoryRelativeManifest(packagePolicy.manifest).startsWith(root.prefix),
    );
    if (matchingRoots.length !== 1) {
      errors.push(`${packagePolicy.name} manifest must match exactly one declared workspace root.`);
    } else if (matchingRoots[0].family !== packagePolicy.family) {
      errors.push(`${packagePolicy.name} family does not match its workspace root.`);
    }

    const cargoPackage = packageByName.get(packagePolicy.name);
    if (!cargoPackage) {
      errors.push(
        `Platform workspace package is missing from Cargo metadata: ${packagePolicy.name}.`,
      );
    } else if (repositoryRelativeManifest(cargoPackage.manifest_path) !== manifest) {
      errors.push(
        `${packagePolicy.name} moved from ${manifest} to ${repositoryRelativeManifest(cargoPackage.manifest_path)} without a policy update.`,
      );
    }

    const checkScript = packageScripts[packagePolicy.checkScript];
    if (typeof checkScript !== "string") {
      errors.push(`${packagePolicy.name} is missing package script ${packagePolicy.checkScript}.`);
    } else {
      for (const command of [...packagePolicy.compileCommands, ...packagePolicy.clippyCommands]) {
        if (!checkScript.includes(command)) {
          errors.push(`${packagePolicy.checkScript} does not execute ${command}.`);
        }
      }
    }
    const testScript = packageScripts[packagePolicy.testScript];
    if (typeof testScript !== "string") {
      errors.push(`${packagePolicy.name} is missing package script ${packagePolicy.testScript}.`);
    } else {
      for (const command of packagePolicy.testCommands) {
        if (!testScript.includes(command)) {
          errors.push(`${packagePolicy.testScript} does not execute ${command}.`);
        }
      }
    }

    const workflowCoverage = coverageByJob.get(`${packagePolicy.workflow}#${packagePolicy.job}`);
    if (!workflowCoverage) {
      errors.push(
        `${packagePolicy.name} is not attached to workflow coverage ${packagePolicy.workflow}#${packagePolicy.job}.`,
      );
    } else if (
      workflowCoverage.runner !== packagePolicy.runner ||
      workflowCoverage.workflow !== packagePolicy.workflow
    ) {
      errors.push(`${packagePolicy.name} workflow runner or path does not match its policy.`);
    }
  }

  const platformManifestPrefixes = validWorkspaceRoots.map((root) => root.prefix);
  for (const cargoPackage of cargoPackages) {
    const manifest = repositoryRelativeManifest(cargoPackage.manifest_path);
    if (!platformManifestPrefixes.some((prefix) => manifest.startsWith(prefix))) continue;
    if (!packageNames.has(cargoPackage.name)) {
      errors.push(
        `Platform workspace package has no compile/Clippy/test policy: ${cargoPackage.name} (${manifest}).`,
      );
    }
  }

  for (const coverage of validWorkflowCoverage) {
    if (!localWorkflowPath.test(coverage.workflow)) {
      errors.push(`Platform workflow coverage uses an unsafe workflow path ${coverage.workflow}.`);
    }
    if (coverage.commands.length === 0) {
      errors.push(`${coverage.workflow}#${coverage.job} must declare workflow commands.`);
    }
    if (!supportedPlatformRunners.has(coverage.runner)) {
      errors.push(
        `${coverage.workflow}#${coverage.job} uses unsupported platform runner ${coverage.runner}.`,
      );
    }
    const workflow = workflowByPath.get(coverage.workflow);
    if (!workflow) {
      errors.push(`Platform workflow coverage references missing workflow ${coverage.workflow}.`);
      continue;
    }
    const job = workflow.workflow.jobs?.[coverage.job];
    if (!job) {
      errors.push(
        `Platform workflow coverage references missing job ${coverage.workflow}#${coverage.job}.`,
      );
      continue;
    }
    if (job.if !== coverage.if) {
      errors.push(`${coverage.workflow}#${coverage.job} has an unexpected trigger condition.`);
    }
    if (JSON.stringify(job["runs-on"]) !== JSON.stringify(coverage.runner)) {
      errors.push(`${coverage.workflow}#${coverage.job} has an unexpected runner.`);
    }
    const commands = workflowRunCommands(workflow, coverage.job);
    for (const command of coverage.commands) {
      if (!commands.some((run) => run.includes(command))) {
        errors.push(`${coverage.workflow}#${coverage.job} does not execute ${command}.`);
      }
    }
    for (const [scriptName, requirements] of Object.entries(coverage.scriptRequirements)) {
      const script = packageScripts[scriptName];
      if (typeof script !== "string") {
        errors.push(`Platform workflow coverage requires missing package script ${scriptName}.`);
        continue;
      }
      for (const requirement of requirements) {
        if (!script.includes(requirement)) {
          errors.push(`${scriptName} does not retain platform coverage command ${requirement}.`);
        }
      }
    }
  }

  for (const packagePolicy of validPackages) {
    const workflowCoverage = coverageByJob.get(`${packagePolicy.workflow}#${packagePolicy.job}`);
    if (!workflowCoverage) continue;
    const directCommands = workflowCoverage.commands;
    const checkCovered = directCommands.includes(`pnpm ${packagePolicy.checkScript}`);
    const testCovered = directCommands.includes(`pnpm ${packagePolicy.testScript}`);
    const checkIndirect = Object.values(workflowCoverage.scriptRequirements).some((requirements) =>
      requirements.includes(`pnpm ${packagePolicy.checkScript}`),
    );
    const testIndirect = Object.values(workflowCoverage.scriptRequirements).some((requirements) =>
      requirements.includes(packagePolicy.testCommands[0]),
    );
    if (!checkCovered && !checkIndirect) {
      errors.push(
        `${packagePolicy.name} compile/Clippy script is not reachable from its workflow job.`,
      );
    }
    if (!testCovered && !testIndirect) {
      errors.push(`${packagePolicy.name} test script is not reachable from its workflow job.`);
    }
  }

  return errors;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOwn(record: Record<string, unknown>, key: string): boolean {
  return Object.hasOwn(record, key);
}

function validateKnownKeys(
  value: Record<string, unknown>,
  allowed: Set<string>,
  context: string,
): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.has(key))
    .map((key) => `${context} uses unsupported key ${key}.`);
}

function validateStringMap(value: unknown, context: string): string[] {
  if (!isRecord(value)) return [`${context} must be a mapping.`];
  return Object.entries(value)
    .filter(([, entry]) => typeof entry !== "string")
    .map(([key]) => `${context}.${key} must be a string.`);
}

function validateScalarMap(value: unknown, context: string): string[] {
  if (!isRecord(value)) return [`${context} must be a mapping.`];
  return Object.entries(value)
    .filter(
      ([, entry]) =>
        entry !== null &&
        typeof entry !== "string" &&
        typeof entry !== "number" &&
        typeof entry !== "boolean",
    )
    .map(([key]) => `${context}.${key} must be a scalar.`);
}

function validatePositiveInteger(value: unknown, context: string): string[] {
  return Number.isInteger(value) && (value as number) > 0
    ? []
    : [`${context} must be a positive integer.`];
}

function validateNeeds(value: unknown, context: string): string[] {
  if (typeof value === "string" && value.length > 0) return [];
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((entry) => typeof entry === "string")
  ) {
    return [];
  }
  return [`${context} must be a job ID or a non-empty list of job IDs.`];
}

function validatePermissions(value: unknown, context: string): string[] {
  const errors = validateStringMap(value, context);
  if (errors.length > 0 || !isRecord(value)) return errors;
  for (const [permission, level] of Object.entries(value)) {
    if (!new Set(["none", "read", "write"]).has(level)) {
      errors.push(`${context}.${permission} must be none, read, or write.`);
    }
  }
  return errors;
}

function parseWorkflowSource(source: string, relative: string): ParsedWorkflow {
  const document = parseDocument(source);
  invariant(
    document.errors.length === 0,
    `${relative} is invalid YAML: ${document.errors.join("; ")}`,
  );
  const value = document.toJS();
  invariant(isRecord(value), `${relative} must contain a workflow mapping.`);
  return { relative, source, workflow: value as Workflow };
}

export function parseWorkflowFixture(source: string, relative = "fixture.yml"): ParsedWorkflow {
  return parseWorkflowSource(source, relative);
}

function parseLocalReference(reference: string): { path?: string; reason?: string } | null {
  const prefix = reference.startsWith("./") ? "./" : reference.startsWith("$/") ? "$/" : null;
  if (!prefix) return null;
  const localPath = reference.slice(prefix.length);
  const segments = localPath.split("/");
  if (
    localPath.length === 0 ||
    localPath.startsWith("/") ||
    segments.some((segment) => segment.length === 0 || segment === "." || segment === "..") ||
    segments.some((segment) => !referenceIdentifier.test(segment))
  ) {
    return { reason: "local reference path is not a safe static path" };
  }
  return { path: localPath };
}

interface ExternalReference {
  repository: string;
  path: string;
  ref: string;
}

function parseExternalReference(reference: string): ExternalReference | null {
  const match = fullExternalReference.exec(reference);
  if (!match?.groups) return null;
  const segments = match.groups.left.split("/");
  if (
    segments.length < 2 ||
    segments.some((segment) => segment.length === 0 || !referenceIdentifier.test(segment))
  ) {
    return null;
  }
  return {
    repository: `${segments[0]}/${segments[1]}`,
    path: segments.slice(2).join("/"),
    ref: match.groups.ref,
  };
}

export function classifyWorkflowReference(
  reference: string,
  location: "step" | "job",
  metadata: { workflowPath?: string; jobName?: string; stepIndex?: number } = {},
): WorkflowReference {
  const base = {
    reference,
    location,
    workflowPath: metadata.workflowPath ?? "fixture.yml",
    jobName: metadata.jobName ?? "fixture-job",
    ...(metadata.stepIndex === undefined ? {} : { stepIndex: metadata.stepIndex }),
  };
  if (typeof reference !== "string" || reference.length === 0) {
    return { ...base, kind: "unsupported", reason: "reference must be a non-empty string" };
  }

  const local = parseLocalReference(reference);
  if (local) {
    if (!local.path) return { ...base, kind: "unsupported", reason: local.reason };
    if (localWorkflowPath.test(local.path)) {
      return location === "job"
        ? { ...base, kind: "local-reusable-workflow", path: local.path }
        : {
            ...base,
            kind: "unsupported",
            path: local.path,
            reason: "a workflow file cannot be used as a step action",
          };
    }
    return location === "step"
      ? { ...base, kind: "local-action", path: local.path }
      : {
          ...base,
          kind: "unsupported",
          path: local.path,
          reason: "a job-level uses reference must target a reusable workflow",
        };
  }

  const external = parseExternalReference(reference);
  if (!external) {
    return { ...base, kind: "unsupported", reason: "reference syntax is unsupported" };
  }
  if (localWorkflowPath.test(external.path)) {
    return location === "job"
      ? {
          ...base,
          kind: "external-reusable-workflow",
          repository: external.repository,
          path: external.path,
          ref: external.ref,
        }
      : {
          ...base,
          kind: "unsupported",
          repository: external.repository,
          path: external.path,
          ref: external.ref,
          reason: "a reusable workflow cannot be used as a step action",
        };
  }
  return location === "step"
    ? {
        ...base,
        kind: "external-action",
        repository: external.repository,
        path: external.path,
        ref: external.ref,
      }
    : {
        ...base,
        kind: "unsupported",
        repository: external.repository,
        path: external.path,
        ref: external.ref,
        reason: "a job-level uses reference must target a reusable workflow",
      };
}

export function classifyWorkflowStep(
  step: WorkflowStep,
  metadata: { workflowPath?: string; jobName?: string; stepIndex?: number } = {},
): WorkflowStepInspection {
  const stepIndex = metadata.stepIndex ?? 0;
  if (typeof step.run === "string" && step.uses === undefined) {
    return {
      kind: "run",
      location: "step",
      workflowPath: metadata.workflowPath ?? "fixture.yml",
      jobName: metadata.jobName ?? "fixture-job",
      stepIndex,
    };
  }
  return classifyWorkflowReference(step.uses ?? "", "step", {
    ...metadata,
    stepIndex,
  });
}

export function collectWorkflowReferences(
  workflow: Workflow,
  workflowPath = "fixture.yml",
): WorkflowReference[] {
  return Object.entries(workflow.jobs ?? {}).flatMap(([jobName, job]) => {
    if (typeof job.uses === "string") {
      return [
        classifyWorkflowReference(job.uses, "job", {
          workflowPath,
          jobName,
        }),
      ];
    }
    return (job.steps ?? []).flatMap((step, stepIndex) => {
      const inspection = classifyWorkflowStep(step, { workflowPath, jobName, stepIndex });
      return inspection.kind === "run" ? [] : [inspection];
    });
  });
}

function validateExternalActionReference(
  policy: TrustedReleasePolicy,
  reference: WorkflowReference,
): string[] {
  const errors: string[] = [];
  const repository = reference.repository ?? "unknown";
  const ref = reference.ref ?? "";
  if (policy.actions.requireFullCommitSha && !fullSha.test(ref)) {
    errors.push(`Action is not pinned by full SHA: ${reference.reference}`);
  }
  const expected = policy.actions.allowed[repository];
  if (!expected) {
    errors.push(`Action is not allowlisted: ${repository}`);
    return errors;
  }
  if (fullSha.test(ref) && expected !== ref) {
    errors.push(`Action digest drifted: ${repository}`);
  }
  return errors;
}

export function validateWorkflowReference(
  policy: TrustedReleasePolicy,
  reference: WorkflowReference,
): string[] {
  if (reference.kind === "local-action") return [];
  if (reference.kind === "unsupported") {
    return [
      `Unsupported ${reference.location} uses reference ${reference.reference}: ${reference.reason}.`,
    ];
  }
  if (reference.kind === "external-action") {
    return validateExternalActionReference(policy, reference);
  }
  if (!policy.actions.allowedReusableWorkflows.includes(reference.reference)) {
    return [`Reusable workflow is not allowlisted: ${reference.reference}`];
  }
  if (policy.actions.requireFullCommitSha && reference.kind === "external-reusable-workflow") {
    if (!fullSha.test(reference.ref ?? "")) {
      return [`Reusable workflow is not pinned by full SHA: ${reference.reference}`];
    }
  }
  return [];
}

export function validateActionReferences(
  policy: TrustedReleasePolicy,
  references: string[],
): string[] {
  return references.flatMap((reference) => {
    const classified = classifyWorkflowReference(reference, "step");
    return validateWorkflowReference(policy, classified);
  });
}

function validateConcurrency(value: unknown, context: string): string[] {
  if (typeof value === "string") return value.length > 0 ? [] : [`${context} must not be empty.`];
  if (!isRecord(value)) return [`${context} must be a string or mapping.`];
  const errors = validateKnownKeys(value, new Set(["group", "cancel-in-progress"]), context);
  if (typeof value.group !== "string" || value.group.length === 0) {
    errors.push(`${context}.group must be a non-empty string.`);
  }
  if (
    value["cancel-in-progress"] !== undefined &&
    typeof value["cancel-in-progress"] !== "boolean" &&
    typeof value["cancel-in-progress"] !== "string"
  ) {
    errors.push(`${context}.cancel-in-progress must be a boolean or expression string.`);
  }
  return errors;
}

function validateStepShape(value: unknown, context: string): string[] {
  if (!isRecord(value)) return [`${context} must be a mapping.`];
  const errors = validateKnownKeys(value, stepKeys, context);
  const hasRun = hasOwn(value, "run");
  const hasUses = hasOwn(value, "uses");
  if (hasRun === hasUses) {
    errors.push(`${context} must contain exactly one of run or uses.`);
  }
  if (hasRun && (typeof value.run !== "string" || value.run.length === 0)) {
    errors.push(`${context}.run must be a non-empty string.`);
  }
  if (hasUses && (typeof value.uses !== "string" || value.uses.length === 0)) {
    errors.push(`${context}.uses must be a non-empty string.`);
  }
  for (const key of ["id", "if", "name", "shell", "working-directory"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") {
      errors.push(`${context}.${key} must be a string.`);
    }
  }
  if (value.with !== undefined) {
    errors.push(...validateScalarMap(value.with, `${context}.with`));
    if (!hasUses) errors.push(`${context}.with is only supported on action steps.`);
  }
  if (value.env !== undefined) errors.push(...validateScalarMap(value.env, `${context}.env`));
  if (value["timeout-minutes"] !== undefined) {
    errors.push(...validatePositiveInteger(value["timeout-minutes"], `${context}.timeout-minutes`));
  }
  if (
    value["continue-on-error"] !== undefined &&
    typeof value["continue-on-error"] !== "boolean" &&
    typeof value["continue-on-error"] !== "string"
  ) {
    errors.push(`${context}.continue-on-error must be a boolean or expression string.`);
  }
  return errors;
}

function validateJobShape(value: unknown, context: string): string[] {
  if (!isRecord(value)) return [`${context} must be a mapping.`];
  const reusable = hasOwn(value, "uses");
  const errors = validateKnownKeys(value, reusable ? reusableJobKeys : normalJobKeys, context);
  if (value.name !== undefined && typeof value.name !== "string") {
    errors.push(`${context}.name must be a string.`);
  }
  if (value.if !== undefined && typeof value.if !== "string") {
    errors.push(`${context}.if must be a string.`);
  }
  if (value.needs !== undefined) errors.push(...validateNeeds(value.needs, `${context}.needs`));
  if (value.permissions !== undefined) {
    errors.push(...validatePermissions(value.permissions, `${context}.permissions`));
  }
  if (value["timeout-minutes"] !== undefined) {
    errors.push(...validatePositiveInteger(value["timeout-minutes"], `${context}.timeout-minutes`));
  }
  if (value.strategy !== undefined && !isRecord(value.strategy)) {
    errors.push(`${context}.strategy must be a mapping.`);
  }
  if (
    value["continue-on-error"] !== undefined &&
    typeof value["continue-on-error"] !== "boolean" &&
    typeof value["continue-on-error"] !== "string"
  ) {
    errors.push(`${context}.continue-on-error must be a boolean or expression string.`);
  }
  if (value.env !== undefined) errors.push(...validateScalarMap(value.env, `${context}.env`));
  if (value.defaults !== undefined && !isRecord(value.defaults)) {
    errors.push(`${context}.defaults must be a mapping.`);
  }
  if (value.concurrency !== undefined) {
    errors.push(...validateConcurrency(value.concurrency, `${context}.concurrency`));
  }

  if (reusable) {
    if (typeof value.uses !== "string" || value.uses.length === 0) {
      errors.push(`${context}.uses must be a non-empty string.`);
    }
    for (const forbidden of [
      "runs-on",
      "steps",
      "timeout-minutes",
      "container",
      "services",
      "environment",
    ]) {
      if (hasOwn(value, forbidden)) {
        errors.push(`${context}.${forbidden} is not valid on a reusable-workflow job.`);
      }
    }
    if (value.with !== undefined) errors.push(...validateScalarMap(value.with, `${context}.with`));
    if (value.secrets !== undefined && value.secrets !== "inherit") {
      errors.push(...validateScalarMap(value.secrets, `${context}.secrets`));
    }
    return errors;
  }

  if (typeof value["runs-on"] !== "string" && !Array.isArray(value["runs-on"])) {
    errors.push(`${context}.runs-on must be a string or non-empty list.`);
  } else if (
    (typeof value["runs-on"] === "string" && value["runs-on"].length === 0) ||
    (Array.isArray(value["runs-on"]) &&
      (value["runs-on"].length === 0 ||
        value["runs-on"].some((entry) => typeof entry !== "string")))
  ) {
    errors.push(`${context}.runs-on must contain a non-empty static runner label.`);
  }
  const runnerLabels =
    typeof value["runs-on"] === "string"
      ? [value["runs-on"]]
      : Array.isArray(value["runs-on"])
        ? value["runs-on"]
        : [];
  if (runnerLabels.some((label) => typeof label === "string" && label.includes("${{"))) {
    errors.push(`${context}.runs-on must not use a dynamic expression.`);
  }
  if (!Array.isArray(value.steps) || value.steps.length === 0) {
    errors.push(`${context}.steps must be a non-empty list.`);
  } else {
    value.steps.forEach((step, index) => {
      errors.push(...validateStepShape(step, `${context}.steps[${index}]`));
    });
  }
  if (value.with !== undefined)
    errors.push(`${context}.with is only supported on reusable-workflow jobs.`);
  if (value.secrets !== undefined) {
    errors.push(`${context}.secrets is only supported on reusable-workflow jobs.`);
  }
  if (value.outputs !== undefined)
    errors.push(...validateStringMap(value.outputs, `${context}.outputs`));
  if (
    value.container !== undefined &&
    typeof value.container !== "string" &&
    !isRecord(value.container)
  ) {
    errors.push(`${context}.container must be a string or mapping.`);
  }
  if (value.services !== undefined && !isRecord(value.services)) {
    errors.push(`${context}.services must be a mapping.`);
  }
  return errors;
}

function validateTriggerShape(value: unknown, context: string): string[] {
  if (typeof value === "string") return value.length > 0 ? [] : [`${context} must not be empty.`];
  if (Array.isArray(value)) {
    return value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0)
      ? []
      : [`${context} must be a non-empty list of event names.`];
  }
  if (!isRecord(value)) return [`${context} must be a string, list, or mapping.`];
  return Object.keys(value)
    .map((event) => (event.length > 0 ? "" : `${context} contains an empty event name.`))
    .filter(Boolean);
}

function validateWorkflowShape(workflow: Workflow, relative: string): string[] {
  const value = workflow as unknown as Record<string, unknown>;
  const errors = validateKnownKeys(value, workflowKeys, relative);
  if (value.name !== undefined && typeof value.name !== "string") {
    errors.push(`${relative}.name must be a string.`);
  }
  if (value["run-name"] !== undefined && typeof value["run-name"] !== "string") {
    errors.push(`${relative}.run-name must be a string.`);
  }
  if (!hasOwn(value, "on")) errors.push(`${relative} is missing the on trigger.`);
  else errors.push(...validateTriggerShape(value.on, `${relative}.on`));
  if (value.permissions !== undefined) {
    errors.push(...validatePermissions(value.permissions, `${relative}.permissions`));
  }
  if (value.env !== undefined) errors.push(...validateScalarMap(value.env, `${relative}.env`));
  if (value.defaults !== undefined && !isRecord(value.defaults)) {
    errors.push(`${relative}.defaults must be a mapping.`);
  }
  if (value.concurrency !== undefined) {
    errors.push(...validateConcurrency(value.concurrency, `${relative}.concurrency`));
  }
  if (!isRecord(value.jobs) || Object.keys(value.jobs).length === 0) {
    errors.push(`${relative}.jobs must be a non-empty mapping.`);
    return errors;
  }
  for (const [jobName, job] of Object.entries(value.jobs)) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]*$/u.test(jobName)) {
      errors.push(`${relative} job ID is unsafe: ${jobName}`);
    }
    errors.push(...validateJobShape(job, `${relative} job ${jobName}`));
  }
  return errors;
}

function workflowEventNames(on: unknown): Set<string> {
  if (typeof on === "string") return new Set([on]);
  if (Array.isArray(on))
    return new Set(on.filter((event): event is string => typeof event === "string"));
  if (isRecord(on)) return new Set(Object.keys(on));
  return new Set();
}

function jobMayRunOnPullRequest(workflow: Workflow, job: WorkflowJob): boolean {
  if (!workflowEventNames(workflow.on).has("pull_request")) return false;
  if (!job.if) return true;
  const eventTests = [...job.if.matchAll(/github\.event_name\s*==\s*['"]([^'"]+)['"]/gu)].map(
    (match) => match[1],
  );
  if (eventTests.length === 0) return true;
  return eventTests.includes("pull_request");
}

function sameStringRecord(
  left: Record<string, string> | undefined,
  right: Record<string, string>,
): boolean {
  if (!left) return false;
  const leftEntries = Object.entries(left).sort(([a], [b]) => a.localeCompare(b));
  const rightEntries = Object.entries(right).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(leftEntries) === JSON.stringify(rightEntries);
}

function containsSecretReference(value: unknown): boolean {
  if (typeof value === "string") return /\$\{\{\s*secrets(?:[.\s[])/u.test(value);
  if (Array.isArray(value)) return value.some((entry) => containsSecretReference(entry));
  if (!isRecord(value)) return false;
  return Object.values(value).some((entry) => containsSecretReference(entry));
}

export function validateUntrustedWorkflowJob(
  policy: TrustedReleasePolicy,
  job: WorkflowJob,
  workflow?: Workflow,
  references: WorkflowReference[] = [],
): string[] {
  const errors: string[] = [];
  const runner = job["runs-on"];
  if (JSON.stringify(runner) !== JSON.stringify(policy.untrusted.runnerLabels[0])) {
    errors.push("untrusted job runner is not the isolated GitHub-hosted runner");
  }
  const permissions = job.permissions ?? workflow?.permissions ?? policy.untrusted.permissions;
  if (!sameStringRecord(permissions, policy.untrusted.permissions)) {
    errors.push("untrusted job permissions exceed contents: read");
  }
  if (!policy.untrusted.allowSelfHosted && JSON.stringify(runner).includes("self-hosted")) {
    errors.push("untrusted job reaches a self-hosted runner");
  }
  if (!policy.untrusted.allowSecrets && containsSecretReference(job)) {
    errors.push("untrusted job reads a secret");
  }
  if (!policy.untrusted.allowOidc && permissions?.["id-token"] !== undefined) {
    errors.push("untrusted job can mint OIDC tokens");
  }
  if (
    !policy.untrusted.allowArtifactUpload &&
    references.some(
      (reference) =>
        reference.kind === "external-action" && reference.repository === "actions/upload-artifact",
    )
  ) {
    errors.push("untrusted job uploads an artifact");
  }
  if (!policy.untrusted.allowReusableWorkflowCalls && job.uses) {
    errors.push("untrusted job calls a reusable workflow");
  }
  if (job.environment !== undefined) errors.push("untrusted job enters an Environment");
  if (job.container !== undefined || job.services !== undefined) {
    errors.push("untrusted job uses a container or service boundary");
  }
  return errors;
}

export function discoverWorkflowFiles(
  workflowDirectory = path.join(repositoryRoot, ".github/workflows"),
): string[] {
  return readdirSync(workflowDirectory, { withFileTypes: true })
    .filter((entry) => /\.ya?ml$/u.test(entry.name))
    .map((entry) => {
      invariant(entry.isFile(), `Workflow file must be a regular file: ${entry.name}`);
      return entry.name;
    })
    .sort();
}

function localWorkflowTarget(reference: WorkflowReference): string | null {
  if (reference.kind !== "local-reusable-workflow" || !reference.path) return null;
  return reference.path;
}

export function validateWorkflow(
  policy: TrustedReleasePolicy,
  relative: string,
  workflow: Workflow,
  options: WorkflowValidationOptions = {},
): string[] {
  const errors = validateWorkflowShape(workflow, relative);
  const references = collectWorkflowReferences(workflow, relative);
  for (const reference of references) {
    errors.push(...validateWorkflowReference(policy, reference));
    const target = localWorkflowTarget(reference);
    if (target && options.knownWorkflowPaths) {
      const known = new Set(options.knownWorkflowPaths);
      if (!known.has(target) && !known.has(`./${target}`) && !known.has(`$/${target}`)) {
        errors.push(
          `Local reusable workflow is not present in the workflow inventory: ${reference.reference}`,
        );
      }
    }
  }

  if (!isRecord(workflow.jobs)) return errors;
  const eventNames = workflowEventNames(workflow.on);
  for (const event of ["pull_request_target", "workflow_run", "repository_dispatch"]) {
    if (eventNames.has(event)) {
      errors.push(`${relative} uses unsupported privileged trigger ${event}.`);
    }
  }
  for (const [jobName, job] of Object.entries(workflow.jobs)) {
    if (workflow.permissions === undefined && job.permissions === undefined) {
      errors.push(`${relative} job ${jobName} must declare explicit permissions.`);
    }
    const permissions = job.permissions ?? workflow.permissions;
    if (
      !policy.oidc.enabled &&
      permissions?.["id-token"] !== undefined &&
      permissions["id-token"] !== "none"
    ) {
      errors.push(`${relative} job ${jobName} requests OIDC permission while OIDC is disabled.`);
    }
    if (!policy.untrusted.allowSecrets && containsSecretReference(job)) {
      errors.push(
        `${relative} job ${jobName} contains a secret reference while secrets are disabled.`,
      );
    }
    if (
      !policy.protected.allowSelfHosted &&
      JSON.stringify(job["runs-on"] ?? "").includes("self-hosted")
    ) {
      errors.push(`${relative} job ${jobName} reaches a self-hosted runner.`);
    }
    const jobReferences = references.filter((reference) => reference.jobName === jobName);
    if (eventNames.has("pull_request") && jobMayRunOnPullRequest(workflow, job)) {
      errors.push(
        ...validateUntrustedWorkflowJob(policy, job, workflow, jobReferences).map(
          (error) => `${relative} job ${jobName}: ${error}`,
        ),
      );
    }
  }
  return errors;
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

const workflowFiles = discoverWorkflowFiles();
invariant(
  workflowFiles.includes("ci.yml") && workflowFiles.includes("stage-macos-alpha-release.yml"),
  "The required CI and release workflows are missing from the workflow inventory.",
);

const workflowPaths = workflowFiles.map((file) => `.github/workflows/${file}`);
const knownWorkflowPaths = new Set(workflowPaths);
const parsedWorkflows = workflowPaths.map((relative) => ({
  relative,
  ...parseWorkflowSource(read(relative), relative),
}));
for (const parsed of parsedWorkflows) {
  const errors = validateWorkflow(policy, parsed.relative, parsed.workflow, {
    knownWorkflowPaths,
  });
  invariant(errors.length === 0, errors.join("; "));
  assertCheckoutIsolation(parsed.relative, parsed.workflow);
}
const workflowJobCount = parsedWorkflows.reduce(
  (count, parsed) => count + Object.keys(parsed.workflow.jobs ?? {}).length,
  0,
);
const ci = parsedWorkflows.find((parsed) => parsed.relative === ".github/workflows/ci.yml");
const release = parsedWorkflows.find(
  (parsed) => parsed.relative === ".github/workflows/stage-macos-alpha-release.yml",
);
invariant(ci && release, "The required CI and release workflows could not be parsed.");
assertNoProtectedExecution(
  ".github/workflows/stage-macos-alpha-release.yml",
  release.source,
  release.workflow,
);

invariant(
  isRecord(ci.workflow.on) && Object.hasOwn(ci.workflow.on, "pull_request"),
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
  isRecord(release.workflow.on) &&
    JSON.stringify(Object.keys(release.workflow.on)) === JSON.stringify(["workflow_dispatch"]),
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
    packageJson.scripts?.["check:rust:pr"] ===
      "cargo clippy --workspace --all-targets --exclude mish-desktop --exclude mish-mobile --exclude tauri-plugin-mish-vpn --exclude mish-platform-macos --exclude mish-simulated-host --exclude mish-updater -- -D warnings && cargo clippy -p mish-updater --lib -- -D warnings" &&
    packageJson.scripts?.["check:rust:clippy"] ===
      "cargo clippy --workspace --all-targets -- -D warnings",
  "The secretless Fast PR gate must retain the portable workspace/all-target Clippy contract without weakening the complete main inspection.",
);
invariant(
  packageJson.scripts?.["test:scripts"]?.includes("trusted-release-policy.test.ts"),
  "The Fast PR gate must run trusted release adversarial fixtures.",
);
invariant(
  packageJson.scripts?.["test:scripts"]?.includes("check-trusted-ci-policy.test.ts"),
  "The Fast PR gate must run complete workflow/job policy fixtures.",
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

const platformTargetPolicy = readPlatformTargetPolicy();
const cargoMetadata = JSON.parse(
  execFileSync("cargo", ["metadata", "--format-version", "1", "--no-deps"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  }),
) as { packages: CargoWorkspacePackage[] };
const platformTargetErrors = validatePlatformTargetCoverage({
  policy: platformTargetPolicy,
  workflows: parsedWorkflows,
  packageScripts: packageJson.scripts ?? {},
  cargoPackages: cargoMetadata.packages,
});
invariant(platformTargetErrors.length === 0, platformTargetErrors.join("; "));

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
  `Trusted CI policy valid: inspected ${parsedWorkflows.length} workflows and ${workflowJobCount} jobs; untrusted jobs are secretless and GitHub-hosted; live protected identity is disabled; Internal TUN staging binds frozen workflow/tooling to immutable artifact IDs without signing or publication; action pin, CODEOWNERS, Environment, OIDC, and runner contracts are deterministic.`,
);
