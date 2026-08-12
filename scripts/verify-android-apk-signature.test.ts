import assert from "node:assert/strict";
import test from "node:test";

import {
  ANDROID_SIGNER_POLICY,
  ANDROID_SIGNER_SCHEME,
  ANDROID_SIGNER_VERIFICATION,
  parseApksignerVerification,
  readPinnedSignerSha256,
  verifyApkSignerPin,
} from "./verify-android-apk-signature.ts";

const signer = "8e55b6922b8010c1ebd6c2fdce16ab1b10163f700068e67583aec20870b76934";
const foreignSigner = "1e55b6922b8010c1ebd6c2fdce16ab1b10163f700068e67583aec20870b76934";
const verifiedOutput = (digest = signer) =>
  `Verified using v1 scheme (JAR signing): false\nVerified using v2 scheme (APK Signature Scheme v2): true\nVerified using v3 scheme (APK Signature Scheme v3): false\nSigner #1 certificate SHA-256 digest: ${digest}\n`;
const manifest = JSON.stringify({
  android: {
    signing: {
      policy: ANDROID_SIGNER_POLICY,
      scheme: ANDROID_SIGNER_SCHEME,
      verification: ANDROID_SIGNER_VERIFICATION,
      signerSha256: signer,
    },
  },
});

test("accepts the exact pinned signer from a verified APK", () => {
  const observation = verifyApkSignerPin(verifiedOutput(), manifest);
  assert.equal(observation.certificateSha256, signer);
  assert.deepEqual(observation.schemes, ["v2"]);
});

test("rejects a different signer before any package effect", () => {
  assert.throws(
    () => verifyApkSignerPin(verifiedOutput(foreignSigner), manifest),
    /does not match the pinned/u,
  );
});

test("rejects missing, multiple, and malformed signer observations", () => {
  assert.throws(
    () => parseApksignerVerification("Verified using v2 scheme (APK Signature Scheme v2): true\n"),
    /exactly one signer/u,
  );
  assert.throws(
    () =>
      parseApksignerVerification(
        `${verifiedOutput()}Signer #2 certificate SHA-256 digest: ${foreignSigner}\n`,
      ),
    /exactly one signer/u,
  );
  assert.throws(() => parseApksignerVerification(verifiedOutput("not-a-digest")), /malformed/u);
  assert.throws(
    () => parseApksignerVerification(verifiedOutput(signer.toUpperCase())),
    /malformed/u,
  );
  assert.throws(
    () => parseApksignerVerification("Verified using v2 scheme (APK Signature Scheme v2): false\n"),
    /verified scheme/u,
  );
});

test("rejects malformed or drifted manifest policy", () => {
  assert.equal(readPinnedSignerSha256(manifest), signer);
  assert.throws(
    () =>
      readPinnedSignerSha256(manifest.replace(ANDROID_SIGNER_POLICY, "arbitrary-runtime-value")),
    /bounded Android signer policy/u,
  );
  assert.throws(
    () => readPinnedSignerSha256(manifest.replace(signer, "A".repeat(64))),
    /bounded Android signer policy/u,
  );
});

test("keeps certificate bytes, paths, and private material out of bounded results", () => {
  const observation = parseApksignerVerification(verifiedOutput());
  const serialized = JSON.stringify(observation);
  assert.doesNotMatch(serialized, /keystore|private|\/|mish-fixture/u);
  assert.doesNotMatch(serialized, /[A-Z]:\\/u);
});
