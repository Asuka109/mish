import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const paths = [
  "packages/contracts/src/generated/android-platform-facts.ts",
  "apps/mobile/src-tauri/plugins/mish-vpn/src/generated/platform_facts.rs",
  "apps/mobile/src-tauri/plugins/mish-vpn/android/src/main/java/com/asuka109/mish/vpn/AndroidPlatformFactsContract.kt",
] as const;
const before = new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));
const generation = spawnSync("node", ["scripts/generate-android-platform-facts.ts"], {
  stdio: "inherit",
});
if (generation.status !== 0) process.exit(generation.status ?? 1);
const stale = paths.filter((path) => before.get(path) !== readFileSync(path, "utf8"));
if (stale.length > 0) {
  throw new Error(
    `Generated Android platform-facts bindings were stale:\n${stale.map((path) => `- ${path}`).join("\n")}`,
  );
}
console.log(
  `Generated Android platform-facts contract valid: ${paths.length} bindings are current.`,
);
