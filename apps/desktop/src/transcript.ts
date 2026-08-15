/**
 * Bounded semantic evidence for the Electron host boundary.
 *
 * Authentication data, paths, URLs, raw Electron messages, renderer payloads,
 * and platform observations are intentionally absent. The same closed record
 * is safe to replay in unit tests and in an isolated fixture process.
 */
export const ELECTRON_TRANSCRIPT_SCHEMA_VERSION = 1 as const;

export type ElectronTranscriptOperation =
  | "window.create"
  | "renderer.bootstrap"
  | "orpc.handshake"
  | "orpc.invoke"
  | "orpc.events"
  | "renderer.store"
  | "application.quit";

export type ElectronTranscriptEffect = "invocation" | "result" | "event" | "cleanup";

export type ElectronTranscriptResult =
  | "accepted"
  | "ready"
  | "event"
  | "cleaned-up"
  | "disconnected"
  | "deadline-exceeded"
  | "oversized"
  | "quit"
  | "rejected"
  | "stale";

export interface ElectronTranscriptEvent {
  readonly schemaVersion: typeof ELECTRON_TRANSCRIPT_SCHEMA_VERSION;
  readonly authority: "electron-host";
  readonly operation: ElectronTranscriptOperation;
  readonly effect: ElectronTranscriptEffect;
  readonly result: ElectronTranscriptResult;
  readonly correlationId: string;
  readonly logicalTime: number;
}

const SYNTHETIC_CORRELATION = /^electron-[0-9]{4,}$/u;
const OPERATIONS = new Set<ElectronTranscriptOperation>([
  "window.create",
  "renderer.bootstrap",
  "orpc.handshake",
  "orpc.invoke",
  "orpc.events",
  "renderer.store",
  "application.quit",
]);
const EFFECTS = new Set<ElectronTranscriptEffect>(["invocation", "result", "event", "cleanup"]);
const RESULTS = new Set<ElectronTranscriptResult>([
  "accepted",
  "ready",
  "event",
  "cleaned-up",
  "disconnected",
  "deadline-exceeded",
  "oversized",
  "quit",
  "rejected",
  "stale",
]);
const EVENT_KEYS = new Set([
  "schemaVersion",
  "authority",
  "operation",
  "effect",
  "result",
  "correlationId",
  "logicalTime",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertEvent(value: unknown): asserts value is ElectronTranscriptEvent {
  if (!isRecord(value) || Object.keys(value).some((key) => !EVENT_KEYS.has(key))) {
    throw new Error("Invalid Electron transcript fields");
  }
  if (
    value.schemaVersion !== ELECTRON_TRANSCRIPT_SCHEMA_VERSION ||
    value.authority !== "electron-host" ||
    typeof value.operation !== "string" ||
    !OPERATIONS.has(value.operation as ElectronTranscriptOperation) ||
    typeof value.effect !== "string" ||
    !EFFECTS.has(value.effect as ElectronTranscriptEffect) ||
    typeof value.result !== "string" ||
    !RESULTS.has(value.result as ElectronTranscriptResult) ||
    typeof value.correlationId !== "string" ||
    !SYNTHETIC_CORRELATION.test(value.correlationId) ||
    typeof value.logicalTime !== "number" ||
    !Number.isSafeInteger(value.logicalTime) ||
    value.logicalTime < 1
  ) {
    throw new Error("Invalid Electron transcript event");
  }
}

export interface ElectronTranscriptReplay {
  readonly events: readonly ElectronTranscriptEvent[];
  readonly logicalTime: number;
}

export class ElectronTranscript {
  readonly #maxEvents: number;
  readonly #events: ElectronTranscriptEvent[] = [];
  #logicalTime = 0;

  constructor(maxEvents = 128) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 256) {
      throw new RangeError("Electron transcript maxEvents must be between 1 and 256");
    }
    this.#maxEvents = maxEvents;
  }

  record(
    event: Omit<ElectronTranscriptEvent, "authority" | "logicalTime" | "schemaVersion">,
  ): void {
    this.#logicalTime += 1;
    const complete: ElectronTranscriptEvent = {
      schemaVersion: ELECTRON_TRANSCRIPT_SCHEMA_VERSION,
      authority: "electron-host",
      logicalTime: this.#logicalTime,
      ...event,
    };
    assertEvent(complete);
    this.#events.push(complete);
    if (this.#events.length > this.#maxEvents) {
      this.#events.splice(0, this.#events.length - this.#maxEvents);
    }
  }

  snapshot(): readonly ElectronTranscriptEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }

  serialize(): string {
    return JSON.stringify(this.snapshot());
  }
}

export function replayElectronTranscript(
  events: readonly ElectronTranscriptEvent[],
): ElectronTranscriptReplay {
  let logicalTime = 0;
  for (const event of events) {
    assertEvent(event);
    if (event.logicalTime <= logicalTime) {
      throw new Error("Electron transcript logical time must increase");
    }
    logicalTime = event.logicalTime;
  }
  return {
    events: events.map((event) => ({ ...event })),
    logicalTime,
  };
}

export function electronCorrelation(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > 9_999) {
    throw new RangeError("Electron transcript correlation is out of bounds");
  }
  return `electron-${String(index).padStart(4, "0")}`;
}
