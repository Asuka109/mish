import {
  StatusClientError,
  mishRpcMethods,
  statusRpcNotifications,
  type ApplicationSnapshotDelivery,
  type CaptureSelectionDto,
  type CaptureOperationStatusDto,
  type CaptureRecoveryAction,
  type LocalProxyTestResultDto,
  type RecentTrafficSnapshotDto,
  type RoutingMode,
  type ServiceMonitorDraft,
  type ServiceProbeIntervalSeconds,
  type StatusClient,
  type StatusConnectionState,
  type StatusCommand,
  type StatusSnapshotDto,
  type StatusSnapshotNotificationDto,
} from "@mish/contracts";
import {
  RpcCancelledError,
  RpcClient,
  RpcDisconnectedError,
  RpcDisposedError,
  RpcMessageTooLargeError,
  RpcProtocolError,
  RpcRemoteError,
  RpcValidationError,
  type RpcConnectionState,
  type RpcRequestOptions,
} from "@mish/rpc-client";
import { ApplicationSnapshotAcceptance } from "./application-snapshot-acceptance";

export type StatusRpcClient = RpcClient<typeof mishRpcMethods>;

export class RpcStatusClient implements StatusClient {
  private readonly connectionListeners = new Set<(state: StatusConnectionState) => void>();
  private readonly snapshotListeners = new Set<
    (snapshot: StatusSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private connectionState: StatusConnectionState;
  private disposed = false;
  private remoteSubscriptionId: string | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;
  private capabilityPendingProfileId: string | null = null;
  private capabilityPromise: Promise<void> | null = null;
  private capabilityProfileId: string | null = null;
  private capabilitiesLoaded = false;
  private acceptedRecentTraffic: RecentTrafficSnapshotDto | null = null;
  private acceptedCaptureOperation: CaptureOperationStatusDto | null = null;
  private acceptedCaptureProjection: StatusSnapshotDto["runtime"] | null = null;
  private readonly retiredCaptureScopes: string[] = [];
  private readonly snapshotAcceptance = new ApplicationSnapshotAcceptance<StatusSnapshotDto>();
  private readonly supportedCommands = new Set<StatusCommand>();

  constructor(
    private readonly rpc: StatusRpcClient,
    private readonly discoverCommandCapabilities = false,
  ) {
    this.connectionState = mapConnectionState(rpc.getConnectionState());
    this.unsubscribeNotification = rpc.onNotification(
      "status.snapshot",
      statusRpcNotifications["status.snapshot"],
      (notification) => this.receiveSnapshot(notification),
    );
    this.unsubscribeRpcConnection = rpc.subscribeConnection((state) =>
      this.receiveConnectionState(state),
    );
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeNotification();
    this.unsubscribeRpcConnection();
    this.connectionListeners.clear();
    this.snapshotListeners.clear();
    this.rpc.dispose();
  }

  getConnectionState() {
    return { ...this.connectionState };
  }

  getSnapshot(options?: RpcRequestOptions) {
    return this.requestSnapshot("status.getSnapshot", {}, options);
  }

  removeServiceMonitor(monitorId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("status.removeServiceMonitor", { monitorId }, options);
  }

  recoverSystemProxy(action: CaptureRecoveryAction, options?: RpcRequestOptions) {
    return this.requestSnapshot("status.recoverSystemProxy", { action }, options);
  }

  restoreDefaultServices(options?: RpcRequestOptions) {
    return this.requestSnapshot("status.restoreDefaultServices", {}, options);
  }

  selectGroupChild(groupId: string, childId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("status.selectGroupChild", { childId, groupId }, options);
  }

  startGroupDelayTest(groupId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("status.startGroupDelayTest", { groupId }, options);
  }

  testServiceMonitor(monitorId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("status.testServiceMonitor", { monitorId }, options);
  }

  cancelGroupDelayTest(testId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("status.cancelGroupDelayTest", { testId }, options);
  }

  setActiveProfile(profileId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("status.setActiveProfile", { profileId }, options);
  }

  setCapture(selection: CaptureSelectionDto, active: boolean, options?: RpcRequestOptions) {
    return this.requestSnapshot("status.setCapture", { active, selection }, options);
  }

  setRoutingMode(mode: RoutingMode, options?: RpcRequestOptions) {
    return this.requestSnapshot("status.setRoutingMode", { mode }, options);
  }

  setServiceProbeInterval(
    intervalSeconds: ServiceProbeIntervalSeconds,
    options?: RpcRequestOptions,
  ) {
    return this.requestSnapshot("status.setServiceProbeInterval", { intervalSeconds }, options);
  }

  async testLocalProxy(options?: RpcRequestOptions): Promise<LocalProxyTestResultDto> {
    try {
      const result = await this.rpc.request("status.testLocalProxy", {}, options);
      this.emitSnapshotConnectionState();
      return result;
    } catch (error) {
      throw mapRpcError(error);
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
    void this.ensureRemoteSubscription();
    return () => {
      this.snapshotListeners.delete(listener);
      if (this.snapshotListeners.size > 0 || !this.remoteSubscriptionId) return;
      const subscriptionId = this.remoteSubscriptionId;
      this.remoteSubscriptionId = null;
      void this.rpc.request("status.unsubscribe", { subscriptionId }).catch(() => undefined);
    };
  }

  supportsCommand(command: StatusCommand) {
    return command === "capture" || this.supportedCommands.has(command);
  }

  upsertServiceMonitor(draft: ServiceMonitorDraft, options?: RpcRequestOptions) {
    return this.requestSnapshot("status.upsertServiceMonitor", { draft }, options);
  }

  private emitConnectionState(state: StatusConnectionState) {
    this.connectionState = state;
    for (const listener of this.connectionListeners) listener({ ...state });
  }

  private async ensureRemoteSubscription() {
    if (this.disposed || this.snapshotListeners.size === 0 || this.remoteSubscriptionId) {
      return;
    }
    if (this.subscriptionPromise) {
      this.subscriptionRetryPending = true;
      return;
    }

    this.subscriptionPromise = this.rpc
      .request("status.subscribe", {})
      .then(({ snapshot, subscriptionId }) => {
        if (this.snapshotListeners.size === 0) {
          void this.rpc.request("status.unsubscribe", { subscriptionId }).catch(() => undefined);
          return;
        }
        this.remoteSubscriptionId = subscriptionId;
        this.receiveSnapshot({ snapshot, subscriptionId }, "baseline");
      })
      .catch(() => {
        if (this.connectionState.phase === "connected") {
          this.emitConnectionState({ ...this.connectionState, stale: true });
        }
      })
      .finally(() => {
        this.subscriptionPromise = null;
        if (!this.subscriptionRetryPending) return;
        this.subscriptionRetryPending = false;
        void this.ensureRemoteSubscription();
      });
    await this.subscriptionPromise;
  }

  private receiveConnectionState(state: RpcConnectionState) {
    const mapped = mapConnectionState(state);
    if (mapped.phase === "connected") {
      this.snapshotAcceptance.armReconnect();
      this.remoteSubscriptionId = null;
      this.capabilitiesLoaded = false;
      this.capabilityPendingProfileId = null;
      this.capabilityProfileId = null;
      this.supportedCommands.clear();
      this.emitConnectionState({ ...mapped, stale: true });
      void this.ensureRemoteSubscription();
      return;
    }
    this.emitConnectionState(mapped);
  }

  private receiveSnapshot(
    notification: StatusSnapshotNotificationDto,
    delivery: ApplicationSnapshotDelivery = "update",
  ) {
    if (notification.subscriptionId !== this.remoteSubscriptionId) return;
    const result = this.snapshotAcceptance.accept(notification.snapshot, delivery);
    if (result.kind === "conflict") {
      this.emitConnectionState({ ...this.connectionState, stale: true });
      return;
    }
    if (result.kind === "duplicate") this.snapshotAcceptance.completeReconnect();
    this.emitSnapshotConnectionState();
    if (result.kind !== "accepted") return;
    const snapshot = this.acceptSnapshot(result.snapshot);
    for (const listener of this.snapshotListeners) listener(snapshot, delivery);
    void this.ensureCommandCapabilities(snapshot.activeProfileId);
  }

  private acceptRecentTraffic(snapshot: StatusSnapshotDto): StatusSnapshotDto {
    const incoming = snapshot.recentTraffic;
    const accepted = this.acceptedRecentTraffic;
    if (
      !accepted ||
      incoming.authorityId !== accepted.authorityId ||
      incoming.revision > accepted.revision
    ) {
      this.acceptedRecentTraffic = structuredClone(incoming);
      return snapshot;
    }
    return { ...snapshot, recentTraffic: structuredClone(accepted) };
  }

  private acceptSnapshot(snapshot: StatusSnapshotDto): StatusSnapshotDto {
    return this.acceptCaptureOperation(this.acceptRecentTraffic(snapshot));
  }

  private acceptCaptureOperation(snapshot: StatusSnapshotDto): StatusSnapshotDto {
    const incoming = snapshot.runtime.captureOperation;
    const accepted = this.acceptedCaptureOperation;
    if (!accepted) {
      this.rememberCaptureProjection(snapshot);
      return snapshot;
    }

    if (incoming.scopeEpoch !== accepted.scopeEpoch) {
      if (this.retiredCaptureScopes.includes(incoming.scopeEpoch)) {
        return this.withAcceptedCaptureProjection(snapshot);
      }
      this.retiredCaptureScopes.push(accepted.scopeEpoch);
      if (this.retiredCaptureScopes.length > 8) this.retiredCaptureScopes.shift();
      this.rememberCaptureProjection(snapshot);
      return snapshot;
    }

    const incomingId = captureOperationId(incoming);
    const acceptedId = captureOperationId(accepted);
    if (incomingId > acceptedId) {
      this.rememberCaptureProjection(snapshot);
      return snapshot;
    }
    if (incomingId < acceptedId) return this.withAcceptedCaptureProjection(snapshot);

    const incomingRank = captureOperationPhaseRank(incoming.phase);
    const acceptedRank = captureOperationPhaseRank(accepted.phase);
    if (
      incomingRank > acceptedRank ||
      (incomingRank === acceptedRank && incoming.phase === accepted.phase)
    ) {
      this.rememberCaptureProjection(snapshot);
      return snapshot;
    }
    return this.withAcceptedCaptureProjection(snapshot);
  }

  private rememberCaptureProjection(snapshot: StatusSnapshotDto) {
    this.acceptedCaptureOperation = structuredClone(snapshot.runtime.captureOperation);
    this.acceptedCaptureProjection = structuredClone(snapshot.runtime);
  }

  private withAcceptedCaptureProjection(snapshot: StatusSnapshotDto): StatusSnapshotDto {
    if (!this.acceptedCaptureProjection) return snapshot;
    return { ...snapshot, runtime: structuredClone(this.acceptedCaptureProjection) };
  }

  private async ensureCommandCapabilities(profileId: string) {
    if (
      !this.discoverCommandCapabilities ||
      this.disposed ||
      (this.capabilitiesLoaded && this.capabilityProfileId === profileId)
    ) {
      return;
    }

    if (this.capabilityPendingProfileId !== profileId) {
      this.capabilityPendingProfileId = profileId;
      this.capabilitiesLoaded = false;
      this.capabilityProfileId = null;
      this.supportedCommands.clear();
      this.emitConnectionState(this.getConnectionState());
    }
    if (this.capabilityPromise) return;

    const requestedProfileId = this.capabilityPendingProfileId;
    this.capabilityPromise = this.rpc
      .request("bridge.getInfo", {})
      .then((info) => {
        if (this.disposed || this.capabilityPendingProfileId !== requestedProfileId) return;
        this.supportedCommands.clear();
        this.capabilitiesLoaded = true;
        this.capabilityProfileId = requestedProfileId;
        if (info.statusCommands.group) this.supportedCommands.add("group");
        if (info.statusCommands.groupDelay) this.supportedCommands.add("group-delay");
        if (info.statusCommands.routing) this.supportedCommands.add("routing");
        if (info.statusCommands.services) this.supportedCommands.add("services");
        this.emitConnectionState(this.getConnectionState());
      })
      .catch(() => undefined)
      .finally(() => {
        this.capabilityPromise = null;
        if (
          !this.disposed &&
          this.capabilityPendingProfileId !== requestedProfileId &&
          this.capabilityPendingProfileId !== null
        ) {
          void this.ensureCommandCapabilities(this.capabilityPendingProfileId);
        }
      });
    await this.capabilityPromise;
  }

  private async requestSnapshot<
    Method extends
      | "status.getSnapshot"
      | "status.cancelGroupDelayTest"
      | "status.removeServiceMonitor"
      | "status.recoverSystemProxy"
      | "status.restoreDefaultServices"
      | "status.selectGroupChild"
      | "status.startGroupDelayTest"
      | "status.testServiceMonitor"
      | "status.setActiveProfile"
      | "status.setCapture"
      | "status.setRoutingMode"
      | "status.setServiceProbeInterval"
      | "status.upsertServiceMonitor",
  >(
    method: Method,
    params: Parameters<StatusRpcClient["request"]>[1],
    options?: RpcRequestOptions,
  ): Promise<StatusSnapshotDto> {
    try {
      const delivery = method === "status.getSnapshot" ? "request" : "command";
      const result = this.snapshotAcceptance.accept(
        await this.rpc.request(method, params as never, options),
        delivery,
      );
      if (result.kind === "conflict") {
        throw new StatusClientError("validation", "Status snapshot order conflict");
      }
      if (result.kind === "duplicate") this.snapshotAcceptance.completeReconnect();
      const snapshot = this.acceptSnapshot(result.snapshot);
      this.emitSnapshotConnectionState();
      void this.ensureCommandCapabilities(snapshot.activeProfileId);
      return snapshot;
    } catch (error) {
      throw mapRpcError(error);
    }
  }

  private emitSnapshotConnectionState() {
    this.emitConnectionState({
      attempt: 0,
      phase: "connected",
      stale: this.snapshotAcceptance.isReconnectPending(),
    });
  }
}

function captureOperationId(operation: CaptureOperationStatusDto) {
  return operation.operationId === null ? 0n : BigInt(operation.operationId);
}

function captureOperationPhaseRank(phase: CaptureOperationStatusDto["phase"]) {
  switch (phase) {
    case "idle":
      return 0;
    case "pending":
      return 1;
    case "applied":
    case "failed":
      return 2;
    case "recovery-required":
      return 3;
  }
}

function mapConnectionState(state: RpcConnectionState): StatusConnectionState {
  if (state.phase === "authenticating" || state.phase === "connecting") {
    return { attempt: state.attempt, phase: "connecting", stale: true };
  }
  return {
    attempt: state.attempt,
    phase: state.phase,
    stale: state.stale,
  };
}

export function mapRpcError(error: unknown) {
  if (error instanceof StatusClientError) return error;
  if (error instanceof RpcCancelledError) {
    return new StatusClientError("cancelled", error.message);
  }
  if (error instanceof RpcDisconnectedError || error instanceof RpcDisposedError) {
    return new StatusClientError("disconnected", error.message, true);
  }
  if (error instanceof RpcValidationError) {
    return new StatusClientError("validation", error.message);
  }
  if (error instanceof RpcMessageTooLargeError || error instanceof RpcProtocolError) {
    return new StatusClientError("protocol", error.message);
  }
  if (error instanceof RpcRemoteError) {
    const kind =
      error.data && typeof error.data === "object" && "kind" in error.data
        ? (error.data as { kind?: unknown }).kind
        : undefined;
    if (kind === "unsupported") return new StatusClientError("unsupported", error.message);
    if (kind === "unsupported-group") {
      return new StatusClientError("unsupported", error.message);
    }
    if (kind === "invalid-request") {
      return new StatusClientError("invalid-request", error.message);
    }
    if (kind === "not-found") return new StatusClientError("not-found", error.message);
    if (kind === "conflict") return new StatusClientError("conflict", error.message, true);
    if (kind === "disconnected") {
      return new StatusClientError("disconnected", error.message, true);
    }
    if (kind === "cancelled") return new StatusClientError("cancelled", error.message);
    if (kind === "rejected") return new StatusClientError("rejected", error.message);
    if (kind === "runtime-replaced") {
      return new StatusClientError("runtime-replaced", error.message, true);
    }
    if (kind === "stale-membership") {
      return new StatusClientError("stale-membership", error.message, true);
    }
    if (kind === "timeout") return new StatusClientError("timeout", error.message, true);
    if (kind === "version-drift") {
      return new StatusClientError("version-drift", error.message);
    }
    if (kind === "inconsistent-observation") {
      return new StatusClientError("inconsistent-observation", error.message, true);
    }
    if (error.code === -32_602) {
      return new StatusClientError("invalid-request", error.message);
    }
    if (error.code === -32_004) {
      return new StatusClientError("not-found", error.message);
    }
    if (error.code === -32_009) {
      return new StatusClientError("conflict", error.message, true);
    }
    const retryable = error.code >= -32_099 && error.code <= -32_000;
    return new StatusClientError("remote", error.message, retryable);
  }
  if (error instanceof Error) {
    return new StatusClientError("unknown", error.message);
  }
  return new StatusClientError("unknown", "Unknown RPC client failure");
}
