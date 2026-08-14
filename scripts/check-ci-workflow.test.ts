import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { parseDocument, stringify } from "yaml";

import { validatePackageRevisionPolicy } from "./ci-package-revision-policy.ts";
import {
  requiredCiJobIds,
  requiredCiJobNames,
  validateCiWorkflowJobInventory,
  validateCiWorkflowJobNames,
} from "./check-ci-workflow.ts";

interface EventFixture {
  accepted: boolean;
  eventName: string;
  name: string;
  ref: string;
  sha: string;
}

interface StepFixture {
  "continue-on-error"?: boolean;
  name?: string;
  run?: string;
}

interface WorkflowFixture {
  jobs?: Record<string, { steps?: StepFixture[] }>;
}

const workflowPath = path.resolve(import.meta.dirname, "../.github/workflows/ci.yml");
const workflowSource = readFileSync(workflowPath, "utf8");
const workflow = parseDocument(workflowSource).toJS() as WorkflowFixture;
const eventFixtures = JSON.parse(
  readFileSync(
    path.resolve(import.meta.dirname, "fixtures/ci-package-revision/events.json"),
    "utf8",
  ),
) as EventFixture[];

function packageStep(jobId: string, name: string): StepFixture {
  const step = workflow.jobs?.[jobId]?.steps?.find((candidate) => candidate.name === name);
  assert.ok(step, `${jobId} fixture step ${name} must exist`);
  return step;
}

function runBashFixture(
  source: string,
  environment: Record<string, string>,
  cwd?: string,
): { output: string; succeeded: boolean } {
  const outputRoot = mkdtempSync(path.join(tmpdir(), "mish-package-revision-output-"));
  const outputPath = path.join(outputRoot, "github-output");
  try {
    execFileSync("bash", ["-c", source], {
      cwd,
      env: { PATH: process.env.PATH ?? "", ...environment, GITHUB_OUTPUT: outputPath },
      stdio: "pipe",
    });
    return { output: readFileSync(outputPath, "utf8"), succeeded: true };
  } catch {
    return { output: "", succeeded: false };
  } finally {
    rmSync(outputRoot, { force: true, recursive: true });
  }
}

function replaceOnce(source: string, expected: string, replacement: string): string {
  assert.ok(source.includes(expected), `fixture source must contain ${expected}`);
  return source.replace(expected, replacement);
}

function baselineJobs(): Record<string, unknown> {
  return Object.fromEntries(
    requiredCiJobIds.map((jobId) => [jobId, { name: requiredCiJobNames[jobId] }]),
  );
}

test("CI job inventory fails closed on additions, deletions, and renames", () => {
  assert.deepEqual(validateCiWorkflowJobInventory(baselineJobs()), []);

  const addedJob = { ...baselineJobs(), "unreviewed-job": {} };
  assert.deepEqual(validateCiWorkflowJobInventory(addedJob), [
    "CI workflow contains unreviewed job: unreviewed-job.",
  ]);

  const deletedJob = baselineJobs();
  delete deletedJob["platform-android-gate"];
  assert.deepEqual(validateCiWorkflowJobInventory(deletedJob), [
    "CI workflow is missing reviewed job: platform-android-gate.",
  ]);

  const renamedJob = baselineJobs();
  renamedJob["platform-android"] = renamedJob["platform-android-gate"];
  delete renamedJob["platform-android-gate"];
  assert.deepEqual(validateCiWorkflowJobInventory(renamedJob), [
    "CI workflow is missing reviewed job: platform-android-gate.",
    "CI workflow contains unreviewed job: platform-android.",
  ]);
});

test("CI job names fail closed when a required external-check context is renamed", () => {
  assert.deepEqual(validateCiWorkflowJobNames(baselineJobs()), []);

  const renamedJob = baselineJobs();
  renamedJob["pr-gate"] = { name: "Renamed PR gate" };
  assert.deepEqual(validateCiWorkflowJobNames(renamedJob), [
    "CI workflow job pr-gate must retain reviewed name: Fast PR gate.",
  ]);
});

test("package revision selection accepts only full-SHA main push and main dispatch fixtures", () => {
  const selection = packageStep("package-macos", "Select accepted package revision").run;
  assert.ok(selection);

  for (const fixture of eventFixtures) {
    const result = runBashFixture(selection, {
      EVENT_NAME: fixture.eventName,
      EVENT_REF: fixture.ref,
      EVENT_SHA: fixture.sha,
    });
    assert.equal(result.succeeded, fixture.accepted, fixture.name);
    if (fixture.accepted) {
      assert.equal(result.output, `accepted_sha=${fixture.sha}\n`, fixture.name);
    }
  }
});

test("verified HEAD fixtures keep a stale event commit frozen and reject moving main", () => {
  const repository = mkdtempSync(path.join(tmpdir(), "mish-package-revision-git-"));
  try {
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repository });
    execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: repository });
    execFileSync("git", ["config", "user.name", "Package Revision Fixture"], { cwd: repository });
    writeFileSync(path.join(repository, "fixture.txt"), "accepted\n");
    execFileSync("git", ["add", "fixture.txt"], { cwd: repository });
    execFileSync("git", ["commit", "-m", "accepted fixture"], { cwd: repository });
    const acceptedSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();

    writeFileSync(path.join(repository, "fixture.txt"), "main moved\n");
    execFileSync("git", ["commit", "-am", "moving main fixture"], { cwd: repository });
    const movingMainSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repository,
      encoding: "utf8",
    }).trim();
    assert.notEqual(acceptedSha, movingMainSha);

    const verifyHead = packageStep("package-macos", "Verify checked-out package revision").run;
    assert.ok(verifyHead);
    const moved = runBashFixture(verifyHead, { FROZEN_SOURCE_SHA: acceptedSha }, repository);
    assert.equal(moved.succeeded, false, "moving main must not satisfy the frozen event SHA");

    execFileSync("git", ["checkout", "--detach", acceptedSha], {
      cwd: repository,
      stdio: "ignore",
    });
    const staleButExact = runBashFixture(
      verifyHead,
      { FROZEN_SOURCE_SHA: acceptedSha },
      repository,
    );
    assert.equal(staleButExact.succeeded, true);
    assert.equal(
      staleButExact.output,
      `source_sha=${acceptedSha}\nshort_sha=${acceptedSha.slice(0, 7)}\n`,
    );
  } finally {
    rmSync(repository, { force: true, recursive: true });
  }
});

test("package revision policy rejects floating checkout and branch-dispatch bypass fixtures", () => {
  const floatingMain = replaceOnce(
    workflowSource,
    "ref: ${{ steps.package-source.outputs.accepted_sha }}",
    "ref: main",
  );
  assert.ok(
    validatePackageRevisionPolicy(floatingMain).some((error) =>
      error.includes("checkout must fetch only the frozen accepted package SHA"),
    ),
  );

  const branchDispatch = replaceOnce(
    workflowSource,
    'test "$EVENT_REF" = "refs/heads/main"',
    'test -n "$EVENT_REF"',
  );
  assert.ok(
    validatePackageRevisionPolicy(branchDispatch).some((error) =>
      error.includes("package revision selection is missing closed guard"),
    ),
  );
});

test("package revision policy rejects removed and reordered HEAD assertion fixtures", () => {
  const removedWorkflow = structuredClone(workflow);
  const removedStep = removedWorkflow.jobs?.["package-macos"]?.steps?.find(
    (candidate) => candidate.name === "Verify package revision before upload",
  );
  assert.ok(removedStep?.run);
  removedStep.run = replaceOnce(
    removedStep.run,
    'test "$(git rev-parse HEAD)" = "$SOURCE_SHA"',
    'echo "pre-upload assertion removed"',
  );
  assert.ok(
    validatePackageRevisionPolicy(stringify(removedWorkflow)).some((error) =>
      error.includes("pre-upload verification is missing"),
    ),
  );

  const reorderedWorkflow = structuredClone(workflow);
  const reorderedSteps = reorderedWorkflow.jobs?.["package-macos"]?.steps;
  assert.ok(reorderedSteps);
  const assertionIndex = reorderedSteps.findIndex(
    (candidate) => candidate.name === "Verify package revision before upload",
  );
  const uploadIndex = reorderedSteps.findIndex(
    (candidate) => candidate.name === "Upload Apple Silicon test package",
  );
  assert.ok(assertionIndex >= 0 && uploadIndex > assertionIndex);
  const [assertionStep] = reorderedSteps.splice(assertionIndex, 1);
  assert.ok(assertionStep);
  reorderedSteps.splice(uploadIndex, 0, assertionStep);
  assert.ok(
    validatePackageRevisionPolicy(stringify(reorderedWorkflow)).some((error) =>
      error.includes("HEAD and package metadata must be verified immediately before upload"),
    ),
  );
});

test("package revision policy rejects metadata divergence and assertion bypass fixtures", () => {
  const divergentMetadata = replaceOnce(
    workflowSource,
    "name: ${{ steps.package-metadata.outputs.artifact_name }}",
    "name: mish-package-diverged",
  );
  assert.ok(
    validatePackageRevisionPolicy(divergentMetadata).some((error) =>
      error.includes("upload artifact name must use verified package metadata"),
    ),
  );

  const bypassed = replaceOnce(
    workflowSource,
    "      - name: Verify package revision before upload\n",
    "      - name: Verify package revision before upload\n        continue-on-error: true\n",
  );
  assert.ok(
    validatePackageRevisionPolicy(bypassed).some((error) =>
      error.includes("pre-upload revision verification cannot be bypassed"),
    ),
  );
});
