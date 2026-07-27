import {
  MobileConfigValidationResultSchema,
  MobileVpnEventSchema,
  MobileVpnSnapshotSchema,
  type MobileConfigValidationFailure,
  type MobileConfigValidationResultDto,
  type MobileVpnSnapshotDto,
} from "@mish/contracts";
import { addPluginListener, invoke, type PluginListener } from "@tauri-apps/api/core";

export const MOBILE_CORE_MAX_CONFIG_BYTES_V1 = 1_048_576;

interface MobileVpnTransport {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(handler: (payload: unknown) => void): Promise<PluginListener>;
}

interface MobileConfigValidationOptions {
  signal?: AbortSignal;
}

export interface MobileVpnClient {
  dispose(): void;
  getSnapshot(): MobileVpnSnapshotDto | undefined;
  initialize(): Promise<MobileVpnSnapshotDto>;
  requestNotificationPermission(): Promise<MobileVpnSnapshotDto>;
  requestVpnConsent(): Promise<MobileVpnSnapshotDto>;
  startFixtureLifecycle(): Promise<MobileVpnSnapshotDto>;
  stop(): Promise<MobileVpnSnapshotDto>;
  subscribe(handler: (snapshot: MobileVpnSnapshotDto) => void): () => void;
  validateConfig(
    configBytes: Uint8Array,
    options?: MobileConfigValidationOptions,
  ): Promise<MobileConfigValidationResultDto>;
}

const defaultTransport: MobileVpnTransport = {
  invoke: (command, args) => invoke(`plugin:mish-vpn|${command}`, args),
  listen: (handler) => addPluginListener("mish-vpn", "snapshot", handler),
};

export class MobileVpnFixtureClient implements MobileVpnClient {
  private validationPending = false;
  private listener?: PluginListener;
  private snapshot?: MobileVpnSnapshotDto;
  private readonly subscribers = new Set<(snapshot: MobileVpnSnapshotDto) => void>();

  constructor(private readonly transport: MobileVpnTransport = defaultTransport) {}

  async initialize(): Promise<MobileVpnSnapshotDto> {
    if (!this.listener) {
      this.listener = await this.transport.listen((payload) => {
        const event = MobileVpnEventSchema.parse(payload);
        this.acceptSnapshot(event.snapshot);
      });
    }
    return this.runCommand("get_snapshot");
  }

  getSnapshot(): MobileVpnSnapshotDto | undefined {
    return this.snapshot;
  }

  requestNotificationPermission(): Promise<MobileVpnSnapshotDto> {
    return this.runCommand("request_notification_permission");
  }

  requestVpnConsent(): Promise<MobileVpnSnapshotDto> {
    return this.runCommand("request_vpn_consent");
  }

  startFixtureLifecycle(): Promise<MobileVpnSnapshotDto> {
    return this.runCommand("start_fixture_lifecycle");
  }

  stop(): Promise<MobileVpnSnapshotDto> {
    return this.runCommand("stop");
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

  subscribe(handler: (snapshot: MobileVpnSnapshotDto) => void): () => void {
    this.subscribers.add(handler);
    if (this.snapshot) handler(this.snapshot);
    return () => this.subscribers.delete(handler);
  }

  dispose(): void {
    void this.listener?.unregister().catch(() => undefined);
    this.listener = undefined;
    this.subscribers.clear();
  }

  private async runCommand(command: string): Promise<MobileVpnSnapshotDto> {
    const snapshot = MobileVpnSnapshotSchema.parse(await this.transport.invoke(command));
    this.acceptSnapshot(snapshot);
    return this.snapshot ?? snapshot;
  }

  private acceptSnapshot(snapshot: MobileVpnSnapshotDto): void {
    if (this.snapshot && snapshot.sequence <= this.snapshot.sequence) return;
    this.snapshot = snapshot;
    for (const subscriber of this.subscribers) subscriber(snapshot);
  }

  private currentAuthority(): { sequence: number; sessionId: string } | undefined {
    if (!this.snapshot) return undefined;
    return { sequence: this.snapshot.sequence, sessionId: this.snapshot.sessionId };
  }
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
