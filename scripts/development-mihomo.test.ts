import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempDisposableSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DevelopmentMihomoError,
  readMacOsMihomoRelease,
  verifyDevelopmentMihomo,
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
