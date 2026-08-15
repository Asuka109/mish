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

function assertRegularFile(file: string): void {
  let metadata: ReturnType<typeof lstatSync>;
  try {
    metadata = lstatSync(file);
  } catch {
    fail(`Electron archive is missing: ${file}`);
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    fail(`Electron archive must be a regular file: ${file}`);
  }
}

export function verifyElectronArchive(
  archive: string,
  expectedSha256: string = ELECTRON_DARWIN_ARM64_SHA256,
): ElectronArchiveEvidence {
  const resolved = path.resolve(archive);
  assertRegularFile(resolved);
  const sha256 = createHash("sha256").update(readFileSync(resolved)).digest("hex");
  if (sha256 !== expectedSha256) {
    fail(`Electron archive SHA-256 mismatch: expected ${expectedSha256}, got ${sha256}`);
  }
  execFileSync("/usr/bin/unzip", ["-tq", resolved], { stdio: "pipe" });
  return {
    archive: resolved,
    sha256,
    version: ELECTRON_VERSION,
    platform: "darwin",
    arch: "arm64",
  };
}
