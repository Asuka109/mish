import {
  EventsClientError,
  eventsRpcNotifications,
  mishRpcMethods,
  type ApplicationSnapshotDelivery,
  type EventsClient,
  type EventsConnectionState,
  type EventsSnapshotDto,
  type EventsSnapshotNotificationDto,
} from "@mish/contracts";
import { RpcClient, type RpcConnectionState, type RpcRequestOptions } from "@mish/rpc-client";
import { ApplicationSnapshotAcceptance } from "./application-snapshot-acceptance";
import { mapRpcError } from "./rpc-status-client";

export type EventsRpcClient = RpcClient<typeof mishRpcMethods>;

export class RpcEventsClient implements EventsClient {
  private readonly connectionListeners = new Set<(state: EventsConnectionState) => void>();
  private readonly snapshotListeners = new Set<
    (snapshot: EventsSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private connectionState: EventsConnectionState;
  private disposed = false;
  private remoteSubscriptionId: string | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;
  private readonly snapshotAcceptance = new ApplicationSnapshotAcceptance<EventsSnapshotDto>();

  constructor(private readonly rpc: EventsRpcClient) {
    this.connectionState = mapConnectionState(rpc.getConnectionState());
    this.unsubscribeNotification = rpc.onNotification(
      "events.snapshot",
      eventsRpcNotifications["events.snapshot"],
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
  }

  getConnectionState() {
    return { ...this.connectionState };
  }

  async getSnapshot(options?: RpcRequestOptions): Promise<EventsSnapshotDto> {
    try {
      const result = this.snapshotAcceptance.accept(
        await this.rpc.request("events.getSnapshot", {}, options),
        "request",
      );
      if (result.kind === "conflict") {
        throw new EventsClientError("validation", "Events snapshot order conflict");
      }
      this.emitSnapshotConnectionState();
      return result.snapshot;
    } catch (error) {
      const mapped = mapRpcError(error);
      throw new EventsClientError(mapped.code, mapped.message, mapped.retryable);
    }
  }

  subscribeConnection(listener: (state: EventsConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  subscribeSnapshots(
    listener: (snapshot: EventsSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ) {
    this.snapshotListeners.add(listener);
    void this.ensureRemoteSubscription();
    return () => {
      this.snapshotListeners.delete(listener);
      if (this.snapshotListeners.size > 0 || !this.remoteSubscriptionId) return;
      const subscriptionId = this.remoteSubscriptionId;
      this.remoteSubscriptionId = null;
      void this.rpc.request("events.unsubscribe", { subscriptionId }).catch(() => undefined);
    };
  }

  private emitConnectionState(state: EventsConnectionState) {
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
      .request("events.subscribe", {})
      .then(({ snapshot, subscriptionId }) => {
        if (this.snapshotListeners.size === 0) {
          void this.rpc.request("events.unsubscribe", { subscriptionId }).catch(() => undefined);
          return;
        }
        this.remoteSubscriptionId = subscriptionId;
        this.receiveSnapshot({ snapshot, subscriptionId }, "baseline");
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
      this.snapshotAcceptance.armReconnect();
      this.remoteSubscriptionId = null;
      this.emitConnectionState({ ...mapped, stale: true });
      void this.ensureRemoteSubscription();
      return;
    }
    this.emitConnectionState(mapped);
  }

  private receiveSnapshot(
    notification: EventsSnapshotNotificationDto,
    delivery: ApplicationSnapshotDelivery = "update",
  ) {
    if (notification.subscriptionId !== this.remoteSubscriptionId) return;
    const result = this.snapshotAcceptance.accept(notification.snapshot, delivery);
    if (result.kind === "conflict") {
      this.emitConnectionState({ ...this.connectionState, stale: true });
      return;
    }
    this.emitSnapshotConnectionState();
    if (result.kind !== "accepted") return;
    for (const listener of this.snapshotListeners) listener(result.snapshot, delivery);
  }

  private emitSnapshotConnectionState() {
    this.emitConnectionState({
      attempt: 0,
      phase: "connected",
      stale: this.snapshotAcceptance.isReconnectPending(),
    });
  }
}

function mapConnectionState(state: RpcConnectionState): EventsConnectionState {
  if (state.phase === "authenticating" || state.phase === "connecting") {
    return { attempt: state.attempt, phase: "connecting", stale: true };
  }
  return { attempt: state.attempt, phase: state.phase, stale: state.stale };
}
