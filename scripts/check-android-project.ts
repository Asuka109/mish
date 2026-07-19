import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");

function source(path: string) {
  return readFileSync(resolve(root, path), "utf8");
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const gradle = source("apps/mobile/src-tauri/gen/android/app/build.gradle.kts");
const manifest = source("apps/mobile/src-tauri/gen/android/app/src/main/AndroidManifest.xml");
const mobilePackage = JSON.parse(source("apps/mobile/package.json")) as {
  scripts?: Record<string, string>;
};
const tauri = source("apps/mobile/src-tauri/tauri.conf.json");

for (const setting of [
  'buildToolsVersion = "36.1.0"',
  "compileSdk = 36",
  'ndkVersion = "29.0.14206865"',
  "targetSdk = 36",
]) {
  invariant(gradle.includes(setting), `Android project is missing the pinned setting: ${setting}`);
}

invariant(
  mobilePackage.scripts?.["android:build"] ===
    "pnpm android:configure && tauri android build --debug --target aarch64 x86_64 --split-per-abi",
  "Android debug builds must remain split and limited to ARM64 and x86_64.",
);
invariant(
  mobilePackage.scripts?.["android:init"] ===
    "tauri android init --ci --skip-targets-install && pnpm android:configure",
  "Android initialization must preserve the minimal Rust target set and reapply pinned versions.",
);
invariant(
  manifest.match(/<uses-permission\b/gu)?.length === 1 &&
    manifest.includes("android.permission.INTERNET"),
  "The Phase 0 Manifest may request only INTERNET.",
);
invariant(
  !manifest.includes("android.permission.BIND_VPN_SERVICE") && !manifest.includes("<service"),
  "The typed fixture must not declare a VPN service.",
);
invariant(
  !tauri.includes("ws://127.0.0.1") && !tauri.includes("runtime_bootstrap"),
  "The mobile shell must not contain the desktop loopback bridge bootstrap.",
);

console.log(
  "Android project valid: API 36, Build Tools 36.1.0, NDK 29, two debug ABIs, and no VPN claim.",
);
