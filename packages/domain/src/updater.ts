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
  recordExternalCompletion,
  staleOutput,
  trace,
  traceError,
} from "./shared.ts";

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
  context: ({ input }) => initialContext(input),
  on: {
    STALE_COMPLETION: {
      actions: ({ context, event }) => recordExternalCompletion(context, "updater", event),
    },
  },
  states: {
    idle: {
      entry: ({ context }) => trace(context, "updater", "accepted"),
      on: {
        CHECK: {
          target: "checking",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
        COMMIT: { actions: ({ context }) => trace(context, "updater", "rejected") },
        CANCEL: { actions: ({ context }) => trace(context, "updater", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
      },
    },
    checking: {
      initial: "discovering",
      on: {
        CHECK: { actions: ({ context }) => trace(context, "updater", "duplicate") },
        CANCEL: {
          target: "#updater-cancelling",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "updater", "cancelled"),
          ],
        },
        REPLACE: {
          target: "#updater-replacing",
          actions: [
            assign(({ context, event }) => beginReplacement(context, event.operation)),
            ({ context }) => trace(context, "updater", "superseded"),
          ],
        },
        DISPOSE: {
          target: "#updater-disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
      },
      states: {
        discovering: {
          invoke: {
            src: "check",
            input: ({ context }) => effectInput(context, "updater", "updater.check"),
            onDone: [
              {
                target: "#updater-verifying",
                guard: ({ context, event }) => currentOutput(context, event.output),
                actions: [
                  assign(({ context }) => beginEffect(context)),
                  ({ context }) => trace(context, "updater", "success"),
                ],
              },
              { actions: ({ context, event }) => staleOutput(context, "updater", event.output) },
            ],
            onError: {
              target: "#updater-failed",
              actions: ({ context, event }) => traceError(context, "updater", event.error),
            },
          },
        },
        verifying: {
          id: "updater-verifying",
          invoke: {
            src: "verify",
            input: ({ context }) => effectInput(context, "updater", "updater.verify"),
            onDone: [
              {
                target: "#updater-available",
                guard: ({ context, event }) => currentOutput(context, event.output),
                actions: ({ context }) => trace(context, "updater", "success"),
              },
              { actions: ({ context, event }) => staleOutput(context, "updater", event.output) },
            ],
            onError: {
              target: "#updater-failed",
              actions: ({ context, event }) => traceError(context, "updater", event.error),
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
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
        CANCEL: {
          target: "idle",
          actions: ({ context }) => trace(context, "updater", "cancelled"),
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
      },
    },
    committing: {
      entry: ({ context }) => trace(context, "updater", "accepted"),
      invoke: {
        src: "commit",
        input: ({ context }) => effectInput(context, "updater", "updater.commit"),
        onDone: [
          {
            target: "committed",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: ({ context }) => trace(context, "updater", "success"),
          },
          { actions: ({ context, event }) => staleOutput(context, "updater", event.output) },
        ],
        onError: {
          target: "recoveryRequired",
          actions: ({ context, event }) => traceError(context, "updater", event.error),
        },
      },
      on: {
        COMMIT: { actions: ({ context }) => trace(context, "updater", "duplicate") },
        CANCEL: {
          target: "cancelling",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "updater", "cancelled"),
          ],
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => beginReplacement(context, event.operation)),
            ({ context }) => trace(context, "updater", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
      },
    },
    committed: {
      entry: ({ context }) => trace(context, "updater", "success"),
      on: {
        CHECK: {
          target: "checking",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
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
          actions: ({ context, event }) => traceError(context, "updater", event.error),
        },
      },
      on: {
        CANCEL: { actions: ({ context }) => trace(context, "updater", "duplicate") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
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
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "updater", "finalized"),
          ],
        },
        onError: {
          target: "recoveryRequired",
          actions: ({ context, event }) => traceError(context, "updater", event.error),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
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
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
        CHECK: {
          target: "checking",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
      },
    },
    recoveryRequired: {
      id: "updater-recovery",
      entry: ({ context }) => trace(context, "updater", "recovery-required"),
      on: {
        RECOVER: {
          target: "checking",
          actions: [
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
      },
    },
    disposing: {
      id: "updater-disposing",
      entry: ({ context }) => trace(context, "updater", "accepted"),
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "updater", "updater.dispose", "dispose"),
        onDone: {
          target: "disposed",
          actions: ({ context }) => trace(context, "updater", "disposed"),
        },
        onError: {
          target: "disposeRecoveryRequired",
          actions: ({ context, event }) => traceError(context, "updater", event.error),
        },
      },
      on: {
        DISPOSE: { actions: ({ context }) => trace(context, "updater", "duplicate") },
      },
    },
    disposeRecoveryRequired: {
      id: "updater-dispose-recovery",
      entry: ({ context }) => trace(context, "updater", "recovery-required"),
      on: {
        RETRY: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "updater", "accepted"),
          ],
        },
      },
    },
    disposed: { type: "final" },
  },
});
