import { describe, expect, it } from "vitest";

import {
  ElectronTranscript,
  electronCorrelation,
  replayElectronTranscript,
} from "../src/transcript.js";

describe("Electron transcript boundary", () => {
  it("bounds, validates, and replays semantic evidence without credentials", () => {
    const transcript = new ElectronTranscript(2);
    transcript.record({
      operation: "window.create",
      effect: "invocation",
      result: "accepted",
      correlationId: electronCorrelation(1),
    });
    transcript.record({
      operation: "renderer.bootstrap",
      effect: "event",
      result: "ready",
      correlationId: electronCorrelation(2),
    });
    transcript.record({
      operation: "application.quit",
      effect: "result",
      result: "quit",
      correlationId: electronCorrelation(3),
    });
    const events = transcript.snapshot();
    expect(events).toHaveLength(2);
    expect(events[0]?.schemaVersion).toBe(1);
    expect(replayElectronTranscript(events).logicalTime).toBe(3);
    expect(transcript.serialize()).not.toContain("fixture-token");
    expect(() =>
      transcript.record({
        operation: "window.create",
        effect: "result",
        result: "accepted",
        correlationId: "real-path",
      }),
    ).toThrow("Invalid Electron transcript event");
  });

  it("rejects malformed replay records and out-of-bound synthetic IDs", () => {
    const transcript = new ElectronTranscript(4);
    transcript.record({
      operation: "window.create",
      effect: "invocation",
      result: "accepted",
      correlationId: electronCorrelation(1),
    });
    const event = transcript.snapshot()[0]!;
    expect(() =>
      replayElectronTranscript([{ ...event, logicalTime: event.logicalTime }]),
    ).not.toThrow();
    expect(() =>
      replayElectronTranscript([
        event,
        { ...event, logicalTime: event.logicalTime, correlationId: electronCorrelation(2) },
      ]),
    ).toThrow("Electron transcript logical time must increase");
    expect(() => electronCorrelation(0)).toThrow(
      "Electron transcript correlation is out of bounds",
    );
    expect(() => electronCorrelation(10_000)).toThrow(
      "Electron transcript correlation is out of bounds",
    );
  });

  it("replays operation-matched projection invocation and result records", () => {
    const transcript = new ElectronTranscript();
    transcript.record({
      operation: "orpc.invoke",
      effect: "invocation",
      result: "accepted",
      correlationId: electronCorrelation(1),
    });
    transcript.record({
      operation: "projection.status.snapshot",
      effect: "result",
      result: "projection-degraded",
      correlationId: electronCorrelation(2),
    });
    transcript.record({
      operation: "projection.routes.snapshot",
      effect: "result",
      result: "projection-empty",
      correlationId: electronCorrelation(3),
    });
    transcript.record({
      operation: "projection.settings.snapshot",
      effect: "result",
      result: "projection-owned",
      correlationId: electronCorrelation(4),
    });

    const replay = replayElectronTranscript(transcript.snapshot());
    expect(replay.events.map((event) => event.operation)).toEqual([
      "orpc.invoke",
      "projection.status.snapshot",
      "projection.routes.snapshot",
      "projection.settings.snapshot",
    ]);
    expect(transcript.serialize()).not.toMatch(/token|password|\/Users\//u);
  });
});
