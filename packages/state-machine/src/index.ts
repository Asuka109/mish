/**
 * A small TypeScript execution kernel for failure-sensitive lifecycles.
 *
 * Product machines keep their own state, input, effect, projection, and error
 * vocabulary. RunnerHandle owns only bounded admission, effect correlation,
 * cancellation, task/finalizer ownership, bounded shutdown, and stale
 * completion retirement. This mirrors `crates/state-machine`; it is not a
 * product state machine or a replacement for a domain reducer.
 */

export const DEFAULT_INBOX_CAPACITY = 32;
export const DEFAULT_SHUTDOWN_GRACE_MS = 2_000;
export const DEFAULT_FINALIZER_GRACE_MS = 2_000;

export type EffectMode = "spawn" | "cancel";

export const EffectMode = {
  Spawn: "spawn",
  Cancel: "cancel",
} as const;

export interface Correlation {
  readonly machineAuthority: string;
  readonly scopeEpoch: number;
  readonly operationId: string;
  readonly admittedRevision: number;
  readonly effectId: number;
}

export function sameOperation(left: Correlation, right: Correlation): boolean {
  return (
    left.machineAuthority === right.machineAuthority &&
    left.scopeEpoch === right.scopeEpoch &&
    left.operationId === right.operationId &&
    left.admittedRevision === right.admittedRevision
  );
}

export function sameCorrelation(left: Correlation, right: Correlation): boolean {
  return sameOperation(left, right) && left.effectId === right.effectId;
}

export function withEffect(correlation: Correlation, effectId: number): Correlation {
  return { ...correlation, effectId };
}

export interface CorrelatedEffect {
  readonly correlation: Correlation;
  readonly mode?: EffectMode | (() => EffectMode);
}

export type TaskFailure = "aborted" | "completion-conflict" | "panicked";

export const TaskFailure = {
  Aborted: "aborted",
  CompletionConflict: "completion-conflict",
  Panicked: "panicked",
} as const;

export type Disposition =
  | "accepted"
  | "rejected"
  | "unchanged"
  | "effect-emitting"
  | "committed"
  | "cancelled"
  | "failed"
  | "retired"
  | "recovery-required";

export const Disposition = {
  Accepted: "accepted",
  Rejected: "rejected",
  Unchanged: "unchanged",
  EffectEmitting: "effect-emitting",
  Committed: "committed",
  Cancelled: "cancelled",
  Failed: "failed",
  Retired: "retired",
  RecoveryRequired: "recovery-required",
} as const satisfies Record<string, Disposition>;

export interface EffectBatch<E> {
  readonly first: E;
  readonly rest: readonly E[];
}

export function effectBatchOne<E>(first: E): EffectBatch<E> {
  return { first, rest: [] };
}

export function effectBatchFromFirst<E>(first: E, rest: readonly E[]): EffectBatch<E> {
  return { first, rest: [...rest] };
}

/** Rust-compatible constructors for callers that prefer `EffectBatch.one(...)`. */
export const EffectBatch = {
  one: effectBatchOne,
  fromFirst: effectBatchFromFirst,
};

export type Transition<S, E, Error> =
  | { readonly kind: "accepted"; readonly state: S }
  | { readonly kind: "rejected"; readonly error: Error }
  | { readonly kind: "unchanged" }
  | {
      readonly kind: "effect-emitting";
      readonly state: S;
      readonly effects: EffectBatch<E>;
    }
  | { readonly kind: "committed"; readonly state: S }
  | { readonly kind: "cancelled"; readonly state: S }
  | { readonly kind: "failed"; readonly state: S }
  | { readonly kind: "retired" }
  | { readonly kind: "recovery-required"; readonly state: S };

export const Transition = {
  accepted<S>(state: S): Transition<S, never, never> {
    return { kind: "accepted", state };
  },
  rejected<Error>(error: Error): Transition<never, never, Error> {
    return { error, kind: "rejected" };
  },
  unchanged(): Transition<never, never, never> {
    return { kind: "unchanged" };
  },
  effectEmitting<S, E>(state: S, effects: EffectBatch<E>): Transition<S, E, never> {
    return { effects, kind: "effect-emitting", state };
  },
  committed<S>(state: S): Transition<S, never, never> {
    return { kind: "committed", state };
  },
  cancelled<S>(state: S): Transition<S, never, never> {
    return { kind: "cancelled", state };
  },
  failed<S>(state: S): Transition<S, never, never> {
    return { kind: "failed", state };
  },
  retired(): Transition<never, never, never> {
    return { kind: "retired" };
  },
  recoveryRequired<S>(state: S): Transition<S, never, never> {
    return { kind: "recovery-required", state };
  },
};

export function transitionDisposition<S, E, Error>(
  transition: Transition<S, E, Error>,
): Disposition {
  return transition.kind;
}

export interface Machine<S, I, E, Error> {
  reduce(state: S, input: I): Transition<S, E, Error>;
  inputCorrelation(state: S, input: I): Correlation | undefined;
  /** Whether an effect owned by this runner may still mutate the current state. */
  effectIsCurrent(state: S, correlation: Correlation): boolean;
  taskFailed(correlation: Correlation, failure: TaskFailure): I;
  shutdown(): I;
  unavailable(): Error;
}

export interface EffectExecutor<E, I> {
  execute(effect: E, cancellation: AbortSignal): I | PromiseLike<I>;
}

export type EffectExecutorFunction<E, I> = (
  effect: E,
  cancellation: AbortSignal,
) => I | PromiseLike<I>;

export interface TransitionObserver<S, I> {
  transitioned(
    previous: S,
    input: I,
    current: S,
    disposition: Disposition,
  ): void | PromiseLike<void>;
}

export type TransitionObserverFunction<S, I> = (
  previous: S,
  input: I,
  current: S,
  disposition: Disposition,
) => void | PromiseLike<void>;

export class NoopObserver<S, I> implements TransitionObserver<S, I> {
  transitioned(_previous: S, _input: I, _current: S, _disposition: Disposition): void {}
}

export interface Admission<S> {
  readonly state: S;
  readonly disposition: Disposition;
}

export type AdmissionErrorKind = "rejected" | "inbox-saturated" | "retired";

export interface AdmissionError<Error> {
  readonly kind: AdmissionErrorKind;
  readonly error?: Error;
}

export type AdmissionResult<S, Error> =
  | { readonly ok: true; readonly value: Admission<S> }
  | { readonly ok: false; readonly error: AdmissionError<Error> };

export type ActorFailure = "cancelled" | "panicked" | "retired-before-reply";

export const ActorFailure = {
  Cancelled: "cancelled",
  Panicked: "panicked",
  RetiredBeforeReply: "retired-before-reply",
} as const;

export type ForcedRetirementReason = "shutdown-deadline-exceeded" | "finalizer-deadline-exceeded";

export const ForcedRetirementReason = {
  ShutdownDeadlineExceeded: "shutdown-deadline-exceeded",
  FinalizerDeadlineExceeded: "finalizer-deadline-exceeded",
} as const;

export type RetirementTerminal<Error> =
  | "applied"
  | "already-retired"
  | { readonly kind: "shutdown-rejected"; readonly error: Error }
  | { readonly kind: "cleanup-failed"; readonly disposition: Disposition }
  | { readonly kind: "forced"; readonly reason: ForcedRetirementReason }
  | { readonly kind: "actor-failed"; readonly failure: ActorFailure };

export interface Retirement<S, Error> {
  readonly state: S;
  readonly disposition: Disposition;
  readonly terminal: RetirementTerminal<Error>;
}

/** Timer surface kept injectable so deadline tests can use logical/fake time. */
export interface RunnerScheduler {
  now(): number;
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface RunnerConfig {
  readonly inboxCapacity?: number;
  /** Milliseconds. This maps to Rust's `shutdown_grace`. */
  readonly shutdownGraceMs?: number;
  /** Milliseconds. This maps to Rust's `finalizer_grace`. */
  readonly finalizerGraceMs?: number;
  /** Millisecond aliases ease migration from duration-shaped call sites. */
  readonly shutdownGrace?: number;
  readonly finalizerGrace?: number;
  readonly scheduler?: RunnerScheduler;
}

export const RunnerConfig = {
  default(): RunnerConfig {
    return {
      finalizerGraceMs: DEFAULT_FINALIZER_GRACE_MS,
      inboxCapacity: DEFAULT_INBOX_CAPACITY,
      shutdownGraceMs: DEFAULT_SHUTDOWN_GRACE_MS,
    };
  },
};

interface NormalizedRunnerConfig {
  readonly inboxCapacity: number;
  readonly shutdownGraceMs: number;
  readonly finalizerGraceMs: number;
  readonly scheduler: RunnerScheduler;
}

const defaultScheduler: RunnerScheduler = {
  clearTimeout(handle) {
    globalThis.clearTimeout(handle as number);
  },
  now: () => Date.now(),
  setTimeout(callback, delayMs) {
    return globalThis.setTimeout(callback, delayMs);
  },
};

function normalizeConfig(config: RunnerConfig | undefined): NormalizedRunnerConfig {
  const inboxCapacity = config?.inboxCapacity ?? DEFAULT_INBOX_CAPACITY;
  const shutdownGraceMs =
    config?.shutdownGraceMs ?? config?.shutdownGrace ?? DEFAULT_SHUTDOWN_GRACE_MS;
  const finalizerGraceMs =
    config?.finalizerGraceMs ?? config?.finalizerGrace ?? DEFAULT_FINALIZER_GRACE_MS;
  if (!Number.isSafeInteger(inboxCapacity) || inboxCapacity <= 0) {
    throw new RangeError("machine inbox must be bounded and have positive capacity");
  }
  if (!Number.isFinite(shutdownGraceMs) || shutdownGraceMs < 0) {
    throw new RangeError("shutdown grace must be a finite non-negative duration");
  }
  if (!Number.isFinite(finalizerGraceMs) || finalizerGraceMs < 0) {
    throw new RangeError("finalizer grace must be a finite non-negative duration");
  }
  return {
    finalizerGraceMs,
    inboxCapacity,
    scheduler: config?.scheduler ?? defaultScheduler,
    shutdownGraceMs,
  };
}

interface AdmissionCommand<S, I, Error> {
  readonly input: I;
  readonly resolve: (result: AdmissionResult<S, Error>) => void;
}

type Settlement<I> =
  | { readonly kind: "error"; readonly error: unknown; readonly taskId: number }
  | { readonly kind: "success"; readonly input: I; readonly taskId: number };

type EffectRole = "operation" | "finalizer";

interface OwnedEffect {
  readonly cancellation: AbortController;
  readonly correlation: Correlation;
  readonly role: EffectRole;
}

interface SettlementWaiter<I> {
  readonly resolve: (settlement: Settlement<I> | null) => void;
  readonly timer: unknown;
}

interface DrainOutcome {
  readonly forced: boolean;
  readonly lastDisposition: Disposition | null;
}

interface EffectSettlement {
  readonly disposition: Disposition;
}

function abortedEffectError(): Error {
  const error = new Error("Effect task aborted");
  error.name = "AbortError";
  return error;
}

function observerFor<S, I>(
  observer: TransitionObserver<S, I> | TransitionObserverFunction<S, I>,
): TransitionObserver<S, I> {
  if (typeof observer === "function") {
    return { transitioned: observer };
  }
  return observer;
}

function executorFor<E, I>(
  executor: EffectExecutor<E, I> | EffectExecutorFunction<E, I>,
): EffectExecutor<E, I> {
  if (typeof executor === "function") {
    return { execute: executor };
  }
  return executor;
}

/**
 * Owns one domain reducer and all of its asynchronous effect tasks.
 *
 * `tryAdmit` is the Result-shaped API. `admit` maps saturated/retired inboxes
 * to `machine.unavailable()` and throws the domain error for a rejected input,
 * matching Rust's `RunnerHandle::admit` convenience method.
 */
export class RunnerHandle<S, I, E, Error> {
  private state: S;
  private readonly config: NormalizedRunnerConfig;
  private readonly machine: Machine<S, I, E, Error>;
  private readonly executor: EffectExecutor<E, I>;
  private readonly observer: TransitionObserver<S, I>;
  private readonly commands: Array<AdmissionCommand<S, I, Error>> = [];
  private readonly settlements: Array<Settlement<I>> = [];
  private readonly tasks = new Map<number, OwnedEffect>();
  private readonly settlementWaiters: Array<SettlementWaiter<I>> = [];
  private nextTaskId = 1;
  private processing = false;
  private draining = false;
  private shutdownRequested = false;
  private actorTerminated = false;
  private actorFailure: ActorFailure | null = null;
  private shutdownResolver: ((retirement: Retirement<S, Error>) => void) | null = null;
  private shutdownPromise: Promise<Retirement<S, Error>> | null = null;
  private retirement: Retirement<S, Error> | null = null;
  private retirementObserved = false;
  private lateSettlementsIgnored = false;

  constructor(
    machine: Machine<S, I, E, Error>,
    initial: S,
    executor: EffectExecutor<E, I> | EffectExecutorFunction<E, I>,
    observer: TransitionObserver<S, I> | TransitionObserverFunction<S, I>,
    config?: RunnerConfig,
  ) {
    this.machine = machine;
    this.state = initial;
    this.executor = executorFor(executor);
    this.observer = observerFor(observer);
    this.config = normalizeConfig(config);
  }

  snapshot(): S {
    return this.state;
  }

  async tryAdmit(input: I): Promise<AdmissionResult<S, Error>> {
    if (this.actorTerminated || this.shutdownRequested) {
      return { error: { kind: "retired" }, ok: false };
    }
    if (this.commands.length >= this.config.inboxCapacity) {
      return { error: { kind: "inbox-saturated" }, ok: false };
    }
    return new Promise<AdmissionResult<S, Error>>((resolve) => {
      this.commands.push({ input, resolve });
      this.schedulePump();
    });
  }

  async admit(input: I): Promise<Admission<S>> {
    const result = await this.tryAdmit(input);
    if (result.ok) return result.value;
    if (result.error.kind === "rejected") throw result.error.error;
    throw this.machine.unavailable();
  }

  /**
   * Requests normal bounded retirement. Repeated calls after the first caller
   * has observed a retirement return `already-retired`, like Rust's atomic
   * shutdown claim.
   */
  shutdown(): Promise<Retirement<S, Error>> {
    if (this.shutdownPromise) return this.shutdownPromise;
    if (this.actorTerminated) {
      if (this.retirementObserved) return Promise.resolve(this.alreadyRetired());
      this.retirementObserved = true;
      return Promise.resolve(this.retirement ?? this.actorFailureRetirement());
    }
    if (this.shutdownRequested) return Promise.resolve(this.alreadyRetired());

    this.shutdownRequested = true;
    // Shutdown is out-of-band from admission. Commands already waiting in the
    // bounded inbox are dropped, matching a closed Tokio receiver; the command
    // currently being reduced is allowed to finish before drain begins.
    this.rejectQueuedAdmissions();
    this.shutdownPromise = new Promise<Retirement<S, Error>>((resolve) => {
      this.shutdownResolver = resolve;
    });
    this.schedulePump();
    return this.shutdownPromise;
  }

  /** Explicit owner release; JavaScript GC cannot provide Rust Drop semantics deterministically. */
  dispose(): Promise<Retirement<S, Error>> {
    return this.shutdown();
  }

  /**
   * Models process termination. It intentionally skips machine shutdown and
   * finalizers; callers needing compensation must await `shutdown()` instead.
   */
  abortForProcessTermination(): void {
    if (this.actorTerminated) return;
    this.shutdownRequested = true;
    this.actorTerminated = true;
    this.actorFailure = ActorFailure.Cancelled;
    this.lateSettlementsIgnored = true;
    this.abortOwned();
    this.rejectQueuedAdmissions();
    this.resolveShutdown(this.actorFailureRetirement());
  }

  private schedulePump(): void {
    if (this.processing || this.draining || this.actorTerminated) return;
    void this.pump();
  }

  private async pump(): Promise<void> {
    if (this.processing || this.draining || this.actorTerminated) return;
    this.processing = true;
    try {
      while (!this.actorTerminated && !this.draining) {
        if (this.shutdownRequested) {
          await this.completeShutdown();
          return;
        }
        const settlement = this.settlements.shift();
        if (settlement) {
          await this.finishEffect(settlement, false);
          continue;
        }
        const command = this.commands.shift();
        if (!command) return;
        await this.processAdmission(command);
      }
    } catch {
      this.failActor(ActorFailure.Panicked);
    } finally {
      this.processing = false;
      if (
        !this.actorTerminated &&
        !this.draining &&
        (this.commands.length > 0 || this.settlements.length > 0)
      ) {
        this.schedulePump();
      }
    }
  }

  private async processAdmission(command: AdmissionCommand<S, I, Error>): Promise<void> {
    try {
      const result = await this.applyInput(command.input, "operation");
      command.resolve(result);
    } catch {
      command.resolve({ error: { kind: "retired" }, ok: false });
      this.failActor(ActorFailure.Panicked);
    }
  }

  private async applyInput(input: I, role: EffectRole): Promise<AdmissionResult<S, Error>> {
    const previous = this.state;
    const transition = this.machine.reduce(previous, input);
    const disposition = transitionDisposition(transition);

    if (transition.kind === "rejected") {
      this.publish(previous);
      await this.notifyObserver(previous, input, this.state, disposition);
      return { error: { error: transition.error, kind: "rejected" }, ok: false };
    }

    if (
      transition.kind === "accepted" ||
      transition.kind === "committed" ||
      transition.kind === "cancelled" ||
      transition.kind === "failed" ||
      transition.kind === "recovery-required" ||
      transition.kind === "effect-emitting"
    ) {
      this.state = transition.state;
    }

    // Publish before observer notification. Consumers may use the observer as
    // the readiness edge for snapshot(), matching the Rust runner contract.
    this.publish(this.state);
    await this.notifyObserver(previous, input, this.state, disposition);

    if (transition.kind === "effect-emitting") {
      for (const effect of [transition.effects.first, ...transition.effects.rest]) {
        this.dispatchEffect(effect, role);
      }
    }

    return { ok: true, value: { disposition, state: this.state } };
  }

  private publish(next: S): void {
    this.state = next;
  }

  private async notifyObserver(
    previous: S,
    input: I,
    current: S,
    disposition: Disposition,
  ): Promise<void> {
    await this.observer.transitioned(previous, input, current, disposition);
  }

  private dispatchEffect(effect: E, role: EffectRole): void {
    const candidate = effect as unknown as Partial<CorrelatedEffect>;
    const correlation = candidate.correlation;
    if (!correlation) {
      throw new TypeError("correlated effects must expose a correlation");
    }
    const mode = typeof candidate.mode === "function" ? candidate.mode() : candidate.mode;
    if (mode === EffectMode.Cancel) {
      for (const task of this.tasks.values()) {
        if (sameCorrelation(task.correlation, correlation)) task.cancellation.abort();
      }
      return;
    }

    const taskId = this.nextTaskId;
    this.nextTaskId += 1;
    const cancellation = new AbortController();
    this.tasks.set(taskId, { cancellation, correlation, role });
    let execution: I | PromiseLike<I>;
    try {
      execution = this.executor.execute(effect, cancellation.signal);
    } catch (error) {
      this.enqueueSettlement({ error, kind: "error", taskId });
      return;
    }
    Promise.resolve(execution).then(
      (input) => this.enqueueSettlement({ input, kind: "success", taskId }),
      (error: unknown) => this.enqueueSettlement({ error, kind: "error", taskId }),
    );
  }

  private enqueueSettlement(settlement: Settlement<I>): void {
    if (this.lateSettlementsIgnored || this.actorTerminated) return;
    this.settlements.push(settlement);
    const waiter = this.settlementWaiters.shift();
    if (waiter) {
      this.config.scheduler.clearTimeout(waiter.timer);
      waiter.resolve(this.settlements.shift() ?? null);
      return;
    }
    if (!this.draining) this.schedulePump();
  }

  private async finishEffect(
    settlement: Settlement<I>,
    forceStaleCompletion: boolean,
  ): Promise<EffectSettlement> {
    const task = this.tasks.get(settlement.taskId);
    if (!task) return { disposition: Disposition.Retired };
    this.tasks.delete(settlement.taskId);

    let result: AdmissionResult<S, Error>;
    if (settlement.kind === "error") {
      const failure = task.cancellation.signal.aborted ? TaskFailure.Aborted : TaskFailure.Panicked;
      const finalizer = this.machine.taskFailed(task.correlation, failure);
      result = await this.applyInput(finalizer, "finalizer");
    } else {
      const completionCorrelation = this.machine.inputCorrelation(this.state, settlement.input);
      const conflict =
        completionCorrelation === undefined ||
        !sameCorrelation(completionCorrelation, task.correlation) ||
        !this.machine.effectIsCurrent(this.state, task.correlation) ||
        (forceStaleCompletion && task.role === "operation");
      if (conflict) {
        const finalizer = this.machine.taskFailed(task.correlation, TaskFailure.CompletionConflict);
        result = await this.applyInput(finalizer, "finalizer");
      } else {
        result = await this.applyInput(settlement.input, task.role);
      }
    }
    return {
      disposition: result.ok ? result.value.disposition : Disposition.Rejected,
    };
  }

  private async completeShutdown(): Promise<void> {
    if (this.actorTerminated) return;
    this.draining = true;
    let shutdownResult: AdmissionResult<S, Error>;
    try {
      shutdownResult = await this.applyInput(this.machine.shutdown(), "operation");
    } catch {
      this.draining = false;
      this.failActor(ActorFailure.Panicked);
      return;
    }

    const normalDrain = await this.drain(this.config.shutdownGraceMs, false);
    if (this.actorTerminated) return;
    let terminal: RetirementTerminal<Error>;
    if (normalDrain.forced) {
      terminal = { kind: "forced", reason: ForcedRetirementReason.ShutdownDeadlineExceeded };
      this.abortOwned(true);
      const finalizerDrain = await this.drain(this.config.finalizerGraceMs, true);
      if (this.actorTerminated) return;
      if (finalizerDrain.forced) {
        this.abortOwned();
        this.tasks.clear();
        this.settlements.length = 0;
        terminal = { kind: "forced", reason: ForcedRetirementReason.FinalizerDeadlineExceeded };
      }
    } else if (!shutdownResult.ok) {
      terminal = { error: shutdownResult.error.error as Error, kind: "shutdown-rejected" };
    } else {
      const lastDisposition = normalDrain.lastDisposition ?? shutdownResult.value.disposition;
      terminal =
        lastDisposition === Disposition.Rejected ||
        lastDisposition === Disposition.Failed ||
        lastDisposition === Disposition.RecoveryRequired
          ? { disposition: lastDisposition, kind: "cleanup-failed" }
          : "applied";
    }

    const retirement: Retirement<S, Error> = {
      disposition: shutdownResult.ok ? shutdownResult.value.disposition : Disposition.Rejected,
      state: this.state,
      terminal,
    };
    this.draining = false;
    this.actorTerminated = true;
    this.lateSettlementsIgnored = true;
    this.resolveShutdown(retirement);
  }

  private async drain(graceMs: number, forceStaleCompletion: boolean): Promise<DrainOutcome> {
    let lastDisposition: Disposition | null = null;
    const deadline = this.config.scheduler.now() + graceMs;
    while (this.tasks.size > 0) {
      const remaining = deadline - this.config.scheduler.now();
      if (remaining <= 0) return { forced: true, lastDisposition };
      const settlement = await this.waitForSettlement(remaining);
      if (settlement === null) return { forced: true, lastDisposition };
      const outcome = await this.finishEffect(settlement, forceStaleCompletion);
      lastDisposition = outcome.disposition;
    }
    return { forced: false, lastDisposition };
  }

  private waitForSettlement(timeoutMs: number): Promise<Settlement<I> | null> {
    const immediate = this.settlements.shift();
    if (immediate) return Promise.resolve(immediate);
    return new Promise<Settlement<I> | null>((resolve) => {
      const timer = this.config.scheduler.setTimeout(() => {
        const index = this.settlementWaiters.findIndex((waiter) => waiter.resolve === resolve);
        if (index >= 0) this.settlementWaiters.splice(index, 1);
        resolve(null);
      }, timeoutMs);
      this.settlementWaiters.push({ resolve, timer });
    });
  }

  private abortOwned(forceSettlement = false): void {
    for (const [taskId, task] of this.tasks) {
      task.cancellation.abort();
      if (forceSettlement) {
        // Rust's JoinSet yields an Aborted JoinError after abort_all(), even
        // when an effect future ignores cancellation. Promise cancellation
        // cannot forcibly stop user code, so enqueue one owned synthetic
        // settlement and ignore the eventual late promise result.
        this.settlements.push({
          error: abortedEffectError(),
          kind: "error",
          taskId,
        });
      }
    }
  }

  private failActor(failure: ActorFailure): void {
    if (this.actorTerminated) return;
    this.actorFailure = failure;
    this.actorTerminated = true;
    this.lateSettlementsIgnored = true;
    this.abortOwned();
    this.tasks.clear();
    this.settlements.length = 0;
    this.rejectQueuedAdmissions();
    this.resolveShutdown(this.actorFailureRetirement());
  }

  private rejectQueuedAdmissions(): void {
    while (this.commands.length > 0) {
      this.commands.shift()?.resolve({ error: { kind: "retired" }, ok: false });
    }
  }

  private actorFailureRetirement(): Retirement<S, Error> {
    return {
      disposition: Disposition.Retired,
      state: this.state,
      terminal: {
        failure: this.actorFailure ?? ActorFailure.RetiredBeforeReply,
        kind: "actor-failed",
      },
    };
  }

  private alreadyRetired(): Retirement<S, Error> {
    return {
      disposition: Disposition.Unchanged,
      state: this.state,
      terminal: "already-retired",
    };
  }

  private resolveShutdown(retirement: Retirement<S, Error>): void {
    const resolver = this.shutdownResolver;
    this.shutdownResolver = null;
    this.retirement = retirement;
    if (resolver) this.retirementObserved = true;
    this.shutdownPromise = null;
    if (resolver) resolver(retirement);
  }
}

export function spawnRunner<S, I, E, Error>(
  machine: Machine<S, I, E, Error>,
  initial: S,
  executor: EffectExecutor<E, I> | EffectExecutorFunction<E, I>,
  observer: TransitionObserver<S, I> | TransitionObserverFunction<S, I> = new NoopObserver<S, I>(),
  config?: RunnerConfig,
): RunnerHandle<S, I, E, Error> {
  return new RunnerHandle(machine, initial, executor, observer, config);
}
