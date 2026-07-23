import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  type LocalReleaseAsset,
  type ReleaseClient,
  type ReleaseRequest,
  type RemoteRelease,
  type RemoteReleaseState,
  parsePrereleaseVersion,
  planStaging,
  prepareReleaseArtifacts,
  readLocalReleaseAssets,
  resolveGitSource,
  runDeterministicFixture,
  stageVerifiedRelease,
  validateReleaseVersion,
} from "./macos-alpha-release.ts";

const sourceSha = "1".repeat(40);
const version = "0.1.0-alpha.1";

function repositoryFixture(): string {
  const root = mkdtempSync(path.join(tmpdir(), "mish-release-source-"));
  mkdirSync(path.join(root, "apps/desktop/src-tauri"), { recursive: true });
  writeFileSync(
    path.join(root, "package.json"),
    '{"version":"0.1.0","scripts":{"desktop:bundle:macos":"node scripts/build-macos-bundle.ts --profile alpha-ad-hoc"}}\n',
  );
  writeFileSync(path.join(root, "apps/desktop/package.json"), '{"version":"0.1.0"}\n');
  writeFileSync(path.join(root, "apps/desktop/src-tauri/tauri.conf.json"), '{"version":"0.1.0"}\n');
  writeFileSync(
    path.join(root, "Cargo.toml"),
    '[workspace]\n\n[workspace.package]\nversion = "0.1.0"\n',
  );
  execFileSync("git", ["init", "-b", "main"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Mish Fixture"], { cwd: root });
  execFileSync("git", ["config", "user.email", "fixture@example.invalid"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

function artifactFixture() {
  const root = mkdtempSync(path.join(tmpdir(), "mish-release-artifacts-"));
  const dmg = path.join(root, "Mish_0.1.0_aarch64.dmg");
  const output = path.join(root, "candidate");
  writeFileSync(dmg, "verified alpha dmg fixture\n");
  const assets = prepareReleaseArtifacts({
    dmgPath: dmg,
    outputDirectory: output,
    sourceSha,
    version,
  });
  return { assets, dmg, output, root };
}

function matchingRelease(assets: LocalReleaseAsset[] = []): RemoteRelease {
  return {
    assets: assets.map((asset, index) => ({
      digest: `sha256:${asset.digest}`,
      id: index + 1,
      name: asset.name,
      size: asset.size,
      state: "uploaded",
    })),
    draft: true,
    htmlUrl: "https://example.invalid/draft",
    id: 7,
    name: `Mish v${version} Alpha`,
    prerelease: true,
    tagName: `v${version}`,
    targetCommitish: sourceSha,
    uploadUrl: "https://uploads.example.invalid{?name,label}",
  };
}

class FixtureClient implements ReleaseClient {
  readonly mutations: string[] = [];
  state: RemoteReleaseState = { release: null, tagCommit: null };

  async getState(): Promise<RemoteReleaseState> {
    return this.state;
  }

  async createTag(tag: string, commit: string): Promise<void> {
    this.mutations.push(`tag:${tag}:${commit}`);
    this.state = { ...this.state, tagCommit: commit };
  }

  async createRelease(request: ReleaseRequest): Promise<void> {
    this.mutations.push(`release:${request.version}:${request.sourceSha}`);
    this.state = { ...this.state, release: matchingRelease() };
  }

  async uploadAsset(release: RemoteRelease, asset: LocalReleaseAsset): Promise<void> {
    this.mutations.push(`asset:${asset.name}`);
    release.assets.push({
      digest: `sha256:${asset.digest}`,
      id: release.assets.length + 1,
      name: asset.name,
      size: asset.size,
      state: "uploaded",
    });
  }
}

test("release version must be canonical prerelease SemVer matching the desktop base version", () => {
  assert.deepEqual(parsePrereleaseVersion("0.1.0-alpha.1"), {
    baseVersion: "0.1.0",
    tag: "v0.1.0-alpha.1",
    version: "0.1.0-alpha.1",
  });
  assert.equal(
    validateReleaseVersion("0.1.0-rc.2+fixture.1", "0.1.0").tag,
    "v0.1.0-rc.2+fixture.1",
  );
  for (const invalid of [
    "0.1.0",
    "01.1.0-alpha.1",
    "0.1.0-alpha.01",
    "0.1.0-alpha.1; touch owned",
    " 0.1.0-alpha.1",
  ]) {
    assert.throws(() => parsePrereleaseVersion(invalid), /prerelease SemVer|whitespace/u);
  }
  assert.throws(
    () => validateReleaseVersion("0.2.0-alpha.1", "0.1.0"),
    /does not match desktop application version/u,
  );
});

test("source resolution freezes main, accepts an exact reachable SHA, and rejects an unreachable SHA", () => {
  const root = repositoryFixture();
  const mainSha = execFileSync("git", ["rev-parse", "main"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.deepEqual(
    resolveGitSource({ cwd: root, mainRef: "main", requestedSource: mainSha, version }),
    {
      artifactName: "Mish-0.1.0-alpha.1-arm64.dmg",
      baseVersion: "0.1.0",
      mainSha,
      sourceSha: mainSha,
      tag: "v0.1.0-alpha.1",
      version,
    },
  );
  assert.equal(resolveGitSource({ cwd: root, mainRef: "main", version }).sourceSha, mainSha);

  execFileSync("git", ["switch", "-c", "outside"], { cwd: root });
  writeFileSync(path.join(root, "outside.txt"), "outside main\n");
  execFileSync("git", ["add", "outside.txt"], { cwd: root });
  execFileSync("git", ["commit", "-m", "outside"], { cwd: root });
  const outsideSha = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: root,
    encoding: "utf8",
  }).trim();
  assert.throws(
    () =>
      resolveGitSource({
        cwd: root,
        mainRef: "main",
        requestedSource: outsideSha,
        version,
      }),
    /not reachable from main/u,
  );
  assert.throws(
    () => resolveGitSource({ cwd: root, mainRef: "main", requestedSource: "deadbeef", version }),
    /full lowercase 40-character/u,
  );
});

test("artifact generation is deterministic and verifies metadata plus checksums", () => {
  const first = artifactFixture();
  const second = artifactFixture();
  for (const name of ["Mish-0.1.0-alpha.1-arm64.dmg", "release-metadata.json", "SHA256SUMS.txt"]) {
    assert.deepEqual(
      readFileSync(path.join(first.output, name)),
      readFileSync(path.join(second.output, name)),
    );
  }
  const metadata = JSON.parse(
    readFileSync(path.join(first.output, "release-metadata.json"), "utf8"),
  ) as Record<string, unknown>;
  assert.deepEqual(metadata, {
    architecture: "arm64",
    expectedGatekeeperBoundary: "rejection-or-app-scoped-open-anyway",
    minimumMacosVersion: "13.0",
    mihomoVersion: "v1.19.29",
    releaseKind: "draft-prerelease",
    schemaVersion: 1,
    signingMode: "ad-hoc",
    sourceSha,
    tag: `v${version}`,
    version,
  });
  assert.equal(first.assets.length, 3);

  writeFileSync(path.join(first.output, "Mish-0.1.0-alpha.1-arm64.dmg"), "tampered\n");
  assert.throws(
    () => readLocalReleaseAssets(first.output, { sourceSha, version }),
    /Checksum mismatch/u,
  );
});

test("artifact failure produces no candidate directory", () => {
  const root = mkdtempSync(path.join(tmpdir(), "mish-release-failure-"));
  const output = path.join(root, "candidate");
  assert.throws(
    () =>
      prepareReleaseArtifacts({
        dmgPath: path.join(root, "missing.dmg"),
        outputDirectory: output,
        sourceSha,
        version,
      }),
    /Alpha DMG is missing/u,
  );
  assert.equal(existsSync(output), false);
});

test("staging decisions fail closed for tag and release conflicts", () => {
  const request = { sourceSha, version };
  assert.equal(
    planStaging(request, { release: null, tagCommit: null }).action,
    "create-tag-and-release",
  );
  assert.equal(
    planStaging(request, { release: null, tagCommit: sourceSha }).action,
    "create-release",
  );
  assert.equal(
    planStaging(request, { release: matchingRelease(), tagCommit: sourceSha }).action,
    "resume-release",
  );
  assert.throws(
    () => planStaging(request, { release: null, tagCommit: "2".repeat(40) }),
    /already points/u,
  );
  assert.throws(
    () =>
      planStaging(request, {
        release: { ...matchingRelease(), draft: false },
        tagCommit: sourceSha,
      }),
    /not a Draft/u,
  );
  assert.throws(
    () =>
      planStaging(request, {
        release: { ...matchingRelease(), targetCommitish: "2".repeat(40) },
        tagCommit: sourceSha,
      }),
    /targets/u,
  );
});

test("same-commit retries resume missing assets and reject mismatched existing assets", () => {
  const { assets } = artifactFixture();
  const request = { assets, sourceSha, version };
  const partial = matchingRelease(assets.slice(0, 1));
  const plan = planStaging(request, { release: partial, tagCommit: sourceSha });
  assert.equal(plan.action, "resume-release");
  assert.deepEqual(plan.matchingAssets, [assets[0].name]);
  assert.deepEqual(
    plan.missingAssets,
    assets.slice(1).map((asset) => asset.name),
  );

  const complete = planStaging(request, {
    release: matchingRelease(assets),
    tagCommit: sourceSha,
  });
  assert.equal(complete.action, "already-staged");

  const conflicting = matchingRelease(assets);
  conflicting.assets[0].digest = `sha256:${"f".repeat(64)}`;
  assert.throws(
    () => planStaging(request, { release: conflicting, tagCommit: sourceSha }),
    /different SHA-256 digest/u,
  );
});

test("dry-run exercises staging without writes and live staging orders tag before Draft assets", async () => {
  const { assets } = artifactFixture();
  const request = { assets, sourceSha, version };
  const dryRunClient = new FixtureClient();
  const dryRun = await stageVerifiedRelease(dryRunClient, request, true);
  assert.equal(dryRun.plan.action, "create-tag-and-release");
  assert.deepEqual(dryRunClient.mutations, []);

  const client = new FixtureClient();
  const staged = await stageVerifiedRelease(client, request, false);
  assert.equal(staged.plan.action, "already-staged");
  assert.deepEqual(client.mutations, [
    `tag:v${version}:${sourceSha}`,
    `release:${version}:${sourceSha}`,
    ...assets.map((asset) => `asset:${asset.name}`),
  ]);
});

test("deterministic fixture covers clean, idempotent, conflict, and published decisions", () => {
  assert.deepEqual(runDeterministicFixture(), {
    clean: "create-tag-and-release",
    "conflicting-tag": `Tag v${version} already points to ${"2".repeat(40)}, not ${sourceSha}.`,
    "published-release": `Existing release v${version} is not a Draft.`,
    "same-draft": "resume-release",
    "same-tag": "create-release",
  });
});
