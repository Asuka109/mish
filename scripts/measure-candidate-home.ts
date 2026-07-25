import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempDisposableSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";

export type CandidateHomeStrategy = "current" | "verified-clone" | "verified-sequential";

type ManifestAsset = {
  bytes: number;
  name: string;
  runtimeName: string;
  sha256: string;
};

type Manifest = {
  assets: ManifestAsset[];
  schemaVersion: number;
};

export type CandidateHomeFault = {
  afterAsset: number;
  kind: "cancelled" | "failure";
};

export type CandidateHomeSample = {
  bytes: number;
  cleanupMilliseconds: number;
  cloneUsed: boolean;
  outcome: "cancelled" | "failure" | "success";
  prepareMilliseconds: number;
  strategy: CandidateHomeStrategy;
};

export type GlobalHomeSample = {
  filesCreated: number;
  mode: "cold" | "warm";
  outcome: "cancelled" | "failure" | "success";
  prepareMilliseconds: number;
  sourceBytesRead: number;
  writtenBytes: number;
};

const REQUIRED_ASSETS = [
  ["geosite.dat", "GeoSite.dat"],
  ["geoip.dat", "GeoIP.dat"],
  ["geoip.metadb", "geoip.metadb"],
  ["GeoLite2-ASN.mmdb", "ASN.mmdb"],
] as const;

function digest(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

function readManifest(snapshot: string): Manifest {
  const metadata = lstatSync(snapshot);
  assert(metadata.isDirectory() && !metadata.isSymbolicLink(), "snapshot must be a real directory");
  const manifest = JSON.parse(
    readFileSync(path.join(snapshot, "manifest.json"), "utf8"),
  ) as Manifest;
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(manifest.assets.length, REQUIRED_ASSETS.length);
  for (const [index, [name, runtimeName]] of REQUIRED_ASSETS.entries()) {
    const asset = manifest.assets[index];
    assert(asset);
    assert.equal(asset.name, name);
    assert.equal(asset.runtimeName, runtimeName);
    assert(Number.isSafeInteger(asset.bytes) && asset.bytes > 0);
    assert.match(asset.sha256, /^[0-9a-f]{64}$/u);
  }
  return manifest;
}

function verifiedAssets(snapshot: string, manifest: Manifest) {
  return manifest.assets.map((asset) => {
    const source = path.join(snapshot, asset.name);
    const metadata = lstatSync(source);
    assert(metadata.isFile() && !metadata.isSymbolicLink(), `${asset.name} must be a real file`);
    assert.equal(metadata.size, asset.bytes);
    const content = readFileSync(source);
    assert.equal(digest(content), asset.sha256);
    return { asset, content, source };
  });
}

export function prepareMeasuredCandidateHome(options: {
  fault?: CandidateHomeFault;
  root: string;
  snapshot: string;
  strategy: CandidateHomeStrategy;
}): CandidateHomeSample {
  const manifest = readManifest(options.snapshot);
  const candidateId = randomUUID();
  const staging = path.join(options.root, `.staging-${candidateId}`);
  const candidate = path.join(options.root, candidateId);
  const home = path.join(staging, "home");
  mkdirSync(home, { mode: 0o700, recursive: true });
  const started = performance.now();
  let cloneUsed = false;
  let outcome: CandidateHomeSample["outcome"] = "success";
  let cleanupMilliseconds = 0;

  try {
    const verified = verifiedAssets(options.snapshot, manifest);
    for (const [index, { asset, content, source }] of verified.entries()) {
      if (options.fault?.afterAsset === index) {
        outcome = options.fault.kind;
        throw new Error(`injected-${options.fault.kind}`);
      }
      const destination = path.join(home, asset.runtimeName);
      if (options.strategy === "current") {
        writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
      } else if (options.strategy === "verified-sequential") {
        copyFileSync(source, destination);
      } else {
        assert.equal(process.platform, "darwin", "APFS clone measurement requires macOS");
        execFileSync("/bin/cp", ["-c", source, destination], { stdio: "pipe" });
        cloneUsed = true;
      }
      chmodSync(destination, 0o600);
    }
    renameSync(staging, candidate);
    for (const asset of manifest.assets) {
      assert.equal(lstatSync(path.join(candidate, "home", asset.runtimeName)).size, asset.bytes);
    }
  } catch (error) {
    const cleanupStarted = performance.now();
    rmSync(staging, { force: true, recursive: true });
    rmSync(candidate, { force: true, recursive: true });
    cleanupMilliseconds = performance.now() - cleanupStarted;
    if (!options.fault) throw error;
  }

  return {
    bytes: manifest.assets.reduce((total, asset) => total + asset.bytes, 0),
    cleanupMilliseconds,
    cloneUsed,
    outcome,
    prepareMilliseconds: performance.now() - started,
    strategy: options.strategy,
  };
}

export function prepareMeasuredGlobalHome(options: {
  fault?: "cancelled-after-prepare" | "seed-failure";
  root: string;
  snapshot: string;
}): GlobalHomeSample {
  const home = path.join(options.root, "mihomo", "home");
  const configs = path.join(options.root, "mihomo", "configs");
  mkdirSync(home, { mode: 0o700, recursive: true });
  mkdirSync(configs, { mode: 0o700, recursive: true });
  const mode = REQUIRED_ASSETS.every(([, runtimeName]) => existsSync(path.join(home, runtimeName)))
    ? "warm"
    : "cold";
  const started = performance.now();
  const createdAssets: string[] = [];
  const generation = path.join(configs, `${randomUUID()}.yaml`);
  let sourceBytesRead = 0;
  let writtenBytes = 0;
  let outcome: GlobalHomeSample["outcome"] = "success";

  try {
    if (mode === "cold") {
      const manifest = readManifest(options.snapshot);
      const verified = verifiedAssets(options.snapshot, manifest);
      sourceBytesRead = verified.reduce((total, item) => total + item.content.byteLength, 0);
      for (const [index, { asset, content }] of verified.entries()) {
        const destination = path.join(home, asset.runtimeName);
        if (existsSync(destination)) continue;
        if (options.fault === "seed-failure" && index === 2) {
          outcome = "failure";
          throw new Error("injected-seed-failure");
        }
        writeFileSync(destination, content, { flag: "wx", mode: 0o600 });
        createdAssets.push(destination);
        writtenBytes += content.byteLength;
      }
    } else {
      for (const [, runtimeName] of REQUIRED_ASSETS) {
        const metadata = lstatSync(path.join(home, runtimeName));
        assert(metadata.isFile() && !metadata.isSymbolicLink());
      }
    }

    const config = Buffer.alloc(4 * 1024, 1);
    writeFileSync(generation, config, { flag: "wx", mode: 0o600 });
    writtenBytes += config.byteLength;
    if (options.fault === "cancelled-after-prepare") {
      outcome = "cancelled";
      rmSync(generation);
    }
  } catch (error) {
    for (const asset of createdAssets) rmSync(asset, { force: true });
    rmSync(generation, { force: true });
    if (!options.fault) throw error;
  }

  return {
    filesCreated: createdAssets.length + (existsSync(generation) ? 1 : 0),
    mode,
    outcome,
    prepareMilliseconds: performance.now() - started,
    sourceBytesRead,
    writtenBytes,
  };
}

function percentile(samples: number[], fraction: number) {
  const sorted = samples.toSorted((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

export function summarizeCandidateHomeSamples(samples: CandidateHomeSample[]) {
  return Object.fromEntries(
    [...new Set(samples.map((sample) => sample.strategy))].map((strategy) => {
      const selected = samples.filter(
        (sample) => sample.strategy === strategy && sample.outcome === "success",
      );
      const timings = selected.map((sample) => sample.prepareMilliseconds);
      return [
        strategy,
        {
          firstMilliseconds: timings[0],
          medianMilliseconds: percentile(timings, 0.5),
          p95Milliseconds: percentile(timings, 0.95),
          samples: timings.length,
        },
      ];
    }),
  );
}

function parseIterations(arguments_: string[]) {
  const index = arguments_.indexOf("--iterations");
  if (index === -1) return 7;
  const value = Number(arguments_[index + 1]);
  assert(Number.isSafeInteger(value) && value >= 3 && value <= 100);
  return value;
}

function run() {
  const iterations = parseIterations(process.argv.slice(2));
  const snapshot = path.resolve("resources/geodata/snapshot");
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish-candidate-home-measure-"));
  const samples: CandidateHomeSample[] = [];
  const strategies: CandidateHomeStrategy[] = [
    "current",
    "verified-sequential",
    ...(process.platform === "darwin" ? (["verified-clone"] as const) : []),
  ];
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    for (const strategy of strategies) {
      samples.push(
        prepareMeasuredCandidateHome({
          root: temporary.path,
          snapshot,
          strategy,
        }),
      );
    }
  }
  for (const kind of ["failure", "cancelled"] as const) {
    samples.push(
      prepareMeasuredCandidateHome({
        fault: { afterAsset: 2, kind },
        root: temporary.path,
        snapshot,
        strategy: "current",
      }),
    );
  }
  const globalRoot = path.join(temporary.path, "global-runtime");
  const globalSamples: GlobalHomeSample[] = [
    prepareMeasuredGlobalHome({ root: globalRoot, snapshot }),
  ];
  for (let iteration = 1; iteration < iterations; iteration += 1) {
    globalSamples.push(prepareMeasuredGlobalHome({ root: globalRoot, snapshot }));
  }
  globalSamples.push(
    prepareMeasuredGlobalHome({
      fault: "cancelled-after-prepare",
      root: globalRoot,
      snapshot,
    }),
  );
  const failedRoot = path.join(temporary.path, "failed-global-runtime");
  globalSamples.push(
    prepareMeasuredGlobalHome({
      fault: "seed-failure",
      root: failedRoot,
      snapshot,
    }),
  );
  process.stdout.write(
    `${JSON.stringify(
      {
        filesystem: process.platform === "darwin" ? "darwin" : process.platform,
        globalSamples,
        iterations,
        samples,
        summary: summarizeCandidateHomeSamples(samples),
      },
      null,
      2,
    )}\n`,
  );
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) run();
