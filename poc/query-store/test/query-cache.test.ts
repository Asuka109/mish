import { describe, expect, it } from "vitest";

import {
  consumeEventIterator,
  createActorEventSink,
  createOrpcMutation,
  createQueryClient,
  createQueryEventSink,
  fetchOrpcQuery,
} from "../src/index.ts";

describe("oRPC Query/Mutation admission", () => {
  it("caches fresh query results and refetches after invalidation", async () => {
    const client = createQueryClient();
    let calls = 0;
    const procedure = async (input: { readonly id: string }) => {
      calls += 1;
      return { id: input.id, revision: calls };
    };
    const options = {
      queryKey: ["profile", "profile-a"] as const,
      staleTime: 60_000,
      retry: false,
    };

    await fetchOrpcQuery(client, procedure, { id: "profile-a" }, options);
    await fetchOrpcQuery(client, procedure, { id: "profile-a" }, options);
    expect(calls).toBe(1);
    expect(client.getQueryData(options.queryKey)).toEqual({
      id: "profile-a",
      revision: 1,
    });
    expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(false);

    await client.invalidateQueries({
      queryKey: options.queryKey,
      exact: true,
      refetchType: "none",
    });
    expect(client.getQueryState(options.queryKey)?.isInvalidated).toBe(true);

    await fetchOrpcQuery(client, procedure, { id: "profile-a" }, options);
    expect(calls).toBe(2);
    expect(client.getQueryData(options.queryKey)).toEqual({
      id: "profile-a",
      revision: 2,
    });
    client.clear();
  });

  it("retries a failed oRPC query according to the bounded policy", async () => {
    const client = createQueryClient();
    let calls = 0;
    const procedure = async (): Promise<string> => {
      calls += 1;
      if (calls === 1) throw new Error("transient");
      return "ready";
    };

    await expect(
      fetchOrpcQuery(client, procedure, undefined, {
        queryKey: ["runtime"],
        staleTime: 0,
        retry: 1,
        retryDelay: 0,
      }),
    ).resolves.toBe("ready");
    expect(calls).toBe(2);
    client.clear();
  });

  it("invalidates Query cache after an oRPC mutation", async () => {
    const client = createQueryClient();
    const queryKey = ["settings"] as const;
    client.setQueryData(queryKey, { revision: 1 });
    const mutation = createOrpcMutation(
      client,
      async (input: { readonly revision: number }) => input,
      { invalidateKeys: [queryKey] },
    );

    await expect(mutation.execute({ revision: 2 })).resolves.toEqual({ revision: 2 });
    expect(client.getQueryState(queryKey)?.isInvalidated).toBe(true);
    expect(mutation.getState().status).toBe("success");
    client.clear();
  });

  it("retries a transient oRPC mutation failure within its bound", async () => {
    const client = createQueryClient();
    let attempts = 0;
    const mutation = createOrpcMutation(
      client,
      async (input: { readonly value: string }) => {
        attempts += 1;
        if (attempts === 1) throw new Error("transient mutation");
        return input.value;
      },
      { retry: 1, retryDelay: 0 },
    );

    await expect(mutation.execute({ value: "committed" })).resolves.toBe("committed");
    expect(attempts).toBe(2);
    client.clear();
  });
});

describe("Event Iterator routing", () => {
  it("writes iterator events to Query cache and closes the iterator", async () => {
    const client = createQueryClient();
    const returned: string[] = [];
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
            returned.push("closed");
            return { done: true, value: undefined };
          },
        };
      },
    };
    const sink = createQueryEventSink<{ readonly id: number }, readonly { readonly id: number }[]>(
      client,
      ["events"],
      (
        previous: readonly { readonly id: number }[] | undefined,
        event: { readonly id: number },
      ) => [...(previous ?? []), event],
    );

    const run = consumeEventIterator(iterator, sink);
    await run.done;
    expect(client.getQueryData(["events"])).toEqual([{ id: 1 }, { id: 2 }]);
    expect(returned).toEqual(["closed"]);
    client.clear();
  });

  it("routes iterator events to an actor and can stop before the next event", async () => {
    const received: unknown[] = [];
    let firstEvent!: () => void;
    const firstEventObserved = new Promise<void>((resolve) => {
      firstEvent = resolve;
    });
    const actor = {
      send: (event: unknown) => {
        received.push(event);
        firstEvent();
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
    await firstEventObserved;
    await run.stop();
    await run.done;

    expect(received).toEqual([{ type: "event.received", value: 1 }]);
    expect(returnCount).toBe(1);
  });

  it("closes and detaches an iterator when the portable abort signal fires", async () => {
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

  it("rejects an unadmitted store-like sink before consuming events", () => {
    const iterator: AsyncIterable<number> = {
      [Symbol.asyncIterator]() {
        return {
          next: async () => ({ done: true, value: undefined }),
        };
      },
    };

    expect(() =>
      consumeEventIterator(iterator, {
        kind: "ui",
        write: () => undefined,
      } as never),
    ).toThrow(/Query cache or XState actor sink/);

    expect(() =>
      consumeEventIterator(iterator, {
        kind: "remote-snapshot",
        write: () => undefined,
      } as never),
    ).toThrow(/Query cache or XState actor sink/);
  });
});
