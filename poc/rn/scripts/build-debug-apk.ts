import { existsSync, readFileSync } from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const android = `${root}/android`;
const gradle = `${android}/gradlew`;

if (!existsSync(gradle)) throw new Error("Gradle wrapper is missing");

const result = spawnSync(gradle, [":app:assembleDebug", "--no-daemon", "--stacktrace"], {
  cwd: android,
  env: { ...process.env, CI: "true" },
  stdio: "inherit",
});
if (result.status !== 0) process.exit(result.status ?? 1);

const apk = `${android}/app/build/outputs/apk/debug/app-debug.apk`;
if (!existsSync(apk)) throw new Error("Debug APK was not produced");

const listing = execFileSync("unzip", ["-Z1", apk], { encoding: "utf8" });
for (const abi of ["arm64-v8a", "x86_64"]) {
  if (!listing.includes(`lib/${abi}/`)) {
    throw new Error(`Debug APK is missing required ABI ${abi}`);
  }
}

const buildProperties = readFileSync(`${android}/app/build.gradle`, "utf8");
if (!buildProperties.includes("arm64-v8a,x86_64")) {
  throw new Error("Dual ABI policy is not visible in the app build");
}
process.stdout.write(`RN dual-ABI debug APK: ${apk}\n`);
