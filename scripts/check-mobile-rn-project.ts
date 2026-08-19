import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const appRoot = resolve(root, "apps/mobile-rn");

function source(relativePath: string): string {
  return readFileSync(resolve(appRoot, relativePath), "utf8");
}

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const requiredFiles = [
  "package.json",
  "android/settings.gradle",
  "android/build.gradle",
  "android/gradle.properties",
  "android/app/build.gradle",
  "android/app/src/main/AndroidManifest.xml",
  "react-native.config.js",
  "android/app/src/main/java/com/asuka109/mish/rn/MainActivity.kt",
  "android/app/src/main/java/com/asuka109/mish/rn/MainApplication.kt",
  "android/app/src/main/java/com/asuka109/mish/rn/MishCapabilityModule.kt",
  "android/app/src/main/java/com/asuka109/mish/rn/MishCapabilityPackage.kt",
  "android/app/src/main/java/com/asuka109/mish/rn/MishCapabilityContract.kt",
  "src/native/NativeMishCapability.ts",
  "src/native/capability-client.ts",
  "src/App.tsx",
] as const;

for (const relativePath of requiredFiles) {
  const path = resolve(appRoot, relativePath);
  invariant(statSync(path).isFile(), `React Native foundation is missing ${relativePath}.`);
}

const packageJson = JSON.parse(source("package.json")) as {
  name?: string;
  dependencies?: Record<string, string>;
  codegenConfig?: {
    name?: string;
    type?: string;
    jsSrcsDir?: string;
    android?: { javaPackageName?: string };
  };
  scripts?: Record<string, string>;
};
invariant(packageJson.name === "@mish/mobile-rn", "React Native package identity drifted.");
for (const dependency of ["react", "react-native", "@mish/contracts", "@mish/design-tokens"]) {
  invariant(
    packageJson.dependencies?.[dependency],
    `React Native package is missing ${dependency}.`,
  );
}
invariant(
  packageJson.codegenConfig?.name === "MishCapabilitySpec" &&
    packageJson.codegenConfig.type === "modules" &&
    packageJson.codegenConfig.jsSrcsDir === "src/native" &&
    packageJson.codegenConfig.android?.javaPackageName === "com.asuka109.mish.rn",
  "TurboModule codegen configuration is incomplete or drifted.",
);
for (const script of [
  "android:build",
  "android:codegen",
  "android:test",
  "android:inspect",
  "test:run",
  "typecheck",
]) {
  invariant(packageJson.scripts?.[script], `React Native package is missing ${script}.`);
}

const gradleProperties = source("android/gradle.properties");
for (const required of [
  "newArchEnabled=true",
  "hermesEnabled=true",
  "reactNativeArchitectures=arm64-v8a,x86_64",
]) {
  invariant(gradleProperties.includes(required), `RN Android project is missing ${required}.`);
}

const appGradle = source("android/app/build.gradle");
for (const required of [
  'applicationId "com.asuka109.mish.rn"',
  'include "arm64-v8a", "x86_64"',
  "universalApk false",
  "signingConfig signingConfigs.mishFixtureDebug",
  'storePassword "mish-fixture-debug-v1"',
  'keyAlias "mish-fixture-debug"',
  "debuggableVariants = []",
]) {
  invariant(appGradle.includes(required), `RN Android build is missing ${required}.`);
}
const releaseStart = appGradle.indexOf("release {");
const releaseBody = releaseStart >= 0 ? appGradle.slice(releaseStart) : "";
invariant(
  releaseStart >= 0 &&
    !releaseBody.includes("mishFixtureDebug") &&
    !releaseBody.includes("mish-fixture-debug"),
  "The RN release build must not use the synthetic debug signer.",
);

const manifest = source("android/app/src/main/AndroidManifest.xml");
const permissions = [...manifest.matchAll(/<uses-permission\s+android:name="([^"]+)"\s*\/>/gu)].map(
  (match) => match[1],
);
invariant(
  JSON.stringify(permissions) === JSON.stringify(["android.permission.INTERNET"]),
  "The RN foundation manifest must request only INTERNET; native VPN permissions are out of scope.",
);
for (const forbidden of [
  "BIND_VPN_SERVICE",
  "FOREGROUND_SERVICE",
  "VpnService",
  "android.net.VpnService",
]) {
  invariant(
    !manifest.includes(forbidden),
    `RN foundation manifest contains forbidden ${forbidden}.`,
  );
}

const nativeSources = [
  source("android/app/src/main/java/com/asuka109/mish/rn/MishCapabilityModule.kt"),
  source("android/app/src/main/java/com/asuka109/mish/rn/MishCapabilityContract.kt"),
];
const nativeText = nativeSources.join("\n");
for (const required of [
  "NativeMishCapabilitySpec",
  "Native platform effects are unavailable",
  "MAX_TRANSCRIPT_EVENTS",
  "ResultKind.INVALID_INPUT",
  "ResultKind.UNAVAILABLE",
]) {
  invariant(nativeText.includes(required), `RN capability seam is missing ${required}.`);
}
for (const forbidden of [
  "VpnService",
  "startForeground",
  "protect(",
  "startService",
  "DatagramSocket",
  "Socket(",
]) {
  invariant(
    !nativeText.includes(forbidden),
    `RN capability seam contains forbidden effect ${forbidden}.`,
  );
}

const appSource = source("src/App.tsx");
for (const required of [
  "Home",
  "Routes",
  "Profiles",
  "Activity",
  "Settings",
  'accessibilityRole="tab"',
  "mishNativeTokens",
  "capabilityClient",
]) {
  invariant(appSource.includes(required), `RN UI shell is missing ${required}.`);
}

const signer = resolve(appRoot, "android/app/signing/mish-fixture-debug.keystore");
const existingSigner = resolve(
  root,
  "apps/mobile/src-tauri/gen/android/app/signing/mish-fixture-debug.keystore",
);
invariant(
  readFileSync(signer).equals(readFileSync(existingSigner)),
  "RN debug signer must reuse the reviewed synthetic signer.",
);

const generatedPaths = readdirSync(resolve(appRoot, "android/app/src/main"), {
  recursive: true,
}).filter((entry) => String(entry).includes("generated"));
invariant(
  generatedPaths.length === 0,
  "Generated TurboModule sources must remain build outputs, not checked-in inputs.",
);

console.log(
  "React Native Android foundation contract valid: New Architecture, closed capability seam, five-tab accessible shell, dual ABI debug split, and credential-free signer boundary are intact.",
);

if (import.meta.main) {
  try {
    // The function executes during module evaluation so CI can run this file directly.
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "React Native foundation check failed.");
    process.exitCode = 1;
  }
}
