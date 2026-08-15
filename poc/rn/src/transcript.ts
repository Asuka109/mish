/**
 * Closed semantic evidence for the React Native admission fixture.
 *
 * The transcript is deliberately independent of Android, a device, a URL,
 * profile data, credentials, and wall-clock time. It describes only the
 * deterministic capability and renderer decisions exercised by this POC.
 */

export const RN_TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const RN_TRANSCRIPT_LIMIT = 64 as const;

export const RN_EFFECTS = [
  "renderer.mount",
  "renderer.cleanup",
  "store.subscribe",
  "store.batch",
  "store.remount",
  "websocket.connect",
  "websocket.cancel",
  "websocket.reconnect",
  "abort.signal",
  "async-iterator.return",
  "native.capabilities",
  "xstate.actor",
] as const;
export type RnEffect = (typeof RN_EFFECTS)[number];

export const RN_RESULTS = [
  "accepted",
  "success",
  "cancelled",
  "reconnected",
  "cleaned-up",
  "available",
  "unavailable",
  "replayed",
] as const;
export type RnResult = (typeof RN_RESULTS)[number];

export interface RnTranscriptEvent {
  readonly schemaVersion: typeof RN_TRANSCRIPT_SCHEMA_VERSION;
  readonly index: number;
  readonly effect: RnEffect;
  readonly result: RnResult;
  readonly logicalTime: number;
  readonly authority: "rn-poc";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isEnum = <T extends readonly string[]>(values: T, value: unknown): value is T[number] =>
  typeof value === "string" && (values as readonly string[]).includes(value);

const EVENT_KEYS = new Set([
  "schemaVersion",
  "index",
  "effect",
  "result",
  "logicalTime",
  "authority",
]);

/** A bounded transcript with logical time and a closed vocabulary. */
export class RnTranscript {
  readonly #events: RnTranscriptEvent[] = [];
  #logicalTime = 0;

  get events(): readonly RnTranscriptEvent[] {
    return this.#events;
  }

  record(effect: RnEffect, result: RnResult): RnTranscriptEvent {
    if (this.#events.length >= RN_TRANSCRIPT_LIMIT) {
      throw new Error(`RN transcript limit ${RN_TRANSCRIPT_LIMIT} exceeded`);
    }
    this.#logicalTime += 1;
    const event: RnTranscriptEvent = {
      schemaVersion: RN_TRANSCRIPT_SCHEMA_VERSION,
      index: this.#events.length,
      effect,
      result,
      logicalTime: this.#logicalTime,
      authority: "rn-poc",
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

/** Parse replay evidence while rejecting unknown fields and invalid order. */
export function parseRnTranscript(value: unknown): readonly RnTranscriptEvent[] {
  if (!Array.isArray(value) || value.length > RN_TRANSCRIPT_LIMIT) {
    throw new Error("invalid or oversized RN transcript");
  }

  let previousLogicalTime = 0;
  return value.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      [...Object.keys(candidate)].some((key) => !EVENT_KEYS.has(key)) ||
      candidate.schemaVersion !== RN_TRANSCRIPT_SCHEMA_VERSION ||
      candidate.index !== index ||
      candidate.authority !== "rn-poc" ||
      !isEnum(RN_EFFECTS, candidate.effect) ||
      !isEnum(RN_RESULTS, candidate.result) ||
      !Number.isSafeInteger(candidate.logicalTime) ||
      (candidate.logicalTime as number) <= previousLogicalTime
    ) {
      throw new Error("invalid RN transcript event");
    }
    previousLogicalTime = candidate.logicalTime as number;
    return candidate as unknown as RnTranscriptEvent;
  });
}
