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

export type SettingsRpcEvent =
  | { type: "CONNECT"; operation?: number }
  | { type: "DISCONNECT" }
  | { type: "RECONNECT"; operation?: number }
  | { type: "REFRESH" }
  | { type: "CANCEL" }
  | { type: "RETRY" }
  | { type: "DISPOSE" }
  | { type: "SNAPSHOT"; generation: number; revision: number; effectId?: number }
  | ({ type: "STALE_COMPLETION" } & Correlation);

export interface SettingsRpcContext extends DomainContext {
  readonly acceptedSnapshotRevision: number;
}

const settingsRpcContext = (input: ActorEnvironment): SettingsRpcContext => ({
  ...initialContext(input),
  acceptedSnapshotRevision: 0,
});

const newerSnapshot = (
  context: SettingsRpcContext,
  event: Extract<SettingsRpcEvent, { type: "SNAPSHOT" }>,
): boolean =>
  event.generation === context.generation && event.revision > context.acceptedSnapshotRevision;

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
  id: "mish.rpc-session",
  initial: "disconnected",
  context: ({ input }) => settingsRpcContext(input),
  on: {
    STALE_COMPLETION: {
      actions: ({ context, event }) => recordExternalCompletion(context, "rpc", event),
    },
  },
  states: {
    disconnected: {
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      on: {
        CONNECT: {
          target: "connecting",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        RECONNECT: {
          target: "connecting",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        REFRESH: { actions: ({ context }) => trace(context, "settings", "rejected") },
        DISCONNECT: { actions: ({ context }) => trace(context, "rpc", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
      },
    },
    connecting: {
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      invoke: {
        src: "connect",
        input: ({ context }) => effectInput(context, "rpc", "rpc.connect"),
        onDone: [
          {
            target: "authenticating",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => beginEffect(context)),
              ({ context }) => trace(context, "rpc", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "rpc", event.output) },
        ],
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "rpc", event.error),
        },
      },
      on: {
        CONNECT: { actions: ({ context }) => trace(context, "rpc", "duplicate") },
        DISCONNECT: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "cancelled"),
          ],
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => beginReplacement(context, event.operation)),
            ({ context }) => trace(context, "rpc", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
      },
    },
    authenticating: {
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      invoke: {
        src: "authenticate",
        input: ({ context }) => effectInput(context, "rpc", "rpc.authenticate"),
        onDone: [
          {
            target: "syncing",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => beginEffect(context)),
              ({ context }) => trace(context, "rpc", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "rpc", event.output) },
        ],
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "rpc", event.error),
        },
      },
      on: {
        DISCONNECT: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "cancelled"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
      },
    },
    syncing: {
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      invoke: {
        src: "baseline",
        input: ({ context }) => effectInput(context, "rpc", "rpc.baseline"),
        onDone: [
          {
            target: "connected",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => ({ acceptedSnapshotRevision: context.revision })),
              ({ context }) => trace(context, "rpc", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "rpc", event.output) },
        ],
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "rpc", event.error),
        },
      },
      on: {
        DISCONNECT: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "cancelled"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
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
            assign(({ context }) => beginRequest(context)),
            ({ context }) => trace(context, "settings", "accepted"),
          ],
        },
        DISCONNECT: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => ({
              ...beginReplacement(context, event.operation),
              acceptedSnapshotRevision: 0,
            })),
            ({ context }) => trace(context, "rpc", "superseded"),
          ],
        },
        SNAPSHOT: [
          {
            guard: ({ context, event }) => newerSnapshot(context, event),
            actions: [
              assign(({ event }) => ({ acceptedSnapshotRevision: event.revision })),
              ({ context }) => trace(context, "rpc", "success"),
            ],
          },
          {
            actions: ({ context, event }) =>
              trace(
                context,
                "rpc",
                event.generation === context.generation &&
                  event.revision === context.acceptedSnapshotRevision
                  ? "equal"
                  : "stale",
              ),
          },
        ],
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
      },
    },
    refreshing: {
      entry: ({ context }) => trace(context, "settings", "accepted"),
      invoke: {
        src: "loadSettings",
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
            assign(({ context, event }) => ({
              ...beginReplacement(context, event.operation),
              acceptedSnapshotRevision: 0,
            })),
            ({ context }) => trace(context, "rpc", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
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
            assign(({ context }) => ({ ...beginEffect(context), acceptedSnapshotRevision: 0 })),
            ({ context }) => trace(context, "rpc", "finalized"),
          ],
        },
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "rpc", event.error),
        },
      },
      on: {
        RECONNECT: { actions: ({ context }) => trace(context, "rpc", "duplicate") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
      },
    },
    disconnecting: {
      entry: ({ context }) => trace(context, "rpc", "finalized"),
      invoke: {
        src: "disconnect",
        input: ({ context }) => effectInput(context, "rpc", "rpc.disconnect", "finalizer"),
        onDone: {
          target: "disconnected",
          actions: [
            assign(() => ({ acceptedSnapshotRevision: 0 })),
            ({ context }) => trace(context, "rpc", "success"),
          ],
        },
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "rpc", event.error),
        },
      },
      on: {
        DISCONNECT: { actions: ({ context }) => trace(context, "rpc", "duplicate") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
      },
    },
    failed: {
      entry: ({ context }) => trace(context, "rpc", "failure"),
      on: {
        RETRY: {
          target: "connecting",
          actions: [
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        CONNECT: {
          target: "connecting",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
      },
    },
    disposing: {
      id: "rpc-disposing",
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "rpc", "rpc.dispose", "dispose"),
        onDone: { target: "disposed", actions: ({ context }) => trace(context, "rpc", "disposed") },
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "rpc", event.error),
        },
      },
      on: {
        DISPOSE: { actions: ({ context }) => trace(context, "rpc", "duplicate") },
      },
    },
    disposed: { type: "final" },
  },
});

/** Settings refresh and the RPC session share one actor authority. */
export const settingsMachine = settingsRpcMachine;
export const rpcSessionMachine = settingsRpcMachine;
