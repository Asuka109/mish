import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ActorFailure,
  Disposition,
  EffectBatch,
  ForcedRetirementReason,
  TaskFailure,
  Transition,
  type Correlation,
  type CorrelatedEffect,
  type Machine,
  type TransitionObserver,
  type Transition as KernelTransition,
  spawnRunner,
  type RunnerHandle,
} from "./index";

type TestPhase = "idle" | "running" | "finalizing" | "done" | "retired" | "failed";

interface TestState {
  readonly phase: TestPhase;
  readonly active: Correlation | null;
}

type TestInput =
  | { readonly kind: "start"; readonly correlation: Correlation }
  | { readonly kind: "start-batch"; readonly correlation: Correlation }
  | { readonly kind: "replace"; readonly correlation: Correlation }
  | { readonly kind: "cancel" }
  | { readonly kind: "complete"; readonly correlation: Correlation }
  | {
      readonly kind: "task-failed";
      readonly correlation: Correlation;
      readonly failure: TaskFailure;
    }
  | { readonly kind: "finalized"; readonly correlation: Correlation }
  | { readonly kind: "shutdown" };

interface TestEffect extends CorrelatedEffect {
  readonly kind: "work" | "work-a" | "work-b" | "finalize";
}

const idle: TestState = { active: null, phase: "idle" };

function correlation(operationId: string, effectId = 1): Correlation {
  return {
    admittedRevision: 11,
    effectId,
    machineAuthority: "test-authority",
    operationId,
    scopeEpoch: 7,
  };
}

function cloneState(phase: TestPhase, active: Correlation | null): TestState {
  return { active, phase };
}

class TestMachine implements Machine<TestState, TestInput, TestEffect, string> {
  readonly failures: Array<{ correlation: Correlation; failure: TaskFailure }> = [];

  reduce(state: TestState, input: TestInput): KernelTransition<TestState, TestEffect, string> {
    switch (input.kind) {
      case "start":
        if (state.phase === "idle") {
          return Transition.effectEmitting(
            cloneState("running", input.correlation),
            EffectBatch.one({ correlation: input.correlation, kind: "work" }),
          );
        }
        if (
          state.phase === "running" &&
          state.active &&
          sameOperationForTest(state.active, input.correlation)
        ) {
          return Transition.unchanged();
        }
        return Transition.rejected("busy");
      case "start-batch":
        if (state.phase !== "idle") return Transition.rejected("busy");
        return Transition.effectEmitting(
          cloneState("running", input.correlation),
          EffectBatch.fromFirst({ correlation: input.correlation, kind: "work-a" }, [
            { correlation: input.correlation, kind: "work-b" },
          ]),
        );
      case "replace":
        if (state.phase !== "running") return Transition.retired();
        return Transition.accepted(cloneState("running", input.correlation));
      case "cancel":
        if (state.phase !== "running" || !state.active) return Transition.rejected("invalid");
        return Transition.effectEmitting(
          state,
          EffectBatch.one({ correlation: state.active, kind: "work", mode: "cancel" }),
        );
      case "complete":
        if (
          state.phase === "running" &&
          state.active &&
          sameCorrelationForTest(state.active, input.correlation)
        ) {
          return Transition.committed(cloneState("done", null));
        }
        return Transition.retired();
      case "task-failed":
        if (state.phase === "finalizing") return Transition.failed(cloneState("failed", null));
        if (
          state.phase === "running" &&
          state.active &&
          sameOperationForTest(state.active, input.correlation)
        ) {
          const finalizer = { ...input.correlation, effectId: input.correlation.effectId + 1 };
          return Transition.effectEmitting(
            cloneState("finalizing", state.active),
            EffectBatch.one({ correlation: finalizer, kind: "finalize" }),
          );
        }
        return Transition.retired();
      case "finalized":
        if (
          state.phase === "finalizing" &&
          state.active &&
          sameCorrelationForTest(
            { ...state.active, effectId: state.active.effectId + 1 },
            input.correlation,
          )
        ) {
          return Transition.cancelled(cloneState("retired", null));
        }
        return Transition.failed(cloneState("failed", null));
      case "shutdown":
        if (state.phase === "running" || state.phase === "finalizing") {
          // Keep the owned operation correlation current through the bounded
          // drain so an aborted completion can enter the domain finalizer.
          return Transition.accepted(state);
        }
        return Transition.accepted(cloneState("retired", null));
    }
  }

  inputCorrelation(_state: TestState, input: TestInput): Correlation | undefined {
    if (
      input.kind === "start" ||
      input.kind === "start-batch" ||
      input.kind === "replace" ||
      input.kind === "complete" ||
      input.kind === "task-failed" ||
      input.kind === "finalized"
    ) {
      return input.correlation;
    }
    return undefined;
  }

  effectIsCurrent(state: TestState, candidate: Correlation): boolean {
    if (state.active === null) return false;
    if (state.phase === "running") return sameCorrelationForTest(state.active, candidate);
    return (
      state.phase === "finalizing" &&
      sameCorrelationForTest({ ...state.active, effectId: state.active.effectId + 1 }, candidate)
    );
  }

  taskFailed(correlationValue: Correlation, failure: TaskFailure): TestInput {
    this.failures.push({ correlation: correlationValue, failure });
    return { correlation: correlationValue, failure, kind: "task-failed" };
  }

  shutdown(): TestInput {
    return { kind: "shutdown" };
  }

  unavailable(): string {
    return "unavailable";
  }
}

class ImmediateShutdownMachine extends TestMachine {
  override reduce(
    state: TestState,
    input: TestInput,
  ): KernelTransition<TestState, TestEffect, string> {
    if (input.kind === "shutdown") return Transition.cancelled(cloneState("retired", null));
    return super.reduce(state, input);
  }
}

function sameOperationForTest(left: Correlation, right: Correlation): boolean {
  return (
    left.machineAuthority === right.machineAuthority &&
    left.scopeEpoch === right.scopeEpoch &&
    left.operationId === right.operationId &&
    left.admittedRevision === right.admittedRevision
  );
}

function sameCorrelationForTest(left: Correlation, right: Correlation): boolean {
  return sameOperationForTest(left, right) && left.effectId === right.effectId;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const runners = new Set<RunnerHandle<unknown, unknown, unknown, unknown>>();

function track<S, I, E, Error>(runner: RunnerHandle<S, I, E, Error>): RunnerHandle<S, I, E, Error> {
  runners.add(runner as RunnerHandle<unknown, unknown, unknown, unknown>);
  return runner;
}

afterEach(async () => {
  await Promise.all([...runners].map((runner) => runner.shutdown()));
  runners.clear();
  vi.useRealTimers();
});

describe("TypeScript state-machine kernel parity", () => {
  it("publishes snapshots before notifying observers and commits a happy path", async () => {
    const machine = new TestMachine();
    let runner!: RunnerHandle<TestState, TestInput, TestEffect, string>;
    const observed: Disposition[] = [];
    const publishedBeforeObserver: boolean[] = [];
    const observer: TransitionObserver<TestState, TestInput> = {
      transitioned(_previous, _input, current, disposition) {
        publishedBeforeObserver.push(runner.snapshot() === current);
        observed.push(disposition);
      },
    };
    const release = deferred<TestInput>();
    runner = track(
      spawnRunner(
        machine,
        idle,
        (effect) =>
          effect.kind === "work"
            ? release.promise
            : Promise.resolve({ kind: "complete", correlation: effect.correlation }),
        observer,
      ),
    );

    await expect(
      runner.admit({ correlation: correlation("happy"), kind: "start" }),
    ).resolves.toMatchObject({
      disposition: Disposition.EffectEmitting,
    });
    release.resolve({ correlation: correlation("happy"), kind: "complete" });
    await vi.waitFor(() => expect(runner.snapshot().phase).toBe("done"));

    expect(publishedBeforeObserver).toEqual([true, true]);
    expect(observed).toEqual([Disposition.EffectEmitting, Disposition.Committed]);
  });

  it("keeps duplicate admission idempotent, rejects competing work, and supports cancellation", async () => {
    const machine = new TestMachine();
    const work = deferred<TestInput>();
    const runner = track(
      spawnRunner(
        machine,
        idle,
        (effect) => (effect.mode === "cancel" ? work.promise : work.promise),
        new (class implements TransitionObserver<TestState, TestInput> {
          transitioned() {}
        })(),
      ),
    );
    const operation = correlation("single-flight");
    await runner.admit({ correlation: operation, kind: "start" });
    await expect(runner.admit({ correlation: operation, kind: "start" })).resolves.toMatchObject({
      disposition: Disposition.Unchanged,
    });
    await expect(runner.admit({ correlation: correlation("other"), kind: "start" })).rejects.toBe(
      "busy",
    );

    await runner.admit({ kind: "cancel" });
    work.resolve({ correlation: operation, kind: "complete" });
    await vi.waitFor(() => expect(runner.snapshot().phase).toBe("done"));
    expect(machine.failures).toEqual([]);
  });

  it("runs effect batches in parallel while applying completions serially", async () => {
    const machine = new TestMachine();
    const completions = new Map<string, ReturnType<typeof deferred<TestInput>>>();
    let active = 0;
    let maximumActive = 0;
    const runner = track(
      spawnRunner(machine, idle, (effect) => {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        const wait = deferred<TestInput>();
        completions.set(effect.kind, wait);
        return wait.promise.finally(() => {
          active -= 1;
        });
      }),
    );
    const operation = correlation("parallel-batch");
    await runner.admit({ correlation: operation, kind: "start-batch" });
    expect(maximumActive).toBe(2);
    completions.get("work-a")?.resolve({ correlation: operation, kind: "complete" });
    completions.get("work-b")?.resolve({ correlation: operation, kind: "complete" });
    await vi.waitFor(() => expect(runner.snapshot().phase).toBe("done"));
    expect(machine.failures).toEqual([
      { correlation: operation, failure: TaskFailure.CompletionConflict },
    ]);
  });

  it("retires foreign, replaced, stale, and equal-effect completions before reducer mutation", async () => {
    const machine = new TestMachine();
    const work = deferred<TestInput>();
    const runner = track(spawnRunner(machine, idle, () => work.promise));
    const oldOperation = correlation("old");
    const replacement = correlation("replacement");
    await runner.admit({ correlation: oldOperation, kind: "start" });
    await runner.admit({ correlation: replacement, kind: "replace" });
    work.resolve({ correlation: oldOperation, kind: "complete" });
    await vi.waitFor(() => expect(machine.failures).toHaveLength(1));

    expect(machine.failures).toEqual([
      { correlation: oldOperation, failure: TaskFailure.CompletionConflict },
    ]);
    expect(runner.snapshot()).toMatchObject({ active: replacement, phase: "running" });
    expect(runner.snapshot().phase).not.toBe("done");
  });

  it("treats an equal-operation completion with the wrong effect id as stale", async () => {
    const machine = new TestMachine();
    const operation = correlation("equal-effect");
    const runner = track(
      spawnRunner(machine, idle, (effect) =>
        effect.kind === "work"
          ? Promise.resolve<TestInput>({
              correlation: { ...operation, effectId: 2 },
              kind: "complete",
            })
          : Promise.resolve<TestInput>({
              correlation: { ...operation, effectId: 2 },
              kind: "finalized",
            }),
      ),
    );
    await runner.admit({ correlation: operation, kind: "start" });
    await vi.waitFor(() => expect(runner.snapshot().phase).toBe("retired"));
    expect(machine.failures).toEqual([
      { correlation: operation, failure: TaskFailure.CompletionConflict },
    ]);
  });

  it("turns executor rejection into a typed panic finalizer and exposes finalizer failure", async () => {
    const machine = new TestMachine();
    const runner = track(
      spawnRunner(machine, idle, (effect) => {
        if (effect.kind === "work") return Promise.reject(new Error("effect panic"));
        return Promise.reject(new Error("finalizer failure"));
      }),
    );
    await runner.admit({ correlation: correlation("panic"), kind: "start" });
    await vi.waitFor(() => expect(runner.snapshot().phase).toBe("failed"));
    expect(machine.failures).toEqual([
      { correlation: correlation("panic"), failure: TaskFailure.Panicked },
      { correlation: { ...correlation("panic"), effectId: 2 }, failure: TaskFailure.Panicked },
    ]);

    const retirement = await runner.shutdown();
    expect(retirement.terminal).toBe("applied");
  });

  it("keeps panic/rejection in reducer and observers as typed actor retirement", async () => {
    const reducerMachine: Machine<TestState, TestInput, TestEffect, string> = {
      effectIsCurrent: () => false,
      inputCorrelation: () => undefined,
      reduce: () => {
        throw new Error("reducer panic");
      },
      shutdown: () => ({ kind: "shutdown" }),
      taskFailed: () => ({ kind: "shutdown" }),
      unavailable: () => "unavailable",
    };
    const reducerRunner = track(
      spawnRunner<TestState, TestInput, TestEffect, string>(reducerMachine, idle, () =>
        Promise.resolve<TestInput>({ kind: "shutdown" }),
      ),
    );
    await expect(
      reducerRunner.tryAdmit({ correlation: correlation("reducer"), kind: "start" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "retired" },
    });
    await expect(reducerRunner.shutdown()).resolves.toMatchObject({
      terminal: { failure: ActorFailure.Panicked, kind: "actor-failed" },
    });

    const observerRunner = track(
      spawnRunner(
        new TestMachine(),
        idle,
        () =>
          Promise.resolve<TestInput>({ correlation: correlation("observer"), kind: "complete" }),
        () => Promise.reject(new Error("observer rejection")),
      ),
    );
    await expect(
      observerRunner.tryAdmit({ correlation: correlation("observer"), kind: "start" }),
    ).resolves.toMatchObject({
      ok: false,
      error: { kind: "retired" },
    });
    await expect(observerRunner.shutdown()).resolves.toMatchObject({
      terminal: { failure: ActorFailure.Panicked, kind: "actor-failed" },
    });
  });

  it("distinguishes saturated inbox, retired admission, and bounded forced retirement", async () => {
    vi.useFakeTimers();
    const machine = new ImmediateShutdownMachine();
    const observerGate = deferred<void>();
    let first = true;
    const runner = track(
      spawnRunner(
        machine,
        idle,
        () => new Promise<TestInput>(() => {}),
        () => {
          if (first) {
            first = false;
            return observerGate.promise;
          }
        },
        { inboxCapacity: 1, shutdownGraceMs: 10, finalizerGraceMs: 10 },
      ),
    );
    const operation = correlation("saturation");
    const firstAdmission = runner.tryAdmit({ correlation: operation, kind: "start" });
    await Promise.resolve();
    const queuedAdmission = runner.tryAdmit({ correlation: operation, kind: "start" });
    await expect(runner.tryAdmit({ kind: "cancel" })).resolves.toMatchObject({
      error: { kind: "inbox-saturated" },
      ok: false,
    });
    observerGate.resolve();
    await expect(firstAdmission).resolves.toMatchObject({ ok: true });
    await expect(queuedAdmission).resolves.toMatchObject({ ok: true });

    const shutdown = runner.shutdown();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(25);
    await Promise.resolve();
    const retirement = await shutdown;
    expect(retirement.terminal).toEqual({
      kind: "forced",
      reason: ForcedRetirementReason.ShutdownDeadlineExceeded,
    });
    await expect(runner.shutdown()).resolves.toMatchObject({ terminal: "already-retired" });
    await expect(
      runner.tryAdmit({ correlation: correlation("late"), kind: "start" }),
    ).resolves.toMatchObject({
      error: { kind: "retired" },
      ok: false,
    });
  });

  it("forces a finalizer deadline and ignores a late finalizer completion", async () => {
    vi.useFakeTimers();
    const machine = new TestMachine();
    const operation = correlation("finalizer-timeout");
    const finalizerRelease = deferred<TestInput>();
    const runner = track(
      spawnRunner(
        machine,
        idle,
        (effect, signal) => {
          if (effect.kind === "work") {
            return new Promise<TestInput>((resolve) => {
              signal.addEventListener(
                "abort",
                () => resolve({ correlation: operation, kind: "complete" }),
                {
                  once: true,
                },
              );
            });
          }
          return finalizerRelease.promise;
        },
        new (class implements TransitionObserver<TestState, TestInput> {
          transitioned() {}
        })(),
        { shutdownGraceMs: 5, finalizerGraceMs: 5 },
      ),
    );
    await runner.admit({ correlation: operation, kind: "start" });
    const shutdown = runner.shutdown();
    await vi.advanceTimersByTimeAsync(5);
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(6);
    const retirement = await shutdown;
    expect(retirement.terminal).toEqual({
      kind: "forced",
      reason: ForcedRetirementReason.FinalizerDeadlineExceeded,
    });
    const stateBeforeLateRelease = runner.snapshot();
    finalizerRelease.resolve({ correlation: { ...operation, effectId: 2 }, kind: "finalized" });
    await Promise.resolve();
    expect(runner.snapshot()).toEqual(stateBeforeLateRelease);
  });

  it("uses explicit process termination without running finalizers", async () => {
    const machine = new TestMachine();
    const pending = new Promise<TestInput>(() => {});
    const runner = track(spawnRunner(machine, idle, () => pending));
    const operation = correlation("process-abort");
    await runner.admit({ correlation: operation, kind: "start" });
    runner.abortForProcessTermination();
    expect(machine.failures).toEqual([]);
    await expect(runner.shutdown()).resolves.toMatchObject({
      terminal: { failure: ActorFailure.Cancelled, kind: "actor-failed" },
    });
  });
});
