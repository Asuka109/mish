import { createHash } from "node:crypto";
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
const androidSignerVerifier = source("scripts/verify-android-apk-signature.ts");
const rootGradle = source("apps/mobile/src-tauri/gen/android/build.gradle.kts");
const manifest = source("apps/mobile/src-tauri/gen/android/app/src/main/AndroidManifest.xml");
const pluginRoot = "apps/mobile/src-tauri/plugins/mish-vpn";
const pluginManifest = source(`${pluginRoot}/android/src/main/AndroidManifest.xml`);
const pluginService = source(
  `${pluginRoot}/android/src/main/java/com/asuka109/mish/vpn/MishVpnService.kt`,
);
const mobileCoreAdmission = source(
  `${pluginRoot}/android/src/main/java/com/asuka109/mish/vpn/MishMobileCoreAdmission.kt`,
);
const mobileCoreAdversarialTest = source(
  `${pluginRoot}/android/src/test/java/com/asuka109/mish/vpn/MobileCoreProvenanceAdversarialTest.kt`,
);
const mobileCoreProvenance = source(
  `${pluginRoot}/android/src/main/java/com/asuka109/mish/vpn/MobileCoreProvenance.kt`,
);
const mobileCoreProvenanceTest = source(
  `${pluginRoot}/android/src/test/java/com/asuka109/mish/vpn/MobileCoreProvenanceDiagnosticsTest.kt`,
);
const kotlinTestRoot = resolve(root, pluginRoot, "android/src/test");
const productionExclusionRoots = [
  ".github",
  "apps/mobile/src-tauri/src",
  `${pluginRoot}/src`,
  `${pluginRoot}/android/src/main`,
  "apps/web/src",
];
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
const mobileVpnClientTest = source("apps/web/src/platform/mobile-vpn-client.test.ts");
const mobileCoreStage = source("scripts/stage-mobile-core-android.ts");
const mobileCoreSourceManifest = JSON.parse(source("mobile-core/source-manifest.json")) as {
  schemaVersion: number;
  abiVersion: number;
  wrapperRevision: string;
  mihomo: { commit: string; version: string };
  android: {
    signing: {
      admissionSchemaVersion: number;
      policy: string;
      scheme: string;
      verification: string;
      signerSha256: string;
    };
  };
};
const mobileIgnore = source("apps/mobile/src-tauri/.gitignore");
const mobileAppIgnore = source("apps/mobile/src-tauri/gen/android/app/.gitignore");
const debugKeystorePath = resolve(
  root,
  "apps/mobile/src-tauri/gen/android/app/signing/mish-fixture-debug.keystore",
);
const debugCertificatePath = resolve(
  root,
  "apps/mobile/src-tauri/plugins/mish-vpn/android/src/test/resources/mish-fixture-debug.cer",
);
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

function collectTextFiles(directory: string): string {
  return readdirSync(resolve(root, directory), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => readFileSync(resolve(entry.parentPath, entry.name), "utf8"))
    .join("\n");
}

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
  existsSync(debugKeystorePath) && existsSync(debugCertificatePath),
  "The credential-free debug signer must provide its checked-in test-only keystore and public certificate fixture.",
);
invariant(
  gradle.includes('val mishFixtureDebugKeystore = file("signing/mish-fixture-debug.keystore")') &&
    gradle.includes('create("mishFixtureDebug")') &&
    gradle.includes('storeType = "JKS"') &&
    gradle.includes('signingConfig = signingConfigs.getByName("mishFixtureDebug")'),
  "Android debug builds must use the repository-owned synthetic signer authority.",
);
const releaseStart = gradle.indexOf('getByName("release")');
const releaseBody = releaseStart >= 0 ? gradle.slice(releaseStart) : "";
invariant(
  releaseStart >= 0 &&
    !releaseBody.includes("mishFixtureDebug") &&
    !releaseBody.includes("mish-fixture-debug.keystore"),
  "Release Android builds must not reference the synthetic debug signer.",
);
const debugCertificateSha256 = createHash("sha256")
  .update(readFileSync(debugCertificatePath))
  .digest("hex");
invariant(
  debugCertificateSha256 === mobileCoreSourceManifest.android.signing.signerSha256,
  "The source manifest signer pin must match the checked-in public debug certificate fixture.",
);
invariant(
  androidSignerVerifier.includes("parseApksignerVerification") &&
    androidSignerVerifier.includes("exactly one signer") &&
    androidSignerVerifier.includes("does not match the pinned Mobile Core signer"),
  "The Android package gate must parse and compare the actual APK signer before packaging effects.",
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
  mobilePackage.scripts?.["android:test:emulator"]?.includes("android:prepare-plugin-tests") &&
    mobilePackage.scripts?.["android:test:emulator"]?.includes(
      ":tauri-plugin-mish-vpn:connectedDebugAndroidTest",
    ),
  "The repository-owned Android emulator lifecycle acceptance must remain directly runnable.",
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
for (const requirement of [
  "MobileCoreProvenanceProjection",
  "MobileCoreProvenanceSnapshot",
  "NOT_EVALUATED",
  "NATIVE_IDENTITY",
  "AtomicReference",
]) {
  invariant(
    mobileCoreProvenance.includes(requirement),
    `Mobile Core D2.3 diagnostic projection is missing: ${requirement}`,
  );
}
for (const requirement of [
  "admitted decision publishes the exact bounded verified provenance",
  "unavailable and every closed rejection class remain bounded",
  "authority replacement starts a new bounded generation without history",
  "diagnostic JSON contains exact keys and no private payload shapes",
  "diagnostic rendering does not reobserve admission inputs",
]) {
  invariant(
    mobileCoreProvenanceTest.includes(requirement),
    `Mobile Core D2.3 diagnostic use case is missing: ${requirement}`,
  );
}
for (const requirement of [
  "MobileCoreAdmissionBoundaryEffect",
  "MobileCoreAdmissionBoundaryResult",
  "PROTECTED_USE_RECHECK",
  "MobileCoreAdmissionSource",
  "source.observeArtifact()",
  "MobileCoreAdmissionFailure.ARTIFACT_REPLACED",
]) {
  invariant(
    mobileCoreAdmission.includes(requirement),
    `Mobile Core admission must retain the D2.2 protected-use boundary: ${requirement}`,
  );
}
for (const requirement of [
  "manifest adversarial matrix fails closed before every runtime effect",
  "ABI and artifact adversarial matrix fails closed before every runtime effect",
  "signer adversarial matrix fails closed before every runtime effect",
  "occurrence bounded replacement at protected use boundary rejects before JNI and runtime effects",
  "closed boundary transcript is bounded and contains no private payload shape",
]) {
  invariant(
    mobileCoreAdversarialTest.includes(requirement),
    `Mobile Core D2.2 adversarial use case is missing: ${requirement}`,
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
  "core.admission()",
  "class MobileConfigValidationCoordinator",
  "class MobileConfigLoadCoordinator",
  "nativeValidateConfig",
  "nativeLoadConfig",
  "nativeInspectLoadedConfig",
  "nativeStartCore",
  "nativeStopCore",
  "nativeInspectRuntime",
  "class MobileCoreArtifactAdmission",
  "MobileCoreAdmissionPolicy",
  "MOBILE_CORE_ADMISSION_MANIFEST_ASSET",
  "MOBILE_CORE_ADMISSION_MAX_MANIFEST_BYTES",
  "MOBILE_CORE_ADMISSION_MAX_ARTIFACT_BYTES",
  "MOBILE_CORE_ADMISSION_MAX_SIGNATURE_BYTES",
  "GET_SIGNING_CERTIFICATES",
  "MobileCoreAdmissionFailure",
  "MobileCoreAdmissionInvocation",
  "MobileCoreEffectOperation",
  "ensureAdmitted()",
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
  "mish_core_command_v1",
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
for (const requirement of [
  "nativeRouteOperation",
  'static const char status_request[] = "{\\"kind\\":\\"status\\"}"',
  'static const char routes_request[] = "{\\"kind\\":\\"routes\\",\\"limit\\":512}"',
  "MishVpnCoreCommandFn",
  "core_api.command",
]) {
  invariant(
    pluginNativeBridge.includes(requirement),
    `Android JNI Route command boundary is missing: ${requirement}`,
  );
}
for (const requirement of [
  "SHA256SUMS",
  "--evidence-dir",
  "verify-mobile-core.ts",
  "writeAdmissionManifest",
  "mish-mobile-core-admission.json",
  "signatureScheme",
  "signatureVerification",
  "signerSha256",
  "readUInt16LE(18)",
  "libmish_mobile_core.so",
  "apps/mobile/src-tauri/gen/android/app/src/main/jniLibs",
]) {
  invariant(
    mobileCoreStage.includes(requirement),
    `Android Mobile Core staging verification is missing: ${requirement}`,
  );
}
invariant(
  mobileCoreSourceManifest.android.signing.admissionSchemaVersion === 2 &&
    mobileCoreSourceManifest.android.signing.policy === "synthetic-debug-v1" &&
    mobileCoreSourceManifest.android.signing.scheme === "android-package-signature-v1" &&
    mobileCoreSourceManifest.android.signing.verification === "package-signer" &&
    /^[a-f0-9]{64}$/u.test(mobileCoreSourceManifest.android.signing.signerSha256),
  "Android Mobile Core signer policy must be one bounded synthetic fingerprint.",
);
invariant(
  mobileCoreStage.includes(`signerSha256: sourceManifest.android.signing.signerSha256`),
  "Android staging must source the signer fingerprint from mobile-core/source-manifest.json.",
);
invariant(
  mobileCoreStage.includes("schemaVersion: sourceManifest.android.signing.admissionSchemaVersion"),
  "Android staging must source the admission schema version from the signer policy authority.",
);
invariant(
  mobileAppIgnore.includes("/src/main/assets/mish-mobile-core-admission.json"),
  "The generated Android admission manifest must remain ignored build input.",
);
const authorityPersistenceIndex = pluginService.indexOf("store.activationStarting(");
const admissionIndex = pluginService.indexOf("if (!core.admission().admitted)");
const foregroundIndex = pluginService.indexOf("promoteToForeground()");
invariant(
  authorityPersistenceIndex >= 0 &&
    admissionIndex > authorityPersistenceIndex &&
    foregroundIndex > admissionIndex,
  "Mobile Core admission must follow persisted lifecycle authority and precede foreground effects.",
);
for (const requirement of [
  `MOBILE_CORE_ADMISSION_SCHEMA_VERSION = ${mobileCoreSourceManifest.android.signing.admissionSchemaVersion}`,
  `MOBILE_CORE_ADMISSION_SIGNATURE_SCHEME = "${mobileCoreSourceManifest.android.signing.scheme}"`,
  `MOBILE_CORE_ADMISSION_SIGNATURE_VERIFICATION = "${mobileCoreSourceManifest.android.signing.verification}"`,
  `PINNED_SOURCE_COMMIT = "${mobileCoreSourceManifest.mihomo.commit}"`,
  `PINNED_SOURCE_VERSION = "${mobileCoreSourceManifest.mihomo.version}"`,
  `PINNED_WRAPPER_REVISION = "${mobileCoreSourceManifest.wrapperRevision}"`,
  `PINNED_ABI_VERSION = ${mobileCoreSourceManifest.abiVersion}`,
  `MOBILE_CORE_ADMISSION_EXPECTED_SIGNER_SHA256 =\n    \"${mobileCoreSourceManifest.android.signing.signerSha256}\"`,
]) {
  invariant(
    mobileCoreSourceManifest.schemaVersion === 1 && kotlin.includes(requirement),
    `Kotlin admission pins must match mobile-core/source-manifest.json: ${requirement}`,
  );
}
for (const command of [
  "get_snapshot",
  "get_core_provenance",
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
  pluginPermission.includes('"allow-get-core-provenance"') &&
    pluginPermission.includes('"allow-request-vpn-consent"') &&
    pluginPermission.includes('"allow-start"') &&
    pluginPermission.includes('"allow-validate-config"') &&
    pluginPermission.includes('"allow-load-config"') &&
    pluginPermission.includes('"allow-cancel-config-load"') &&
    mobileRust.includes("tauri_plugin_mish_vpn::init()"),
  "The bounded Mish VPN plugin and permissions must remain registered.",
);
invariant(
  mobileVpnClient.includes("MobileCoreProvenanceSnapshotSchema.parse") &&
    pluginRustModels.includes("deny_unknown_fields") &&
    pluginRustModels.includes("MobileCoreProvenanceSnapshot") &&
    pluginRustAndroid.includes('run_mobile_plugin_async("getCoreProvenance"'),
  "The D2.3 product DTO must cross only the strict mobile Kotlin/Rust/TypeScript boundary.",
);
invariant(
  pluginRustAndroid.includes("static MOBILE_ROUTE_CONFIG_GATE") &&
    pluginRustAndroid.includes("route_config_gate: Arc<Mutex<()>>") &&
    (pluginRustAndroid.match(/self\.route_config_gate\.lock\(\)\.await/g)?.length ?? 0) === 3,
  "Config load/publication and Route reads/effects must share one process-wide Rust gate.",
);
for (const forbidden of [
  "recentBoundaryInvocations",
  "MobileCoreAdmissionBoundaryInvocation",
  "nativeLibraryDir",
  "readManifest",
  "observeSignature",
]) {
  invariant(
    !pluginRustModels.includes(forbidden) && !mobileVpnClient.includes(forbidden),
    `D2.3 public DTO must exclude synthetic controls and raw admission inputs: ${forbidden}`,
  );
}
invariant(
  !pluginRustModels.split("#[cfg(test)]")[0].includes("certificateBytes") &&
    !mobileVpnClient.includes("certificateBytes:") &&
    mobileVpnClientTest.includes("certificateBytes: [1, 2]") &&
    mobileVpnClientTest.includes(").toBe(false)"),
  "Certificate bytes must appear only as rejected TypeScript test input, never as a public DTO field.",
);
const productionExclusionGraph = productionExclusionRoots.map(collectTextFiles).join("\n");
for (const testOnlyMarker of [
  "MutableAdmissionSource",
  "MobileCoreProvenanceDiagnosticsTest",
  "authority replacement starts a new bounded generation without history",
]) {
  invariant(
    !productionExclusionGraph.includes(testOnlyMarker),
    `D2.3 synthetic evidence leaked into a production-inappropriate graph: ${testOnlyMarker}`,
  );
}
invariant(
  existsSync(kotlinTestRoot) &&
    collectTextFiles(`${pluginRoot}/android/src/test`).includes(
      "MobileCoreProvenanceDiagnosticsTest",
    ),
  "D2.3 synthetic diagnostics controls must remain in the Android JVM test graph.",
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
