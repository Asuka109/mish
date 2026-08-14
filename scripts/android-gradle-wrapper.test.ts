import assert from "node:assert/strict";
import test from "node:test";

import {
  androidGradleDistribution,
  pinAndroidGradleWrapper,
  validateAndroidGradleWrapper,
} from "./android-gradle-wrapper.ts";

const canonicalUrl =
  "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.3-bin.zip";
const canonicalChecksum = `distributionSha256Sum=${androidGradleDistribution.distributionSha256Sum}`;

function fixture(...properties: string[]) {
  return [
    "# generated fixture",
    "distributionBase=GRADLE_USER_HOME",
    ...properties,
    "distributionPath=wrapper/dists",
    "zipStorePath=wrapper/dists",
    "zipStoreBase=GRADLE_USER_HOME",
    "",
  ].join("\n");
}

test("canonical Gradle wrapper pin validates and regeneration preserves it", () => {
  const source = fixture(canonicalUrl, canonicalChecksum);
  assert.deepEqual(validateAndroidGradleWrapper(source), []);
  assert.equal(pinAndroidGradleWrapper(source), source);
  assert.equal(pinAndroidGradleWrapper(pinAndroidGradleWrapper(source)), source);
});

test("generation writes the reviewed URL and checksum deterministically", () => {
  const generated = pinAndroidGradleWrapper(fixture());

  assert.deepEqual(validateAndroidGradleWrapper(generated), []);
  assert.equal(generated.match(/^distributionUrl=/gmu)?.length, 1);
  assert.equal(generated.match(/^distributionSha256Sum=/gmu)?.length, 1);
  assert.ok(generated.includes(canonicalUrl));
  assert.ok(generated.includes(canonicalChecksum));
});

for (const [name, source, expectedError] of [
  [
    "missing checksum",
    fixture(canonicalUrl),
    "The Gradle wrapper distribution SHA-256 is missing.",
  ],
  [
    "malformed checksum",
    fixture(canonicalUrl, "distributionSha256Sum=not-a-sha256"),
    "The Gradle wrapper distribution SHA-256 is malformed.",
  ],
  [
    "altered checksum",
    fixture(canonicalUrl, `distributionSha256Sum=${"0".repeat(64)}`),
    "The Gradle wrapper distribution SHA-256 does not match the canonical pin.",
  ],
  [
    "duplicate checksum",
    fixture(canonicalUrl, canonicalChecksum, canonicalChecksum),
    "The Gradle wrapper distribution SHA-256 must occur exactly once.",
  ],
  [
    "version-mismatched URL",
    fixture(
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.2-bin.zip",
      canonicalChecksum,
    ),
    "The Gradle wrapper distribution URL/version does not match the canonical pin.",
  ],
  [
    "URL and checksum pair from another Gradle version",
    fixture(
      "distributionUrl=https\\://services.gradle.org/distributions/gradle-8.14.2-bin.zip",
      "distributionSha256Sum=7197a12f450794931532469d4ff21a59ea2c1cd59a3ec3f89c035c3c420a6999",
    ),
    "The Gradle wrapper distribution SHA-256 does not match the canonical pin.",
  ],
  [
    "replaced distribution URL",
    fixture(
      "distributionUrl=https\\://example.invalid/distributions/gradle-8.14.3-bin.zip",
      canonicalChecksum,
    ),
    "The Gradle wrapper distribution URL/version does not match the canonical pin.",
  ],
] as const) {
  test(`validation rejects ${name}`, () => {
    assert.ok(validateAndroidGradleWrapper(source).includes(expectedError));
  });
}
