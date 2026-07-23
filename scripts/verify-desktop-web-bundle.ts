import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const assetsDirectory = fileURLToPath(new URL("../apps/web/dist/assets/", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const remixIconManifest = JSON.parse(
  readFileSync(`${repositoryRoot}/packages/brand-assets/remix-icon-v4.8.0.json`, "utf8"),
) as {
  assets: { localPath: string; sha256: string }[];
};
const forbiddenMarkers = [
  "mobile-bottom-navigation",
  "mobile-destination-icon",
  "mobile-fixture-banner",
];

for (const entry of readdirSync(assetsDirectory, { withFileTypes: true })) {
  if (!entry.isFile() || !/\.(?:css|js)$/.test(entry.name)) continue;

  const source = readFileSync(`${assetsDirectory}/${entry.name}`, "utf8");
  const marker = forbiddenMarkers.find((candidate) => source.includes(candidate));
  if (!marker) continue;

  throw new Error(
    `Desktop Web bundle contains mobile navigation marker ${marker} in ${entry.name}`,
  );
}

for (const asset of remixIconManifest.assets) {
  const publicPrefix = "packages/brand-assets/public/";
  if (!asset.localPath.startsWith(publicPrefix)) {
    throw new Error(`Remix Icon asset is outside the Web public directory: ${asset.localPath}`);
  }
  const bundledPath = `${repositoryRoot}/apps/web/dist/${asset.localPath.slice(publicPrefix.length)}`;
  const digest = createHash("sha256").update(readFileSync(bundledPath)).digest("hex");
  if (digest !== asset.sha256) {
    throw new Error(`Bundled Remix Icon asset checksum mismatch: ${asset.localPath}`);
  }
}

console.log("Desktop Web bundle excludes mobile navigation modules and includes pinned icons.");
