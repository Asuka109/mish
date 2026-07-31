import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  cleanupQuarantine,
  compileQuarantine,
  compileTranscript,
  rawTranscriptFileName,
  runCli,
  sensitiveMarkerFileName,
  transcriptCapturePolicy,
  validateSanitizedTranscript,
} from "./macos-platform-transcript.ts";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const fixtures = path.join(import.meta.dirname, "fixtures/macos-platform-transcripts");

type SyntheticCase = {
  also?: { requestKind: string; result: Record<string, unknown> };
  expectError?: string;
  name: string;
  requestKind: string;
  result: Record<string, unknown>;
  topLevel?: Record<string, unknown>;
};

async function json(file: string): Promise<any> {
  return JSON.parse(await readFile(path.join(fixtures, file), "utf8"));
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function sha256(value: Buffer | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function replaceResult(raw: any, requestKind: string, result: Record<string, unknown>): void {
  const record = raw.records.find((candidate: any) => candidate.requestKind === requestKind);
  assert.ok(record, `Missing fixture record ${requestKind}`);
  record.result = result;
}

test("deterministically compiles the fixed synthetic raw transcript without raw identifiers", async () => {
  const raw = await json("synthetic-base.json");
  const first = compileTranscript(raw, {
    fixtureId: "synthetic-base",
    sourceKind: "synthetic-test",
  });
  const second = compileTranscript(clone(raw), {
    fixtureId: "synthetic-base",
    sourceKind: "synthetic-test",
  });

  assert.deepEqual(first, second);
  assert.equal(first.fixture.schemaVersion, 1);
  assert.equal(first.fixture.platformFamily, "macos");
  assert.equal(first.fixture.productVersionFamily, "26.x");
  assert.equal(first.fixture.buildFamily, "25F");
  assert.equal(first.fixture.architecture, "arm64");
  assert.equal(first.fixture.locale, "C");
  assert.equal(first.fixture.requests.length, 8);
  assert.equal(first.fixture.provenance.capturePolicy, transcriptCapturePolicy);
  assert.match(first.fixture.provenance.sanitizedTranscriptSha256, /^[a-f0-9]{64}$/u);

  const serialized = JSON.stringify(first);
  for (const rawValue of [
    "Controlled Lab Ethernet",
    "en42",
    "USB 10/100/1000 LAN",
    "controlled.proxy.invalid",
    "internal.controlled.invalid",
    "Unrelated Wi-Fi",
    "192.0.2.1",
    "private-name",
  ]) {
    assert.doesNotMatch(serialized, new RegExp(rawValue.replaceAll(".", "\\."), "u"));
  }
  assert.match(serialized, /network-service-1/u);
  assert.equal(serialized.match(/proxy-host-1\.fixture\.invalid/gu)?.length, 3);
  assert.equal(serialized.match(/Port: 40001/gu)?.length, 2);
  assert.match(serialized, /Port: 40002/u);
  assert.match(first.privacyDiff, /Raw values included: \*\*none\*\*/u);
  assert.doesNotMatch(first.privacyDiff, /Controlled|en42|USB|192\.0\.2\.1/u);
});

test("checked-in real Tart fixture and privacy diff retain their validated exact identities", async () => {
  const checkedRoot = path.join(repositoryRoot, "docs/quality/fixtures/macos-platform-transcripts");
  const fixtureBytes = await readFile(path.join(checkedRoot, "system-proxy-macos26-arm64.json"));
  const privacyBytes = await readFile(
    path.join(checkedRoot, "system-proxy-macos26-arm64.privacy.md"),
  );
  const fixture = JSON.parse(fixtureBytes.toString("utf8"));
  validateSanitizedTranscript(fixture);
  assert.equal(
    sha256(fixtureBytes),
    "a1c75df6966eb051120547325becd11b2038b4b816e584a47a8242fba27599fd",
  );
  assert.equal(
    sha256(privacyBytes),
    "df13246a227f006c55126c2427d131c1b15eec221d4df41eaef79c5247575703",
  );
  const privacy = privacyBytes.toString("utf8");
  assert.match(privacy, /Source: `real-tart-capture`/u);
  assert.match(privacy, new RegExp(fixture.provenance.sanitizedTranscriptSha256, "u"));
  assert.doesNotMatch(privacy, /raw-transcript|\/Users\/|192\.168\.|BEGIN PRIVATE KEY/iu);
});

test("validates the emitted schema, closed result kinds, synthetic values, digest, and maximum size", async () => {
  const raw = await json("synthetic-base.json");
  const { fixture } = compileTranscript(raw, {
    fixtureId: "schema-validation",
    sourceKind: "synthetic-test",
  });
  assert.doesNotThrow(() => validateSanitizedTranscript(fixture));

  for (const mutate of [
    (candidate: any) => (candidate.requests[0].result.kind = "partial"),
    (candidate: any) =>
      (candidate.requests[2].result.stdout = candidate.requests[2].result.stdout.replace(
        "proxy-host-1.fixture.invalid",
        "real.example",
      )),
    (candidate: any) => (candidate.requests[0].result.stdout = "x".repeat(8_193)),
    (candidate: any) => (candidate.provenance.sanitizedTranscriptSha256 = "0".repeat(64)),
    (candidate: any) => (candidate.unexpected = true),
  ]) {
    const candidate = clone(fixture);
    mutate(candidate);
    assert.throws(() => validateSanitizedTranscript(candidate));
  }
});

test("repository-owned synthetic raw cases cover variation, typed failures, malformed output, and privacy rejection", async () => {
  const base = await json("synthetic-base.json");
  const caseFile = (await json("synthetic-cases.json")) as {
    cases: SyntheticCase[];
    schemaVersion: number;
  };
  assert.equal(caseFile.schemaVersion, 1);
  assert.deepEqual(
    caseFile.cases.map(({ name }) => name),
    [
      "malformed-output",
      "version-line-ending-variation",
      "locale-variation-rejected",
      "truncation",
      "timeout",
      "permission-error",
      "unexpected-field",
      "pseudonym-consistency",
      "privacy-rejection",
      "closed-result-kind",
      "cleanup-failure",
    ],
  );

  for (const fixtureCase of caseFile.cases) {
    const raw = clone(base);
    replaceResult(raw, fixtureCase.requestKind, fixtureCase.result);
    Object.assign(raw, fixtureCase.topLevel);
    if (fixtureCase.also) {
      replaceResult(raw, fixtureCase.also.requestKind, fixtureCase.also.result);
    }
    const compile = () =>
      compileTranscript(raw, { fixtureId: fixtureCase.name, sourceKind: "synthetic-test" });
    if (fixtureCase.expectError) {
      assert.throws(compile, new RegExp(fixtureCase.expectError, "iu"), fixtureCase.name);
      continue;
    }
    const compiled = compile();
    if (fixtureCase.name === "version-line-ending-variation") {
      assert.equal(compiled.fixture.productVersionFamily, "15.x");
      assert.equal(compiled.fixture.buildFamily, "24G");
      assert.equal(compiled.fixture.locale, "C");
    }
    if (["truncation", "timeout", "permission-error"].includes(fixtureCase.name)) {
      assert.ok(
        compiled.fixture.requests.some(({ result }) => result.kind === fixtureCase.result.kind),
      );
    }
  }
});

test("refuses arbitrary programs, arguments, paths, remote targets, open fields, and oversized output", async () => {
  const base = await json("synthetic-base.json");
  for (const mutate of [
    (raw: any) => (raw.records[3].program = "/usr/bin/ssh"),
    (raw: any) => raw.records[3].arguments.push("example.com"),
    (raw: any) => (raw.records[5].arguments = ["-getwebproxy", "../../private"]),
    (raw: any) => (raw.records[5].remoteTarget = "host.example"),
  ]) {
    const raw = clone(base);
    mutate(raw);
    assert.throws(
      () => compileTranscript(raw, { fixtureId: "refusal", sourceKind: "synthetic-test" }),
      /program or arguments|missing or unexpected fields/u,
    );
  }

  const oversized = clone(base);
  oversized.records[5].result.stdout = "x".repeat(65_537);
  assert.throws(
    () => compileTranscript(oversized, { fixtureId: "oversized", sourceKind: "synthetic-test" }),
    /oversized/u,
  );
});

async function quarantine(name: string, raw: unknown): Promise<string> {
  const root = path.join(
    repositoryRoot,
    `.scratch/macos-platform-transcripts/raw/mish-329-${name}-${process.pid}`,
  );
  await mkdir(root, { recursive: true, mode: 0o700 });
  await writeFile(path.join(root, sensitiveMarkerFileName), "Sensitive synthetic test fixture.\n", {
    mode: 0o600,
  });
  await writeFile(path.join(root, rawTranscriptFileName), `${JSON.stringify(raw)}\n`, {
    mode: 0o600,
  });
  return root;
}

test("successful compilation deletes raw quarantine and leaves only the synthetic fixture and privacy diff", async () => {
  const raw = await json("synthetic-base.json");
  const inputRoot = await quarantine("success", raw);
  const suffix = `system-proxy-test-success-${process.pid}`;
  const fixtureOutput = path.join(
    repositoryRoot,
    `docs/quality/fixtures/macos-platform-transcripts/${suffix}.json`,
  );
  const privacyDiffOutput = path.join(
    repositoryRoot,
    `docs/quality/fixtures/macos-platform-transcripts/${suffix}.privacy.md`,
  );
  await compileQuarantine({
    fixtureId: "success",
    fixtureOutput,
    inputRoot,
    privacyDiffOutput,
    sourceKind: "synthetic-test",
  });
  await assert.rejects(stat(inputRoot), /ENOENT/u);
  assert.equal(JSON.parse(await readFile(fixtureOutput, "utf8")).schemaVersion, 1);
  assert.match(await readFile(privacyDiffOutput, "utf8"), /Raw values included/u);
  await unlink(fixtureOutput);
  await unlink(privacyDiffOutput);
});

test("cleanup failure visibly fails, removes candidate outputs, and never blesses a fixture", async () => {
  const raw = await json("synthetic-base.json");
  const inputRoot = await quarantine("cleanup-failure", raw);
  const suffix = `system-proxy-test-cleanup-failure-${process.pid}`;
  const fixtureOutput = path.join(
    repositoryRoot,
    `docs/quality/fixtures/macos-platform-transcripts/${suffix}.json`,
  );
  const privacyDiffOutput = path.join(
    repositoryRoot,
    `docs/quality/fixtures/macos-platform-transcripts/${suffix}.privacy.md`,
  );
  await assert.rejects(
    compileQuarantine({
      cleanup: async () => {
        throw new Error("synthetic cleanup failure");
      },
      fixtureId: "cleanup-failure",
      fixtureOutput,
      inputRoot,
      privacyDiffOutput,
      sourceKind: "synthetic-test",
    }),
    /fixture is not accepted/u,
  );
  await assert.rejects(stat(fixtureOutput), /ENOENT/u);
  await assert.rejects(stat(privacyDiffOutput), /ENOENT/u);
  assert.deepEqual(
    (await readdir(inputRoot)).sort(),
    [rawTranscriptFileName, sensitiveMarkerFileName].sort(),
  );
  await cleanupQuarantine(inputRoot);
});

test("explicit abort removes only an allowlisted quarantine and CLI rejects unallowlisted options", async () => {
  const raw = await json("synthetic-base.json");
  const inputRoot = await quarantine("abort", raw);
  await cleanupQuarantine(inputRoot);
  await assert.rejects(stat(inputRoot), /ENOENT/u);
  await assert.rejects(
    runCli(["record", "--output-root", inputRoot, "--program", "/usr/bin/ssh"]),
    /unallowlisted options/u,
  );
  await assert.rejects(
    runCli(["abort", "--output-root", path.join(repositoryRoot, ".scratch")]),
    /direct child/u,
  );
});
