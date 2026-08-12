import {
  MobileRouteCommandResultSchema,
  MobileRouteSnapshotSchema,
  StatusClientError,
  type ApplicationSnapshotDelivery,
  type CaptureRecoveryAction,
  type CaptureSelectionDto,
  type LocalProxyTestResultDto,
  type RoutingMode,
  type ServiceMonitorDraft,
  type ServiceProbeIntervalSeconds,
  type StatusClient,
  type StatusCommand,
  type StatusConnectionState,
  type StatusSnapshotDto,
} from "@mish/contracts";
import { invoke } from "@tauri-apps/api/core";

interface MobileStatusTransport {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
}

const transport: MobileStatusTransport = {
  invoke: (command, args) => invoke(`plugin:mish-vpn|${command}`, args),
};

export class MobileStatusClient implements StatusClient {
  private snapshot: StatusSnapshotDto | null = null;
  private authority: {
    profileId: string;
    profileRevision: string;
    runtimeAuthority: string;
  } | null = null;
  private readonly snapshotListeners = new Set<
    (snapshot: StatusSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private readonly connectionListeners = new Set<(state: StatusConnectionState) => void>();
  private disposed = false;
  constructor(
    private readonly native: MobileStatusTransport = transport,
    private readonly createOperationId: () => string = () => `mobile-route-${crypto.randomUUID()}`,
  ) {}

  dispose() {
    this.disposed = true;
    this.snapshotListeners.clear();
    this.connectionListeners.clear();
  }

  getConnectionState(): StatusConnectionState {
    return { attempt: 0, phase: "connected", stale: this.snapshot === null };
  }

  async getSnapshot(options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) throw cancelled();
    const envelope = MobileRouteSnapshotSchema.parse(
      await this.native.invoke("get_route_snapshot"),
    );
    if (this.disposed) throw cancelled();
    const accepted = this.accept(envelope, "baseline");
    return accepted ? envelope.status : (this.snapshot ?? envelope.status);
  }

  supportsCommand(command: StatusCommand) {
    return command === "group";
  }

  async selectGroupChild(groupId: string, childId: string, options?: { signal?: AbortSignal }) {
    const before = this.snapshot ?? (await this.getSnapshot(options));
    const authority = this.authority;
    if (!authority || authority.profileId !== before.activeProfileId) {
      throw new StatusClientError("runtime-replaced", "The mobile Route baseline is stale");
    }
    const group = before.groups.find((candidate) => candidate.id === groupId);
    if (!group?.selectedChildId) {
      throw new StatusClientError("stale-membership", "The policy-group relation is stale");
    }
    const operationId = this.createOperationId();
    const onAbort = () => {
      void this.native.invoke("cancel_route_selection", { request: { operationId } });
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      if (options?.signal?.aborted) {
        await this.native.invoke("cancel_route_selection", { request: { operationId } });
        throw cancelled();
      }
      const result = MobileRouteCommandResultSchema.parse(
        await this.native.invoke("select_route_child", {
          request: {
            childId,
            currentChildId: group.selectedChildId,
            groupId,
            operationId,
            profileId: authority.profileId,
            profileRevision: authority.profileRevision,
            runtimeAuthority: authority.runtimeAuthority,
          },
        }),
      );
      if (this.disposed) throw cancelled();
      if (
        this.authority?.runtimeAuthority !== authority.runtimeAuthority ||
        this.authority.profileId !== authority.profileId ||
        this.authority.profileRevision !== authority.profileRevision
      ) {
        throw new StatusClientError(
          "runtime-replaced",
          "The mobile runtime was replaced while Route selection was pending",
          false,
          this.snapshot,
        );
      }
      const accepted = this.accept(result.snapshot, "update");
      if (result.status === "success") {
        return accepted ? result.snapshot.status : (this.snapshot ?? result.snapshot.status);
      }
      throw new StatusClientError(
        mapFailure(result.failure),
        "Mobile Route selection failed",
        false,
        result.snapshot.status,
      );
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  subscribeConnection(listener: (state: StatusConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  subscribeSnapshots(
    listener: (snapshot: StatusSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ) {
    this.snapshotListeners.add(listener);
    if (this.snapshot) listener(this.snapshot, "baseline");
    return () => this.snapshotListeners.delete(listener);
  }

  private accept(
    envelope: {
      profileId: string;
      profileRevision: string;
      runtimeAuthority: string;
      status: StatusSnapshotDto;
    },
    delivery: ApplicationSnapshotDelivery,
  ) {
    const snapshot = envelope.status;
    if (
      envelope.profileId !== snapshot.activeProfileId ||
      envelope.runtimeAuthority !== snapshot.applicationOrder.authorityId
    ) {
      throw new StatusClientError(
        "protocol",
        "The mobile Route authority envelope is inconsistent",
      );
    }
    if (
      this.snapshot &&
      this.authority?.profileId === envelope.profileId &&
      this.authority.profileRevision === envelope.profileRevision &&
      this.authority.runtimeAuthority === envelope.runtimeAuthority &&
      snapshot.applicationOrder.authorityId === this.snapshot.applicationOrder.authorityId &&
      snapshot.applicationOrder.epoch === this.snapshot.applicationOrder.epoch &&
      snapshot.applicationOrder.order <= this.snapshot.applicationOrder.order
    )
      return false;
    this.authority = {
      profileId: envelope.profileId,
      profileRevision: envelope.profileRevision,
      runtimeAuthority: envelope.runtimeAuthority,
    };
    this.snapshot = snapshot;
    for (const listener of this.snapshotListeners) listener(snapshot, delivery);
    for (const listener of this.connectionListeners) listener(this.getConnectionState());
    return true;
  }

  removeServiceMonitor = unsupported;
  recoverSystemProxy = unsupported as (
    _action: CaptureRecoveryAction,
    _options?: { signal?: AbortSignal },
  ) => Promise<StatusSnapshotDto>;
  restoreDefaultServices = unsupported;
  startGroupDelayTest = unsupported as (
    _groupId: string,
    _options?: { signal?: AbortSignal },
  ) => Promise<StatusSnapshotDto>;
  testServiceMonitor = unsupported as (
    _monitorId: string,
    _options?: { signal?: AbortSignal },
  ) => Promise<StatusSnapshotDto>;
  testLocalProxy = unsupported as (_options?: {
    signal?: AbortSignal;
  }) => Promise<LocalProxyTestResultDto>;
  cancelGroupDelayTest = unsupported as (
    _testId: string,
    _options?: { signal?: AbortSignal },
  ) => Promise<StatusSnapshotDto>;
  setActiveProfile = unsupported as (
    _profileId: string,
    _options?: { signal?: AbortSignal },
  ) => Promise<StatusSnapshotDto>;
  setCapture = unsupported as (
    _selection: CaptureSelectionDto,
    _active: boolean,
    _options?: { signal?: AbortSignal },
  ) => Promise<StatusSnapshotDto>;
  setRoutingMode = unsupported as (
    _mode: RoutingMode,
    _options?: { signal?: AbortSignal },
  ) => Promise<StatusSnapshotDto>;
  setServiceProbeInterval = unsupported as (
    _interval: ServiceProbeIntervalSeconds,
    _options?: { signal?: AbortSignal },
  ) => Promise<StatusSnapshotDto>;
  upsertServiceMonitor = unsupported as (
    _draft: ServiceMonitorDraft,
    _options?: { signal?: AbortSignal },
  ) => Promise<StatusSnapshotDto>;
}

function unsupported(): Promise<never> {
  return Promise.reject(
    new StatusClientError("unsupported", "This mobile Status command is unavailable"),
  );
}

function cancelled() {
  return new StatusClientError("cancelled", "The mobile Status command was cancelled");
}

function mapFailure(failure: string | null) {
  switch (failure) {
    case "cancelled":
      return "cancelled" as const;
    case "runtime-replaced":
      return "runtime-replaced" as const;
    case "invalid-relation":
      return "stale-membership" as const;
    case "stale-authority":
      return "runtime-replaced" as const;
    case "duplicate-conflict":
      return "conflict" as const;
    case "invalid-input":
      return "invalid-request" as const;
    default:
      return "rejected" as const;
  }
}
