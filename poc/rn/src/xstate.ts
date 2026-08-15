import { createActor } from "xstate";
import {
  DeterministicEffects,
  SemanticTranscript,
  runtimeMachine,
} from "@mish/poc-xstate";

import { RnTranscript } from "./transcript.ts";

/** Start/stop a real XState v5 actor without invoking a host effect. */
export function replayXStateActor(transcript: RnTranscript): boolean {
  const semanticTranscript = new SemanticTranscript();
  const actor = createActor(runtimeMachine, {
    input: {
      authority: 1,
      effects: new DeterministicEffects(semanticTranscript),
      transcript: semanticTranscript,
    },
  });
  actor.start();
  const initialState = actor.getSnapshot().value === "stopped";
  actor.stop();
  transcript.record("xstate.actor", initialState ? "replayed" : "accepted");
  return initialState;
}
