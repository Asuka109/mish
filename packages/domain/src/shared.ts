import { fromPromise } from "xstate";

import {
  type ActorDomain,
  type Correlation,
  type DomainEffects,
  type EffectInvocation,
  type EffectKind,
  type EffectOutput,
  isCurrentCorrelation,
  isStaleOutput,
  DomainEffectError,
  SemanticTranscript,
} from "./transcript.ts";

export type { Correlation } from "./transcript.ts";

export interface ActorEnvironment {
  readonly effects: DomainEffects;
  readonly transcript: SemanticTranscript;
  /** A bounded synthetic authority identity. */
  readonly authority: number;
}

export interface DomainContext extends ActorEnvironment {
  readonly generation: number;
  readonly operation: number;
  readonly revision: number;
  /** Identity of the currently owned effect. Zero is used by stable states. */
  readonly effectId: number;
  /** Monotonic synthetic effect identity allocator owned by this actor. */
  readonly nextEffectId: number;
}

export type EffectInput = EffectInvocation & { readonly effects: DomainEffects };

export const invokeEffect = fromPromise<EffectOutput, EffectInput>(({ input, signal }) =>
  input.effects.invoke(input, signal),
);

export const effectInput = <D extends ActorDomain, E extends EffectKind>(
  context: DomainContext,
  actor: D,
  effect: E,
  phase?: EffectInvocation["phase"],
): EffectInput => ({
  effects: context.effects,
  actor,
  effect,
  authority: context.authority,
  generation: context.generation,
  operation: context.operation,
  revision: context.revision,
  effectId: context.effectId,
  ...(phase === undefined ? {} : { phase }),
});

export const trace = (
  context: DomainContext,
  actor: ActorDomain,
  result: Parameters<SemanticTranscript["transition"]>[1],
): void => {
  context.transcript.transition(
    {
      actor,
      authority: context.authority,
      generation: context.generation,
      operation: context.operation,
      revision: context.revision,
    },
    result,
  );
};

export const traceError = (context: DomainContext, actor: ActorDomain, error: unknown): void => {
  const result = error instanceof DomainEffectError ? error.result : "failure";
  trace(context, actor, result === "cancelled" ? "cancelled" : result);
};

export const positive = (value: number | undefined, defaultValue: number): number =>
  value !== undefined && Number.isSafeInteger(value) && value > 0 ? value : defaultValue;

export const beginEffect = (
  context: DomainContext,
): Pick<DomainContext, "effectId" | "nextEffectId"> => ({
  effectId: context.nextEffectId,
  nextEffectId: context.nextEffectId + 1,
});

export const beginOperation = (
  context: DomainContext,
  operation?: number,
): Pick<DomainContext, "generation" | "operation" | "revision" | "effectId" | "nextEffectId"> => ({
  generation: context.generation + 1,
  operation: positive(operation, context.operation + 1),
  revision: context.revision + 1,
  ...beginEffect(context),
});

export const beginRequest = (
  context: DomainContext,
  operation?: number,
): Pick<DomainContext, "operation" | "revision" | "effectId" | "nextEffectId"> => ({
  operation: positive(operation, context.operation + 1),
  revision: context.revision + 1,
  ...beginEffect(context),
});

export const beginReplacement = (
  context: DomainContext,
  operation?: number,
): Pick<DomainContext, "generation" | "operation" | "revision" | "effectId" | "nextEffectId"> => ({
  generation: context.generation + 1,
  operation: positive(operation, context.operation + 1),
  revision: context.revision + 1,
  ...beginEffect(context),
});

export const beginDispose = (
  context: DomainContext,
): Pick<DomainContext, "effectId" | "nextEffectId"> => beginEffect(context);

export const currentOutput = (
  context: DomainContext,
  output: Pick<EffectOutput, "authority" | "generation" | "operation" | "revision" | "effectId">,
): boolean => isCurrentCorrelation(context, output);

/**
 * An old/equal/duplicate completion is an observation, never a domain input.
 * Keeping this action on every actor makes the guard visible in deterministic
 * transcripts without creating a second lifecycle authority.
 */
export const recordExternalCompletion = (
  context: DomainContext,
  actor: ActorDomain,
  event: Correlation,
): void => {
  const eventEffectId = event.effectId;
  const sameAuthority = event.authority === context.authority;
  const sameOrder =
    event.generation === context.generation &&
    event.operation === context.operation &&
    event.revision === context.revision;
  const result =
    !sameAuthority ||
    event.generation < context.generation ||
    event.operation < context.operation ||
    event.revision < context.revision
      ? "stale"
      : sameOrder && eventEffectId !== undefined && eventEffectId === context.effectId
        ? "duplicate"
        : sameOrder && eventEffectId !== undefined
          ? "equal"
          : "stale";
  trace(context, actor, result);
};

export const staleOutput = (
  context: DomainContext,
  actor: ActorDomain,
  output: EffectOutput,
): void => {
  if (!isStaleOutput(context, output)) return;
  context.transcript.record({
    actor,
    phase: "result",
    effect: output.effect,
    result: "stale",
    authority: output.authority,
    generation: output.generation,
    operation: output.operation,
    revision: output.revision,
    effectId: output.effectId,
  });
};

export const initialContext = (input: ActorEnvironment): DomainContext => ({
  ...input,
  generation: 1,
  operation: 1,
  revision: 1,
  effectId: 0,
  nextEffectId: 1,
});
