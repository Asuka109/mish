import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { parseDocument } from "yaml";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const runnerLabels = ["self-hosted", "macOS", "ARM64", "mish", "trusted-ci"];

interface Step {
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
}

interface Job {
  permissions?: Record<string, string>;
  "runs-on"?: string[];
  steps?: Step[];
}

interface Workflow {
  jobs?: Record<string, Job>;
  on?: Record<string, unknown>;
}

function read(relative: string): string {
  return readFileSync(path.join(repositoryRoot, relative), "utf8");
}

function workflow(relative: string): { source: string; value: Workflow } {
  const source = read(relative);
  const document = parseDocument(source);
  assert.deepEqual(document.errors, []);
  return { source, value: document.toJS() as Workflow };
}

test("every workflow job uses the exact dedicated runner boundary", () => {
  for (const relative of [
    ".github/workflows/ci.yml",
    ".github/workflows/stage-macos-alpha-release.yml",
  ]) {
    const parsed = workflow(relative);
    for (const [name, job] of Object.entries(parsed.value.jobs ?? {})) {
      assert.deepEqual(job["runs-on"], runnerLabels, `${relative} ${name}`);
      assert.deepEqual(job.permissions, { contents: "read" }, `${relative} ${name}`);
      const boundary = job.steps?.[0];
      assert.equal(boundary?.name, "Verify dedicated runner boundary", `${relative} ${name}`);
      assert.match(boundary?.run ?? "", /RUNNER_NAME.*mish-macos-arm64-01/u);
      assert.match(boundary?.run ?? "", /id -un.*mish-ci/u);
      assert.match(boundary?.run ?? "", /ACTIONS_RUNNER_HOOK_JOB_STARTED/u);
      assert.match(boundary?.run ?? "", /ACTIONS_RUNNER_HOOK_JOB_COMPLETED/u);
      assert.match(boundary?.run ?? "", /\/dev\/console/u);
    }
    assert.doesNotMatch(parsed.source, /\$\{\{\s*secrets\./u);
  }
});

test("pull requests use the trusted default workflow and exact owner head SHA", () => {
  const ci = workflow(".github/workflows/ci.yml");
  assert.ok(Object.hasOwn(ci.value.on ?? {}, "pull_request_target"));
  assert.ok(!Object.hasOwn(ci.value.on ?? {}, "pull_request"));
  const gate = ci.value.jobs?.["pr-gate"];
  const checkout = gate?.steps?.find((step) => step.uses?.startsWith("actions/checkout@"));
  assert.equal(checkout?.with?.ref, "${{ github.event.pull_request.head.sha }}");
  assert.match(ci.source, /github\.actor_id == '18379948'/u);
  assert.match(ci.source, /github\.event\.pull_request\.head\.repo\.id == 1304960811/u);
  assert.match(
    ci.source,
    /github\.event\.pull_request\.head\.repo\.full_name == 'Asuka109\/mish'/u,
  );
  assert.match(
    ci.source,
    /github\.workflow_ref == 'Asuka109\/mish\/\.github\/workflows\/ci\.yml@refs\/heads\/main'/u,
  );
  assert.doesNotMatch(ci.source, /refs\/pull\//u);
});

test("runner hooks clean only the dedicated account and validated workspace", () => {
  const hygiene = read("scripts/self-hosted-runner-hygiene.sh");
  assert.match(hygiene, /expected_user="\$\{MISH_RUNNER_USER:-mish-ci\}"/u);
  assert.match(hygiene, /runner_root.*\$HOME\/actions-runner/u);
  assert.match(hygiene, /hook_root.*\$HOME\/\.local\/share\/mish-runner-hooks/u);
  assert.match(hygiene, /console_user.*\/dev\/console/u);
  assert.match(hygiene, /"\$image_path".*"\$work_root"\/\*/su);
  assert.match(hygiene, /hdiutil detach "\$mountpoint"/u);
  assert.doesNotMatch(hygiene, /hdiutil detach[^\n]*-force/u);
  assert.match(hygiene, /security delete-keychain/u);
  assert.match(hygiene, /find "\$work_root" -depth -mindepth 1 -delete/u);
  assert.match(hygiene, /pkill -TERM -u "\$uid_value" -x/u);
  assert.match(hygiene, /pkill -KILL -u "\$uid_value" -x/u);
  assert.doesNotMatch(hygiene, /\bsudo\b|\bosascript\b|\/bin\/rm|\brm -/u);
  assert.match(read("scripts/self-hosted-runner-job-started.sh"), /hygiene\.sh" started/u);
  assert.match(read("scripts/self-hosted-runner-job-completed.sh"), /hygiene\.sh" completed/u);
});

test("routine packaging and verification cannot open Finder", () => {
  const build = read("scripts/build-macos-bundle.ts");
  const alphaVerifier = read("scripts/verify-macos-alpha-ad-hoc-dmg.ts");
  const internalVerifier = read("scripts/verify-internal-tun-alpha-stage.ts");
  const ci = read(".github/workflows/ci.yml");
  const release = read(".github/workflows/stage-macos-alpha-release.yml");

  assert.match(build, /styledDmg = alphaAdHoc && arguments_\.includes\("--styled-dmg"\)/u);
  assert.match(alphaVerifier, /"attach", "-readonly", "-nobrowse", "-noautoopen"/u);
  assert.match(internalVerifier, /"attach", "-readonly", "-nobrowse", "-noautoopen"/u);
  assert.doesNotMatch(ci, /--styled-dmg|\bopen -a Finder\b|\bopen "\$.*\.dmg/u);
  assert.doesNotMatch(release, /--styled-dmg|\bopen -a Finder\b|\bopen "\$.*\.dmg/u);
});
