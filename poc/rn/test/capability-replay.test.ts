import { describe, expect, it } from "vitest";

import {
  detectRuntimeCapabilities,
  replayAsyncIterableCancellation,
  replayWebSocketCancellation,
} from "../src/capabilities.ts";
import { replayXStateActor } from "../src/xstate.ts";
import { RnTranscript, parseRnTranscript } from "../src/transcript.ts";

describe("React Native capability boundary", () => {
  it("detects optional host globals without assuming browser primitives", () => {
    const capabilities = detectRuntimeCapabilities();
    expect(typeof capabilities.asyncIterator).toBe("boolean");
    expect(typeof capabilities.structuredClone).toBe("boolean");
    expect(typeof capabilities.readableStream).toBe("boolean");
    expect(typeof capabilities.textEncoder).toBe("boolean");
    expect(typeof capabilities.messagePort).toBe("boolean");
  });

  it("replays WebSocket cancellation and reconnect through the oRPC channel seam", () => {
    const transcript = new RnTranscript();
    expect(replayWebSocketCancellation(transcript)).toEqual({
      cancelled: true,
      reconnected: true,
    });
    expect(transcript.events.map((event) => event.effect)).toEqual([
      "websocket.connect",
      "websocket.cancel",
      "websocket.reconnect",
    ]);
  });

  it("returns the iterator and selects the Query sink when AbortSignal cancels", async () => {
    const transcript = new RnTranscript();
    await expect(replayAsyncIterableCancellation(transcript)).resolves.toEqual({
      abortObserved: true,
      iteratorReturned: true,
      querySinkSelected: true,
    });
    expect(transcript.events.map((event) => event.result)).toEqual(["cancelled", "cleaned-up"]);
  });

  it("starts a real XState v5 actor with deterministic effects", () => {
    const transcript = new RnTranscript();
    expect(replayXStateActor(transcript)).toBe(true);
    expect(transcript.events).toEqual([
      expect.objectContaining({ effect: "xstate.actor", result: "replayed" }),
    ]);
  });

  it("rejects unknown replay fields and remains bounded", () => {
    const transcript = new RnTranscript();
    transcript.record("websocket.connect", "accepted");
    expect(parseRnTranscript(transcript.events)).toHaveLength(1);
    expect(() =>
      parseRnTranscript([{ ...transcript.events[0], secret: "rejected" }]),
    ).toThrow(/invalid RN transcript/);
    for (let index = 0; index < 63; index += 1) {
      transcript.record("store.subscribe", "accepted");
    }
    expect(transcript.events).toHaveLength(64);
    expect(() => transcript.record("renderer.mount", "accepted")).toThrow(/limit/);
  });
});
