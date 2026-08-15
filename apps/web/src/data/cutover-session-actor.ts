import {
  DomainEffectError,
  SemanticTranscript,
  createDomainActor,
  type DomainActor,
  type DomainEffects,
  type EffectInvocation,
  type EffectOutput,
  type RpcSessionContext,
  type RpcSessionEvent,
} from "@mish/domain";
import { OrpcSessionError, type OrpcChannel, type OrpcSessionAuthority } from "@mish/orpc-client";
import {
  MAX_STREAM_CHUNKS,
  consumeEventIterator,
  createQueryEventSink,
  type EventIteratorRun,
  type QueryClient,
  type QueryKey,
} from "@mish/ui-state";
import type { OrpcEventValue } from "@mish/contracts";

export const CUTOVER_SESSION_QUERY_KEY = ["web", "orpc", "session"] as const;
export const CUTOVER_SESSION_STREAM_QUERY_KEY = ["web", "orpc", "session-stream"] as const;

export interface CutoverSessionQueryData {
  readonly generation: number;
  readonly parentEpoch: number;
  readonly revision: number;
}

export interface CutoverSessionStreamData {
  readonly generation: number;
  readonly parentEpoch: number;
  readonly revision: number;
  readonly lastSequence: number;
  readonly lastValue: OrpcEventValue["value"];
  readonly chunks: readonly OrpcEventValue[];
}

export interface CutoverSessionPort {
  readonly authority: Pick<
    OrpcSessionAuthority,
    | "connect"
    | "disconnect"
    | "dispose"
    | "state"
    | "sessionGeneration"
    | "parentEpoch"
    | "revision"
    | "watchEvents"
  >;
  readonly createChannel: () => OrpcChannel;
}

export interface CutoverSessionFactory {
  readonly createAuthority: () => CutoverSessionPort["authority"];
  readonly createChannel: () => OrpcChannel;
}

export interface CutoverSessionActorOptions {
  readonly queryClient: QueryClient;
  readonly queryKey?: QueryKey;
  readonly streamQueryKey?: QueryKey;
  readonly session: CutoverSessionPort;
}

export interface CutoverSessionActorHandle {
  readonly actor: DomainActor<RpcSessionEvent, RpcSessionContext>;
  readonly transcript: SemanticTranscript;
  readonly dispose: () => Promise<void>;
}

function success(request: EffectInvocation): EffectOutput {
  return { ...request, result: "success" };
}

function errorKind(error: unknown): DomainEffectError["result"] {
  if (error instanceof DomainEffectError) return error.result;
  if (error instanceof OrpcSessionError) {
    switch (error.kind) {
      case "cancelled":
        return "cancelled";
      case "deadline-exceeded":
        return "timeout";
      case "disconnected":
      case "not-connected":
        return "disconnected";
      case "stale-response":
      case "version-mismatch":
        return "stale";
      default:
        return "failure";
    }
  }
  return "failure";
}

function toDomainError(error: unknown): DomainEffectError {
  return error instanceof DomainEffectError ? error : new DomainEffectError(errorKind(error));
}

function sessionData(session: CutoverSessionPort): CutoverSessionQueryData {
  return {
    generation: session.authority.sessionGeneration,
    parentEpoch: session.authority.parentEpoch,
    revision: session.authority.revision,
  };
}

/**
 * Projects only the session-correlated Event Iterator signal. A generation,
 * parent epoch, revision, or sequence that is older/equal than the cache is
 * ignored; the legacy EventsSnapshotDto never enters this cache.
 */
export function reduceSessionEvent(
  previous: CutoverSessionStreamData | undefined,
  event: OrpcEventValue,
): CutoverSessionStreamData {
  if (!previous || event.sessionGeneration > previous.generation) {
    return {
      chunks: [event],
      generation: event.sessionGeneration,
      lastSequence: event.sequence,
      lastValue: event.value,
      parentEpoch: event.parentEpoch,
      revision: event.revision,
    };
  }
  if (
    event.sessionGeneration < previous.generation ||
    event.parentEpoch !== previous.parentEpoch ||
    event.revision !== previous.revision ||
    event.sequence <= previous.lastSequence
  ) {
    return previous;
  }
  return {
    ...previous,
    chunks: [...previous.chunks, event].slice(-MAX_STREAM_CHUNKS),
    lastSequence: event.sequence,
    lastValue: event.value,
  };
}

/**
 * Bridges exactly one domain RPC actor to the official oRPC session authority.
 * The actor owns connect/auth/baseline/reconnect/dispose workflow; the session
 * authority owns protocol correlation, negotiated bounds, and Event Iterator
 * validation. The adapter contains no UI or remote snapshot state.
 */
export function createCutoverSessionActor(
  options: CutoverSessionActorOptions,
): CutoverSessionActorHandle {
  const transcript = new SemanticTranscript();
  let actor: DomainActor<RpcSessionEvent, RpcSessionContext>;
  let stream: EventIteratorRun | undefined;
  let streamController: AbortController | undefined;
  let stopped = false;
  let disposePromise: Promise<void> | undefined;
  let cleanupFailure: unknown;
  const sessionQueryKey = options.queryKey ?? CUTOVER_SESSION_QUERY_KEY;
  const streamQueryKey = options.streamQueryKey ?? CUTOVER_SESSION_STREAM_QUERY_KEY;

  const clearSessionQueries = (): void => {
    options.queryClient.removeQueries({ exact: true, queryKey: sessionQueryKey });
    options.queryClient.removeQueries({ exact: true, queryKey: streamQueryKey });
  };

  // A new actor lifetime never inherits the previous authority's remote
  // metadata or stream chunks. The next baseline is the only writer allowed
  // to repopulate these keys.
  clearSessionQueries();

  const stopStream = async (): Promise<void> => {
    streamController?.abort();
    streamController = undefined;
    const current = stream;
    stream = undefined;
    if (!current) return;
    await current.stop();
  };

  const startStream = async (): Promise<void> => {
    await stopStream();
    const controller = new AbortController();
    streamController = controller;
    const iterator = await options.session.authority.watchEvents({ signal: controller.signal });
    const current = consumeEventIterator(
      iterator,
      createQueryEventSink<OrpcEventValue, CutoverSessionStreamData>(
        options.queryClient,
        streamQueryKey,
        reduceSessionEvent,
      ),
      { signal: controller.signal },
    );
    stream = current;
    const reconnectOnStreamEnd = (): void => {
      if (!stopped && !controller.signal.aborted) actor.send({ type: "RECONNECT" });
    };
    void current.done.then(reconnectOnStreamEnd, reconnectOnStreamEnd);
  };

  const effects: DomainEffects = {
    async invoke(request, signal) {
      try {
        switch (request.effect) {
          case "rpc.connect":
            await options.session.authority.connect(options.session.createChannel(), { signal });
            return success(request);
          case "rpc.authenticate":
            if (signal.aborted) throw new DomainEffectError("cancelled");
            // oRPC performs the authenticated handshake as part of connect().
            return success(request);
          case "rpc.baseline":
            if (signal.aborted) throw new DomainEffectError("cancelled");
            options.queryClient.removeQueries({ exact: true, queryKey: streamQueryKey });
            await startStream();
            options.queryClient.setQueryData(sessionQueryKey, sessionData(options.session));
            return success(request);
          case "rpc.disconnect":
            try {
              clearSessionQueries();
              // Retire the protocol authority before waiting on iterator cleanup.
              // This makes a StrictMode/remount cleanup a synchronous ownership
              // boundary: a subsequent setup cannot overlap a live session.
              options.session.authority.disconnect();
              await stopStream();
            } finally {
              options.session.authority.disconnect();
            }
            return success(request);
          case "rpc.dispose":
            try {
              clearSessionQueries();
              // See rpc.disconnect: authority retirement is synchronous, while
              // iterator cleanup remains awaitable and observable to the caller.
              options.session.authority.dispose();
              await stopStream();
            } finally {
              options.session.authority.dispose();
            }
            return success(request);
          default:
            throw new DomainEffectError("failure");
        }
      } catch (error) {
        if (request.effect === "rpc.dispose" || request.effect === "rpc.disconnect") {
          cleanupFailure = error;
        }
        throw toDomainError(error);
      }
    },
  };

  actor = createDomainActor("rpcSession", {
    authority: 1,
    effects,
    transcript,
  });

  const dispose = async (): Promise<void> => {
    if (disposePromise) return disposePromise;
    disposePromise = (async () => {
      stopped = true;
      clearSessionQueries();
      // React effect cleanup is not awaited. Retire this authority before the
      // first await so StrictMode setup→cleanup→setup cannot overlap sessions.
      options.session.authority.dispose();
      const initial = actor.getSnapshot();
      if (initial.status === "stopped") {
        try {
          await stopStream();
        } catch (error) {
          cleanupFailure = error;
          throw error;
        }
        return;
      }
      if (initial.status === "done" && initial.value === "disposed") {
        try {
          await stopStream();
        } catch (error) {
          cleanupFailure = error;
          throw error;
        }
        return;
      }
      if (initial.status === "error" || initial.value === "disposeRecoveryRequired") {
        try {
          await stopStream();
        } catch (error) {
          cleanupFailure = error;
        }
        throw cleanupFailure ?? new DomainEffectError("recovery-required");
      }
      let settled = false;
      let subscription: { unsubscribe(): void } | undefined;
      let resolveTerminal!: () => void;
      let rejectTerminal!: (error: unknown) => void;
      const terminal = new Promise<void>((resolve, reject) => {
        resolveTerminal = resolve;
        rejectTerminal = reject;
      });
      const finish = (error?: unknown): void => {
        if (settled) return;
        settled = true;
        subscription?.unsubscribe();
        if (error) rejectTerminal(error);
        else resolveTerminal();
      };
      subscription = actor.subscribe((snapshot) => {
        if (snapshot.status === "done" && snapshot.value === "disposed") {
          finish();
        } else if (snapshot.value === "disposeRecoveryRequired" || snapshot.status === "error") {
          finish(cleanupFailure ?? new DomainEffectError("recovery-required"));
        }
      });
      try {
        actor.send({ type: "DISPOSE" });
        const snapshot = actor.getSnapshot();
        if (snapshot.status === "done" && snapshot.value === "disposed") finish();
        await terminal;
      } catch (error) {
        finish(error);
        await terminal.catch(() => undefined);
        throw error;
      } finally {
        actor.stop();
        options.session.authority.dispose();
      }
    })();
    return disposePromise;
  };

  return { actor, dispose, transcript };
}
