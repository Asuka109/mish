import { ServerPeer } from "../../../node_modules/.pnpm/@orpc+standard-server-peer@1.15.0/node_modules/@orpc/standard-server-peer/dist/index.mjs";
import type { EncodedMessage } from "../../../node_modules/.pnpm/@orpc+standard-server-peer@1.15.0/node_modules/@orpc/standard-server-peer/dist/index.mjs";
import type {
  StandardRequest,
  StandardResponse,
} from "../../../node_modules/.pnpm/@orpc+standard-server@1.15.0/node_modules/@orpc/standard-server/dist/index.mjs";

import type {
  EventValue,
  EventIteratorReturn,
  InvokeInput,
  InvokeOutput,
} from "../../src/contract.js";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function inputFromBody(body: unknown): unknown {
  if (isRecord(body) && "json" in body) {
    return body.json;
  }
  return body;
}

function response(body: unknown, status = 200): StandardResponse {
  return {
    status,
    headers: {},
    body: { json: body },
  };
}

function unauthorizedResponse(): StandardResponse {
  return response(
    {
      defined: true,
      code: "UNAUTHORIZED",
      status: 401,
      message: "Unauthorized",
      data: null,
    },
    401,
  );
}

function versionMismatchResponse(): StandardResponse {
  return response(
    {
      defined: true,
      code: "CONFLICT",
      status: 409,
      message: "Protocol version mismatch",
      data: null,
    },
    409,
  );
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
  readonly #sendToServer: (data: unknown) => void;
  #readyState = 1;

  constructor(sendToServer: (data: unknown) => void) {
    this.#sendToServer = sendToServer;
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
    this.#sendToServer(data);
  }

  close(): void {
    if (this.#readyState === 3) return;
    this.#readyState = 3;
    this.#emit("close", {});
  }

  deliver(data: EncodedMessage): void {
    if (this.#readyState !== 1) return;
    this.#emit("message", { data });
  }

  #emit(type: string, event: unknown): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }
}

class FixtureMessagePort implements MessagePortLike {
  readonly #listeners = new Map<string, Set<Listener>>();
  readonly #postToServer: (data: unknown) => void;
  #closed = false;

  constructor(postToServer: (data: unknown) => void) {
    this.#postToServer = postToServer;
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
    this.#postToServer(data);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#emit("close", {});
  }

  deliver(data: EncodedMessage): void {
    if (this.#closed) return;
    this.#emit("message", { data });
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

export function createOrpcFixture(options: OrpcFixtureOptions = {}): OrpcFixture {
  const expectedAuthToken = options.authToken ?? "fixture-token";
  const protocolVersion = options.protocolVersion ?? 1;
  const sessionGeneration = options.sessionGeneration ?? 1;
  const maxMessageBytes = options.maxMessageBytes ?? 4096;
  const mutable: MutableMetrics = {
    abortCount: 0,
    activeStreams: 0,
    cleanupCount: 0,
    receivedOperations: [],
  };
  const pendingInvocations: Array<() => void> = [];

  let websocket: FixtureWebSocket;
  let messagePort: FixtureMessagePort;

  const handleRequest = async (request: StandardRequest): Promise<StandardResponse> => {
    const input = inputFromBody(request.body);
    if (!isRecord(input))
      return response(
        { defined: true, code: "BAD_REQUEST", status: 400, message: "Bad Request", data: null },
        400,
      );
    const operation = request.url.pathname;
    mutable.receivedOperations.push(operation);

    if (operation === "/session/handshake") {
      if (input.authToken !== expectedAuthToken) return unauthorizedResponse();
      if (input.protocolVersion !== protocolVersion) return versionMismatchResponse();
      return response({ maxMessageBytes, protocolVersion, sessionGeneration });
    }

    if (operation === "/invoke") {
      const invokeInput = input as unknown as InvokeInput;
      if (options.deferInvocations) {
        await new Promise<void>((resolve) => {
          pendingInvocations.push(resolve);
          request.signal?.addEventListener(
            "abort",
            () => {
              mutable.abortCount += 1;
              resolve();
            },
            { once: true },
          );
        });
      }
      if (request.signal?.aborted) {
        mutable.abortCount += 1;
        return response(
          {
            defined: true,
            code: "CLIENT_CLOSED_REQUEST",
            status: 499,
            message: "Client Closed Request",
            data: null,
          },
          499,
        );
      }
      return response(invokeOutput(invokeInput, options));
    }

    if (operation === "/events/watch") {
      const eventInput = input;
      const stream = async function* (): AsyncGenerator<unknown, unknown, undefined> {
        mutable.activeStreams += 1;
        try {
          if (options.holdEventsUntilAbort) {
            await deferredUntilAbort(request.signal, () => {
              mutable.abortCount += 1;
            });
            return {
              json: {
                correlationId: String(eventInput.correlationId),
                sessionGeneration: Number(eventInput.sessionGeneration),
                value: "closed",
              },
            };
          }
          for (const event of eventValues(eventInput, options)) {
            if (request.signal?.aborted) break;
            yield { json: event };
          }
          return {
            json: {
              correlationId: options.eventReturn?.correlationId ?? String(eventInput.correlationId),
              sessionGeneration:
                options.eventReturn?.sessionGeneration ?? Number(eventInput.sessionGeneration),
              value: "closed",
            },
          };
        } finally {
          mutable.activeStreams -= 1;
          mutable.cleanupCount += 1;
        }
      };
      return { status: 200, headers: {}, body: stream() };
    }

    return response(
      { defined: true, code: "NOT_FOUND", status: 404, message: "Not Found", data: null },
      404,
    );
  };

  const serverPeer = new ServerPeer(async (message) => {
    websocket.deliver(message);
  });
  websocket = new FixtureWebSocket((data) => {
    void serverPeer.message(data as EncodedMessage, handleRequest);
  });

  const portServerPeer = new ServerPeer(async (message) => {
    messagePort.deliver(message);
  });
  messagePort = new FixtureMessagePort((data) => {
    void portServerPeer.message(data as EncodedMessage, handleRequest);
  });

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
    clientWebSocket: websocket,
    clientMessagePort: messagePort,
    releaseInvocations() {
      for (const resolve of pendingInvocations.splice(0)) resolve();
    },
    close() {
      websocket.close();
      messagePort.close();
      serverPeer.close();
      portServerPeer.close();
    },
  };
}
