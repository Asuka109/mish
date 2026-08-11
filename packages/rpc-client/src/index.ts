import * as z from "zod";

const JsonRpcResponseIdSchema = z.union([
  z.number().int().refine(Number.isSafeInteger, "JSON-RPC response IDs must be safe integers"),
  z.string(),
]);
const JsonRpcErrorObjectSchema = z
  .object({ code: z.number().int(), data: z.unknown().optional(), message: z.string() })
  .strict();
const JsonRpcResponseMessageSchema = z.union([
  z
    .object({ id: JsonRpcResponseIdSchema, jsonrpc: z.literal("2.0"), result: z.unknown() })
    .strict(),
  z
    .object({
      error: JsonRpcErrorObjectSchema,
      id: JsonRpcResponseIdSchema,
      jsonrpc: z.literal("2.0"),
    })
    .strict(),
]);
const JsonRpcNotificationMessageSchema = z
  .object({ jsonrpc: z.literal("2.0"), method: z.string(), params: z.unknown().optional() })
  .strict();
const JsonRpcMessageSchema = z.union([
  JsonRpcResponseMessageSchema,
  JsonRpcNotificationMessageSchema,
]);
const AuthenticationMetadataSchema = z
  .object({
    clientName: z.string().min(1),
    clientVersion: z.string().min(1),
    token: z.string().min(1),
  })
  .strict();
const AuthenticationResultSchema = z
  .object({
    authenticated: z.literal(true),
    expiresAt: z.string().optional(),
    sessionId: z.string().min(1),
  })
  .strict();

const textEncoder = new TextEncoder();

export const DEFAULT_RPC_REQUEST_DEADLINE_MILLISECONDS = 30_000;
export const MAX_RPC_REQUEST_DEADLINE_MILLISECONDS = 120_000;

let nextClientIdentity = 1;

export type RpcRequestId = string;
export type RpcRequestIdFactory = (sequence: number) => RpcRequestId;

function createDefaultRequestIdFactory(): RpcRequestIdFactory {
  const identity =
    typeof globalThis.crypto?.randomUUID === "function"
      ? globalThis.crypto.randomUUID()
      : `${Date.now().toString(36)}-${nextClientIdentity++}`;
  return (sequence) => `mish-rpc-${identity}-${sequence}`;
}

function validateRequestDeadline(deadline: number | undefined) {
  const value = deadline ?? DEFAULT_RPC_REQUEST_DEADLINE_MILLISECONDS;
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_RPC_REQUEST_DEADLINE_MILLISECONDS) {
    throw new RangeError(
      `RPC request deadline must be an integer between 0 and ${MAX_RPC_REQUEST_DEADLINE_MILLISECONDS} milliseconds`,
    );
  }
  return value;
}

export interface WebSocketLikeEventMap {
  close: { code: number; reason: string; wasClean: boolean };
  error: { error?: unknown; message?: string };
  message: { data: unknown };
  open: object;
}

export interface WebSocketLike {
  readonly readyState: number;
  addEventListener<Type extends keyof WebSocketLikeEventMap>(
    type: Type,
    listener: (event: WebSocketLikeEventMap[Type]) => void,
  ): void;
  close(code?: number, reason?: string): void;
  removeEventListener<Type extends keyof WebSocketLikeEventMap>(
    type: Type,
    listener: (event: WebSocketLikeEventMap[Type]) => void,
  ): void;
  send(data: string): void;
}

export interface RpcMethodDefinition {
  params: z.ZodType;
  result: z.ZodType;
}

export type RpcMethodDefinitions = Record<string, RpcMethodDefinition>;

export type RpcConnectionPhase =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "negotiating"
  | "connected"
  | "client-too-old"
  | "backend-too-old"
  | "reconnecting"
  | "disposed";

export type RpcCompatibilityOutcome = "compatible" | "client-too-old" | "backend-too-old";

export interface RpcConnectionState {
  attempt: number;
  phase: RpcConnectionPhase;
  stale: boolean;
}

export interface RpcAuthenticationMetadata {
  clientName: string;
  clientVersion: string;
  token: string;
}

export interface RpcClientOptions<Methods extends RpcMethodDefinitions> {
  authentication: () => Promise<RpcAuthenticationMetadata> | RpcAuthenticationMetadata;
  authenticationMethod?: string;
  backoff?: {
    factor?: number;
    initialDelayMilliseconds?: number;
    maximumDelayMilliseconds?: number;
    maximumReconnectAttempts?: number;
  };
  compatibility?: RpcCompatibilityPolicy;
  maxMessageBytes?: number;
  methods: Methods;
  onProtocolError?: (error: RpcProtocolError) => void;
  requestDeadlineMilliseconds?: number;
  requestIdFactory?: RpcRequestIdFactory;
  transportFactory: () => WebSocketLike;
}

export interface RpcCompatibilityPolicy {
  method: string;
  params: unknown;
  resultSchema: z.ZodType;
  outcome(result: unknown): RpcCompatibilityOutcome;
}

export interface RpcRequestOptions {
  signal?: AbortSignal;
}

interface PendingRequest {
  abortCleanup?: () => void;
  method: string;
  reject(error: unknown): void;
  resolve(value: unknown): void;
  resultSchema: z.ZodType;
  timeoutCleanup?: () => void;
}

interface ConnectionWaiter {
  abortCleanup?: () => void;
  deadlineCleanup?: () => void;
  reject(error: unknown): void;
  resolve(): void;
}

interface NotificationSubscription {
  listeners: Set<(params: unknown) => void>;
  schema: z.ZodType;
}

interface TransportListeners {
  close: (event: WebSocketLikeEventMap["close"]) => void;
  error: (event: WebSocketLikeEventMap["error"]) => void;
  message: (event: WebSocketLikeEventMap["message"]) => void;
  open: (event: WebSocketLikeEventMap["open"]) => void;
}

export class RpcClientError extends Error {}

export class RpcCancelledError extends RpcClientError {
  constructor(message = "The RPC request was cancelled") {
    super(message);
    this.name = "RpcCancelledError";
  }
}

export class RpcTimeoutError extends RpcClientError {
  constructor(
    readonly deadlineMilliseconds: number,
    readonly requestId: RpcRequestId | null = null,
  ) {
    super(
      requestId
        ? `RPC request ${requestId} exceeded the ${deadlineMilliseconds} millisecond deadline`
        : `RPC connection exceeded the ${deadlineMilliseconds} millisecond deadline`,
    );
    this.name = "RpcTimeoutError";
  }
}

export class RpcRequestIdCollisionError extends RpcClientError {
  constructor(readonly requestId: RpcRequestId) {
    super(`RPC request ID collision for ${requestId}`);
    this.name = "RpcRequestIdCollisionError";
  }
}

export class RpcDisposedError extends RpcClientError {
  constructor() {
    super("The RPC client has been disposed");
    this.name = "RpcDisposedError";
  }
}

export class RpcDisconnectedError extends RpcClientError {
  constructor(message = "The RPC transport is disconnected") {
    super(message);
    this.name = "RpcDisconnectedError";
  }
}

export class RpcCompatibilityError extends RpcClientError {
  constructor(
    readonly outcome: Exclude<RpcCompatibilityOutcome, "compatible">,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RpcCompatibilityError";
  }
}

export class RpcMessageTooLargeError extends RpcClientError {
  constructor(
    readonly size: number,
    readonly maximumSize: number,
  ) {
    super(`RPC message size ${size} exceeds the ${maximumSize} byte limit`);
    this.name = "RpcMessageTooLargeError";
  }
}

export class RpcProtocolError extends RpcClientError {
  constructor(
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = "RpcProtocolError";
  }
}

export class RpcRemoteError extends RpcClientError {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "RpcRemoteError";
  }
}

export class RpcValidationError extends RpcClientError {
  constructor(
    message: string,
    readonly cause: unknown,
  ) {
    super(message);
    this.name = "RpcValidationError";
  }
}

type ParamsFor<Methods extends RpcMethodDefinitions, Method extends keyof Methods> = z.input<
  Methods[Method]["params"]
>;
type ResultFor<Methods extends RpcMethodDefinitions, Method extends keyof Methods> = z.output<
  Methods[Method]["result"]
>;

export class RpcClient<Methods extends RpcMethodDefinitions> {
  private readonly authentication: RpcClientOptions<Methods>["authentication"];
  private readonly authenticationMethod: string;
  private readonly backoffFactor: number;
  private readonly compatibility?: RpcCompatibilityPolicy;
  private readonly initialDelayMilliseconds: number;
  private readonly maximumDelayMilliseconds: number;
  private readonly maximumReconnectAttempts: number;
  private readonly maxMessageBytes: number;
  private readonly methods: Methods;
  private readonly onProtocolError?: (error: RpcProtocolError) => void;
  private readonly requestDeadlineMilliseconds: number;
  private readonly requestIdFactory: RpcRequestIdFactory;
  private readonly issuedRequestIds: Set<RpcRequestId> | null;
  private readonly transportFactory: () => WebSocketLike;
  private readonly connectionListeners = new Set<(state: RpcConnectionState) => void>();
  private readonly connectionWaiters = new Set<ConnectionWaiter>();
  private readonly notifications = new Map<string, NotificationSubscription>();
  private readonly pendingRequests = new Map<RpcRequestId, PendingRequest>();
  private state: RpcConnectionState = { attempt: 0, phase: "disconnected", stale: true };
  private desiredConnection = false;
  private compatibilityError: RpcCompatibilityError | null = null;
  private disposed = false;
  private nextRequestSequence = 1;
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectionAttemptTimer: ReturnType<typeof setTimeout> | null = null;
  private transport: WebSocketLike | null = null;
  private transportListeners: TransportListeners | null = null;

  constructor(options: RpcClientOptions<Methods>) {
    this.authentication = options.authentication;
    this.authenticationMethod = options.authenticationMethod ?? "rpc.authenticate";
    this.backoffFactor = options.backoff?.factor ?? 2;
    this.compatibility = options.compatibility;
    this.initialDelayMilliseconds = options.backoff?.initialDelayMilliseconds ?? 250;
    this.maximumDelayMilliseconds = options.backoff?.maximumDelayMilliseconds ?? 5_000;
    this.maximumReconnectAttempts = options.backoff?.maximumReconnectAttempts ?? 5;
    this.maxMessageBytes = options.maxMessageBytes ?? 1_048_576;
    this.methods = options.methods;
    this.onProtocolError = options.onProtocolError;
    this.requestDeadlineMilliseconds = validateRequestDeadline(options.requestDeadlineMilliseconds);
    this.requestIdFactory = options.requestIdFactory ?? createDefaultRequestIdFactory();
    this.issuedRequestIds = options.requestIdFactory ? new Set() : null;
    this.transportFactory = options.transportFactory;
  }

  connect(options: RpcRequestOptions = {}) {
    if (this.disposed) return Promise.reject(new RpcDisposedError());
    if (options.signal?.aborted) return Promise.reject(new RpcCancelledError());
    if (this.compatibilityError) return Promise.reject(this.compatibilityError);
    if (this.state.phase === "connected") return Promise.resolve();

    this.desiredConnection = true;
    const promise = new Promise<void>((resolve, reject) => {
      const waiter: ConnectionWaiter = { reject, resolve };
      const deadlineTimer = setTimeout(() => {
        if (!this.connectionWaiters.delete(waiter)) return;
        waiter.abortCleanup?.();
        reject(new RpcTimeoutError(this.requestDeadlineMilliseconds));
      }, this.requestDeadlineMilliseconds);
      waiter.deadlineCleanup = () => clearTimeout(deadlineTimer);
      if (options.signal) {
        const onAbort = () => {
          if (!this.connectionWaiters.delete(waiter)) return;
          waiter.deadlineCleanup?.();
          reject(new RpcCancelledError());
        };
        options.signal.addEventListener("abort", onAbort, { once: true });
        waiter.abortCleanup = () => options.signal?.removeEventListener("abort", onAbort);
      }
      this.connectionWaiters.add(waiter);
    });

    if (!this.transport && !this.reconnectTimer) this.openTransport(false);
    return promise;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.desiredConnection = false;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    if (this.connectionAttemptTimer) clearTimeout(this.connectionAttemptTimer);
    this.connectionAttemptTimer = null;
    const error = new RpcDisposedError();
    this.rejectPendingRequests(error);
    this.rejectConnectionWaiters(error);
    this.updateState({ attempt: 0, phase: "disposed", stale: true });
    const transport = this.transport;
    this.transport = null;
    if (transport) transport.close(1000, "Client disposed");
    this.detachTransportListeners(transport);
    this.connectionListeners.clear();
    this.notifications.clear();
  }

  getConnectionState() {
    return { ...this.state };
  }

  onNotification<Schema extends z.ZodType>(
    method: string,
    schema: Schema,
    listener: (params: z.output<Schema>) => void,
  ) {
    let subscription = this.notifications.get(method);
    if (!subscription) {
      subscription = { listeners: new Set(), schema };
      this.notifications.set(method, subscription);
    }
    subscription.listeners.add(listener as (params: unknown) => void);

    return () => {
      subscription?.listeners.delete(listener as (params: unknown) => void);
      if (subscription?.listeners.size === 0) this.notifications.delete(method);
    };
  }

  async request<Method extends keyof Methods & string>(
    method: Method,
    params: ParamsFor<Methods, Method>,
    options: RpcRequestOptions = {},
  ): Promise<ResultFor<Methods, Method>> {
    const definition = this.methods[method];
    const parsedParams = definition.params.safeParse(params);
    if (!parsedParams.success) {
      throw new RpcValidationError(`Invalid parameters for ${method}`, parsedParams.error);
    }

    await this.connect(options);
    return this.sendRequestNow(
      method,
      parsedParams.data,
      definition.result,
      options.signal,
    ) as Promise<ResultFor<Methods, Method>>;
  }

  subscribeConnection(listener: (state: RpcConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  private async authenticate(transport: WebSocketLike) {
    try {
      const metadata = AuthenticationMetadataSchema.safeParse(await this.authentication());
      if (!metadata.success) {
        throw new RpcValidationError("Invalid RPC authentication metadata", metadata.error);
      }
      const result = await this.sendRequestNow(
        this.authenticationMethod,
        metadata.data,
        AuthenticationResultSchema,
      );
      if (this.transport !== transport || this.disposed) return;
      AuthenticationResultSchema.parse(result);
      if (this.compatibility) {
        this.updateState({
          attempt: this.reconnectAttempts,
          phase: "negotiating",
          stale: true,
        });
        let compatibilityResult: unknown;
        try {
          compatibilityResult = await this.sendRequestNow(
            this.compatibility.method,
            this.compatibility.params,
            this.compatibility.resultSchema,
          );
        } catch (error) {
          throw new RpcCompatibilityError(
            "backend-too-old",
            "The backend does not implement the required bridge protocol",
            error,
          );
        }
        const outcome = this.compatibility.outcome(compatibilityResult);
        if (outcome !== "compatible") {
          throw new RpcCompatibilityError(
            outcome,
            outcome === "client-too-old"
              ? "This client is too old for the bridge protocol"
              : "The backend is too old for this client",
          );
        }
      }
      this.reconnectAttempts = 0;
      this.updateState({ attempt: 0, phase: "connected", stale: false });
      this.resolveConnectionWaiters();
    } catch (error) {
      if (this.transport !== transport || this.disposed) return;
      if (error instanceof RpcCompatibilityError) {
        this.compatibilityError = error;
        this.desiredConnection = false;
        this.clearConnectionAttemptTimer();
        this.detachTransportListeners(transport);
        this.transport = null;
        transport.close(4002, "Bridge protocol incompatible");
        this.updateState({ attempt: 0, phase: error.outcome, stale: true });
        this.rejectConnectionWaiters(error);
        this.reportProtocolError(new RpcProtocolError(error.message, error));
        return;
      }
      this.reportProtocolError(
        error instanceof RpcProtocolError
          ? error
          : new RpcProtocolError("RPC authentication failed", error),
      );
      transport.close(4001, "Authentication failed");
    }
  }

  private detachTransportListeners(transport: WebSocketLike | null) {
    if (!transport || !this.transportListeners) return;
    transport.removeEventListener("close", this.transportListeners.close);
    transport.removeEventListener("error", this.transportListeners.error);
    transport.removeEventListener("message", this.transportListeners.message);
    transport.removeEventListener("open", this.transportListeners.open);
    this.transportListeners = null;
  }

  private clearConnectionAttemptTimer() {
    if (this.connectionAttemptTimer) clearTimeout(this.connectionAttemptTimer);
    this.connectionAttemptTimer = null;
  }

  private handleClose(transport: WebSocketLike, _event: WebSocketLikeEventMap["close"]) {
    if (this.transport !== transport) return;
    this.clearConnectionAttemptTimer();
    this.detachTransportListeners(transport);
    this.transport = null;
    this.rejectPendingRequests(new RpcDisconnectedError());
    if (this.disposed) return;
    if (!this.desiredConnection) {
      this.updateState({ attempt: 0, phase: "disconnected", stale: true });
      return;
    }
    this.scheduleReconnect();
  }

  private handleError(transport: WebSocketLike, event: WebSocketLikeEventMap["error"]) {
    if (this.transport !== transport) return;
    this.reportProtocolError(
      new RpcProtocolError(event.message ?? "RPC transport error", event.error),
    );
  }

  private handleMessage(data: unknown) {
    if (typeof data === "string") {
      this.processMessage(data, textEncoder.encode(data).byteLength);
      return;
    }

    void readBinaryMessage(data)
      .then(({ size, text }) => this.processMessage(text, size))
      .catch((error) =>
        this.reportProtocolError(new RpcProtocolError("Unsupported RPC message", error)),
      );
  }

  private handleOpen(transport: WebSocketLike) {
    if (this.transport !== transport || this.disposed) return;
    this.clearConnectionAttemptTimer();
    this.updateState({
      attempt: this.reconnectAttempts,
      phase: "authenticating",
      stale: true,
    });
    void this.authenticate(transport);
  }

  private openTransport(reconnecting: boolean) {
    if (this.disposed || this.transport) return;
    this.compatibilityError = null;
    this.updateState({
      attempt: this.reconnectAttempts,
      phase: reconnecting ? "reconnecting" : "connecting",
      stale: true,
    });

    let transport: WebSocketLike;
    try {
      transport = this.transportFactory();
    } catch (error) {
      this.reportProtocolError(new RpcProtocolError("RPC transport creation failed", error));
      this.scheduleReconnect();
      return;
    }

    const listeners: TransportListeners = {
      close: (event) => this.handleClose(transport, event),
      error: (event) => this.handleError(transport, event),
      message: (event) => this.handleMessage(event.data),
      open: () => this.handleOpen(transport),
    };
    this.transport = transport;
    this.transportListeners = listeners;
    this.connectionAttemptTimer = setTimeout(() => {
      if (this.transport !== transport || this.disposed) return;
      this.connectionAttemptTimer = null;
      this.detachTransportListeners(transport);
      this.transport = null;
      this.rejectConnectionWaiters(new RpcTimeoutError(this.requestDeadlineMilliseconds));
      transport.close(4000, "RPC connection deadline exceeded");
      this.scheduleReconnect();
    }, this.requestDeadlineMilliseconds);
    transport.addEventListener("close", listeners.close);
    transport.addEventListener("error", listeners.error);
    transport.addEventListener("message", listeners.message);
    transport.addEventListener("open", listeners.open);
  }

  private processMessage(text: string, size: number) {
    if (size > this.maxMessageBytes) {
      const error = new RpcProtocolError(
        "Incoming RPC message exceeds the configured size limit",
        new RpcMessageTooLargeError(size, this.maxMessageBytes),
      );
      this.reportProtocolError(error);
      this.transport?.close(1009, "Message too large");
      return;
    }

    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      this.reportProtocolError(new RpcProtocolError("Malformed JSON-RPC payload", error));
      return;
    }

    const parsed = JsonRpcMessageSchema.safeParse(value);
    if (!parsed.success) {
      this.reportProtocolError(new RpcProtocolError("Malformed JSON-RPC message", parsed.error));
      return;
    }

    const message = parsed.data;
    if ("method" in message) {
      this.processNotification(message.method, message.params);
      return;
    }
    this.processResponse(message);
  }

  private processNotification(method: string, params: unknown) {
    if (this.state.phase !== "connected") {
      this.reportProtocolError(
        new RpcProtocolError(`RPC notification ${method} arrived before authentication`),
      );
      return;
    }
    const subscription = this.notifications.get(method);
    if (!subscription) return;
    const parsed = subscription.schema.safeParse(params);
    if (!parsed.success) {
      this.reportProtocolError(
        new RpcProtocolError(`Invalid parameters for notification ${method}`, parsed.error),
      );
      return;
    }
    for (const listener of subscription.listeners) listener(parsed.data);
  }

  private processResponse(message: z.infer<typeof JsonRpcResponseMessageSchema>) {
    if (typeof message.id !== "string") {
      this.reportProtocolError(
        new RpcProtocolError(`Unknown RPC response id ${String(message.id)}`),
      );
      return;
    }
    const pending = this.takePendingRequest(message.id);
    if (!pending) {
      this.reportProtocolError(new RpcProtocolError(`Unknown RPC response id ${message.id}`));
      return;
    }

    if ("error" in message) {
      pending.reject(
        new RpcRemoteError(message.error.code, message.error.message, message.error.data),
      );
      return;
    }
    const result = pending.resultSchema.safeParse(message.result);
    if (!result.success) {
      const error = new RpcValidationError(`Invalid result for ${pending.method}`, result.error);
      pending.reject(error);
      this.reportProtocolError(new RpcProtocolError(error.message, error));
      return;
    }
    pending.resolve(result.data);
  }

  private rejectConnectionWaiters(error: unknown) {
    for (const waiter of this.connectionWaiters) {
      waiter.abortCleanup?.();
      waiter.deadlineCleanup?.();
      waiter.reject(error);
    }
    this.connectionWaiters.clear();
  }

  private rejectPendingRequests(error: unknown) {
    for (const requestId of this.pendingRequests.keys()) {
      const pending = this.takePendingRequest(requestId);
      pending?.reject(error);
    }
  }

  private reportProtocolError(error: RpcProtocolError) {
    this.onProtocolError?.(error);
  }

  private resolveConnectionWaiters() {
    for (const waiter of this.connectionWaiters) {
      waiter.abortCleanup?.();
      waiter.deadlineCleanup?.();
      waiter.resolve();
    }
    this.connectionWaiters.clear();
  }

  private scheduleReconnect() {
    if (this.disposed || !this.desiredConnection || this.reconnectTimer) return;
    if (this.reconnectAttempts >= this.maximumReconnectAttempts) {
      const error = new RpcDisconnectedError("RPC reconnect attempts were exhausted");
      this.updateState({
        attempt: this.reconnectAttempts,
        phase: "disconnected",
        stale: true,
      });
      this.rejectConnectionWaiters(error);
      return;
    }

    this.reconnectAttempts += 1;
    const delay = Math.min(
      this.maximumDelayMilliseconds,
      this.initialDelayMilliseconds * this.backoffFactor ** (this.reconnectAttempts - 1),
    );
    this.updateState({ attempt: this.reconnectAttempts, phase: "reconnecting", stale: true });
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.openTransport(true);
    }, delay);
  }

  private sendCancellation(requestId: RpcRequestId) {
    if (this.state.phase !== "connected" || !this.transport) return;
    const payload = JSON.stringify({
      jsonrpc: "2.0",
      method: "rpc.cancel",
      params: { requestId },
    });
    if (textEncoder.encode(payload).byteLength > this.maxMessageBytes) return;
    try {
      this.transport.send(payload);
    } catch {
      // The request has already been settled; cancellation is only a best-effort hint.
    }
  }

  private sendRequestNow(
    method: string,
    params: unknown,
    resultSchema: z.ZodType,
    signal?: AbortSignal,
  ) {
    if (this.disposed) return Promise.reject(new RpcDisposedError());
    if (signal?.aborted) return Promise.reject(new RpcCancelledError());
    if (!this.transport || this.transport.readyState !== 1) {
      return Promise.reject(new RpcDisconnectedError());
    }

    let id: RpcRequestId;
    try {
      id = this.allocateRequestId();
    } catch (error) {
      return Promise.reject(error);
    }
    const payload = JSON.stringify({ id, jsonrpc: "2.0", method, params });
    const size = textEncoder.encode(payload).byteLength;
    if (size > this.maxMessageBytes) {
      return Promise.reject(new RpcMessageTooLargeError(size, this.maxMessageBytes));
    }

    return new Promise<unknown>((resolve, reject) => {
      const pending: PendingRequest = { method, reject, resolve, resultSchema };
      if (signal) {
        const onAbort = () => {
          const current = this.takePendingRequest(id);
          if (!current) return;
          this.sendCancellation(id);
          reject(new RpcCancelledError());
        };
        signal.addEventListener("abort", onAbort, { once: true });
        pending.abortCleanup = () => signal.removeEventListener("abort", onAbort);
      }
      this.pendingRequests.set(id, pending);
      const deadlineTimer = setTimeout(() => {
        const current = this.takePendingRequest(id);
        if (!current) return;
        this.sendCancellation(id);
        current.reject(new RpcTimeoutError(this.requestDeadlineMilliseconds, id));
      }, this.requestDeadlineMilliseconds);
      pending.timeoutCleanup = () => clearTimeout(deadlineTimer);
      try {
        this.transport?.send(payload);
      } catch (error) {
        const current = this.takePendingRequest(id);
        current?.reject(new RpcDisconnectedError(String(error)));
      }
    });
  }

  private allocateRequestId(): RpcRequestId {
    if (!Number.isSafeInteger(this.nextRequestSequence)) {
      throw new RpcRequestIdCollisionError("sequence-exhausted");
    }
    const sequence = this.nextRequestSequence;
    this.nextRequestSequence += 1;
    const requestId = this.requestIdFactory(sequence);
    if (typeof requestId !== "string" || requestId.length === 0) {
      throw new RpcProtocolError("RPC request ID factory returned an invalid identity");
    }
    if (this.pendingRequests.has(requestId) || this.issuedRequestIds?.has(requestId)) {
      throw new RpcRequestIdCollisionError(requestId);
    }
    this.issuedRequestIds?.add(requestId);
    return requestId;
  }

  private takePendingRequest(requestId: RpcRequestId) {
    const pending = this.pendingRequests.get(requestId);
    if (!pending) return null;
    this.pendingRequests.delete(requestId);
    pending.abortCleanup?.();
    pending.timeoutCleanup?.();
    return pending;
  }

  private updateState(state: RpcConnectionState) {
    this.state = state;
    for (const listener of this.connectionListeners) listener({ ...state });
  }
}

async function readBinaryMessage(data: unknown) {
  if (data instanceof ArrayBuffer) {
    return { size: data.byteLength, text: new TextDecoder().decode(data) };
  }
  if (ArrayBuffer.isView(data)) {
    return {
      size: data.byteLength,
      text: new TextDecoder().decode(new Uint8Array(data.buffer, data.byteOffset, data.byteLength)),
    };
  }
  if (typeof Blob !== "undefined" && data instanceof Blob) {
    return { size: data.size, text: await data.text() };
  }
  throw new TypeError("RPC messages must be text or binary WebSocket payloads");
}

export function createBrowserWebSocketTransportFactory(url: string, protocols?: string | string[]) {
  return () => new WebSocket(url, protocols) as unknown as WebSocketLike;
}

export * from "./session-authority";
