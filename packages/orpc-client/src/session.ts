import { createORPCClient } from "@orpc/client";
import { RPCLink as MessagePortRPCLink } from "@orpc/client/message-port";
import { RPCLink as WebSocketRPCLink } from "@orpc/client/websocket";
import type {
  OrpcClientName,
  OrpcContractClient,
  OrpcEventReturn,
  OrpcEventValue,
  OrpcHandshakeOutput,
  OrpcOperation,
  OrpcInvokeOutput,
} from "@mish/contracts";
import { ORPC_CONTRACT_VERSION, ORPC_PROTOCOL_VERSION } from "@mish/contracts";

import {
  BoundedTranscript,
  type OrpcTranscriptEffect,
  type OrpcTranscriptOperation,
  type OrpcTranscriptResult,
  type OrpcTransportKind,
} from "./transcript.js";
import { asSessionError, type ChannelEventListener, type OrpcChannel } from "./transport.js";

export type OrpcSessionState =
  | "authenticating"
  | "connected-current"
  | "connected-stale"
  | "connecting"
  | "disconnected"
  | "disposed";

export type OrpcStaleReason =
  | "connection"
  | "correlation"
  | "generation"
  | "parent-epoch"
  | "revision"
  | "sequence";

export type OrpcSessionErrorKind =
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

export class OrpcSessionError extends Error {
  readonly kind: OrpcSessionErrorKind;
  readonly staleReason: OrpcStaleReason | undefined;

  constructor(kind: OrpcSessionErrorKind, staleReason?: OrpcStaleReason) {
    super(kind);
    this.name = "OrpcSessionError";
    this.kind = kind;
    this.staleReason = staleReason;
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

export interface OrpcSessionOptions {
  readonly authToken: string;
  readonly clientName: OrpcClientName;
  readonly clientVersion: string;
  readonly maxDeadlineMs?: number;
  readonly maxMessageBytes?: number;
  readonly protocolVersion?: typeof ORPC_PROTOCOL_VERSION;
  readonly scheduler?: DeadlineScheduler;
  readonly transcript?: BoundedTranscript;
}

export interface OrpcConnectOptions {
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface OrpcInvokeOptions {
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

export interface OrpcWatchOptions {
  readonly deadlineMs?: number;
  readonly signal?: AbortSignal;
}

interface PendingCall {
  readonly callerSignal: AbortSignal | undefined;
  readonly connectionEpoch: number;
  readonly controller: AbortController;
  readonly correlationId: string;
  deadlineHandle: unknown;
  readonly operation: OrpcTranscriptOperation;
  reject: (error: OrpcSessionError) => void;
  readonly transport: OrpcTransportKind;
  readonly expectedGeneration: number;
  readonly expectedParentEpoch: number;
  readonly expectedRevision: number;
  settled: boolean;
}

interface ActiveEventStream {
  invalidate(error: OrpcSessionError): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function errorCode(error: unknown): string | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function errorStatus(error: unknown): number | undefined {
  if (!isRecord(error)) return undefined;
  return typeof error.status === "number" ? error.status : undefined;
}

function operationName(operation: OrpcOperation): OrpcTranscriptOperation {
  return `application.invoke.${operation}` as OrpcTranscriptOperation;
}

function isIterator(value: unknown): value is AsyncIterator<unknown> {
  return isRecord(value) && typeof value.next === "function";
}

function eventValue(value: unknown): value is OrpcEventValue {
  return (
    isRecord(value) &&
    typeof value.correlationId === "string" &&
    isPositiveInteger(value.parentEpoch) &&
    isPositiveInteger(value.revision) &&
    isPositiveInteger(value.sequence) &&
    isPositiveInteger(value.sessionGeneration) &&
    (value.value === "ready" || value.value === "changed")
  );
}

function eventReturn(value: unknown): value is OrpcEventReturn {
  return (
    isRecord(value) &&
    typeof value.correlationId === "string" &&
    isPositiveInteger(value.parentEpoch) &&
    isPositiveInteger(value.revision) &&
    isPositiveInteger(value.sessionGeneration) &&
    value.value === "closed"
  );
}

function eventStaleReason(
  value: Pick<OrpcEventValue, "correlationId" | "parentEpoch" | "revision" | "sessionGeneration">,
  expected: Pick<
    OrpcEventValue,
    "correlationId" | "parentEpoch" | "revision" | "sessionGeneration"
  >,
): OrpcStaleReason {
  if (value.correlationId !== expected.correlationId) return "correlation";
  if (value.sessionGeneration !== expected.sessionGeneration) return "generation";
  if (value.parentEpoch !== expected.parentEpoch) return "parent-epoch";
  if (value.revision !== expected.revision) return "revision";
  return "correlation";
}

function resultForError(error: OrpcSessionError): OrpcTranscriptResult {
  switch (error.kind) {
    case "cancelled":
      return "cancelled";
    case "deadline-exceeded":
      return "deadline-exceeded";
    case "disconnected":
      return "disconnected";
    case "message-too-large":
      return "oversized";
    case "stale-response":
    case "version-mismatch":
      return "stale";
    case "disposed":
      return "cleaned-up";
    default:
      return "rejected";
  }
}

function isSessionErrorKind(value: unknown): value is OrpcSessionErrorKind {
  return (
    value === "already-connected" ||
    value === "cancelled" ||
    value === "deadline-exceeded" ||
    value === "disconnected" ||
    value === "disposed" ||
    value === "message-too-large" ||
    value === "not-connected" ||
    value === "protocol" ||
    value === "stale-response" ||
    value === "unauthorized" ||
    value === "version-mismatch"
  );
}

function validateBoundedInteger(value: unknown, minimum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum;
}

export class OrpcSessionAuthority {
  readonly #options: {
    readonly authToken: string;
    readonly clientName: OrpcClientName;
    readonly clientVersion: string;
    readonly maxDeadlineMs: number;
    readonly maxMessageBytes: number;
    readonly protocolVersion: typeof ORPC_PROTOCOL_VERSION;
  };
  readonly #scheduler: DeadlineScheduler;
  readonly #pending = new Map<string, PendingCall>();
  readonly #streams = new Set<ActiveEventStream>();
  #transcript: BoundedTranscript | undefined;
  #channel: OrpcChannel | undefined;
  #channelCloseListener: ChannelEventListener | undefined;
  #client: OrpcContractClient | undefined;
  #transportKind: OrpcTransportKind | undefined;
  #state: OrpcSessionState = "disconnected";
  #connectionEpoch = 0;
  #sessionGeneration = 0;
  #parentEpoch = 0;
  #revision = 0;
  #negotiatedDeadlineMs: number;
  #nextCorrelationId = 1;
  #closing = false;

  constructor(options: OrpcSessionOptions) {
    if (options.authToken.length === 0 || options.clientVersion.length === 0) {
      throw new TypeError("oRPC session identity must be non-empty");
    }
    const maxDeadlineMs = options.maxDeadlineMs ?? 1_000;
    const maxMessageBytes = options.maxMessageBytes ?? 16 * 1024;
    if (!validateBoundedInteger(maxDeadlineMs, 1)) {
      throw new RangeError("maxDeadlineMs must be a positive safe integer");
    }
    if (!validateBoundedInteger(maxMessageBytes, 128) || maxMessageBytes > 1024 * 1024) {
      throw new RangeError("maxMessageBytes is outside the bounded transport policy");
    }
    this.#options = {
      authToken: options.authToken,
      clientName: options.clientName,
      clientVersion: options.clientVersion,
      maxDeadlineMs,
      maxMessageBytes,
      protocolVersion: options.protocolVersion ?? ORPC_PROTOCOL_VERSION,
    };
    this.#negotiatedDeadlineMs = maxDeadlineMs;
    this.#scheduler = options.scheduler ?? systemDeadlineScheduler;
    this.#transcript = options.transcript;
  }

  get state(): OrpcSessionState {
    return this.#state;
  }

  get sessionGeneration(): number {
    return this.#sessionGeneration;
  }

  get parentEpoch(): number {
    return this.#parentEpoch;
  }

  get revision(): number {
    return this.#revision;
  }

  get connectionEpoch(): number {
    return this.#connectionEpoch;
  }

  get transcript(): readonly import("./transcript.js").OrpcTranscriptEvent[] {
    return this.#transcript?.snapshot() ?? [];
  }

  async connect(
    channel: OrpcChannel,
    options: OrpcConnectOptions = {},
  ): Promise<OrpcHandshakeOutput> {
    if (this.#state === "disposed") throw new OrpcSessionError("disposed");
    if (this.#state !== "disconnected") {
      throw new OrpcSessionError("already-connected");
    }
    const deadlineMs = this.#validateDeadline(
      options.deadlineMs ?? Math.min(500, this.#options.maxDeadlineMs),
      this.#options.maxDeadlineMs,
    );
    this.#ensureTranscript();
    const connectionEpoch = ++this.#connectionEpoch;
    const correlationId = this.#nextCorrelation();
    this.#attachChannel(channel, connectionEpoch);
    this.#state = "connecting";
    this.#record({
      connectionEpoch,
      correlationId,
      effect: "invocation",
      operation: "transport.connect",
      parentEpoch: this.#parentEpoch,
      revision: this.#revision,
      result: "accepted",
      sessionGeneration: this.#sessionGeneration,
      transport: channel.kind,
    });
    this.#state = "authenticating";
    try {
      const output = await this.#startCall<OrpcHandshakeOutput>({
        call: (signal) =>
          this.#client!.session.handshake(
            {
              authToken: this.#options.authToken,
              clientName: this.#options.clientName,
              clientVersion: this.#options.clientVersion,
              protocolVersion: this.#options.protocolVersion,
              requestedDeadlineMs: this.#options.maxDeadlineMs,
              requestedMaxMessageBytes: this.#options.maxMessageBytes,
            },
            { context: {}, signal },
          ),
        connectionEpoch,
        correlationId,
        deadlineMs,
        expectedGeneration: this.#sessionGeneration,
        expectedParentEpoch: this.#parentEpoch,
        expectedRevision: this.#revision,
        operation: "session.handshake",
        signal: options.signal,
        transport: channel.kind,
        validate: (value) => this.#validateHandshake(value),
        accept: (value) => {
          if (!this.#isAttached(channel, connectionEpoch)) {
            throw new OrpcSessionError("stale-response", "connection");
          }
          this.#state = "connected-stale";
          channel.setMaxMessageBytes(value.maxMessageBytes);
          this.#negotiatedDeadlineMs = Math.min(this.#options.maxDeadlineMs, value.maxDeadlineMs);
          this.#sessionGeneration = value.sessionGeneration;
          this.#parentEpoch = value.parentEpoch;
          this.#revision = value.revision;
          this.#state = "connected-current";
        },
      });
      this.#record({
        connectionEpoch,
        correlationId,
        effect: "result",
        operation: "transport.connect",
        parentEpoch: this.#parentEpoch,
        revision: this.#revision,
        result: "accepted",
        sessionGeneration: this.#sessionGeneration,
        transport: channel.kind,
      });
      return output;
    } catch (error) {
      const mapped = this.#mapError(error, options.signal, connectionEpoch);
      if (this.#isAttached(channel, connectionEpoch)) {
        this.#retireConnection(mapped, resultForError(mapped));
      }
      throw mapped;
    }
  }

  async reconnect(
    channel: OrpcChannel,
    options: OrpcConnectOptions = {},
  ): Promise<OrpcHandshakeOutput> {
    if (this.#state === "disposed") throw new OrpcSessionError("disposed");
    const previousConnectionEpoch = this.#connectionEpoch;
    const correlationId = this.#peekCorrelation();
    this.#record({
      connectionEpoch: previousConnectionEpoch,
      correlationId,
      effect: "invocation",
      operation: "transport.reconnect",
      parentEpoch: this.#parentEpoch,
      revision: this.#revision,
      result: "accepted",
      sessionGeneration: this.#sessionGeneration,
      transport: channel.kind,
    });
    if (this.#state !== "disconnected") {
      this.#retireConnection(new OrpcSessionError("disconnected"), "disconnected");
    }
    try {
      const output = await this.connect(channel, options);
      this.#record({
        connectionEpoch: this.#connectionEpoch,
        correlationId,
        effect: "result",
        operation: "transport.reconnect",
        parentEpoch: this.#parentEpoch,
        revision: this.#revision,
        result: "reconnected",
        sessionGeneration: this.#sessionGeneration,
        transport: channel.kind,
      });
      return output;
    } catch (error) {
      const mapped = this.#mapError(error, options.signal, this.#connectionEpoch);
      this.#record({
        connectionEpoch: this.#connectionEpoch,
        correlationId,
        effect: "result",
        operation: "transport.reconnect",
        parentEpoch: this.#parentEpoch,
        revision: this.#revision,
        result: resultForError(mapped),
        sessionGeneration: this.#sessionGeneration,
        transport: channel.kind,
      });
      throw mapped;
    }
  }

  async invoke(
    operation: OrpcOperation,
    options: OrpcInvokeOptions = {},
  ): Promise<OrpcInvokeOutput> {
    this.#assertCurrent();
    const connectionEpoch = this.#connectionEpoch;
    const channel = this.#channel!;
    const generation = this.#sessionGeneration;
    const parentEpoch = this.#parentEpoch;
    const revision = this.#revision;
    const correlationId = this.#nextCorrelation();
    const deadlineMs = this.#deadline(options.deadlineMs);
    return this.#startCall({
      call: (signal) =>
        this.#client!.application.invoke(
          {
            correlationId,
            deadlineMs,
            operation,
            parentEpoch,
            revision,
            sessionGeneration: generation,
          },
          { context: {}, signal },
        ),
      connectionEpoch,
      correlationId,
      deadlineMs,
      expectedGeneration: generation,
      expectedParentEpoch: parentEpoch,
      expectedRevision: revision,
      operation: operationName(operation),
      signal: options.signal,
      transport: channel.kind,
      validate: (value) => {
        if (
          value.correlationId !== correlationId ||
          value.operation !== operation ||
          value.parentEpoch !== parentEpoch ||
          value.revision !== revision ||
          value.sessionGeneration !== generation
        ) {
          throw new OrpcSessionError(
            "stale-response",
            this.#staleReason(value, {
              correlationId,
              operation,
              parentEpoch,
              revision,
              sessionGeneration: generation,
            }),
          );
        }
        if (value.value !== "accepted") {
          throw new OrpcSessionError("protocol");
        }
      },
    });
  }

  async watchEvents(
    options: OrpcWatchOptions = {},
  ): Promise<AsyncIterableIterator<OrpcEventValue>> {
    this.#assertCurrent();
    const connectionEpoch = this.#connectionEpoch;
    const channel = this.#channel!;
    const generation = this.#sessionGeneration;
    const parentEpoch = this.#parentEpoch;
    const revision = this.#revision;
    const correlationId = this.#nextCorrelation();
    const iterator = await this.#startCall<AsyncIterator<unknown>>({
      call: (signal) =>
        this.#client!.application.events.watch(
          { correlationId, parentEpoch, revision, sessionGeneration: generation },
          { context: {}, signal },
        ),
      connectionEpoch,
      correlationId,
      deadlineMs: this.#deadline(options.deadlineMs),
      expectedGeneration: generation,
      expectedParentEpoch: parentEpoch,
      expectedRevision: revision,
      operation: "application.events.watch",
      signal: options.signal,
      transport: channel.kind,
      validate: (value) => {
        if (!isIterator(value)) throw new OrpcSessionError("protocol");
      },
    });

    if (!this.#isAttached(channel, connectionEpoch) || this.#state !== "connected-current") {
      try {
        await iterator.return?.();
      } catch {
        // The old iterator is no longer authoritative; its cleanup is best effort.
      }
      throw new OrpcSessionError("stale-response", "connection");
    }

    let active = true;
    let terminal: OrpcSessionError | undefined;
    let terminalRecorded = false;
    let pendingResolve: ((result: IteratorResult<OrpcEventValue>) => void) | undefined;
    let pendingReject: ((error: OrpcSessionError) => void) | undefined;
    let cleanupPromise: Promise<void> | undefined;
    let lastSequence = 0;
    let stream: ActiveEventStream;

    const recordTerminal = (error?: OrpcSessionError): void => {
      if (terminalRecorded) return;
      terminalRecorded = true;
      this.#record({
        connectionEpoch,
        correlationId,
        effect: "result",
        operation: "application.events.watch",
        parentEpoch,
        revision,
        result: error ? resultForError(error) : "accepted",
        sessionGeneration: generation,
        transport: channel.kind,
      });
    };

    const finish = (): Promise<void> => {
      if (cleanupPromise) return cleanupPromise;
      active = false;
      const resolvePending = pendingResolve;
      pendingResolve = undefined;
      pendingReject = undefined;
      options.signal?.removeEventListener("abort", onAbort);
      this.#streams.delete(stream);
      try {
        // The peer may be waiting on the same event turn. Start the official
        // iterator cleanup without making local cancellation depend on a
        // remote acknowledgement that can no longer arrive.
        void Promise.resolve(iterator.return?.()).catch(() => undefined);
      } catch {
        // Cleanup remains recorded even when the peer is already closed.
      }
      this.#record({
        connectionEpoch,
        correlationId,
        effect: "cleanup",
        operation: "application.events.watch",
        parentEpoch,
        revision,
        result: "cleaned-up",
        sessionGeneration: generation,
        transport: channel.kind,
      });
      cleanupPromise = Promise.resolve();
      resolvePending?.({ done: true, value: undefined } as IteratorResult<OrpcEventValue>);
      return cleanupPromise;
    };

    const invalidate = (error: OrpcSessionError): void => {
      if (!active) return;
      terminal = error;
      recordTerminal(error);
      active = false;
      pendingResolve = undefined;
      const reject = pendingReject;
      pendingReject = undefined;
      reject?.(error);
      void finish();
    };

    const onAbort = (): void => invalidate(new OrpcSessionError("cancelled"));
    stream = { invalidate };
    this.#streams.add(stream);
    options.signal?.addEventListener("abort", onAbort, { once: true });

    const recordEvent = this.#record.bind(this);
    const mapError = this.#mapError.bind(this);
    const wrapped: AsyncIterableIterator<OrpcEventValue> = {
      [Symbol.asyncIterator]() {
        return wrapped;
      },
      async next(): Promise<IteratorResult<OrpcEventValue>> {
        if (!active) {
          if (terminal) throw terminal;
          return { done: true, value: undefined } as IteratorResult<OrpcEventValue>;
        }
        if (pendingReject) {
          return Promise.reject(new OrpcSessionError("protocol"));
        }
        return new Promise<IteratorResult<OrpcEventValue>>((resolve, reject) => {
          pendingResolve = resolve;
          pendingReject = reject;
          const rejectNext = async (error: OrpcSessionError): Promise<void> => {
            if (!pendingReject) return undefined;
            pendingReject = undefined;
            pendingResolve = undefined;
            terminal = error;
            recordTerminal(error);
            await finish();
            reject(error);
          };
          Promise.resolve(iterator.next())
            .then(async (result) => {
              if (!pendingReject) return undefined;
              if (!active) return undefined;
              if (result.done) {
                if (
                  !eventReturn(result.value) ||
                  result.value.correlationId !== correlationId ||
                  result.value.parentEpoch !== parentEpoch ||
                  result.value.revision !== revision ||
                  result.value.sessionGeneration !== generation
                ) {
                  await rejectNext(
                    new OrpcSessionError(
                      "stale-response",
                      eventReturn(result.value)
                        ? eventStaleReason(result.value, {
                            correlationId,
                            parentEpoch,
                            revision,
                            sessionGeneration: generation,
                          })
                        : "correlation",
                    ),
                  );
                  return undefined;
                }
                pendingReject = undefined;
                pendingResolve = undefined;
                recordTerminal();
                await finish();
                resolve({ done: true, value: undefined } as IteratorResult<OrpcEventValue>);
                return undefined;
              }
              if (
                !eventValue(result.value) ||
                result.value.correlationId !== correlationId ||
                result.value.parentEpoch !== parentEpoch ||
                result.value.revision !== revision ||
                result.value.sessionGeneration !== generation
              ) {
                await rejectNext(
                  new OrpcSessionError(
                    "stale-response",
                    eventValue(result.value)
                      ? eventStaleReason(result.value, {
                          correlationId,
                          parentEpoch,
                          revision,
                          sessionGeneration: generation,
                        })
                      : "correlation",
                  ),
                );
                return undefined;
              }
              if (result.value.sequence <= lastSequence) {
                await rejectNext(new OrpcSessionError("stale-response", "sequence"));
                return undefined;
              }
              pendingReject = undefined;
              pendingResolve = undefined;
              lastSequence = result.value.sequence;
              recordEvent({
                connectionEpoch,
                correlationId,
                effect: "event",
                operation: "application.events.watch",
                parentEpoch,
                revision,
                result: "accepted",
                sequence: result.value.sequence,
                sessionGeneration: generation,
                transport: channel.kind,
              });
              resolve({ done: false, value: result.value });
              return undefined;
            })
            .catch(async (error: unknown) => {
              if (!pendingReject) return undefined;
              if (!active) return undefined;
              await rejectNext(mapError(error, options.signal, connectionEpoch));
              return undefined;
            });
        });
      },
      async return(): Promise<IteratorResult<OrpcEventValue>> {
        await finish();
        return { done: true, value: undefined } as IteratorResult<OrpcEventValue>;
      },
    };
    return wrapped;
  }

  disconnect(): void {
    if (this.#state === "disposed") return;
    if (this.#state === "disconnected") return;
    this.#retireConnection(new OrpcSessionError("disconnected"), "disconnected");
  }

  dispose(): void {
    if (this.#state === "disposed") return;
    if (this.#state !== "disconnected") {
      this.#retireConnection(new OrpcSessionError("disposed"), "cleaned-up");
    } else {
      this.#retireStreams(new OrpcSessionError("disposed"));
    }
    this.#state = "disposed";
  }

  #ensureTranscript(): void {
    this.#transcript ??= new BoundedTranscript();
  }

  #attachChannel(channel: OrpcChannel, connectionEpoch: number): void {
    this.#channel = channel;
    this.#transportKind = channel.kind;
    this.#channelCloseListener = () => this.#handleChannelClose(channel, connectionEpoch);
    channel.setOversizeHandler(() => this.#handleOversized(channel, connectionEpoch));
    channel.addEventListener("close", this.#channelCloseListener);
    this.#client = this.#createClient(channel);
  }

  #createClient(channel: OrpcChannel): OrpcContractClient {
    if (channel.kind === "websocket") {
      const link = new WebSocketRPCLink({ websocket: channel as never });
      return createORPCClient<OrpcContractClient>(link);
    }
    const link = new MessagePortRPCLink({ port: channel as never });
    return createORPCClient<OrpcContractClient>(link);
  }

  #startCall<T>(options: {
    readonly accept?: (value: T) => void;
    readonly call: (signal: AbortSignal) => Promise<T>;
    readonly connectionEpoch: number;
    readonly correlationId: string;
    readonly deadlineMs: number;
    readonly expectedGeneration: number;
    readonly expectedParentEpoch: number;
    readonly expectedRevision: number;
    readonly operation: OrpcTranscriptOperation;
    readonly signal: AbortSignal | undefined;
    readonly transport: OrpcTransportKind;
    readonly validate: (value: T) => void;
  }): Promise<T> {
    this.#record({
      connectionEpoch: options.connectionEpoch,
      correlationId: options.correlationId,
      effect: "invocation",
      operation: options.operation,
      parentEpoch: options.expectedParentEpoch,
      revision: options.expectedRevision,
      result: "accepted",
      sessionGeneration: options.expectedGeneration,
      transport: options.transport,
    });
    if (options.signal?.aborted) {
      const error = new OrpcSessionError("cancelled");
      this.#recordResult(options, error);
      return Promise.reject(error);
    }
    return new Promise<T>((resolve, reject) => {
      const controller = new AbortController();
      let deadlineHandle: unknown;
      let removeAbortListener: (() => void) | undefined;
      const pending: PendingCall = {
        callerSignal: options.signal,
        connectionEpoch: options.connectionEpoch,
        controller,
        correlationId: options.correlationId,
        deadlineHandle,
        operation: options.operation,
        reject: (error) => finishError(error),
        transport: options.transport,
        expectedGeneration: options.expectedGeneration,
        expectedParentEpoch: options.expectedParentEpoch,
        expectedRevision: options.expectedRevision,
        settled: false,
      };
      const cleanup = (): void => {
        this.#scheduler.cancel(deadlineHandle);
        removeAbortListener?.();
        this.#pending.delete(options.correlationId);
      };
      const finishError = (error: OrpcSessionError): void => {
        if (pending.settled) return;
        pending.settled = true;
        cleanup();
        controller.abort();
        this.#recordResult(options, error);
        reject(error);
      };
      const finishSuccess = (value: T): void => {
        if (pending.settled) return;
        try {
          options.accept?.(value);
          pending.settled = true;
          cleanup();
          this.#recordResult(options);
          resolve(value);
        } catch (error) {
          finishError(this.#mapError(error, options.signal, options.connectionEpoch));
        }
      };
      pending.reject = finishError;
      this.#pending.set(options.correlationId, pending);
      const onAbort = (): void => finishError(new OrpcSessionError("cancelled"));
      if (options.signal) {
        options.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => options.signal?.removeEventListener("abort", onAbort);
        if (options.signal.aborted) onAbort();
      }
      if (!pending.settled) {
        deadlineHandle = this.#scheduler.schedule(options.deadlineMs, () =>
          finishError(new OrpcSessionError("deadline-exceeded")),
        );
        pending.deadlineHandle = deadlineHandle;
      }
      Promise.resolve()
        .then(() => {
          if (pending.settled) return undefined;
          return options.call(controller.signal);
        })
        .then((value) => {
          if (pending.settled || value === undefined) return undefined;
          if (!this.#isAttached(this.#channel, options.connectionEpoch)) {
            finishError(new OrpcSessionError("stale-response", "connection"));
            return undefined;
          }
          try {
            options.validate(value);
            finishSuccess(value);
          } catch (error) {
            finishError(this.#mapError(error, options.signal, options.connectionEpoch));
          }
          return undefined;
        })
        .catch((error: unknown) => {
          if (pending.settled) return undefined;
          finishError(this.#mapError(error, options.signal, options.connectionEpoch));
          return undefined;
        });
    });
  }

  #recordResult(
    options: {
      readonly connectionEpoch: number;
      readonly correlationId: string;
      readonly expectedGeneration: number;
      readonly expectedParentEpoch: number;
      readonly expectedRevision: number;
      readonly operation: OrpcTranscriptOperation;
      readonly transport: OrpcTransportKind;
    },
    error?: OrpcSessionError,
  ): void {
    const sessionGeneration =
      !error && options.operation === "session.handshake"
        ? this.#sessionGeneration
        : options.expectedGeneration;
    const parentEpoch =
      !error && options.operation === "session.handshake"
        ? this.#parentEpoch
        : options.expectedParentEpoch;
    const revision =
      !error && options.operation === "session.handshake"
        ? this.#revision
        : options.expectedRevision;
    this.#record({
      connectionEpoch: options.connectionEpoch,
      correlationId: options.correlationId,
      effect: "result",
      operation: options.operation,
      parentEpoch,
      revision,
      result: error ? resultForError(error) : "accepted",
      sessionGeneration,
      transport: options.transport,
    });
  }

  #validateHandshake(value: OrpcHandshakeOutput): void {
    if (
      value.contractVersion !== ORPC_CONTRACT_VERSION ||
      value.protocolVersion !== this.#options.protocolVersion
    ) {
      throw new OrpcSessionError("version-mismatch");
    }
    if (
      !isPositiveInteger(value.sessionGeneration) ||
      value.sessionGeneration <= this.#sessionGeneration
    ) {
      throw new OrpcSessionError("stale-response", "generation");
    }
    if (!isPositiveInteger(value.parentEpoch) || value.parentEpoch <= this.#parentEpoch) {
      throw new OrpcSessionError("stale-response", "parent-epoch");
    }
    if (!isPositiveInteger(value.revision)) {
      throw new OrpcSessionError("protocol");
    }
    if (value.revision <= this.#revision) {
      throw new OrpcSessionError("stale-response", "revision");
    }
    if (
      !validateBoundedInteger(value.maxMessageBytes, 128) ||
      value.maxMessageBytes > 1024 * 1024
    ) {
      throw new OrpcSessionError("protocol");
    }
    if (!validateBoundedInteger(value.maxDeadlineMs, 1)) {
      throw new OrpcSessionError("protocol");
    }
  }

  #validateDeadline(value: number, maximum: number): number {
    if (!validateBoundedInteger(value, 1) || value > maximum) {
      throw new OrpcSessionError("deadline-exceeded");
    }
    return value;
  }

  #deadline(value: number | undefined): number {
    const maximum =
      this.#state === "connected-current"
        ? this.#negotiatedDeadlineMs
        : this.#options.maxDeadlineMs;
    return this.#validateDeadline(value ?? Math.min(250, maximum), maximum);
  }

  #assertCurrent(): void {
    if (this.#state === "disposed") throw new OrpcSessionError("disposed");
    if (this.#state !== "connected-current" || !this.#client || !this.#channel) {
      throw new OrpcSessionError("not-connected");
    }
  }

  #isAttached(channel: OrpcChannel | undefined, connectionEpoch: number): boolean {
    return Boolean(
      channel && this.#channel === channel && this.#connectionEpoch === connectionEpoch,
    );
  }

  #nextCorrelation(): string {
    const value = `orpc-correlation-${String(this.#nextCorrelationId).padStart(4, "0")}`;
    this.#nextCorrelationId += 1;
    return value;
  }

  #peekCorrelation(): string {
    return `orpc-correlation-${String(Math.max(1, this.#nextCorrelationId - 1)).padStart(4, "0")}`;
  }

  #mapError(
    error: unknown,
    callerSignal: AbortSignal | undefined,
    connectionEpoch: number,
  ): OrpcSessionError {
    const typed = asSessionError(error);
    if (typed && isSessionErrorKind(typed.kind)) {
      return new OrpcSessionError(typed.kind, typed.staleReason);
    }
    if (callerSignal?.aborted) return new OrpcSessionError("cancelled");
    if (!this.#isAttached(this.#channel, connectionEpoch)) {
      return new OrpcSessionError("stale-response", "connection");
    }
    const code = errorCode(error);
    const status = errorStatus(error);
    if (code === "UNAUTHORIZED" || status === 401) return new OrpcSessionError("unauthorized");
    if (code === "CONFLICT" || status === 409) return new OrpcSessionError("version-mismatch");
    if (code === "PAYLOAD_TOO_LARGE" || status === 413) {
      return new OrpcSessionError("message-too-large");
    }
    if (code === "CLIENT_CLOSED_REQUEST" || status === 499) {
      return new OrpcSessionError("cancelled");
    }
    if (code === "TIMEOUT" || code === "GATEWAY_TIMEOUT" || status === 408 || status === 504) {
      return new OrpcSessionError("deadline-exceeded");
    }
    return new OrpcSessionError("protocol");
  }

  #staleReason(
    value: OrpcInvokeOutput,
    expected: {
      readonly correlationId: string;
      readonly operation: OrpcOperation;
      readonly parentEpoch: number;
      readonly revision: number;
      readonly sessionGeneration: number;
    },
  ): OrpcStaleReason {
    if (value.correlationId !== expected.correlationId) return "correlation";
    if (value.operation !== expected.operation) return "correlation";
    if (value.sessionGeneration !== expected.sessionGeneration) return "generation";
    if (value.parentEpoch !== expected.parentEpoch) return "parent-epoch";
    if (value.revision !== expected.revision) return "revision";
    return "correlation";
  }

  #handleOversized(channel: OrpcChannel, connectionEpoch: number): void {
    if (!this.#isAttached(channel, connectionEpoch)) return;
    this.#retireConnection(new OrpcSessionError("message-too-large"), "oversized");
  }

  #handleChannelClose(channel: OrpcChannel, connectionEpoch: number): void {
    if (this.#closing || !this.#isAttached(channel, connectionEpoch)) return;
    this.#retireConnection(new OrpcSessionError("disconnected"), "disconnected");
  }

  #retireConnection(error: OrpcSessionError, transportResult: OrpcTranscriptResult): void {
    const channel = this.#channel;
    const channelCloseListener = this.#channelCloseListener;
    const transport = this.#transportKind;
    const connectionEpoch = this.#connectionEpoch;
    if (!channel && this.#state === "disconnected") {
      this.#retireStreams(error);
      return;
    }
    this.#connectionEpoch += 1;
    this.#state = "disconnected";
    this.#channel = undefined;
    this.#client = undefined;
    this.#channelCloseListener = undefined;
    this.#transportKind = undefined;
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#retireStreams(error);
    if (channel && channelCloseListener) {
      channel.removeEventListener("close", channelCloseListener);
      channel.setOversizeHandler(undefined);
      this.#closing = true;
      try {
        // Closing an already-closed browser channel is idempotent and clears
        // the official oRPC adapter listeners retained by the wrapper.
        channel.close();
      } finally {
        this.#closing = false;
      }
    }
    if (transport) {
      this.#record({
        connectionEpoch,
        correlationId: this.#peekCorrelation(),
        effect: transportResult === "cleaned-up" ? "cleanup" : "result",
        operation: "transport.disconnect",
        parentEpoch: this.#parentEpoch,
        revision: this.#revision,
        result: transportResult,
        sessionGeneration: this.#sessionGeneration,
        transport,
      });
    }
  }

  #retireStreams(error: OrpcSessionError): void {
    for (const stream of this.#streams) stream.invalidate(error);
  }

  #record(event: {
    readonly connectionEpoch: number;
    readonly correlationId: string;
    readonly effect: OrpcTranscriptEffect;
    readonly operation: OrpcTranscriptOperation;
    readonly parentEpoch: number;
    readonly revision: number;
    readonly result: OrpcTranscriptResult;
    readonly sequence?: number;
    readonly sessionGeneration: number;
    readonly transport: OrpcTransportKind;
  }): void {
    this.#transcript?.record(event);
  }
}
