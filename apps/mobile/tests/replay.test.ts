import { describe, expect, it } from "vitest";

import {
  detectRuntimeCapabilities,
  replayAsyncIterableCancellation,
  replayDomainActor,
  replayOrpcTransport,
} from "../src/capabilities.js";
import { RnTranscript, replayRnTranscript } from "../src/transcript.js";

describe("RN host deterministic replay", () => {
  it("covers shared transport cancellation and reconnect without a socket", () => {
    const transcript = new RnTranscript();
    const result = replayOrpcTransport(transcript);

    expect(result).toEqual({ cancelled: true, reconnected: true });
    expect(transcript.events.map((event) => event.operation)).toEqual([
      "orpc.connect",
      "orpc.cancel",
      "orpc.connect",
      "orpc.cleanup",
    ]);
    expect(replayRnTranscript(transcript.snapshot())).toBe(4);
  });

  it("cancels an async iterator into Query and completes a real XState actor", async () => {
    const transcript = new RnTranscript();
    const iterable = await replayAsyncIterableCancellation(transcript);
    const actor = await replayDomainActor(transcript);

    expect(iterable).toEqual({
      abortObserved: true,
      iteratorReturned: true,
      querySinkSelected: true,
    });
    expect(actor).toBe(true);
    expect(transcript.events.some((event) => event.operation === "actor.transition")).toBe(true);
    expect(detectRuntimeCapabilities().asyncIterator).toBe(true);
  });
});
