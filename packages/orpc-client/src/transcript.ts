/**
 * A bounded semantic record of session decisions. Wire payloads are
 * deliberately not part of this shape: authentication material, URLs, body
 * values, and platform output must never enter replay evidence.
 */
export const ORPC_TRANSCRIPT_SCHEMA_VERSION = 1 as const;

export type OrpcTransportKind = "message-port" | "websocket";

export type OrpcTranscriptOperation =
  | "application.events.watch"
  | "application.invoke.profile.refresh"
  | "application.invoke.status.snapshot"
  | "session.handshake"
  | "transport.connect"
  | "transport.disconnect"
  | "transport.reconnect";

export type OrpcTranscriptEffect = "cancellation" | "cleanup" | "event" | "invocation" | "result";

export type OrpcTranscriptResult =
  | "accepted"
  | "cancelled"
  | "cleaned-up"
  | "deadline-exceeded"
  | "disconnected"
  | "oversized"
  | "reconnected"
  | "rejected"
  | "stale";

export interface OrpcTranscriptEvent {
  readonly authority: "mish-orpc-session";
  readonly connectionEpoch: number;
  readonly correlationId: string;
  readonly effect: OrpcTranscriptEffect;
  readonly logicalTime: number;
  readonly operation: OrpcTranscriptOperation;
  readonly parentEpoch: number;
  readonly revision: number;
  readonly schemaVersion: typeof ORPC_TRANSCRIPT_SCHEMA_VERSION;
  readonly sequence?: number;
  readonly sessionGeneration: number;
  readonly sessionId: string;
  readonly result: OrpcTranscriptResult;
  readonly transport: OrpcTransportKind;
}

export interface BoundedTranscriptOptions {
  readonly maxEvents?: number;
  readonly sessionId?: string;
}

export interface TranscriptRecord {
  readonly connectionEpoch: number;
  readonly correlationId: string;
  readonly effect: OrpcTranscriptEffect;
  readonly operation: OrpcTranscriptOperation;
  readonly parentEpoch: number;
  readonly revision: number;
  readonly sequence?: number;
  readonly sessionGeneration: number;
  readonly result: OrpcTranscriptResult;
  readonly transport: OrpcTransportKind;
}

export interface TranscriptReplay {
  readonly events: readonly OrpcTranscriptEvent[];
  readonly logicalTime: number;
}

const SYNTHETIC_SESSION_ID = /^orpc-session-[0-9]{4,}$/u;
const SYNTHETIC_CORRELATION_ID = /^orpc-correlation-[0-9]{4,}$/u;
const TRANSCRIPT_KEYS = new Set([
  "authority",
  "connectionEpoch",
  "correlationId",
  "effect",
  "logicalTime",
  "operation",
  "parentEpoch",
  "revision",
  "result",
  "schemaVersion",
  "sequence",
  "sessionGeneration",
  "sessionId",
  "transport",
]);
const TRANSCRIPT_TRANSPORTS = new Set<OrpcTransportKind>(["message-port", "websocket"]);
const TRANSCRIPT_OPERATIONS = new Set<OrpcTranscriptOperation>([
  "application.events.watch",
  "application.invoke.profile.refresh",
  "application.invoke.status.snapshot",
  "session.handshake",
  "transport.connect",
  "transport.disconnect",
  "transport.reconnect",
]);
const TRANSCRIPT_EFFECTS = new Set<OrpcTranscriptEffect>([
  "cancellation",
  "cleanup",
  "event",
  "invocation",
  "result",
]);
const TRANSCRIPT_RESULTS = new Set<OrpcTranscriptResult>([
  "accepted",
  "cancelled",
  "cleaned-up",
  "deadline-exceeded",
  "disconnected",
  "oversized",
  "reconnected",
  "rejected",
  "stale",
]);

function isCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function isPositiveCounter(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function assertTranscriptEvent(event: OrpcTranscriptEvent): void {
  if (Object.keys(event).some((key) => !TRANSCRIPT_KEYS.has(key))) {
    throw new Error("Invalid oRPC transcript fields");
  }
  if (
    event.schemaVersion !== ORPC_TRANSCRIPT_SCHEMA_VERSION ||
    event.authority !== "mish-orpc-session" ||
    !SYNTHETIC_SESSION_ID.test(event.sessionId) ||
    !SYNTHETIC_CORRELATION_ID.test(event.correlationId)
  ) {
    throw new Error("Invalid oRPC transcript identity");
  }
  if (
    !TRANSCRIPT_TRANSPORTS.has(event.transport) ||
    !TRANSCRIPT_OPERATIONS.has(event.operation) ||
    !TRANSCRIPT_EFFECTS.has(event.effect) ||
    !TRANSCRIPT_RESULTS.has(event.result)
  ) {
    throw new Error("Invalid oRPC transcript vocabulary");
  }
  if (
    !isCounter(event.connectionEpoch) ||
    !isCounter(event.sessionGeneration) ||
    !isCounter(event.parentEpoch) ||
    !isCounter(event.revision) ||
    !isPositiveCounter(event.logicalTime)
  ) {
    throw new Error("Invalid oRPC transcript counter");
  }
  if (event.sequence !== undefined && !isPositiveCounter(event.sequence)) {
    throw new Error("Invalid oRPC transcript sequence");
  }
}

/**
 * Keeps a recent, schema-checked semantic window. The default identity is
 * deterministic so tests never need random or host-derived identifiers.
 */
export class BoundedTranscript {
  readonly #maxEvents: number;
  readonly #sessionId: string;
  readonly #events: OrpcTranscriptEvent[] = [];
  #logicalTime = 0;

  constructor(options: BoundedTranscriptOptions = {}) {
    const maxEvents = options.maxEvents ?? 64;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 256) {
      throw new Error("Transcript maxEvents must be between 1 and 256");
    }
    const sessionId = options.sessionId ?? "orpc-session-0001";
    if (!SYNTHETIC_SESSION_ID.test(sessionId)) {
      throw new Error("Transcript session ids must be synthetic");
    }
    this.#maxEvents = maxEvents;
    this.#sessionId = sessionId;
  }

  record(event: TranscriptRecord): void {
    this.#logicalTime += 1;
    const complete: OrpcTranscriptEvent = {
      schemaVersion: ORPC_TRANSCRIPT_SCHEMA_VERSION,
      authority: "mish-orpc-session",
      connectionEpoch: event.connectionEpoch,
      correlationId: event.correlationId,
      effect: event.effect,
      logicalTime: this.#logicalTime,
      operation: event.operation,
      parentEpoch: event.parentEpoch,
      revision: event.revision,
      sequence: event.sequence,
      sessionGeneration: event.sessionGeneration,
      sessionId: this.#sessionId,
      result: event.result,
      transport: event.transport,
    };
    assertTranscriptEvent(complete);
    this.#events.push(complete);
    if (this.#events.length > this.#maxEvents) {
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }
  }

  snapshot(): readonly OrpcTranscriptEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }

  toJSON(): readonly OrpcTranscriptEvent[] {
    return this.snapshot();
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }
}

/**
 * Replays only the closed semantic facts. This is intentionally independent
 * from a transport implementation and therefore safe to run in CI.
 */
export function replayTranscript(events: readonly OrpcTranscriptEvent[]): TranscriptReplay {
  let previousLogicalTime = 0;
  for (const event of events) {
    assertTranscriptEvent(event);
    if (event.logicalTime <= previousLogicalTime) {
      throw new Error("Transcript logical time must be strictly increasing");
    }
    previousLogicalTime = event.logicalTime;
  }
  return {
    events: events.map((event) => ({ ...event })),
    logicalTime: previousLogicalTime,
  };
}
