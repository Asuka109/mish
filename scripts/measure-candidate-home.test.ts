import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempDisposableSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  prepareMeasuredCandidateHome,
  summarizeCandidateHomeSamples,
  type CandidateHomeStrategy,
} from "./measure-candidate-home.ts";

const ASSETS = [
  ["geosite.dat", "GeoSite.dat"],
  ["geoip.dat", "GeoIP.dat"],
  ["geoip.metadb", "geoip.metadb"],
  ["GeoLite2-ASN.mmdb", "ASN.mmdb"],
] as const;

function fixture(root: string) {
  const snapshot = path.join(root, "snapshot");
  mkdirSync(snapshot);
  const assets = ASSETS.map(([name, runtimeName], index) => {
    const content = Buffer.alloc(64 * 1024, index + 1);
    writeFileSync(path.join(snapshot, name), content);
    return {
      bytes: content.byteLength,
      name,
      runtimeName,
      sha256: createHash("sha256").update(content).digest("hex"),
    };
  });
  writeFileSync(path.join(snapshot, "manifest.json"), JSON.stringify({ assets, schemaVersion: 2 }));
  return snapshot;
}

test("all preparation strategies publish one complete private candidate", () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish candidate measure "));
  const snapshot = fixture(temporary.path);
  const root = path.join(temporary.path, "candidates");
  mkdirSync(root);

  for (const strategy of [
    "current",
    "verified-sequential",
    ...(process.platform === "darwin" ? (["verified-clone"] as const) : []),
  ] satisfies CandidateHomeStrategy[]) {
    const sample = prepareMeasuredCandidateHome({ root, snapshot, strategy });
    assert.equal(sample.outcome, "success");
    assert.equal(sample.bytes, 4 * 64 * 1024);
    assert.equal(
      readdirSync(root).some((entry) => entry.startsWith(".staging-")),
      false,
    );
  }
});

test("injected failure and cancellation remove every partial candidate", () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish candidate cleanup "));
  const snapshot = fixture(temporary.path);

  for (const kind of ["failure", "cancelled"] as const) {
    const root = path.join(temporary.path, kind);
    mkdirSync(root);
    const sample = prepareMeasuredCandidateHome({
      fault: { afterAsset: 2, kind },
      root,
      snapshot,
      strategy: "current",
    });
    assert.equal(sample.outcome, kind);
    assert.deepEqual(readdirSync(root), []);
    assert.equal(existsSync(path.join(root, "home")), false);
  }
});

test("summary keeps first-run evidence separate from the warm median", () => {
  const samples = [8, 4, 6].map((prepareMilliseconds) => ({
    bytes: 1,
    cleanupMilliseconds: 0,
    cloneUsed: false,
    outcome: "success" as const,
    prepareMilliseconds,
    strategy: "current" as const,
  }));
  assert.deepEqual(summarizeCandidateHomeSamples(samples), {
    current: {
      firstMilliseconds: 8,
      medianMilliseconds: 6,
      p95Milliseconds: 8,
      samples: 3,
    },
  });
});
