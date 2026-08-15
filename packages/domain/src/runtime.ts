import { assign, setup } from "xstate";

import {
  ActorEnvironment,
  Correlation,
  DomainContext,
  beginDispose,
  beginEffect,
  beginOperation,
  beginReplacement,
  beginRequest,
  currentOutput,
  effectInput,
  invokeEffect,
  initialContext,
  recordExternalCompletion,
  staleOutput,
  trace,
  traceError,
} from "./shared.ts";

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
  context: ({ input }) => initialContext(input),
  on: {
    STALE_COMPLETION: {
      actions: ({ context, event }) => recordExternalCompletion(context, "runtime", event),
    },
  },
  states: {
    stopped: {
      entry: ({ context }) => trace(context, "runtime", "accepted"),
      on: {
        START: {
          target: "starting",
          actions: [
            assign(({ context, event }) => beginRequest(context, event.operation)),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
        },
        STOP: { actions: ({ context }) => trace(context, "runtime", "rejected") },
        CANCEL: { actions: ({ context }) => trace(context, "runtime", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
        },
      },
    },
    starting: {
      entry: ({ context }) => trace(context, "runtime", "accepted"),
      invoke: {
        src: "start",
        input: ({ context }) => effectInput(context, "runtime", "runtime.start"),
        onDone: [
          {
            target: "running",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: ({ context }) => trace(context, "runtime", "success"),
          },
          { actions: ({ context, event }) => staleOutput(context, "runtime", event.output) },
        ],
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "runtime", event.error),
        },
      },
      on: {
        START: { actions: ({ context }) => trace(context, "runtime", "duplicate") },
        CANCEL: {
          target: "stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "runtime", "cancelled"),
          ],
        },
        STOP: {
          target: "stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => beginReplacement(context, event.operation)),
            ({ context }) => trace(context, "runtime", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
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
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "runtime", "finalized"),
          ],
        },
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "runtime", event.error),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
        },
      },
    },
    running: {
      entry: ({ context }) => trace(context, "runtime", "success"),
      on: {
        START: { actions: ({ context }) => trace(context, "runtime", "rejected") },
        STOP: {
          target: "stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
        },
        CANCEL: {
          target: "stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "runtime", "cancelled"),
          ],
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => beginReplacement(context, event.operation)),
            ({ context }) => trace(context, "runtime", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
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
          actions: ({ context, event }) => traceError(context, "runtime", event.error),
        },
      },
      on: {
        STOP: { actions: ({ context }) => trace(context, "runtime", "duplicate") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
        },
      },
    },
    failed: {
      entry: ({ context }) => trace(context, "runtime", "failure"),
      on: {
        RETRY: {
          target: "starting",
          actions: [
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
        },
        START: {
          target: "starting",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "runtime", "accepted"),
          ],
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
          actions: ({ context, event }) => traceError(context, "runtime", event.error),
        },
      },
      on: {
        DISPOSE: { actions: ({ context }) => trace(context, "runtime", "duplicate") },
      },
    },
    disposed: { type: "final" },
  },
});
