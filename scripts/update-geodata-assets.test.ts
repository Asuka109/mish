import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempDisposableSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  REQUIRED_GEODATA_ASSETS,
  updateGeodataSnapshot,
  type GeodataRelease,
} from "./update-geodata-assets.ts";

const contentByName = new Map(
  REQUIRED_GEODATA_ASSETS.map((name) => [name, Buffer.from(`fixture:${name}`)]),
);

function digest(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

function releaseFixture(): GeodataRelease {
  return {
    assets: [
      { id: 99, name: "unrelated.txt", size: 4 },
      ...REQUIRED_GEODATA_ASSETS.toReversed().map((name, index) => {
        const content = contentByName.get(name);
        assert(content);
        return {
          digest: `sha256:${digest(content)}`,
          id: index + 10,
          name,
          size: content.byteLength,
        };
      }),
    ],
    html_url: "https://github.com/MetaCubeX/meta-rules-dat/releases/tag/latest",
    id: 1234,
    published_at: "2026-07-23T00:00:00Z",
    tag_name: "latest",
  };
}

test("downloads the exact required release assets and records deterministic provenance", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish geodata "));
  const outputDirectory = path.join(temporary.path, "snapshot");
  const release = releaseFixture();
  const requested: number[] = [];

  const manifest = await updateGeodataSnapshot({
    downloadAsset: async (asset) => {
      requested.push(asset.id);
      const content = contentByName.get(asset.name);
      assert(content);
      return content;
    },
    outputDirectory,
    release,
  });

  assert.deepEqual(
    manifest.assets.map((asset) => asset.name),
    REQUIRED_GEODATA_ASSETS,
  );
  assert.deepEqual(
    requested,
    release.assets
      .filter((asset) => REQUIRED_GEODATA_ASSETS.includes(asset.name))
      .toSorted((left, right) => {
        return (
          REQUIRED_GEODATA_ASSETS.indexOf(left.name) - REQUIRED_GEODATA_ASSETS.indexOf(right.name)
        );
      })
      .map((asset) => asset.id),
  );
  assert.equal(manifest.release.id, release.id);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.source.license, "GPL-3.0-only");

  for (const asset of manifest.assets) {
    const downloaded = readFileSync(path.join(outputDirectory, asset.name));
    assert.equal(downloaded.toString(), `fixture:${asset.name}`);
    assert.equal(asset.sha256, digest(downloaded));
    assert.equal(asset.bytes, downloaded.byteLength);
  }
  assert.deepEqual(
    JSON.parse(readFileSync(path.join(outputDirectory, "manifest.json"), "utf8")),
    manifest,
  );
  assert.deepEqual(
    readdirSync(temporary.path).filter((entry) => entry.includes("staging")),
    [],
  );
});

test("rejects missing and duplicate required release assets before downloading", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish geodata invalid "));
  const release = releaseFixture();
  let downloads = 0;
  const run = (candidate: GeodataRelease) =>
    updateGeodataSnapshot({
      downloadAsset: async () => {
        downloads += 1;
        return Buffer.alloc(0);
      },
      outputDirectory: path.join(temporary.path, "snapshot"),
      release: candidate,
    });

  await assert.rejects(
    run({ ...release, assets: release.assets.filter((asset) => asset.name !== "geosite.dat") }),
    /required GeoData release asset is missing: geosite\.dat/u,
  );
  const duplicate = release.assets.find((asset) => asset.name === "geoip.dat");
  assert(duplicate);
  await assert.rejects(
    run({ ...release, assets: [...release.assets, duplicate] }),
    /duplicate GeoData release asset: geoip\.dat/u,
  );
  assert.equal(downloads, 0);
});

test("size or digest mismatch leaves the prior manifest and published snapshots unchanged", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish geodata mismatch "));
  const outputDirectory = path.join(temporary.path, "snapshot");
  const release = releaseFixture();

  await assert.rejects(
    updateGeodataSnapshot({
      downloadAsset: async (asset) => {
        const content = contentByName.get(asset.name);
        assert(content);
        return asset.name === "geoip.dat"
          ? Buffer.concat([content, Buffer.from("extra")])
          : content;
      },
      outputDirectory,
      release,
    }),
    /GeoData asset size mismatch: geoip\.dat/u,
  );

  assert.equal(existsSync(outputDirectory), false);
  assert.deepEqual(
    readdirSync(temporary.path).filter((entry) => entry.includes("staging")),
    [],
  );

  const badDigestRelease = releaseFixture();
  const geosite = badDigestRelease.assets.find((asset) => asset.name === "geosite.dat");
  assert(geosite);
  geosite.digest = `sha256:${"0".repeat(64)}`;
  await assert.rejects(
    updateGeodataSnapshot({
      downloadAsset: async (asset) => {
        const content = contentByName.get(asset.name);
        assert(content);
        return content;
      },
      outputDirectory,
      release: badDigestRelease,
    }),
    /GeoData asset digest mismatch: geosite\.dat/u,
  );
  assert.equal(existsSync(outputDirectory), false);
});

test("download failure publishes neither a snapshot nor a replacement manifest", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish geodata failure "));
  const outputDirectory = path.join(temporary.path, "snapshot");
  const release = releaseFixture();

  await assert.rejects(
    updateGeodataSnapshot({
      downloadAsset: async (asset) => {
        if (asset.name === "geoip.metadb") throw new Error("synthetic download failure");
        const content = contentByName.get(asset.name);
        assert(content);
        return content;
      },
      outputDirectory,
      release,
    }),
    /synthetic download failure/u,
  );

  assert.equal(existsSync(outputDirectory), false);
});

test("rejects a same-size corrupted published snapshot without downloading over it", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish geodata corrupt "));
  const outputDirectory = path.join(temporary.path, "snapshot");
  const release = releaseFixture();
  const download = async (asset: GeodataRelease["assets"][number]) => {
    const content = contentByName.get(asset.name);
    assert(content);
    return content;
  };
  await updateGeodataSnapshot({
    downloadAsset: download,
    outputDirectory,
    release,
  });
  const geositePath = path.join(outputDirectory, "geosite.dat");
  const geosite = readFileSync(geositePath);
  writeFileSync(geositePath, Buffer.alloc(geosite.byteLength, 1));
  let downloads = 0;

  await assert.rejects(
    updateGeodataSnapshot({
      downloadAsset: async (asset) => {
        downloads += 1;
        return download(asset);
      },
      outputDirectory,
      release,
    }),
    /existing GeoData snapshot is invalid: 1234/u,
  );
  assert.equal(downloads, 0);
  assert.deepEqual(readFileSync(geositePath), Buffer.alloc(geosite.byteLength, 1));
});

test("atomically replaces an older valid bundled snapshot", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish geodata replace "));
  const outputDirectory = path.join(temporary.path, "snapshot");
  const firstRelease = releaseFixture();
  const download = async (asset: GeodataRelease["assets"][number]) => {
    const content = contentByName.get(asset.name);
    assert(content);
    return content;
  };
  await updateGeodataSnapshot({ downloadAsset: download, outputDirectory, release: firstRelease });

  const nextRelease = {
    ...releaseFixture(),
    id: 5678,
    published_at: "2026-07-24T00:00:00Z",
  };
  await updateGeodataSnapshot({ downloadAsset: download, outputDirectory, release: nextRelease });

  const manifest = JSON.parse(
    readFileSync(path.join(outputDirectory, "manifest.json"), "utf8"),
  ) as { release: { id: number } };
  assert.equal(manifest.release.id, nextRelease.id);
  assert.deepEqual(
    readdirSync(temporary.path).filter(
      (entry) => entry.includes("staging") || entry.includes("previous"),
    ),
    [],
  );
});

test("rejects an unsafe existing snapshot path before downloading", async () => {
  using temporary = mkdtempDisposableSync(path.join(tmpdir(), "mish geodata unsafe "));
  const outputDirectory = path.join(temporary.path, "snapshot");
  writeFileSync(outputDirectory, "not a directory");
  let downloads = 0;

  await assert.rejects(
    updateGeodataSnapshot({
      downloadAsset: async () => {
        downloads += 1;
        return Buffer.alloc(0);
      },
      outputDirectory,
      release: releaseFixture(),
    }),
    /existing GeoData snapshot path is unsafe/u,
  );
  assert.equal(downloads, 0);
});
