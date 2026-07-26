import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const assetsDirectory = fileURLToPath(new URL("../apps/web/dist/assets/", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const desktopConfiguration = JSON.parse(
  readFileSync(`${repositoryRoot}/apps/desktop/src-tauri/tauri.conf.json`, "utf8"),
) as {
  app?: { security?: { csp?: string } };
};
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
const appearanceBootstrapPath = `${repositoryRoot}/apps/web/dist/appearance-bootstrap.js`;
const entryDocumentPath = `${repositoryRoot}/apps/web/dist/index.html`;
const desktopCsp = desktopConfiguration.app?.security?.csp ?? "";

if (!desktopCsp.includes("script-src 'self'")) {
  throw new Error("Desktop CSP must restrict scripts to self-hosted assets.");
}
if (/script-src[^;]*'unsafe-inline'/.test(desktopCsp)) {
  throw new Error("Desktop CSP must not permit executable inline scripts.");
}

if (!existsSync(appearanceBootstrapPath)) {
  throw new Error("Desktop Web bundle is missing the self-hosted appearance bootstrap.");
}

const entryDocument = readFileSync(entryDocumentPath, "utf8");
const appearanceBootstrapTag = /<script\s+src="\/appearance-bootstrap\.js"><\/script>/;
const appearanceBootstrapMatch = appearanceBootstrapTag.exec(entryDocument);
if (!appearanceBootstrapMatch) {
  throw new Error("Desktop Web entry does not load the self-hosted appearance bootstrap.");
}
if (/<script(?:\s[^>]*)?>(?!\s*<\/script>)[\s\S]*?<\/script>/.test(entryDocument)) {
  throw new Error("Desktop Web entry contains executable inline script.");
}
const applicationModuleOffset = entryDocument.search(/<script\s+type="module"/);
if (
  applicationModuleOffset < 0 ||
  (appearanceBootstrapMatch.index ?? Number.POSITIVE_INFINITY) > applicationModuleOffset
) {
  throw new Error("Appearance bootstrap must execute before the desktop startup reveal module.");
}

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
