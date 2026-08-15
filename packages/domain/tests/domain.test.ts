import { createActor } from "xstate";
import { describe, expect, it } from "vitest";

import {
  captureMachine,
  coreMachine,
  DeterministicEffects,
  parseSemanticTranscript,
  profileMachine,
  replayTranscript,
  rpcSessionMachine,
  runtimeMachine,
  SemanticTranscript,
  settingsMachine,
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

    actor.send({ type: "START", operation: 11 });
    const restarted = effects.effect("runtime.start", 1);
    expect(restarted.generation).toBeGreaterThan(startEffect.generation);
    effects.complete(restarted.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("running");

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
    actor.send({ type: "STOP" });
    const stop = effects.effect("core.stop");
    effects.complete(stop.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("idle");
    actor.send({ type: "LAUNCH", operation: 8 });
    const restarted = effects.effect("core.launch", 2);
    expect(restarted.generation).toBeGreaterThan(retry.generation);
    effects.complete(restarted.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("ready");
    actor.send({ type: "CRASH" });
    expect(actor.getSnapshot().value).toBe("failed");
    actor.stop();
  });

  it("does not restart Runtime or Core after a failed dispose", async () => {
    const runtime = start(runtimeMachine);
    runtime.actor.send({ type: "DISPOSE" });
    const runtimeDispose = runtime.effects.effect("runtime.dispose");
    runtime.effects.fail(runtimeDispose.effectId, "recovery-required");
    await flush();
    expect(runtime.actor.getSnapshot().value).toBe("disposeRecoveryRequired");
    runtime.actor.send({ type: "START" });
    expect(runtime.actor.getSnapshot().value).toBe("disposeRecoveryRequired");
    runtime.actor.send({ type: "RETRY" });
    const runtimeRetry = runtime.effects.effect("runtime.dispose", 1);
    runtime.effects.complete(runtimeRetry.effectId);
    await flush();
    expect(runtime.actor.getSnapshot().status).toBe("done");
    runtime.actor.stop();

    const core = start(coreMachine);
    core.actor.send({ type: "DISPOSE" });
    const coreDispose = core.effects.effect("core.dispose");
    core.effects.fail(coreDispose.effectId, "recovery-required");
    await flush();
    expect(core.actor.getSnapshot().value).toBe("disposeRecoveryRequired");
    core.actor.send({ type: "LAUNCH" });
    expect(core.actor.getSnapshot().value).toBe("disposeRecoveryRequired");
    core.actor.send({ type: "RETRY" });
    const coreRetry = core.effects.effect("core.dispose", 1);
    core.effects.complete(coreRetry.effectId);
    await flush();
    expect(core.actor.getSnapshot().status).toBe("done");
    core.actor.stop();
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

    const compensated = start(captureMachine);
    compensated.actor.send({ type: "ENABLE" });
    const compensatedFailedApply = compensated.effects.effect("capture.apply");
    compensated.effects.fail(compensatedFailedApply.effectId, "failure");
    await flush();
    const compensationRestore = compensated.effects.effect("capture.restore");
    compensated.effects.complete(compensationRestore.effectId);
    await flush();
    const compensationObservation = compensated.effects.effect("capture.observe");
    compensated.effects.complete(compensationObservation.effectId);
    await flush();
    expect(compensated.actor.getSnapshot().value).toBe("off");
    compensated.actor.stop();

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

    actor.send({ type: "REPAIR" });
    const failedRepairCleanup = effects.effect("vpn.cleanup", 2);
    effects.fail(failedRepairCleanup.effectId, "recovery-required");
    await flush();
    expect(actor.getSnapshot().value).toBe("recoveryRequired");

    actor.send({ type: "REPAIR" });
    const repairCleanup = effects.effect("vpn.cleanup", 3);
    effects.complete(repairCleanup.effectId);
    await flush();
    const repairObservation = effects.effect("vpn.observe", 1);
    effects.complete(repairObservation.effectId);
    await flush();
    const repairedPermission = effects.effect("vpn.permission", 2);
    expect(repairedPermission.generation).toBeGreaterThan(failedRepairCleanup.generation);
    effects.complete(repairedPermission.effectId);
    await flush();
    const repairedTun = effects.effect("vpn.tun.start", 2);
    effects.complete(repairedTun.effectId);
    await flush();
    const repairedObservation = effects.effect("vpn.observe", 2);
    effects.complete(repairedObservation.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("running");
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

  it("keeps Settings reconnect stale until a fresh baseline and retries refresh", async () => {
    const { actor, effects, transcript } = start(settingsMachine);
    actor.send({ type: "CONNECT", operation: 6 });
    const connect = effects.effect("settings.connect");
    effects.complete(connect.effectId);
    await flush();
    const auth = effects.effect("settings.authenticate");
    effects.complete(auth.effectId);
    await flush();
    const baseline = effects.effect("settings.baseline");
    effects.complete(baseline.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("connected");
    const baselineRevision = actor.getSnapshot().context.acceptedSnapshotRevision;
    actor.send({ type: "SNAPSHOT", generation: connect.generation - 1, revision: 99 });
    expect(actor.getSnapshot().context.acceptedSnapshotRevision).toBe(baselineRevision);
    actor.send({
      type: "SNAPSHOT",
      generation: connect.generation,
      revision: baselineRevision,
      effectId: baseline.effectId,
    });
    expect(transcript.events.at(-1)?.result).toBe("duplicate");
    actor.send({ type: "SNAPSHOT", generation: connect.generation, revision: baselineRevision });
    expect(transcript.events.at(-1)?.result).toBe("equal");

    actor.send({ type: "REFRESH" });
    const refresh = effects.effect("settings.load");
    effects.fail(refresh.effectId, "timeout");
    await flush();
    expect(actor.getSnapshot().value).toBe("failed");
    actor.send({ type: "RETRY" });
    const reconnect = effects.effect("settings.disconnect");
    effects.complete(reconnect.effectId);
    await flush();
    const retryConnect = effects.effect("settings.connect", 1);
    effects.complete(retryConnect.effectId);
    await flush();
    const retryAuth = effects.effect("settings.authenticate", 1);
    effects.complete(retryAuth.effectId);
    await flush();
    const retryBaseline = effects.effect("settings.baseline", 1);
    effects.complete(retryBaseline.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("connected");
    expect(
      transcript.events.some((event) => event.actor === "settings" && event.result === "timeout"),
    ).toBe(true);
    actor.send({ type: "DISPOSE" });
    const dispose = effects.effect("settings.dispose");
    effects.complete(dispose.effectId);
    await flush();
    expect(actor.getSnapshot().status).toBe("done");
    actor.stop();
  });

  it("keeps the RPC session stale until baseline, bounds reconnect attempts, and retains dispose recovery", async () => {
    const { actor, effects, transcript } = start(rpcSessionMachine);
    actor.send({ type: "CONNECT", operation: 9 });
    const connect = effects.effect("rpc.connect");
    effects.complete(connect.effectId);
    await flush();
    const auth = effects.effect("rpc.authenticate");
    effects.complete(auth.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("connected-stale");
    actor.send({ type: "SNAPSHOT", generation: connect.generation, revision: 99 });
    expect(transcript.events.at(-1)?.result).toBe("stale");
    const baseline = effects.effect("rpc.baseline");
    effects.complete(baseline.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("connected-current");
    const revision = actor.getSnapshot().context.acceptedSnapshotRevision;
    actor.send({ type: "SNAPSHOT", generation: connect.generation, revision });
    expect(transcript.events.at(-1)?.result).toBe("equal");

    actor.send({ type: "RECONNECT", operation: 10 });
    const close = effects.effect("rpc.disconnect");
    effects.complete(close.effectId);
    await flush();
    const reconnect = effects.effect("rpc.connect", 1);
    expect(reconnect.generation).toBeGreaterThan(connect.generation);
    effects.complete(reconnect.effectId);
    await flush();
    const reconnectAuth = effects.effect("rpc.authenticate", 1);
    effects.complete(reconnectAuth.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("connected-stale");
    actor.send({ type: "SNAPSHOT", generation: connect.generation, revision: 999 });
    expect(actor.getSnapshot().context.acceptedSnapshotRevision).toBe(0);
    const reconnectBaseline = effects.effect("rpc.baseline", 1);
    effects.complete(reconnectBaseline.effectId);
    await flush();
    expect(actor.getSnapshot().value).toBe("connected-current");

    actor.send({ type: "RECONNECT", operation: 11 });
    const firstClose = effects.effect("rpc.disconnect", 1);
    effects.fail(firstClose.effectId, "timeout");
    await flush();
    const secondClose = effects.effect("rpc.disconnect", 2);
    effects.fail(secondClose.effectId, "timeout");
    await flush();
    const thirdClose = effects.effect("rpc.disconnect", 3);
    effects.fail(thirdClose.effectId, "timeout");
    await flush();
    expect(actor.getSnapshot().value).toBe("disconnected");
    expect(actor.getSnapshot().context.reconnectAttempts).toBe(3);

    actor.send({ type: "DISPOSE" });
    const dispose = effects.effect("rpc.dispose");
    effects.fail(dispose.effectId, "recovery-required");
    await flush();
    expect(actor.getSnapshot().value).toBe("disposeRecoveryRequired");
    actor.send({ type: "CONNECT" });
    expect(actor.getSnapshot().value).toBe("disposeRecoveryRequired");
    actor.send({ type: "RETRY" });
    const disposeRetry = effects.effect("rpc.dispose", 1);
    effects.complete(disposeRetry.effectId);
    await flush();
    expect(actor.getSnapshot().status).toBe("done");
    actor.stop();
  });

  it("keeps every domain in dispose recovery until cleanup is retried", async () => {
    const cases = [
      {
        machine: profileMachine,
        effect: "profile.dispose" as const,
        start: { type: "ACTIVATE" as const },
      },
      {
        machine: captureMachine,
        effect: "capture.dispose" as const,
        start: { type: "ENABLE" as const },
      },
      {
        machine: updaterMachine,
        effect: "updater.dispose" as const,
        start: { type: "CHECK" as const },
      },
      { machine: vpnMachine, effect: "vpn.dispose" as const, start: { type: "START" as const } },
      {
        machine: settingsMachine,
        effect: "settings.dispose" as const,
        start: { type: "CONNECT" as const },
      },
    ] as const;

    await Promise.all(
      cases.map(async (entry) => {
        const { actor, effects } = start(entry.machine);
        actor.send({ type: "DISPOSE" });
        const dispose = effects.effect(entry.effect);
        effects.fail(dispose.effectId, "recovery-required");
        await flush();
        expect(actor.getSnapshot().value).toBe("disposeRecoveryRequired");
        actor.send(entry.start);
        expect(actor.getSnapshot().value).toBe("disposeRecoveryRequired");
        actor.send({ type: "RETRY" });
        const retry = effects.effect(entry.effect, 1);
        effects.complete(retry.effectId);
        await flush();
        expect(actor.getSnapshot().status).toBe("done");
        actor.stop();
      }),
    );
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
