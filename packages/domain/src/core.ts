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

export type CoreEvent =
  | { type: "LAUNCH"; operation?: number }
  | { type: "STOP" }
  | { type: "CANCEL" }
  | { type: "REPLACE"; operation?: number }
  | { type: "CRASH" }
  | { type: "RECOVER" }
  | { type: "RETRY" }
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
  initial: "idle",
  context: ({ input }) => initialContext(input),
  on: {
    STALE_COMPLETION: {
      actions: ({ context, event }) => recordExternalCompletion(context, "core", event),
    },
  },
  states: {
    idle: {
      entry: ({ context }) => trace(context, "core", "accepted"),
      on: {
        LAUNCH: {
          target: "launching",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
        STOP: { actions: ({ context }) => trace(context, "core", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
      },
    },
    launching: {
      entry: ({ context }) => trace(context, "core", "accepted"),
      invoke: {
        src: "launch",
        input: ({ context }) => effectInput(context, "core", "core.launch"),
        onDone: [
          {
            target: "ready",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: ({ context }) => trace(context, "core", "success"),
          },
          { actions: ({ context, event }) => staleOutput(context, "core", event.output) },
        ],
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "core", event.error),
        },
      },
      on: {
        LAUNCH: { actions: ({ context }) => trace(context, "core", "duplicate") },
        CANCEL: {
          target: "stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "core", "cancelled"),
          ],
        },
        STOP: {
          target: "stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => beginReplacement(context, event.operation)),
            ({ context }) => trace(context, "core", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
      },
    },
    replacing: {
      entry: ({ context }) => trace(context, "core", "superseded"),
      invoke: {
        src: "stop",
        input: ({ context }) => effectInput(context, "core", "core.stop", "finalizer"),
        onDone: {
          target: "launching",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "core", "finalized"),
          ],
        },
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "core", event.error),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
      },
    },
    ready: {
      entry: ({ context }) => trace(context, "core", "success"),
      on: {
        LAUNCH: { actions: ({ context }) => trace(context, "core", "rejected") },
        CRASH: {
          target: "failed",
          actions: ({ context }) => trace(context, "core", "failure"),
        },
        STOP: {
          target: "stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => beginReplacement(context, event.operation)),
            ({ context }) => trace(context, "core", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
      },
    },
    stopping: {
      entry: ({ context }) => trace(context, "core", "finalized"),
      invoke: {
        src: "stop",
        input: ({ context }) => effectInput(context, "core", "core.stop", "finalizer"),
        onDone: { target: "idle", actions: ({ context }) => trace(context, "core", "success") },
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "core", event.error),
        },
      },
      on: {
        STOP: { actions: ({ context }) => trace(context, "core", "duplicate") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
      },
    },
    failed: {
      entry: ({ context }) => trace(context, "core", "failure"),
      on: {
        RECOVER: {
          target: "launching",
          actions: [
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
        LAUNCH: {
          target: "launching",
          actions: [
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
        RETRY: {
          target: "launching",
          actions: [
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
      },
    },
    disposing: {
      entry: ({ context }) => trace(context, "core", "accepted"),
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "core", "core.dispose", "dispose"),
        onDone: {
          target: "disposed",
          actions: ({ context }) => trace(context, "core", "disposed"),
        },
        onError: {
          target: "disposeRecoveryRequired",
          actions: ({ context, event }) => traceError(context, "core", event.error),
        },
      },
      on: {
        DISPOSE: { actions: ({ context }) => trace(context, "core", "duplicate") },
      },
    },
    disposeRecoveryRequired: {
      id: "core-dispose-recovery",
      entry: ({ context }) => trace(context, "core", "recovery-required"),
      on: {
        RETRY: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "core", "accepted"),
          ],
        },
      },
    },
    disposed: { type: "final" },
  },
});
