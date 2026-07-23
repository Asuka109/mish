import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SOURCE_REPOSITORY = "MetaCubeX/meta-rules-dat";
const MAX_ASSET_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
const GH_MAX_BUFFER_BYTES = 72 * 1024 * 1024;

export const REQUIRED_GEODATA_ASSETS = [
  "geosite.dat",
  "geoip.dat",
  "geoip.metadb",
  "GeoLite2-ASN.mmdb",
] as const;

export interface GeodataReleaseAsset {
  digest?: string;
  id: number;
  name: string;
  size: number;
}

export interface GeodataRelease {
  assets: GeodataReleaseAsset[];
  html_url: string;
  id: number;
  published_at: string;
  tag_name: string;
}

interface GeodataManifestAsset {
  bytes: number;
  name: string;
  releaseAssetId: number;
  sha256: string;
}

export interface GeodataManifest {
  assets: GeodataManifestAsset[];
  release: {
    id: number;
    publishedAt: string;
    tag: string;
    url: string;
  };
  schemaVersion: 1;
  source: {
    license: "GPL-3.0-only";
    licenseUrl: string;
    repository: string;
  };
}

interface UpdateGeodataSnapshotOptions {
  downloadAsset: (asset: GeodataReleaseAsset) => Promise<Uint8Array>;
  manifestPath: string;
  outputDirectory: string;
  release: GeodataRelease;
}

function sha256(content: Uint8Array) {
  return createHash("sha256").update(content).digest("hex");
}

function expectedAssets(release: GeodataRelease) {
  if (!Number.isSafeInteger(release.id) || release.id <= 0) {
    throw new Error("GeoData release identifier is invalid");
  }
  if (!release.published_at || !release.tag_name || !release.html_url) {
    throw new Error("GeoData release provenance is incomplete");
  }

  const selected = REQUIRED_GEODATA_ASSETS.map((name) => {
    const matches = release.assets.filter((asset) => asset.name === name);
    if (matches.length === 0) {
      throw new Error(`required GeoData release asset is missing: ${name}`);
    }
    if (matches.length > 1) {
      throw new Error(`duplicate GeoData release asset: ${name}`);
    }
    const [asset] = matches;
    if (!asset || !Number.isSafeInteger(asset.id) || asset.id <= 0) {
      throw new Error(`GeoData release asset identifier is invalid: ${name}`);
    }
    if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_ASSET_BYTES) {
      throw new Error(`GeoData release asset size is invalid: ${name}`);
    }
    if (asset.digest && !/^sha256:[0-9a-f]{64}$/u.test(asset.digest)) {
      throw new Error(`GeoData release asset digest is invalid: ${name}`);
    }
    return asset;
  });

  const totalBytes = selected.reduce((total, asset) => total + asset.size, 0);
  if (totalBytes > MAX_SNAPSHOT_BYTES) {
    throw new Error("GeoData release snapshot exceeds the size limit");
  }
  return selected;
}

function createManifest(release: GeodataRelease, assets: GeodataManifestAsset[]): GeodataManifest {
  return {
    assets,
    release: {
      id: release.id,
      publishedAt: release.published_at,
      tag: release.tag_name,
      url: release.html_url,
    },
    schemaVersion: 1,
    source: {
      license: "GPL-3.0-only",
      licenseUrl: `https://github.com/${SOURCE_REPOSITORY}/blob/master/LICENSE`,
      repository: SOURCE_REPOSITORY,
    },
  };
}

function manifestJson(manifest: GeodataManifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

async function writeFileAtomic(destination: string, content: string) {
  await mkdir(path.dirname(destination), { recursive: true });
  const temporary = `${destination}.${randomUUID()}.partial`;
  try {
    await writeFile(temporary, content, { encoding: "utf8", flag: "wx", mode: 0o644 });
    await rename(temporary, destination);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function existingSnapshot(
  snapshotDirectory: string,
  release: GeodataRelease,
  assets: GeodataReleaseAsset[],
) {
  let manifest: GeodataManifest;
  try {
    manifest = JSON.parse(
      await readFile(path.join(snapshotDirectory, "manifest.json"), "utf8"),
    ) as GeodataManifest;
  } catch {
    return undefined;
  }
  if (manifest.schemaVersion !== 1 || manifest.release.id !== release.id) return undefined;
  if (manifest.assets.length !== assets.length) return undefined;

  for (const [index, asset] of assets.entries()) {
    const recorded = manifest.assets[index];
    if (
      !recorded ||
      recorded.name !== asset.name ||
      recorded.releaseAssetId !== asset.id ||
      recorded.bytes !== asset.size ||
      (asset.digest && recorded.sha256 !== asset.digest.slice("sha256:".length))
    ) {
      return undefined;
    }
    try {
      const assetPath = path.join(snapshotDirectory, asset.name);
      const metadata = await lstat(assetPath);
      if (!metadata.isFile() || metadata.size !== recorded.bytes) return undefined;
      if (sha256(await readFile(assetPath)) !== recorded.sha256) return undefined;
    } catch {
      return undefined;
    }
  }
  return manifest;
}

export async function updateGeodataSnapshot({
  downloadAsset,
  manifestPath,
  outputDirectory,
  release,
}: UpdateGeodataSnapshotOptions): Promise<GeodataManifest> {
  const assets = expectedAssets(release);
  const snapshotDirectory = path.join(outputDirectory, String(release.id));
  const snapshotPresent = await lstat(snapshotDirectory)
    .then(() => true)
    .catch(() => false);
  const existing = await existingSnapshot(snapshotDirectory, release, assets);
  if (existing) {
    await writeFileAtomic(manifestPath, manifestJson(existing));
    return existing;
  }
  if (snapshotPresent) {
    throw new Error(`existing GeoData snapshot is invalid: ${release.id}`);
  }

  await mkdir(outputDirectory, { recursive: true });
  const stagingDirectory = await mkdtemp(path.join(outputDirectory, `.staging-${release.id}-`));
  try {
    const recorded: GeodataManifestAsset[] = [];
    for (const asset of assets) {
      const content = await downloadAsset(asset);
      if (content.byteLength !== asset.size) {
        throw new Error(`GeoData asset size mismatch: ${asset.name}`);
      }
      const digest = sha256(content);
      if (asset.digest && digest !== asset.digest.slice("sha256:".length)) {
        throw new Error(`GeoData asset digest mismatch: ${asset.name}`);
      }
      await writeFile(path.join(stagingDirectory, asset.name), content, {
        flag: "wx",
        mode: 0o644,
      });
      recorded.push({
        bytes: content.byteLength,
        name: asset.name,
        releaseAssetId: asset.id,
        sha256: digest,
      });
    }

    const manifest = createManifest(release, recorded);
    await writeFile(path.join(stagingDirectory, "manifest.json"), manifestJson(manifest), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o644,
    });
    await rename(stagingDirectory, snapshotDirectory);
    await writeFileAtomic(manifestPath, manifestJson(manifest));
    return manifest;
  } catch (error) {
    await rm(stagingDirectory, { force: true, recursive: true });
    throw error;
  }
}

function latestRelease() {
  const output = execFileSync(
    "gh",
    [
      "api",
      "-H",
      "Accept: application/vnd.github+json",
      `repos/${SOURCE_REPOSITORY}/releases/latest`,
    ],
    {
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    },
  );
  return JSON.parse(output) as GeodataRelease;
}

function downloadReleaseAsset(asset: GeodataReleaseAsset) {
  const output = execFileSync(
    "gh",
    [
      "api",
      "-H",
      "Accept: application/octet-stream",
      `repos/${SOURCE_REPOSITORY}/releases/assets/${asset.id}`,
    ],
    {
      encoding: "buffer",
      maxBuffer: GH_MAX_BUFFER_BYTES,
    },
  );
  return Promise.resolve(output);
}

async function main() {
  const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const manifest = await updateGeodataSnapshot({
    downloadAsset: downloadReleaseAsset,
    manifestPath: path.join(repositoryRoot, "resources/geodata/manifest.json"),
    outputDirectory: path.join(repositoryRoot, ".scratch/geodata/meta-rules-dat"),
    release: latestRelease(),
  });
  console.log(
    JSON.stringify({
      assets: manifest.assets.map(({ bytes, name, sha256: digest }) => ({
        bytes,
        name,
        sha256: digest,
      })),
      releaseId: manifest.release.id,
      snapshot: `.scratch/geodata/meta-rules-dat/${manifest.release.id}`,
    }),
  );
}

const entrypoint = process.argv[1];
if (entrypoint && import.meta.url === pathToFileURL(entrypoint).href) {
  await main();
}
