import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const read = (relativePath: string): string => readFileSync(`${root}/${relativePath}`, "utf8");

describe("React Native admission fixture boundaries", () => {
  it("uses public package entries and the real RN renderer adapter", () => {
    const app = read("src/App.tsx");
    const capabilities = read("src/capabilities.ts");
    const native = read("src/native.ts");
    expect(app).toContain('from "@mish/poc-query-store"');
    expect(app).toContain("useMishStore");
    expect(app).toContain("StrictMode");
    expect(native).toContain("TurboModuleRegistry.getEnforcing");
    expect(capabilities).toContain('from "@mish/poc-orpc"');
    expect(capabilities).toContain('from "@mish/poc-query-store"');
    expect(app).not.toContain("react-dom");

    const transformer = read("metro-babel-transformer.cjs");
    const smoke = read("scripts/smoke-emulator.ts");
    expect(transformer).toContain('require("@react-native/metro-babel-transformer")');
    expect(transformer).not.toContain("require.resolve");
    expect(transformer).not.toContain("@react-native/metro-config");
    expect(smoke).toContain("MISH_RN_TOTAL_TIMEOUT_MS");
    expect(smoke).toContain("totalDeadline");
    expect(smoke).toContain("timeout: Math.min(adbTimeoutMs, remaining)");
    expect(smoke).toContain('"-port"');
    expect(smoke).toContain("MISH_RN_EMULATOR_PORT");
    expect(smoke).toContain("ownedIdentity");
    expect(smoke).toContain("isOwnedEmulator");
    expect(smoke).toContain("process.kill(ownedIdentity.pid, 0)");
  });

  it("keeps host effects out of the fixture", () => {
    const sources = [
      read("src/App.tsx"),
      read("src/capabilities.ts"),
      read("src/native.ts"),
      read("android/app/src/main/AndroidManifest.xml"),
    ].join("\n");
    expect(sources).not.toMatch(/VpnService|ConnectivityManager|ParcelFileDescriptor|TUN/);
    expect(sources).not.toMatch(/fetch\(|XMLHttpRequest/);
    expect(sources).not.toMatch(/structuredClone\(|new TextEncoder\(|new MessagePort\(/);
    expect(sources).not.toContain("<uses-permission");
  });

  it("pins New Architecture and Hermes in the Android fixture", () => {
    const properties = read("android/gradle.properties");
    const build = read("android/app/build.gradle");
    const native = read("android/app/src/main/java/com/mish/rnadmission/RnAdmissionModule.kt");
    expect(properties).toContain("newArchEnabled=true");
    expect(properties).toContain("hermesEnabled=true");
    expect(build).toContain('"arm64-v8a,x86_64"');
    expect(native).toContain("TurboModule");
    expect(native).toContain("networkEffects");
  });
});
