import assert from "node:assert/strict";
import test from "node:test";

import { runReleaseSecurityGate } from "./release-security-adversarial.ts";

test("credential-free release security gate closes the E1.1-E1.3 adversarial matrix", async () => {
  const report = await runReleaseSecurityGate();
  assert.equal(report.schemaVersion, 1);
  assert.equal(report.transcript.eventCount, 19);
  assert.ok(
    report.records.every(({ status }) => ["covered", "rejected", "cleaned"].includes(status)),
  );
  assert.equal(new Set(report.records.map(({ id }) => id)).size, report.records.length);
  assert.doesNotMatch(JSON.stringify(report), /private key|certificate|\/tmp|execPath/u);
});
