import {
  notificationRpcNotifications,
  mishRpcMethods,
  type EventsConnectionState,
  type NotificationClient,
  type NotificationPresentationClaimDto,
  type NotificationPresentationClaimResultDto,
  type NotificationPresentationCompletionResultDto,
  type NotificationPresentationFoldReason,
  type NotificationPresentationIdentityDto,
  type NotificationPublicationDto,
  type NotificationSnapshotDelivery,
  type NotificationSnapshotDto,
  type NotificationSnapshotNotificationDto,
} from "@mish/contracts";
import { RpcClient, type RpcConnectionState, type RpcRequestOptions } from "@mish/rpc-client";
import { mapRpcError } from "./rpc-status-client";

type NotificationRpcClient = RpcClient<typeof mishRpcMethods>;

export class RpcNotificationClient implements NotificationClient {
  private readonly clientId = createPresentationIdentifier("notification-client");
  private readonly connectionListeners = new Set<(state: EventsConnectionState) => void>();
  private readonly snapshotListeners = new Set<(delivery: NotificationSnapshotDelivery) => void>();
  private connectionState: EventsConnectionState;
  private disposed = false;
  private hasConnected = false;
  private hasBaseline = false;
  private latestRevision = -1;
  private remoteSubscriptionId: string | null = null;
  private sessionId = createPresentationIdentifier("notification-session");
  private subscriptionIdentity: NotificationPresentationIdentityDto | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;

  constructor(private readonly rpc: NotificationRpcClient) {
    this.connectionState = mapConnectionState(rpc.getConnectionState());
    this.unsubscribeNotification = rpc.onNotification(
      "notifications.snapshot",
      notificationRpcNotifications["notifications.snapshot"],
      (notification) => this.receiveNotification(notification),
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

  async getSnapshot(options?: RpcRequestOptions) {
    return this.request<"notifications.getSnapshot", NotificationSnapshotDto>(
      "notifications.getSnapshot",
      {},
      options,
    );
  }

  async claimPresentation(options?: RpcRequestOptions) {
    const result = await this.request<
      "notifications.claimPresentation",
      NotificationPresentationClaimResultDto
    >("notifications.claimPresentation", this.activePresentationIdentity(), options);
    this.receiveSnapshot({
      claim: result.claim,
      kind: this.hasBaseline ? "update" : "baseline",
      snapshot: result.snapshot,
    });
    return result;
  }

  async completePresentation(
    claim: NotificationPresentationClaimDto,
    outcome: NotificationPresentationFoldReason,
    options?: RpcRequestOptions,
  ) {
    const { id, leaseGeneration, revision } = claim;
    const result = await this.request<
      "notifications.completePresentation",
      NotificationPresentationCompletionResultDto
    >(
      "notifications.completePresentation",
      { ...this.activePresentationIdentity(), id, leaseGeneration, outcome, revision },
      options,
    );
    this.receiveSnapshot({
      kind: this.hasBaseline ? "update" : "baseline",
      snapshot: result.snapshot,
    });
    return result;
  }

  async markRead(ids: readonly string[], options?: RpcRequestOptions) {
    return this.mutate("notifications.markRead", { ids: [...ids] }, options);
  }

  async publish(publication: NotificationPublicationDto, options?: RpcRequestOptions) {
    return this.mutate("notifications.publish", publication, options);
  }

  async remove(id: string, options?: RpcRequestOptions) {
    return this.mutate("notifications.remove", { id }, options);
  }

  async removeByDedupeKey(dedupeKey: string, options?: RpcRequestOptions) {
    return this.mutate("notifications.removeByDedupeKey", { dedupeKey }, options);
  }

  subscribeConnection(listener: (state: EventsConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  subscribeSnapshots(listener: (delivery: NotificationSnapshotDelivery) => void) {
    this.snapshotListeners.add(listener);
    void this.ensureRemoteSubscription();
    return () => {
      this.snapshotListeners.delete(listener);
      if (this.snapshotListeners.size > 0 || !this.remoteSubscriptionId) return;
      const subscriptionId = this.remoteSubscriptionId;
      this.remoteSubscriptionId = null;
      this.subscriptionIdentity = null;
      void this.rpc.request("notifications.unsubscribe", { subscriptionId }).catch(() => undefined);
    };
  }

  private async request<M extends keyof typeof mishRpcMethods, Result>(
    method: M,
    params: Parameters<NotificationRpcClient["request"]>[1],
    options?: RpcRequestOptions,
  ): Promise<Result> {
    try {
      return (await this.rpc.request(method, params as never, options)) as Result;
    } catch (error) {
      const mapped = mapRpcError(error);
      throw new Error(mapped.message, { cause: error });
    }
  }

  private async mutate<M extends keyof typeof mishRpcMethods>(
    method: M,
    params: Parameters<NotificationRpcClient["request"]>[1],
    options?: RpcRequestOptions,
  ) {
    const snapshot = await this.request<M, NotificationSnapshotDto>(method, params, options);
    this.receiveSnapshot({ kind: this.hasBaseline ? "update" : "baseline", snapshot });
    return snapshot;
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
    const identity = this.presentationIdentity();
    this.subscriptionPromise = this.rpc
      .request("notifications.subscribe", identity)
      .then(({ claim, snapshot, subscriptionId }) => {
        if (this.snapshotListeners.size === 0) {
          void this.rpc
            .request("notifications.unsubscribe", { subscriptionId })
            .catch(() => undefined);
          return;
        }
        this.remoteSubscriptionId = subscriptionId;
        this.subscriptionIdentity = identity;
        this.receiveSnapshot({ claim, kind: "baseline", snapshot });
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
      this.subscriptionIdentity = null;
      if (this.hasConnected) {
        this.sessionId = createPresentationIdentifier("notification-session");
      }
      this.hasConnected = true;
      this.hasBaseline = false;
      this.latestRevision = -1;
      this.emitConnectionState({ ...mapped, stale: true });
      void this.ensureRemoteSubscription();
      return;
    }
    this.emitConnectionState(mapped);
  }

  private receiveNotification(notification: NotificationSnapshotNotificationDto) {
    if (notification.subscriptionId !== this.remoteSubscriptionId) return;
    this.receiveSnapshot({ kind: "update", snapshot: notification.snapshot });
  }

  private receiveSnapshot(delivery: NotificationSnapshotDelivery) {
    if (delivery.kind === "update" && delivery.snapshot.revision < this.latestRevision) return;
    if (
      delivery.kind === "update" &&
      delivery.snapshot.revision === this.latestRevision &&
      delivery.claim === undefined
    ) {
      return;
    }
    if (delivery.kind === "baseline") this.hasBaseline = true;
    this.latestRevision = delivery.snapshot.revision;
    this.emitConnectionState({ attempt: 0, phase: "connected", stale: false });
    for (const listener of this.snapshotListeners) listener(structuredClone(delivery));
  }

  private presentationIdentity(): NotificationPresentationIdentityDto {
    return { clientId: this.clientId, sessionId: this.sessionId };
  }

  private activePresentationIdentity(): NotificationPresentationIdentityDto {
    return this.subscriptionIdentity ?? this.presentationIdentity();
  }
}

function createPresentationIdentifier(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function mapConnectionState(state: RpcConnectionState): EventsConnectionState {
  if (state.phase === "authenticating" || state.phase === "connecting") {
    return { attempt: state.attempt, phase: "connecting", stale: true };
  }
  return { attempt: state.attempt, phase: state.phase, stale: state.stale };
}
