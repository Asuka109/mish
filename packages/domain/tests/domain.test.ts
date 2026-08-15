import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import {
  captureMachine,
  coreMachine,
  DeterministicEffects,
  parseSemanticTranscript,
  profileMachine,
  replayTranscript,
  runtimeMachine,
  SemanticTranscript,
  settingsRpcMachine,
  updaterMachine,
  vpnMachine,
} from "../src/index.ts";

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

const start = <T extends Parameters<typeof createActor>[0]>(machine: T) => {
  const transcript = new SemanticTranscript();
  const effects = new DeterministicEffects(transcript);
  const actor = createActor(machine, {
    input: { transcript, effects, authority: 1 },
  } as never);
  actor.start();
  return { actor, effects, transcript };
};

describe("domain actor lifecycle", () => {
  it("owns Runtime startup, duplicate rejection, cancellation/finalizer, stale completion, and dispose", async () => {
    const { actor, effects, transcript } = start(runtimeMachine);
    expect(actor.getSnapshot().value).toBe("stopped");

    actor.send({ type: "STOP" });
    expect(transcript.events.at(-1)?.result).toBe("rejected");
    actor.send({ type: "START", operation: 10 });
    const startEffect = effects.effect("runtime.start");
    actor.send({ type: "START" });
    expect(transcript.events.at(-1)?.result).toBe("duplicate");
    actor.send({ type: "CANCEL" });
    expect(effects.isCancelled(startEffect.effectId)).toBe(true);
    const stopEffect = effects.effect("runtime.stop");
    effects.complete(stopEffect.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("stopped");

    effects.completeLate(startEffect.effectId);
    actor.send({
      type: "STALE_COMPLETION",
      authority: 1,
      generation: startEffect.generation,
      operation: startEffect.operation,
      revision: startEffect.revision,
      effectId: startEffect.effectId,
    });
    expect(transcript.events.some((event) => event.result === "stale")).toBe(true);

    actor.send({ type: "DISPOSE" });
    const disposeEffect = effects.effect("runtime.dispose");
    effects.complete(disposeEffect.effectId);
    await flush();
    expect(actor.getSnapshot().status).toBe("done");
    actor.stop();
  });

  it("retires an old Runtime generation before replacement startup", async () => {
    const { actor, effects } = start(runtimeMachine);
    actor.send({ type: "START", operation: 11 });
    const first = effects.effect("runtime.start");
    effects.complete(first.effectId);
    await flush();
    actor.send({ type: "REPLACE", operation: 12 });
    const stop = effects.effect("runtime.stop");
    expect(stop.generation).toBeGreaterThan(first.generation);
    effects.complete(stop.effectId);
    await flush();
    const replacement = effects.effect("runtime.start", 1);
    effects.complete(replacement.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("running");
    actor.stop();
  });

  it("keeps Core timeout typed and recovers with a new generation", async () => {
    const { actor, effects, transcript } = start(coreMachine);
    actor.send({ type: "LAUNCH" });
    const launch = effects.effect("core.launch");
    effects.fail(launch.effectId, "timeout");
    await flush();
    expect(actor.getSnapshot().value).toBe("failed");
    expect(transcript.events.some((event) => event.result === "timeout")).toBe(true);
    actor.send({ type: "RECOVER" });
    const retry = effects.effect("core.launch", 1);
    expect(retry.generation).toBeGreaterThan(launch.generation);
    effects.complete(retry.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("ready");
    actor.send({ type: "CRASH" });
    expect(actor.getSnapshot().value).toBe("failed");
    actor.stop();
  });

  it("compensates Profile activation and reaches recovery-required when rollback cannot prove safety", async () => {
    const failed = start(profileMachine);
    failed.actor.send({ type: "ACTIVATE", revision: 7, operation: 2 });
    const activation = failed.effects.effect("profile.activate");
    failed.effects.fail(activation.effectId);
    await flush();
    const rollback = failed.effects.effect("profile.rollback");
    failed.effects.fail(rollback.effectId, "recovery-required");
    await flush();
    expect(failed.actor.getSnapshot().value).toBe("recoveryRequired");
    failed.actor.send({ type: "REPAIR" });
    const repair = failed.effects.effect("profile.activate", 1);
    failed.effects.complete(repair.effectId);
    await flush();
    const observation = failed.effects.effect("profile.observe");
    failed.effects.complete(observation.effectId);
    await flush();
    expect(failed.actor.getSnapshot().value).toBe("active");
    failed.actor.stop();

    const cancelled = start(profileMachine);
    cancelled.actor.send({ type: "ACTIVATE" });
    const pendingObservation = cancelled.effects.effect("profile.activate");
    cancelled.effects.complete(pendingObservation.effectId);
    await flush();
    const observe = cancelled.effects.effect("profile.observe");
    cancelled.actor.send({ type: "CANCEL" });
    expect(cancelled.effects.isCancelled(observe.effectId)).toBe(true);
    const cancelRollback = cancelled.effects.effect("profile.rollback");
    cancelled.effects.complete(cancelRollback.effectId);
    await flush();
    expect(cancelled.actor.getSnapshot().value).toBe("inactive");
    cancelled.actor.stop();
  });

  it("requires Capture observation and compensates failed apply/restore", async () => {
    const success = start(captureMachine);
    success.actor.send({ type: "ENABLE", operation: 3 });
    const apply = success.effects.effect("capture.apply");
    success.effects.complete(apply.effectId);
    await flush();
    const observation = success.effects.effect("capture.observe");
    success.effects.complete(observation.effectId);
    await flush();
    expect(success.actor.getSnapshot().value).toBe("applied");
    success.actor.send({ type: "DISABLE" });
    const restore = success.effects.effect("capture.restore");
    success.effects.complete(restore.effectId);
    await flush();
    const offObservation = success.effects.effect("capture.observe", 1);
    success.effects.complete(offObservation.effectId);
    await flush();
    expect(success.actor.getSnapshot().value).toBe("off");
    success.actor.stop();

    const failed = start(captureMachine);
    failed.actor.send({ type: "ENABLE" });
    const failedApply = failed.effects.effect("capture.apply");
    failed.effects.fail(failedApply.effectId, "failure");
    await flush();
    const compensation = failed.effects.effect("capture.restore");
    failed.effects.fail(compensation.effectId, "recovery-required");
    await flush();
    expect(failed.actor.getSnapshot().value).toBe("recoveryRequired");
    expect(failed.transcript.events.some((event) => event.result === "recovery-required")).toBe(
      true,
    );
    failed.actor.send({ type: "REPAIR" });
    const repair = failed.effects.effect("capture.restore", 1);
    failed.effects.complete(repair.effectId);
    await flush();
    const repairObservation = failed.effects.effect("capture.observe", 0);
    failed.effects.complete(repairObservation.effectId);
    await flush();
    expect(failed.actor.getSnapshot().value).toBe("off");
    failed.actor.stop();
  });

  it("owns VPN-TUN stop cleanup and recovery after failed start", async () => {
    const { actor, effects, transcript } = start(vpnMachine);
    actor.send({ type: "START", operation: 5 });
    const permission = effects.effect("vpn.permission");
    effects.complete(permission.effectId);
    await flush();
    const tun = effects.effect("vpn.tun.start");
    effects.complete(tun.effectId);
    await flush();
    const observation = effects.effect("vpn.observe");
    effects.complete(observation.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("running");
    actor.send({ type: "STOP" });
    const stop = effects.effect("vpn.stop");
    effects.complete(stop.effectId);
    await flush();
    const cleanup = effects.effect("vpn.cleanup");
    effects.complete(cleanup.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("stopped");

    actor.send({ type: "START" });
    const secondPermission = effects.effect("vpn.permission", 1);
    effects.complete(secondPermission.effectId);
    await flush();
    const secondTun = effects.effect("vpn.tun.start", 1);
    effects.fail(secondTun.effectId);
    await flush();
    const failedCleanup = effects.effect("vpn.cleanup", 1);
    effects.fail(failedCleanup.effectId, "recovery-required");
    await flush();
    expect(actor.getSnapshot().value).toBe("recoveryRequired");
    expect(transcript.events.some((event) => event.result === "finalized")).toBe(true);
    actor.stop();
  });

  it("bounds Updater check/verify, cancellation finalizer, and commit recovery", async () => {
    const { actor, effects, transcript } = start(updaterMachine);
    actor.send({ type: "CHECK", operation: 4 });
    const check = effects.effect("updater.check");
    effects.complete(check.effectId);
    await flush();
    const verify = effects.effect("updater.verify");
    effects.complete(verify.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("available");
    actor.send({ type: "COMMIT" });
    const commit = effects.effect("updater.commit");
    effects.fail(commit.effectId, "failure");
    await flush();
    expect(actor.getSnapshot().value).toBe("recoveryRequired");
    actor.send({ type: "RECOVER" });
    const retry = effects.effect("updater.check", 1);
    actor.send({ type: "CANCEL" });
    expect(effects.isCancelled(retry.effectId)).toBe(true);
    const cancel = effects.effect("updater.cancel");
    effects.complete(cancel.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("idle");
    expect(transcript.events.some((event) => event.result === "finalized")).toBe(true);
    actor.stop();
  });

  it("keeps Settings/RPC reconnect stale until a fresh baseline", async () => {
    const { actor, effects, transcript } = start(settingsRpcMachine);
    actor.send({ type: "CONNECT", operation: 6 });
    const connect = effects.effect("rpc.connect");
    effects.complete(connect.effectId);
    await flush();
    const auth = effects.effect("rpc.authenticate");
    effects.complete(auth.effectId);
    await flush();
    const baseline = effects.effect("rpc.baseline");
    effects.complete(baseline.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("connected");
    const baselineRevision = actor.getSnapshot().context.acceptedSnapshotRevision;
    actor.send({ type: "SNAPSHOT", generation: connect.generation - 1, revision: 99 });
    expect(actor.getSnapshot().context.acceptedSnapshotRevision).toBe(baselineRevision);
    actor.send({ type: "SNAPSHOT", generation: connect.generation, revision: baselineRevision });
    expect(transcript.events.at(-1)?.result).toBe("equal");

    actor.send({ type: "REFRESH" });
    const refresh = effects.effect("settings.load");
    effects.fail(refresh.effectId, "timeout");
    await flush();
    expect(actor.getSnapshot().value).toBe("failed");
    actor.send({ type: "RETRY" });
    const retryConnect = effects.effect("rpc.connect", 1);
    effects.complete(retryConnect.effectId);
    await flush();
    const retryAuth = effects.effect("rpc.authenticate", 1);
    effects.complete(retryAuth.effectId);
    await flush();
    const retryBaseline = effects.effect("rpc.baseline", 1);
    effects.complete(retryBaseline.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("connected");
    expect(
      transcript.events.some((event) => event.actor === "settings" && event.result === "timeout"),
    ).toBe(true);
    actor.send({ type: "DISPOSE" });
    const dispose = effects.effect("rpc.dispose");
    effects.complete(dispose.effectId);
    await flush();
    expect(actor.getSnapshot().status).toBe("done");
    actor.stop();
  });

  it("replays only bounded semantic fields and rejects private/unknown data", () => {
    const transcript = new SemanticTranscript();
    transcript.transition(
      { actor: "runtime", authority: 1, generation: 1, operation: 1, revision: 1 },
      "accepted",
    );
    transcript.record({
      actor: "runtime",
      phase: "invocation",
      effect: "runtime.start",
      result: "pending",
      authority: 1,
      generation: 1,
      operation: 1,
      revision: 1,
      effectId: 1,
    });
    const events = parseSemanticTranscript({
      schemaVersion: 1,
      events: transcript.events,
    });
    expect(replayTranscript(events).logicalTime).toBe(2);
    expect(() =>
      parseSemanticTranscript({
        schemaVersion: 1,
        events: [{ ...events[0], token: "private" }],
      }),
    ).toThrow(/unknown field/);
    expect(() =>
      parseSemanticTranscript({
        schemaVersion: 1,
        events: Array.from({ length: 129 }, (_, index) => ({
          ...events[0],
          index,
          logicalTime: index + 1,
        })),
      }),
    ).toThrow(/bound/);
  });
});
