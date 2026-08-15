import { ORPCError } from "@orpc/client";
import { implement } from "@orpc/server";
import { RPCHandler as MessagePortRPCHandler } from "@orpc/server/message-port";
import { RPCHandler as WebSocketRPCHandler } from "@orpc/server/websocket";
import type {
  OrpcClientName,
  OrpcEventReturn,
  OrpcEventValue,
  OrpcHandshakeOutput,
  OrpcInvokeInput,
  OrpcInvokeOutput,
} from "@mish/contracts";
import { ORPC_CLIENT_NAMES, orpcContract } from "@mish/contracts";

import type { MessagePortLike, WebSocketLike } from "../../src/transport.js";

type Listener = (event: unknown) => void;

export interface OrpcFixtureMetrics {
  readonly abortCount: number;
  readonly activeStreams: number;
  readonly cleanupCount: number;
  readonly handshakeClientNames: readonly OrpcClientName[];
  readonly receivedOperations: readonly string[];
}

export interface OrpcFixtureEvent {
  readonly sequence: number;
  readonly value: "changed" | "ready";
  readonly correlationId?: string;
  readonly parentEpoch?: number;
  readonly revision?: number;
  readonly sessionGeneration?: number;
}

export interface OrpcFixtureOptions {
  readonly authToken?: string;
  readonly contractVersion?: number;
  readonly protocolVersion?: number;
  readonly sessionGeneration?: number;
  readonly parentEpoch?: number;
  readonly revision?: number;
  readonly maxMessageBytes?: number;
  readonly maxDeadlineMs?: number;
  readonly staleInvoke?: "correlation" | "generation" | "parent-epoch" | "revision";
  readonly eventValues?: readonly OrpcFixtureEvent[];
  readonly eventReturn?: Partial<OrpcEventReturn>;
  readonly holdEventsUntilAbort?: boolean;
  readonly deferInvocations?: boolean;
}

export interface OrpcFixture {
  readonly clientMessagePort: MessagePortLike;
  readonly clientWebSocket: WebSocketLike;
  readonly metrics: OrpcFixtureMetrics;
  releaseInvocations(): void;
  close(): void;
}

interface MutableMetrics {
  abortCount: number;
  activeStreams: number;
  cleanupCount: number;
  handshakeClientNames: OrpcClientName[];
  receivedOperations: string[];
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
    const listeners = this.#listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    if (this.#readyState !== 1) throw new Error("fixture transport is closed");
    this.#peer?.emit("message", { data });
  }

  close(): void {
    if (this.#readyState === 3) return;
    this.#readyState = 3;
    this.emit("close", {});
    this.#peer?.closeFromPeer();
  }

  private closeFromPeer(): void {
    if (this.#readyState === 3) return;
    this.#readyState = 3;
    this.emit("close", {});
  }

  private emit(type: string, event: unknown): void {
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
    const listeners = this.#listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  postMessage(data: unknown): void {
    if (this.#closed) throw new Error("fixture port is closed");
    this.#peer?.emit("message", { data });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close", {});
    this.#peer?.closeFromPeer();
  }

  private closeFromPeer(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.emit("close", {});
  }

  private emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
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

function eventValues(
  input: Record<string, unknown>,
  options: OrpcFixtureOptions,
): readonly OrpcEventValue[] {
  return (
    options.eventValues ?? [
      { sequence: 1, value: "ready" },
      { sequence: 2, value: "changed" },
    ]
  ).map((event) => ({
    correlationId: event.correlationId ?? String(input.correlationId),
    parentEpoch: event.parentEpoch ?? Number(input.parentEpoch),
    revision: event.revision ?? Number(input.revision),
    sequence: event.sequence,
    sessionGeneration: event.sessionGeneration ?? Number(input.sessionGeneration),
    value: event.value,
  }));
}

function invokeOutput(input: OrpcInvokeInput, options: OrpcFixtureOptions): OrpcInvokeOutput {
  return {
    correlationId:
      options.staleInvoke === "correlation" ? "orpc-correlation-9999" : input.correlationId,
    operation: input.operation,
    parentEpoch: options.staleInvoke === "parent-epoch" ? input.parentEpoch + 1 : input.parentEpoch,
    revision: options.staleInvoke === "revision" ? input.revision + 1 : input.revision,
    sessionGeneration:
      options.staleInvoke === "generation" ? input.sessionGeneration + 1 : input.sessionGeneration,
    value: "accepted",
  };
}

function createRouter(
  options: OrpcFixtureOptions,
  metrics: MutableMetrics,
  pendingInvocations: Array<() => void>,
) {
  const implementation = implement(orpcContract);
  const expectedAuthToken = options.authToken ?? "fixture-auth-token";
  const acceptedClientNames = new Set<OrpcClientName>(ORPC_CLIENT_NAMES);
  const protocolVersion = options.protocolVersion ?? 1;
  const contractVersion = options.contractVersion ?? 1;
  const sessionGeneration = options.sessionGeneration ?? 1;
  const parentEpoch = options.parentEpoch ?? 1;
  const revision = options.revision ?? 1;
  const maxMessageBytes = options.maxMessageBytes ?? 4_096;
  const maxDeadlineMs = options.maxDeadlineMs ?? 500;

  return implementation.router({
    session: {
      handshake: implementation.session.handshake.handler(({ input }: any) => {
        metrics.receivedOperations.push("/session/handshake");
        if (input.authToken !== expectedAuthToken) {
          throw new ORPCError("UNAUTHORIZED", { status: 401, data: null });
        }
        if (!acceptedClientNames.has(input.clientName)) {
          throw new ORPCError("FORBIDDEN", { status: 403, data: null });
        }
        metrics.handshakeClientNames.push(input.clientName as OrpcClientName);
        if (input.protocolVersion !== protocolVersion) {
          throw new ORPCError("CONFLICT", { status: 409, data: null });
        }
        return {
          contractVersion,
          maxDeadlineMs,
          maxMessageBytes,
          parentEpoch,
          protocolVersion,
          revision,
          sessionGeneration,
        } as OrpcHandshakeOutput;
      }),
    },
    application: {
      invoke: implementation.application.invoke.handler(async ({ input, signal }: any) => {
        metrics.receivedOperations.push("/application/invoke");
        if (options.deferInvocations) {
          if (signal?.aborted) {
            metrics.abortCount += 1;
            throw new ORPCError("CLIENT_CLOSED_REQUEST", { status: 499, data: null });
          }
          await new Promise<void>((resolve) => {
            pendingInvocations.push(resolve);
            signal?.addEventListener(
              "abort",
              () => {
                metrics.abortCount += 1;
                resolve();
              },
              { once: true },
            );
          });
        }
        if (signal?.aborted) {
          metrics.abortCount += 1;
          throw new ORPCError("CLIENT_CLOSED_REQUEST", { status: 499, data: null });
        }
        return invokeOutput(input as OrpcInvokeInput, options);
      }),
      events: {
        watch: implementation.application.events.watch.handler(async function* ({
          input,
          signal,
        }: any) {
          metrics.receivedOperations.push("/application/events/watch");
          metrics.activeStreams += 1;
          try {
            if (options.holdEventsUntilAbort) {
              await deferredUntilAbort(signal, () => {
                metrics.abortCount += 1;
              });
              return {
                correlationId: String(input.correlationId),
                parentEpoch: Number(input.parentEpoch),
                revision: Number(input.revision),
                sessionGeneration: Number(input.sessionGeneration),
                value: "closed" as const,
              } satisfies OrpcEventReturn;
            }
            for (const event of eventValues(input as Record<string, unknown>, options)) {
              if (signal?.aborted) break;
              yield event;
            }
            return {
              correlationId: options.eventReturn?.correlationId ?? String(input.correlationId),
              parentEpoch: options.eventReturn?.parentEpoch ?? Number(input.parentEpoch),
              revision: options.eventReturn?.revision ?? Number(input.revision),
              sessionGeneration:
                options.eventReturn?.sessionGeneration ?? Number(input.sessionGeneration),
              value: "closed" as const,
            } satisfies OrpcEventReturn;
          } finally {
            metrics.activeStreams -= 1;
            metrics.cleanupCount += 1;
          }
        }),
      },
    },
  });
}

export function createOrpcFixture(options: OrpcFixtureOptions = {}): OrpcFixture {
  const mutable: MutableMetrics = {
    abortCount: 0,
    activeStreams: 0,
    cleanupCount: 0,
    handshakeClientNames: [],
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

  const router = createRouter(options, mutable, pendingInvocations);
  new WebSocketRPCHandler(router).upgrade(serverWebSocket as never);
  new MessagePortRPCHandler(router).upgrade(serverMessagePort as never);

  const metrics: OrpcFixtureMetrics = {
    get abortCount() {
      return mutable.abortCount;
    },
    get activeStreams() {
      return mutable.activeStreams;
    },
    get cleanupCount() {
      return mutable.cleanupCount;
    },
    get handshakeClientNames() {
      return [...mutable.handshakeClientNames];
    },
    get receivedOperations() {
      return [...mutable.receivedOperations];
    },
  };

  return {
    clientMessagePort,
    clientWebSocket,
    metrics,
    releaseInvocations() {
      for (const resolve of pendingInvocations.splice(0)) resolve();
    },
    close() {
      clientWebSocket.close();
      clientMessagePort.close();
    },
  };
}
