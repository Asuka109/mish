import {
  ApplicationSnapshotOrderSchema,
  ProfilePreviewSchema,
  type ApplicationSnapshotOrderDto,
  type ProfilePreviewDto,
} from "@mish/contracts";
import type { RpcSessionAuthority, RpcSessionSnapshot } from "@mish/rpc-client";

export const PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const PROFILE_HTTPS_IMPORT_TRANSCRIPT_MAX_EVENTS = 32;

export type ProfileHttpsImportAuthorityFailure =
  | "malformed"
  | "stale"
  | "duplicate"
  | "conflict"
  | "wrong-generation"
  | "unsupported-source";

export type ProfileHttpsImportAuthorityOutcome = "accepted" | ProfileHttpsImportAuthorityFailure;

export type ProfileHttpsImportTraceEvent = {
  generation: number;
  kind: "preview" | "save";
  phase: "invocation" | "result";
  requestSequence: number | null;
  result: ProfileHttpsImportAuthorityOutcome | null;
  schemaVersion: typeof PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION;
  sourceType: "https" | "local-file" | null;
};

export interface ProfileHttpsImportTranscript {
  readonly events: readonly ProfileHttpsImportTraceEvent[];
  readonly schemaVersion: typeof PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION;
}

export class ProfileHttpsImportTranscriptOverflowError extends Error {
  constructor() {
    super("The Profile HTTPS import transcript exceeded its fixed event bound");
    this.name = "ProfileHttpsImportTranscriptOverflowError";
  }
}

export class ProfileHttpsImportTranscriptRecorder {
  private readonly recorded: ProfileHttpsImportTraceEvent[] = [];

  constructor(private readonly limit = PROFILE_HTTPS_IMPORT_TRANSCRIPT_MAX_EVENTS) {
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > PROFILE_HTTPS_IMPORT_TRANSCRIPT_MAX_EVENTS
    ) {
      throw new RangeError("The Profile HTTPS import transcript limit is outside its fixed bound");
    }
  }

  record(event: ProfileHttpsImportTraceEvent): void {
    if (this.recorded.length >= this.limit) {
      throw new ProfileHttpsImportTranscriptOverflowError();
    }
    validateTraceEvent(event);
    this.recorded.push(structuredClone(event));
  }

  snapshot(): ProfileHttpsImportTranscript {
    return {
      events: this.recorded.map((event) => structuredClone(event)),
      schemaVersion: PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION,
    };
  }
}

export type ProfileHttpsImportRpcSessionAuthority = Pick<
  RpcSessionAuthority<RpcSessionSnapshot>,
  "getGeneration" | "isStale"
>;

export interface ProfileHttpsImportPreviewRequest {
  readonly generation: number;
  readonly requestSequence: number;
  readonly scope: ApplicationSnapshotOrderDto;
}

export interface ProfileHttpsImportAuthorityBinding {
  readonly generation: number;
  readonly preview: ProfilePreviewDto;
  readonly requestSequence: number;
  readonly scope: ApplicationSnapshotOrderDto;
}

export type ProfileHttpsImportPreviewRequestResult =
  | { readonly kind: "accepted"; readonly request: ProfileHttpsImportPreviewRequest }
  | { readonly kind: ProfileHttpsImportAuthorityFailure; readonly request: null };

export type ProfileHttpsImportPreviewResult =
  | { readonly authority: ProfileHttpsImportAuthorityBinding; readonly kind: "accepted" }
  | { readonly authority: null; readonly kind: ProfileHttpsImportAuthorityFailure };

export type ProfileHttpsImportSaveResult =
  | { readonly authority: ProfileHttpsImportAuthorityBinding; readonly kind: "accepted" }
  | { readonly authority: null; readonly kind: ProfileHttpsImportAuthorityFailure };

export interface ProfileHttpsImportAuthorityOptions {
  readonly trace?: (event: ProfileHttpsImportTraceEvent) => void;
}

/**
 * Binds one HTTPS preflight request, its redacted preview, and the later save
 * to the same accepted RPC session generation and application scope. This is
 * deliberately separate from RpcSessionAuthority: it never accepts snapshots
 * and never carries URL, label, token, path, or profile bytes.
 */
export class ProfileHttpsImportAuthority {
  private accepted: ProfileHttpsImportAuthorityBinding | null = null;
  private lastCompletedRequestSequence: number | null = null;
  private lastConsumedPreviewId: string | null = null;
  private nextRequestSequence = 1;
  private pending: ProfileHttpsImportPreviewRequest | null = null;

  constructor(
    private readonly session: ProfileHttpsImportRpcSessionAuthority,
    private readonly options: ProfileHttpsImportAuthorityOptions = {},
  ) {}

  beginPreview(
    scopeInput: unknown,
    generation = this.session.getGeneration(),
  ): ProfileHttpsImportPreviewRequestResult {
    const parsedGeneration = parseGeneration(generation);
    const scope = parseScope(scopeInput);
    this.trace({
      generation: parsedGeneration ?? this.session.getGeneration(),
      kind: "preview",
      phase: "invocation",
      requestSequence: null,
      result: null,
      schemaVersion: PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      sourceType: null,
    });

    // A new request explicitly replaces both an accepted preview and any
    // request still in flight. Late completions retain their old sequence and
    // therefore cannot clear or authorize the replacement.
    this.accepted = null;
    this.pending = null;
    this.lastCompletedRequestSequence = null;
    this.lastConsumedPreviewId = null;

    if (!scope || parsedGeneration === null) {
      return this.previewRequestFailure(
        "malformed",
        parsedGeneration ?? this.session.getGeneration(),
      );
    }
    const sessionFailure = this.sessionGenerationFailure(parsedGeneration);
    if (sessionFailure) return this.previewRequestFailure(sessionFailure, parsedGeneration);

    const request: ProfileHttpsImportPreviewRequest = {
      generation: parsedGeneration,
      requestSequence: this.nextRequestSequence,
      scope: structuredClone(scope),
    };
    this.nextRequestSequence = increment(this.nextRequestSequence);
    this.pending = request;
    return { kind: "accepted", request: structuredClone(request) };
  }

  acceptPreview(requestInput: unknown, previewInput: unknown): ProfileHttpsImportPreviewResult {
    const observedGeneration = this.session.getGeneration();
    const parsedRequest = parseRequest(requestInput);
    const preview = ProfilePreviewSchema.safeParse(previewInput).success
      ? (previewInput as ProfilePreviewDto)
      : null;
    const pending = this.pending;
    const generation = parsedRequest?.generation ?? observedGeneration;
    const requestSequence = parsedRequest?.requestSequence ?? parseRequestSequence(requestInput);

    if (!parsedRequest) {
      if (this.pending && requestSequence === this.pending.requestSequence) {
        this.pending = null;
        this.lastCompletedRequestSequence = requestSequence;
      }
      return this.previewResultFailure("malformed", generation, requestSequence, preview);
    }
    if (!pending || pending.requestSequence !== parsedRequest.requestSequence) {
      const kind =
        this.lastCompletedRequestSequence === parsedRequest.requestSequence ? "duplicate" : "stale";
      return this.previewResultFailure(kind, generation, requestSequence, preview);
    }

    // Consume the pending request before every validation branch. A malformed
    // completion cannot be retried under the same request identity.
    this.pending = null;
    this.lastCompletedRequestSequence = parsedRequest.requestSequence;
    if (parsedRequest.generation !== pending.generation) {
      return this.previewResultFailure("wrong-generation", generation, requestSequence, preview);
    }
    if (!sameScope(parsedRequest.scope, pending.scope)) {
      return this.previewResultFailure("conflict", generation, requestSequence, preview);
    }
    const sessionFailure = this.sessionGenerationFailure(parsedRequest.generation);
    if (sessionFailure) {
      return this.previewResultFailure(sessionFailure, generation, requestSequence, preview);
    }
    if (!preview) return this.previewResultFailure("malformed", generation, requestSequence, null);
    if (preview.sourceType !== "https") {
      return this.previewResultFailure("unsupported-source", generation, requestSequence, preview);
    }

    const authority: ProfileHttpsImportAuthorityBinding = {
      generation: pending.generation,
      preview: structuredClone(preview),
      requestSequence: pending.requestSequence,
      scope: structuredClone(pending.scope),
    };
    this.accepted = authority;
    this.trace({
      generation: authority.generation,
      kind: "preview",
      phase: "result",
      requestSequence: authority.requestSequence,
      result: "accepted",
      schemaVersion: PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      sourceType: "https",
    });
    return { authority: structuredClone(authority), kind: "accepted" };
  }

  authorizeSave(
    scopeInput: unknown,
    previewInput: unknown,
    generation = this.session.getGeneration(),
  ): ProfileHttpsImportSaveResult {
    const parsedGeneration = parseGeneration(generation);
    const scope = parseScope(scopeInput);
    const parsedPreview = ProfilePreviewSchema.safeParse(previewInput);
    const preview = parsedPreview.success ? (previewInput as ProfilePreviewDto) : null;
    this.trace({
      generation: parsedGeneration ?? this.session.getGeneration(),
      kind: "save",
      phase: "invocation",
      requestSequence: this.accepted?.requestSequence ?? null,
      result: null,
      schemaVersion: PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      sourceType: preview?.sourceType ?? null,
    });

    if (!scope || parsedGeneration === null || !preview) {
      this.accepted = null;
      return this.saveFailure(
        "malformed",
        parsedGeneration ?? this.session.getGeneration(),
        preview,
      );
    }
    const sessionFailure = this.saveSessionGenerationFailure(parsedGeneration);
    if (sessionFailure) {
      this.accepted = null;
      return this.saveFailure(sessionFailure, parsedGeneration, preview);
    }
    if (preview.sourceType !== "https") {
      this.accepted = null;
      return this.saveFailure("unsupported-source", parsedGeneration, preview);
    }
    const authority = this.accepted;
    if (!authority) {
      return this.saveFailure(
        this.lastConsumedPreviewId === preview.previewId ? "duplicate" : "stale",
        parsedGeneration,
        preview,
      );
    }
    if (authority.generation !== parsedGeneration) {
      this.accepted = null;
      return this.saveFailure("wrong-generation", parsedGeneration, preview);
    }
    if (!sameScope(authority.scope, scope) || !samePreview(authority.preview, preview)) {
      this.accepted = null;
      return this.saveFailure("conflict", parsedGeneration, preview);
    }

    this.accepted = null;
    this.lastConsumedPreviewId = preview.previewId;
    this.trace({
      generation: parsedGeneration,
      kind: "save",
      phase: "result",
      requestSequence: authority.requestSequence,
      result: "accepted",
      schemaVersion: PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      sourceType: "https",
    });
    return { authority: structuredClone(authority), kind: "accepted" };
  }

  invalidate(): void {
    this.accepted = null;
    this.pending = null;
    this.lastCompletedRequestSequence = null;
    this.lastConsumedPreviewId = null;
  }

  snapshot(): ProfileHttpsImportAuthorityBinding | null {
    return this.accepted ? structuredClone(this.accepted) : null;
  }

  private sessionGenerationFailure(generation: number): ProfileHttpsImportAuthorityFailure | null {
    if (this.session.isStale()) return "stale";
    if (generation < this.session.getGeneration()) return "stale";
    if (generation > this.session.getGeneration()) return "wrong-generation";
    return null;
  }

  private saveSessionGenerationFailure(
    generation: number,
  ): ProfileHttpsImportAuthorityFailure | null {
    if (this.session.isStale()) return "stale";
    return generation === this.session.getGeneration() ? null : "wrong-generation";
  }

  private previewRequestFailure(
    kind: ProfileHttpsImportAuthorityFailure,
    generation: number,
  ): ProfileHttpsImportPreviewRequestResult {
    this.trace({
      generation,
      kind: "preview",
      phase: "result",
      requestSequence: null,
      result: kind,
      schemaVersion: PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      sourceType: null,
    });
    return { kind, request: null };
  }

  private previewResultFailure(
    kind: ProfileHttpsImportAuthorityFailure,
    generation: number,
    requestSequence: number | null,
    preview: ProfilePreviewDto | null,
  ): ProfileHttpsImportPreviewResult {
    this.trace({
      generation,
      kind: "preview",
      phase: "result",
      requestSequence,
      result: kind,
      schemaVersion: PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      sourceType: preview?.sourceType ?? null,
    });
    return { authority: null, kind };
  }

  private saveFailure(
    kind: ProfileHttpsImportAuthorityFailure,
    generation: number,
    preview: ProfilePreviewDto | null,
  ): ProfileHttpsImportSaveResult {
    this.trace({
      generation,
      kind: "save",
      phase: "result",
      requestSequence: this.accepted?.requestSequence ?? null,
      result: kind,
      schemaVersion: PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION,
      sourceType: preview?.sourceType ?? null,
    });
    return { authority: null, kind };
  }

  private trace(event: ProfileHttpsImportTraceEvent): void {
    this.options.trace?.(event);
  }
}

function parseGeneration(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function parseScope(value: unknown): ApplicationSnapshotOrderDto | null {
  const parsed = ApplicationSnapshotOrderSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function parseRequest(value: unknown): ProfileHttpsImportPreviewRequest | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (
    Object.keys(candidate).sort().join("\u0000") !== "generation\u0000requestSequence\u0000scope"
  ) {
    return null;
  }
  const generation = parseGeneration(candidate.generation);
  const requestSequence = parseRequestSequence(value);
  const scope = parseScope(candidate.scope);
  if (generation === null || requestSequence === null || !scope) return null;
  return { generation, requestSequence, scope: structuredClone(scope) };
}

function parseRequestSequence(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const sequence = (value as Record<string, unknown>).requestSequence;
  return typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence >= 1
    ? sequence
    : null;
}

function sameScope(left: ApplicationSnapshotOrderDto, right: ApplicationSnapshotOrderDto): boolean {
  return (
    left.authorityId === right.authorityId &&
    left.epoch === right.epoch &&
    left.order === right.order
  );
}

function samePreview(left: ProfilePreviewDto, right: ProfilePreviewDto): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map(
        (key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`,
      )
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function increment(value: number): number {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("Profile HTTPS import request sequence exhausted");
  }
  return value + 1;
}

function validateTraceEvent(event: ProfileHttpsImportTraceEvent): void {
  if (event.schemaVersion !== PROFILE_HTTPS_IMPORT_TRANSCRIPT_SCHEMA_VERSION) {
    throw new TypeError("Unsupported Profile HTTPS import transcript schema");
  }
  if (
    !Number.isSafeInteger(event.generation) ||
    event.generation < 0 ||
    (event.requestSequence !== null &&
      (!Number.isSafeInteger(event.requestSequence) || event.requestSequence < 1))
  ) {
    throw new TypeError("Malformed Profile HTTPS import transcript authority");
  }
  if (
    (event.phase === "invocation" && event.result !== null) ||
    (event.phase === "result" && event.result === null)
  ) {
    throw new TypeError("Malformed Profile HTTPS import transcript result");
  }
  if (
    event.sourceType !== null &&
    event.sourceType !== "https" &&
    event.sourceType !== "local-file"
  ) {
    throw new TypeError("Malformed Profile HTTPS import transcript source");
  }
}
