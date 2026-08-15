import type { OrpcSessionError } from "./session.js";

const OPEN_WEBSOCKET_STATE = 1;
const MIN_MESSAGE_BYTES = 128;
const MAX_MESSAGE_BYTES = 1024 * 1024;

export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024;

class TransportError<Kind extends "disconnected" | "message-too-large"> extends Error {
  readonly kind: Kind;

  constructor(kind: Kind) {
    super(kind);
    this.name = "OrpcTransportError";
    this.kind = kind;
  }
}

export type ChannelEventListener = (event: unknown) => void;

export interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  removeEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  send(data: string): void;
  close(): void;
}

export interface MessagePortLike {
  addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  removeEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  postMessage(data: unknown, transfer?: unknown[]): void;
  close(): void;
  start?(): void;
}

export interface OrpcChannel {
  readonly kind: "message-port" | "websocket";
  readonly maxMessageBytes: number;
  readonly readyState: number;
  addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  removeEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  setMaxMessageBytes(maxMessageBytes: number): void;
  setOversizeHandler(handler: (() => void) | undefined): void;
  close(): void;
}

function validateMaxMessageBytes(value: number): void {
  if (!Number.isSafeInteger(value) || value < MIN_MESSAGE_BYTES || value > MAX_MESSAGE_BYTES) {
    throw new RangeError(
      `Message size must be between ${MIN_MESSAGE_BYTES} and ${MAX_MESSAGE_BYTES} bytes`,
    );
  }
}

function eventData(event: unknown): unknown {
  if (typeof event === "object" && event !== null && "data" in event) {
    return (event as { data: unknown }).data;
  }
  return event;
}

function byteLength(data: unknown): number {
  if (typeof data === "string") {
    return new TextEncoder().encode(data).byteLength;
  }
  if (data instanceof ArrayBuffer) {
    return data.byteLength;
  }
  if (ArrayBuffer.isView(data)) {
    return data.byteLength;
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return data.size;
  }
  if (typeof data === "object" && data !== null && "byteLength" in data) {
    const value = (data as { byteLength: unknown }).byteLength;
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      return value;
    }
  }
  try {
    const encoded = JSON.stringify(data);
    return encoded === undefined ? 0 : new TextEncoder().encode(encoded).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

abstract class BoundedChannel implements OrpcChannel {
  abstract readonly kind: "message-port" | "websocket";
  abstract readonly readyState: number;

  #maxMessageBytes: number;
  #oversizeHandler: (() => void) | undefined;
  readonly #listeners = new Map<string, Map<ChannelEventListener, ChannelEventListener>>();

  protected constructor(maxMessageBytes: number) {
    validateMaxMessageBytes(maxMessageBytes);
    this.#maxMessageBytes = maxMessageBytes;
  }

  get maxMessageBytes(): number {
    return this.#maxMessageBytes;
  }

  setMaxMessageBytes(maxMessageBytes: number): void {
    validateMaxMessageBytes(maxMessageBytes);
    this.#maxMessageBytes = Math.min(this.#maxMessageBytes, maxMessageBytes);
  }

  setOversizeHandler(handler: (() => void) | undefined): void {
    this.#oversizeHandler = handler;
  }

  protected assertWithinLimit(data: unknown): void {
    if (byteLength(data) > this.#maxMessageBytes) {
      this.#oversizeHandler?.();
      throw new TransportError("message-too-large");
    }
  }

  protected listener(type: string, listener: ChannelEventListener): ChannelEventListener {
    if (type !== "message") return listener;
    return (event) => {
      try {
        this.assertWithinLimit(eventData(event));
      } catch (error) {
        if (isOversizeError(error)) return;
        throw error;
      }
      listener(event);
    };
  }

  protected remember(
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

  protected remembered(type: string, listener: ChannelEventListener): ChannelEventListener {
    return this.#listeners.get(type)?.get(listener) ?? listener;
  }

  protected forget(type: string, listener: ChannelEventListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  protected clearListeners(remove: (type: string, listener: ChannelEventListener) => void): void {
    for (const [type, listeners] of this.#listeners) {
      for (const wrapped of listeners.values()) remove(type, wrapped);
    }
    this.#listeners.clear();
  }

  abstract addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void;
  abstract removeEventListener(
    type: string,
    listener: ChannelEventListener,
    options?: unknown,
  ): void;
  abstract close(): void;
}

function isOversizeError(error: unknown): error is { readonly kind: "message-too-large" } {
  return (
    typeof error === "object" &&
    error !== null &&
    "kind" in error &&
    error.kind === "message-too-large"
  );
}

export class WebSocketTransport extends BoundedChannel {
  readonly kind = "websocket" as const;
  readonly #socket: WebSocketLike;

  constructor(socket: WebSocketLike, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES) {
    super(maxMessageBytes);
    this.#socket = socket;
  }

  get readyState(): number {
    return this.#socket.readyState;
  }

  send(data: string): void {
    this.assertWithinLimit(data);
    if (this.#socket.readyState !== OPEN_WEBSOCKET_STATE) {
      throw new TransportError("disconnected");
    }
    this.#socket.send(data);
  }

  addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void {
    const wrapped = this.listener(type, listener);
    this.remember(type, listener, wrapped);
    this.#socket.addEventListener(type, wrapped, options);
  }

  removeEventListener(type: string, listener: ChannelEventListener, options?: unknown): void {
    this.#socket.removeEventListener(type, this.remembered(type, listener), options);
    this.forget(type, listener);
  }

  close(): void {
    this.clearListeners((type, listener) => this.#socket.removeEventListener(type, listener));
    this.#socket.close();
  }
}

export class MessagePortTransport extends BoundedChannel {
  readonly kind = "message-port" as const;
  readonly #port: MessagePortLike;
  #closed = false;

  constructor(port: MessagePortLike, maxMessageBytes = DEFAULT_MAX_MESSAGE_BYTES) {
    super(maxMessageBytes);
    this.#port = port;
    this.#port.start?.();
  }

  get readyState(): number {
    return this.#closed ? 3 : 1;
  }

  postMessage(data: unknown, transfer?: unknown[]): void {
    if (this.#closed) throw new TransportError("disconnected");
    this.assertWithinLimit(data);
    this.#port.postMessage(data, transfer);
  }

  addEventListener(type: string, listener: ChannelEventListener, options?: unknown): void {
    const wrapped = this.listener(type, listener);
    this.remember(type, listener, wrapped);
    this.#port.addEventListener(type, wrapped, options);
  }

  removeEventListener(type: string, listener: ChannelEventListener, options?: unknown): void {
    this.#port.removeEventListener(type, this.remembered(type, listener), options);
    this.forget(type, listener);
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.clearListeners((type, listener) => this.#port.removeEventListener(type, listener));
    this.#port.close();
  }
}

export function asSessionError(error: unknown): OrpcSessionError | undefined {
  if (typeof error === "object" && error !== null && "kind" in error) {
    const kind = error.kind;
    if (typeof kind === "string") return error as OrpcSessionError;
  }
  return undefined;
}
