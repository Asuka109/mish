import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (relativePath: string): string => readFileSync(`${root}/${relativePath}`, "utf8");

const required = [
  "index.ts",
  "src/App.tsx",
  "src/capabilities.ts",
  "src/native.ts",
  "src/transcript.ts",
  "src/xstate.ts",
  "metro.config.cjs",
  "babel.config.cjs",
  "android/settings.gradle",
  "android/app/build.gradle",
  "android/app/src/main/AndroidManifest.xml",
  "android/app/src/main/java/com/mish/rnadmission/RnAdmissionModule.kt",
];

for (const relativePath of required) {
  read(relativePath);
}

const source = [
  read("src/App.tsx"),
  read("src/capabilities.ts"),
  read("src/native.ts"),
  read("src/xstate.ts"),
  read("android/app/src/main/AndroidManifest.xml"),
  read("android/app/src/main/java/com/mish/rnadmission/RnAdmissionModule.kt"),
].join("\n");

const denied = [
  /<uses-permission/i,
  /android\.permission\.(?:INTERNET|ACCESS_NETWORK_STATE|CHANGE_NETWORK_STATE)/i,
  /VpnService|ParcelFileDescriptor|ConnectivityManager/i,
  /java\.net\.(?:Socket|ServerSocket)|java\.io\.|ProcessBuilder|Runtime\.getRuntime/i,
  /fetch\(|XMLHttpRequest|WebView/i,
  /structuredClone\(|new TextEncoder\(|new MessagePort\(/,
];

for (const pattern of denied) {
  if (pattern.test(source)) {
    throw new Error(`RN admission deny check failed: ${pattern}`);
  }
}

if (!source.includes("TurboModule") || !source.includes("networkEffects")) {
  throw new Error("RN admission fixture is missing the native capability seam");
}

process.stdout.write("RN admission static checks passed\n");
