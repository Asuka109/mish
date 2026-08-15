import { assign, fromPromise, setup } from "xstate";

import {
  DeterministicEffects,
  type EffectInvocation,
  type EffectKind,
  type EffectOutput,
  isStaleOutput,
  type ActorDomain,
  SemanticTranscript,
} from "./transcript.ts";

export interface ActorEnvironment {
  readonly effects: DeterministicEffects;
  readonly transcript: SemanticTranscript;
  readonly authority: number;
}

interface Correlation {
  readonly generation: number;
  readonly operation: number;
  readonly revision: number;
}

interface DomainContext extends ActorEnvironment, Correlation {}

type EffectInput = EffectInvocation & { readonly effects: DeterministicEffects };

const invokeEffect = fromPromise<EffectOutput, EffectInput>(({ input, signal }) =>
  input.effects.invoke(input, signal),
);

const effectInput = <D extends ActorDomain, E extends EffectKind>(
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
  ...(phase === undefined ? {} : { phase }),
});

const trace = (
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

const positive = (value: number, fallback: number): number =>
  Number.isSafeInteger(value) && value > 0 ? value : fallback;

const stale = (context: DomainContext, actor: ActorDomain, event: Correlation): void => {
  if (!isStaleOutput(context, event)) return;
  context.transcript.record({
    actor,
    phase: "result",
    effect: "none",
    result: "stale",
    authority: context.authority,
    generation: event.generation,
    operation: event.operation,
    revision: event.revision,
    effectId: 0,
  });
};

export type RuntimeEvent =
  | { type: "START"; operation?: number }
  | { type: "STOP" }
  | { type: "CANCEL" }
  | { type: "REPLACE"; operation?: number }
  | { type: "RETRY" }
  | { type: "DISPOSE" }
  | ({ type: "STALE_COMPLETION" } & Correlation);

export type RuntimeContext = DomainContext;

export const runtimeMachine = setup({
  types: {
    context: {} as RuntimeContext,
    events: {} as RuntimeEvent,
    input: {} as ActorEnvironment,
  },
  actors: {
    start: invokeEffect,
    stop: invokeEffect,
    dispose: invokeEffect,
  },
}).createMachine({
  id: "mish.runtime",
  initial: "stopped",
  context: ({ input }) => ({
    ...input,
    generation: 1,
    operation: 1,
    revision: 1,
  }),
  on: {
    STALE_COMPLETION: {
      actions: ({ context, event }) => stale(context, "runtime", event),
    },
  },
  states: {
    stopped: {
      entry: ({ context }) => trace(context, "runtime", "accepted"),
      on: {
        START: {
          target: "starting",
          actions: [
            assign(({ context, event }) => ({
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
        },
        STOP: { actions: ({ context }) => trace(context, "runtime", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "runtime", "accepted"),
        },
      },
    },
    starting: {
      entry: ({ context }) => trace(context, "runtime", "accepted"),
      invoke: {
        src: "start",
        input: ({ context }) => effectInput(context, "runtime", "runtime.start"),
        onDone: {
          target: "running",
          guard: ({ context, event }) => !isStaleOutput(context, event.output),
          actions: ({ context }) => trace(context, "runtime", "success"),
        },
        onError: {
          target: "failed",
          actions: ({ context }) => trace(context, "runtime", "failure"),
        },
      },
      on: {
        CANCEL: {
          target: "stopping",
          actions: ({ context }) => trace(context, "runtime", "cancelled"),
        },
        STOP: {
          target: "stopping",
          actions: ({ context }) => trace(context, "runtime", "accepted"),
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "runtime", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "runtime", "accepted"),
        },
      },
    },
    replacing: {
      entry: ({ context }) => trace(context, "runtime", "superseded"),
      invoke: {
        src: "stop",
        input: ({ context }) => effectInput(context, "runtime", "runtime.stop", "finalizer"),
        onDone: {
          target: "starting",
          actions: ({ context }) => trace(context, "runtime", "finalized"),
        },
        onError: {
          target: "failed",
          actions: ({ context }) => trace(context, "runtime", "recovery-required"),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "runtime", "accepted"),
        },
      },
    },
    running: {
      entry: ({ context }) => trace(context, "runtime", "success"),
      on: {
        START: { actions: ({ context }) => trace(context, "runtime", "rejected") },
        STOP: {
          target: "stopping",
          actions: ({ context }) => trace(context, "runtime", "accepted"),
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "runtime", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "runtime", "accepted"),
        },
      },
    },
    stopping: {
      entry: ({ context }) => trace(context, "runtime", "finalized"),
      invoke: {
        src: "stop",
        input: ({ context }) => effectInput(context, "runtime", "runtime.stop", "finalizer"),
        onDone: {
          target: "stopped",
          actions: ({ context }) => trace(context, "runtime", "success"),
        },
        onError: {
          target: "failed",
          actions: ({ context }) => trace(context, "runtime", "recovery-required"),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "runtime", "accepted"),
        },
      },
    },
    failed: {
      entry: ({ context }) => trace(context, "runtime", "failure"),
      on: {
        RETRY: {
          target: "starting",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
        },
        START: {
          target: "starting",
          actions: ({ context }) => trace(context, "runtime", "accepted"),
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "runtime", "accepted"),
        },
      },
    },
    disposing: {
      entry: ({ context }) => trace(context, "runtime", "accepted"),
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "runtime", "runtime.dispose", "dispose"),
        onDone: {
          target: "disposed",
          actions: ({ context }) => trace(context, "runtime", "disposed"),
        },
        onError: {
          target: "failed",
          actions: ({ context }) => trace(context, "runtime", "recovery-required"),
        },
      },
    },
    disposed: { type: "final" },
  },
});

export type CoreEvent =
  | { type: "LAUNCH"; operation?: number }
  | { type: "STOP" }
  | { type: "CANCEL" }
  | { type: "REPLACE"; operation?: number }
  | { type: "CRASH" }
  | { type: "RECOVER" }
  | { type: "DISPOSE" }
  | ({ type: "STALE_COMPLETION" } & Correlation);

export type CoreContext = DomainContext;

export const coreMachine = setup({
  types: {
    context: {} as CoreContext,
    events: {} as CoreEvent,
    input: {} as ActorEnvironment,
  },
  actors: {
    launch: invokeEffect,
    stop: invokeEffect,
    dispose: invokeEffect,
  },
}).createMachine({
  id: "mish.core",
  initial: "absent",
  context: ({ input }) => ({ ...input, generation: 1, operation: 1, revision: 1 }),
  on: {
    STALE_COMPLETION: { actions: ({ context, event }) => stale(context, "core", event) },
  },
  states: {
    absent: {
      entry: ({ context }) => trace(context, "core", "accepted"),
      on: {
        LAUNCH: {
          target: "launching",
          actions: [
            assign(({ context, event }) => ({
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
        STOP: { actions: ({ context }) => trace(context, "core", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "core", "accepted"),
        },
      },
    },
    launching: {
      invoke: {
        src: "launch",
        input: ({ context }) => effectInput(context, "core", "core.launch"),
        onDone: {
          target: "ready",
          guard: ({ context, event }) => !isStaleOutput(context, event.output),
          actions: ({ context }) => trace(context, "core", "success"),
        },
        onError: { target: "failed", actions: ({ context }) => trace(context, "core", "failure") },
      },
      on: {
        CANCEL: {
          target: "stopping",
          actions: ({ context }) => trace(context, "core", "cancelled"),
        },
        STOP: { target: "stopping", actions: ({ context }) => trace(context, "core", "accepted") },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "core", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "core", "accepted"),
        },
      },
    },
    replacing: {
      invoke: {
        src: "stop",
        input: ({ context }) => effectInput(context, "core", "core.stop", "finalizer"),
        onDone: {
          target: "launching",
          actions: ({ context }) => trace(context, "core", "finalized"),
        },
        onError: {
          target: "failed",
          actions: ({ context }) => trace(context, "core", "recovery-required"),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "core", "accepted"),
        },
      },
    },
    ready: {
      entry: ({ context }) => trace(context, "core", "success"),
      on: {
        LAUNCH: { actions: ({ context }) => trace(context, "core", "rejected") },
        CRASH: { target: "failed", actions: ({ context }) => trace(context, "core", "failure") },
        STOP: { target: "stopping", actions: ({ context }) => trace(context, "core", "accepted") },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "core", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "core", "accepted"),
        },
      },
    },
    stopping: {
      invoke: {
        src: "stop",
        input: ({ context }) => effectInput(context, "core", "core.stop", "finalizer"),
        onDone: { target: "absent", actions: ({ context }) => trace(context, "core", "success") },
        onError: {
          target: "failed",
          actions: ({ context }) => trace(context, "core", "recovery-required"),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "core", "accepted"),
        },
      },
    },
    failed: {
      on: {
        RECOVER: {
          target: "launching",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
        LAUNCH: {
          target: "launching",
          actions: ({ context }) => trace(context, "core", "accepted"),
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "core", "accepted"),
        },
      },
    },
    disposing: {
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "core", "core.dispose", "dispose"),
        onDone: {
          target: "disposed",
          actions: ({ context }) => trace(context, "core", "disposed"),
        },
        onError: {
          target: "failed",
          actions: ({ context }) => trace(context, "core", "recovery-required"),
        },
      },
    },
    disposed: { type: "final" },
  },
});

export type ProfileEvent =
  | { type: "ACTIVATE"; revision?: number; operation?: number }
  | { type: "CANCEL" }
  | { type: "REPLACE"; revision?: number; operation?: number }
  | { type: "RETRY" }
  | { type: "REPAIR" }
  | { type: "DISPOSE" }
  | ({ type: "STALE_COMPLETION" } & Correlation);

export interface ProfileContext extends DomainContext {
  readonly targetRevision: number;
}

export const profileMachine = setup({
  types: {
    context: {} as ProfileContext,
    events: {} as ProfileEvent,
    input: {} as ActorEnvironment,
  },
  actors: {
    activate: invokeEffect,
    observe: invokeEffect,
    rollback: invokeEffect,
    deactivate: invokeEffect,
    dispose: invokeEffect,
  },
}).createMachine({
  id: "mish.profile",
  initial: "inactive",
  context: ({ input }) => ({
    ...input,
    generation: 1,
    operation: 1,
    revision: 1,
    targetRevision: 1,
  }),
  on: {
    STALE_COMPLETION: { actions: ({ context, event }) => stale(context, "profile", event) },
  },
  states: {
    inactive: {
      entry: ({ context }) => trace(context, "profile", "accepted"),
      on: {
        ACTIVATE: {
          target: "activating",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
              targetRevision: positive(
                event.revision ?? context.targetRevision,
                context.targetRevision,
              ),
            })),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
        CANCEL: { actions: ({ context }) => trace(context, "profile", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "profile", "accepted"),
        },
      },
    },
    activating: {
      initial: "preparing",
      on: {
        CANCEL: {
          target: "#profile-cancelling",
          actions: ({ context }) => trace(context, "profile", "cancelled"),
        },
        REPLACE: {
          target: "#profile-replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
              targetRevision: positive(
                event.revision ?? context.targetRevision + 1,
                context.targetRevision + 1,
              ),
            })),
            ({ context }) => trace(context, "profile", "superseded"),
          ],
        },
        DISPOSE: {
          target: "#profile-disposing",
          actions: ({ context }) => trace(context, "profile", "accepted"),
        },
      },
      states: {
        preparing: {
          invoke: {
            src: "activate",
            input: ({ context }) => effectInput(context, "profile", "profile.activate"),
            onDone: {
              target: "#profile-confirming",
              guard: ({ context, event }) => !isStaleOutput(context, event.output),
              actions: ({ context }) => trace(context, "profile", "success"),
            },
            onError: {
              target: "#profile-failed",
              actions: ({ context }) => trace(context, "profile", "failure"),
            },
          },
        },
        confirming: {
          id: "profile-confirming",
          invoke: {
            src: "observe",
            input: ({ context }) => effectInput(context, "profile", "profile.observe"),
            onDone: {
              target: "#profile-active",
              guard: ({ context, event }) => !isStaleOutput(context, event.output),
              actions: ({ context }) => trace(context, "profile", "success"),
            },
            onError: {
              target: "#profile-failed",
              actions: ({ context }) => trace(context, "profile", "failure"),
            },
          },
        },
      },
    },
    replacing: {
      id: "profile-replacing",
      entry: ({ context }) => trace(context, "profile", "superseded"),
      invoke: {
        src: "deactivate",
        input: ({ context }) => effectInput(context, "profile", "profile.deactivate", "finalizer"),
        onDone: {
          target: "activating",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "profile", "finalized"),
          ],
        },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "profile", "recovery-required"),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "profile", "accepted"),
        },
      },
    },
    active: {
      id: "profile-active",
      entry: ({ context }) => trace(context, "profile", "success"),
      on: {
        ACTIVATE: { actions: ({ context }) => trace(context, "profile", "rejected") },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
              targetRevision: positive(
                event.revision ?? context.targetRevision + 1,
                context.targetRevision + 1,
              ),
            })),
            ({ context }) => trace(context, "profile", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "profile", "accepted"),
        },
      },
    },
    cancelling: {
      id: "profile-cancelling",
      entry: ({ context }) => trace(context, "profile", "finalized"),
      invoke: {
        src: "rollback",
        input: ({ context }) => effectInput(context, "profile", "profile.rollback", "finalizer"),
        onDone: {
          target: "inactive",
          actions: ({ context }) => trace(context, "profile", "success"),
        },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "profile", "recovery-required"),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "profile", "accepted"),
        },
      },
    },
    failed: {
      id: "profile-failed",
      entry: ({ context }) => trace(context, "profile", "failure"),
      on: {
        RETRY: {
          target: "activating",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
        ACTIVATE: {
          target: "activating",
          actions: ({ context }) => trace(context, "profile", "accepted"),
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "profile", "accepted"),
        },
      },
    },
    recoveryRequired: {
      id: "profile-recovery",
      entry: ({ context }) => trace(context, "profile", "recovery-required"),
      on: {
        REPAIR: {
          target: "activating",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "profile", "accepted"),
        },
      },
    },
    disposing: {
      id: "profile-disposing",
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "profile", "profile.dispose", "dispose"),
        onDone: {
          target: "disposed",
          actions: ({ context }) => trace(context, "profile", "disposed"),
        },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "profile", "recovery-required"),
        },
      },
    },
    disposed: { type: "final" },
  },
});

export type CaptureEvent =
  | { type: "ENABLE"; operation?: number }
  | { type: "DISABLE" }
  | { type: "CANCEL" }
  | { type: "REPLACE"; operation?: number }
  | { type: "RETRY" }
  | { type: "REPAIR" }
  | { type: "DISPOSE" }
  | ({ type: "STALE_COMPLETION" } & Correlation);

export type CaptureContext = DomainContext;

export const captureMachine = setup({
  types: {
    context: {} as CaptureContext,
    events: {} as CaptureEvent,
    input: {} as ActorEnvironment,
  },
  actors: {
    apply: invokeEffect,
    observe: invokeEffect,
    restore: invokeEffect,
    dispose: invokeEffect,
  },
}).createMachine({
  id: "mish.capture",
  initial: "off",
  context: ({ input }) => ({ ...input, generation: 1, operation: 1, revision: 1 }),
  on: {
    STALE_COMPLETION: { actions: ({ context, event }) => stale(context, "capture", event) },
  },
  states: {
    off: {
      id: "capture-off",
      entry: ({ context }) => trace(context, "capture", "accepted"),
      on: {
        ENABLE: {
          target: "applying",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
        DISABLE: { actions: ({ context }) => trace(context, "capture", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "capture", "accepted"),
        },
      },
    },
    applying: {
      entry: ({ context }) => trace(context, "capture", "accepted"),
      invoke: {
        src: "apply",
        input: ({ context }) => effectInput(context, "capture", "capture.apply"),
        onDone: {
          target: "reconciling",
          guard: ({ context, event }) => !isStaleOutput(context, event.output),
          actions: ({ context }) => trace(context, "capture", "success"),
        },
        onError: {
          target: "compensating",
          actions: ({ context }) => trace(context, "capture", "failure"),
        },
      },
      on: {
        CANCEL: {
          target: "restoring",
          actions: ({ context }) => trace(context, "capture", "cancelled"),
        },
        DISABLE: {
          target: "restoring",
          actions: ({ context }) => trace(context, "capture", "accepted"),
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "capture", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "capture", "accepted"),
        },
      },
    },
    reconciling: {
      entry: ({ context }) => trace(context, "capture", "accepted"),
      invoke: {
        src: "observe",
        input: ({ context }) => effectInput(context, "capture", "capture.observe"),
        onDone: {
          target: "applied",
          guard: ({ context, event }) => !isStaleOutput(context, event.output),
          actions: ({ context }) => trace(context, "capture", "success"),
        },
        onError: {
          target: "compensating",
          actions: ({ context }) => trace(context, "capture", "failure"),
        },
      },
      on: {
        CANCEL: {
          target: "restoring",
          actions: ({ context }) => trace(context, "capture", "cancelled"),
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "capture", "accepted"),
        },
      },
    },
    applied: {
      entry: ({ context }) => trace(context, "capture", "success"),
      on: {
        ENABLE: { actions: ({ context }) => trace(context, "capture", "rejected") },
        DISABLE: {
          target: "restoring",
          actions: ({ context }) => trace(context, "capture", "accepted"),
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "capture", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "capture", "accepted"),
        },
      },
    },
    replacing: {
      entry: ({ context }) => trace(context, "capture", "superseded"),
      invoke: {
        src: "restore",
        input: ({ context }) => effectInput(context, "capture", "capture.restore", "finalizer"),
        onDone: {
          target: "applying",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "capture", "finalized"),
          ],
        },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "capture", "recovery-required"),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "capture", "accepted"),
        },
      },
    },
    restoring: {
      id: "capture-restoring",
      initial: "writing",
      on: {
        DISPOSE: {
          target: "#capture-disposing",
          actions: ({ context }) => trace(context, "capture", "accepted"),
        },
      },
      states: {
        writing: {
          invoke: {
            src: "restore",
            input: ({ context }) => effectInput(context, "capture", "capture.restore", "finalizer"),
            onDone: {
              target: "#capture-restoring-observing",
              actions: ({ context }) => trace(context, "capture", "finalized"),
            },
            onError: {
              target: "#capture-recovery",
              actions: ({ context }) => trace(context, "capture", "recovery-required"),
            },
          },
        },
        observing: {
          id: "capture-restoring-observing",
          invoke: {
            src: "observe",
            input: ({ context }) => effectInput(context, "capture", "capture.observe", "finalizer"),
            onDone: {
              target: "#capture-off",
              guard: ({ context, event }) => !isStaleOutput(context, event.output),
              actions: ({ context }) => trace(context, "capture", "success"),
            },
            onError: {
              target: "#capture-recovery",
              actions: ({ context }) => trace(context, "capture", "recovery-required"),
            },
          },
        },
      },
    },
    compensating: {
      entry: ({ context }) => trace(context, "capture", "finalized"),
      invoke: {
        src: "restore",
        input: ({ context }) => effectInput(context, "capture", "capture.restore", "finalizer"),
        onDone: { target: "off", actions: ({ context }) => trace(context, "capture", "success") },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "capture", "recovery-required"),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "capture", "accepted"),
        },
      },
    },
    recoveryRequired: {
      id: "capture-recovery",
      entry: ({ context }) => trace(context, "capture", "recovery-required"),
      on: {
        REPAIR: {
          target: "restoring",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
        ENABLE: {
          target: "applying",
          actions: ({ context }) => trace(context, "capture", "accepted"),
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "capture", "accepted"),
        },
      },
    },
    disposing: {
      id: "capture-disposing",
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "capture", "capture.dispose", "dispose"),
        onDone: {
          target: "disposed",
          actions: ({ context }) => trace(context, "capture", "disposed"),
        },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "capture", "recovery-required"),
        },
      },
    },
    disposed: { type: "final" },
  },
});

export type UpdaterEvent =
  | { type: "CHECK"; operation?: number }
  | { type: "CANCEL" }
  | { type: "REPLACE"; operation?: number }
  | { type: "RETRY" }
  | { type: "COMMIT" }
  | { type: "RECOVER" }
  | { type: "DISPOSE" }
  | ({ type: "STALE_COMPLETION" } & Correlation);

export type UpdaterContext = DomainContext;

export const updaterMachine = setup({
  types: {
    context: {} as UpdaterContext,
    events: {} as UpdaterEvent,
    input: {} as ActorEnvironment,
  },
  actors: {
    check: invokeEffect,
    verify: invokeEffect,
    cancel: invokeEffect,
    commit: invokeEffect,
    dispose: invokeEffect,
  },
}).createMachine({
  id: "mish.updater",
  initial: "idle",
  context: ({ input }) => ({ ...input, generation: 1, operation: 1, revision: 1 }),
  on: {
    STALE_COMPLETION: { actions: ({ context, event }) => stale(context, "updater", event) },
  },
  states: {
    idle: {
      entry: ({ context }) => trace(context, "updater", "accepted"),
      on: {
        CHECK: {
          target: "checking",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
        COMMIT: { actions: ({ context }) => trace(context, "updater", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "updater", "accepted"),
        },
      },
    },
    checking: {
      initial: "discovering",
      on: {
        CANCEL: {
          target: "#updater-cancelling",
          actions: ({ context }) => trace(context, "updater", "cancelled"),
        },
        REPLACE: {
          target: "#updater-replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "updater", "superseded"),
          ],
        },
        DISPOSE: {
          target: "#updater-disposing",
          actions: ({ context }) => trace(context, "updater", "accepted"),
        },
      },
      states: {
        discovering: {
          invoke: {
            src: "check",
            input: ({ context }) => effectInput(context, "updater", "updater.check"),
            onDone: {
              target: "#updater-verifying",
              guard: ({ context, event }) => !isStaleOutput(context, event.output),
              actions: ({ context }) => trace(context, "updater", "success"),
            },
            onError: {
              target: "#updater-failed",
              actions: ({ context }) => trace(context, "updater", "failure"),
            },
          },
        },
        verifying: {
          id: "updater-verifying",
          invoke: {
            src: "verify",
            input: ({ context }) => effectInput(context, "updater", "updater.verify"),
            onDone: {
              target: "#updater-available",
              guard: ({ context, event }) => !isStaleOutput(context, event.output),
              actions: ({ context }) => trace(context, "updater", "success"),
            },
            onError: {
              target: "#updater-failed",
              actions: ({ context }) => trace(context, "updater", "failure"),
            },
          },
        },
      },
    },
    available: {
      id: "updater-available",
      entry: ({ context }) => trace(context, "updater", "success"),
      on: {
        CHECK: { actions: ({ context }) => trace(context, "updater", "rejected") },
        COMMIT: {
          target: "committing",
          actions: ({ context }) => trace(context, "updater", "accepted"),
        },
        CANCEL: {
          target: "idle",
          actions: ({ context }) => trace(context, "updater", "cancelled"),
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "updater", "accepted"),
        },
      },
    },
    committing: {
      invoke: {
        src: "commit",
        input: ({ context }) => effectInput(context, "updater", "updater.commit"),
        onDone: {
          target: "committed",
          guard: ({ context, event }) => !isStaleOutput(context, event.output),
          actions: ({ context }) => trace(context, "updater", "success"),
        },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "updater", "recovery-required"),
        },
      },
      on: {
        CANCEL: {
          target: "cancelling",
          actions: ({ context }) => trace(context, "updater", "cancelled"),
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "updater", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "updater", "accepted"),
        },
      },
    },
    committed: {
      entry: ({ context }) => trace(context, "updater", "success"),
      on: {
        CHECK: {
          target: "checking",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "updater", "accepted"),
        },
      },
    },
    cancelling: {
      id: "updater-cancelling",
      entry: ({ context }) => trace(context, "updater", "finalized"),
      invoke: {
        src: "cancel",
        input: ({ context }) => effectInput(context, "updater", "updater.cancel", "finalizer"),
        onDone: { target: "idle", actions: ({ context }) => trace(context, "updater", "success") },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "updater", "recovery-required"),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "updater", "accepted"),
        },
      },
    },
    replacing: {
      id: "updater-replacing",
      entry: ({ context }) => trace(context, "updater", "superseded"),
      invoke: {
        src: "cancel",
        input: ({ context }) => effectInput(context, "updater", "updater.cancel", "finalizer"),
        onDone: {
          target: "checking",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "updater", "finalized"),
          ],
        },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "updater", "recovery-required"),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "updater", "accepted"),
        },
      },
    },
    failed: {
      id: "updater-failed",
      entry: ({ context }) => trace(context, "updater", "failure"),
      on: {
        RETRY: {
          target: "checking",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
        CHECK: {
          target: "checking",
          actions: ({ context }) => trace(context, "updater", "accepted"),
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "updater", "accepted"),
        },
      },
    },
    recoveryRequired: {
      entry: ({ context }) => trace(context, "updater", "recovery-required"),
      on: {
        RECOVER: {
          target: "checking",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "updater", "accepted"),
        },
      },
    },
    disposing: {
      id: "updater-disposing",
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "updater", "updater.dispose", "dispose"),
        onDone: {
          target: "disposed",
          actions: ({ context }) => trace(context, "updater", "disposed"),
        },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "updater", "recovery-required"),
        },
      },
    },
    disposed: { type: "final" },
  },
});

export type VpnEvent =
  | { type: "START"; operation?: number }
  | { type: "STOP" }
  | { type: "CANCEL" }
  | { type: "REPLACE"; operation?: number }
  | { type: "RETRY" }
  | { type: "REPAIR" }
  | { type: "DISPOSE" }
  | ({ type: "STALE_COMPLETION" } & Correlation);

export type VpnContext = DomainContext;

export const vpnMachine = setup({
  types: {
    context: {} as VpnContext,
    events: {} as VpnEvent,
    input: {} as ActorEnvironment,
  },
  actors: {
    permission: invokeEffect,
    tunStart: invokeEffect,
    observe: invokeEffect,
    stop: invokeEffect,
    cleanup: invokeEffect,
    dispose: invokeEffect,
  },
}).createMachine({
  id: "mish.vpn",
  initial: "stopped",
  context: ({ input }) => ({ ...input, generation: 1, operation: 1, revision: 1 }),
  on: {
    STALE_COMPLETION: { actions: ({ context, event }) => stale(context, "vpn", event) },
  },
  states: {
    stopped: {
      id: "vpn-stopped",
      entry: ({ context }) => trace(context, "vpn", "accepted"),
      on: {
        START: {
          target: "permission",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
        STOP: { actions: ({ context }) => trace(context, "vpn", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "vpn", "accepted"),
        },
      },
    },
    permission: {
      invoke: {
        src: "permission",
        input: ({ context }) => effectInput(context, "vpn", "vpn.permission"),
        onDone: {
          target: "starting",
          guard: ({ context, event }) => !isStaleOutput(context, event.output),
          actions: ({ context }) => trace(context, "vpn", "success"),
        },
        onError: { target: "failed", actions: ({ context }) => trace(context, "vpn", "failure") },
      },
      on: {
        CANCEL: { target: "stopped", actions: ({ context }) => trace(context, "vpn", "cancelled") },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "vpn", "accepted"),
        },
      },
    },
    starting: {
      id: "vpn-starting",
      initial: "opening",
      on: {
        CANCEL: {
          target: "#vpn-stopping",
          actions: ({ context }) => trace(context, "vpn", "cancelled"),
        },
        REPLACE: {
          target: "#vpn-replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "vpn", "superseded"),
          ],
        },
        DISPOSE: {
          target: "#vpn-disposing",
          actions: ({ context }) => trace(context, "vpn", "accepted"),
        },
      },
      states: {
        opening: {
          invoke: {
            src: "tunStart",
            input: ({ context }) => effectInput(context, "vpn", "vpn.tun.start"),
            onDone: {
              target: "#vpn-starting-observing",
              guard: ({ context, event }) => !isStaleOutput(context, event.output),
              actions: ({ context }) => trace(context, "vpn", "success"),
            },
            onError: {
              target: "#vpn-cleanup-failure",
              actions: ({ context }) => trace(context, "vpn", "failure"),
            },
          },
        },
        observing: {
          id: "vpn-starting-observing",
          invoke: {
            src: "observe",
            input: ({ context }) => effectInput(context, "vpn", "vpn.observe"),
            onDone: {
              target: "#vpn-running",
              guard: ({ context, event }) => !isStaleOutput(context, event.output),
              actions: ({ context }) => trace(context, "vpn", "success"),
            },
            onError: {
              target: "#vpn-cleanup-failure",
              actions: ({ context }) => trace(context, "vpn", "failure"),
            },
          },
        },
      },
    },
    running: {
      id: "vpn-running",
      entry: ({ context }) => trace(context, "vpn", "success"),
      on: {
        START: { actions: ({ context }) => trace(context, "vpn", "rejected") },
        STOP: { target: "stopping", actions: ({ context }) => trace(context, "vpn", "accepted") },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "vpn", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "vpn", "accepted"),
        },
      },
    },
    stopping: {
      id: "vpn-stopping",
      initial: "stoppingCore",
      on: {
        DISPOSE: {
          target: "#vpn-disposing",
          actions: ({ context }) => trace(context, "vpn", "accepted"),
        },
      },
      states: {
        stoppingCore: {
          invoke: {
            src: "stop",
            input: ({ context }) => effectInput(context, "vpn", "vpn.stop", "finalizer"),
            onDone: {
              target: "#vpn-stopping-cleaning",
              actions: ({ context }) => trace(context, "vpn", "finalized"),
            },
            onError: {
              target: "#vpn-recovery",
              actions: ({ context }) => trace(context, "vpn", "recovery-required"),
            },
          },
        },
        cleaning: {
          id: "vpn-stopping-cleaning",
          invoke: {
            src: "cleanup",
            input: ({ context }) => effectInput(context, "vpn", "vpn.cleanup", "finalizer"),
            onDone: {
              target: "#vpn-stopped",
              actions: ({ context }) => trace(context, "vpn", "success"),
            },
            onError: {
              target: "#vpn-recovery",
              actions: ({ context }) => trace(context, "vpn", "recovery-required"),
            },
          },
        },
      },
    },
    replacing: {
      id: "vpn-replacing",
      entry: ({ context }) => trace(context, "vpn", "superseded"),
      initial: "stoppingCore",
      on: {
        DISPOSE: {
          target: "#vpn-disposing",
          actions: ({ context }) => trace(context, "vpn", "accepted"),
        },
      },
      states: {
        stoppingCore: {
          invoke: {
            src: "stop",
            input: ({ context }) => effectInput(context, "vpn", "vpn.stop", "finalizer"),
            onDone: {
              target: "#vpn-replacing-cleaning",
              actions: ({ context }) => trace(context, "vpn", "finalized"),
            },
            onError: {
              target: "#vpn-recovery",
              actions: ({ context }) => trace(context, "vpn", "recovery-required"),
            },
          },
        },
        cleaning: {
          id: "vpn-replacing-cleaning",
          invoke: {
            src: "cleanup",
            input: ({ context }) => effectInput(context, "vpn", "vpn.cleanup", "finalizer"),
            onDone: {
              target: "#vpn-starting",
              actions: [
                assign(({ context }) => ({
                  generation: context.generation + 1,
                  revision: context.revision + 1,
                })),
                ({ context }) => trace(context, "vpn", "finalized"),
              ],
            },
            onError: {
              target: "#vpn-recovery",
              actions: ({ context }) => trace(context, "vpn", "recovery-required"),
            },
          },
        },
      },
    },
    cleanupAfterFailure: {
      id: "vpn-cleanup-failure",
      invoke: {
        src: "cleanup",
        input: ({ context }) => effectInput(context, "vpn", "vpn.cleanup", "finalizer"),
        onDone: { target: "failed", actions: ({ context }) => trace(context, "vpn", "finalized") },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "vpn", "recovery-required"),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "vpn", "accepted"),
        },
      },
    },
    failed: {
      entry: ({ context }) => trace(context, "vpn", "failure"),
      on: {
        RETRY: {
          target: "permission",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
        START: {
          target: "permission",
          actions: ({ context }) => trace(context, "vpn", "accepted"),
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "vpn", "accepted"),
        },
      },
    },
    recoveryRequired: {
      id: "vpn-recovery",
      entry: ({ context }) => trace(context, "vpn", "recovery-required"),
      on: {
        REPAIR: {
          target: "permission",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
        STOP: { target: "stopping", actions: ({ context }) => trace(context, "vpn", "accepted") },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "vpn", "accepted"),
        },
      },
    },
    disposing: {
      id: "vpn-disposing",
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "vpn", "vpn.dispose", "dispose"),
        onDone: { target: "disposed", actions: ({ context }) => trace(context, "vpn", "disposed") },
        onError: {
          target: "recoveryRequired",
          actions: ({ context }) => trace(context, "vpn", "recovery-required"),
        },
      },
    },
    disposed: { type: "final" },
  },
});

export type SettingsRpcEvent =
  | { type: "CONNECT"; operation?: number }
  | { type: "DISCONNECT" }
  | { type: "RECONNECT"; operation?: number }
  | { type: "REFRESH" }
  | { type: "CANCEL" }
  | { type: "RETRY" }
  | { type: "DISPOSE" }
  | { type: "SNAPSHOT"; generation: number; revision: number }
  | ({ type: "STALE_COMPLETION" } & Correlation);

export interface SettingsRpcContext extends DomainContext {
  readonly acceptedSnapshotRevision: number;
}

export const settingsRpcMachine = setup({
  types: {
    context: {} as SettingsRpcContext,
    events: {} as SettingsRpcEvent,
    input: {} as ActorEnvironment,
  },
  actors: {
    connect: invokeEffect,
    authenticate: invokeEffect,
    baseline: invokeEffect,
    disconnect: invokeEffect,
    loadSettings: invokeEffect,
    dispose: invokeEffect,
  },
}).createMachine({
  id: "mish.settings-rpc",
  initial: "disconnected",
  context: ({ input }) => ({
    ...input,
    generation: 1,
    operation: 1,
    revision: 1,
    acceptedSnapshotRevision: 0,
  }),
  on: {
    STALE_COMPLETION: { actions: ({ context, event }) => stale(context, "rpc", event) },
  },
  states: {
    disconnected: {
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      on: {
        CONNECT: {
          target: "connecting",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        REFRESH: { actions: ({ context }) => trace(context, "settings", "rejected") },
        DISCONNECT: { actions: ({ context }) => trace(context, "rpc", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "rpc", "accepted"),
        },
      },
    },
    connecting: {
      invoke: {
        src: "connect",
        input: ({ context }) => effectInput(context, "rpc", "rpc.connect"),
        onDone: {
          target: "authenticating",
          guard: ({ context, event }) => !isStaleOutput(context, event.output),
          actions: ({ context }) => trace(context, "rpc", "success"),
        },
        onError: { target: "failed", actions: ({ context }) => trace(context, "rpc", "failure") },
      },
      on: {
        DISCONNECT: {
          target: "disconnecting",
          actions: ({ context }) => trace(context, "rpc", "cancelled"),
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "rpc", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "rpc", "accepted"),
        },
      },
    },
    authenticating: {
      invoke: {
        src: "authenticate",
        input: ({ context }) => effectInput(context, "rpc", "rpc.authenticate"),
        onDone: {
          target: "syncing",
          guard: ({ context, event }) => !isStaleOutput(context, event.output),
          actions: ({ context }) => trace(context, "rpc", "success"),
        },
        onError: { target: "failed", actions: ({ context }) => trace(context, "rpc", "failure") },
      },
      on: {
        DISCONNECT: {
          target: "disconnecting",
          actions: ({ context }) => trace(context, "rpc", "cancelled"),
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "rpc", "accepted"),
        },
      },
    },
    syncing: {
      invoke: {
        src: "baseline",
        input: ({ context }) => effectInput(context, "rpc", "rpc.baseline"),
        onDone: {
          target: "connected",
          guard: ({ context, event }) => !isStaleOutput(context, event.output),
          actions: [
            assign(({ context }) => ({
              acceptedSnapshotRevision: context.acceptedSnapshotRevision + 1,
            })),
            ({ context }) => trace(context, "rpc", "success"),
          ],
        },
        onError: { target: "failed", actions: ({ context }) => trace(context, "rpc", "failure") },
      },
      on: {
        DISCONNECT: {
          target: "disconnecting",
          actions: ({ context }) => trace(context, "rpc", "cancelled"),
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "rpc", "accepted"),
        },
      },
    },
    connected: {
      entry: ({ context }) => trace(context, "rpc", "success"),
      on: {
        CONNECT: { actions: ({ context }) => trace(context, "rpc", "rejected") },
        REFRESH: {
          target: "refreshing",
          actions: [
            assign(({ context }) => ({
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
        DISCONNECT: {
          target: "disconnecting",
          actions: ({ context }) => trace(context, "rpc", "accepted"),
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "rpc", "superseded"),
          ],
        },
        SNAPSHOT: {
          guard: ({ context, event }) =>
            event.generation === context.generation &&
            event.revision > context.acceptedSnapshotRevision,
          actions: [
            assign(({ context, event }) => ({ acceptedSnapshotRevision: event.revision })),
            ({ context }) => trace(context, "rpc", "success"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "rpc", "accepted"),
        },
      },
    },
    refreshing: {
      invoke: {
        src: "loadSettings",
        input: ({ context }) => effectInput(context, "settings", "settings.load"),
        onDone: {
          target: "connected",
          guard: ({ context, event }) => !isStaleOutput(context, event.output),
          actions: [
            assign(({ context }) => ({
              acceptedSnapshotRevision: context.acceptedSnapshotRevision + 1,
            })),
            ({ context }) => trace(context, "settings", "success"),
          ],
        },
        onError: {
          target: "failed",
          actions: ({ context }) => trace(context, "settings", "failure"),
        },
      },
      on: {
        CANCEL: {
          target: "connected",
          actions: ({ context }) => trace(context, "settings", "cancelled"),
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => ({
              generation: context.generation + 1,
              operation: positive(event.operation ?? context.operation + 1, context.operation + 1),
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "rpc", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "rpc", "accepted"),
        },
      },
    },
    reconnecting: {
      entry: ({ context }) => trace(context, "rpc", "superseded"),
      invoke: {
        src: "disconnect",
        input: ({ context }) => effectInput(context, "rpc", "rpc.disconnect", "finalizer"),
        onDone: {
          target: "connecting",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "rpc", "finalized"),
          ],
        },
        onError: { target: "failed", actions: ({ context }) => trace(context, "rpc", "failure") },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "rpc", "accepted"),
        },
      },
    },
    disconnecting: {
      invoke: {
        src: "disconnect",
        input: ({ context }) => effectInput(context, "rpc", "rpc.disconnect", "finalizer"),
        onDone: {
          target: "disconnected",
          actions: ({ context }) => trace(context, "rpc", "success"),
        },
        onError: { target: "failed", actions: ({ context }) => trace(context, "rpc", "failure") },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "rpc", "accepted"),
        },
      },
    },
    failed: {
      entry: ({ context }) => trace(context, "rpc", "failure"),
      on: {
        RETRY: {
          target: "connecting",
          actions: [
            assign(({ context }) => ({
              generation: context.generation + 1,
              operation: context.operation + 1,
              revision: context.revision + 1,
            })),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        CONNECT: {
          target: "connecting",
          actions: ({ context }) => trace(context, "rpc", "accepted"),
        },
        DISPOSE: {
          target: "disposing",
          actions: ({ context }) => trace(context, "rpc", "accepted"),
        },
      },
    },
    disposing: {
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "rpc", "rpc.dispose", "dispose"),
        onDone: { target: "disposed", actions: ({ context }) => trace(context, "rpc", "disposed") },
        onError: {
          target: "failed",
          actions: ({ context }) => trace(context, "rpc", "recovery-required"),
        },
      },
    },
    disposed: { type: "final" },
  },
});
