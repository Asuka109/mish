import {
  DomainTranscript,
  DomainEffectError,
  createDomainActor,
  type DomainActor,
  type DomainEffects,
  type DomainActorSnapshot,
  type EffectInvocation,
  type EffectOutput,
  type RpcSessionContext,
  type RpcSessionEvent,
} from "@mish/domain";
import type { OrpcEventValue, OrpcHandshakeOutput } from "@mish/contracts";
import {
  MAX_STREAM_CHUNKS,
  consumeEventIterator,
  createQueryEventSink,
  type QueryClient,
} from "@mish/ui-state";
import type { ElectronHostApi } from "./electron-api.js";

export const ELECTRON_SESSION_QUERY_KEY = ["electron", "orpc", "session"] as const;
export const ELECTRON_SESSION_STREAM_QUERY_KEY = ["electron", "orpc", "session-stream"] as const;

export interface ElectronSessionQueryData {
  readonly generation: number;
  readonly parentEpoch: number;
  readonly revision: number;
}

export interface ElectronSessionStreamData {
  readonly chunks: readonly OrpcEventValue[];
  readonly generation: number;
  readonly parentEpoch: number;
  readonly revision: number;
  readonly lastSequence: number;
  readonly lastValue: OrpcEventValue["value"];
}

export interface ElectronSessionAuthority {
  readonly state: string;
  readonly sessionGeneration: number;
  readonly parentEpoch: number;
  readonly revision: number;
  connect(options?: { readonly signal?: AbortSignal }): Promise<OrpcHandshakeOutput>;
  disconnect(): void;
  dispose(): Promise<void>;
  watchEvents(options?: {
    readonly signal?: AbortSignal;
  }): Promise<AsyncIterableIterator<OrpcEventValue>>;
}

export class EventQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<{
    readonly resolve: (result: IteratorResult<T>) => void;
    readonly reject: (error: unknown) => void;
  }> = [];
  readonly #maxItems: number;
  #closed = false;
  #error: unknown;

  constructor(maxItems: number) {
    this.#maxItems = maxItems;
  }

  push(value: T): void {
    if (this.#closed) return;
    const waiter = this.#waiters.shift();
    if (waiter) {
      waiter.resolve({ done: false, value });
      return;
    }
    if (this.#items.length >= this.#maxItems) {
      this.close(new Error("Electron event queue exceeded its bound"));
      return;
    }
    this.#items.push(value);
  }

  close(error?: unknown): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#error = error;
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      if (error) {
        waiter.reject(error);
      } else {
        waiter.resolve({ done: true, value: undefined as never });
      }
    }
  }

  next(): Promise<IteratorResult<T>> {
    const item = this.#items.shift();
    if (item !== undefined) return Promise.resolve({ done: false, value: item });
    if (this.#closed) {
      return this.#error === undefined
        ? Promise.resolve({ done: true, value: undefined as never })
        : Promise.reject(this.#error);
    }
    return new Promise<IteratorResult<T>>((resolve, reject) =>
      this.#waiters.push({ resolve, reject }),
    );
  }
}

class RendererSessionAuthority implements ElectronSessionAuthority {
  readonly #api: ElectronHostApi;
  #state = "disconnected";
  #sessionGeneration = 0;
  #parentEpoch = 0;
  #revision = 0;
  #streamStop: (() => Promise<void>) | undefined;

  constructor(api: ElectronHostApi) {
    this.#api = api;
  }

  get state(): string {
    return this.#state;
  }

  get sessionGeneration(): number {
    return this.#sessionGeneration;
  }

  get parentEpoch(): number {
    return this.#parentEpoch;
  }

  get revision(): number {
    return this.#revision;
  }

  async connect(options: { readonly signal?: AbortSignal } = {}): Promise<OrpcHandshakeOutput> {
    if (options.signal?.aborted) throw new Error("session connect cancelled");
    this.#state = "connecting";
    const output = await this.#api.connect();
    this.#sessionGeneration = output.sessionGeneration;
    this.#parentEpoch = output.parentEpoch;
    this.#revision = output.revision;
    this.#state = "connected-current";
    return output;
  }

  disconnect(): void {
    this.#api.disconnect();
    this.#state = "disconnected";
  }

  async dispose(): Promise<void> {
    await this.#api.dispose();
    this.#state = "disposed";
    this.#streamStop = undefined;
  }

  async watchEvents(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AsyncIterableIterator<OrpcEventValue>> {
    if (this.#state !== "connected-current") throw new Error("session is not connected");
    const queue = new EventQueue<OrpcEventValue>(MAX_STREAM_CHUNKS);
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) return;
      stopped = true;
      options.signal?.removeEventListener("abort", onAbort);
      await this.#api.stopEvents();
      queue.close();
      if (this.#streamStop === stop) this.#streamStop = undefined;
    };
    const onAbort = (): void => {
      void stop();
    };
    this.#streamStop = stop;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    await this.#api.watchEvents(
      (event) => queue.push(event),
      () => queue.close(),
    );
    const iterator: AsyncIterableIterator<OrpcEventValue> = {
      [Symbol.asyncIterator]() {
        return iterator;
      },
      next: () => queue.next(),
      async return() {
        await stop();
        return { done: true, value: undefined as never };
      },
    };
    return iterator;
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

function sessionData(authority: ElectronSessionAuthority): ElectronSessionQueryData {
  return {
    generation: authority.sessionGeneration,
    parentEpoch: authority.parentEpoch,
    revision: authority.revision,
  };
}

export function reduceElectronSessionEvent(
  previous: ElectronSessionStreamData | undefined,
  event: OrpcEventValue,
): ElectronSessionStreamData {
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

export interface ElectronSessionActorHandle {
  readonly actor: DomainActor<RpcSessionEvent, RpcSessionContext>;
  readonly authority: ElectronSessionAuthority;
  readonly transcript: DomainTranscript;
  readonly dispose: () => Promise<void>;
}

export function createElectronSessionActor(options: {
  readonly api: ElectronHostApi;
  readonly queryClient: QueryClient;
}): ElectronSessionActorHandle {
  const transcript = new DomainTranscript();
  const authority = new RendererSessionAuthority(options.api);
  let actor: DomainActor<RpcSessionEvent, RpcSessionContext>;
  let stream: ReturnType<typeof consumeEventIterator> | undefined;
  let streamController: AbortController | undefined;
  let stopped = false;
  let disposePromise: Promise<void> | undefined;

  const clearQueries = (): void => {
    options.queryClient.removeQueries({ exact: true, queryKey: ELECTRON_SESSION_QUERY_KEY });
    options.queryClient.removeQueries({ exact: true, queryKey: ELECTRON_SESSION_STREAM_QUERY_KEY });
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
    const iterator = await authority.watchEvents({ signal: controller.signal });
    const current = consumeEventIterator(
      iterator,
      createQueryEventSink<OrpcEventValue, ElectronSessionStreamData>(
        options.queryClient,
        ELECTRON_SESSION_STREAM_QUERY_KEY,
        reduceElectronSessionEvent,
      ),
      { signal: controller.signal },
    );
    stream = current;
    void current.done.then(
      () => {
        if (!stopped && !controller.signal.aborted) actor.send({ type: "RECONNECT" });
        return undefined;
      },
      () => {
        if (!stopped && !controller.signal.aborted) actor.send({ type: "RECONNECT" });
        return undefined;
      },
    );
  };

  const effects: DomainEffects = {
    async invoke(request, signal) {
      try {
        switch (request.effect) {
          case "rpc.connect":
            await authority.connect({ signal });
            return success(request);
          case "rpc.authenticate":
            if (signal.aborted) throw new DomainEffectError("cancelled");
            return success(request);
          case "rpc.baseline":
            if (signal.aborted) throw new DomainEffectError("cancelled");
            clearQueries();
            await startStream();
            options.queryClient.setQueryData(ELECTRON_SESSION_QUERY_KEY, sessionData(authority));
            return success(request);
          case "rpc.disconnect":
            clearQueries();
            authority.disconnect();
            await stopStream();
            return success(request);
          case "rpc.dispose":
            clearQueries();
            await stopStream();
            await authority.dispose();
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
    disposePromise = (async () => {
      stopped = true;
      clearQueries();
      const snapshot = actor.getSnapshot();
      if (snapshot.status === "stopped" || snapshot.status === "done") {
        await stopStream();
        await authority.dispose();
        return;
      }
      let subscription: { unsubscribe(): void } | undefined;
      let settled = false;
      let resolveTerminal!: () => void;
      const terminal = new Promise<void>((resolve) => {
        resolveTerminal = resolve;
      });
      const finish = (next: DomainActorSnapshot<RpcSessionContext>): void => {
        if (settled) return;
        if (next.status === "done" || next.status === "error") {
          settled = true;
          subscription?.unsubscribe();
          resolveTerminal();
        }
      };
      subscription = actor.subscribe(finish);
      actor.send({ type: "DISPOSE" });
      finish(actor.getSnapshot());
      await terminal;
      actor.stop();
      await authority.dispose();
    })();
    return disposePromise;
  };

  return { actor, authority, transcript, dispose };
}
