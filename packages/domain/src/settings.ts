import { assign, setup } from "xstate";

import {
  ActorEnvironment,
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
import {
  SessionBoundaryEvent,
  SnapshotContext,
  SnapshotEvent,
  snapshotContext,
  snapshotIsNewer,
  snapshotResult,
} from "./settings-rpc.ts";

export type SettingsEvent = SessionBoundaryEvent | SnapshotEvent;
export type SettingsContext = SnapshotContext;

const settingsContext = (input: ActorEnvironment): SettingsContext =>
  snapshotContext(initialContext(input));

const resetBaseline = (context: SettingsContext, operation?: number) => ({
  ...beginReplacement(context, operation),
  acceptedSnapshotRevision: 0,
});

const traceSnapshot = (context: SettingsContext, event: SnapshotEvent): void =>
  trace(context, "settings", snapshotResult(context, event));

export const settingsMachine = setup({
  types: {
    context: {} as SettingsContext,
    events: {} as SettingsEvent,
    input: {} as ActorEnvironment,
  },
  actors: {
    connect: invokeEffect,
    authenticate: invokeEffect,
    baseline: invokeEffect,
    disconnect: invokeEffect,
    load: invokeEffect,
    dispose: invokeEffect,
  },
}).createMachine({
  id: "mish.settings",
  initial: "disconnected",
  context: ({ input }) => settingsContext(input),
  on: {
    STALE_COMPLETION: {
      actions: ({ context, event }) => recordExternalCompletion(context, "settings", event),
    },
    SNAPSHOT: {
      actions: ({ context }) => trace(context, "settings", "stale"),
    },
  },
  states: {
    disconnected: {
      entry: ({ context }) => trace(context, "settings", "disconnected"),
      on: {
        CONNECT: {
          target: "connecting",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
        RECONNECT: {
          target: "connecting",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
        REFRESH: { actions: ({ context }) => trace(context, "settings", "rejected") },
        DISCONNECT: { actions: ({ context }) => trace(context, "settings", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
      },
    },
    connecting: {
      entry: ({ context }) => trace(context, "settings", "accepted"),
      invoke: {
        src: "connect",
        input: ({ context }) => effectInput(context, "settings", "settings.connect"),
        onDone: [
          {
            target: "authenticating",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => beginEffect(context)),
              ({ context }) => trace(context, "settings", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "settings", event.output) },
        ],
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "settings", event.error),
        },
      },
      on: {
        CONNECT: { actions: ({ context }) => trace(context, "settings", "duplicate") },
        DISCONNECT: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "settings", "cancelled"),
          ],
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => resetBaseline(context, event.operation)),
            ({ context }) => trace(context, "settings", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
      },
    },
    authenticating: {
      entry: ({ context }) => trace(context, "settings", "accepted"),
      invoke: {
        src: "authenticate",
        input: ({ context }) => effectInput(context, "settings", "settings.authenticate"),
        onDone: [
          {
            target: "baselining",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => beginEffect(context)),
              ({ context }) => trace(context, "settings", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "settings", event.output) },
        ],
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "settings", event.error),
        },
      },
      on: {
        DISCONNECT: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "settings", "cancelled"),
          ],
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => resetBaseline(context, event.operation)),
            ({ context }) => trace(context, "settings", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
      },
    },
    baselining: {
      entry: ({ context }) => trace(context, "settings", "accepted"),
      invoke: {
        src: "baseline",
        input: ({ context }) => effectInput(context, "settings", "settings.baseline"),
        onDone: [
          {
            target: "connected",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => ({ acceptedSnapshotRevision: context.revision })),
              ({ context }) => trace(context, "settings", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "settings", event.output) },
        ],
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "settings", event.error),
        },
      },
      on: {
        DISCONNECT: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "settings", "cancelled"),
          ],
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => resetBaseline(context, event.operation)),
            ({ context }) => trace(context, "settings", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
      },
    },
    connected: {
      entry: ({ context }) => trace(context, "settings", "success"),
      on: {
        CONNECT: { actions: ({ context }) => trace(context, "settings", "rejected") },
        REFRESH: {
          target: "refreshing",
          actions: [
            assign(({ context }) => beginRequest(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
        DISCONNECT: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => resetBaseline(context, event.operation)),
            ({ context }) => trace(context, "settings", "superseded"),
          ],
        },
        SNAPSHOT: [
          {
            guard: ({ context, event }) => snapshotIsNewer(context, event),
            actions: [
              assign(({ event }) => ({ acceptedSnapshotRevision: event.revision })),
              ({ context }) => trace(context, "settings", "success"),
            ],
          },
          { actions: ({ context, event }) => traceSnapshot(context, event) },
        ],
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
      },
    },
    refreshing: {
      entry: ({ context }) => trace(context, "settings", "accepted"),
      invoke: {
        src: "load",
        input: ({ context }) => effectInput(context, "settings", "settings.load"),
        onDone: [
          {
            target: "connected",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => ({ acceptedSnapshotRevision: context.revision })),
              ({ context }) => trace(context, "settings", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "settings", event.output) },
        ],
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "settings", event.error),
        },
      },
      on: {
        REFRESH: { actions: ({ context }) => trace(context, "settings", "duplicate") },
        CANCEL: {
          target: "connected",
          actions: ({ context }) => trace(context, "settings", "cancelled"),
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => resetBaseline(context, event.operation)),
            ({ context }) => trace(context, "settings", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
      },
    },
    reconnecting: {
      entry: ({ context }) => trace(context, "settings", "superseded"),
      invoke: {
        src: "disconnect",
        input: ({ context }) =>
          effectInput(context, "settings", "settings.disconnect", "finalizer"),
        onDone: {
          target: "connecting",
          actions: [
            assign(({ context }) => ({ ...beginEffect(context), acceptedSnapshotRevision: 0 })),
            ({ context }) => trace(context, "settings", "reconnected"),
          ],
        },
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "settings", event.error),
        },
      },
      on: {
        RECONNECT: { actions: ({ context }) => trace(context, "settings", "duplicate") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
      },
    },
    disconnecting: {
      entry: ({ context }) => trace(context, "settings", "finalized"),
      invoke: {
        src: "disconnect",
        input: ({ context }) =>
          effectInput(context, "settings", "settings.disconnect", "finalizer"),
        onDone: {
          target: "disconnected",
          actions: [
            assign(() => ({ acceptedSnapshotRevision: 0 })),
            ({ context }) => trace(context, "settings", "disconnected"),
          ],
        },
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "settings", event.error),
        },
      },
      on: {
        DISCONNECT: { actions: ({ context }) => trace(context, "settings", "duplicate") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
      },
    },
    failed: {
      entry: ({ context }) => trace(context, "settings", "failure"),
      on: {
        RETRY: {
          target: "reconnecting",
          actions: [
            assign(({ context }) => resetBaseline(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
        CONNECT: {
          target: "connecting",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => resetBaseline(context, event.operation)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
      },
    },
    disposing: {
      entry: ({ context }) => trace(context, "settings", "accepted"),
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "settings", "settings.dispose", "dispose"),
        onDone: {
          target: "disposed",
          actions: ({ context }) => trace(context, "settings", "disposed"),
        },
        onError: {
          target: "disposeRecoveryRequired",
          actions: ({ context, event }) => traceError(context, "settings", event.error),
        },
      },
      on: {
        DISPOSE: { actions: ({ context }) => trace(context, "settings", "duplicate") },
      },
    },
    disposeRecoveryRequired: {
      id: "settings-dispose-recovery",
      entry: ({ context }) => trace(context, "settings", "recovery-required"),
      on: {
        RETRY: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
      },
    },
    disposed: { type: "final" },
  },
});
