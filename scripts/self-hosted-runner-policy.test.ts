import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");

function read(relative: string): string {
  return readFileSync(path.join(repositoryRoot, relative), "utf8");
}

test("runner hooks clean only validated runner-owned resources on the shared account", () => {
  const hygiene = read("scripts/self-hosted-runner-hygiene.sh");
  assert.match(hygiene, /runner_root.*\$HOME\/actions-runner\/mish/u);
  assert.match(hygiene, /hook_root.*\$HOME\/\.local\/share\/mish-runner-hooks/u);
  assert.match(hygiene, /"\$image_path".*"\$work_root"\/\*/su);
  assert.match(hygiene, /hdiutil detach "\$mountpoint"/u);
  assert.doesNotMatch(hygiene, /hdiutil detach[^\n]*-force/u);
  assert.match(hygiene, /security delete-keychain/u);
  assert.match(hygiene, /lsof.*-d cwd/u);
  assert.match(hygiene, /kill -TERM/u);
  assert.match(hygiene, /kill -KILL/u);
  assert.match(hygiene, /GITHUB_WORKSPACE/u);
  assert.match(hygiene, /mkdir -p "\$workspace"/u);
  assert.doesNotMatch(hygiene, /pkill[^\n]*-u/u);
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
