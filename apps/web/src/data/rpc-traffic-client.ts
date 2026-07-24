import {
  TrafficClientError,
  mishRpcMethods,
  trafficRpcNotifications,
  type TrafficClient,
  type TrafficCommandAuthorityDto,
  type TrafficCommandOperation,
  type TrafficCommandResultDto,
  type TrafficConnectionState,
  type TrafficDataSnapshotDto,
  type TrafficSnapshotNotificationDto,
} from "@mish/contracts";
import { RpcClient, type RpcConnectionState, type RpcRequestOptions } from "@mish/rpc-client";
import { mapRpcError } from "./rpc-status-client";

export type TrafficRpcClient = RpcClient<typeof mishRpcMethods>;

export class RpcTrafficClient implements TrafficClient {
  private readonly connectionListeners = new Set<(state: TrafficConnectionState) => void>();
  private readonly snapshotListeners = new Set<(snapshot: TrafficDataSnapshotDto) => void>();
  private connectionState: TrafficConnectionState;
  private disposed = false;
  private readonly supportedCommands = new Set<TrafficCommandOperation>();
  private capabilitiesLoaded = false;
  private capabilitiesPromise: Promise<void> | null = null;
  private remoteSubscriptionId: string | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;

  constructor(private readonly rpc: TrafficRpcClient) {
    this.connectionState = mapConnectionState(rpc.getConnectionState());
    this.unsubscribeNotification = rpc.onNotification(
      "traffic.snapshot",
      trafficRpcNotifications["traffic.snapshot"],
      (notification) => this.receiveSnapshot(notification),
    );
    this.unsubscribeRpcConnection = rpc.subscribeConnection((state) =>
      this.receiveConnectionState(state),
    );
  }

  async closeAllActive(
    authority: TrafficCommandAuthorityDto,
    options?: RpcRequestOptions,
  ): Promise<TrafficCommandResultDto> {
    await this.ensureCapabilities();
    try {
      return await this.rpc.request("traffic.closeAllActive", { authority }, options);
    } catch (error) {
      throw toTrafficClientError(error);
    }
  }

  async closeConnection(
    authority: TrafficCommandAuthorityDto,
    connectionId: string,
    options?: RpcRequestOptions,
  ): Promise<TrafficCommandResultDto> {
    await this.ensureCapabilities();
    try {
      return await this.rpc.request(
        "traffic.closeConnection",
        { authority, connectionId },
        options,
      );
    } catch (error) {
      throw toTrafficClientError(error);
    }
  }

  async closeFilteredVisible(
    authority: TrafficCommandAuthorityDto,
    connectionIds: string[],
    options?: RpcRequestOptions,
  ): Promise<TrafficCommandResultDto> {
    await this.ensureCapabilities();
    try {
      return await this.rpc.request(
        "traffic.closeFilteredVisible",
        { authority, connectionIds },
        options,
      );
    } catch (error) {
      throw toTrafficClientError(error);
    }
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribeNotification();
    this.unsubscribeRpcConnection();
    this.connectionListeners.clear();
    this.snapshotListeners.clear();
  }

  getConnectionState() {
    return { ...this.connectionState };
  }

  async getSnapshot(options?: RpcRequestOptions): Promise<TrafficDataSnapshotDto> {
    try {
      await this.ensureCapabilities();
      const snapshot = await this.rpc.request("traffic.getSnapshot", {}, options);
      this.emitConnectionState({ attempt: 0, phase: "connected", stale: false });
      return snapshot;
    } catch (error) {
      throw toTrafficClientError(error);
    }
  }

  subscribeConnection(listener: (state: TrafficConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  supportsCommand(command: TrafficCommandOperation) {
    return this.supportedCommands.has(command);
  }

  subscribeSnapshots(listener: (snapshot: TrafficDataSnapshotDto) => void) {
    this.snapshotListeners.add(listener);
    void this.ensureRemoteSubscription();
    return () => {
      this.snapshotListeners.delete(listener);
      if (this.snapshotListeners.size > 0 || !this.remoteSubscriptionId) return;
      const subscriptionId = this.remoteSubscriptionId;
      this.remoteSubscriptionId = null;
      void this.rpc.request("traffic.unsubscribe", { subscriptionId }).catch(() => undefined);
    };
  }

  private emitConnectionState(state: TrafficConnectionState) {
    this.connectionState = state;
    for (const listener of this.connectionListeners) listener({ ...state });
  }

  private async ensureRemoteSubscription() {
    if (this.disposed || this.snapshotListeners.size === 0 || this.remoteSubscriptionId) return;
    if (this.subscriptionPromise) {
      this.subscriptionRetryPending = true;
      return;
    }

    this.subscriptionPromise = this.ensureCapabilities()
      .then(() => this.rpc.request("traffic.subscribe", {}))
      .then(({ snapshot, subscriptionId }) => {
        if (this.snapshotListeners.size === 0) {
          void this.rpc.request("traffic.unsubscribe", { subscriptionId }).catch(() => undefined);
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
      this.capabilitiesLoaded = false;
      this.remoteSubscriptionId = null;
      this.emitConnectionState({ ...mapped, stale: true });
      void this.ensureRemoteSubscription();
      return;
    }
    this.emitConnectionState(mapped);
  }

  private ensureCapabilities() {
    if (this.capabilitiesLoaded) return Promise.resolve();
    if (this.capabilitiesPromise) return this.capabilitiesPromise;
    this.capabilitiesPromise = this.rpc
      .request("bridge.getInfo", {})
      .then((info) => {
        this.supportedCommands.clear();
        if (info.trafficCommands.closeAllActive) this.supportedCommands.add("close-all-active");
        if (info.trafficCommands.closeConnection) this.supportedCommands.add("close-connection");
        if (info.trafficCommands.closeFilteredVisible) {
          this.supportedCommands.add("close-filtered-visible");
        }
        this.capabilitiesLoaded = true;
      })
      .catch((error) => {
        if (this.disposed) return;
        throw toTrafficClientError(error);
      })
      .finally(() => {
        this.capabilitiesPromise = null;
      });
    return this.capabilitiesPromise;
  }

  private receiveSnapshot(notification: TrafficSnapshotNotificationDto) {
    if (notification.subscriptionId !== this.remoteSubscriptionId) return;
    this.emitConnectionState({ attempt: 0, phase: "connected", stale: false });
    for (const listener of this.snapshotListeners) listener(notification.snapshot);
  }
}

function mapConnectionState(state: RpcConnectionState): TrafficConnectionState {
  if (state.phase === "authenticating" || state.phase === "connecting") {
    return { attempt: state.attempt, phase: "connecting", stale: true };
  }
  return { attempt: state.attempt, phase: state.phase, stale: state.stale };
}

function toTrafficClientError(error: unknown) {
  if (error instanceof TrafficClientError) return error;
  const mapped = mapRpcError(error);
  return new TrafficClientError(mapped.code, mapped.message, mapped.retryable);
}
