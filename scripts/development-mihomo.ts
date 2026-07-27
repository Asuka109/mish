import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import path from "node:path";

export interface MacOsMihomoRelease {
  archiveSha256: string;
  asset: string;
  binarySha256: string;
  repository: string;
  schemaVersion: 1;
  version: string;
}

export type DevelopmentMihomoFailure =
  | "archive-digest"
  | "binary-absent"
  | "binary-digest"
  | "binary-mode"
  | "binary-path"
  | "binary-type"
  | "binary-version"
  | "manifest-invalid"
  | "unsupported-host";

export class DevelopmentMihomoError extends Error {
  readonly failure: DevelopmentMihomoFailure;

  constructor(failure: DevelopmentMihomoFailure, message: string) {
    super(message);
    this.failure = failure;
    this.name = "DevelopmentMihomoError";
  }
}

export interface DevelopmentMihomoVerification {
  binary: string;
  binarySha256: string;
  version: string;
}

export interface DevelopmentMihomoSelection extends DevelopmentMihomoVerification {
  source: "explicit-override" | "repository-pin";
}

interface VerifyDevelopmentMihomoOptions {
  binary: string;
  expectedSha256: string;
  expectedVersion: string;
  inspectVersion?: (binary: string) => string;
}

interface VerifyLocalDevelopmentMihomoOptions {
  binary: string;
  expectedVersion: string;
  inspectVersion?: (binary: string) => string;
}

function sha256(contents: Uint8Array): string {
  return createHash("sha256").update(contents).digest("hex");
}

export async function readMacOsMihomoRelease(repositoryRoot: string): Promise<MacOsMihomoRelease> {
  let release: unknown;
  try {
    release = JSON.parse(
      await readFile(path.join(repositoryRoot, "resources/mihomo/macos-arm64.json"), "utf8"),
    );
  } catch {
    throw new DevelopmentMihomoError(
      "manifest-invalid",
      "The pinned development Core manifest could not be read.",
    );
  }
  if (!validMacOsMihomoRelease(release)) {
    throw new DevelopmentMihomoError(
      "manifest-invalid",
      "The pinned development Core manifest is not the closed macOS arm64 release contract.",
    );
  }
  return release;
}

function validMacOsMihomoRelease(release: unknown): release is MacOsMihomoRelease {
  if (!release || typeof release !== "object" || Array.isArray(release)) return false;
  const candidate = release as Record<string, unknown>;
  const version = candidate.version;
  return (
    Object.keys(candidate).length === 6 &&
    candidate.schemaVersion === 1 &&
    candidate.repository === "MetaCubeX/mihomo" &&
    typeof version === "string" &&
    /^v\d+\.\d+\.\d+$/u.test(version) &&
    candidate.asset === `mihomo-darwin-arm64-${version}.gz` &&
    typeof candidate.archiveSha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.archiveSha256) &&
    typeof candidate.binarySha256 === "string" &&
    /^[a-f0-9]{64}$/u.test(candidate.binarySha256)
  );
}

export function preparedDevelopmentMihomoPath(
  repositoryRoot: string,
  release: MacOsMihomoRelease,
): string {
  return path.join(repositoryRoot, ".scratch/mihomo", release.version, release.asset.slice(0, -3));
}

function inspectMihomoVersion(binary: string): string {
  const result = spawnSync(binary, ["-v"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  if (result.error || result.status !== 0) {
    throw new DevelopmentMihomoError(
      "binary-version",
      "The prepared development Core did not report its pinned version.",
    );
  }
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
}

export async function verifyDevelopmentMihomo({
  binary,
  expectedSha256,
  expectedVersion,
  inspectVersion = inspectMihomoVersion,
}: VerifyDevelopmentMihomoOptions): Promise<DevelopmentMihomoVerification> {
  let metadata;
  try {
    metadata = await lstat(binary);
  } catch {
    throw new DevelopmentMihomoError(
      "binary-absent",
      "The repository-managed development Core is absent after preparation.",
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new DevelopmentMihomoError(
      "binary-type",
      "The repository-managed development Core must be a regular file.",
    );
  }
  if ((metadata.mode & 0o777) !== 0o755) {
    throw new DevelopmentMihomoError(
      "binary-mode",
      "The repository-managed development Core must have mode 0755.",
    );
  }
  try {
    await access(binary, constants.X_OK);
  } catch {
    throw new DevelopmentMihomoError(
      "binary-mode",
      "The repository-managed development Core is not executable.",
    );
  }
  const binarySha256 = sha256(await readFile(binary));
  if (binarySha256 !== expectedSha256) {
    throw new DevelopmentMihomoError(
      "binary-digest",
      "The repository-managed development Core does not match the pinned SHA-256.",
    );
  }
  const version = inspectVersion(binary);
  if (!version.includes(`${expectedVersion} darwin arm64`)) {
    throw new DevelopmentMihomoError(
      "binary-version",
      "The repository-managed development Core does not match the pinned version and host.",
    );
  }
  return { binary, binarySha256, version };
}

export async function verifyLocalDevelopmentMihomo({
  binary,
  expectedVersion,
  inspectVersion = inspectMihomoVersion,
}: VerifyLocalDevelopmentMihomoOptions): Promise<DevelopmentMihomoVerification> {
  if (!path.isAbsolute(binary)) {
    throw new DevelopmentMihomoError(
      "binary-path",
      "The explicit MISH_MIHOMO_BIN development Core path must be absolute.",
    );
  }
  let metadata;
  try {
    metadata = await lstat(binary);
  } catch {
    throw new DevelopmentMihomoError(
      "binary-absent",
      "The explicit MISH_MIHOMO_BIN development Core is absent; restore it or unset the override.",
    );
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new DevelopmentMihomoError(
      "binary-type",
      "The explicit MISH_MIHOMO_BIN development Core must be a regular file.",
    );
  }
  if ((metadata.mode & 0o777) !== 0o755) {
    throw new DevelopmentMihomoError(
      "binary-mode",
      "The explicit MISH_MIHOMO_BIN development Core must have mode 0755.",
    );
  }
  try {
    await access(binary, constants.X_OK);
  } catch {
    throw new DevelopmentMihomoError(
      "binary-mode",
      "The explicit MISH_MIHOMO_BIN development Core is not executable.",
    );
  }
  const binarySha256 = sha256(await readFile(binary));
  const version = inspectVersion(binary);
  if (!version.includes(`${expectedVersion} darwin arm64`)) {
    throw new DevelopmentMihomoError(
      "binary-version",
      "The explicit MISH_MIHOMO_BIN development Core does not match the required version and host.",
    );
  }
  return { binary, binarySha256, version };
}

export async function selectDevelopmentMihomo(
  repositoryRoot: string,
  explicitOverride: string | undefined,
): Promise<DevelopmentMihomoSelection> {
  if (explicitOverride !== undefined) {
    const release = await readMacOsMihomoRelease(repositoryRoot);
    return {
      ...(await verifyLocalDevelopmentMihomo({
        binary: explicitOverride,
        expectedVersion: release.version,
      })),
      source: "explicit-override",
    };
  }
  return {
    ...(await preparePinnedDevelopmentMihomo(repositoryRoot)),
    source: "repository-pin",
  };
}

export async function preparePinnedDevelopmentMihomo(
  repositoryRoot: string,
): Promise<DevelopmentMihomoVerification> {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new DevelopmentMihomoError(
      "unsupported-host",
      "The pinned development Core currently supports Apple Silicon macOS only.",
    );
  }
  const release = await readMacOsMihomoRelease(repositoryRoot);
  const directory = path.join(repositoryRoot, ".scratch/mihomo", release.version);
  const archive = path.join(directory, release.asset);
  const binary = preparedDevelopmentMihomoPath(repositoryRoot, release);
  const temporary = `${binary}.tmp-${process.pid}`;
  await mkdir(directory, { recursive: true });

  try {
    return await verifyDevelopmentMihomo({
      binary,
      expectedSha256: release.binarySha256,
      expectedVersion: release.version,
    });
  } catch (error) {
    if (!(error instanceof DevelopmentMihomoError)) throw error;
  }

  let compressed = await readFile(archive).catch(() => null);
  if (compressed && sha256(compressed) !== release.archiveSha256) {
    await unlink(archive);
    compressed = null;
  }
  if (!compressed) {
    execFileSync(
      "gh",
      [
        "release",
        "download",
        release.version,
        "--repo",
        release.repository,
        "--pattern",
        release.asset,
        "--dir",
        directory,
      ],
      { stdio: "inherit" },
    );
    compressed = await readFile(archive);
  }
  if (sha256(compressed) !== release.archiveSha256) {
    throw new DevelopmentMihomoError(
      "archive-digest",
      "The downloaded development Core archive does not match the pinned SHA-256.",
    );
  }
  const uncompressed = gunzipSync(compressed);
  if (sha256(uncompressed) !== release.binarySha256) {
    throw new DevelopmentMihomoError(
      "binary-digest",
      "The decompressed development Core does not match the pinned SHA-256.",
    );
  }

  try {
    await writeFile(temporary, uncompressed, { mode: 0o755 });
    await chmod(temporary, 0o755);
    await rename(temporary, binary);
  } finally {
    await unlink(temporary).catch(() => undefined);
  }

  return verifyDevelopmentMihomo({
    binary,
    expectedSha256: release.binarySha256,
    expectedVersion: release.version,
  });
}
