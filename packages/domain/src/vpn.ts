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
  id: "mish.vpn-tun",
  initial: "stopped",
  context: ({ input }) => initialContext(input),
  on: {
    STALE_COMPLETION: {
      actions: ({ context, event }) => recordExternalCompletion(context, "vpn", event),
    },
  },
  states: {
    stopped: {
      id: "vpn-stopped",
      entry: ({ context }) => trace(context, "vpn", "accepted"),
      on: {
        START: {
          target: "permission",
          actions: [
            assign(({ context, event }) => beginOperation(context, event.operation)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
        STOP: { actions: ({ context }) => trace(context, "vpn", "rejected") },
        CANCEL: { actions: ({ context }) => trace(context, "vpn", "rejected") },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
      },
    },
    permission: {
      id: "vpn-permission",
      entry: ({ context }) => trace(context, "vpn", "accepted"),
      invoke: {
        src: "permission",
        input: ({ context }) => effectInput(context, "vpn", "vpn.permission"),
        onDone: [
          {
            target: "starting",
            guard: ({ context, event }) => currentOutput(context, event.output),
            actions: [
              assign(({ context }) => beginEffect(context)),
              ({ context }) => trace(context, "vpn", "success"),
            ],
          },
          { actions: ({ context, event }) => staleOutput(context, "vpn", event.output) },
        ],
        onError: {
          target: "failed",
          actions: ({ context, event }) => traceError(context, "vpn", event.error),
        },
      },
      on: {
        START: { actions: ({ context }) => trace(context, "vpn", "duplicate") },
        CANCEL: {
          target: "stopped",
          actions: ({ context }) => trace(context, "vpn", "cancelled"),
        },
        STOP: {
          target: "stopped",
          actions: ({ context }) => trace(context, "vpn", "cancelled"),
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
      },
    },
    starting: {
      id: "vpn-starting",
      initial: "opening",
      on: {
        START: { actions: ({ context }) => trace(context, "vpn", "duplicate") },
        CANCEL: {
          target: "#vpn-stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "vpn", "cancelled"),
          ],
        },
        STOP: {
          target: "#vpn-stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
        REPLACE: {
          target: "#vpn-replacing",
          actions: [
            assign(({ context, event }) => beginReplacement(context, event.operation)),
            ({ context }) => trace(context, "vpn", "superseded"),
          ],
        },
        DISPOSE: {
          target: "#vpn-disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
      },
      states: {
        opening: {
          invoke: {
            src: "tunStart",
            input: ({ context }) => effectInput(context, "vpn", "vpn.tun.start"),
            onDone: [
              {
                target: "#vpn-starting-observing",
                guard: ({ context, event }) => currentOutput(context, event.output),
                actions: [
                  assign(({ context }) => beginEffect(context)),
                  ({ context }) => trace(context, "vpn", "success"),
                ],
              },
              { actions: ({ context, event }) => staleOutput(context, "vpn", event.output) },
            ],
            onError: {
              target: "#vpn-cleanup-failure",
              actions: [
                assign(({ context }) => beginEffect(context)),
                ({ context, event }) => traceError(context, "vpn", event.error),
              ],
            },
          },
        },
        observing: {
          id: "vpn-starting-observing",
          invoke: {
            src: "observe",
            input: ({ context }) => effectInput(context, "vpn", "vpn.observe"),
            onDone: [
              {
                target: "#vpn-running",
                guard: ({ context, event }) => currentOutput(context, event.output),
                actions: ({ context }) => trace(context, "vpn", "success"),
              },
              { actions: ({ context, event }) => staleOutput(context, "vpn", event.output) },
            ],
            onError: {
              target: "#vpn-cleanup-failure",
              actions: [
                assign(({ context }) => beginEffect(context)),
                ({ context, event }) => traceError(context, "vpn", event.error),
              ],
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
        STOP: {
          target: "stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
        CANCEL: {
          target: "stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "vpn", "cancelled"),
          ],
        },
        REPLACE: {
          target: "replacing",
          actions: [
            assign(({ context, event }) => beginReplacement(context, event.operation)),
            ({ context }) => trace(context, "vpn", "superseded"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
      },
    },
    stopping: {
      id: "vpn-stopping",
      initial: "stoppingCore",
      on: {
        STOP: { actions: ({ context }) => trace(context, "vpn", "duplicate") },
        DISPOSE: {
          target: "#vpn-disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
      },
      states: {
        stoppingCore: {
          invoke: {
            src: "stop",
            input: ({ context }) => effectInput(context, "vpn", "vpn.stop", "finalizer"),
            onDone: {
              target: "#vpn-stopping-cleaning",
              actions: [
                assign(({ context }) => beginEffect(context)),
                ({ context }) => trace(context, "vpn", "finalized"),
              ],
            },
            onError: {
              target: "#vpn-recovery",
              actions: ({ context, event }) => traceError(context, "vpn", event.error),
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
              actions: ({ context, event }) => traceError(context, "vpn", event.error),
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
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
      },
      states: {
        stoppingCore: {
          invoke: {
            src: "stop",
            input: ({ context }) => effectInput(context, "vpn", "vpn.stop", "finalizer"),
            onDone: {
              target: "#vpn-replacing-cleaning",
              actions: [
                assign(({ context }) => beginEffect(context)),
                ({ context }) => trace(context, "vpn", "finalized"),
              ],
            },
            onError: {
              target: "#vpn-recovery",
              actions: ({ context, event }) => traceError(context, "vpn", event.error),
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
                assign(({ context }) => beginEffect(context)),
                ({ context }) => trace(context, "vpn", "finalized"),
              ],
            },
            onError: {
              target: "#vpn-recovery",
              actions: ({ context, event }) => traceError(context, "vpn", event.error),
            },
          },
        },
      },
    },
    cleanupAfterFailure: {
      id: "vpn-cleanup-failure",
      entry: ({ context }) => trace(context, "vpn", "finalized"),
      invoke: {
        src: "cleanup",
        input: ({ context }) => effectInput(context, "vpn", "vpn.cleanup", "finalizer"),
        onDone: { target: "failed", actions: ({ context }) => trace(context, "vpn", "finalized") },
        onError: {
          target: "recoveryRequired",
          actions: ({ context, event }) => traceError(context, "vpn", event.error),
        },
      },
      on: {
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
      },
    },
    failed: {
      entry: ({ context }) => trace(context, "vpn", "failure"),
      on: {
        RETRY: {
          target: "permission",
          actions: [
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
        START: {
          target: "permission",
          actions: [
            assign(({ context }) => beginOperation(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
      },
    },
    recoveryRequired: {
      id: "vpn-recovery",
      entry: ({ context }) => trace(context, "vpn", "recovery-required"),
      on: {
        REPAIR: {
          target: "repairing",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
        STOP: {
          target: "stopping",
          actions: [
            assign(({ context }) => beginEffect(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
      },
    },
    repairing: {
      id: "vpn-repairing",
      initial: "cleaning",
      on: {
        REPAIR: { actions: ({ context }) => trace(context, "vpn", "duplicate") },
        DISPOSE: {
          target: "#vpn-disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
      },
      states: {
        cleaning: {
          invoke: {
            src: "cleanup",
            input: ({ context }) => effectInput(context, "vpn", "vpn.cleanup", "finalizer"),
            onDone: {
              target: "#vpn-repair-observing",
              actions: [
                assign(({ context }) => beginEffect(context)),
                ({ context }) => trace(context, "vpn", "finalized"),
              ],
            },
            onError: {
              target: "#vpn-recovery",
              actions: ({ context, event }) => traceError(context, "vpn", event.error),
            },
          },
        },
        observing: {
          id: "vpn-repair-observing",
          invoke: {
            src: "observe",
            input: ({ context }) => effectInput(context, "vpn", "vpn.observe", "finalizer"),
            onDone: {
              target: "#vpn-permission",
              guard: ({ context, event }) => currentOutput(context, event.output),
              actions: [
                assign(({ context }) => beginOperation(context)),
                ({ context }) => trace(context, "vpn", "success"),
              ],
            },
            onError: {
              target: "#vpn-recovery",
              actions: ({ context, event }) => traceError(context, "vpn", event.error),
            },
          },
        },
      },
    },
    disposing: {
      id: "vpn-disposing",
      entry: ({ context }) => trace(context, "vpn", "accepted"),
      invoke: {
        src: "dispose",
        input: ({ context }) => effectInput(context, "vpn", "vpn.dispose", "dispose"),
        onDone: { target: "disposed", actions: ({ context }) => trace(context, "vpn", "disposed") },
        onError: {
          target: "disposeRecoveryRequired",
          actions: ({ context, event }) => traceError(context, "vpn", event.error),
        },
      },
      on: {
        DISPOSE: { actions: ({ context }) => trace(context, "vpn", "duplicate") },
      },
    },
    disposeRecoveryRequired: {
      id: "vpn-dispose-recovery",
      entry: ({ context }) => trace(context, "vpn", "recovery-required"),
      on: {
        RETRY: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
        DISPOSE: {
          target: "disposing",
          actions: [
            assign(({ context }) => beginDispose(context)),
            ({ context }) => trace(context, "vpn", "accepted"),
          ],
        },
      },
    },
    disposed: { type: "final" },
  },
});

/** Explicit alias used by host composition to name the VPN/TUN lifecycle. */
export const vpnTunMachine = vpnMachine;
