import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const gradlePath = resolve(
  import.meta.dirname,
  "../apps/mobile/src-tauri/gen/android/app/build.gradle.kts",
);
let gradle = readFileSync(gradlePath, "utf8");

function pinAndroidSetting(name: string, value: string) {
  const setting = new RegExp(`^(\\s*)${name}\\s*=.*$`, "mu");
  if (setting.test(gradle)) {
    gradle = gradle.replace(setting, `$1${name} = ${value}`);
    return;
  }

  gradle = gradle.replace("android {\n", `android {\n    ${name} = ${value}\n`);
}

pinAndroidSetting("buildToolsVersion", '"36.1.0"');
pinAndroidSetting("compileSdk", "36");
pinAndroidSetting("ndkVersion", '"29.0.14206865"');
pinAndroidSetting("targetSdk", "36");

gradle = gradle.replace(/^\s*jniLibs\.keepDebugSymbols\.add\([^\n]+\)\n/gmu, "");
gradle = gradle.replace(
  /(^\s*packaging \{\n)/mu,
  '$1                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")\n' +
    '                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")\n',
);

writeFileSync(gradlePath, gradle);
console.log("Pinned Android API 36, Build Tools 36.1.0, NDK 29, ARM64, and x86_64.");
