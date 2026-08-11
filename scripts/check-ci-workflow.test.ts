import assert from "node:assert/strict";
import test from "node:test";

import {
  requiredCiJobIds,
  requiredCiJobNames,
  validateCiWorkflowJobInventory,
  validateCiWorkflowJobNames,
} from "./check-ci-workflow.ts";

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
