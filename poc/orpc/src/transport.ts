import { createORPCClient } from "@orpc/client";
import { RPCLink as MessagePortRPCLink } from "@orpc/client/message-port";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";

import type {
  EventInput,
  EventIteratorReturn,
  EventValue,
  HandshakeInput,
  HandshakeOutput,
  InvokeInput,
  InvokeOutput,
  ORPCContractClient,
} from "./contract.js";
import { BoundedTranscript } from "./transcript.js";

export type TransportKind = "websocket" | "message-port";

export type PolicyErrorKind =
  | "already-connected"
  | "cancelled"
  | "deadline-exceeded"
  | "disconnected"
  | "disposed"
  | "message-too-large"
  | "not-connected"
  | "protocol"
  | "stale-response"
  | "unauthorized"
  | "version-mismatch";

export class PolicyTransportError extends Error {
  readonly kind: PolicyErrorKind;

  constructor(kind: PolicyErrorKind) {
    super(kind);
    this.kind = kind;
    this.name = "PolicyTransportError";
  }
}

export interface DeadlineScheduler {
  schedule(delayMs: number, callback: () => void): unknown;
  cancel(handle: unknown): void;
}

export const systemDeadlineScheduler: DeadlineScheduler = {
  schedule(delayMs, callback) {
    return setTimeout(callback, delayMs);
  },
  cancel(handle) {
    clearTimeout(handle as ReturnType<typeof setTimeout>);
  },
};

type ChannelEventListener = (event: unknown) => void;

export interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  removeEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  send(data: unknown): void;
  close(): void;
}

export interface MessagePortLike {
  addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  removeEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  postMessage(data: unknown, transfer?: unknown[]): void;
  close(): void;
}

export interface PolicyChannel {
  readonly kind: TransportKind;
  readonly readyState: number;
  addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  removeEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  setMaxMessageBytes(maxMessageBytes: number): void;
  setOversizeHandler(handler: (() => void) | undefined): void;
  close(): void;
}

const WEBSOCKET_OPEN = 1;

function messageData(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "data" in event) {
    return (event as { data: unknown }).data;
  }
  return event;
}

function messageByteLength(data: unknown): number {
  if (typeof data === "string") {
    return new TextEncoder().encode(data).byteLength;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (typeof data === "object" && data !== null && "size" in data) {
    const size = (data as { size: unknown }).size;
    if (typeof size === "number" && Number.isFinite(size)) {
      return size;
    }
  }
  const encoded = JSON.stringify(data);
  return encoded === undefined ? 0 : new TextEncoder().encode(encoded).byteLength;
}

function validateMaxMessageBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < 128 || value > 1024 * 1024) {
    throw new Error("maxMessageBytes must be between 128 and 1048576");
  }
}

abstract class BoundedChannelBase implements PolicyChannel {
  abstract readonly kind: TransportKind;
  abstract readonly readyState: number;

  #maxMessageBytes: number;
  #oversizeHandler: (() => void) | undefined;
  readonly #listeners = new Map<string, Map<ChannelEventListener, ChannelEventListener>>();

  constructor(maxMessageBytes: number) {
    validateMaxMessageBytes(maxMessageBytes);
    this.#maxMessageBytes = maxMessageBytes;
  }

  setMaxMessageBytes(maxMessageBytes: number): void {
    validateMaxMessageBytes(maxMessageBytes);
    this.#maxMessageBytes = Math.min(this.#maxMessageBytes, maxMessageBytes);
  }

  setOversizeHandler(handler: (() => void) | undefined): void {
    this.#oversizeHandler = handler;
  }

  protected assertWithinLimit(data: unknown): void {
    if (messageByteLength(data) > this.#maxMessageBytes) {
      this.#oversizeHandler?.();
      throw new PolicyTransportError("message-too-large");
    }
  }

  protected wrapListener(type: string, listener: ChannelEventListener): ChannelEventListener {
    if (type !== "message") {
      return listener;
    }
    return (event) => {
      try {
        this.assertWithinLimit(messageData(event));
      } catch (error) {
        if (isPolicyError(error) && error.kind === "message-too-large") {
          return;
        }
        throw error;
      }
      listener(event);
    };
  }

  protected rememberListener(
    type: string,
    listener: ChannelEventListener,
    wrapped: ChannelEventListener,
  ): void {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Map();
      this.#listeners.set(type, listeners);
    }
    listeners.set(listener, wrapped);
  }

  protected rememberedListener(type: string, listener: ChannelEventListener): ChannelEventListener {
    return this.#listeners.get(type)?.get(listener) ?? listener;
  }

  protected forgetListener(type: string, listener: ChannelEventListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  abstract addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  abstract removeEventListener(
    type: string,
    listener: ChannelEventListener,
    options?: unknown,
  ): void;
  abstract close(): void;
}

export class BoundedWebSocketChannel extends BoundedChannelBase {
  readonly kind = "websocket" as const;
  readonly #socket: WebSocketLike;

  constructor(socket: WebSocketLike, maxMessageBytes: number) {
    super(maxMessageBytes);
    this.#socket = socket;
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  send(data: unknown): void {
    this.assertWithinLimit(data);
    if (this.#socket.readyState !== WEBSOCKET_OPEN) {
      throw new PolicyTransportError("disconnected");
    }
    this.#socket.send(data);
  }

  addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void {
    const wrapped = this.wrapListener(type, listener);
    this.rememberListener(type, listener, wrapped);
    this.#socket.addEventListener(type, wrapped, options);
  }

  removeEventListener(type: string, listener: ChannelEventListener, options?: unknown): void {
    this.#socket.removeEventListener(type, this.rememberedListener(type, listener), options);
    this.forgetListener(type, listener);
  }

  close(): void {
    this.#socket.close();
  }
}

export class BoundedMessagePortChannel extends BoundedChannelBase {
  readonly kind = "message-port" as const;
  readonly #port: MessagePortLike;

  constructor(port: MessagePortLike, maxMessageBytes: number) {
    super(maxMessageBytes);
    this.#port = port;
  }

  get readyState(): number {
    return 1;
  }

  postMessage(data: unknown, transfer?: unknown[]): void {
    this.assertWithinLimit(data);
    this.#port.postMessage(data, transfer);
  }

  addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void {
    const wrapped = this.wrapListener(type, listener);
    this.rememberListener(type, listener, wrapped);
    this.#port.addEventListener(type, wrapped, options);
  }

  removeEventListener(type: string, listener: ChannelEventListener, options?: unknown): void {
    this.#port.removeEventListener(type, this.rememberedListener(type, listener), options);
    this.forgetListener(type, listener);
  }

  close(): void {
    this.#port.close();
  }
}

export interface PolicySessionOptions {
  readonly authToken: string;
  readonly clientName: "web" | "electron";
  readonly clientVersion: string;
  readonly protocolVersion?: number;
  readonly maxMessageBytes?: number;
  readonly maxDeadlineMs?: number;
  readonly scheduler?: DeadlineScheduler;
  readonly transcript?: BoundedTranscript;
}

export type PolicySessionState = "disconnected" | "connecting" | "connected" | "disposed";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPolicyError(error: unknown): error is PolicyTransportError {
  return error instanceof PolicyTransportError;
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function staticError(error: unknown, fallback: PolicyErrorKind): PolicyTransportError {
  if (isPolicyError(error)) return error;
  const code = errorCode(error);
  if (code === "UNAUTHORIZED" || (isRecord(error) && error.status === 401)) {
    return new PolicyTransportError("unauthorized");
  }
  if (code === "CONFLICT" || (isRecord(error) && error.status === 409)) {
    return new PolicyTransportError("version-mismatch");
  }
  return new PolicyTransportError(fallback);
}

function clientOptions(signal?: AbortSignal): {
  context: Record<PropertyKey, never>;
  signal?: AbortSignal;
} {
  return signal ? { context: {}, signal } : { context: {} };
}

function operationName(
  operation: InvokeInput["operation"],
): "invoke.status.snapshot" | "invoke.profile.refresh" {
  return operation === "status.snapshot" ? "invoke.status.snapshot" : "invoke.profile.refresh";
}

function isEventValue(value: unknown): value is EventValue {
  return (
    isRecord(value) &&
    typeof value.correlationId === "string" &&
    typeof value.sequence === "number" &&
    typeof value.sessionGeneration === "number" &&
    (value.value === "ready" || value.value === "changed")
  );
}

function isEventReturn(value: unknown): value is EventIteratorReturn {
  return (
    isRecord(value) &&
    typeof value.correlationId === "string" &&
    typeof value.sessionGeneration === "number" &&
    value.value === "closed"
  );
}

export class PolicySession {
  readonly #options: {
    readonly authToken: string;
    readonly clientName: "web" | "electron";
    readonly clientVersion: string;
    readonly protocolVersion: number;
    readonly maxMessageBytes: number;
    readonly maxDeadlineMs: number;
  };
  readonly #scheduler: DeadlineScheduler;
  #transcript: BoundedTranscript | undefined;
  #channel: PolicyChannel | undefined;
  #client: ORPCContractClient | undefined;
  #state: PolicySessionState = "disconnected";
  #sessionGeneration = 0;
  #connectionId = 0;
  #nextCorrelationId = 1;
  #pendingControllers = new Set<AbortController>();
  #closing = false;

  constructor(options: PolicySessionOptions) {
    this.#options = {
      authToken: options.authToken,
      clientName: options.clientName,
      clientVersion: options.clientVersion,
      protocolVersion: options.protocolVersion ?? 1,
      maxMessageBytes: options.maxMessageBytes ?? 16 * 1024,
      maxDeadlineMs: options.maxDeadlineMs ?? 1000,
    };
    validateMaxMessageBytes(this.#options.maxMessageBytes);
    if (!Number.isSafeInteger(this.#options.maxDeadlineMs) || this.#options.maxDeadlineMs < 1) {
      throw new Error("maxDeadlineMs must be a positive integer");
    }
    this.#scheduler = options.scheduler ?? systemDeadlineScheduler;
    this.#transcript = options.transcript;
  }

  get state(): PolicySessionState {
    return this.#state;
  }

  get sessionGeneration(): number {
    return this.#sessionGeneration;
  }

  get transcript(): readonly import("./transcript.js").TranscriptEvent[] {
    return this.#transcript?.snapshot() ?? [];
  }

  async connect(channel: PolicyChannel): Promise<HandshakeOutput> {
    if (this.#state === "disposed") {
      throw new PolicyTransportError("disposed");
    }
    if (this.#state === "connected" || this.#state === "connecting") {
      throw new PolicyTransportError("already-connected");
    }
    if (this.#transcript === undefined) {
      this.#transcript = new BoundedTranscript({ transport: channel.kind });
    }
    this.#channel = channel;
    this.#state = "connecting";
    this.#connectionId += 1;
    const connectionId = this.#connectionId;
    channel.setOversizeHandler(() => this.#handleOversized(channel));
    channel.addEventListener("close", () => this.#handleChannelClose(channel, connectionId));
    this.#client = this.#createClient(channel);
    const correlationId = this.#nextCorrelation();
    const input: HandshakeInput = {
      authToken: this.#options.authToken,
      clientName: this.#options.clientName,
      clientVersion: this.#options.clientVersion,
      protocolVersion: this.#options.protocolVersion,
    };
    this.#record({
      operation: "session.handshake",
      effect: "invocation",
      result: "accepted",
      correlationId,
      sessionGeneration: Math.max(1, this.#sessionGeneration),
    });
    try {
      const output = await this.#client.session.handshake(input, clientOptions());
      this.#validateHandshake(output);
      channel.setMaxMessageBytes(output.maxMessageBytes);
      this.#sessionGeneration = output.sessionGeneration;
      this.#state = "connected";
      this.#record({
        operation: "session.handshake",
        effect: "result",
        result: "accepted",
        correlationId,
        sessionGeneration: this.#sessionGeneration,
      });
      return output;
    } catch (error) {
      const mapped = staticError(error, "protocol");
      this.#record({
        operation: "session.handshake",
        effect: "result",
        result: mapped.kind === "unauthorized" ? "rejected" : "stale",
        correlationId,
        sessionGeneration: Math.max(1, this.#sessionGeneration),
      });
      this.#state = "disconnected";
      this.#client = undefined;
      this.#closing = true;
      channel.close();
      this.#closing = false;
      if (this.#channel === channel) this.#channel = undefined;
      throw mapped;
    }
  }

  async reconnect(channel: PolicyChannel): Promise<HandshakeOutput> {
    if (this.#state === "disposed") {
      throw new PolicyTransportError("disposed");
    }
    if (this.#state === "connected" || this.#state === "connecting") {
      this.#closeCurrent("reconnected");
    }
    this.#record({
      operation: "transport.reconnect",
      effect: "invocation",
      result: "accepted",
      correlationId: this.#peekCorrelation(),
      sessionGeneration: Math.max(1, this.#sessionGeneration),
    });
    const output = await this.connect(channel);
    this.#record({
      operation: "transport.reconnect",
      effect: "result",
      result: "reconnected",
      correlationId: this.#peekCorrelation(),
      sessionGeneration: this.#sessionGeneration,
    });
    return output;
  }

  async invoke(
    operation: InvokeInput["operation"],
    options: { readonly deadlineMs?: number; readonly signal?: AbortSignal } = {},
  ): Promise<InvokeOutput> {
    this.#assertConnected();
    const client = this.#client;
    if (!client) throw new PolicyTransportError("not-connected");
    const connectionId = this.#connectionId;
    const generation = this.#sessionGeneration;
    const correlationId = this.#nextCorrelation();
    const deadlineMs = options.deadlineMs ?? Math.min(250, this.#options.maxDeadlineMs);
    if (
      !Number.isSafeInteger(deadlineMs) ||
      deadlineMs < 1 ||
      deadlineMs > this.#options.maxDeadlineMs
    ) {
      throw new PolicyTransportError("deadline-exceeded");
    }
    if (options.signal?.aborted) {
      throw new PolicyTransportError("cancelled");
    }
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    options.signal?.addEventListener("abort", onAbort, { once: true });
    this.#pendingControllers.add(controller);
    let timedOut = false;
    const timer = this.#scheduler.schedule(deadlineMs, () => {
      timedOut = true;
      controller.abort();
    });
    const input: InvokeInput = {
      correlationId,
      deadlineMs,
      operation,
      sessionGeneration: generation,
    };
    this.#record({
      operation: operationName(operation),
      effect: "invocation",
      result: "accepted",
      correlationId,
      sessionGeneration: generation,
    });
    try {
      const output = await client.invoke(input, clientOptions(controller.signal));
      if (
        output.correlationId !== correlationId ||
        output.operation !== operation ||
        output.sessionGeneration !== generation
      ) {
        throw new PolicyTransportError("stale-response");
      }
      this.#record({
        operation: operationName(operation),
        effect: "result",
        result: "accepted",
        correlationId,
        sessionGeneration: generation,
      });
      return output;
    } catch (error) {
      let mapped: PolicyTransportError;
      if (timedOut) {
        mapped = new PolicyTransportError("deadline-exceeded");
      } else if (options.signal?.aborted) {
        mapped = new PolicyTransportError("cancelled");
      } else if (this.#connectionId !== connectionId || this.#state === "disconnected") {
        mapped = new PolicyTransportError("disconnected");
      } else {
        mapped = staticError(error, "protocol");
      }
      this.#record({
        operation: operationName(operation),
        effect: "result",
        result: this.#resultForError(mapped),
        correlationId,
        sessionGeneration: generation,
      });
      throw mapped;
    } finally {
      this.#scheduler.cancel(timer);
      this.#pendingControllers.delete(controller);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async watchEvents(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<AsyncIterableIterator<EventValue>> {
    this.#assertConnected();
    if (options.signal?.aborted) {
      throw new PolicyTransportError("cancelled");
    }
    const client = this.#client;
    if (!client) throw new PolicyTransportError("not-connected");
    const connectionId = this.#connectionId;
    const generation = this.#sessionGeneration;
    const correlationId = this.#nextCorrelation();
    const input: EventInput = { correlationId, sessionGeneration: generation };
    this.#record({
      operation: "events.watch",
      effect: "invocation",
      result: "accepted",
      correlationId,
      sessionGeneration: generation,
    });
    const iterator = await client.events.watch(input, clientOptions(options.signal));
    let lastSequence = 0;
    let finished = false;

    const finish = async (): Promise<void> => {
      if (finished) return;
      finished = true;
      try {
        await iterator.return?.();
      } catch {
        // A transport close already performed the cleanup; the wrapper still
        // emits its bounded cleanup fact below.
      }
      this.#record({
        operation: "events.watch",
        effect: "cleanup",
        result: "cleaned-up",
        correlationId,
        sessionGeneration: generation,
      });
    };

    const wrapped: AsyncIterableIterator<EventValue> = {
      [Symbol.asyncIterator]() {
        return this;
      },
      async next() {
        try {
          const result = await iterator.next();
          if (result.done) {
            if (
              !isEventReturn(result.value) ||
              result.value.correlationId !== correlationId ||
              result.value.sessionGeneration !== generation
            ) {
              throw new PolicyTransportError("stale-response");
            }
            finished = true;
            thisSession.#record({
              operation: "events.watch",
              effect: "result",
              result: "accepted",
              correlationId,
              sessionGeneration: generation,
            });
            return { done: true, value: undefined } as IteratorResult<EventValue>;
          }
          if (
            !isEventValue(result.value) ||
            result.value.correlationId !== correlationId ||
            result.value.sessionGeneration !== generation
          ) {
            throw new PolicyTransportError("stale-response");
          }
          if (result.value.sequence <= lastSequence) {
            throw new PolicyTransportError("stale-response");
          }
          lastSequence = result.value.sequence;
          thisSession.#record({
            operation: "events.watch",
            effect: "event",
            result: "accepted",
            correlationId,
            sessionGeneration: generation,
          });
          return { done: false, value: result.value };
        } catch (error) {
          const mapped =
            error instanceof PolicyTransportError
              ? error
              : options.signal?.aborted
                ? new PolicyTransportError("cancelled")
                : thisSession.#connectionId !== connectionId ||
                    thisSession.#state === "disconnected"
                  ? new PolicyTransportError("disconnected")
                  : staticError(error, "protocol");
          await finish();
          thisSession.#record({
            operation: "events.watch",
            effect: "result",
            result: thisSession.#resultForError(mapped),
            correlationId,
            sessionGeneration: generation,
          });
          throw mapped;
        }
      },
      async return() {
        await finish();
        return { done: true, value: undefined };
      },
    };
    const thisSession = this;
    return wrapped;
  }

  disconnect(): void {
    if (this.#state === "disposed") return;
    this.#closeCurrent("disconnected");
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    this.#closeCurrent("cleaned-up");
    this.#state = "disposed";
  }

  #createClient(channel: PolicyChannel): ORPCContractClient {
    if (channel.kind === "websocket") {
      const link = new WebSocketRPCLink({ websocket: channel as never });
      return createORPCClient<ORPCContractClient>(link);
    }
    const link = new MessagePortRPCLink({ port: channel as never });
    return createORPCClient<ORPCContractClient>(link);
  }

  #validateHandshake(output: HandshakeOutput): void {
    if (output.protocolVersion !== this.#options.protocolVersion) {
      throw new PolicyTransportError("version-mismatch");
    }
    if (
      !Number.isSafeInteger(output.sessionGeneration) ||
      output.sessionGeneration < 1 ||
      (this.#sessionGeneration > 0 && output.sessionGeneration <= this.#sessionGeneration)
    ) {
      throw new PolicyTransportError("stale-response");
    }
    validateMaxMessageBytes(output.maxMessageBytes);
  }

  #assertConnected(): void {
    if (this.#state === "disposed") throw new PolicyTransportError("disposed");
    if (this.#state !== "connected" || !this.#client || !this.#channel) {
      throw new PolicyTransportError("not-connected");
    }
  }

  #nextCorrelation(): string {
    const value = `poc-${String(this.#nextCorrelationId).padStart(4, "0")}`;
    this.#nextCorrelationId += 1;
    return value;
  }

  #peekCorrelation(): string {
    return `poc-${String(Math.max(1, this.#nextCorrelationId - 1)).padStart(4, "0")}`;
  }

  #resultForError(
    error: PolicyTransportError,
  ):
    | "rejected"
    | "stale"
    | "deadline-exceeded"
    | "cancelled"
    | "oversized"
    | "disconnected"
    | "cleaned-up" {
    switch (error.kind) {
      case "stale-response":
      case "version-mismatch":
        return "stale";
      case "deadline-exceeded":
        return "deadline-exceeded";
      case "cancelled":
        return "cancelled";
      case "message-too-large":
        return "oversized";
      case "disconnected":
      case "not-connected":
        return "disconnected";
      case "disposed":
        return "cleaned-up";
      default:
        return "rejected";
    }
  }

  #record(event: Parameters<BoundedTranscript["record"]>[0]): void {
    this.#transcript?.record(event);
  }

  #handleOversized(channel: PolicyChannel): void {
    this.#record({
      operation: "transport.disconnect",
      effect: "result",
      result: "oversized",
      correlationId: this.#peekCorrelation(),
      sessionGeneration: Math.max(1, this.#sessionGeneration),
    });
    if (this.#channel === channel) {
      this.#closeCurrent("oversized");
    }
  }

  #handleChannelClose(channel: PolicyChannel, connectionId: number): void {
    if (this.#closing || this.#channel !== channel || this.#connectionId !== connectionId) return;
    this.#state = "disconnected";
    this.#connectionId += 1;
    this.#client = undefined;
    for (const controller of this.#pendingControllers) controller.abort();
    this.#record({
      operation: "transport.disconnect",
      effect: "result",
      result: "disconnected",
      correlationId: this.#peekCorrelation(),
      sessionGeneration: Math.max(1, this.#sessionGeneration),
    });
  }

  #closeCurrent(result: "disconnected" | "reconnected" | "cleaned-up" | "oversized"): void {
    const channel = this.#channel;
    this.#connectionId += 1;
    this.#state = "disconnected";
    this.#client = undefined;
    this.#channel = undefined;
    for (const controller of this.#pendingControllers) controller.abort();
    if (channel) {
      this.#record({
        operation: result === "reconnected" ? "transport.reconnect" : "transport.disconnect",
        effect: result === "cleaned-up" ? "cleanup" : "result",
        result:
          result === "reconnected" ? "reconnected" : result === "oversized" ? "oversized" : result,
        correlationId: this.#peekCorrelation(),
        sessionGeneration: Math.max(1, this.#sessionGeneration),
      });
      this.#closing = true;
      channel.setOversizeHandler(undefined);
      channel.close();
      this.#closing = false;
    }
  }
}
