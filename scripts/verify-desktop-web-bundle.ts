import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const assetsDirectory = fileURLToPath(new URL("../apps/web/dist/assets/", import.meta.url));
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

console.log("Desktop Web bundle excludes mobile navigation modules and styles.");
