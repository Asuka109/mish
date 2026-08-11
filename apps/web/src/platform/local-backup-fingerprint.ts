import {
  LocalBackupPreviewSchema,
  LocalBackupScopeSchema,
  type LocalBackupPreviewDto,
  type LocalBackupScopeDto,
} from "@mish/contracts";

export const LOCAL_BACKUP_EXPORT_FINGERPRINT_SCHEMA_VERSION = 1 as const;

const FINGERPRINT_PURPOSE = "local-backup-export-authority" as const;
const SCOPE_FINGERPRINT_PURPOSE = "local-backup-export-scope" as const;
const HEX_DIGEST = /^[a-f0-9]{64}$/u;

export interface LocalBackupExportFingerprintContract {
  readonly acceptedPreview: LocalBackupPreviewDto;
  readonly purpose: typeof FINGERPRINT_PURPOSE;
  readonly rpcSessionGeneration: number;
  readonly schemaVersion: typeof LOCAL_BACKUP_EXPORT_FINGERPRINT_SCHEMA_VERSION;
  readonly selectedScope: LocalBackupScopeDto;
}

export interface LocalBackupExportScopeFingerprintContract {
  readonly purpose: typeof SCOPE_FINGERPRINT_PURPOSE;
  readonly schemaVersion: typeof LOCAL_BACKUP_EXPORT_FINGERPRINT_SCHEMA_VERSION;
  readonly selectedScope: LocalBackupScopeDto;
}

export class LocalBackupExportFingerprintError extends Error {
  readonly code: "crypto-unavailable" | "malformed";

  constructor(code: "crypto-unavailable" | "malformed", message: string) {
    super(message);
    this.name = "LocalBackupExportFingerprintError";
    this.code = code;
  }
}

/**
 * Builds the exact semantic contract that is hashed for a save authority.
 *
 * The selected scope is intentionally repeated outside the preview DTO. This
 * makes a caller-provided scope/preview mismatch visible in the digest even
 * when the preview's own scope field is otherwise valid.
 */
export function localBackupExportFingerprintContract(
  selectedScope: unknown,
  preview: unknown,
  rpcSessionGeneration: unknown,
): LocalBackupExportFingerprintContract {
  const scope = parseScope(selectedScope);
  const acceptedPreview = parsePreview(preview);
  const generation = parseGeneration(rpcSessionGeneration);
  if (!scope || !acceptedPreview || generation === null) {
    throw new LocalBackupExportFingerprintError(
      "malformed",
      "The local backup export authority contract is malformed",
    );
  }

  return {
    acceptedPreview,
    purpose: FINGERPRINT_PURPOSE,
    rpcSessionGeneration: generation,
    schemaVersion: LOCAL_BACKUP_EXPORT_FINGERPRINT_SCHEMA_VERSION,
    selectedScope: scope,
  };
}

export function localBackupExportScopeFingerprintContract(
  selectedScope: unknown,
): LocalBackupExportScopeFingerprintContract {
  const scope = parseScope(selectedScope);
  if (!scope) {
    throw new LocalBackupExportFingerprintError(
      "malformed",
      "The local backup export scope is malformed",
    );
  }
  return {
    purpose: SCOPE_FINGERPRINT_PURPOSE,
    schemaVersion: LOCAL_BACKUP_EXPORT_FINGERPRINT_SCHEMA_VERSION,
    selectedScope: scope,
  };
}

export async function localBackupExportFingerprint(
  selectedScope: unknown,
  preview: unknown,
  rpcSessionGeneration: unknown,
): Promise<string> {
  return digestContract(
    localBackupExportFingerprintContract(selectedScope, preview, rpcSessionGeneration),
  );
}

export async function localBackupExportScopeFingerprint(selectedScope: unknown): Promise<string> {
  return digestContract(localBackupExportScopeFingerprintContract(selectedScope));
}

export function isLocalBackupExportFingerprint(value: unknown): value is string {
  return typeof value === "string" && HEX_DIGEST.test(value);
}

export function parseLocalBackupExportGeneration(value: unknown): number | null {
  return parseGeneration(value);
}

export function parseLocalBackupExportPreview(value: unknown): LocalBackupPreviewDto | null {
  return parsePreview(value);
}

export function parseLocalBackupExportScope(value: unknown): LocalBackupScopeDto | null {
  return parseScope(value);
}

/**
 * Canonical JSON is deliberately structural: object key order does not alter
 * the authority, while array order remains part of the accepted DTO contract.
 */
export function canonicalLocalBackupExportJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

async function digestContract(contract: unknown): Promise<string> {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.subtle) {
    throw new LocalBackupExportFingerprintError(
      "crypto-unavailable",
      "Web Crypto is required to bind a local backup export authority",
    );
  }
  const bytes = new TextEncoder().encode(canonicalLocalBackupExportJson(contract));
  const digest = await cryptoApi.subtle.digest("SHA-256", bytes);
  const result = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (!HEX_DIGEST.test(result)) {
    throw new LocalBackupExportFingerprintError(
      "crypto-unavailable",
      "Web Crypto returned an invalid local backup export fingerprint",
    );
  }
  return result;
}

function parseScope(value: unknown): LocalBackupScopeDto | null {
  const parsed = LocalBackupScopeSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parsePreview(value: unknown): LocalBackupPreviewDto | null {
  const parsed = LocalBackupPreviewSchema.safeParse(value);
  if (!parsed.success || parsed.data.previewId.length > 128) return null;
  return parsed.data;
}

function parseGeneration(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  return value;
}
