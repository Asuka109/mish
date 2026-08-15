import { ORPCError } from "@orpc/client";
import { implement } from "@orpc/server";
import { RPCHandler as MessagePortRPCHandler } from "@orpc/server/message-port";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/websocket";

import type {
  EventValue,
  EventIteratorReturn,
  InvokeInput,
  InvokeOutput,
} from "../../src/contract.js";
import { orpcContract } from "../../src/contract.js";
import type { MessagePortLike, WebSocketLike } from "../../src/transport.js";

type Listener = (event: unknown) => void;

export interface FixtureMetrics {
  readonly abortCount: number;
  readonly activeStreams: number;
  readonly cleanupCount: number;
  readonly receivedOperations: readonly string[];
}

export interface EventFixtureValue {
  readonly sequence: number;
  readonly value: "ready" | "changed";
  readonly correlationId?: string;
  readonly sessionGeneration?: number;
}

export interface OrpcFixtureOptions {
  readonly authToken?: string;
  readonly protocolVersion?: number;
  readonly sessionGeneration?: number;
  readonly maxMessageBytes?: number;
  readonly staleInvoke?: "correlation" | "generation";
  readonly eventValues?: readonly EventFixtureValue[];
  readonly eventReturn?: Partial<EventIteratorReturn>;
  readonly holdEventsUntilAbort?: boolean;
  readonly deferInvocations?: boolean;
}

export interface OrpcFixture {
  readonly metrics: FixtureMetrics;
  readonly clientWebSocket: WebSocketLike;
  readonly clientMessagePort: MessagePortLike;
  readonly releaseInvocations: () => void;
  readonly close: () => void;
}

interface MutableMetrics {
  abortCount: number;
  activeStreams: number;
  cleanupCount: number;
  receivedOperations: string[];
}

function deferredUntilAbort(signal: AbortSignal | undefined, onAbort: () => void): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      onAbort();
      resolve();
      return;
    }
    signal?.addEventListener(
      "abort",
      () => {
        onAbort();
        resolve();
      },
      { once: true },
    );
  });
}

class FixtureWebSocket implements WebSocketLike {
  readonly #listeners = new Map<string, Set<Listener>>();
  #peer: FixtureWebSocket | undefined;
  #readyState = 1;

  connect(peer: FixtureWebSocket): void {
    this.#peer = peer;
  }

  get readyState(): number {
    return this.#readyState;
  }

  addEventListener(type: string, listener: Listener): void {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: unknown): void {
    if (this.#readyState !== 1) throw new Error("fixture websocket is closed");
    if (this.#peer) this.#peer.#emit("message", { data });
  }

  close(): void {
    if (this.#readyState === 3) return;
    this.#readyState = 3;
    this.#emit("close", {});
    if (this.#peer) this.#peer.#closeFromPeer();
  }

  #closeFromPeer(): void {
    if (this.#readyState === 3) return;
    this.#readyState = 3;
    this.#emit("close", {});
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

class FixtureMessagePort implements MessagePortLike {
  readonly #listeners = new Map<string, Set<Listener>>();
  #peer: FixtureMessagePort | undefined;
  #closed = false;

  connect(peer: FixtureMessagePort): void {
    this.#peer = peer;
  }

  addEventListener(type: string, listener: Listener): void {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  postMessage(data: unknown): void {
    if (this.#closed) throw new Error("fixture message port is closed");
    if (this.#peer) this.#peer.#emit("message", { data });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#emit("close", {});
    if (this.#peer) this.#peer.#closeFromPeer();
  }

  #closeFromPeer(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#emit("close", {});
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

function eventValues(
  input: Record<string, unknown>,
  options: OrpcFixtureOptions,
): readonly EventValue[] {
  return (
    options.eventValues ?? [
      { sequence: 1, value: "ready" },
      { sequence: 2, value: "changed" },
    ]
  ).map((event) => ({
    correlationId: event.correlationId ?? String(input.correlationId),
    sequence: event.sequence,
    sessionGeneration: event.sessionGeneration ?? Number(input.sessionGeneration),
    value: event.value,
  }));
}

function invokeOutput(input: InvokeInput, options: OrpcFixtureOptions): InvokeOutput {
  return {
    correlationId: options.staleInvoke === "correlation" ? "poc-9999" : input.correlationId,
    operation: input.operation,
    sessionGeneration:
      options.staleInvoke === "generation" ? input.sessionGeneration + 1 : input.sessionGeneration,
    value: "ok",
  };
}

function createServerRouter(
  options: OrpcFixtureOptions,
  mutable: MutableMetrics,
  pendingInvocations: Array<() => void>,
) {
  const expectedAuthToken = options.authToken ?? "fixture-token";
  const protocolVersion = options.protocolVersion ?? 1;
  const sessionGeneration = options.sessionGeneration ?? 1;
  const maxMessageBytes = options.maxMessageBytes ?? 4096;
  const implementation = implement(orpcContract);

  return implementation.router({
    session: {
      handshake: implementation.session.handshake.handler(({ input }: any) => {
        mutable.receivedOperations.push("/session/handshake");
        if (input.authToken !== expectedAuthToken) {
          throw new ORPCError("UNAUTHORIZED", { status: 401, data: null });
        }
        if (input.protocolVersion !== protocolVersion) {
          throw new ORPCError("CONFLICT", { status: 409, data: null });
        }
        return { maxMessageBytes, protocolVersion, sessionGeneration };
      }),
    },
    invoke: implementation.invoke.handler(async ({ input, signal }: any) => {
      mutable.receivedOperations.push("/invoke");
      const invokeInput = input as InvokeInput;
      if (options.deferInvocations) {
        if (signal?.aborted) {
          mutable.abortCount += 1;
          throw new ORPCError("CLIENT_CLOSED_REQUEST", { status: 499, data: null });
        }
        await new Promise<void>((resolve) => {
          pendingInvocations.push(resolve);
          signal?.addEventListener(
            "abort",
            () => {
              mutable.abortCount += 1;
              resolve();
            },
            { once: true },
          );
        });
      }
      if (signal?.aborted) {
        mutable.abortCount += 1;
        throw new ORPCError("CLIENT_CLOSED_REQUEST", { status: 499, data: null });
      }
      return invokeOutput(invokeInput, options);
    }),
    events: {
      watch: implementation.events.watch.handler(async function* ({ input, signal }: any) {
        mutable.receivedOperations.push("/events/watch");
        const eventInput = input as Record<string, unknown>;
        mutable.activeStreams += 1;
        try {
          if (options.holdEventsUntilAbort) {
            await deferredUntilAbort(signal, () => {
              mutable.abortCount += 1;
            });
            return {
              correlationId: String(eventInput.correlationId),
              sessionGeneration: Number(eventInput.sessionGeneration),
              value: "closed" as const,
            };
          }
          for (const event of eventValues(eventInput, options)) {
            if (signal?.aborted) break;
            yield event;
          }
          return {
            correlationId: options.eventReturn?.correlationId ?? String(eventInput.correlationId),
            sessionGeneration:
              options.eventReturn?.sessionGeneration ?? Number(eventInput.sessionGeneration),
            value: "closed" as const,
          };
        } finally {
          mutable.activeStreams -= 1;
          mutable.cleanupCount += 1;
        }
      }),
    },
  });
}

export function createOrpcFixture(options: OrpcFixtureOptions = {}): OrpcFixture {
  const mutable: MutableMetrics = {
    abortCount: 0,
    activeStreams: 0,
    cleanupCount: 0,
    receivedOperations: [],
  };
  const pendingInvocations: Array<() => void> = [];
  const clientWebSocket = new FixtureWebSocket();
  const serverWebSocket = new FixtureWebSocket();
  clientWebSocket.connect(serverWebSocket);
  serverWebSocket.connect(clientWebSocket);
  const clientMessagePort = new FixtureMessagePort();
  const serverMessagePort = new FixtureMessagePort();
  clientMessagePort.connect(serverMessagePort);
  serverMessagePort.connect(clientMessagePort);

  const serverRouter = createServerRouter(options, mutable, pendingInvocations);
  new WebSocketRPCHandler(serverRouter).upgrade(serverWebSocket as never);
  new MessagePortRPCHandler(serverRouter).upgrade(serverMessagePort as never);

  const metrics: FixtureMetrics = {
    get abortCount() {
      return mutable.abortCount;
    },
    get activeStreams() {
      return mutable.activeStreams;
    },
    get cleanupCount() {
      return mutable.cleanupCount;
    },
    get receivedOperations() {
      return [...mutable.receivedOperations];
    },
  };

  return {
    metrics,
    clientWebSocket,
    clientMessagePort,
    releaseInvocations() {
      for (const resolve of pendingInvocations.splice(0)) resolve();
    },
    close() {
      clientWebSocket.close();
      clientMessagePort.close();
    },
  };
}
