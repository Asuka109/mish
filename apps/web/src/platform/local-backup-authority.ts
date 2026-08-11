import type { RpcSessionAuthority, RpcSessionSnapshot } from "@mish/rpc-client";
import type { LocalBackupPreviewDto, LocalBackupScopeDto } from "@mish/contracts";
import {
  canonicalLocalBackupExportJson,
  isLocalBackupExportFingerprint,
  localBackupExportFingerprint,
  localBackupExportScopeFingerprint,
  parseLocalBackupExportGeneration,
  parseLocalBackupExportPreview,
  parseLocalBackupExportScope,
} from "./local-backup-fingerprint";

export const LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const LOCAL_BACKUP_EXPORT_TRANSCRIPT_MAX_EVENTS = 32;

export type LocalBackupExportAuthorityFailure =
  | "malformed"
  | "stale"
  | "duplicate"
  | "conflict"
  | "wrong-generation";

export type LocalBackupExportAuthorityOutcome = "accepted" | LocalBackupExportAuthorityFailure;

export type LocalBackupExportTraceEvent =
  | {
      authorityFingerprint: string | null;
      generation: number;
      kind: "preview" | "save";
      phase: "invocation";
      result: null;
      schemaVersion: typeof LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION;
      scopeFingerprint: string | null;
    }
  | {
      authorityFingerprint: string | null;
      generation: number;
      kind: "preview" | "save";
      phase: "result";
      result: LocalBackupExportAuthorityOutcome;
      schemaVersion: typeof LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION;
      scopeFingerprint: string | null;
    };

export interface LocalBackupExportTranscript {
  readonly events: readonly LocalBackupExportTraceEvent[];
  readonly schemaVersion: typeof LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION;
}

export class LocalBackupExportTranscriptOverflowError extends Error {
  constructor() {
    super("The local backup export transcript exceeded its fixed event bound");
    this.name = "LocalBackupExportTranscriptOverflowError";
  }
}

export class LocalBackupExportTranscriptRecorder {
  private readonly recorded: LocalBackupExportTraceEvent[] = [];

  constructor(private readonly limit = LOCAL_BACKUP_EXPORT_TRANSCRIPT_MAX_EVENTS) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > LOCAL_BACKUP_EXPORT_TRANSCRIPT_MAX_EVENTS
    ) {
      throw new RangeError("The local backup export transcript limit is outside its fixed bound");
    }
  }

  record(event: LocalBackupExportTraceEvent): void {
    if (this.recorded.length >= this.limit) {
      throw new LocalBackupExportTranscriptOverflowError();
    }
    validateTraceEvent(event);
    this.recorded.push(structuredClone(event));
  }

  snapshot(): LocalBackupExportTranscript {
    return {
      events: this.recorded.map((event) => structuredClone(event)),
      schemaVersion: LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION,
    };
  }
}

export type LocalBackupRpcSessionAuthority = Pick<
  RpcSessionAuthority<RpcSessionSnapshot>,
  "getGeneration" | "isStale"
>;

export interface LocalBackupExportPreviewRequest {
  readonly generation: number;
  readonly requestSequence: number;
  readonly scope: LocalBackupScopeDto;
  readonly scopeFingerprint: string;
}

export interface LocalBackupExportAuthorityBinding {
  readonly fingerprint: string;
  readonly generation: number;
  readonly preview: LocalBackupPreviewDto;
  readonly scope: LocalBackupScopeDto;
}

export type LocalBackupExportPreviewRequestResult =
  | { readonly kind: "accepted"; readonly request: LocalBackupExportPreviewRequest }
  | { readonly kind: LocalBackupExportAuthorityFailure; readonly request: null };

export type LocalBackupExportPreviewResult =
  | { readonly authority: LocalBackupExportAuthorityBinding; readonly kind: "accepted" }
  | { readonly authority: null; readonly kind: LocalBackupExportAuthorityFailure };

export type LocalBackupExportSaveResult =
  | { readonly authority: LocalBackupExportAuthorityBinding; readonly kind: "accepted" }
  | { readonly authority: null; readonly kind: LocalBackupExportAuthorityFailure };

export interface LocalBackupExportAuthorityOptions {
  readonly trace?: (event: LocalBackupExportTraceEvent) => void;
}

/**
 * Owns the Web-side save authorization without becoming a second RPC session
 * authority. The generation is always read from the supplied
 * `RpcSessionAuthority`; this class only binds that generation to one exact
 * selected scope and one accepted preview DTO.
 */
export class LocalBackupExportAuthority {
  private accepted: LocalBackupExportAuthorityBinding | null = null;
  private lastCompletedRequestSequence: number | null = null;
  private lastConsumedFingerprint: string | null = null;
  private nextRequestSequence = 1;
  private pending: LocalBackupExportPreviewRequest | null = null;

  constructor(
    private readonly session: LocalBackupRpcSessionAuthority,
    private readonly options: LocalBackupExportAuthorityOptions = {},
  ) {}

  async beginPreview(
    selectedScope: unknown,
    generation = this.session.getGeneration(),
  ): Promise<LocalBackupExportPreviewRequestResult> {
    const parsedGeneration = parseLocalBackupExportGeneration(generation);
    const scope = parseLocalBackupExportScope(selectedScope);
    const observedGeneration = this.session.getGeneration();
    const scopeFingerprint = scope ? await safeScopeFingerprint(scope) : null;

    this.trace({
      authorityFingerprint: null,
      generation: parsedGeneration ?? observedGeneration,
      kind: "preview",
      phase: "invocation",
      result: null,
      schemaVersion: LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION,
      scopeFingerprint,
    });

    if (!this.pending) {
      this.accepted = null;
      this.lastCompletedRequestSequence = null;
      this.lastConsumedFingerprint = null;
    }
    if (this.pending) {
      return this.previewRequestFailure(
        "duplicate",
        parsedGeneration ?? observedGeneration,
        scopeFingerprint,
      );
    }
    if (!scope || parsedGeneration === null) {
      return this.previewRequestFailure(
        "malformed",
        parsedGeneration ?? observedGeneration,
        scopeFingerprint,
      );
    }
    const sessionFailure = this.sessionGenerationFailure(parsedGeneration, observedGeneration);
    if (sessionFailure) {
      return this.previewRequestFailure(sessionFailure, parsedGeneration, scopeFingerprint);
    }

    const request: LocalBackupExportPreviewRequest = {
      generation: parsedGeneration,
      requestSequence: this.nextRequestSequence,
      scope: structuredClone(scope),
      scopeFingerprint: scopeFingerprint!,
    };
    this.nextRequestSequence += 1;
    this.pending = request;
    return { kind: "accepted", request: structuredClone(request) };
  }

  async acceptPreview(
    request: LocalBackupExportPreviewRequest,
    previewInput: unknown,
  ): Promise<LocalBackupExportPreviewResult> {
    const observedGeneration = this.session.getGeneration();
    const pending = this.pending;
    const preview = parseLocalBackupExportPreview(previewInput);
    const parsedRequest = parsePreviewRequest(request);
    const generation = parsedRequest?.generation ?? observedGeneration;
    const scopeFingerprint = parsedRequest?.scopeFingerprint ?? null;

    if (!parsedRequest) {
      const requestSequence = parseRequestSequence(request);
      if (pending && pending.requestSequence === requestSequence) {
        this.pending = null;
        this.lastCompletedRequestSequence = requestSequence;
      }
      return this.previewResultFailure("malformed", generation, scopeFingerprint);
    }
    if (!pending || pending.requestSequence !== parsedRequest.requestSequence) {
      const result =
        this.lastCompletedRequestSequence === parsedRequest.requestSequence ? "duplicate" : "stale";
      return this.previewResultFailure(result, generation, scopeFingerprint);
    }
    this.pending = null;
    this.lastCompletedRequestSequence = parsedRequest.requestSequence;

    if (generation !== pending.generation) {
      return this.previewResultFailure("wrong-generation", generation, scopeFingerprint);
    }
    if (
      parsedRequest.scopeFingerprint !== pending.scopeFingerprint ||
      !sameScope(parsedRequest.scope, pending.scope)
    ) {
      return this.previewResultFailure("conflict", generation, scopeFingerprint);
    }
    const expectedScopeFingerprint = await safeScopeFingerprint(parsedRequest.scope);
    if (!expectedScopeFingerprint || expectedScopeFingerprint !== parsedRequest.scopeFingerprint) {
      return this.previewResultFailure("malformed", generation, scopeFingerprint);
    }
    if (!preview) {
      return this.previewResultFailure("malformed", generation, scopeFingerprint);
    }
    const sessionFailure = this.sessionGenerationFailure(generation, observedGeneration);
    if (sessionFailure) {
      return this.previewResultFailure(sessionFailure, generation, scopeFingerprint);
    }
    if (!sameScope(parsedRequest.scope, preview.scope)) {
      return this.previewResultFailure("conflict", generation, scopeFingerprint);
    }

    const fingerprint = await safeFingerprint(parsedRequest.scope, preview, generation);
    if (!fingerprint) {
      return this.previewResultFailure("malformed", generation, scopeFingerprint);
    }
    if (
      this.lastConsumedFingerprint === fingerprint ||
      this.accepted?.fingerprint === fingerprint
    ) {
      this.accepted = null;
      return this.previewResultFailure("duplicate", generation, scopeFingerprint, fingerprint);
    }
    if (this.accepted?.preview.previewId === preview.previewId) {
      this.accepted = null;
      return this.previewResultFailure("conflict", generation, scopeFingerprint, fingerprint);
    }

    const authority: LocalBackupExportAuthorityBinding = deepFreeze({
      fingerprint,
      generation,
      preview: structuredClone(preview),
      scope: structuredClone(parsedRequest.scope),
    });
    this.accepted = authority;
    this.lastConsumedFingerprint = null;
    this.trace({
      authorityFingerprint: fingerprint,
      generation,
      kind: "preview",
      phase: "result",
      result: "accepted",
      schemaVersion: LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION,
      scopeFingerprint,
    });
    return { authority, kind: "accepted" };
  }

  async authorizeSave(
    selectedScope: unknown,
    previewInput: unknown,
    generation = this.session.getGeneration(),
  ): Promise<LocalBackupExportSaveResult> {
    const observedGeneration = this.session.getGeneration();
    const parsedGeneration = parseLocalBackupExportGeneration(generation);
    const scope = parseLocalBackupExportScope(selectedScope);
    const preview = parseLocalBackupExportPreview(previewInput);
    const scopeFingerprint = scope ? await safeScopeFingerprint(scope) : null;
    const authorityFingerprint = this.accepted?.fingerprint ?? this.lastConsumedFingerprint;

    this.trace({
      authorityFingerprint,
      generation: parsedGeneration ?? observedGeneration,
      kind: "save",
      phase: "invocation",
      result: null,
      schemaVersion: LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION,
      scopeFingerprint,
    });

    if (!scope || !preview || parsedGeneration === null) {
      this.accepted = null;
      return this.saveFailure(
        "malformed",
        parsedGeneration ?? observedGeneration,
        scopeFingerprint,
      );
    }
    const sessionFailure = this.saveSessionGenerationFailure(parsedGeneration, observedGeneration);
    if (sessionFailure) {
      this.accepted = null;
      return this.saveFailure(sessionFailure, parsedGeneration, scopeFingerprint);
    }
    if (!this.accepted) {
      const candidate = await safeFingerprint(scope, preview, parsedGeneration);
      return this.saveFailure(
        candidate && candidate === this.lastConsumedFingerprint ? "duplicate" : "stale",
        parsedGeneration,
        scopeFingerprint,
        candidate,
      );
    }
    if (this.accepted.generation !== parsedGeneration) {
      this.accepted = null;
      return this.saveFailure("wrong-generation", parsedGeneration, scopeFingerprint);
    }
    if (!sameScope(this.accepted.scope, scope) || !samePreview(this.accepted.preview, preview)) {
      this.accepted = null;
      return this.saveFailure("conflict", parsedGeneration, scopeFingerprint);
    }

    const fingerprint = await safeFingerprint(scope, preview, parsedGeneration);
    if (!fingerprint) {
      this.accepted = null;
      return this.saveFailure("malformed", parsedGeneration, scopeFingerprint);
    }
    if (fingerprint !== this.accepted.fingerprint) {
      this.accepted = null;
      return this.saveFailure("conflict", parsedGeneration, scopeFingerprint, fingerprint);
    }

    const accepted = this.accepted;
    this.accepted = null;
    this.lastConsumedFingerprint = accepted.fingerprint;
    this.trace({
      authorityFingerprint: accepted.fingerprint,
      generation: parsedGeneration,
      kind: "save",
      phase: "result",
      result: "accepted",
      schemaVersion: LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION,
      scopeFingerprint,
    });
    return { authority: accepted, kind: "accepted" };
  }

  invalidate(): void {
    this.accepted = null;
    this.lastCompletedRequestSequence = null;
    this.pending = null;
    this.lastConsumedFingerprint = null;
  }

  snapshot(): LocalBackupExportAuthorityBinding | null {
    return this.accepted ? structuredClone(this.accepted) : null;
  }

  private sessionGenerationFailure(generation: number, observedGeneration: number) {
    if (this.session.isStale()) return "stale" as const;
    if (generation < observedGeneration) return "stale" as const;
    if (generation > observedGeneration) return "wrong-generation" as const;
    return null;
  }

  private saveSessionGenerationFailure(generation: number, observedGeneration: number) {
    if (this.session.isStale()) return "stale" as const;
    if (generation !== observedGeneration) return "wrong-generation" as const;
    return null;
  }

  private previewRequestFailure(
    kind: LocalBackupExportAuthorityFailure,
    generation: number,
    scopeFingerprint: string | null,
  ): LocalBackupExportPreviewRequestResult {
    this.trace({
      authorityFingerprint: null,
      generation,
      kind: "preview",
      phase: "result",
      result: kind,
      schemaVersion: LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION,
      scopeFingerprint,
    });
    return { kind, request: null };
  }

  private previewResultFailure(
    kind: LocalBackupExportAuthorityFailure,
    generation: number,
    scopeFingerprint: string | null,
    authorityFingerprint: string | null = null,
  ): LocalBackupExportPreviewResult {
    this.trace({
      authorityFingerprint,
      generation,
      kind: "preview",
      phase: "result",
      result: kind,
      schemaVersion: LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION,
      scopeFingerprint,
    });
    return { authority: null, kind };
  }

  private saveFailure(
    kind: LocalBackupExportAuthorityFailure,
    generation: number,
    scopeFingerprint: string | null,
    authorityFingerprint: string | null = this.accepted?.fingerprint ??
      this.lastConsumedFingerprint,
  ): LocalBackupExportSaveResult {
    this.trace({
      authorityFingerprint,
      generation,
      kind: "save",
      phase: "result",
      result: kind,
      schemaVersion: LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION,
      scopeFingerprint,
    });
    return { authority: null, kind };
  }

  private trace(event: LocalBackupExportTraceEvent) {
    this.options.trace?.(event);
  }
}

function sameScope(left: LocalBackupScopeDto, right: LocalBackupScopeDto): boolean {
  return (
    left.patches === right.patches &&
    left.profiles === right.profiles &&
    left.schedules === right.schedules &&
    left.settings === right.settings &&
    left.sourceLocators === right.sourceLocators
  );
}

function samePreview(left: LocalBackupPreviewDto, right: LocalBackupPreviewDto): boolean {
  return canonicalLocalBackupExportJson(left) === canonicalLocalBackupExportJson(right);
}

function parsePreviewRequest(value: unknown): LocalBackupExportPreviewRequest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  const keys = Object.keys(candidate).sort();
  if (keys.join("\u0000") !== "generation\u0000requestSequence\u0000scope\u0000scopeFingerprint") {
    return null;
  }
  const generation = parseLocalBackupExportGeneration(candidate.generation);
  const requestSequence = parseRequestSequence(value);
  const scope = parseLocalBackupExportScope(candidate.scope);
  const scopeFingerprint = candidate.scopeFingerprint;
  if (
    generation === null ||
    requestSequence === null ||
    !scope ||
    !isLocalBackupExportFingerprint(scopeFingerprint)
  ) {
    return null;
  }
  return {
    generation,
    requestSequence,
    scope: structuredClone(scope),
    scopeFingerprint,
  };
}

function parseRequestSequence(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const requestSequence = (value as Record<string, unknown>).requestSequence;
  return typeof requestSequence === "number" &&
    Number.isSafeInteger(requestSequence) &&
    requestSequence >= 1
    ? requestSequence
    : null;
}

async function safeScopeFingerprint(scope: LocalBackupScopeDto): Promise<string | null> {
  try {
    return await localBackupExportScopeFingerprint(scope);
  } catch {
    return null;
  }
}

async function safeFingerprint(
  scope: LocalBackupScopeDto,
  preview: LocalBackupPreviewDto,
  generation: number,
): Promise<string | null> {
  try {
    return await localBackupExportFingerprint(scope, preview, generation);
  } catch {
    return null;
  }
}

function validateTraceEvent(event: LocalBackupExportTraceEvent): void {
  const resultKinds: readonly LocalBackupExportAuthorityOutcome[] = [
    "accepted",
    "malformed",
    "stale",
    "duplicate",
    "conflict",
    "wrong-generation",
  ];
  if (
    event.schemaVersion !== LOCAL_BACKUP_EXPORT_TRANSCRIPT_SCHEMA_VERSION ||
    !Number.isSafeInteger(event.generation) ||
    event.generation < 0 ||
    (event.kind !== "preview" && event.kind !== "save") ||
    (event.phase !== "invocation" && event.phase !== "result") ||
    (event.scopeFingerprint !== null && !isLocalBackupExportFingerprint(event.scopeFingerprint)) ||
    (event.authorityFingerprint !== null &&
      !isLocalBackupExportFingerprint(event.authorityFingerprint))
  ) {
    throw new TypeError("The local backup export transcript event is malformed");
  }
  if (event.phase === "invocation" && event.result !== null) {
    throw new TypeError("An invocation transcript event cannot carry a result");
  }
  if (event.phase === "result" && event.result === null) {
    throw new TypeError("A result transcript event must carry a closed result kind");
  }
  if (event.phase === "result" && !resultKinds.includes(event.result)) {
    throw new TypeError("A result transcript event carries an undeclared result kind");
  }
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  return value;
}
