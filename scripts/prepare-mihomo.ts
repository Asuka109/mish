import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

type MacOsMihomoRelease = {
  archiveSha256: string;
  asset: string;
  binarySha256: string;
  repository: string;
  schemaVersion: 1;
  version: string;
};

const release = JSON.parse(
  await readFile(path.resolve("resources/mihomo/macos-arm64.json"), "utf8"),
) as MacOsMihomoRelease;

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The pinned development asset currently supports Apple Silicon macOS only");
}

const directory = path.resolve(".scratch/mihomo", release.version);
const archive = path.join(directory, release.asset);
const binary = archive.slice(0, -3);
await mkdir(directory, { recursive: true });

execFileSync(
  "gh",
  [
    "release",
    "download",
    release.version,
    "--repo",
    release.repository,
    "--pattern",
    release.asset,
    "--dir",
    directory,
    "--skip-existing",
  ],
  { stdio: "inherit" },
);

const compressed = await readFile(archive);
const digest = createHash("sha256").update(compressed).digest("hex");
if (digest !== release.archiveSha256) {
  throw new Error(
    `Mihomo checksum mismatch: expected ${release.archiveSha256}, received ${digest}`,
  );
}
const uncompressed = gunzipSync(compressed);
const binaryDigest = createHash("sha256").update(uncompressed).digest("hex");
if (binaryDigest !== release.binarySha256) {
  throw new Error(
    `Mihomo binary checksum mismatch: expected ${release.binarySha256}, received ${binaryDigest}`,
  );
}
await writeFile(binary, uncompressed);
await chmod(binary, 0o755);
console.log(`Prepared ${binary}`);
