import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import {
  captureMachine,
  coreMachine,
  DeterministicEffects,
  profileMachine,
  runtimeMachine,
  SemanticTranscript,
  settingsRpcMachine,
  updaterMachine,
  vpnMachine,
  parseSemanticTranscript,
} from "../src/index.ts";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const environment = (): { transcript: SemanticTranscript; effects: DeterministicEffects } => {
  const transcript = new SemanticTranscript();
  return { transcript, effects: new DeterministicEffects(transcript) };
};

const start = <T extends Parameters<typeof createActor>[0]>(machine: T) => {
  const { transcript, effects } = environment();
  const actor = createActor(machine, { input: { transcript, effects, authority: 1 } } as never);
  actor.start();
  return { actor, effects, transcript };
};

const occurrence = (
  effects: DeterministicEffects,
  kind: Parameters<DeterministicEffects["effect"]>[0],
  index = 0,
) => effects.effect(kind, index);

describe("XState v5 actor admission", () => {
  it("admits Runtime startup, rejects illegal input, cancels with a finalizer, and disposes", async () => {
    const { actor, effects, transcript } = start(runtimeMachine);
    expect(actor.getSnapshot().value).toBe("stopped");

    actor.send({ type: "STOP" });
    expect(transcript.events.at(-1)?.result).toBe("rejected");

    actor.send({ type: "START", operation: 10 });
    const startEffect = occurrence(effects, "runtime.start");
    expect(actor.getSnapshot().value).toBe("starting");
    actor.send({ type: "CANCEL" });
    expect(effects.isCancelled(startEffect.effectId)).toBe(true);

    const stopEffect = occurrence(effects, "runtime.stop");
    effects.complete(stopEffect.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("stopped");
    expect(transcript.events.some((event) => event.result === "cancelled")).toBe(true);

    effects.completeLate(startEffect.effectId);
    actor.send({
      type: "STALE_COMPLETION",
      generation: startEffect.generation,
      operation: startEffect.operation,
      revision: startEffect.revision,
    });
    expect(transcript.events.some((event) => event.result === "stale")).toBe(true);

    actor.send({ type: "DISPOSE" });
    const disposeEffect = occurrence(effects, "runtime.dispose");
    effects.complete(disposeEffect.effectId);
    await flush();
    expect(actor.getSnapshot().status).toBe("done");
    actor.stop();
  });

  it("replaces Runtime authority and retires an old generation", async () => {
    const { actor, effects, transcript } = start(runtimeMachine);
    actor.send({ type: "START", operation: 11 });
    const runningStart = occurrence(effects, "runtime.start");
    effects.complete(runningStart.effectId);
    await flush();
    actor.send({ type: "REPLACE", operation: 12 });
    const replacementStop = occurrence(effects, "runtime.stop");
    expect(replacementStop.generation).toBeGreaterThan(runningStart.generation);
    effects.complete(replacementStop.effectId);
    await flush();
    const replacementStart = occurrence(effects, "runtime.start", 1);
    effects.complete(replacementStart.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("running");
    actor.send({
      type: "STALE_COMPLETION",
      generation: runningStart.generation,
      operation: runningStart.operation,
      revision: runningStart.revision,
    });
    expect(transcript.events.at(-1)?.result).toBe("stale");
    actor.stop();
  });

  it("aborts an invoked effect when its actor is disposed by ownership cleanup", () => {
    const { actor, effects } = start(runtimeMachine);
    actor.send({ type: "START" });
    const startEffect = occurrence(effects, "runtime.start");
    actor.stop();
    expect(effects.isCancelled(startEffect.effectId)).toBe(true);
    expect(actor.getSnapshot().status).toBe("stopped");
  });

  it("keeps Core failure explicit and recovers through a new generation", async () => {
    const { actor, effects, transcript } = start(coreMachine);
    actor.send({ type: "LAUNCH" });
    const firstLaunch = occurrence(effects, "core.launch");
    effects.fail(firstLaunch.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("failed");
    expect(
      transcript.events.some((event) => event.actor === "core" && event.result === "failure"),
    ).toBe(true);

    actor.send({ type: "RECOVER" });
    const secondLaunch = occurrence(effects, "core.launch", 1);
    expect(secondLaunch.generation).toBeGreaterThan(firstLaunch.generation);
    effects.complete(secondLaunch.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("ready");

    actor.send({ type: "CRASH" });
    expect(actor.getSnapshot().value).toBe("failed");
    actor.stop();
  });

  it("sequences Profile activation through effect and observation, then cancels stale work", async () => {
    const { actor, effects, transcript } = start(profileMachine);
    actor.send({ type: "ACTIVATE", revision: 7, operation: 2 });
    const activation = occurrence(effects, "profile.activate");
    effects.complete(activation.effectId);
    await flush();
    const observation = occurrence(effects, "profile.observe");
    expect(actor.getSnapshot().value).toEqual({ activating: "confirming" });

    actor.send({ type: "CANCEL" });
    expect(effects.isCancelled(observation.effectId)).toBe(true);
    const rollback = occurrence(effects, "profile.rollback");
    effects.complete(rollback.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("inactive");

    effects.completeLate(observation.effectId);
    expect(transcript.events.filter((event) => event.result === "stale").length).toBeGreaterThan(0);
    actor.stop();
  });

  it("requires Capture observation after apply and exposes rollback recovery", async () => {
    const first = start(captureMachine);
    first.actor.send({ type: "ENABLE", operation: 3 });
    const apply = occurrence(first.effects, "capture.apply");
    first.effects.complete(apply.effectId);
    await flush();
    const observation = occurrence(first.effects, "capture.observe");
    first.effects.complete(observation.effectId);
    await flush();
    expect(first.actor.getSnapshot().value).toBe("applied");

    first.actor.send({ type: "DISABLE" });
    const restore = occurrence(first.effects, "capture.restore");
    first.effects.complete(restore.effectId);
    await flush();
    const offObservation = occurrence(first.effects, "capture.observe", 1);
    first.effects.complete(offObservation.effectId);
    await flush();
    expect(first.actor.getSnapshot().value).toBe("off");
    first.actor.stop();

    const failed = start(captureMachine);
    failed.actor.send({ type: "ENABLE" });
    const failedApply = occurrence(failed.effects, "capture.apply");
    failed.effects.fail(failedApply.effectId);
    await flush();
    const compensation = occurrence(failed.effects, "capture.restore");
    failed.effects.fail(compensation.effectId, "recovery-required");
    await flush();
    expect(failed.actor.getSnapshot().value).toBe("recoveryRequired");
    failed.actor.send({ type: "REPAIR" });
    const repairRestore = occurrence(failed.effects, "capture.restore", 1);
    failed.effects.complete(repairRestore.effectId);
    await flush();
    const repairObservation = occurrence(failed.effects, "capture.observe");
    failed.effects.complete(repairObservation.effectId);
    await flush();
    expect(failed.actor.getSnapshot().value).toBe("off");
    failed.actor.stop();
  });

  it("bounds Updater check/verify, cancellation, replacement, and commit failure", async () => {
    const { actor, effects, transcript } = start(updaterMachine);
    actor.send({ type: "CHECK", operation: 4 });
    const check = occurrence(effects, "updater.check");
    effects.complete(check.effectId);
    await flush();
    const verify = occurrence(effects, "updater.verify");
    effects.complete(verify.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("available");

    actor.send({ type: "COMMIT" });
    const commit = occurrence(effects, "updater.commit");
    effects.fail(commit.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("recoveryRequired");
    expect(
      transcript.events.some(
        (event) => event.actor === "updater" && event.result === "recovery-required",
      ),
    ).toBe(true);

    actor.send({ type: "RECOVER" });
    const retryCheck = occurrence(effects, "updater.check", 1);
    actor.send({ type: "CANCEL" });
    expect(effects.isCancelled(retryCheck.effectId)).toBe(true);
    const cancel = occurrence(effects, "updater.cancel");
    effects.complete(cancel.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("idle");
    actor.stop();
  });

  it("reconciles VPN/TUN start and owns stop cleanup after a failed replacement", async () => {
    const { actor, effects, transcript } = start(vpnMachine);
    actor.send({ type: "START", operation: 5 });
    const permission = occurrence(effects, "vpn.permission");
    effects.complete(permission.effectId);
    await flush();
    const tun = occurrence(effects, "vpn.tun.start");
    effects.complete(tun.effectId);
    await flush();
    const runningObservation = occurrence(effects, "vpn.observe");
    effects.complete(runningObservation.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("running");

    actor.send({ type: "STOP" });
    const stop = occurrence(effects, "vpn.stop");
    effects.complete(stop.effectId);
    await flush();
    const cleanup = occurrence(effects, "vpn.cleanup");
    effects.complete(cleanup.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("stopped");

    actor.send({ type: "START" });
    const secondPermission = occurrence(effects, "vpn.permission", 1);
    effects.complete(secondPermission.effectId);
    await flush();
    const secondTun = occurrence(effects, "vpn.tun.start", 1);
    effects.fail(secondTun.effectId);
    await flush();
    const failedCleanup = occurrence(effects, "vpn.cleanup", 1);
    effects.complete(failedCleanup.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("failed");
    expect(
      transcript.events.some((event) => event.actor === "vpn" && event.result === "finalized"),
    ).toBe(true);
    actor.stop();
  });

  it("orders Settings/RPC connect, baseline, refresh, reconnect, and stale snapshots", async () => {
    const { actor, effects, transcript } = start(settingsRpcMachine);
    actor.send({ type: "CONNECT", operation: 6 });
    const connect = occurrence(effects, "rpc.connect");
    effects.complete(connect.effectId);
    await flush();
    const auth = occurrence(effects, "rpc.authenticate");
    effects.complete(auth.effectId);
    await flush();
    const baseline = occurrence(effects, "rpc.baseline");
    effects.complete(baseline.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("connected");

    actor.send({ type: "SNAPSHOT", generation: connect.generation - 1, revision: 99 });
    expect(actor.getSnapshot().context.acceptedSnapshotRevision).toBe(1);
    actor.send({ type: "REFRESH" });
    const refresh = occurrence(effects, "settings.load");
    effects.fail(refresh.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("failed");

    actor.send({ type: "RETRY" });
    const reconnectConnect = occurrence(effects, "rpc.connect", 1);
    effects.complete(reconnectConnect.effectId);
    await flush();
    const reconnectAuth = occurrence(effects, "rpc.authenticate", 1);
    effects.complete(reconnectAuth.effectId);
    await flush();
    const reconnectBaseline = occurrence(effects, "rpc.baseline", 1);
    effects.complete(reconnectBaseline.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("connected");
    expect(
      transcript.events.some((event) => event.actor === "settings" && event.result === "failure"),
    ).toBe(true);

    actor.send({ type: "DISPOSE" });
    const dispose = occurrence(effects, "rpc.dispose");
    effects.complete(dispose.effectId);
    await flush();
    expect(actor.getSnapshot().status).toBe("done");
    actor.stop();
  });

  it("keeps transcript schema closed and bounded", () => {
    const transcript = new SemanticTranscript();
    for (let index = 0; index < 32; index += 1) {
      transcript.record({
        actor: "runtime",
        phase: "transition",
        effect: "none",
        result: "accepted",
        authority: 1,
        generation: 1,
        operation: 1,
        revision: index + 1,
        effectId: 0,
      });
    }
    expect(transcript.events).toHaveLength(32);
    expect(parseSemanticTranscript({ schemaVersion: 1, events: transcript.events })).toHaveLength(
      32,
    );
    expect(() =>
      transcript.record({
        actor: "runtime",
        phase: "transition",
        effect: "none",
        result: "accepted",
        authority: 1,
        generation: 1,
        operation: 1,
        revision: 33,
        effectId: 0,
      }),
    ).toThrow(/limit/);
    expect(() =>
      parseSemanticTranscript({
        schemaVersion: 1,
        events: [
          {
            ...transcript.events[0],
            extra: "not-admitted",
          },
        ],
      }),
    ).toThrow(/unknown field/);
  });
});
