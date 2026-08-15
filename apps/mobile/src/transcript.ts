/**
 * Closed semantic evidence for the React Native host.
 *
 * This record contains only synthetic identities, bounded lifecycle facts, and
 * logical time. Authentication material, URLs, payloads, device state, and
 * native output are intentionally not representable.
 */

export const RN_TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const RN_TRANSCRIPT_LIMIT = 128 as const;

export const RN_TRANSCRIPT_OPERATIONS = [
  "renderer.mount",
  "renderer.cleanup",
  "renderer.remount",
  "store.subscribe",
  "store.batch",
  "native.capabilities",
  "orpc.connect",
  "orpc.handshake",
  "orpc.invoke",
  "orpc.events",
  "orpc.cancel",
  "orpc.cleanup",
  "query.write",
  "actor.transition",
] as const;
export type RnTranscriptOperation = (typeof RN_TRANSCRIPT_OPERATIONS)[number];

export const RN_TRANSCRIPT_EFFECTS = [
  "invocation",
  "result",
  "event",
  "cancellation",
  "cleanup",
  "transition",
] as const;
export type RnTranscriptEffect = (typeof RN_TRANSCRIPT_EFFECTS)[number];

export const RN_TRANSCRIPT_RESULTS = [
  "accepted",
  "success",
  "pending",
  "event",
  "available",
  "unavailable",
  "cancelled",
  "cleaned-up",
  "reconnected",
  "stale",
  "rejected",
] as const;
export type RnTranscriptResult = (typeof RN_TRANSCRIPT_RESULTS)[number];

export interface RnTranscriptEvent {
  readonly schemaVersion: typeof RN_TRANSCRIPT_SCHEMA_VERSION;
  readonly authority: "rn-host";
  readonly connectionEpoch: number;
  readonly generation: number;
  readonly index: number;
  readonly logicalTime: number;
  readonly operation: RnTranscriptOperation;
  readonly revision: number;
  readonly effect: RnTranscriptEffect;
  readonly result: RnTranscriptResult;
}

const EVENT_KEYS = new Set([
  "schemaVersion",
  "authority",
  "connectionEpoch",
  "generation",
  "index",
  "logicalTime",
  "operation",
  "revision",
  "effect",
  "result",
]);

const hasOnlyKeys = (value: Record<string, unknown>): boolean =>
  Object.keys(value).every((key) => EVENT_KEYS.has(key));

const isCounter = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

const isEnum = <T extends readonly string[]>(values: T, value: unknown): value is T[number] =>
  typeof value === "string" && (values as readonly string[]).includes(value);

/** A bounded transcript whose logical clock advances only on recorded facts. */
export class RnTranscript {
  readonly #events: RnTranscriptEvent[] = [];
  #logicalTime = 0;

  get events(): readonly RnTranscriptEvent[] {
    return this.#events;
  }

  record(
    operation: RnTranscriptOperation,
    effect: RnTranscriptEffect,
    result: RnTranscriptResult,
    metadata: Partial<Pick<RnTranscriptEvent, "connectionEpoch" | "generation" | "revision">> = {},
  ): RnTranscriptEvent {
    if (this.#events.length >= RN_TRANSCRIPT_LIMIT) {
      throw new Error(`RN transcript limit ${RN_TRANSCRIPT_LIMIT} exceeded`);
    }
    const connectionEpoch = metadata.connectionEpoch ?? 1;
    const generation = metadata.generation ?? 1;
    const revision = metadata.revision ?? 1;
    if (![connectionEpoch, generation, revision].every((value) => isCounter(value) && value > 0)) {
      throw new Error("RN transcript identities must be positive safe integers");
    }
    const event: RnTranscriptEvent = {
      schemaVersion: RN_TRANSCRIPT_SCHEMA_VERSION,
      authority: "rn-host",
      connectionEpoch,
      generation,
      index: this.#events.length,
      logicalTime: ++this.#logicalTime,
      operation,
      revision,
      effect,
      result,
    };
    this.#events.push(event);
    return event;
  }

  snapshot(): readonly RnTranscriptEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }
}

/** Parse replay evidence while rejecting unknown fields and non-monotonic time. */
export function parseRnTranscript(value: unknown): readonly RnTranscriptEvent[] {
  if (!Array.isArray(value) || value.length > RN_TRANSCRIPT_LIMIT) {
    throw new Error("invalid or oversized RN transcript");
  }
  let previousLogicalTime = 0;
  return value.map((candidate, index) => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      !hasOnlyKeys(candidate as Record<string, unknown>)
    ) {
      throw new Error("invalid RN transcript event");
    }
    const event = candidate as Record<string, unknown>;
    if (
      event.schemaVersion !== RN_TRANSCRIPT_SCHEMA_VERSION ||
      event.authority !== "rn-host" ||
      event.index !== index ||
      !isCounter(event.connectionEpoch) ||
      event.connectionEpoch < 1 ||
      !isCounter(event.generation) ||
      event.generation < 1 ||
      !isCounter(event.revision) ||
      event.revision < 1 ||
      !isCounter(event.logicalTime) ||
      event.logicalTime <= previousLogicalTime ||
      !isEnum(RN_TRANSCRIPT_OPERATIONS, event.operation) ||
      !isEnum(RN_TRANSCRIPT_EFFECTS, event.effect) ||
      !isEnum(RN_TRANSCRIPT_RESULTS, event.result)
    ) {
      throw new Error("invalid RN transcript event");
    }
    previousLogicalTime = event.logicalTime;
    return event as unknown as RnTranscriptEvent;
  });
}

export function replayRnTranscript(events: readonly RnTranscriptEvent[]): number {
  return parseRnTranscript(events).at(-1)?.logicalTime ?? 0;
}
