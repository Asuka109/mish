import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";

const paths = [
  "packages/contracts/src/generated/bridge-protocol.ts",
  "crates/desktop-bridge/src/generated/bridge_protocol.rs",
] as const;
const before = new Map(paths.map((path) => [path, readFileSync(path, "utf8")]));
const generation = spawnSync("node", ["scripts/generate-bridge-protocol.ts"], {
  stdio: "inherit",
});
if (generation.status !== 0) process.exit(generation.status ?? 1);
const stale = paths.filter((path) => before.get(path) !== readFileSync(path, "utf8"));
if (stale.length > 0) {
  throw new Error(
    `Generated bridge protocol bindings were stale:\n${stale.map((path) => `- ${path}`).join("\n")}`,
  );
}
console.log(`Generated bridge protocol contract valid: ${paths.length} bindings are current.`);
