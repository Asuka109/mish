import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

const release = {
  asset: "mihomo-darwin-arm64-v1.19.29.gz",
  repository: "MetaCubeX/mihomo",
  sha256: "4dc25df9e899f14161911302a8ee5fc9e202ed9c976fc405bf82c50ff27466ca",
  version: "v1.19.29",
} as const;

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
if (digest !== release.sha256) {
  throw new Error(`Mihomo checksum mismatch: expected ${release.sha256}, received ${digest}`);
}
await writeFile(binary, gunzipSync(compressed));
await chmod(binary, 0o755);
console.log(`Prepared ${binary}`);
