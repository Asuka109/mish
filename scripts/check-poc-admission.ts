import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Isolated, read-only POC admission. The production workspace and graph never
 * import these files; this command is the only final gate allowed to inspect
 * the POC manifests for replay evidence.
 */
const root = resolve(import.meta.dirname, "..");
const required = [
  "poc/package.json",
  "poc/pnpm-lock.yaml",
  "poc/pnpm-workspace.yaml",
  "poc/rn/scripts/check-admission.ts",
  "poc/rn/scripts/replay-transcript.ts",
];
for (const relative of required) {
  if (!existsSync(resolve(root, relative)))
    throw new Error(`POC admission input is missing: ${relative}`);
  readFileSync(resolve(root, relative), "utf8");
}
const manifest = JSON.parse(readFileSync(resolve(root, "poc/package.json"), "utf8")) as {
  private?: boolean;
  scripts?: Record<string, string>;
};
if (manifest.private !== true) throw new Error("POC admission requires a private manifest");
console.log("POC_ADMISSION_OK isolated=read-only production-edge=none");
