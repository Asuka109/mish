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
const rootGradle = source("apps/mobile/src-tauri/gen/android/build.gradle.kts");
const manifest = source("apps/mobile/src-tauri/gen/android/app/src/main/AndroidManifest.xml");
const pluginRoot = "apps/mobile/src-tauri/plugins/mish-vpn";
const pluginManifest = source(`${pluginRoot}/android/src/main/AndroidManifest.xml`);
const pluginBuild = source(`${pluginRoot}/build.rs`);
const pluginGradle = source(`${pluginRoot}/android/build.gradle.kts`);
const pluginNativeBuild = source(`${pluginRoot}/android/src/main/cpp/Android.mk`);
const pluginNativeBridge = source(`${pluginRoot}/android/src/main/cpp/mish_vpn_jni.c`);
const mobileCoreWrapper = source("mobile-core/wrapper/runtime.go");
const mobileCoreHeader = source("mobile-core/abi/mish_mobile_core.h");
const pluginPermission = source(`${pluginRoot}/permissions/default.toml`);
const pluginRustModels = source(`${pluginRoot}/src/models.rs`);
const pluginRustLifecycle = source(`${pluginRoot}/src/lifecycle.rs`);
const pluginRustAndroid = source(`${pluginRoot}/src/android.rs`);
const mobileVpnClient = source("apps/web/src/platform/mobile-vpn-client.ts");
const mobileCoreStage = source("scripts/stage-mobile-core-android.ts");
const mobileIgnore = source("apps/mobile/src-tauri/.gitignore");
const mobilePackage = JSON.parse(source("apps/mobile/package.json")) as {
  scripts?: Record<string, string>;
};
const mobilePermission = source("apps/mobile/src-tauri/permissions/mobile_fixture_bootstrap.toml");
const mobileCapability = source("apps/mobile/src-tauri/capabilities/mobile.json");
const mobileSettingsCapability = source(
  "apps/mobile/src-tauri/capabilities/mobile-settings-android.json",
);
const mobileSettingsPermission = source("apps/mobile/src-tauri/permissions/mobile_settings.toml");
const mobileRust = source("apps/mobile/src-tauri/src/lib.rs");
const settingsRust = source("crates/settings/src/lib.rs");
const tauri = source("apps/mobile/src-tauri/tauri.conf.json");
const kotlinRoot = resolve(root, pluginRoot, "android/src/main/java/com/asuka109/mish/vpn");
const kotlin = readdirSync(kotlinRoot)
  .filter((path) => path.endsWith(".kt"))
  .map((path) => readFileSync(resolve(kotlinRoot, path), "utf8"))
  .join("\n");

function numericConstant(sourceText: string, pattern: RegExp, name: string): number {
  const match = sourceText.match(pattern);
  invariant(match?.[1], `Missing numeric constant: ${name}`);
  return Number(match[1].replaceAll("_", ""));
}

const mobileCoreMaxConfigBytes = numericConstant(
  mobileCoreHeader,
  /MISH_CORE_MAX_CONFIG_BYTES_V1\s+(\d+)u/u,
  "Mobile Core ABI configuration limit",
);
for (const [sourceText, pattern, name] of [
  [
    mobileVpnClient,
    /MOBILE_CORE_MAX_CONFIG_BYTES_V1\s*=\s*([\d_]+)/u,
    "TypeScript configuration limit",
  ],
  [
    pluginRustModels,
    /MOBILE_CORE_MAX_CONFIG_BYTES_V1:\s*usize\s*=\s*([\d_]+)/u,
    "Rust configuration limit",
  ],
  [kotlin, /MOBILE_CORE_MAX_CONFIG_BYTES_V1\s*=\s*([\d_]+)/u, "Kotlin configuration limit"],
] as const) {
  invariant(
    numericConstant(sourceText, pattern, name) === mobileCoreMaxConfigBytes,
    `${name} must match MISH_CORE_MAX_CONFIG_BYTES_V1.`,
  );
}

for (const setting of [
  'buildToolsVersion = "36.1.0"',
  "compileSdk = 36",
  'ndkVersion = "29.0.14206865"',
  "targetSdk = 36",
]) {
  invariant(gradle.includes(setting), `Android project is missing the pinned setting: ${setting}`);
}
invariant(
  rootGradle.includes('plugins.withId("com.android.library")') &&
    rootGradle.includes('buildToolsVersion = "36.1.0"'),
  "All generated Android library modules must use the retained Build Tools version.",
);
invariant(
  pluginGradle.includes('buildToolsVersion = "36.1.0"') &&
    pluginGradle.includes("compileSdk = 36") &&
    pluginGradle.includes("minSdk = 28") &&
    pluginGradle.includes('ndkVersion = "29.0.14206865"') &&
    pluginGradle.includes("externalNativeBuild"),
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
  mobilePackage.scripts?.["android:test"]?.includes("android:prepare-plugin-tests") &&
    mobilePackage.scripts?.["android:test"]?.includes(":tauri-plugin-mish-vpn:testDebugUnitTest"),
  "The Kotlin lifecycle state-machine tests must remain directly runnable.",
);
invariant(
  mobilePackage.scripts?.tauri === "tauri",
  "Nested Gradle Rust tasks must be able to re-enter the package-local Tauri CLI.",
);
invariant(
  source("package.json").includes('"mobile-core:stage:android"'),
  "The verified Mobile Core Android staging command must remain registered.",
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
  "android.permission.ACCESS_NETWORK_STATE",
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
  "class MishVpnPlatformStore",
  "PlatformRecoveryEvidence",
  "activationStarting",
  "serviceDestroyed",
  'System.loadLibrary("mish_vpn_jni")',
  "class MishMobileCoreProbe",
  "class MobileConfigValidationCoordinator",
  "class MobileConfigLoadCoordinator",
  "nativeValidateConfig",
  "nativeLoadConfig",
  "nativeInspectLoadedConfig",
  "nativeStartCore",
  "nativeStopCore",
  "nativeInspectRuntime",
  "MOBILE_CORE_MAX_CONFIG_BYTES_V1",
  "getPlatformFacts",
  "startPlatformLifecycle",
  'trigger("facts"',
]) {
  invariant(
    kotlin.includes(requirement),
    `Android VPN lifecycle source is missing: ${requirement}`,
  );
}
for (const forbidden of [
  "class MishVpnStateMachine",
  "enum class VpnPhase",
  "data class MobileVpnSnapshot",
  "Failed to persist the authoritative Android VPN lifecycle snapshot",
]) {
  invariant(
    !kotlin.includes(forbidden),
    `Kotlin must remain a platform facts/effects adapter, not product authority: ${forbidden}`,
  );
}
invariant(
  kotlin.includes(".remove(LEGACY_PRODUCT_SNAPSHOT)") && !kotlin.includes("putString(SNAPSHOT"),
  "The unreleased Kotlin product snapshot must be deleted rather than migrated or rewritten.",
);
for (const requirement of [
  "pub(crate) struct LifecycleMachine",
  "impl Machine for LifecycleMachine",
  "LifecycleOperationOutcome",
  "machine_authority",
  "scope_epoch",
  "admitted_revision",
  "LifecycleFailure",
  "PlatformRecoveryEvidence",
]) {
  invariant(
    pluginRustLifecycle.includes(requirement),
    `Shared Rust lifecycle authority is missing: ${requirement}`,
  );
}
invariant(
  pluginRustAndroid.includes('emit("mish-vpn://snapshot"') &&
    pluginRustAndroid.includes('event: "facts"') &&
    mobileVpnClient.includes('listen("mish-vpn://snapshot"') &&
    mobileCapability.includes('"core:event:allow-listen"') &&
    mobileCapability.includes('"core:event:allow-unlisten"') &&
    mobileVpnClient.includes("acceptBaseline") &&
    mobileVpnClient.includes("retiredAuthorityIds"),
  "Rust-to-React delivery must require a complete baseline and authority/session ordering.",
);
for (const requirement of [
  "class MishVpnService : VpnService()",
  "ParcelFileDescriptor",
  ".establish()",
  '.addRoute("0.0.0.0", 0)',
  '.addRoute("::", 0)',
  ".addDnsServer(TUN_IPV4_DNS)",
  "setUnderlyingNetworks(networks)",
  "fun protectSocket(fileDescriptor: Int)",
  "core.start(",
  "request.lifecycleAuthority",
  "core.stop(authority, session)",
  "MishVpnOwnedResourceCleanup",
  "ProtectedSocketFactGate",
  "PUBLIC_PROBE_URL",
]) {
  invariant(
    kotlin.includes(requirement),
    `The Android VPN vertical slice is missing: ${requirement}`,
  );
}
for (const [authorityField, goField] of [
  ["machineAuthority", "MachineAuthority"],
  ["scopeEpoch", "ScopeEpoch"],
  ["operationId", "OperationID"],
  ["admittedRevision", "AdmittedRevision"],
  ["effectIdentity", "EffectIdentity"],
]) {
  const snakeField = authorityField.replace(/[A-Z]/gu, (letter) => `_${letter.toLowerCase()}`);
  invariant(
    pluginRustAndroid.includes(snakeField) &&
      kotlin.includes(authorityField) &&
      pluginNativeBridge.includes(snakeField) &&
      mobileCoreWrapper.includes(goField),
    `Core lifecycle authority must cross Rust, Kotlin, JNI, and Mobile Core: ${authorityField}`,
  );
}
for (const forbidden of ["libmihomo", "MihomoCore", "externalController", "external-controller"]) {
  invariant(
    !kotlin.includes(forbidden),
    `Android must not expose an unbounded Core path: ${forbidden}`,
  );
}
for (const requirement of [
  "LOCAL_MODULE := mish_vpn_jni",
  "MISH_REPOSITORY_ROOT",
  "mobile-core/abi",
]) {
  invariant(
    pluginNativeBuild.includes(requirement) || pluginGradle.includes(requirement),
    `Android JNI build boundary is missing: ${requirement}`,
  );
}
for (const requirement of [
  'dlopen("libmish_mobile_core.so"',
  "mish_core_abi_version_v1",
  "mish_core_initialize_v1",
  "mish_core_validate_config_v1",
  "mish_core_load_config_v1",
  "mish_core_start_v1",
  "mish_core_stop_v1",
  "mish_core_snapshot_v1",
  "mish_core_version_v1",
  "mish_core_free_buffer_v1",
  "mish_vpn_validate_config",
  "mish_vpn_load_config",
  "mish_vpn_inspect_loaded_config",
  "mish_vpn_start_core",
  "mish_vpn_stop_core",
  "mish_vpn_inspect_runtime",
  "protect_socket_with_service",
  "MISH_CORE_MAX_RESPONSE_BYTES_V1",
]) {
  invariant(
    pluginNativeBridge.includes(requirement),
    `Android Mobile Core probe is missing: ${requirement}`,
  );
}
invariant(
  !pluginNativeBridge.includes("mish_core_command_v1"),
  "Android JNI must not resolve the unbounded Mobile Core command symbol.",
);
for (const requirement of [
  "SHA256SUMS",
  "--evidence-dir",
  "verify-mobile-core.ts",
  "readUInt16LE(18)",
  "libmish_mobile_core.so",
  "apps/mobile/src-tauri/gen/android/app/src/main/jniLibs",
]) {
  invariant(
    mobileCoreStage.includes(requirement),
    `Android Mobile Core staging verification is missing: ${requirement}`,
  );
}
for (const command of [
  "get_snapshot",
  "request_notification_permission",
  "request_vpn_consent",
  "start",
  "stop",
  "cancel_lifecycle_operation",
  "validate_config",
  "load_config",
  "cancel_config_load",
]) {
  invariant(pluginBuild.includes(`"${command}"`), `Typed VPN command is missing: ${command}`);
}
invariant(
  pluginPermission.includes('"allow-request-vpn-consent"') &&
    pluginPermission.includes('"allow-start"') &&
    pluginPermission.includes('"allow-validate-config"') &&
    pluginPermission.includes('"allow-load-config"') &&
    pluginPermission.includes('"allow-cancel-config-load"') &&
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
invariant(
  mobileSettingsCapability.includes('"platforms": ["android"]') &&
    mobileSettingsCapability.includes('"allow-mobile-settings-get-snapshot"') &&
    mobileSettingsCapability.includes('"allow-mobile-settings-set-appearance"') &&
    mobileSettingsCapability.includes('"allow-mobile-settings-set-language"') &&
    !mobileCapability.includes('"allow-mobile-settings-get-snapshot"') &&
    tauri.includes('"mobile-settings-android"'),
  "Android Settings permissions must remain Android-only rather than expanding the iOS mobile capability.",
);
for (const command of [
  "mobile_settings_get_snapshot",
  "mobile_settings_set_appearance",
  "mobile_settings_set_language",
]) {
  invariant(
    mobileSettingsPermission.includes(`commands.allow = ["${command}"]`) &&
      mobileRust.includes(command),
    `Android Settings command is missing its narrow local permission: ${command}`,
  );
}
invariant(
  mobileRust.includes("SettingsCapabilities::android()") &&
    mobileRust.includes("SettingsAdapterKind::Native") &&
    settingsRust.includes("pub fn android() -> Self"),
  "Android Settings must compose Shared Rust capability and snapshot authority.",
);

console.log(
  "Android project valid: API 36, Shared Rust-authoritative VPN and Settings state, Kotlin foreground VpnService/TUN/Core effects, bounded Mobile Core validation/load/runtime bridge, Android-only Settings permissions, dual ABI staging, predictive back, and no generated TV/FileProvider residue.",
);
