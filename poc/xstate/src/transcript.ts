/**
 * Closed, test-only semantic evidence for the XState admission POC.
 *
 * The boundary intentionally records no platform output, paths, profile data,
 * credentials, or arbitrary strings.  It is a deterministic model of the
 * effect seam; it must not be read as evidence that any host-side effect ran.
 */

export const TRANSCRIPT_SCHEMA_VERSION = 1 as const;
export const TRANSCRIPT_LIMIT = 32 as const;

export const ACTOR_DOMAINS = [
  "runtime",
  "core",
  "profile",
  "capture",
  "updater",
  "vpn",
  "settings",
  "rpc",
] as const;
export type ActorDomain = (typeof ACTOR_DOMAINS)[number];

export const EFFECT_KINDS = [
  "runtime.start",
  "runtime.stop",
  "runtime.dispose",
  "core.launch",
  "core.stop",
  "core.dispose",
  "profile.activate",
  "profile.observe",
  "profile.rollback",
  "profile.deactivate",
  "profile.dispose",
  "capture.apply",
  "capture.observe",
  "capture.restore",
  "capture.dispose",
  "updater.check",
  "updater.verify",
  "updater.cancel",
  "updater.commit",
  "updater.dispose",
  "vpn.permission",
  "vpn.tun.start",
  "vpn.observe",
  "vpn.stop",
  "vpn.cleanup",
  "vpn.dispose",
  "settings.load",
  "settings.dispose",
  "rpc.connect",
  "rpc.authenticate",
  "rpc.baseline",
  "rpc.disconnect",
  "rpc.dispose",
] as const;
export type EffectKind = (typeof EFFECT_KINDS)[number];

export const TRANSCRIPT_PHASES = [
  "invocation",
  "result",
  "cancel",
  "transition",
  "finalizer",
  "dispose",
] as const;
export type TranscriptPhase = (typeof TRANSCRIPT_PHASES)[number];

export const RESULT_KINDS = [
  "pending",
  "accepted",
  "rejected",
  "success",
  "failure",
  "cancelled",
  "stale",
  "superseded",
  "recovery-required",
  "finalized",
  "disposed",
] as const;
export type ResultKind = (typeof RESULT_KINDS)[number];

export interface SemanticTranscriptEvent {
  readonly schemaVersion: typeof TRANSCRIPT_SCHEMA_VERSION;
  readonly index: number;
  readonly actor: ActorDomain;
  readonly phase: TranscriptPhase;
  readonly effect: EffectKind | "none";
  readonly result: ResultKind;
  readonly authority: number;
  readonly generation: number;
  readonly operation: number;
  readonly revision: number;
  readonly effectId: number;
  readonly logicalTime: number;
}

export interface TransitionMetadata {
  readonly actor: ActorDomain;
  readonly authority: number;
  readonly generation: number;
  readonly operation: number;
  readonly revision: number;
}

const positiveInteger = (value: number, label: string): void => {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${label} must be a positive safe integer`);
  }
};

/** A bounded semantic transcript with logical time only. */
export class SemanticTranscript {
  readonly #events: SemanticTranscriptEvent[] = [];
  #logicalTime = 0;

  get events(): readonly SemanticTranscriptEvent[] {
    return this.#events;
  }

  get logicalTime(): number {
    return this.#logicalTime;
  }

  advance(): number {
    this.#logicalTime += 1;
    return this.#logicalTime;
  }

  record(
    event: Omit<SemanticTranscriptEvent, "schemaVersion" | "index" | "logicalTime"> &
      Partial<Pick<SemanticTranscriptEvent, "logicalTime">>,
  ): SemanticTranscriptEvent {
    if (this.#events.length >= TRANSCRIPT_LIMIT) {
      throw new Error(`semantic transcript limit ${TRANSCRIPT_LIMIT} exceeded`);
    }

    positiveInteger(event.authority, "authority");
    positiveInteger(event.generation, "generation");
    positiveInteger(event.operation, "operation");
    positiveInteger(event.revision, "revision");
    if (event.effectId < 0 || !Number.isSafeInteger(event.effectId)) {
      throw new Error("effectId must be a non-negative safe integer");
    }

    const logicalTime = event.logicalTime ?? this.advance();
    if (!Number.isSafeInteger(logicalTime) || logicalTime < 1) {
      throw new Error("logicalTime must be a positive safe integer");
    }
    this.#logicalTime = Math.max(this.#logicalTime, logicalTime);

    const recorded: SemanticTranscriptEvent = {
      schemaVersion: TRANSCRIPT_SCHEMA_VERSION,
      index: this.#events.length,
      ...event,
      logicalTime,
    };
    this.#events.push(recorded);
    return recorded;
  }

  transition(metadata: TransitionMetadata, result: ResultKind): SemanticTranscriptEvent {
    return this.record({
      ...metadata,
      phase: "transition",
      effect: "none",
      result,
      effectId: 0,
    });
  }

  snapshot(): readonly SemanticTranscriptEvent[] {
    return this.#events.map((event) => ({ ...event }));
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const enumValue = <T extends readonly string[]>(values: T, value: unknown): value is T[number] =>
  typeof value === "string" && (values as readonly string[]).includes(value);

const transcriptEventKeys = new Set([
  "schemaVersion",
  "index",
  "actor",
  "phase",
  "effect",
  "result",
  "authority",
  "generation",
  "operation",
  "revision",
  "effectId",
  "logicalTime",
]);
const transcriptEnvelopeKeys = new Set(["schemaVersion", "events"]);

/** Parse checked-in/replayed semantic evidence without admitting unknown data. */
export const parseSemanticTranscript = (value: unknown): readonly SemanticTranscriptEvent[] => {
  if (
    !isRecord(value) ||
    [...Object.keys(value)].some((key) => !transcriptEnvelopeKeys.has(key)) ||
    value.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION ||
    !Array.isArray(value.events)
  ) {
    throw new Error("invalid semantic transcript envelope");
  }
  if (value.events.length > TRANSCRIPT_LIMIT) {
    throw new Error("semantic transcript exceeds its bound");
  }

  let previousLogicalTime = 0;
  return value.events.map((candidate, index) => {
    if (
      !isRecord(candidate) ||
      [...Object.keys(candidate)].some((key) => !transcriptEventKeys.has(key))
    ) {
      throw new Error("semantic transcript event contains an unknown field");
    }
    if (
      candidate.schemaVersion !== TRANSCRIPT_SCHEMA_VERSION ||
      candidate.index !== index ||
      !enumValue(ACTOR_DOMAINS, candidate.actor) ||
      !enumValue(TRANSCRIPT_PHASES, candidate.phase) ||
      (candidate.effect !== "none" && !enumValue(EFFECT_KINDS, candidate.effect)) ||
      !enumValue(RESULT_KINDS, candidate.result)
    ) {
      throw new Error("semantic transcript event contains an invalid enum or index");
    }
    for (const [key, numberValue] of [
      ["authority", candidate.authority],
      ["generation", candidate.generation],
      ["operation", candidate.operation],
      ["revision", candidate.revision],
      ["logicalTime", candidate.logicalTime],
    ] as const) {
      positiveInteger(numberValue as number, key);
    }
    if ((candidate.logicalTime as number) <= previousLogicalTime) {
      throw new Error("semantic transcript logical time must increase");
    }
    previousLogicalTime = candidate.logicalTime as number;
    if (!Number.isSafeInteger(candidate.effectId) || (candidate.effectId as number) < 0) {
      throw new Error("effectId must be a non-negative safe integer");
    }
    return candidate as unknown as SemanticTranscriptEvent;
  });
};

export interface EffectInvocation {
  readonly actor: ActorDomain;
  readonly effect: EffectKind;
  readonly authority: number;
  readonly generation: number;
  readonly operation: number;
  readonly revision: number;
  readonly phase?: "invocation" | "finalizer" | "dispose";
}

export interface EffectOutput extends EffectInvocation {
  readonly effectId: number;
  readonly result: ResultKind;
}

class EffectCancelled extends Error {
  constructor() {
    super("effect cancelled");
    this.name = "EffectCancelled";
  }
}

interface PendingEffect {
  readonly request: EffectInvocation;
  readonly effectId: number;
  readonly resolve: (output: EffectOutput) => void;
  readonly reject: (error: Error) => void;
  cancelled: boolean;
  settled: boolean;
}

/**
 * A local deterministic effect boundary used by tests and replay fixtures.
 * It deliberately has no host implementation and does not schedule wall time.
 */
export class DeterministicEffects {
  readonly #pending = new Map<number, PendingEffect>();
  readonly #all = new Map<number, PendingEffect>();
  #nextEffectId = 1;

  constructor(readonly transcript: SemanticTranscript) {}

  invoke(request: EffectInvocation, signal: AbortSignal): Promise<EffectOutput> {
    const effectId = this.#nextEffectId++;
    const pendingPromise = new Promise<EffectOutput>((resolve, reject) => {
      const pending: PendingEffect = {
        request,
        effectId,
        resolve,
        reject,
        cancelled: false,
        settled: false,
      };
      this.#pending.set(effectId, pending);
      this.#all.set(effectId, pending);

      const cancel = (): void => {
        if (pending.settled || pending.cancelled) return;
        pending.cancelled = true;
        this.transcript.record({
          actor: request.actor,
          phase: "cancel",
          effect: request.effect,
          result: "cancelled",
          authority: request.authority,
          generation: request.generation,
          operation: request.operation,
          revision: request.revision,
          effectId,
        });
        reject(new EffectCancelled());
      };

      if (signal.aborted) {
        cancel();
      } else {
        signal.addEventListener("abort", cancel, { once: true });
      }
    });

    this.transcript.record({
      actor: request.actor,
      phase: request.phase ?? "invocation",
      effect: request.effect,
      result: "pending",
      authority: request.authority,
      generation: request.generation,
      operation: request.operation,
      revision: request.revision,
      effectId,
    });
    return pendingPromise;
  }

  pending(effect?: EffectKind): readonly EffectOutput[] {
    return [...this.#pending.values()]
      .filter(({ request }) => effect === undefined || request.effect === effect)
      .map(({ request, effectId }) => ({
        ...request,
        effectId,
        result: "pending" as const,
      }));
  }

  complete(
    effectId: number,
    result: Exclude<ResultKind, "pending" | "accepted" | "rejected"> = "success",
  ): boolean {
    const pending = this.#all.get(effectId);
    if (!pending || pending.settled) return false;
    if (pending.cancelled) {
      this.completeLate(effectId);
      return false;
    }
    pending.settled = true;
    this.#pending.delete(effectId);

    const output: EffectOutput = {
      ...pending.request,
      effectId,
      result,
    };
    this.transcript.record({
      actor: pending.request.actor,
      phase:
        pending.request.phase === "finalizer"
          ? "finalizer"
          : pending.request.phase === "dispose"
            ? "dispose"
            : "result",
      effect: pending.request.effect,
      result,
      authority: pending.request.authority,
      generation: pending.request.generation,
      operation: pending.request.operation,
      revision: pending.request.revision,
      effectId,
    });
    pending.resolve(output);
    return true;
  }

  fail(
    effectId: number,
    result: Exclude<ResultKind, "pending" | "accepted" | "rejected" | "success"> = "failure",
  ): boolean {
    const pending = this.#all.get(effectId);
    if (!pending || pending.settled) return false;
    pending.settled = true;
    this.#pending.delete(effectId);
    this.transcript.record({
      actor: pending.request.actor,
      phase:
        pending.request.phase === "finalizer"
          ? "finalizer"
          : pending.request.phase === "dispose"
            ? "dispose"
            : "result",
      effect: pending.request.effect,
      result,
      authority: pending.request.authority,
      generation: pending.request.generation,
      operation: pending.request.operation,
      revision: pending.request.revision,
      effectId,
    });
    pending.reject(new Error(result));
    return true;
  }

  /** Record a completion observed after cancellation/replacement without reviving the actor. */
  completeLate(effectId: number): boolean {
    const pending = this.#all.get(effectId);
    if (!pending || (!pending.cancelled && !pending.settled)) return false;
    this.transcript.record({
      actor: pending.request.actor,
      phase: "result",
      effect: pending.request.effect,
      result: "stale",
      authority: pending.request.authority,
      generation: pending.request.generation,
      operation: pending.request.operation,
      revision: pending.request.revision,
      effectId,
    });
    return true;
  }

  effect(effect: EffectKind, occurrence = 0): EffectOutput {
    const matching = [...this.#all.values()].filter(({ request }) => request.effect === effect);
    const entry = matching[occurrence];
    if (!entry) throw new Error(`no ${effect} effect at occurrence ${occurrence}`);
    return {
      ...entry.request,
      effectId: entry.effectId,
      result: "pending",
    };
  }

  isCancelled(effectId: number): boolean {
    return this.#all.get(effectId)?.cancelled ?? false;
  }
}

export const isStaleOutput = (
  context: Pick<EffectInvocation, "generation" | "operation" | "revision">,
  output: Pick<EffectOutput, "generation" | "operation" | "revision">,
): boolean =>
  context.generation !== output.generation ||
  context.operation !== output.operation ||
  context.revision !== output.revision;
