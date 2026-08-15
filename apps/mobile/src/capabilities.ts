import { WebSocketTransport, type WebSocketLike } from "@mish/orpc-client";
import {
  DeterministicEffects,
  DomainTranscript,
  createDomainActor,
  type RuntimeEvent,
} from "@mish/domain";
import {
  consumeEventIterator,
  createQueryEventSink,
  createQueryClient,
  type AbortLike,
} from "@mish/ui-state";

import { RnTranscript } from "./transcript.js";

export interface RuntimeCapabilitySnapshot {
  readonly abortController: boolean;
  readonly asyncIterator: boolean;
  readonly readableStream: boolean;
  readonly structuredClone: boolean;
  readonly textEncoder: boolean;
  readonly webSocket: boolean;
}

/** Detect optional Hermes capabilities without naming browser globals. */
export function detectRuntimeCapabilities(): RuntimeCapabilitySnapshot {
  const globals = globalThis as Record<string, unknown>;
  return {
    abortController: typeof globals.AbortController === "function",
    asyncIterator: typeof Symbol.asyncIterator === "symbol",
    readableStream: typeof globals.ReadableStream === "function",
    structuredClone: typeof globals.structuredClone === "function",
    textEncoder: typeof globals.TextEncoder === "function",
    webSocket: typeof globals.WebSocket === "function",
  };
}

class ReplaySocket implements WebSocketLike {
  #state = 0;
  #openCount = 0;
  #closeCount = 0;
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

  get readyState(): number {
    return this.#state;
  }

  get openCount(): number {
    return this.#openCount;
  }

  get closeCount(): number {
    return this.#closeCount;
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(_data: string): void {
    if (this.#state !== 1) throw new Error("replay transport is closed");
  }

  open(): void {
    this.#state = 1;
    this.#openCount += 1;
    this.#emit("open", {});
  }

  close(): void {
    if (this.#state === 3) return;
    this.#state = 3;
    this.#closeCount += 1;
    this.#emit("close", {});
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

export interface OrpcTransportReplay {
  readonly cancelled: boolean;
  readonly reconnected: boolean;
}

/**
 * Exercise the shared oRPC transport seam without opening a socket. The
 * transport is real; the channel is a closed in-memory host fixture.
 */
export function replayOrpcTransport(transcript: RnTranscript): OrpcTransportReplay {
  const firstSocket = new ReplaySocket();
  const firstTransport = new WebSocketTransport(firstSocket, 1_024);
  firstSocket.open();
  transcript.record("orpc.connect", "invocation", "accepted");
  firstTransport.close();
  transcript.record("orpc.cancel", "cancellation", "cancelled");

  const secondSocket = new ReplaySocket();
  const secondTransport = new WebSocketTransport(secondSocket, 1_024);
  secondSocket.open();
  transcript.record("orpc.connect", "result", "reconnected", { connectionEpoch: 2 });
  secondTransport.close();
  transcript.record("orpc.cleanup", "cleanup", "cleaned-up", { connectionEpoch: 2 });

  return {
    cancelled: firstSocket.openCount === 1 && firstSocket.closeCount === 1,
    reconnected: secondSocket.openCount === 1 && secondSocket.closeCount === 1,
  };
}

interface ReplayAbortController {
  readonly signal: AbortLike;
  abort(): void;
}

function createReplayAbortController(): ReplayAbortController {
  let aborted = false;
  const listeners = new Set<() => void>();
  const signal: AbortLike = {
    get aborted() {
      return aborted;
    },
    addEventListener(_type, listener) {
      if (!aborted) listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
  return {
    signal,
    abort() {
      if (aborted) return;
      aborted = true;
      for (const listener of listeners) listener();
      listeners.clear();
    },
  };
}

export interface AsyncIterableReplay {
  readonly abortObserved: boolean;
  readonly iteratorReturned: boolean;
  readonly querySinkSelected: boolean;
}

/** Abort a pending iterator through the Query sink and observe return cleanup. */
export async function replayAsyncIterableCancellation(
  transcript: RnTranscript,
): Promise<AsyncIterableReplay> {
  const controller = createReplayAbortController();
  const queryClient = createQueryClient({ queryRetry: 0, mutationRetry: 0 });
  const queryKey = ["rn-host", "events"] as const;
  const sink = createQueryEventSink<{ value: "changed" }, { count: number }>(
    queryClient,
    queryKey,
    (previous) => ({ count: (previous?.count ?? 0) + 1 }),
  );
  let resolvePending: ((result: IteratorResult<{ value: "changed" }>) => void) | undefined;
  let returnCount = 0;
  const iterator: AsyncIterableIterator<{ value: "changed" }> = {
    [Symbol.asyncIterator]() {
      return this;
    },
    next() {
      return new Promise((resolve) => {
        resolvePending = resolve;
      });
    },
    return() {
      returnCount += 1;
      resolvePending?.({ done: true, value: undefined });
      resolvePending = undefined;
      return Promise.resolve({ done: true, value: undefined });
    },
  };

  const run = consumeEventIterator(iterator, sink, { signal: controller.signal });
  controller.abort();
  transcript.record("orpc.cancel", "cancellation", "cancelled");
  await run.done;
  transcript.record("orpc.cleanup", "cleanup", "cleaned-up");

  return {
    abortObserved: controller.signal.aborted,
    iteratorReturned: returnCount === 1,
    querySinkSelected: sink.kind === "query",
  };
}

/** Start a real shared XState v5 actor and replay its bounded effect seam. */
export async function replayDomainActor(transcript: RnTranscript): Promise<boolean> {
  const domainTranscript = new DomainTranscript();
  const effects = new DeterministicEffects(domainTranscript);
  const actor = createDomainActor("runtime", {
    authority: 1,
    effects,
    transcript: domainTranscript,
  });
  actor.start();
  actor.send({ type: "START" } satisfies RuntimeEvent);
  const start = effects.pending("runtime.start")[0];
  if (!start) return false;
  effects.complete(start.effectId);
  await Promise.resolve();
  await Promise.resolve();
  const running = actor.getSnapshot().value === "running";

  actor.send({ type: "STOP" } satisfies RuntimeEvent);
  const stop = effects.pending("runtime.stop")[0];
  if (!stop) return false;
  effects.complete(stop.effectId);
  await Promise.resolve();
  await Promise.resolve();
  const stopped = actor.getSnapshot().value === "stopped";

  actor.send({ type: "DISPOSE" } satisfies RuntimeEvent);
  const dispose = effects.pending("runtime.dispose")[0];
  if (!dispose) return false;
  effects.complete(dispose.effectId);
  await Promise.resolve();
  await Promise.resolve();
  const disposed = actor.getSnapshot().status === "done";
  actor.stop();
  transcript.record(
    "actor.transition",
    "transition",
    running && stopped && disposed ? "success" : "rejected",
  );
  return running && stopped && disposed;
}
