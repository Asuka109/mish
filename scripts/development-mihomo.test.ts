import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempDisposableSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DevelopmentMihomoError,
  readMacOsMihomoRelease,
  selectDevelopmentMihomo,
  verifyDevelopmentMihomo,
  verifyLocalDevelopmentMihomo,
} from "./development-mihomo.ts";

function digest(contents: string): string {
  return createHash("sha256").update(contents).digest("hex");
}

async function expectFailure(
  failure: DevelopmentMihomoError["failure"],
  run: () => Promise<unknown>,
) {
  await assert.rejects(run, (error) => {
    assert(error instanceof DevelopmentMihomoError);
    assert.equal(error.failure, failure);
    return true;
  });
}

test("classifies absent, unsafe, invalid, and valid pinned development Core artifacts", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-development-core-"));
  const binary = path.join(temporary.path, "mihomo-darwin-arm64-v1.19.29");
  const contents = "repository-owned fictional Mihomo fixture";
  const verify = () =>
    verifyDevelopmentMihomo({
      binary,
      expectedSha256: digest(contents),
      expectedVersion: "v1.19.29",
      inspectVersion: () => "Mihomo Meta v1.19.29 darwin arm64 with fictional-go",
    });

  await expectFailure("binary-absent", verify);

  writeFileSync(binary, contents, { mode: 0o644 });
  await expectFailure("binary-mode", verify);

  chmodSync(binary, 0o755);
  await expectFailure("binary-digest", () =>
    verifyDevelopmentMihomo({
      binary,
      expectedSha256: digest("different fictional fixture"),
      expectedVersion: "v1.19.29",
      inspectVersion: () => "Mihomo Meta v1.19.29 darwin arm64 with fictional-go",
    }),
  );

  await expectFailure("binary-version", () =>
    verifyDevelopmentMihomo({
      binary,
      expectedSha256: digest(contents),
      expectedVersion: "v1.19.29",
      inspectVersion: () => "Mihomo Meta v1.20.0 darwin arm64 with fictional-go",
    }),
  );

  const verification = await verify();
  assert.equal(verification.binarySha256, digest(contents));
  assert.match(verification.version, /v1\.19\.29 darwin arm64/u);
});

test("rejects a symlink even when it resolves to a valid executable fixture", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-development-core-link-"));
  const target = path.join(temporary.path, "target");
  const binary = path.join(temporary.path, "mihomo");
  const contents = "repository-owned fictional Mihomo fixture";
  writeFileSync(target, contents, { mode: 0o755 });
  symlinkSync(target, binary);

  await expectFailure("binary-type", () =>
    verifyDevelopmentMihomo({
      binary,
      expectedSha256: digest(contents),
      expectedVersion: "v1.19.29",
      inspectVersion: () => "Mihomo Meta v1.19.29 darwin arm64 with fictional-go",
    }),
  );
});

test("rejects malformed or open-ended pinned release manifests", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-development-manifest-"));
  const manifestDirectory = path.join(temporary.path, "resources", "mihomo");
  const manifest = path.join(manifestDirectory, "macos-arm64.json");
  mkdirSync(manifestDirectory, { recursive: true });

  writeFileSync(manifest, "{");
  await expectFailure("manifest-invalid", () => readMacOsMihomoRelease(temporary.path));

  writeFileSync(
    manifest,
    JSON.stringify({
      archiveSha256: "a".repeat(64),
      asset: "mihomo-darwin-arm64-v1.19.29.gz",
      binarySha256: "b".repeat(64),
      repository: "fictional/private-fork",
      schemaVersion: 1,
      version: "v1.19.29",
    }),
  );
  await expectFailure("manifest-invalid", () => readMacOsMihomoRelease(temporary.path));
});

test("validates an explicit local Core without requiring the repository digest", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-local-development-core-"));
  const binary = path.join(temporary.path, "local-mihomo");
  const contents = "repository-owned fictional local Mihomo fixture";
  const verify = () =>
    verifyLocalDevelopmentMihomo({
      binary,
      expectedVersion: "v1.19.29",
      inspectVersion: () => "Mihomo Meta v1.19.29 darwin arm64 with fictional-go",
    });

  await expectFailure("binary-absent", verify);
  await expectFailure("binary-path", () =>
    verifyLocalDevelopmentMihomo({
      binary: "relative/local-mihomo",
      expectedVersion: "v1.19.29",
      inspectVersion: () => "Mihomo Meta v1.19.29 darwin arm64 with fictional-go",
    }),
  );

  writeFileSync(binary, contents, { mode: 0o644 });
  await expectFailure("binary-mode", verify);
  chmodSync(binary, 0o755);
  await expectFailure("binary-version", () =>
    verifyLocalDevelopmentMihomo({
      binary,
      expectedVersion: "v1.19.29",
      inspectVersion: () => "Mihomo Meta v1.20.0 darwin arm64 with fictional-go",
    }),
  );

  const verification = await verify();
  assert.equal(verification.binary, binary);
  assert.equal(verification.binarySha256, digest(contents));
});

test("a missing explicit override fails without preparing the repository pin", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-explicit-core-selection-"));
  const manifestDirectory = path.join(temporary.path, "resources", "mihomo");
  mkdirSync(manifestDirectory, { recursive: true });
  writeFileSync(
    path.join(manifestDirectory, "macos-arm64.json"),
    JSON.stringify({
      archiveSha256: "a".repeat(64),
      asset: "mihomo-darwin-arm64-v1.19.29.gz",
      binarySha256: "b".repeat(64),
      repository: "MetaCubeX/mihomo",
      schemaVersion: 1,
      version: "v1.19.29",
    }),
  );

  await expectFailure("binary-absent", () =>
    selectDevelopmentMihomo(temporary.path, path.join(temporary.path, "missing-local-mihomo")),
  );
  assert.equal(existsSync(path.join(temporary.path, ".scratch")), false);
});
