import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const developmentModule = "macos-platform-transcript";
const fixtureDirectory = "docs/quality/fixtures/macos-platform-transcripts";

function read(relativePath: string): string {
  return readFileSync(path.join(repositoryRoot, relativePath), "utf8");
}

function filesUnder(relativeDirectory: string): string[] {
  return readdirSync(path.join(repositoryRoot, relativeDirectory), { withFileTypes: true }).flatMap(
    (entry) => {
      const relativePath = path.join(relativeDirectory, entry.name);
      if (entry.isDirectory()) return filesUnder(relativePath);
      return entry.isFile() ? [relativePath] : [];
    },
  );
}

test("raw transcript quarantine is explicitly ignored and no quarantined path is tracked", () => {
  execFileSync("git", ["check-ignore", "-q", ".scratch/macos-platform-transcripts/raw/probe"], {
    cwd: repositoryRoot,
  });
  const tracked = execFileSync("git", ["ls-files", ".scratch/macos-platform-transcripts"], {
    cwd: repositoryRoot,
    encoding: "utf8",
  });
  assert.equal(tracked, "");
});

test("desktop and mobile production inputs cannot reach the recorder, compiler, raw fixtures, or quarantine", () => {
  const productInputs = [
    ...filesUnder("apps/desktop"),
    ...filesUnder("apps/mobile"),
    ...filesUnder("crates").filter((file) => !file.includes(`${path.sep}tests${path.sep}`)),
    ...filesUnder("packages"),
    ...filesUnder(".github"),
  ];
  for (const file of productInputs) {
    const content = read(file);
    assert.equal(
      content.includes(developmentModule) ||
        content.includes(".scratch/macos-platform-transcripts") ||
        content.includes("scripts/fixtures/macos-platform-transcripts"),
      false,
      `${file} makes development transcript capture reachable from a production input.`,
    );
  }
});

test("production resource maps exclude development tooling while retaining no raw fixture directory", () => {
  for (const configuration of [
    "apps/desktop/src-tauri/tauri.bundle.conf.json",
    "apps/mobile/src-tauri/tauri.conf.json",
  ]) {
    const serialized = JSON.stringify(JSON.parse(read(configuration)));
    assert.equal(serialized.includes(developmentModule), false, configuration);
    assert.equal(serialized.includes("scripts/fixtures"), false, configuration);
    assert.equal(serialized.includes(fixtureDirectory), false, configuration);
    assert.equal(serialized.includes(".scratch/macos-platform-transcripts"), false, configuration);
  }
});

test("only the separate repository development commands expose recording and compilation", () => {
  const manifest = JSON.parse(read("package.json")) as {
    scripts: Record<string, string>;
  };
  const exposed = Object.entries(manifest.scripts)
    .filter(([, command]) => command.includes("scripts/macos-platform-transcript.ts"))
    .map(([name]) => name)
    .sort();
  assert.deepEqual(exposed, [
    "macos:transcript:abort",
    "macos:transcript:compile",
    "macos:transcript:record",
  ]);
});
