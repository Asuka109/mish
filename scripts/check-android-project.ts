import { existsSync, readFileSync, readdirSync } from "node:fs";
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
const pluginRoot = "apps/mobile/src-tauri/plugins/mish-vpn";
const pluginManifest = source(`${pluginRoot}/android/src/main/AndroidManifest.xml`);
const pluginBuild = source(`${pluginRoot}/build.rs`);
const pluginGradle = source(`${pluginRoot}/android/build.gradle.kts`);
const pluginPermission = source(`${pluginRoot}/permissions/default.toml`);
const mobileIgnore = source("apps/mobile/src-tauri/.gitignore");
const mobilePackage = JSON.parse(source("apps/mobile/package.json")) as {
  scripts?: Record<string, string>;
};
const mobilePermission = source("apps/mobile/src-tauri/permissions/mobile_fixture_bootstrap.toml");
const mobileRust = source("apps/mobile/src-tauri/src/lib.rs");
const tauri = source("apps/mobile/src-tauri/tauri.conf.json");
const kotlinRoot = resolve(root, pluginRoot, "android/src/main/java/com/asuka109/mish/vpn");
const kotlin = readdirSync(kotlinRoot)
  .filter((path) => path.endsWith(".kt"))
  .map((path) => readFileSync(resolve(kotlinRoot, path), "utf8"))
  .join("\n");

for (const setting of [
  'buildToolsVersion = "36.1.0"',
  "compileSdk = 36",
  'ndkVersion = "29.0.14206865"',
  "targetSdk = 36",
]) {
  invariant(gradle.includes(setting), `Android project is missing the pinned setting: ${setting}`);
}
invariant(
  pluginGradle.includes('buildToolsVersion = "36.1.0"') &&
    pluginGradle.includes("compileSdk = 36") &&
    pluginGradle.includes("minSdk = 28"),
  "The Android VPN plugin must share the pinned app SDK and Build Tools baseline.",
);

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
  mobilePackage.scripts?.["android:test"]?.includes(":tauri-plugin-mish-vpn:testDebugUnitTest"),
  "The Kotlin lifecycle state-machine tests must remain directly runnable.",
);
invariant(
  manifest.match(/<uses-permission\b/gu)?.length === 1 &&
    manifest.includes("android.permission.INTERNET"),
  "The generated application Manifest may request only INTERNET; VPN permissions belong to the plugin.",
);
invariant(
  manifest.includes('android:enableOnBackInvokedCallback="true"') &&
    !manifest.includes('android:enableOnBackInvokedCallback="false"'),
  "Android 16 predictive back must remain enabled without a compatibility opt-out.",
);
invariant(
  !manifest.includes("LEANBACK_LAUNCHER") &&
    !manifest.includes("android.software.leanback") &&
    !manifest.includes("FileProvider") &&
    !manifest.includes("FILE_PROVIDER_PATHS") &&
    !existsSync(
      resolve(root, "apps/mobile/src-tauri/gen/android/app/src/main/res/xml/file_paths.xml"),
    ),
  "Generated TV launcher and broad FileProvider path-policy residue must stay removed.",
);
for (const requirement of [
  "android.permission.FOREGROUND_SERVICE",
  "android.permission.FOREGROUND_SERVICE_SYSTEM_EXEMPTED",
  "android.permission.POST_NOTIFICATIONS",
  'android:foregroundServiceType="systemExempted"',
  'android:permission="android.permission.BIND_VPN_SERVICE"',
  '<action android:name="android.net.VpnService"',
  'android:name="android.net.VpnService.SUPPORTS_ALWAYS_ON"',
  'android:value="false"',
]) {
  invariant(
    pluginManifest.includes(requirement),
    `Android VPN plugin Manifest is missing: ${requirement}`,
  );
}
invariant(
  pluginManifest.match(/<service\b/gu)?.length === 1,
  "Phase 0 must declare exactly one protected Android VpnService.",
);
for (const requirement of [
  "class MishVpnService : VpnService()",
  "VpnService.prepare(activity)",
  "ContextCompat.startForegroundService",
  "FOREGROUND_SERVICE_TYPE_SYSTEM_EXEMPTED",
  "NotificationChannel(",
  "Executors.newSingleThreadExecutor",
  "class FixtureVpnBackend",
  "recoverAfterProcessStart",
  'trigger("snapshot"',
]) {
  invariant(
    kotlin.includes(requirement),
    `Android VPN lifecycle source is missing: ${requirement}`,
  );
}
for (const forbidden of [
  ".establish(",
  "ParcelFileDescriptor",
  "System.loadLibrary",
  "libmihomo",
  "MihomoCore",
]) {
  invariant(
    !kotlin.includes(forbidden),
    `The Phase 0 fixture must not implement a TUN or Core boundary: ${forbidden}`,
  );
}
for (const command of [
  "get_snapshot",
  "request_notification_permission",
  "request_vpn_consent",
  "start_fixture_lifecycle",
  "stop",
]) {
  invariant(pluginBuild.includes(`"${command}"`), `Typed VPN command is missing: ${command}`);
}
invariant(
  pluginPermission.includes('"allow-request-vpn-consent"') &&
    pluginPermission.includes('"allow-start-fixture-lifecycle"') &&
    mobileRust.includes("tauri_plugin_mish_vpn::init()"),
  "The bounded Mish VPN plugin and permissions must remain registered.",
);
invariant(
  !tauri.includes("ws://127.0.0.1") && !tauri.includes("runtime_bootstrap"),
  "The mobile shell must not contain the desktop loopback bridge bootstrap.",
);
invariant(
  mobileIgnore.includes("/gen/schemas/") && mobileIgnore.includes("/permissions/autogenerated/"),
  "Host-generated Tauri schemas and permissions must remain untracked.",
);
invariant(
  mobilePermission.includes('identifier = "allow-mobile-fixture-bootstrap"') &&
    mobilePermission.includes('commands.allow = ["mobile_fixture_bootstrap"]'),
  "The mobile fixture command must keep a stable, repository-owned permission.",
);

console.log(
  "Android project valid: API 36, protected Phase 0 VpnService, honest fixture backend, predictive back, and no generated TV/FileProvider residue.",
);
