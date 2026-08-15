import { describe, expect, it } from "vitest";

import {
  replayAsyncIterableCancellation,
  replayWebSocketCancellation,
} from "../src/capabilities.ts";
import { replayXStateActor } from "../src/xstate.ts";
import { RnTranscript } from "../src/transcript.ts";

describe("RN deterministic replay output", () => {
  it("replays the closed capability scenario", async () => {
    const transcript = new RnTranscript();
    const socket = replayWebSocketCancellation(transcript);
    const iterable = await replayAsyncIterableCancellation(transcript);
    const xstate = replayXStateActor(transcript);
    expect(socket.cancelled && socket.reconnected).toBe(true);
    expect(iterable.abortObserved && iterable.iteratorReturned && iterable.querySinkSelected).toBe(
      true,
    );
    expect(xstate).toBe(true);
    if (process.env.MISH_RN_REPLAY_OUTPUT === "1") {
      process.stdout.write(`${transcript.serialize()}\n`);
    }
  });
});
