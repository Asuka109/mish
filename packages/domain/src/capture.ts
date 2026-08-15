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
  context: ({ input }) => initialContext(input),
  on: {
    STALE_COMPLETION: {
      actions: ({ context, event }) => recordExternalCompletion(context, "capture", event),
    },
  },
  states: {
    off: {
      id: "capture-off",
      entry: ({ context }) => trace(context, "capture", "accepted"),
      on: {
        ENABLE: {
          target: "applying",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
        DISABLE: { actions: ({ context }) => trace(context, "capture", "rejected") },
        CANCEL: { actions: ({ context }) => trace(context, "capture", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
      },
    },
    applying: {
      entry: ({ context }) => trace(context, "capture", "accepted"),
      invoke: {
        src: "apply",
        input: ({ context }) => effectInput(context, "capture", "capture.apply"),
        onDone: [
          {
            target: "reconciling",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => beginEffect(context)),
              ({ context }) => trace(context, "capture", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "capture", event.output) },
        ],
        onError: {
          target: "compensating",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context, event }) => traceError(context, "capture", event.error),
          ],
        },
      },
      on: {
        ENABLE: { actions: ({ context }) => trace(context, "capture", "duplicate") },
        CANCEL: {
          target: "restoring",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "capture", "cancelled"),
          ],
        },
        DISABLE: {
          target: "restoring",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => beginReplacement(context, event.operation)),
            ({ context }) => trace(context, "capture", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
      },
    },
    reconciling: {
      entry: ({ context }) => trace(context, "capture", "accepted"),
      invoke: {
        src: "observe",
        input: ({ context }) => effectInput(context, "capture", "capture.observe"),
        onDone: [
          {
            target: "applied",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: ({ context }) => trace(context, "capture", "success"),
          },
          { actions: ({ context, event }) => staleOutput(context, "capture", event.output) },
        ],
        onError: {
          target: "compensating",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context, event }) => traceError(context, "capture", event.error),
          ],
        },
      },
      on: {
        ENABLE: { actions: ({ context }) => trace(context, "capture", "duplicate") },
        CANCEL: {
          target: "restoring",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "capture", "cancelled"),
          ],
        },
        DISABLE: {
          target: "restoring",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
      },
    },
    applied: {
      entry: ({ context }) => trace(context, "capture", "success"),
      on: {
        ENABLE: { actions: ({ context }) => trace(context, "capture", "rejected") },
        DISABLE: {
          target: "restoring",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
        CANCEL: {
          target: "restoring",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "capture", "cancelled"),
          ],
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => beginReplacement(context, event.operation)),
            ({ context }) => trace(context, "capture", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
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
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "capture", "finalized"),
          ],
        },
        onError: {
          target: "recoveryRequired",
          actions: ({ context, event }) => traceError(context, "capture", event.error),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
      },
    },
    restoring: {
      initial: "writing",
      on: {
        DISPOSE: {
          target: "#capture-disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
      },
      states: {
        writing: {
          invoke: {
            src: "restore",
            input: ({ context }) => effectInput(context, "capture", "capture.restore", "finalizer"),
            onDone: {
              target: "#capture-restoring-observing",
              actions: [
                assign(({ context }) => beginEffect(context)),
                ({ context }) => trace(context, "capture", "finalized"),
              ],
            },
            onError: {
              target: "#capture-recovery",
              actions: ({ context, event }) => traceError(context, "capture", event.error),
            },
          },
        },
        observing: {
          id: "capture-restoring-observing",
          invoke: {
            src: "observe",
            input: ({ context }) => effectInput(context, "capture", "capture.observe", "finalizer"),
            onDone: [
              {
                target: "#capture-off",
                guard: ({ context, event }) => currentOutput(context, event.output),
                actions: ({ context }) => trace(context, "capture", "success"),
              },
              { actions: ({ context, event }) => staleOutput(context, "capture", event.output) },
            ],
            onError: {
              target: "#capture-recovery",
              actions: ({ context, event }) => traceError(context, "capture", event.error),
            },
          },
        },
      },
    },
    compensating: {
      entry: ({ context }) => trace(context, "capture", "finalized"),
      initial: "restoring",
      states: {
        restoring: {
          invoke: {
            src: "restore",
            input: ({ context }) => effectInput(context, "capture", "capture.restore", "finalizer"),
            onDone: {
              target: "#capture-compensating-observing",
              actions: [
                assign(({ context }) => beginEffect(context)),
                ({ context }) => trace(context, "capture", "finalized"),
              ],
            },
            onError: {
              target: "#capture-recovery",
              actions: ({ context, event }) => traceError(context, "capture", event.error),
            },
          },
        },
        observing: {
          id: "capture-compensating-observing",
          invoke: {
            src: "observe",
            input: ({ context }) => effectInput(context, "capture", "capture.observe", "finalizer"),
            onDone: [
              {
                target: "#capture-off",
                guard: ({ context, event }) => currentOutput(context, event.output),
                actions: ({ context }) => trace(context, "capture", "success"),
              },
              { actions: ({ context, event }) => staleOutput(context, "capture", event.output) },
            ],
            onError: {
              target: "#capture-recovery",
              actions: ({ context, event }) => traceError(context, "capture", event.error),
            },
          },
        },
      },
      on: {
        DISPOSE: {
          target: "#capture-disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
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
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
        ENABLE: {
          target: "applying",
          actions: [
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
      },
    },
    disposing: {
      id: "capture-disposing",
      entry: ({ context }) => trace(context, "capture", "accepted"),
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "capture", "capture.dispose", "dispose"),
        onDone: {
          target: "disposed",
          actions: ({ context }) => trace(context, "capture", "disposed"),
        },
        onError: {
          target: "disposeRecoveryRequired",
          actions: ({ context, event }) => traceError(context, "capture", event.error),
        },
      },
      on: {
        DISPOSE: { actions: ({ context }) => trace(context, "capture", "duplicate") },
      },
    },
    disposeRecoveryRequired: {
      id: "capture-dispose-recovery",
      entry: ({ context }) => trace(context, "capture", "recovery-required"),
      on: {
        RETRY: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "capture", "accepted"),
          ],
        },
      },
    },
    disposed: { type: "final" },
  },
});
