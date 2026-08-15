/**
 * A bounded, replay-friendly transcript for this POC.
 *
 * The transcript is deliberately an allow-list. It records protocol decisions
 * and synthetic identifiers, never request bodies, authentication material,
 * URLs, or raw wire messages.
 */

export const TRANSCRIPT_SCHEMA_VERSION = 1 as const;

export type TranscriptTransport = "websocket" | "message-port";

export type TranscriptOperation =
  | "session.handshake"
  | "invoke.status.snapshot"
  | "invoke.profile.refresh"
  | "events.watch"
  | "transport.connect"
  | "transport.disconnect"
  | "transport.reconnect";

export type TranscriptEffect = "invocation" | "result" | "event" | "cancellation" | "cleanup";

export type TranscriptResult =
  | "accepted"
  | "rejected"
  | "stale"
  | "deadline-exceeded"
  | "cancelled"
  | "oversized"
  | "disconnected"
  | "reconnected"
  | "cleaned-up";

export interface TranscriptEvent {
  readonly schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly authority: "poc";
  readonly transport: TranscriptTransport;
  readonly operation: TranscriptOperation;
  readonly effect: TranscriptEffect;
  readonly result: TranscriptResult;
  readonly correlationId: string;
  readonly sessionGeneration: number;
  readonly logicalTime: number;
  readonly bytes?: number;
}

export interface TranscriptOptions {
  readonly maxEvents?: number;
  readonly transport: TranscriptTransport;
}

const CORRELATION_ID = /^poc-[0-9]{4,}$/;

function isPositiveInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value > 0;
}

function assertEvent(event: TranscriptEvent): void {
  if (event.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION || event.authority !== "poc") {
    throw new Error("Invalid transcript schema");
  }
  if (!CORRELATION_ID.test(event.correlationId)) {
    throw new Error("Transcript correlation ids must be synthetic");
  }
  if (!isPositiveInteger(event.sessionGeneration) || !isPositiveInteger(event.logicalTime)) {
    throw new Error("Transcript counters must be positive integers");
  }
  if (event.bytes !== undefined && (!Number.isSafeInteger(event.bytes) || event.bytes < 0)) {
    throw new Error("Transcript byte counts must be bounded integers");
  }
}

/**
 * Keeps only the most recent bounded number of protocol facts.
 *
 * `snapshot` returns copies so callers cannot mutate the evidence after it has
 * been observed by a test or a replay harness.
 */
export class BoundedTranscript {
  readonly #maxEvents: number;
  readonly #transport: TranscriptTransport;
  readonly #events: TranscriptEvent[] = [];
  #logicalTime = 0;

  constructor(options: TranscriptOptions) {
    const maxEvents = options.maxEvents ?? 64;
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 256) {
      throw new Error("Transcript maxEvents must be between 1 and 256");
    }
    this.#maxEvents = maxEvents;
    this.#transport = options.transport;
  }

  record(
    event: Omit<TranscriptEvent, "authority" | "logicalTime" | "schemaVersion" | "transport"> &
      Partial<Pick<TranscriptEvent, "bytes">>,
  ): void {
    this.#logicalTime += 1;
    const complete: TranscriptEvent = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      authority: "poc",
      transport: this.#transport,
      logicalTime: this.#logicalTime,
      ...event,
    };
    assertEvent(complete);
    this.#events.push(complete);
    if (this.#events.length > this.#maxEvents) {
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }
  }

  snapshot(): readonly TranscriptEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }

  toJSON(): readonly TranscriptEvent[] {
    return this.snapshot();
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }
}
