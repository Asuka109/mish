import {
  UpdaterClientError,
  mishRpcMethods,
  updaterRpcNotifications,
  type StatusConnectionState,
  type UpdateChannel,
  type UpdaterClient,
  type UpdaterSnapshotDto,
  type UpdaterSnapshotNotificationDto,
} from "@mish/contracts";
import {
  RpcClient,
  RpcRemoteError,
  type RpcConnectionState,
  type RpcRequestOptions,
} from "@mish/rpc-client";
import { mapRpcError } from "./rpc-status-client";

type UpdaterRpcClient = RpcClient<typeof mishRpcMethods>;

export class RpcUpdaterClient implements UpdaterClient {
  private readonly connectionListeners = new Set<(state: StatusConnectionState) => void>();
  private readonly snapshotListeners = new Set<(snapshot: UpdaterSnapshotDto) => void>();
  private acceptedSnapshot: UpdaterSnapshotDto | null = null;
  private connectionState: StatusConnectionState;
  private disposed = false;
  private remoteSubscriptionId: string | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;

  constructor(private readonly rpc: UpdaterRpcClient) {
    this.connectionState = mapConnectionState(rpc.getConnectionState());
    this.unsubscribeNotification = rpc.onNotification(
      "updater.snapshot",
      updaterRpcNotifications["updater.snapshot"],
      (notification) => this.receiveSnapshot(notification),
    );
    this.unsubscribeRpcConnection = rpc.subscribeConnection((state) =>
      this.receiveConnectionState(state),
    );
  }

  cancel(operationId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("updater.cancel", { operationId }, options);
  }

  check(operationId: string, channel: UpdateChannel, options?: RpcRequestOptions) {
    return this.requestSnapshot("updater.check", { channel, operationId }, options);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeNotification();
    this.unsubscribeRpcConnection();
    this.connectionListeners.clear();
    this.snapshotListeners.clear();
    if (!this.remoteSubscriptionId) return;
    const subscriptionId = this.remoteSubscriptionId;
    this.remoteSubscriptionId = null;
    void this.rpc.request("updater.unsubscribe", { subscriptionId }).catch(() => undefined);
  }

  download(operationId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("updater.download", { operationId }, options);
  }

  getConnectionState() {
    return { ...this.connectionState };
  }

  getSnapshot(options?: RpcRequestOptions) {
    return this.requestSnapshot("updater.getSnapshot", {}, options);
  }

  subscribeConnection(listener: (state: StatusConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  subscribeSnapshots(listener: (snapshot: UpdaterSnapshotDto) => void) {
    this.snapshotListeners.add(listener);
    void this.ensureRemoteSubscription();
    return () => {
      this.snapshotListeners.delete(listener);
      if (this.snapshotListeners.size > 0 || !this.remoteSubscriptionId) return;
      const subscriptionId = this.remoteSubscriptionId;
      this.remoteSubscriptionId = null;
      void this.rpc.request("updater.unsubscribe", { subscriptionId }).catch(() => undefined);
    };
  }

  private async requestSnapshot(
    method: "updater.cancel" | "updater.check" | "updater.download" | "updater.getSnapshot",
    params:
      | { channel: UpdateChannel; operationId: string }
      | { operationId: string }
      | Record<string, never>,
    options?: RpcRequestOptions,
  ) {
    try {
      const snapshot = await this.rpc.request(method, params, options);
      return this.acceptSnapshot(snapshot);
    } catch (error) {
      throw mapUpdaterError(error);
    }
  }

  private acceptSnapshot(snapshot: UpdaterSnapshotDto) {
    const accepted = this.acceptedSnapshot;
    if (
      !accepted ||
      snapshot.authorityId !== accepted.authorityId ||
      snapshot.revision > accepted.revision
    ) {
      this.acceptedSnapshot = structuredClone(snapshot);
      return snapshot;
    }
    return structuredClone(accepted);
  }

  private emitConnectionState(state: StatusConnectionState) {
    this.connectionState = state;
    for (const listener of this.connectionListeners) listener({ ...state });
  }

  private async ensureRemoteSubscription() {
    if (this.disposed || this.snapshotListeners.size === 0 || this.remoteSubscriptionId) return;
    if (this.subscriptionPromise) {
      this.subscriptionRetryPending = true;
      return;
    }
    this.subscriptionPromise = this.rpc
      .request("updater.subscribe", {})
      .then(({ snapshot, subscriptionId }) => {
        if (this.snapshotListeners.size === 0) {
          void this.rpc.request("updater.unsubscribe", { subscriptionId }).catch(() => undefined);
          return;
        }
        this.remoteSubscriptionId = subscriptionId;
        this.receiveSnapshot({ snapshot, subscriptionId });
      })
      .catch(() => {
        if (this.connectionState.phase !== "connected") return;
        this.emitConnectionState({ ...this.connectionState, stale: true });
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

  private receiveSnapshot(notification: UpdaterSnapshotNotificationDto) {
    if (notification.subscriptionId !== this.remoteSubscriptionId) return;
    const snapshot = this.acceptSnapshot(notification.snapshot);
    this.emitConnectionState({ attempt: 0, phase: "connected", stale: false });
    if (
      snapshot.authorityId !== notification.snapshot.authorityId ||
      snapshot.revision !== notification.snapshot.revision
    ) {
      return;
    }
    for (const listener of this.snapshotListeners) listener(snapshot);
  }
}

function mapConnectionState(state: RpcConnectionState): StatusConnectionState {
  if (
    state.phase === "authenticating" ||
    state.phase === "connecting" ||
    state.phase === "negotiating"
  ) {
    return { attempt: state.attempt, phase: "connecting", stale: true };
  }
  return { attempt: state.attempt, phase: state.phase, stale: state.stale };
}

function mapUpdaterError(error: unknown) {
  const mapped = mapRpcError(error);
  const kind =
    error instanceof RpcRemoteError &&
    error.data &&
    typeof error.data === "object" &&
    "kind" in error.data &&
    typeof error.data.kind === "string"
      ? error.data.kind
      : null;
  return new UpdaterClientError(mapped.code, mapped.message, mapped.retryable, kind);
}
