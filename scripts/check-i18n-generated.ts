import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const generatedFiles = [
  "apps/web/src/i18n/i18n-react.tsx",
  "apps/web/src/i18n/i18n-types.ts",
  "apps/web/src/i18n/i18n-util.async.ts",
  "apps/web/src/i18n/i18n-util.sync.ts",
  "apps/web/src/i18n/i18n-util.ts",
] as const;

function readGeneratedFiles() {
  return new Map(
    generatedFiles.map((path) => [path, readFileSync(`${root}/${path}`, "utf8")] as const),
  );
}

const before = readGeneratedFiles();
const generation = spawnSync("pnpm", ["--filter", "@mihomo/web", "i18n:generate"], {
  cwd: root,
  stdio: "inherit",
});

if (generation.status !== 0) process.exit(generation.status ?? 1);

const changedFiles = generatedFiles.filter(
  (path) => before.get(path) !== readFileSync(`${root}/${path}`, "utf8"),
);

if (changedFiles.length > 0) {
  throw new Error(
    `Generated i18n files were stale:\n${changedFiles.map((path) => `- ${path}`).join("\n")}`,
  );
}

console.log(`Generated i18n contract valid: ${generatedFiles.length} files are current.`);
