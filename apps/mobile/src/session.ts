import { BoundedTranscript, OrpcSessionAuthority, type OrpcChannel } from "@mish/orpc-client";
import type { OrpcEventValue, OrpcHandshakeOutput, OrpcOperation } from "@mish/contracts";
import {
  DomainEffectError,
  DomainTranscript,
  createDomainActor,
  type DomainActor,
  type DomainEffects,
  type DomainActorSnapshot,
  type EffectInvocation,
  type EffectOutput,
  type RpcSessionContext,
  type RpcSessionEvent,
} from "@mish/domain";
import {
  MAX_STREAM_CHUNKS,
  consumeEventIterator,
  createQueryEventSink,
  type QueryClient,
} from "@mish/ui-state";

export const RN_SESSION_QUERY_KEY = ["rn-host", "orpc", "session"] as const;
export const RN_SESSION_STREAM_QUERY_KEY = ["rn-host", "orpc", "session-stream"] as const;

export interface RnSessionQueryData {
  readonly generation: number;
  readonly parentEpoch: number;
  readonly revision: number;
}

export interface RnSessionStreamData {
  readonly chunks: readonly OrpcEventValue[];
  readonly generation: number;
  readonly parentEpoch: number;
  readonly revision: number;
  readonly lastSequence: number;
  readonly lastValue: OrpcEventValue["value"];
}

export type RnTransportFactory = () => Promise<OrpcChannel>;

/** The only host-owned transport inputs admitted to the domain actor. */
export interface RnSessionOptions {
  readonly authToken: string;
  readonly openTransport: RnTransportFactory;
  readonly queryClient: QueryClient;
}

export interface RnSessionAuthority {
  readonly state: string;
  readonly sessionGeneration: number;
  readonly parentEpoch: number;
  readonly revision: number;
  readonly connect: (signal?: AbortSignal) => Promise<OrpcHandshakeOutput>;
  readonly reconnect: (signal?: AbortSignal) => Promise<OrpcHandshakeOutput>;
  readonly invoke: (operation: OrpcOperation, signal?: AbortSignal) => Promise<unknown>;
  readonly watchEvents: (signal?: AbortSignal) => Promise<AsyncIterableIterator<OrpcEventValue>>;
  readonly disconnect: () => void;
  readonly dispose: () => void;
}

class SessionAuthority implements RnSessionAuthority {
  readonly #session: OrpcSessionAuthority;
  readonly #openTransport: RnTransportFactory;

  constructor(options: Pick<RnSessionOptions, "authToken" | "openTransport">) {
    this.#openTransport = options.openTransport;
    this.#session = new OrpcSessionAuthority({
      authToken: options.authToken,
      clientName: "react-native",
      clientVersion: "rn-host-0.87.0",
      maxDeadlineMs: 1_000,
      maxMessageBytes: 16 * 1024,
      transcript: new BoundedTranscript({ maxEvents: 128, sessionId: "orpc-session-0001" }),
    });
  }

  get state(): string {
    return this.#session.state;
  }

  get sessionGeneration(): number {
    return this.#session.sessionGeneration;
  }

  get parentEpoch(): number {
    return this.#session.parentEpoch;
  }

  get revision(): number {
    return this.#session.revision;
  }

  async connect(signal?: AbortSignal): Promise<OrpcHandshakeOutput> {
    return this.#session.connect(await this.#openTransport(), { deadlineMs: 500, signal });
  }

  async reconnect(signal?: AbortSignal): Promise<OrpcHandshakeOutput> {
    return this.#session.reconnect(await this.#openTransport(), { deadlineMs: 500, signal });
  }

  invoke(operation: OrpcOperation, signal?: AbortSignal): Promise<unknown> {
    return this.#session.invoke(operation, { deadlineMs: 250, signal });
  }

  watchEvents(signal?: AbortSignal): Promise<AsyncIterableIterator<OrpcEventValue>> {
    return this.#session.watchEvents({ deadlineMs: 500, signal });
  }

  disconnect(): void {
    this.#session.disconnect();
  }

  dispose(): void {
    this.#session.dispose();
  }
}

function success(request: EffectInvocation): EffectOutput {
  return { ...request, result: "success" };
}

function toDomainError(error: unknown): DomainEffectError {
  if (error instanceof DomainEffectError) return error;
  return new DomainEffectError(
    error instanceof Error && error.message.includes("cancel") ? "cancelled" : "failure",
  );
}

function sessionData(authority: RnSessionAuthority): RnSessionQueryData {
  return {
    generation: authority.sessionGeneration,
    parentEpoch: authority.parentEpoch,
    revision: authority.revision,
  };
}

export function reduceRnSessionEvent(
  previous: RnSessionStreamData | undefined,
  event: OrpcEventValue,
): RnSessionStreamData {
  if (!previous || event.sessionGeneration > previous.generation) {
    return {
      chunks: [event],
      generation: event.sessionGeneration,
      parentEpoch: event.parentEpoch,
      revision: event.revision,
      lastSequence: event.sequence,
      lastValue: event.value,
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

export interface RnSessionActorHandle {
  readonly actor: DomainActor<RpcSessionEvent, RpcSessionContext>;
  readonly authority: RnSessionAuthority;
  readonly transcript: DomainTranscript;
  readonly dispose: () => Promise<void>;
}

/**
 * Compose the real oRPC session authority, XState RPC actor, Query cache, and
 * Event Iterator cleanup. The host adapter supplies transport only; it cannot
 * own lifecycle, remote cache, or presentation state.
 */
export function createRnSessionActor(options: RnSessionOptions): RnSessionActorHandle {
  const transcript = new DomainTranscript();
  const authority = new SessionAuthority(options);
  let actor: DomainActor<RpcSessionEvent, RpcSessionContext>;
  let stream: ReturnType<typeof consumeEventIterator> | undefined;
  let streamController: AbortController | undefined;
  let disposed = false;
  let disposePromise: Promise<void> | undefined;

  const clearQueries = (): void => {
    options.queryClient.removeQueries({ exact: true, queryKey: RN_SESSION_QUERY_KEY });
    options.queryClient.removeQueries({ exact: true, queryKey: RN_SESSION_STREAM_QUERY_KEY });
  };

  const stopStream = async (): Promise<void> => {
    streamController?.abort();
    streamController = undefined;
    const current = stream;
    stream = undefined;
    if (current) await current.stop();
  };

  const startStream = async (): Promise<void> => {
    await stopStream();
    const controller = new AbortController();
    streamController = controller;
    const iterator = await authority.watchEvents(controller.signal);
    const current = consumeEventIterator(
      iterator,
      createQueryEventSink<OrpcEventValue, RnSessionStreamData>(
        options.queryClient,
        RN_SESSION_STREAM_QUERY_KEY,
        reduceRnSessionEvent,
      ),
      { signal: controller.signal },
    );
    stream = current;
    void current.done.then(
      () => {
        if (!disposed && !controller.signal.aborted) actor.send({ type: "RECONNECT" });
        return undefined;
      },
      () => {
        if (!disposed && !controller.signal.aborted) actor.send({ type: "RECONNECT" });
        return undefined;
      },
    );
  };

  const effects: DomainEffects = {
    async invoke(request, signal) {
      try {
        switch (request.effect) {
          case "rpc.connect":
            if (signal.aborted) throw new DomainEffectError("cancelled");
            if (authority.state === "disconnected") await authority.connect(signal);
            else await authority.reconnect(signal);
            return success(request);
          case "rpc.authenticate":
            if (signal.aborted) throw new DomainEffectError("cancelled");
            return success(request);
          case "rpc.baseline":
            if (signal.aborted) throw new DomainEffectError("cancelled");
            clearQueries();
            await startStream();
            options.queryClient.setQueryData(RN_SESSION_QUERY_KEY, sessionData(authority));
            return success(request);
          case "rpc.disconnect":
            clearQueries();
            await stopStream();
            authority.disconnect();
            return success(request);
          case "rpc.dispose":
            clearQueries();
            await stopStream();
            authority.dispose();
            return success(request);
          default:
            throw new DomainEffectError("failure");
        }
      } catch (error) {
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
    disposed = true;
    disposePromise = (async () => {
      if (actor.getSnapshot().status !== "done") {
        actor.send({ type: "DISPOSE" });
        await Promise.resolve();
      }
      await stopStream();
      authority.dispose();
      actor.stop();
    })();
    return disposePromise;
  };

  return { actor, authority, transcript, dispose };
}

export function snapshotPhase(
  snapshot: DomainActorSnapshot<RpcSessionContext>,
): "connected" | "connecting" | "disconnected" | "failed" {
  const value =
    typeof snapshot.value === "string" ? snapshot.value : Object.keys(snapshot.value)[0];
  if (value === "connected-current") return "connected";
  if (value === "failed" || value === "recoveryRequired" || snapshot.status === "error") {
    return "failed";
  }
  if (value === "disconnected" || value === "disposed" || snapshot.status === "stopped") {
    return "disconnected";
  }
  return "connecting";
}
