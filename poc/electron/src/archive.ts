import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import path from "node:path";

export const ELECTRON_VERSION = "43.4.0" as const;
export const ELECTRON_DARWIN_ARM64_SHA256 =
  "827f9f182566f46846377575b51c547b9926b111637313a373b6f717462aebac" as const;

export interface ElectronArchiveEvidence {
  readonly archive: string;
  readonly sha256: string;
  readonly version: typeof ELECTRON_VERSION;
  readonly platform: "darwin";
  readonly arch: "arm64";
}

function fail(message: string): never {
  throw new Error(`Electron fixture: ${message}`);
}

function assertRegularFile(file: string, description: string): void {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(file);
  } catch {
    fail(`${description} is missing: ${file}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`${description} must be a regular file: ${file}`);
  }
}

function sha256(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function verifyElectronArchive(
  archive: string,
  expectedSha256: string = ELECTRON_DARWIN_ARM64_SHA256,
): ElectronArchiveEvidence {
  const resolved = path.resolve(archive);
  assertRegularFile(resolved, "Electron archive");
  const digest = sha256(resolved);
  if (digest !== expectedSha256) {
    fail(`Electron archive SHA-256 mismatch: expected ${expectedSha256}, got ${digest}`);
  }
  execFileSync("/usr/bin/unzip", ["-tq", resolved], { stdio: "pipe" });
  return {
    archive: resolved,
    sha256: digest,
    version: ELECTRON_VERSION,
    platform: "darwin",
    arch: "arm64",
  };
}
