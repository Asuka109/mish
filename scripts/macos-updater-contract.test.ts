import assert from "node:assert/strict";
import { mkdirSync, mkdtempDisposableSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  discoverUpdaterReleaseFixture,
  prepareUpdaterArtifacts,
  runUpdaterContractFixture,
  simulateUpdaterPublication,
  updaterArtifactName,
  updaterArtifactNames,
  updaterFixtureSourceSha,
  updaterFixtureVersion,
  updaterStableFixtureSourceSha,
  updaterStableFixtureVersion,
  validateUpdaterVersion,
  verifyUpdaterArtifacts,
  type UpdaterChannel,
  type UpdaterReleaseFixture,
} from "./macos-updater-contract.ts";

const fixtures = path.resolve(import.meta.dirname, "fixtures/macos-updater");
const publicKey = readFileSync(path.join(fixtures, "updater-fixture.key.pub"), "utf8").trim();

function completeFixture(channel: UpdaterChannel = "alpha") {
  const temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-updater-test-"));
  const outputDirectory = path.join(temporary.path, "output");
  mkdirSync(outputDirectory);
  const version = channel === "alpha" ? updaterFixtureVersion : updaterStableFixtureVersion;
  const result = prepareUpdaterArtifacts({
    artifact: path.join(fixtures, updaterArtifactName(version)),
    artifactSignature: path.join(fixtures, `${updaterArtifactName(version)}.sig`),
    channel,
    metadataSignature: path.join(fixtures, `mish-${channel}.json.sig`),
    outputDirectory,
    publicKey,
    sourceSha: channel === "alpha" ? updaterFixtureSourceSha : updaterStableFixtureSourceSha,
    version,
  });
  return {
    [Symbol.dispose]: () => temporary[Symbol.dispose](),
    outputDirectory,
    result,
  };
}

test("generates the exact signed Tauri updater artifact set without credentials or network", () => {
  using fixture = completeFixture();
  using stableFixture = completeFixture("stable");
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
    updaterArtifactNames(stableFixture.result.version, stableFixture.result.channel).sort(),
    [
      "Mish-0.1.1-aarch64.app.tar.gz",
      "Mish-0.1.1-aarch64.app.tar.gz.sig",
      "mish-stable.json",
      "mish-stable.json.sig",
    ].sort(),
  );
  assert.deepEqual(
    readFileSync(path.join(fixture.outputDirectory, "mish-alpha.json")),
    readFileSync(path.join(fixtures, "mish-alpha.json")),
  );

  const evidence = runUpdaterContractFixture();
  assert.equal(evidence.network, "not-used");
  assert.equal(evidence.privateKey, "not-present");
  assert.equal(evidence.interruption, "draft-hidden");
  assert.equal(evidence.rediscovery, "unchanged");
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

test("models Draft upload verification, publication visibility, interruption, and high-water replay", () => {
  function release(channel: UpdaterChannel, version: string): UpdaterReleaseFixture {
    return {
      assetDigests: Object.fromEntries(
        updaterArtifactNames(version, channel).map((name, index) => [
          name,
          (index + 1).toString(16).repeat(64),
        ]),
      ),
      channel,
      draft: false,
      immutable: true,
      latest: channel === "stable",
      prerelease: channel === "alpha",
      published: true,
      version,
    };
  }

  const alpha = release("alpha", updaterFixtureVersion);
  const stable = release("stable", updaterStableFixtureVersion);
  const interrupted = simulateUpdaterPublication({
    assetDigests: alpha.assetDigests,
    channel: "alpha",
    interruptAfterVerifiedAssets: 2,
    version: alpha.version,
  });
  assert.equal(interrupted.draft, true);
  assert.equal(interrupted.immutable, false);
  assert.equal(interrupted.published, false);
  assert.equal(interrupted.alphaListVisible, false);
  assert.equal(interrupted.verifiedAssets.length, 2);

  const alphaPublished = simulateUpdaterPublication({
    assetDigests: alpha.assetDigests,
    channel: "alpha",
    version: alpha.version,
  });
  const stablePublished = simulateUpdaterPublication({
    assetDigests: stable.assetDigests,
    channel: "stable",
    version: stable.version,
  });
  assert.equal(alphaPublished.alphaListVisible, true);
  assert.equal(alphaPublished.immutable, true);
  assert.equal(alphaPublished.stableLatestVisible, false);
  assert.equal(stablePublished.stableLatestVisible, true);
  assert.equal(stablePublished.alphaListVisible, false);
  assert.equal(
    stablePublished.timeline.at(-1),
    "published-immutable",
    "Stable latest visibility must be the final publication step",
  );

  const discovered = discoverUpdaterReleaseFixture([alpha], "alpha");
  assert.equal(discovered.disposition, "available");
  assert.deepEqual(
    discoverUpdaterReleaseFixture([alpha], "alpha", {
      digest: discovered.digest,
      version: discovered.version,
    }),
    { ...discovered, disposition: "unchanged" },
  );
  assert.throws(
    () =>
      discoverUpdaterReleaseFixture([alpha], "alpha", {
        digest: "f".repeat(64),
        version: discovered.version,
      }),
    /conflicting digest/u,
  );
  assert.throws(
    () =>
      discoverUpdaterReleaseFixture([alpha], "alpha", {
        digest: discovered.digest,
        version: "0.1.1-alpha.3",
      }),
    /stale below the high-water/u,
  );
  assert.throws(
    () =>
      simulateUpdaterPublication({
        assetDigests: Object.fromEntries(Object.entries(alpha.assetDigests).slice(0, 3)),
        channel: "alpha",
        version: alpha.version,
      }),
    /partial, duplicated, or malformed/u,
  );
  assert.throws(
    () => discoverUpdaterReleaseFixture([{ ...alpha, immutable: false }], "alpha"),
    /No canonical published updater Release/u,
  );
});

test("fails closed on substituted payload, metadata, signatures, or artifact set", () => {
  using payloadFixture = completeFixture();
  writeFileSync(
    path.join(payloadFixture.outputDirectory, payloadFixture.result.artifactName),
    "substituted payload",
  );
  assert.throws(
    () => verifyUpdaterArtifacts(payloadFixture.outputDirectory, payloadFixture.result, publicKey),
    /identity|digest/u,
  );

  using signatureFixture = completeFixture();
  writeFileSync(
    path.join(signatureFixture.outputDirectory, signatureFixture.result.artifactSignatureName),
    readFileSync(path.join(fixtures, "mish-alpha.json.sig"), "utf8").trim(),
  );
  assert.throws(
    () =>
      verifyUpdaterArtifacts(signatureFixture.outputDirectory, signatureFixture.result, publicKey),
    /bind the exact updater payload/u,
  );

  using metadataFixture = completeFixture();
  const metadataPath = path.join(
    metadataFixture.outputDirectory,
    metadataFixture.result.metadataName,
  );
  writeFileSync(metadataPath, readFileSync(metadataPath, "utf8").replace('"alpha"', '"stable"'));
  assert.throws(
    () =>
      verifyUpdaterArtifacts(metadataFixture.outputDirectory, metadataFixture.result, publicKey),
    /identity or provenance/u,
  );

  using extraFixture = completeFixture();
  writeFileSync(path.join(extraFixture.outputDirectory, "unexpected"), "unexpected");
  assert.throws(
    () => verifyUpdaterArtifacts(extraFixture.outputDirectory, extraFixture.result, publicKey),
    /unexpected files/u,
  );
});

test("cryptographically rejects swapped detached signatures before accepting output", () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-updater-signature-test-"));
  const outputDirectory = path.join(temporary.path, "output");
  mkdirSync(outputDirectory);
  assert.throws(
    () =>
      prepareUpdaterArtifacts({
        artifact: path.join(fixtures, updaterArtifactName(updaterFixtureVersion)),
        artifactSignature: path.join(fixtures, "mish-alpha.json.sig"),
        channel: "alpha",
        metadataSignature: path.join(fixtures, `${updaterArtifactName(updaterFixtureVersion)}.sig`),
        outputDirectory,
        publicKey,
        sourceSha: updaterFixtureSourceSha,
        version: updaterFixtureVersion,
      }),
    /does not verify the expected content/u,
  );
});
