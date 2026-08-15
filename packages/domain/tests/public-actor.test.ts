import { createDomainActor, DeterministicEffects, SemanticTranscript } from "@mish/domain";
import { describe, expect, it } from "vitest";

describe("public domain actor factory", () => {
  it("constructs, starts, subscribes, sends, and stops a typed actor", async () => {
    const transcript = new SemanticTranscript();
    const effects = new DeterministicEffects(transcript);
    const actor = createDomainActor("runtime", {
      authority: 7,
      effects,
      transcript,
    });
    const snapshots: string[] = [];
    const subscription = actor.subscribe((snapshot) => {
      snapshots.push(String(snapshot.value));
    });

    actor.start();
    expect(actor.getSnapshot().value).toBe("stopped");
    actor.send({ type: "START", operation: 3 });
    expect(actor.getSnapshot().value).toBe("starting");
    const start = effects.effect("runtime.start");
    effects.complete(start.effectId);
    await Promise.resolve();
    await Promise.resolve();
    expect(snapshots).toContain("running");
    expect(actor.getSnapshot().context.authority).toBe(7);

    const beforeStop = snapshots.length;
    actor.stop();
    expect(actor.getSnapshot().status).toBe("stopped");
    expect(snapshots).toHaveLength(beforeStop);
    subscription.unsubscribe();

    const lateTranscript = new SemanticTranscript();
    const lateEffects = new DeterministicEffects(lateTranscript);
    const lateActor = createDomainActor("runtime", {
      authority: 8,
      effects: lateEffects,
      transcript: lateTranscript,
    });
    const lateSnapshots: string[] = [];
    lateActor.subscribe((snapshot) => {
      lateSnapshots.push(String(snapshot.value));
    });
    lateActor.start();
    lateActor.send({ type: "START" });
    const pendingStart = lateEffects.effect("runtime.start");
    const beforeLateCompletion = lateSnapshots.length;
    lateActor.stop();
    lateEffects.completeLate(pendingStart.effectId);
    await Promise.resolve();
    expect(lateActor.getSnapshot().status).toBe("stopped");
    expect(lateSnapshots).toHaveLength(beforeLateCompletion);
  });

  it("keeps typed reconnect and dispose recovery semantics through the public entry", async () => {
    const transcript = new SemanticTranscript();
    const effects = new DeterministicEffects(transcript);
    const actor = createDomainActor("rpcSession", { authority: 1, effects, transcript });
    actor.start();
    actor.send({ type: "CONNECT" });
    const connect = effects.effect("rpc.connect");
    effects.fail(connect.effectId, "timeout");
    await Promise.resolve();
    await Promise.resolve();
    expect(actor.getSnapshot().value).toBe("failed");

    actor.send({ type: "RECONNECT", operation: 4 });
    const disconnect = effects.effect("rpc.disconnect");
    effects.complete(disconnect.effectId);
    await Promise.resolve();
    await Promise.resolve();
    expect(actor.getSnapshot().value).toBe("reconnectConnecting");

    const reconnect = effects.effect("rpc.connect", 1);
    effects.complete(reconnect.effectId);
    await Promise.resolve();
    await Promise.resolve();
    const authenticate = effects.effect("rpc.authenticate");
    effects.complete(authenticate.effectId);
    await Promise.resolve();
    await Promise.resolve();
    const baseline = effects.effect("rpc.baseline");
    effects.complete(baseline.effectId);
    await Promise.resolve();
    await Promise.resolve();
    expect(actor.getSnapshot().value).toBe("connected-current");

    actor.send({ type: "DISPOSE" });
    const dispose = effects.effect("rpc.dispose");
    effects.complete(dispose.effectId);
    await Promise.resolve();
    await Promise.resolve();
    expect(actor.getSnapshot().status).toBe("done");
    actor.stop();
  });
});
