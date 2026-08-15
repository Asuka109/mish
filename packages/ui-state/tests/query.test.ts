import { describe, expect, it } from "vitest";

import {
  consumeEventIterator,
  createActorEventSink,
  createOrpcMutation,
  createOrpcQueryOptions,
  createOrpcStreamedOptions,
  createQueryClient,
  createQueryEventSink,
  fetchOrpcQuery,
} from "../src/index.ts";
import { createStatusFixture, createStreamFixture } from "./orpc-fixture.ts";

describe("official oRPC/TanStack Query adapter", () => {
  it("rejects unbounded retry overrides instead of admitting a predicate or true", () => {
    expect(() => createQueryClient({ queryRetry: 4 as never })).toThrow(/queryRetry/);
    expect(() => createQueryClient({ mutationRetry: -1 as never })).toThrow(/mutationRetry/);
    expect(() => createQueryClient({ queryRetry: Number.POSITIVE_INFINITY as never })).toThrow(
      /queryRetry/,
    );
    expect(() => createQueryClient({ queryRetry: true as never })).toThrow(/queryRetry/);
    expect(() => createQueryClient({ mutationRetry: false as never })).toThrow(/mutationRetry/);
  });

  it("caches fresh query results and invalidates the exact remote key", async () => {
    const client = createQueryClient();
    let calls = 0;
    const fixture = createStatusFixture(async (input) => {
      calls += 1;
      return { id: input.id, revision: calls };
    });
    const input = { id: "profile-a" };
    const queryKey = fixture.utils.queryKey({ input });
    const options = { input, staleTime: 60_000, retry: 0 as const };

    const generated = createOrpcQueryOptions(fixture.utils, options);
    expect(generated.queryKey).toEqual(queryKey);
    await fetchOrpcQuery(client, fixture.utils, options);
    await fetchOrpcQuery(client, fixture.utils, options);
    expect(calls).toBe(1);
    expect(client.getQueryData(queryKey)).toEqual({ id: "profile-a", revision: 1 });
    expect(client.getQueryState(queryKey)?.isInvalidated).toBe(false);

    await client.invalidateQueries({ queryKey, exact: true, refetchType: "none" });
    expect(client.getQueryState(queryKey)?.isInvalidated).toBe(true);
    await fetchOrpcQuery(client, fixture.utils, options);
    expect(calls).toBe(2);
    expect(client.getQueryData(queryKey)).toEqual({ id: "profile-a", revision: 2 });
    client.clear();
  });

  it("retries a transient remote query only within its explicit bound", async () => {
    const client = createQueryClient();
    let calls = 0;
    const fixture = createStatusFixture(async (input) => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return { id: input.id, revision: calls };
    });

    await expect(
      fetchOrpcQuery(client, fixture.utils, {
        input: { id: "runtime" },
        staleTime: 0,
        retry: 1 as const,
        retryDelay: 0,
      }),
    ).resolves.toEqual({ id: "runtime", revision: 2 });
    expect(calls).toBe(2);
    client.clear();
  });

  it("uses official mutationOptions and invalidates Query cache after success", async () => {
    const client = createQueryClient();
    const fixture = createStatusFixture(async (input) => ({ id: input.id, revision: 2 }));
    const queryKey = fixture.utils.queryKey({ input: { id: "settings" } });
    client.setQueryData(queryKey, { id: "settings", revision: 1 });
    const mutation = createOrpcMutation(client, fixture.utils, {
      retry: 0 as const,
      invalidateKeys: [queryKey],
    });

    await expect(mutation.execute({ id: "settings" })).resolves.toEqual({
      id: "settings",
      revision: 2,
    });
    expect(client.getQueryState(queryKey)?.isInvalidated).toBe(true);
    expect(mutation.getState().status).toBe("success");
    client.clear();
  });

  it("uses official streamedOptions to put Event Iterator chunks in Query cache", async () => {
    const client = createQueryClient();
    const fixture = createStreamFixture(async function* () {
      yield { id: 1 };
      yield { id: 2 };
    });
    const options = createOrpcStreamedOptions(fixture.utils, {
      input: { id: "events" },
      queryFnOptions: { refetchMode: "append", maxChunks: 4 },
    });

    await expect(client.fetchQuery(options)).resolves.toEqual([{ id: 1 }, { id: 2 }]);
    expect(client.getQueryData(options.queryKey)).toEqual([{ id: 1 }, { id: 2 }]);
    client.clear();
  });

  it("rejects an unbounded streamed-query retry override", () => {
    const fixture = createStreamFixture(async function* () {
      yield { id: 1 };
    });

    expect(() =>
      createOrpcStreamedOptions(fixture.utils, {
        input: { id: "events" },
        retry: true as never,
      }),
    ).toThrow(/streamed query retry/);
  });
});

describe("Event Iterator routing", () => {
  it("writes iterator events to Query cache and closes the iterator", async () => {
    const client = createQueryClient();
    let returnCount = 0;
    const iterator: AsyncIterable<{ readonly id: number }> = {
      [Symbol.asyncIterator]() {
        let id = 0;
        return {
          async next() {
            if (id === 2) return { done: true, value: undefined };
            id += 1;
            return { done: false, value: { id } };
          },
          async return() {
            returnCount += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const sink = createQueryEventSink<{ readonly id: number }, readonly { readonly id: number }[]>(
      client,
      ["events"],
      (previous, event) => [...(previous ?? []), event],
    );

    const run = consumeEventIterator(iterator, sink);
    await run.done;
    expect(client.getQueryData(["events"])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(returnCount).toBe(1);
    client.clear();
  });

  it("routes iterator events to an XState actor and stops idempotently", async () => {
    const received: unknown[] = [];
    let firstEventObserved!: () => void;
    const firstEvent = new Promise<void>((resolve) => {
      firstEventObserved = resolve;
    });
    const actor = {
      send: (event: unknown) => {
        received.push(event);
        firstEventObserved();
      },
    };
    let returnCount = 0;
    let nextCalls = 0;
    const iterator: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          async next() {
            nextCalls += 1;
            await Promise.resolve();
            return { done: false, value: nextCalls };
          },
          async return() {
            returnCount += 1;
            return { done: true, value: undefined };
          },
        };
      },
    };
    const run = consumeEventIterator(
      iterator,
      createActorEventSink(actor, (value) => ({ type: "event.received", value })),
    );
    await firstEvent;
    await Promise.all([run.stop(), run.stop()]);
    await run.done;

    expect(received).toEqual([{ type: "event.received", value: 1 }]);
    expect(returnCount).toBe(1);
  });

  it("closes and detaches an iterator when a portable abort signal fires", async () => {
    let abortListener: (() => void) | undefined;
    let removed = false;
    let returnCount = 0;
    let resolveNext!: (result: IteratorResult<number>) => void;
    const iterator: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: () =>
            new Promise<IteratorResult<number>>((resolve) => {
              resolveNext = resolve;
            }),
          async return() {
            returnCount += 1;
            resolveNext({ done: true, value: undefined });
            return { done: true, value: undefined };
          },
        };
      },
    };
    const signal = {
      aborted: false,
      addEventListener: (_type: "abort", listener: () => void) => {
        abortListener = listener;
      },
      removeEventListener: (_type: "abort", listener: () => void) => {
        if (abortListener === listener) removed = true;
      },
    };
    const run = consumeEventIterator(
      iterator,
      createActorEventSink({ send: () => undefined }, (value) => value),
      { signal },
    );

    abortListener?.();
    await run.done;
    expect(returnCount).toBe(1);
    expect(removed).toBe(true);
  });

  it("rejects a Store-like or remote snapshot sink", () => {
    const iterator: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return { next: async () => ({ done: true, value: undefined }) };
      },
    };

    expect(() =>
      consumeEventIterator(iterator, { kind: "ui", write: () => undefined } as never),
    ).toThrow(/Query cache or XState actor sink/);
    expect(() =>
      consumeEventIterator(iterator, { kind: "remote-snapshot", write: () => undefined } as never),
    ).toThrow(/Query cache or XState actor sink/);
  });
});
