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
} from "./shared.js";
import {
  SessionBoundaryEvent,
  SnapshotContext,
  SnapshotEvent,
  snapshotContext,
  snapshotIsNewer,
  snapshotResult,
} from "./settings-rpc.js";

export const RPC_RECONNECT_ATTEMPT_LIMIT = 3 as const;

export type RpcSessionEvent = SessionBoundaryEvent | SnapshotEvent;

export interface RpcSessionContext extends SnapshotContext {
  readonly reconnectAttempts: number;
}

const rpcSessionContext = (input: ActorEnvironment): RpcSessionContext => ({
  ...snapshotContext(initialContext(input)),
  reconnectAttempts: 0,
});

const resetBaseline = (context: RpcSessionContext, operation?: number) => ({
  ...beginReplacement(context, operation),
  acceptedSnapshotRevision: 0,
  reconnectAttempts: 0,
});

const traceSnapshot = (context: RpcSessionContext, event: SnapshotEvent): void =>
  trace(context, "rpc", snapshotResult(context, event));

export const rpcSessionMachine = setup({
  types: {
    context: {} as RpcSessionContext,
    events: {} as RpcSessionEvent,
    input: {} as ActorEnvironment,
  },
  actors: {
    connect: invokeEffect,
    authenticate: invokeEffect,
    baseline: invokeEffect,
    disconnect: invokeEffect,
    dispose: invokeEffect,
  },
}).createMachine({
  id: "mish.rpc-session",
  initial: "disconnected",
  context: ({ input }) => rpcSessionContext(input),
  on: {
    STALE_COMPLETION: {
      actions: ({ context, event }) => recordExternalCompletion(context, "rpc", event),
    },
    SNAPSHOT: {
      actions: ({ context }) => trace(context, "rpc", "stale"),
    },
  },
  states: {
    disconnected: {
      entry: ({ context }) => trace(context, "rpc", "disconnected"),
      on: {
        CONNECT: {
          target: "connecting",
          actions: [
            assign(({ context, event }) => ({
              ...beginOperation(context, event.operation),
              reconnectAttempts: 0,
            })),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        RECONNECT: {
          target: "connecting",
          actions: [
            assign(({ context, event }) => ({
              ...beginOperation(context, event.operation),
              reconnectAttempts: 0,
            })),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        REFRESH: { actions: ({ context }) => trace(context, "rpc", "rejected") },
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
        CANCEL: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "cancelled"),
          ],
        },
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
            assign(({ context, event }) => resetBaseline(context, event.operation)),
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
            target: "connected-stale",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => ({ ...beginEffect(context), acceptedSnapshotRevision: 0 })),
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
        CANCEL: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "cancelled"),
          ],
        },
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
            assign(({ context, event }) => resetBaseline(context, event.operation)),
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
    "connected-stale": {
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      invoke: {
        src: "baseline",
        input: ({ context }) => effectInput(context, "rpc", "rpc.baseline"),
        onDone: [
          {
            target: "connected-current",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => ({
                acceptedSnapshotRevision: context.revision,
                reconnectAttempts: 0,
              })),
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
        SNAPSHOT: { actions: ({ context }) => trace(context, "rpc", "stale") },
        CANCEL: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "cancelled"),
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
            assign(({ context, event }) => resetBaseline(context, event.operation)),
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
    "connected-current": {
      entry: ({ context }) => trace(context, "rpc", "success"),
      on: {
        CONNECT: { actions: ({ context }) => trace(context, "rpc", "rejected") },
        CANCEL: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "cancelled"),
          ],
        },
        REFRESH: {
          target: "connected-stale",
          actions: [
            assign(({ context }) => ({ ...beginRequest(context), acceptedSnapshotRevision: 0 })),
            ({ context }) => trace(context, "rpc", "accepted"),
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
            assign(({ context, event }) => resetBaseline(context, event.operation)),
            ({ context }) => trace(context, "rpc", "superseded"),
          ],
        },
        SNAPSHOT: [
          {
            guard: ({ context, event }) => snapshotIsNewer(context, event),
            actions: [
              assign(({ event }) => ({ acceptedSnapshotRevision: event.revision })),
              ({ context }) => trace(context, "rpc", "success"),
            ],
          },
          { actions: ({ context, event }) => traceSnapshot(context, event) },
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
    reconnecting: {
      entry: ({ context }) => trace(context, "rpc", "superseded"),
      invoke: {
        src: "disconnect",
        input: ({ context }) => effectInput(context, "rpc", "rpc.disconnect", "finalizer"),
        onDone: {
          target: "reconnectConnecting",
          actions: [
            assign(({ context }) => ({ ...beginEffect(context), acceptedSnapshotRevision: 0 })),
            ({ context }) => trace(context, "rpc", "reconnected"),
          ],
        },
        onError: {
          target: "recoveryRequired",
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
    reconnectConnecting: {
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      invoke: {
        src: "connect",
        input: ({ context }) => effectInput(context, "rpc", "rpc.connect"),
        onDone: [
          {
            target: "reconnectAuthenticating",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => beginEffect(context)),
              ({ context }) => trace(context, "rpc", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "rpc", event.output) },
        ],
        onError: [
          {
            target: "disconnected",
            guard: ({ context }) => context.reconnectAttempts + 1 >= RPC_RECONNECT_ATTEMPT_LIMIT,
            actions: [
              assign(({ context }) => ({
                reconnectAttempts: context.reconnectAttempts + 1,
                acceptedSnapshotRevision: 0,
              })),
              ({ context, event }) => traceError(context, "rpc", event.error),
              ({ context }) => trace(context, "rpc", "disconnected"),
            ],
          },
          {
            target: "reconnectAttemptRetrying",
            actions: [
              assign(({ context }) => ({
                ...beginOperation(context),
                acceptedSnapshotRevision: 0,
                reconnectAttempts: context.reconnectAttempts + 1,
              })),
              ({ context, event }) => traceError(context, "rpc", event.error),
            ],
          },
        ],
      },
      on: {
        CANCEL: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "cancelled"),
          ],
        },
        DISCONNECT: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
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
    reconnectAuthenticating: {
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      invoke: {
        src: "authenticate",
        input: ({ context }) => effectInput(context, "rpc", "rpc.authenticate"),
        onDone: [
          {
            target: "reconnectBaselining",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => beginEffect(context)),
              ({ context }) => trace(context, "rpc", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "rpc", event.output) },
        ],
        onError: [
          {
            target: "disconnected",
            guard: ({ context }) => context.reconnectAttempts + 1 >= RPC_RECONNECT_ATTEMPT_LIMIT,
            actions: [
              assign(({ context }) => ({
                reconnectAttempts: context.reconnectAttempts + 1,
                acceptedSnapshotRevision: 0,
              })),
              ({ context, event }) => traceError(context, "rpc", event.error),
              ({ context }) => trace(context, "rpc", "disconnected"),
            ],
          },
          {
            target: "reconnectAttemptRetrying",
            actions: [
              assign(({ context }) => ({
                ...beginOperation(context),
                acceptedSnapshotRevision: 0,
                reconnectAttempts: context.reconnectAttempts + 1,
              })),
              ({ context, event }) => traceError(context, "rpc", event.error),
            ],
          },
        ],
      },
      on: {
        CANCEL: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "cancelled"),
          ],
        },
        DISCONNECT: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
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
    reconnectBaselining: {
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      invoke: {
        src: "baseline",
        input: ({ context }) => effectInput(context, "rpc", "rpc.baseline"),
        onDone: [
          {
            target: "connected-current",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => ({
                acceptedSnapshotRevision: context.revision,
                reconnectAttempts: 0,
              })),
              ({ context }) => trace(context, "rpc", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "rpc", event.output) },
        ],
        onError: [
          {
            target: "disconnected",
            guard: ({ context }) => context.reconnectAttempts + 1 >= RPC_RECONNECT_ATTEMPT_LIMIT,
            actions: [
              assign(({ context }) => ({
                reconnectAttempts: context.reconnectAttempts + 1,
                acceptedSnapshotRevision: 0,
              })),
              ({ context, event }) => traceError(context, "rpc", event.error),
              ({ context }) => trace(context, "rpc", "disconnected"),
            ],
          },
          {
            target: "reconnectAttemptRetrying",
            actions: [
              assign(({ context }) => ({
                ...beginOperation(context),
                acceptedSnapshotRevision: 0,
                reconnectAttempts: context.reconnectAttempts + 1,
              })),
              ({ context, event }) => traceError(context, "rpc", event.error),
            ],
          },
        ],
      },
      on: {
        CANCEL: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "cancelled"),
          ],
        },
        DISCONNECT: {
          target: "disconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
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
    reconnectAttemptRetrying: {
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      always: { target: "reconnectConnecting" },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
      },
    },
    recoveryRequired: {
      id: "rpc-recovery",
      entry: ({ context }) => trace(context, "rpc", "recovery-required"),
      on: {
        RETRY: {
          target: "reconnecting",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => resetBaseline(context, event.operation)),
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
    disconnecting: {
      entry: ({ context }) => trace(context, "rpc", "finalized"),
      invoke: {
        src: "disconnect",
        input: ({ context }) => effectInput(context, "rpc", "rpc.disconnect", "finalizer"),
        onDone: {
          target: "disconnected",
          actions: [
            assign(() => ({ acceptedSnapshotRevision: 0, reconnectAttempts: 0 })),
            ({ context }) => trace(context, "rpc", "disconnected"),
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
            assign(({ context }) => ({
              ...beginOperation(context),
              acceptedSnapshotRevision: 0,
              reconnectAttempts: 0,
            })),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        CONNECT: {
          target: "connecting",
          actions: [
            assign(({ context, event }) => ({
              ...beginOperation(context, event.operation),
              reconnectAttempts: 0,
            })),
            ({ context }) => trace(context, "rpc", "accepted"),
          ],
        },
        RECONNECT: {
          target: "reconnecting",
          actions: [
            assign(({ context, event }) => resetBaseline(context, event.operation)),
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
      entry: ({ context }) => trace(context, "rpc", "accepted"),
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "rpc", "rpc.dispose", "dispose"),
        onDone: {
          target: "disposed",
          actions: ({ context }) => trace(context, "rpc", "disposed"),
        },
        onError: {
          target: "disposeRecoveryRequired",
          actions: ({ context, event }) => traceError(context, "rpc", event.error),
        },
      },
      on: {
        DISPOSE: { actions: ({ context }) => trace(context, "rpc", "duplicate") },
      },
    },
    disposeRecoveryRequired: {
      id: "rpc-dispose-recovery",
      entry: ({ context }) => trace(context, "rpc", "recovery-required"),
      on: {
        RETRY: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
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
    disposed: { type: "final" },
  },
});
