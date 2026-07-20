import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const androidProject = resolve(repositoryRoot, "apps/mobile/src-tauri/gen/android");
const mobileManifest = resolve(repositoryRoot, "apps/mobile/src-tauri/Cargo.toml");
const result = spawnSync(
  "cargo",
  ["check", "--manifest-path", mobileManifest, "--target", "aarch64-linux-android"],
  {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      TAURI_ANDROID_PACKAGE_NAME: "com.asuka109.mish",
      TAURI_ANDROID_PACKAGE_UNESCAPED: "com.asuka109.mish",
      TAURI_ANDROID_PROJECT_PATH: androidProject,
    },
    stdio: "inherit",
  },
);

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
console.log("Prepared generated Gradle settings for local Android plugin tests.");
