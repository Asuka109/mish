import { execFileSync } from "node:child_process";
import { accessSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import process from "node:process";

const repositoryRoot = resolve(import.meta.dirname, "..");
const MAX_APKSIGNER_OUTPUT_BYTES = 128 * 1024;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;

export const ANDROID_SIGNER_POLICY = "synthetic-debug-v1";
export const ANDROID_SIGNER_SCHEME = "android-package-signature-v1";
export const ANDROID_SIGNER_VERIFICATION = "package-signer";

export type ApkSignerObservation = {
  certificateSha256: string;
  schemes: string[];
};

type SourceManifest = {
  android?: {
    signing?: {
      policy?: unknown;
      scheme?: unknown;
      signerSha256?: unknown;
      verification?: unknown;
    };
  };
};

function invariant(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function boundedOutput(output: string): string {
  invariant(
    Buffer.byteLength(output, "utf8") <= MAX_APKSIGNER_OUTPUT_BYTES,
    "APK signer verification output exceeded the bounded limit.",
  );
  return output;
}

/** Parse only the bounded, digest-only fields emitted by apksigner. */
export function parseApksignerVerification(output: string): ApkSignerObservation {
  boundedOutput(output);
  const schemeMatches = [
    ...output.matchAll(/^Verified using (v\d+) scheme[^:]*:\s*(true|false)$/gmu),
  ];
  const schemes = schemeMatches.filter((match) => match[2] === "true").map((match) => match[1]);
  invariant(schemes.length > 0, "APK signature verification did not report a verified scheme.");

  const signerLines = output
    .split(/\r?\n/u)
    .filter((line) => /^Signer #\d+ certificate SHA-256 digest:/u.test(line));
  invariant(
    signerLines.length === 1,
    "APK signature verification requires exactly one signer certificate.",
  );
  const signerMatch = signerLines[0].match(/^Signer #(\d+) certificate SHA-256 digest:\s*(\S+)$/u);
  invariant(signerMatch?.[1] === "1", "APK signer numbering is malformed.");
  const certificateSha256 = signerMatch[2];
  invariant(SHA256_PATTERN.test(certificateSha256), "APK signer SHA-256 digest is malformed.");

  return { certificateSha256, schemes };
}

export function readPinnedSignerSha256(manifestText: string): string {
  let manifest: SourceManifest;
  try {
    manifest = JSON.parse(manifestText) as SourceManifest;
  } catch {
    throw new Error("Mobile Core source manifest is malformed.");
  }
  const signing = manifest.android?.signing;
  invariant(
    signing?.policy === ANDROID_SIGNER_POLICY &&
      signing.scheme === ANDROID_SIGNER_SCHEME &&
      signing.verification === ANDROID_SIGNER_VERIFICATION &&
      typeof signing.signerSha256 === "string" &&
      SHA256_PATTERN.test(signing.signerSha256),
    "Mobile Core source manifest does not contain the bounded Android signer policy.",
  );
  return signing.signerSha256;
}

export function verifyApkSignerPin(
  verificationOutput: string,
  manifestText: string,
): ApkSignerObservation {
  const observation = parseApksignerVerification(verificationOutput);
  const expected = readPinnedSignerSha256(manifestText);
  invariant(
    observation.certificateSha256 === expected,
    "APK signer certificate does not match the pinned Mobile Core signer.",
  );
  return observation;
}

function parseArguments(argv: string[]): { apk: string; apksigner: string } {
  let apk = "";
  let apksigner = "";
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--") continue;
    if (argument === "--apk") apk = argv[++index] ?? "";
    else if (argument === "--apksigner") apksigner = argv[++index] ?? "";
    else throw new Error("Usage: pnpm android:verify-signer -- --apk <path> [--apksigner <path>]");
  }
  invariant(apk.length > 0 && apk.endsWith(".apk"), "--apk must identify a .apk file.");
  const sdkRoot =
    process.env.ANDROID_HOME ??
    process.env.ANDROID_SDK_ROOT ??
    resolve(homedir(), "Library/Android/sdk");
  return {
    apk: resolve(apk),
    apksigner: resolve(apksigner || sdkRoot, apksigner ? "" : "build-tools/36.1.0/apksigner"),
  };
}

function main(argv: string[]): void {
  const options = parseArguments(argv);
  accessSync(options.apk);
  invariant(statSync(options.apk).isFile(), "--apk must identify a regular file.");
  accessSync(options.apksigner);

  let verificationOutput: string;
  try {
    verificationOutput = execFileSync(
      options.apksigner,
      ["verify", "--verbose", "--print-certs", options.apk],
      {
        encoding: "utf8",
        maxBuffer: MAX_APKSIGNER_OUTPUT_BYTES,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
  } catch {
    throw new Error("APK signature verification failed closed.");
  }
  const observation = verifyApkSignerPin(
    verificationOutput,
    readFileSync(resolve(repositoryRoot, "mobile-core/source-manifest.json"), "utf8"),
  );
  console.log(`Android APK signer pin verified (${observation.schemes.join(", ")}).`);
}

if (import.meta.main) {
  try {
    main(process.argv.slice(2));
  } catch (error: unknown) {
    console.error(
      error instanceof Error ? error.message : "Android APK signer verification failed.",
    );
    process.exitCode = 1;
  }
}
