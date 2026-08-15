import { execFileSync } from "node:child_process";
import { accessSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";
import { verifyApkSignerPin } from "./verify-android-apk-signature.ts";

const root = resolve(import.meta.dirname, "..");
const MAX_TOOL_OUTPUT_BYTES = 128 * 1024;
const EXPECTED_PACKAGE = "com.asuka109.mish.rn";
const EXPECTED_ABIS = ["arm64-v8a", "x86_64"] as const;

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function boundedOutput(output: string): string {
  invariant(
    Buffer.byteLength(output, "utf8") <= MAX_TOOL_OUTPUT_BYTES,
    "APK inspection output exceeded the bounded limit.",
  );
  return output;
}

export function parsePackageName(output: string): string {
  const match = boundedOutput(output).match(/^package: name='([^']+)'/mu);
  invariant(match?.[1], "APK badging did not contain one package name.");
  invariant(
    !output.match(/^package: name='/gmu)?.slice(1).length,
    "APK badging contained multiple package names.",
  );
  return match[1];
}

export function parseManifestPermissions(output: string): string[] {
  return [...boundedOutput(output).matchAll(/^uses-permission: name='([^']+)'/gmu)].map(
    (match) => match[1],
  );
}

export function parseNativeAbis(zipListing: string): string[] {
  const abis = new Set<string>();
  for (const match of boundedOutput(zipListing).matchAll(/^lib\/([^/]+)\//gmu)) {
    abis.add(match[1]);
  }
  return [...abis].sort();
}

function parseArguments(argv: string[]): { directory: string; aapt2: string; apksigner: string } {
  let directory = "";
  let aapt2 = "";
  let apksigner = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--directory") directory = argv[++index] ?? "";
    else if (argument === "--aapt2") aapt2 = argv[++index] ?? "";
    else if (argument === "--apksigner") apksigner = argv[++index] ?? "";
    else throw new Error("Usage: pnpm android:inspect -- --directory <apk-directory>");
  }
  invariant(directory.length > 0, "--directory is required.");
  const sdkRoot =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    resolve(homedir(), "Library/Android/sdk");
  return {
    directory: resolve(directory),
    aapt2: resolve(aapt2 || sdkRoot, aapt2 ? "" : "build-tools/36.1.0/aapt2"),
    apksigner: resolve(apksigner || sdkRoot, apksigner ? "" : "build-tools/36.1.0/apksigner"),
  };
}

function inspect(directory: string, aapt2: string, apksigner: string): void {
  accessSync(directory);
  accessSync(aapt2);
  accessSync(apksigner);
  const apks = readdirSync(directory)
    .filter((entry) => entry.endsWith(".apk"))
    .map((entry) => resolve(directory, entry))
    .filter((path) => statSync(path).isFile())
    .sort();
  invariant(
    apks.length === EXPECTED_ABIS.length,
    `Expected exactly ${EXPECTED_ABIS.length} split APKs.`,
  );

  const observedAbis = new Set<string>();
  for (const apk of apks) {
    const badging = execFileSync(aapt2, ["dump", "badging", apk], {
      encoding: "utf8",
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    invariant(
      parsePackageName(badging) === EXPECTED_PACKAGE,
      `APK package identity drifted: ${apk}`,
    );
    invariant(
      JSON.stringify(parseManifestPermissions(badging)) ===
        JSON.stringify(["android.permission.INTERNET"]),
      `APK manifest permissions are broader than INTERNET: ${apk}`,
    );
    const listing = execFileSync("unzip", ["-Z1", apk], {
      encoding: "utf8",
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const abis = parseNativeAbis(listing);
    invariant(
      abis.length === 1 && EXPECTED_ABIS.includes(abis[0] as (typeof EXPECTED_ABIS)[number]),
      `APK ABI set is invalid: ${apk}`,
    );
    observedAbis.add(abis[0]);

    const signerOutput = execFileSync(apksigner, ["verify", "--verbose", "--print-certs", apk], {
      encoding: "utf8",
      maxBuffer: MAX_TOOL_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const signer = verifyApkSignerPin(
      signerOutput,
      readFileSync(resolve(root, "mobile-core/source-manifest.json"), "utf8"),
    );
    console.log(
      `${apk}: package=${EXPECTED_PACKAGE} abi=${abis[0]} signer=${signer.certificateSha256}`,
    );
  }
  invariant(
    JSON.stringify([...observedAbis].sort()) === JSON.stringify([...EXPECTED_ABIS].sort()),
    "APK split outputs do not cover exactly arm64-v8a and x86_64.",
  );
}

if (import.meta.main) {
  try {
    const options = parseArguments(process.argv.slice(2));
    inspect(options.directory, options.aapt2, options.apksigner);
    console.log(
      "React Native debug APK inspection passed: package, INTERNET-only manifest, signer pin, and dual ABI splits are verified.",
    );
  } catch (error: unknown) {
    console.error(error instanceof Error ? error.message : "React Native APK inspection failed.");
    process.exitCode = 1;
  }
}
