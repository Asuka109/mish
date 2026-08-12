import {
  MobileConfigCancelResultSchema,
  MobileConfigLoadResultSchema,
  MobileConfigValidationResultSchema,
  MobileVpnCommandResultSchema,
  MobileVpnEventSchema,
  MobileVpnSnapshotSchema,
  type MobileConfigLoadFailure,
  type MobileConfigLoadResultDto,
  type MobileConfigValidationFailure,
  type MobileConfigValidationResultDto,
  type MobileVpnCommandResultDto,
  type MobileVpnSnapshotDto,
} from "@mish/contracts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export const MOBILE_CORE_MAX_CONFIG_BYTES_V1 = 1_048_576;

interface MobileVpnTransport {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(handler: (payload: unknown) => void): Promise<MobileVpnListener>;
}

export type MobileVpnDeliveryTraceEvent =
  | {
      generation: number;
      kind: "generation";
      phase: "baseline-pending" | "baseline-accepted" | "disposed";
    }
  | {
      acceptance: "accepted" | "duplicate" | "stale" | "retired";
      authorityId: string;
      delivery: "baseline" | "notification" | "command" | "load";
      generation: number;
      kind: "delivery";
      revision: number;
      sequence: number;
      sessionId: string;
    };

export interface MobileVpnClientOptions {
  trace?: (event: MobileVpnDeliveryTraceEvent) => void;
}

interface MobileVpnListener {
  unregister(): Promise<void>;
}

interface MobileConfigValidationOptions {
  signal?: AbortSignal;
}

export interface MobileConfigRevisionIdentity {
  digest: string;
  revision: string;
}

interface MobileConfigLoadOptions {
  injectFailure?: boolean;
  operationId?: string;
  signal?: AbortSignal;
  timeoutMillis?: number;
}

interface MobileVpnAuthority {
  authorityId: string;
  revision: number;
  sequence: number;
  sessionId: string;
}

interface MobileValidationOperation {
  cancellationRequested: boolean;
  generation: number;
  retired: boolean;
}

interface MobileLoadOperation {
  authority: MobileVpnAuthority;
  cancellationRequested: boolean;
  generation: number;
  operationId: string;
  retired: boolean;
}

interface MobileLifecycleOperation {
  authority?: MobileVpnAuthority;
  cancellationRequested: boolean;
  generation: number;
  kind: "request-notification-permission" | "request-vpn-consent" | "start" | "stop";
  operationId: string;
  requestCancellation?: () => void;
  retired: boolean;
  terminalSettled: boolean;
}

export interface MobileVpnClient {
  dispose(): void;
  getSnapshot(): MobileVpnSnapshotDto | undefined;
  initialize(): Promise<MobileVpnSnapshotDto>;
  loadConfig(
    configBytes: Uint8Array,
    identity: MobileConfigRevisionIdentity,
    options?: MobileConfigLoadOptions,
  ): Promise<MobileConfigLoadResultDto>;
  requestNotificationPermission(options?: { signal?: AbortSignal }): Promise<MobileVpnSnapshotDto>;
  requestVpnConsent(options?: { signal?: AbortSignal }): Promise<MobileVpnSnapshotDto>;
  start(options?: { signal?: AbortSignal }): Promise<MobileVpnSnapshotDto>;
  stop(options?: { signal?: AbortSignal }): Promise<MobileVpnSnapshotDto>;
  subscribe(handler: (snapshot: MobileVpnSnapshotDto) => void): () => void;
  validateConfig(
    configBytes: Uint8Array,
    options?: MobileConfigValidationOptions,
  ): Promise<MobileConfigValidationResultDto>;
}

const defaultTransport: MobileVpnTransport = {
  invoke: (command, args) => invoke(`plugin:mish-vpn|${command}`, args),
  listen: async (handler) => {
    const unlisten = await listen("mish-vpn://snapshot", (event) => handler(event.payload));
    return { unregister: async () => unlisten() };
  },
};

export class MobileVpnFixtureClient implements MobileVpnClient {
  private loadSequence = 0;
  private lifecycleOperationSequence = 0;
  private listener?: MobileVpnListener;
  private listenerGeneration = 0;
  private baselineAccepted = false;
  private clientGeneration = 0;
  private disposed = false;
  private readonly pendingEvents = new Map<string, MobileVpnSnapshotDto>();
  private snapshot?: MobileVpnSnapshotDto;
  private readonly retiredAuthorityIds = new Set<string>();
  private readonly retiredSessionIds = new Set<string>();
  private readonly subscribers = new Set<(snapshot: MobileVpnSnapshotDto) => void>();
  private validationOperation?: MobileValidationOperation;
  private activeLoadOperationId?: string;
  private readonly loadOperations = new Map<string, MobileLoadOperation>();
  private readonly lifecycleOperations = new Map<string, MobileLifecycleOperation>();
  private traceCount = 0;

  constructor(
    private readonly transport: MobileVpnTransport = defaultTransport,
    private readonly options: MobileVpnClientOptions = {},
  ) {}

  async initialize(): Promise<MobileVpnSnapshotDto> {
    const generation = this.beginGeneration();
    await this.installListener(generation);
    if (!this.isCurrentGeneration(generation)) {
      throw new Error("The mobile VPN baseline was retired before it was requested.");
    }
    const baseline = MobileVpnSnapshotSchema.parse(await this.transport.invoke("get_snapshot"));
    if (!this.isCurrentGeneration(generation)) {
      throw new Error("The mobile VPN baseline was retired before it was accepted.");
    }
    this.acceptBaseline(baseline);
    if (!this.baselineAccepted) {
      throw new Error("The mobile VPN baseline was stale or conflicting.");
    }
    return this.snapshot ?? baseline;
  }

  getSnapshot(): MobileVpnSnapshotDto | undefined {
    return this.baselineAccepted ? this.snapshot : undefined;
  }

  requestNotificationPermission(
    options: { signal?: AbortSignal } = {},
  ): Promise<MobileVpnSnapshotDto> {
    return this.runLifecycleCommand(
      "request_notification_permission",
      "request-notification-permission",
      options,
    );
  }

  requestVpnConsent(options: { signal?: AbortSignal } = {}): Promise<MobileVpnSnapshotDto> {
    return this.runLifecycleCommand("request_vpn_consent", "request-vpn-consent", options);
  }

  start(options: { signal?: AbortSignal } = {}): Promise<MobileVpnSnapshotDto> {
    return this.runLifecycleCommand("start", "start", options);
  }

  stop(options: { signal?: AbortSignal } = {}): Promise<MobileVpnSnapshotDto> {
    return this.runLifecycleCommand("stop", "stop", options);
  }

  async validateConfig(
    configBytes: Uint8Array,
    options: MobileConfigValidationOptions = {},
  ): Promise<MobileConfigValidationResultDto> {
    const authority = this.currentAuthority();
    if (!authority) {
      return validationFailure(
        "client-uninitialized",
        "Initialize the mobile native client before validating configuration.",
      );
    }
    if (options.signal?.aborted) {
      return validationFailure("cancelled", "Configuration validation was cancelled.", authority);
    }
    if (configBytes.byteLength > MOBILE_CORE_MAX_CONFIG_BYTES_V1) {
      return validationFailure(
        "configuration-too-large",
        "Configuration exceeds the Mobile Core v1 size limit.",
        authority,
      );
    }
    if (this.validationOperation) {
      return validationFailure(
        "duplicate-command",
        "Another configuration validation is already pending.",
        authority,
      );
    }

    const operation: MobileValidationOperation = {
      cancellationRequested: false,
      generation: this.clientGeneration,
      retired: false,
    };
    this.validationOperation = operation;
    const payloadBytes = Array.from(configBytes);
    const validation = (async (): Promise<MobileConfigValidationResultDto> => {
      try {
        const result = MobileConfigValidationResultSchema.parse(
          await this.transport.invoke("validate_config", {
            request: {
              configBytes: payloadBytes,
              sequence: authority.sequence,
              sessionId: authority.sessionId,
            },
          }),
        );
        if (operation.retired || !this.isCurrentGeneration(operation.generation)) {
          return validationFailure(
            operation.cancellationRequested && this.isCurrentGeneration(operation.generation)
              ? "cancelled"
              : "stale-authority",
            operation.cancellationRequested && this.isCurrentGeneration(operation.generation)
              ? "Configuration validation was cancelled."
              : "The mobile runtime authority changed during configuration validation.",
            this.currentAuthority(),
          );
        }
        if (options.signal?.aborted) {
          return validationFailure(
            "cancelled",
            "Configuration validation was cancelled.",
            this.currentAuthority() ?? authority,
          );
        }
        const currentAuthority = this.currentAuthority();
        if (
          result.failure !== "stale-authority" &&
          (result.sequence !== authority.sequence ||
            result.sessionId !== authority.sessionId ||
            currentAuthority?.sequence !== authority.sequence ||
            currentAuthority?.sessionId !== authority.sessionId)
        ) {
          return validationFailure(
            "stale-authority",
            "The mobile runtime authority changed during configuration validation.",
            currentAuthority ?? authority,
          );
        }
        return result;
      } catch {
        if (operation.retired || !this.isCurrentGeneration(operation.generation)) {
          return validationFailure(
            operation.cancellationRequested && this.isCurrentGeneration(operation.generation)
              ? "cancelled"
              : "stale-authority",
            operation.cancellationRequested && this.isCurrentGeneration(operation.generation)
              ? "Configuration validation was cancelled."
              : "The mobile runtime authority changed during configuration validation.",
            this.currentAuthority(),
          );
        }
        return validationFailure(
          options.signal?.aborted ? "cancelled" : "plugin-failure",
          options.signal?.aborted
            ? "Configuration validation was cancelled."
            : "The mobile validation plugin failed safely.",
          this.currentAuthority() ?? authority,
        );
      } finally {
        payloadBytes.fill(0);
        if (this.validationOperation === operation) this.validationOperation = undefined;
      }
    })();

    if (!options.signal) return validation;

    let settleCancellation: (() => void) | undefined;
    const cancellation = new Promise<MobileConfigValidationResultDto>((resolve) => {
      settleCancellation = () => {
        operation.cancellationRequested = true;
        operation.retired = true;
        resolve(
          validationFailure(
            "cancelled",
            "Configuration validation was cancelled.",
            this.currentAuthority() ?? authority,
          ),
        );
      };
      options.signal?.addEventListener("abort", settleCancellation, { once: true });
      if (options.signal?.aborted) settleCancellation();
    });

    try {
      return await Promise.race([validation, cancellation]);
    } finally {
      if (settleCancellation) {
        options.signal.removeEventListener("abort", settleCancellation);
      }
    }
  }

  async loadConfig(
    configBytes: Uint8Array,
    identity: MobileConfigRevisionIdentity,
    options: MobileConfigLoadOptions = {},
  ): Promise<MobileConfigLoadResultDto> {
    const generation = this.clientGeneration;
    const authority = this.currentAuthority();
    const operationId =
      options.operationId ?? `mobile-config-load-${Date.now()}-${++this.loadSequence}`;
    const base = {
      digest: identity.digest,
      operationId,
      revision: identity.revision,
    };
    if (!authority) {
      return loadFailure(
        base,
        "invalid-input",
        "Initialize the mobile native client before loading configuration.",
      );
    }
    if (options.signal?.aborted) {
      return loadFailure(
        base,
        "cancelled",
        "Configuration loading was cancelled before dispatch.",
        this.snapshot,
        "cancelled",
        "before-load",
      );
    }
    if (configBytes.byteLength > MOBILE_CORE_MAX_CONFIG_BYTES_V1) {
      return loadFailure(
        base,
        "configuration-too-large",
        "Configuration exceeds the Mobile Core v1 size limit.",
        this.snapshot,
      );
    }
    if (
      !/^[0-9a-f]{64}$/u.test(identity.digest) ||
      identity.revision.length === 0 ||
      identity.revision.length > 128 ||
      operationId.length === 0 ||
      operationId.length > 128
    ) {
      return loadFailure(
        base,
        "invalid-input",
        "The configuration load identity is invalid.",
        this.snapshot,
      );
    }
    if ((await sha256Hex(configBytes)) !== identity.digest) {
      return loadFailure(
        base,
        "digest-mismatch",
        "The configuration bytes do not match the admitted digest.",
        this.snapshot,
      );
    }
    if (options.signal?.aborted) {
      return loadFailure(
        base,
        "cancelled",
        "Configuration loading was cancelled before native dispatch.",
        this.snapshot,
        "cancelled",
        "before-load",
      );
    }
    if (!this.isCurrentGeneration(generation)) {
      return loadFailure(
        base,
        "runtime-replaced",
        "The mobile configuration load was retired before native dispatch.",
        this.snapshot,
      );
    }
    if (this.activeLoadOperationId) {
      return loadFailure(
        base,
        "duplicate-command",
        "Another configuration load is already pending.",
        this.snapshot,
      );
    }

    const operation: MobileLoadOperation = {
      authority,
      cancellationRequested: false,
      generation,
      operationId,
      retired: false,
    };
    this.loadOperations.set(operationId, operation);
    this.activeLoadOperationId = operationId;
    const payloadBytes = Array.from(configBytes);
    const onAbort = () => {
      if (operation.cancellationRequested) return;
      operation.cancellationRequested = true;
      operation.retired = true;
      void this.transport
        .invoke("cancel_config_load", { request: { operationId } })
        .then((value) => MobileConfigCancelResultSchema.parse(value))
        .catch(() => undefined);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const result = MobileConfigLoadResultSchema.parse(
        await this.transport.invoke("load_config", {
          request: {
            configBytes: payloadBytes,
            digest: identity.digest,
            injectFailure: options.injectFailure ?? false,
            operationId,
            revision: identity.revision,
            sequence: authority.sequence,
            sessionId: authority.sessionId,
            timeoutMillis: options.timeoutMillis ?? 10_000,
          },
        }),
      );
      if (
        result.operationId !== operationId ||
        result.revision !== identity.revision ||
        result.digest !== identity.digest
      ) {
        return loadFailure(
          base,
          "plugin-failure",
          "The mobile configuration load result identity was invalid.",
          this.snapshot,
        );
      }
      if (operation.retired || !this.isCurrentGeneration(operation.generation)) {
        if (
          operation.cancellationRequested &&
          options.signal?.aborted &&
          this.isCurrentGeneration(operation.generation)
        ) {
          const cancellation =
            result.cancellation === "not-requested" ? "too-late" : result.cancellation;
          return loadFailure(
            base,
            "cancelled",
            "Configuration loading was cancelled before its result could be accepted.",
            this.snapshot,
            "cancelled",
            cancellation,
          );
        }
        return loadFailure(
          base,
          "runtime-replaced",
          "The mobile configuration load was retired before its native result arrived.",
          this.snapshot,
        );
      }
      if (result.snapshot) {
        const accepted = this.acceptCommandSnapshot(
          result.snapshot,
          operation.authority,
          result.failure === "runtime-replaced",
          "load",
        );
        if (!accepted) {
          return loadFailure(
            base,
            result.failure === "runtime-replaced" ? "runtime-replaced" : "stale-authority",
            "The mobile configuration load result was stale for the accepted native authority.",
            this.snapshot,
            "failed",
            result.cancellation,
          );
        }
      }
      return result;
    } catch {
      if (operation.retired || !this.isCurrentGeneration(operation.generation)) {
        if (
          operation.cancellationRequested &&
          options.signal?.aborted &&
          this.isCurrentGeneration(operation.generation)
        ) {
          return loadFailure(
            base,
            "cancelled",
            "Configuration loading was cancelled before its result could be accepted.",
            this.snapshot,
            "cancelled",
            "too-late",
          );
        }
        return loadFailure(
          base,
          "runtime-replaced",
          "The mobile configuration load was retired before its native result arrived.",
          this.snapshot,
        );
      }
      return loadFailure(
        base,
        options.signal?.aborted ? "cancelled" : "plugin-failure",
        options.signal?.aborted
          ? "Configuration loading was cancelled without a terminal native result."
          : "The mobile configuration load plugin failed safely.",
        this.snapshot,
        options.signal?.aborted ? "cancelled" : "failed",
        options.signal?.aborted ? "before-load" : "not-requested",
      );
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      payloadBytes.fill(0);
      this.loadOperations.delete(operationId);
      if (this.activeLoadOperationId === operationId) this.activeLoadOperationId = undefined;
    }
  }

  subscribe(handler: (snapshot: MobileVpnSnapshotDto) => void): () => void {
    this.subscribers.add(handler);
    if (!this.disposed && this.baselineAccepted && this.snapshot) handler(this.snapshot);
    return () => this.subscribers.delete(handler);
  }

  dispose(): void {
    this.retireOperations();
    this.disposed = true;
    this.clientGeneration += 1;
    void this.listener?.unregister().catch(() => undefined);
    this.listener = undefined;
    this.listenerGeneration = 0;
    this.baselineAccepted = false;
    this.pendingEvents.clear();
    this.subscribers.clear();
    this.emitTrace({ generation: this.clientGeneration, kind: "generation", phase: "disposed" });
  }

  private async runLifecycleCommand(
    command: string,
    kind: "request-notification-permission" | "request-vpn-consent" | "start" | "stop",
    options: { signal?: AbortSignal } = {},
  ): Promise<MobileVpnSnapshotDto> {
    const generation = this.clientGeneration;
    const operationId = `mobile-vpn-${kind}-${Date.now()}-${++this.lifecycleOperationSequence}`;
    const operation: MobileLifecycleOperation = {
      authority: this.currentAuthority(),
      cancellationRequested: false,
      generation,
      kind,
      operationId,
      retired: false,
      terminalSettled: false,
    };
    this.lifecycleOperations.set(operationId, operation);
    let resolveCancellation: ((result: MobileVpnCommandResultDto) => void) | undefined;
    const cancellation = new Promise<MobileVpnCommandResultDto>((resolve) => {
      resolveCancellation = resolve;
    });
    const requestCancellation = () => {
      if (operation.cancellationRequested || operation.terminalSettled) return;
      operation.cancellationRequested = true;
      void this.transport
        .invoke("cancel_lifecycle_operation", { request: { operationId } })
        .then((value) => MobileVpnCommandResultSchema.parse(value))
        .then((value) => {
          resolveCancellation?.(value);
          return value;
        })
        .catch(() => undefined);
    };
    operation.requestCancellation = requestCancellation;
    const onAbort = requestCancellation;
    options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const commandResult = this.transport
        .invoke(command, { request: { operationId } })
        .then((value) => MobileVpnCommandResultSchema.parse(value))
        .then((value) => ({ source: "command" as const, value }));
      if (options.signal?.aborted) onAbort();
      const settled = await Promise.race([
        commandResult,
        cancellation.then((value) => ({ source: "cancel" as const, value })),
      ]);
      operation.terminalSettled = true;
      const result = settled.value;
      if (operation.retired || !this.isCurrentGeneration(operation.generation)) {
        return this.snapshot ?? result.snapshot;
      }
      if (result.operation.operationId !== operationId || result.operation.kind !== kind) {
        throw new Error("The mobile VPN lifecycle result identity was invalid.");
      }
      this.acceptCommandSnapshot(
        result.snapshot,
        operation.authority,
        result.operation.failure === "stale-platform-authority",
        "command",
      );
      return this.snapshot ?? result.snapshot;
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
      this.lifecycleOperations.delete(operationId);
    }
  }

  private beginGeneration(): number {
    this.retireOperations();
    this.disposed = false;
    this.clientGeneration += 1;
    this.baselineAccepted = false;
    this.pendingEvents.clear();
    const listener = this.listener;
    this.listener = undefined;
    this.listenerGeneration = 0;
    if (listener) void listener.unregister().catch(() => undefined);
    this.emitTrace({
      generation: this.clientGeneration,
      kind: "generation",
      phase: "baseline-pending",
    });
    return this.clientGeneration;
  }

  private async installListener(generation: number): Promise<void> {
    if (this.listenerGeneration === generation && this.listener) return;
    const listenerPromise = this.transport.listen((payload) => {
      if (!this.isCurrentGeneration(generation)) return;
      const event = MobileVpnEventSchema.parse(payload);
      if (!this.baselineAccepted) {
        this.queuePendingSnapshot(event.snapshot);
        return;
      }
      this.acceptSnapshot(event.snapshot);
    });
    const listener = await listenerPromise;
    if (!this.isCurrentGeneration(generation)) {
      await listener.unregister().catch(() => undefined);
      return;
    }
    this.listener = listener;
    this.listenerGeneration = generation;
  }

  private acceptBaseline(baseline: MobileVpnSnapshotDto): void {
    if (!this.snapshot) {
      this.snapshot = baseline;
    } else if (this.retiredAuthorityIds.has(baseline.authorityId)) {
      return;
    } else if (baseline.authorityId !== this.snapshot.authorityId) {
      this.retireAuthority(this.snapshot.authorityId);
      this.snapshot = baseline;
    } else if (baseline.sessionId !== this.snapshot.sessionId) {
      if (this.retiredSessionIds.has(baseline.sessionId)) return;
      if (
        baseline.sequence < this.snapshot.sequence ||
        baseline.revision < this.snapshot.revision
      ) {
        return;
      }
      this.retireSession(this.snapshot.sessionId);
      this.snapshot = baseline;
    } else if (
      baseline.sequence < this.snapshot.sequence ||
      baseline.revision < this.snapshot.revision ||
      (baseline.revision === this.snapshot.revision && !sameSnapshot(this.snapshot, baseline))
    ) {
      return;
    } else {
      this.snapshot = baseline;
    }
    this.baselineAccepted = true;
    this.emitTrace({
      generation: this.clientGeneration,
      kind: "generation",
      phase: "baseline-accepted",
    });
    this.emitTrace({
      acceptance: "accepted",
      authorityId: baseline.authorityId,
      delivery: "baseline",
      generation: this.clientGeneration,
      kind: "delivery",
      revision: baseline.revision,
      sequence: baseline.sequence,
      sessionId: baseline.sessionId,
    });
    this.notify(baseline);
    const pending = [...this.pendingEvents.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
    this.pendingEvents.clear();
    for (const snapshot of pending) {
      if (snapshot.authorityId === baseline.authorityId)
        this.acceptSnapshot(snapshot, "notification");
    }
  }

  private acceptSnapshot(
    snapshot: MobileVpnSnapshotDto,
    delivery: "notification" | "command" | "load" = "notification",
  ): boolean {
    if (!this.baselineAccepted) {
      this.queuePendingSnapshot(snapshot);
      return false;
    }
    if (!this.snapshot) return false;
    if (this.retiredAuthorityIds.has(snapshot.authorityId)) {
      this.traceDelivery(snapshot, delivery, "retired");
      return false;
    }
    if (this.retiredSessionIds.has(snapshot.sessionId)) {
      this.traceDelivery(snapshot, delivery, "retired");
      return false;
    }
    if (this.snapshot.authorityId !== snapshot.authorityId) {
      this.traceDelivery(snapshot, delivery, "stale");
      return false;
    }
    if (snapshot.sequence < this.snapshot.sequence || snapshot.revision < this.snapshot.revision) {
      this.traceDelivery(snapshot, delivery, "stale");
      return false;
    }
    if (
      snapshot.sequence === this.snapshot.sequence &&
      snapshot.revision === this.snapshot.revision
    ) {
      const acceptance = sameSnapshot(this.snapshot, snapshot) ? "duplicate" : "stale";
      this.traceDelivery(snapshot, delivery, acceptance);
      return false;
    }
    if (this.snapshot.sessionId !== snapshot.sessionId) this.retireSession(this.snapshot.sessionId);
    this.snapshot = snapshot;
    this.traceDelivery(snapshot, delivery, "accepted");
    this.notify(snapshot);
    return true;
  }

  private acceptCommandSnapshot(
    snapshot: MobileVpnSnapshotDto,
    authority: MobileVpnAuthority | undefined,
    allowReplacement: boolean,
    delivery: "command" | "load" = "command",
  ): boolean {
    if (
      !this.isCurrentGeneration(this.clientGeneration) ||
      !this.baselineAccepted ||
      !this.snapshot
    ) {
      return false;
    }
    if (
      !authority ||
      snapshot.authorityId !== authority.authorityId ||
      snapshot.sessionId !== authority.sessionId
    ) {
      if (!allowReplacement || this.retiredAuthorityIds.has(snapshot.authorityId)) {
        this.traceDelivery(snapshot, delivery, "stale");
        return false;
      }
      if (
        snapshot.authorityId === this.snapshot.authorityId &&
        (snapshot.sequence <= this.snapshot.sequence || snapshot.revision < this.snapshot.revision)
      ) {
        this.traceDelivery(snapshot, delivery, "stale");
        return false;
      }
      if (this.snapshot.authorityId !== snapshot.authorityId) {
        this.retireAuthority(this.snapshot.authorityId);
      } else if (this.snapshot.sessionId !== snapshot.sessionId) {
        if (this.retiredSessionIds.has(snapshot.sessionId)) return false;
        this.retireSession(this.snapshot.sessionId);
      }
      this.snapshot = snapshot;
      this.baselineAccepted = true;
      this.traceDelivery(snapshot, delivery, "accepted");
      this.notify(snapshot);
      return true;
    }
    if (sameSnapshot(this.snapshot, snapshot)) {
      this.traceDelivery(snapshot, delivery, "duplicate");
      return true;
    }
    return this.acceptSnapshot(snapshot, delivery);
  }

  private currentAuthority(): MobileVpnAuthority | undefined {
    if (!this.snapshot || !this.baselineAccepted) return undefined;
    return {
      authorityId: this.snapshot.authorityId,
      revision: this.snapshot.revision,
      sequence: this.snapshot.sequence,
      sessionId: this.snapshot.sessionId,
    };
  }

  private queuePendingSnapshot(snapshot: MobileVpnSnapshotDto): void {
    const key = `${snapshot.authorityId}:${snapshot.sessionId}`;
    const current = this.pendingEvents.get(key);
    if (!current || snapshot.sequence > current.sequence) {
      this.pendingEvents.set(key, snapshot);
    }
    while (this.pendingEvents.size > 8) {
      this.pendingEvents.delete(this.pendingEvents.keys().next().value!);
    }
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.clientGeneration;
  }

  private notify(snapshot: MobileVpnSnapshotDto): void {
    if (!this.baselineAccepted || this.disposed) return;
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }

  private retireAuthority(authorityId: string): void {
    this.retiredAuthorityIds.add(authorityId);
    trimSet(this.retiredAuthorityIds);
  }

  private retireSession(sessionId: string): void {
    this.retiredSessionIds.add(sessionId);
    trimSet(this.retiredSessionIds);
  }

  private retireOperations(): void {
    if (this.validationOperation) this.validationOperation.retired = true;
    for (const operation of this.loadOperations.values()) {
      operation.retired = true;
      if (!operation.cancellationRequested) {
        operation.cancellationRequested = true;
        void this.transport
          .invoke("cancel_config_load", { request: { operationId: operation.operationId } })
          .then((value) => MobileConfigCancelResultSchema.parse(value))
          .catch(() => undefined);
      }
    }
    for (const operation of this.lifecycleOperations.values()) {
      operation.retired = true;
      if (!operation.cancellationRequested && !operation.terminalSettled)
        operation.requestCancellation?.();
    }
  }

  private traceDelivery(
    snapshot: MobileVpnSnapshotDto,
    delivery: "baseline" | "notification" | "command" | "load",
    acceptance: "accepted" | "duplicate" | "stale" | "retired",
  ): void {
    this.emitTrace({
      acceptance,
      authorityId: snapshot.authorityId,
      delivery,
      generation: this.clientGeneration,
      kind: "delivery",
      revision: snapshot.revision,
      sequence: snapshot.sequence,
      sessionId: snapshot.sessionId,
    });
  }

  private emitTrace(event: MobileVpnDeliveryTraceEvent): void {
    if (!this.options.trace) return;
    if (this.traceCount >= 32) throw new Error("The mobile VPN delivery transcript overflowed.");
    this.traceCount += 1;
    this.options.trace?.(event);
  }
}

function trimSet(values: Set<string>): void {
  while (values.size > 8) values.delete(values.values().next().value!);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function sameSnapshot(left: MobileVpnSnapshotDto, right: MobileVpnSnapshotDto): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function validationFailure(
  failure: MobileConfigValidationFailure,
  message: string,
  authority?: { sequence: number; sessionId: string },
): MobileConfigValidationResultDto {
  return {
    contractVersion: 1,
    failure,
    message,
    outcome: failure === "configuration-rejected" ? "invalid" : "failed",
    sequence: authority?.sequence ?? null,
    sessionId: authority?.sessionId ?? null,
  };
}

function loadFailure(
  identity: { digest: string; operationId: string; revision: string },
  failure: MobileConfigLoadFailure,
  message: string,
  snapshot?: MobileVpnSnapshotDto,
  outcome: MobileConfigLoadResultDto["outcome"] = "failed",
  cancellation: MobileConfigLoadResultDto["cancellation"] = "not-requested",
): MobileConfigLoadResultDto {
  const rollback =
    snapshot?.coreConfigState === "loaded"
      ? "preserved"
      : snapshot?.coreConfigState === "unloaded"
        ? "unloaded"
        : "unknown";
  return {
    cancellation,
    contractVersion: 1,
    digest: identity.digest,
    failure,
    message,
    operationId: identity.operationId,
    outcome,
    revision: identity.revision,
    rollback,
    snapshot: snapshot ?? null,
    timing: "on-time",
  };
}
