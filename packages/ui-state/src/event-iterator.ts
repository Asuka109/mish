import type { QueryClient, QueryKey } from "@tanstack/query-core";

export interface EventActor {
  readonly send: (event: unknown) => void;
}

export interface QueryEventSink<TEvent, _TData = unknown> {
  readonly kind: "query";
  readonly write: (event: TEvent) => void;
}

export interface ActorEventSink<TEvent> {
  readonly kind: "xstate";
  readonly write: (event: TEvent) => void;
}

export type EventSink<TEvent> = QueryEventSink<TEvent> | ActorEventSink<TEvent>;

/**
 * A portable abort shape keeps the iterator utility independent of DOM
 * globals. `AbortSignal` satisfies this contract, as do Hermes/native test
 * adapters that provide the same event methods.
 */
export interface AbortLike {
  readonly aborted: boolean;
  readonly addEventListener?: (
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ) => void;
  readonly removeEventListener?: (type: "abort", listener: () => void) => void;
}

export interface EventIteratorRun {
  readonly done: Promise<void>;
  readonly stop: () => Promise<void>;
}

export function createQueryEventSink<TEvent, TData>(
  client: QueryClient,
  queryKey: QueryKey,
  reduce: (previous: TData | undefined, event: TEvent) => TData,
): QueryEventSink<TEvent, TData> {
  return {
    kind: "query",
    write(event) {
      client.setQueryData<TData>(queryKey, (previous) => reduce(previous, event));
    },
  };
}

export function createActorEventSink<TEvent>(
  actor: EventActor,
  toActorEvent: (event: TEvent) => unknown,
): ActorEventSink<TEvent> {
  return {
    kind: "xstate",
    write(event) {
      actor.send(toActorEvent(event));
    },
  };
}

function assertSink<TEvent>(sink: EventSink<TEvent>): void {
  if (
    !sink ||
    (sink.kind !== "query" && sink.kind !== "xstate") ||
    typeof sink.write !== "function"
  ) {
    throw new TypeError("Event iterators require a Query cache or XState actor sink");
  }
}

/**
 * Drain one Event Iterator into either the Query cache or an XState actor.
 * There is deliberately no Store/UI sink: remote events must not be copied
 * into a second state authority. Cleanup is idempotent and runs on normal
 * completion, explicit stop, abort, and iterator failure.
 */
export function consumeEventIterator<TEvent>(
  iterator: AsyncIterable<TEvent>,
  sink: EventSink<TEvent>,
  options: { readonly signal?: AbortLike } = {},
): EventIteratorRun {
  assertSink(sink);
  const asyncIterator = iterator[Symbol.asyncIterator]();
  let closed = false;
  let closePromise: Promise<void> | undefined;

  const onAbort = (): void => {
    void close();
  };

  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      options.signal?.removeEventListener?.("abort", onAbort);
      try {
        await asyncIterator.return?.();
      } catch {
        // The owner has already cancelled the source. The consuming promise
        // remains deterministic even when a remote close acknowledgement is
        // unavailable.
      }
    })();
    return closePromise;
  };

  if (options.signal?.aborted) {
    void close();
  } else {
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
  }

  const drain = async (): Promise<void> => {
    if (closed) return;
    const result = await asyncIterator.next();
    if (closed || result.done) return;
    sink.write(result.value);
    return drain();
  };

  const done = (async (): Promise<void> => {
    try {
      await drain();
    } finally {
      await close();
    }
  })();

  return { done, stop: close };
}
