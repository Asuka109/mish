import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import {
  classifyWorkflowReference,
  classifyWorkflowStep,
  parseWorkflowFixture,
  validateWorkflow,
  validateWorkflowReference,
} from "./check-trusted-ci-policy.ts";
import { readTrustedReleasePolicy } from "./trusted-release-policy.ts";

const fixtureRoot = path.join(import.meta.dirname, "fixtures/trusted-ci");
const policy = readTrustedReleasePolicy();
const reusablePolicy = structuredClone(policy);
reusablePolicy.actions.allowedReusableWorkflows = ["./.github/workflows/reusable-fixture.yml"];

function fixture(name: string) {
  return parseWorkflowFixture(
    readFileSync(path.join(fixtureRoot, name), "utf8"),
    `.github/workflows/${name}`,
  );
}

test("trusted policy classifies run steps, local actions, ordinary actions, and reusable calls", () => {
  assert.equal(classifyWorkflowStep({ run: "echo fixture" }).kind, "run");
  assert.equal(classifyWorkflowReference("./.github/actions/fixture", "step").kind, "local-action");
  assert.equal(
    classifyWorkflowReference(
      "actions/checkout/directory@d23441a48e516b6c34aea4fa41551a30e30af803",
      "step",
    ).kind,
    "external-action",
  );
  assert.equal(
    classifyWorkflowReference("./.github/workflows/reusable-fixture.yml", "job").kind,
    "local-reusable-workflow",
  );
  assert.equal(
    classifyWorkflowReference(
      "octo/example/.github/workflows/reusable.yml/dummy@d23441a48e516b6c34aea4fa41551a30af803",
      "job",
    ).kind,
    "unsupported",
  );
  assert.equal(classifyWorkflowReference("${{ inputs.action }}", "step").kind, "unsupported");
});

test("multi-job and reusable-workflow fixtures are evaluated as one policy surface", () => {
  const caller = fixture("multi-job.yml");
  const reusable = fixture("reusable-fixture.yml");
  const knownWorkflows = [
    ".github/workflows/multi-job.yml",
    ".github/workflows/reusable-fixture.yml",
  ];

  assert.deepEqual(
    validateWorkflow(reusablePolicy, ".github/workflows/reusable-fixture.yml", reusable.workflow, {
      knownWorkflowPaths: knownWorkflows,
    }),
    [],
  );
  assert.deepEqual(
    validateWorkflow(reusablePolicy, ".github/workflows/multi-job.yml", caller.workflow, {
      knownWorkflowPaths: knownWorkflows,
    }),
    [],
  );
  assert.equal(Object.keys(caller.workflow.jobs ?? {}).length, 3);
  assert.equal(Object.keys(reusable.workflow.jobs ?? {}).length, 1);
});

test("every job is checked and unsupported or bypass-shaped syntax fails closed", () => {
  const caller = fixture("multi-job.yml");
  const jobs = caller.workflow.jobs;
  assert.ok(jobs);

  jobs["run-step"].steps?.push({
    name: "Unpinned action hidden in a later job step",
    uses: "actions/checkout@v6",
  });
  assert.ok(
    validateWorkflow(reusablePolicy, "fixture.yml", caller.workflow).some((error) =>
      error.includes("Action is not pinned by full SHA"),
    ),
  );

  const unsupported = fixture("multi-job.yml");
  const localAction = unsupported.workflow.jobs?.["local-action"]?.steps?.[0];
  assert.ok(localAction);
  localAction.uses = "docker://alpine:3.20";
  assert.ok(
    validateWorkflow(reusablePolicy, "fixture.yml", unsupported.workflow).some((error) =>
      error.includes("Unsupported step uses reference"),
    ),
  );

  const mixedStep = fixture("multi-job.yml");
  const firstStep = mixedStep.workflow.jobs?.["run-step"]?.steps?.[0];
  assert.ok(firstStep);
  firstStep.uses = "./.github/actions/fixture";
  assert.ok(
    validateWorkflow(reusablePolicy, "fixture.yml", mixedStep.workflow).some((error) =>
      error.includes("must contain exactly one of run or uses"),
    ),
  );
});

test("reusable workflow allowlists are separate from ordinary action allowlists", () => {
  const remote = classifyWorkflowReference(
    "octo/example/.github/workflows/reusable.yml@d23441a48e516b6c34aea4fa41551a30e30af803",
    "job",
  );
  assert.equal(remote.kind, "external-reusable-workflow");
  assert.equal(validateWorkflowReference(policy, remote).length, 1);

  const allowed = structuredClone(policy);
  allowed.actions.allowedReusableWorkflows = [remote.reference];
  assert.deepEqual(validateWorkflowReference(allowed, remote), []);
});
