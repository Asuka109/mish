import type { QueryClient, QueryKey } from "@tanstack/query-core";

export interface EventActor {
  send: (event: unknown) => void;
}

export interface QueryEventSink<TEvent, TData> {
  readonly kind: "query";
  readonly write: (event: TEvent) => void;
}

export interface ActorEventSink<TEvent> {
  readonly kind: "xstate";
  readonly write: (event: TEvent) => void;
}

export type EventSink<TEvent> = QueryEventSink<TEvent, unknown> | ActorEventSink<TEvent>;

export interface AbortLike {
  readonly aborted: boolean;
  addEventListener?: (
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ) => void;
  removeEventListener?: (type: "abort", listener: () => void) => void;
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
 * Drain one bounded Event Iterator into either the Query cache or an XState
 * actor. There is deliberately no state-store parameter or fallback sink.
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

  const close = async (): Promise<void> => {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      closed = true;
      options.signal?.removeEventListener?.("abort", onAbort);
      await asyncIterator.return?.();
    })();
    return closePromise;
  };

  const onAbort = (): void => {
    void close();
  };
  if (options.signal?.aborted) {
    void close();
  } else {
    options.signal?.addEventListener?.("abort", onAbort, { once: true });
  }

  const done = (async (): Promise<void> => {
    try {
      while (!closed) {
        const result = await asyncIterator.next();
        if (closed || result.done) break;
        sink.write(result.value);
      }
    } finally {
      await close();
    }
  })();

  return { done, stop: close };
}
