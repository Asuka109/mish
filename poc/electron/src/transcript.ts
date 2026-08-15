/**
 * A closed, bounded transcript for the Electron admission fixture.
 *
 * Only synthetic identities and closed result kinds are admitted. Request
 * bodies, authentication material, paths, URLs, and raw Electron messages are
 * deliberately absent from this schema.
 */
export const TRANSCRIPT_SCHEMA_VERSION = 1 as const;

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
  | "quit"
  | "rejected";

export interface ElectronTranscriptEvent {
  readonly schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly authority: "electron-fixture";
  readonly operation: ElectronTranscriptOperation;
  readonly effect: ElectronTranscriptEffect;
  readonly result: ElectronTranscriptResult;
  readonly correlationId: string;
  readonly logicalTime: number;
}

const SYNTHETIC_CORRELATION = /^electron-[0-9]{4,}$/u;

function assertEvent(event: ElectronTranscriptEvent): void {
  if (
    event.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION ||
    event.authority !== "electron-fixture" ||
    !SYNTHETIC_CORRELATION.test(event.correlationId) ||
    !Number.isSafeInteger(event.logicalTime) ||
    event.logicalTime < 1
  ) {
    throw new Error("Invalid Electron admission transcript event");
  }
}

export class ElectronTranscript {
  readonly #maxEvents: number;
  readonly #events: ElectronTranscriptEvent[] = [];
  #logicalTime = 0;

  constructor(maxEvents = 128) {
    if (!Number.isSafeInteger(maxEvents) || maxEvents < 1 || maxEvents > 256) {
      throw new Error("Electron transcript maxEvents must be between 1 and 256");
    }
    this.#maxEvents = maxEvents;
  }

  record(
    event: Omit<ElectronTranscriptEvent, "authority" | "logicalTime" | "schemaVersion">,
  ): void {
    this.#logicalTime += 1;
    const complete: ElectronTranscriptEvent = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      authority: "electron-fixture",
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

export function correlation(index: number): string {
  if (!Number.isSafeInteger(index) || index < 1 || index > 9999) {
    throw new Error("Electron correlation index is out of bounds");
  }
  return `electron-${String(index).padStart(4, "0")}`;
}
