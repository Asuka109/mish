import { describe, expect, it } from "vitest";

import {
  RN_TRANSCRIPT_LIMIT,
  RnTranscript,
  parseRnTranscript,
  replayRnTranscript,
} from "../src/transcript.js";

describe("RN host transcript", () => {
  it("round-trips bounded semantic evidence and replays its logical clock", () => {
    const transcript = new RnTranscript();
    transcript.record("renderer.mount", "event", "accepted");
    transcript.record("store.batch", "result", "success");
    transcript.record("orpc.invoke", "result", "success", { connectionEpoch: 2 });

    const parsed = parseRnTranscript(JSON.parse(transcript.serialize()));
    expect(parsed).toEqual(transcript.snapshot());
    expect(replayRnTranscript(parsed)).toBe(3);
    expect(parsed[2]).not.toHaveProperty("authToken");
  });

  it("rejects private fields, non-monotonic clocks, and overflow", () => {
    const transcript = new RnTranscript();
    transcript.record("renderer.mount", "event", "accepted");
    const event = transcript.snapshot()[0];

    expect(() => parseRnTranscript([{ ...event, privatePayload: "must-not-be-recorded" }])).toThrow(
      "invalid RN transcript event",
    );
    expect(() => parseRnTranscript([{ ...event, logicalTime: 0 }])).toThrow(
      "invalid RN transcript event",
    );

    for (let index = 1; index < RN_TRANSCRIPT_LIMIT; index += 1) {
      transcript.record("query.write", "event", "pending");
    }
    expect(transcript.events).toHaveLength(RN_TRANSCRIPT_LIMIT);
    expect(() => transcript.record("query.write", "event", "pending")).toThrow(
      "RN transcript limit 128 exceeded",
    );
  });
});
