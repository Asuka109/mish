import {
  StatusClientError,
  statusRpcMethods,
  statusRpcNotifications,
  type CaptureSelectionDto,
  type RoutingMode,
  type ServiceMonitorDraft,
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

export type StatusRpcClient = RpcClient<typeof statusRpcMethods>;

export class RpcStatusClient implements StatusClient {
  private readonly connectionListeners = new Set<(state: StatusConnectionState) => void>();
  private readonly snapshotListeners = new Set<(snapshot: StatusSnapshotDto) => void>();
  private connectionState: StatusConnectionState;
  private disposed = false;
  private remoteSubscriptionId: string | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;

  constructor(private readonly rpc: StatusRpcClient) {
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

  restoreDefaultServices(options?: RpcRequestOptions) {
    return this.requestSnapshot("status.restoreDefaultServices", {}, options);
  }

  selectGroupChild(groupId: string, childId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("status.selectGroupChild", { childId, groupId }, options);
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

  subscribeConnection(listener: (state: StatusConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  subscribeSnapshots(listener: (snapshot: StatusSnapshotDto) => void) {
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

  supportsCommand(_command: StatusCommand) {
    return false;
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
        this.receiveSnapshot({ snapshot, subscriptionId });
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
      this.remoteSubscriptionId = null;
      this.emitConnectionState({ ...mapped, stale: true });
      void this.ensureRemoteSubscription();
      return;
    }
    this.emitConnectionState(mapped);
  }

  private receiveSnapshot(notification: StatusSnapshotNotificationDto) {
    if (notification.subscriptionId !== this.remoteSubscriptionId) return;
    this.emitConnectionState({ attempt: 0, phase: "connected", stale: false });
    for (const listener of this.snapshotListeners) listener(notification.snapshot);
  }

  private async requestSnapshot<
    Method extends
      | "status.getSnapshot"
      | "status.removeServiceMonitor"
      | "status.restoreDefaultServices"
      | "status.selectGroupChild"
      | "status.setActiveProfile"
      | "status.setCapture"
      | "status.setRoutingMode"
      | "status.upsertServiceMonitor",
  >(
    method: Method,
    params: Parameters<StatusRpcClient["request"]>[1],
    options?: RpcRequestOptions,
  ): Promise<StatusSnapshotDto> {
    try {
      const snapshot = await this.rpc.request(method, params as never, options);
      this.emitConnectionState({ attempt: 0, phase: "connected", stale: false });
      return snapshot;
    } catch (error) {
      throw mapRpcError(error);
    }
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

function mapRpcError(error: unknown) {
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
