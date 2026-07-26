import assert from "node:assert/strict";
import { mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareUpdaterArtifacts,
  runUpdaterContractFixture,
  updaterArtifactName,
  updaterArtifactNames,
  updaterFixtureSourceSha,
  updaterFixtureVersion,
  validateUpdaterVersion,
  verifyUpdaterArtifacts,
} from "./macos-updater-contract.ts";

const fixtures = path.resolve(import.meta.dirname, "fixtures/macos-updater");

function completeFixture() {
  const temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-updater-test-"));
  const outputDirectory = path.join(temporary.path, "output");
  mkdirSync(outputDirectory);
  const result = prepareUpdaterArtifacts({
    artifact: path.join(fixtures, updaterArtifactName(updaterFixtureVersion)),
    artifactSignature: path.join(fixtures, `${updaterArtifactName(updaterFixtureVersion)}.sig`),
    channel: "alpha",
    metadataSignature: path.join(fixtures, "mish-alpha.json.sig"),
    outputDirectory,
    sourceSha: updaterFixtureSourceSha,
    version: updaterFixtureVersion,
  });
  return {
    [Symbol.dispose]: () => temporary[Symbol.dispose](),
    outputDirectory,
    result,
  };
}

test("generates the exact signed Tauri updater artifact set without credentials or network", () => {
  using fixture = completeFixture();
  assert.deepEqual(
    updaterArtifactNames(fixture.result.version, fixture.result.channel).sort(),
    [
      "Mish-0.1.1-alpha.2-aarch64.app.tar.gz",
      "Mish-0.1.1-alpha.2-aarch64.app.tar.gz.sig",
      "mish-alpha.json",
      "mish-alpha.json.sig",
    ].sort(),
  );
  assert.deepEqual(
    readFileSync(path.join(fixture.outputDirectory, "mish-alpha.json")),
    readFileSync(path.join(fixtures, "mish-alpha.json")),
  );

  const evidence = runUpdaterContractFixture();
  assert.equal(evidence.network, "not-used");
  assert.equal(evidence.privateKey, "not-present");
  assert.doesNotMatch(JSON.stringify(evidence), /https?:|signature|dW50cnVzdGVk|source_sha/u);

  const tauriContract = JSON.parse(
    readFileSync(
      path.resolve(
        import.meta.dirname,
        "../apps/desktop/src-tauri/tauri.updater.contract.conf.json",
      ),
      "utf8",
    ),
  );
  assert.deepEqual(tauriContract, { bundle: { createUpdaterArtifacts: true } });
});

test("rejects malformed, wrong-channel, or ambiguous versions", () => {
  for (const [version, channel] of [
    ["0.1.0-alpha.1", "stable"],
    ["0.1.0", "alpha"],
    ["v0.1.0", "stable"],
    ["0.1.0+build.1", "stable"],
    ["0.01.0", "stable"],
    ["0.1.0-beta.1", "alpha"],
  ] as const) {
    assert.throws(() => validateUpdaterVersion(version, channel), /strict SemVer/u);
  }
});

test("fails closed on substituted payload, metadata, signatures, or artifact set", () => {
  using payloadFixture = completeFixture();
  writeFileSync(
    path.join(payloadFixture.outputDirectory, payloadFixture.result.artifactName),
    "substituted payload",
  );
  assert.throws(
    () => verifyUpdaterArtifacts(payloadFixture.outputDirectory, payloadFixture.result),
    /identity|digest/u,
  );

  using signatureFixture = completeFixture();
  writeFileSync(
    path.join(signatureFixture.outputDirectory, signatureFixture.result.artifactSignatureName),
    readFileSync(path.join(fixtures, "mish-alpha.json.sig"), "utf8").trim(),
  );
  assert.throws(
    () => verifyUpdaterArtifacts(signatureFixture.outputDirectory, signatureFixture.result),
    /bind the exact updater payload/u,
  );

  using metadataFixture = completeFixture();
  const metadataPath = path.join(
    metadataFixture.outputDirectory,
    metadataFixture.result.metadataName,
  );
  writeFileSync(metadataPath, readFileSync(metadataPath, "utf8").replace('"alpha"', '"stable"'));
  assert.throws(
    () => verifyUpdaterArtifacts(metadataFixture.outputDirectory, metadataFixture.result),
    /identity or provenance/u,
  );

  using extraFixture = completeFixture();
  writeFileSync(path.join(extraFixture.outputDirectory, "unexpected"), "unexpected");
  assert.throws(
    () => verifyUpdaterArtifacts(extraFixture.outputDirectory, extraFixture.result),
    /unexpected files/u,
  );
});
