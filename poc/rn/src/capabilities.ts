import { BoundedWebSocketChannel } from "@mish/poc-orpc";
import type { WebSocketLike } from "@mish/poc-orpc";
import {
  consumeEventIterator,
  createQueryEventSink,
  createQueryClient,
} from "@mish/poc-query-store";

import { RnTranscript } from "./transcript.ts";

export interface RuntimeCapabilitySnapshot {
  readonly webSocket: boolean;
  readonly abortController: boolean;
  readonly asyncIterator: boolean;
  readonly structuredClone: boolean;
  readonly readableStream: boolean;
  readonly textEncoder: boolean;
  readonly messagePort: boolean;
}

/**
 * Detect optional host capabilities without depending on browser globals.
 * Hermes and a root-free Android fixture are allowed to omit any of these.
 */
export function detectRuntimeCapabilities(): RuntimeCapabilitySnapshot {
  const globals = globalThis as Record<string, unknown>;
  return {
    webSocket: typeof globals.WebSocket === "function",
    abortController: typeof globals.AbortController === "function",
    asyncIterator: typeof Symbol.asyncIterator === "symbol",
    structuredClone: typeof globals.structuredClone === "function",
    readableStream: typeof globals.ReadableStream === "function",
    textEncoder: typeof globals.TextEncoder === "function",
    messagePort: typeof globals.MessagePort === "function",
  };
}

interface ReplayAbortSignal {
  readonly aborted: boolean;
  addEventListener(
    type: "abort",
    listener: () => void,
    options?: { readonly once?: boolean },
  ): void;
  removeEventListener(type: "abort", listener: () => void): void;
}

interface ReplayAbortController {
  readonly signal: ReplayAbortSignal;
  abort(): void;
}

function createReplayAbortController(): ReplayAbortController {
  let aborted = false;
  const listeners = new Set<() => void>();
  const signal: ReplayAbortSignal = {
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
      for (const listener of [...listeners]) listener();
      listeners.clear();
    },
  };
}

/** A closed in-memory WebSocket seam. It never opens a real socket. */
class ReplaySocket implements WebSocketLike {
  readyState = 0;
  openCount = 0;
  closeCount = 0;
  readonly #listeners = new Map<string, Set<(event: unknown) => void>>();

  open(): void {
    this.readyState = 1;
    this.openCount += 1;
    this.emit("open", {});
  }

  addEventListener(type: string, listener: (event: unknown) => void): void {
    const listeners = this.#listeners.get(type) ?? new Set();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: (event: unknown) => void): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(_data: unknown): void {
    if (this.readyState !== 1) throw new Error("replay socket is not open");
  }

  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.closeCount += 1;
    this.emit("close", {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) listener(event);
  }
}

export interface WebSocketReplayResult {
  readonly cancelled: boolean;
  readonly reconnected: boolean;
}

/**
 * Exercise the oRPC WebSocket boundary with a deterministic socket. The
 * fixture proves channel close/reconnect cleanup, not a real network path.
 */
export function replayWebSocketCancellation(transcript: RnTranscript): WebSocketReplayResult {
  const firstSocket = new ReplaySocket();
  const firstChannel = new BoundedWebSocketChannel(firstSocket, 1024);
  firstChannel.addEventListener("close", () => undefined);
  firstSocket.open();
  transcript.record("websocket.connect", "accepted");
  firstChannel.close();
  transcript.record("websocket.cancel", "cancelled");

  const secondSocket = new ReplaySocket();
  const secondChannel = new BoundedWebSocketChannel(secondSocket, 1024);
  secondSocket.open();
  transcript.record("websocket.reconnect", "reconnected");
  secondChannel.close();

  return {
    cancelled: firstSocket.openCount === 1 && firstSocket.closeCount === 1,
    reconnected: secondSocket.openCount === 1 && secondSocket.closeCount === 1,
  };
}

export interface AsyncIterableReplayResult {
  readonly abortObserved: boolean;
  readonly iteratorReturned: boolean;
  readonly querySinkSelected: boolean;
}

/**
 * Exercise AbortSignal cancellation through the P3 Event Iterator sink. The
 * pending `next()` is settled by `return()`, with no sleep or wall-clock race.
 */
export async function replayAsyncIterableCancellation(
  transcript: RnTranscript,
): Promise<AsyncIterableReplayResult> {
  const controller = createReplayAbortController();
  const client = createQueryClient();
  const queryKey = ["rn-admission", "events"] as const;
  const sink = createQueryEventSink<{ value: "changed" }, { count: number }>(
    client,
    queryKey,
    (previous, _event) => ({ count: (previous?.count ?? 0) + 1 }),
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
  transcript.record("abort.signal", "cancelled");
  await run.done;
  transcript.record("async-iterator.return", "cleaned-up");

  return {
    abortObserved: controller.signal.aborted,
    iteratorReturned: returnCount === 1,
    querySinkSelected: sink.kind === "query",
  };
}
