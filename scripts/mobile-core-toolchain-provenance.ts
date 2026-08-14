interface GoArchiveIdentity {
  sha256: string;
  executableSha256: string;
}

export interface GoToolchainManifest {
  version: string;
  archives: Record<string, GoArchiveIdentity>;
}

interface OfficialGoToolchainSource {
  kind: "pinned-archive" | "verified-cache";
  host: string;
  archiveSha256: string;
  releaseEligible: true;
}

interface CallerSuppliedGoToolchainSource {
  kind: "caller-supplied";
  identity: "go-executable-sha256-v1";
  trust: "untrusted-local";
  releaseEligible: false;
}

export interface GoToolchainProvenance {
  version: string;
  executableSha256: string;
  source: OfficialGoToolchainSource | CallerSuppliedGoToolchainSource;
}

interface VerificationOptions {
  expectedHost?: string;
  requireReleaseEligible?: boolean;
}

const sha256Pattern = /^[a-f0-9]{64}$/u;
const hostPattern = /^(?:darwin|linux)-(?:arm64|amd64)$/u;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertExactKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const actual = Object.keys(value).toSorted();
  const expected = keys.toSorted();
  assert(
    actual.length === expected.length && actual.every((key, index) => key === expected[index]),
    `${label} must contain only ${expected.join(", ")}`,
  );
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

export function goVersionHostKey(version: string, expectedVersion: string): string {
  const match = version.match(
    new RegExp(`^go version ${escaped(expectedVersion)} (darwin|linux)/(arm64|amd64)$`, "u"),
  );
  assert(match, `Go provenance must use exact ${expectedVersion} host syntax`);
  return `${match[1]}-${match[2]}`;
}

export function officialGoToolchainProvenance(
  kind: OfficialGoToolchainSource["kind"],
  version: string,
  host: string,
  archive: GoArchiveIdentity,
): GoToolchainProvenance {
  assert(hostPattern.test(host), `unsupported Go provenance host ${host}`);
  assert(sha256Pattern.test(archive.sha256), `Go archive identity is invalid for ${host}`);
  assert(
    sha256Pattern.test(archive.executableSha256),
    `Go executable identity is invalid for ${host}`,
  );
  return {
    version,
    executableSha256: archive.executableSha256,
    source: {
      kind,
      host,
      archiveSha256: archive.sha256,
      releaseEligible: true,
    },
  };
}

export function callerSuppliedGoToolchainProvenance(
  version: string,
  executableSha256: string,
): GoToolchainProvenance {
  assert(sha256Pattern.test(executableSha256), "Caller-supplied Go executable identity is invalid");
  return {
    version,
    executableSha256,
    source: {
      kind: "caller-supplied",
      identity: "go-executable-sha256-v1",
      trust: "untrusted-local",
      releaseEligible: false,
    },
  };
}

export function verifyGoToolchainProvenance(
  value: unknown,
  manifest: GoToolchainManifest,
  options: VerificationOptions = {},
): GoToolchainProvenance {
  assert(isRecord(value), "Go toolchain provenance must be an object");
  assertExactKeys(value, ["version", "executableSha256", "source"], "Go toolchain provenance");
  assert(typeof value.version === "string", "Go toolchain version must be a string");
  assert(
    typeof value.executableSha256 === "string" && sha256Pattern.test(value.executableSha256),
    "Go executable identity must be a lower-case SHA-256",
  );
  assert(isRecord(value.source), "Go toolchain source must be an object");

  const host = goVersionHostKey(value.version, manifest.version);
  if (options.expectedHost) {
    assert(host === options.expectedHost, "runtime evidence was not built on this host");
  }

  if (value.source.kind === "caller-supplied") {
    assertExactKeys(
      value.source,
      ["kind", "identity", "trust", "releaseEligible"],
      "Caller-supplied Go toolchain source",
    );
    assert(
      value.source.identity === "go-executable-sha256-v1" &&
        value.source.trust === "untrusted-local" &&
        value.source.releaseEligible === false,
      "Caller-supplied Go toolchain must use the bounded untrusted-local identity",
    );
    assert(
      !options.requireReleaseEligible,
      "Caller-supplied Go toolchain evidence is not release eligible",
    );
    return value as unknown as GoToolchainProvenance;
  }

  assert(
    value.source.kind === "pinned-archive" || value.source.kind === "verified-cache",
    "Go toolchain source kind is not supported",
  );
  assertExactKeys(
    value.source,
    ["kind", "host", "archiveSha256", "releaseEligible"],
    "Official Go toolchain source",
  );
  assert(value.source.host === host, "Go toolchain source host differs from its version");
  assert(value.source.releaseEligible === true, "Official Go toolchain must be release eligible");
  const archive = manifest.archives[host];
  assert(archive, `Go host ${host} is not pinned`);
  assert(value.source.archiveSha256 === archive.sha256, `Go archive checksum mismatch for ${host}`);
  assert(
    value.executableSha256 === archive.executableSha256,
    `Go executable identity does not match the verified official archive for ${host}`,
  );
  return value as unknown as GoToolchainProvenance;
}
