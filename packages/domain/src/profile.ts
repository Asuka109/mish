import { assign, setup } from "xstate";

import {
  ActorEnvironment,
  Correlation,
  DomainContext,
  beginDispose,
  beginEffect,
  beginOperation,
  beginReplacement,
  currentOutput,
  effectInput,
  invokeEffect,
  initialContext,
  positive,
  recordExternalCompletion,
  staleOutput,
  trace,
  traceError,
} from "./shared.ts";

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

const profileContext = (input: ActorEnvironment): ProfileContext => ({
  ...initialContext(input),
  targetRevision: 1,
});

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
  context: ({ input }) => profileContext(input),
  on: {
    STALE_COMPLETION: {
      actions: ({ context, event }) => recordExternalCompletion(context, "profile", event),
    },
  },
  states: {
    inactive: {
      entry: ({ context }) => trace(context, "profile", "accepted"),
      on: {
        ACTIVATE: {
          target: "activating",
          actions: [
            assign(({ context, event }) => ({
              ...beginOperation(context, event.operation),
              targetRevision: positive(event.revision, context.targetRevision),
            })),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
        CANCEL: { actions: ({ context }) => trace(context, "profile", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
      },
    },
    activating: {
      initial: "preparing",
      on: {
        ACTIVATE: { actions: ({ context }) => trace(context, "profile", "duplicate") },
        CANCEL: {
          target: "#profile-cancelling",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "profile", "cancelled"),
          ],
        },
        REPLACE: {
          target: "#profile-replacing",
          actions: [
            assign(({ context, event }) => ({
              ...beginReplacement(context, event.operation),
              targetRevision: positive(event.revision, context.targetRevision + 1),
            })),
            ({ context }) => trace(context, "profile", "superseded"),
          ],
        },
        DISPOSE: {
          target: "#profile-disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
      },
      states: {
        preparing: {
          invoke: {
            src: "activate",
            input: ({ context }) => effectInput(context, "profile", "profile.activate"),
            onDone: [
              {
                target: "#profile-confirming",
                guard: ({ context, event }) => currentOutput(context, event.output),
                actions: [
                  assign(({ context }) => beginEffect(context)),
                  ({ context }) => trace(context, "profile", "success"),
                ],
              },
              { actions: ({ context, event }) => staleOutput(context, "profile", event.output) },
            ],
            onError: {
              target: "#profile-cancelling",
              actions: [
                assign(({ context }) => beginEffect(context)),
                ({ context, event }) => traceError(context, "profile", event.error),
              ],
            },
          },
        },
        confirming: {
          id: "profile-confirming",
          invoke: {
            src: "observe",
            input: ({ context }) => effectInput(context, "profile", "profile.observe"),
            onDone: [
              {
                target: "#profile-active",
                guard: ({ context, event }) => currentOutput(context, event.output),
                actions: ({ context }) => trace(context, "profile", "success"),
              },
              { actions: ({ context, event }) => staleOutput(context, "profile", event.output) },
            ],
            onError: {
              target: "#profile-cancelling",
              actions: [
                assign(({ context }) => beginEffect(context)),
                ({ context, event }) => traceError(context, "profile", event.error),
              ],
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
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "profile", "finalized"),
          ],
        },
        onError: {
          target: "recoveryRequired",
          actions: ({ context, event }) => traceError(context, "profile", event.error),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
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
              ...beginReplacement(context, event.operation),
              targetRevision: positive(event.revision, context.targetRevision + 1),
            })),
            ({ context }) => trace(context, "profile", "superseded"),
          ],
        },
        CANCEL: { actions: ({ context }) => trace(context, "profile", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
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
          actions: ({ context, event }) => traceError(context, "profile", event.error),
        },
      },
      on: {
        CANCEL: { actions: ({ context }) => trace(context, "profile", "duplicate") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
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
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
        ACTIVATE: {
          target: "activating",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
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
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
      },
    },
    disposeRecoveryRequired: {
      id: "profile-dispose-recovery",
      entry: ({ context }) => trace(context, "profile", "recovery-required"),
      on: {
        RETRY: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "profile", "accepted"),
          ],
        },
      },
    },
    disposing: {
      id: "profile-disposing",
      entry: ({ context }) => trace(context, "profile", "accepted"),
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "profile", "profile.dispose", "dispose"),
        onDone: {
          target: "disposed",
          actions: ({ context }) => trace(context, "profile", "disposed"),
        },
        onError: {
          target: "disposeRecoveryRequired",
          actions: ({ context, event }) => traceError(context, "profile", event.error),
        },
      },
      on: {
        DISPOSE: { actions: ({ context }) => trace(context, "profile", "duplicate") },
      },
    },
    disposed: { type: "final" },
  },
});
