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

export interface MobileVpnClient {
  dispose(): void;
  getSnapshot(): MobileVpnSnapshotDto | undefined;
  initialize(): Promise<MobileVpnSnapshotDto>;
  loadConfig(
    configBytes: Uint8Array,
    identity: MobileConfigRevisionIdentity,
    options?: MobileConfigLoadOptions,
  ): Promise<MobileConfigLoadResultDto>;
  requestNotificationPermission(): Promise<MobileVpnSnapshotDto>;
  requestVpnConsent(): Promise<MobileVpnSnapshotDto>;
  start(options?: { signal?: AbortSignal }): Promise<MobileVpnSnapshotDto>;
  stop(): Promise<MobileVpnSnapshotDto>;
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
  private validationPending = false;
  private loadPending = false;
  private loadSequence = 0;
  private lifecycleOperationSequence = 0;
  private listener?: MobileVpnListener;
  private baselineAccepted = false;
  private readonly pendingEvents: MobileVpnSnapshotDto[] = [];
  private snapshot?: MobileVpnSnapshotDto;
  private readonly retiredAuthorityIds = new Set<string>();
  private readonly retiredSessionIds = new Set<string>();
  private readonly subscribers = new Set<(snapshot: MobileVpnSnapshotDto) => void>();

  constructor(private readonly transport: MobileVpnTransport = defaultTransport) {}

  async initialize(): Promise<MobileVpnSnapshotDto> {
    if (!this.listener) {
      this.listener = await this.transport.listen((payload) => {
        const event = MobileVpnEventSchema.parse(payload);
        if (!this.baselineAccepted) {
          this.pendingEvents.push(event.snapshot);
          if (this.pendingEvents.length > 16) this.pendingEvents.shift();
          return;
        }
        this.acceptSnapshot(event.snapshot);
      });
    }
    const baseline = MobileVpnSnapshotSchema.parse(await this.transport.invoke("get_snapshot"));
    this.acceptBaseline(baseline);
    return this.snapshot ?? baseline;
  }

  getSnapshot(): MobileVpnSnapshotDto | undefined {
    return this.snapshot;
  }

  requestNotificationPermission(): Promise<MobileVpnSnapshotDto> {
    return this.runLifecycleCommand(
      "request_notification_permission",
      "request-notification-permission",
    );
  }

  requestVpnConsent(): Promise<MobileVpnSnapshotDto> {
    return this.runLifecycleCommand("request_vpn_consent", "request-vpn-consent");
  }

  start(options: { signal?: AbortSignal } = {}): Promise<MobileVpnSnapshotDto> {
    return this.runLifecycleCommand("start", "start", options);
  }

  stop(): Promise<MobileVpnSnapshotDto> {
    return this.runLifecycleCommand("stop", "stop");
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
    if (this.validationPending) {
      return validationFailure(
        "duplicate-command",
        "Another configuration validation is already pending.",
        authority,
      );
    }

    this.validationPending = true;
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
        return validationFailure(
          options.signal?.aborted ? "cancelled" : "plugin-failure",
          options.signal?.aborted
            ? "Configuration validation was cancelled."
            : "The mobile validation plugin failed safely.",
          this.currentAuthority() ?? authority,
        );
      } finally {
        payloadBytes.fill(0);
        this.validationPending = false;
      }
    })();

    if (!options.signal) return validation;

    let settleCancellation: (() => void) | undefined;
    const cancellation = new Promise<MobileConfigValidationResultDto>((resolve) => {
      settleCancellation = () => {
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
    if (this.loadPending) {
      return loadFailure(
        base,
        "duplicate-command",
        "Another configuration load is already pending.",
        this.snapshot,
      );
    }

    this.loadPending = true;
    const payloadBytes = Array.from(configBytes);
    const onAbort = () => {
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
      if (result.snapshot) this.acceptSnapshot(result.snapshot);
      return result;
    } catch {
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
      this.loadPending = false;
    }
  }

  subscribe(handler: (snapshot: MobileVpnSnapshotDto) => void): () => void {
    this.subscribers.add(handler);
    if (this.snapshot) handler(this.snapshot);
    return () => this.subscribers.delete(handler);
  }

  dispose(): void {
    void this.listener?.unregister().catch(() => undefined);
    this.listener = undefined;
    this.baselineAccepted = false;
    this.pendingEvents.length = 0;
    this.subscribers.clear();
  }

  private async runLifecycleCommand(
    command: string,
    kind: "request-notification-permission" | "request-vpn-consent" | "start" | "stop",
    options: { signal?: AbortSignal } = {},
  ): Promise<MobileVpnSnapshotDto> {
    const operationId = `mobile-vpn-${kind}-${Date.now()}-${++this.lifecycleOperationSequence}`;
    const onAbort = () => {
      void this.transport
        .invoke("cancel_lifecycle_operation", { request: { operationId } })
        .then((value) => MobileVpnCommandResultSchema.parse(value))
        .then((value) => this.acceptSnapshot(value.snapshot))
        .catch(() => undefined);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    let result: MobileVpnCommandResultDto;
    try {
      result = MobileVpnCommandResultSchema.parse(
        await this.transport.invoke(command, { request: { operationId } }),
      );
    } finally {
      options.signal?.removeEventListener("abort", onAbort);
    }
    if (result.operation.operationId !== operationId || result.operation.kind !== kind) {
      throw new Error("The mobile VPN lifecycle result identity was invalid.");
    }
    this.acceptSnapshot(result.snapshot);
    return this.snapshot ?? result.snapshot;
  }

  private acceptBaseline(baseline: MobileVpnSnapshotDto): void {
    this.snapshot = baseline;
    this.baselineAccepted = true;
    this.retiredAuthorityIds.clear();
    this.retiredSessionIds.clear();
    for (const subscriber of this.subscribers) subscriber(baseline);
    const pending = this.pendingEvents
      .splice(0)
      .sort((left, right) => left.sequence - right.sequence);
    for (const snapshot of pending) this.acceptSnapshot(snapshot);
  }

  private acceptSnapshot(snapshot: MobileVpnSnapshotDto): void {
    if (!this.baselineAccepted) {
      this.pendingEvents.push(snapshot);
      if (this.pendingEvents.length > 16) this.pendingEvents.shift();
      return;
    }
    if (this.retiredAuthorityIds.has(snapshot.authorityId)) return;
    if (this.retiredSessionIds.has(snapshot.sessionId)) return;
    if (this.snapshot?.authorityId !== snapshot.authorityId) {
      this.retiredAuthorityIds.add(snapshot.authorityId);
      trimSet(this.retiredAuthorityIds);
      return;
    }
    if (snapshot.sequence <= this.snapshot.sequence || snapshot.revision < this.snapshot.revision) {
      return;
    }
    if (this.snapshot.sessionId !== snapshot.sessionId) {
      this.retiredSessionIds.add(this.snapshot.sessionId);
      trimSet(this.retiredSessionIds);
    }
    this.snapshot = snapshot;
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }

  private currentAuthority(): { sequence: number; sessionId: string } | undefined {
    if (!this.snapshot) return undefined;
    return { sequence: this.snapshot.sequence, sessionId: this.snapshot.sessionId };
  }
}

function trimSet(values: Set<string>): void {
  while (values.size > 8) values.delete(values.values().next().value!);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", Uint8Array.from(bytes).buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
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
