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
import {
  RpcRemoteError,
  RpcSessionAuthority,
  type RpcRequestOptions,
  type RpcSessionSnapshot,
  type RpcSessionTicket,
} from "@mish/rpc-client";
import { mapStatusRpcError } from "./rpc-status-client";
import {
  projectRpcClientFailure,
  projectRpcConnectionState,
  type WebRpcTransport,
} from "./web-rpc-transport";

export type NotificationRpcClient = WebRpcTransport;

// Notification snapshots intentionally keep their domain DTO unchanged. The
// process-global center exposes a monotonic revision, so the RPC session
// authority receives only this internal transport envelope.
interface NotificationSessionSnapshot extends RpcSessionSnapshot {
  snapshot: NotificationSnapshotDto;
}

export class RpcNotificationClient implements NotificationClient {
  private readonly clientId = createPresentationIdentifier("notification-client");
  private readonly connectionListeners = new Set<(state: EventsConnectionState) => void>();
  private readonly snapshotListeners = new Set<(delivery: NotificationSnapshotDelivery) => void>();
  private connectionState: EventsConnectionState;
  private disposed = false;
  private remoteSubscriptionId: string | null = null;
  private sessionId = createPresentationIdentifier("notification-session");
  private subscriptionIdentity: NotificationPresentationIdentityDto | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;
  private readonly sessionAuthority = new RpcSessionAuthority<NotificationSessionSnapshot>();
  private subscriptionTicket: RpcSessionTicket | null = null;

  constructor(private readonly rpc: NotificationRpcClient) {
    this.connectionState = projectRpcConnectionState(rpc.getConnectionState());
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
    this.sessionAuthority.dispose();
    this.connectionListeners.clear();
    this.snapshotListeners.clear();
  }

  getConnectionState() {
    return { ...this.connectionState };
  }

  async getSnapshot(options?: RpcRequestOptions) {
    const ticket = this.sessionAuthority.beginRequest();
    const snapshot = await this.request<"notifications.getSnapshot", NotificationSnapshotDto>(
      "notifications.getSnapshot",
      {},
      options,
    );
    return this.acceptSnapshot(snapshot, "request", ticket);
  }

  async claimPresentation(options?: RpcRequestOptions) {
    const ticket = this.sessionAuthority.beginRequest();
    const result = await this.request<
      "notifications.claimPresentation",
      NotificationPresentationClaimResultDto
    >("notifications.claimPresentation", this.activePresentationIdentity(), options);
    this.receiveSnapshot(
      {
        claim: result.claim,
        kind: this.sessionAuthority.isBaselinePending() ? "baseline" : "update",
        snapshot: result.snapshot,
      },
      ticket,
    );
    return result;
  }

  async completePresentation(
    claim: NotificationPresentationClaimDto,
    outcome: NotificationPresentationFoldReason,
    options?: RpcRequestOptions,
  ) {
    const ticket = this.sessionAuthority.beginRequest();
    const { id, leaseGeneration, revision } = claim;
    const result = await this.request<
      "notifications.completePresentation",
      NotificationPresentationCompletionResultDto
    >(
      "notifications.completePresentation",
      { ...this.activePresentationIdentity(), id, leaseGeneration, outcome, revision },
      options,
    );
    this.receiveSnapshot(
      {
        kind: this.sessionAuthority.isBaselinePending() ? "baseline" : "update",
        snapshot: result.snapshot,
      },
      ticket,
    );
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
      const mapped =
        error instanceof RpcRemoteError ? mapStatusRpcError(error) : projectRpcClientFailure(error);
      throw new Error(mapped.message, { cause: error });
    }
  }

  private async mutate<M extends keyof typeof mishRpcMethods>(
    method: M,
    params: Parameters<NotificationRpcClient["request"]>[1],
    options?: RpcRequestOptions,
  ) {
    const ticket = this.sessionAuthority.beginRequest();
    const snapshot = await this.request<M, NotificationSnapshotDto>(method, params, options);
    return this.acceptSnapshot(
      snapshot,
      this.sessionAuthority.isBaselinePending() ? "baseline" : "command",
      ticket,
    );
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
    const ticket = this.sessionAuthority.beginSubscription();
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
        this.subscriptionTicket = ticket;
        this.receiveSnapshot({ claim, kind: "baseline", snapshot }, ticket);
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

  private receiveConnectionState(state: ReturnType<WebRpcTransport["getConnectionState"]>) {
    const mapped = projectRpcConnectionState(state);
    this.sessionAuthority.observeTransport(mapped.phase === "connected");
    if (mapped.phase === "connected") {
      this.remoteSubscriptionId = null;
      this.subscriptionIdentity = null;
      this.subscriptionTicket = null;
      this.sessionId = createPresentationIdentifier("notification-session");
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

  private receiveSnapshot(
    delivery: NotificationSnapshotDelivery,
    ticket = this.subscriptionTicket,
  ) {
    const effectiveTicket = ticket ?? this.sessionAuthority.beginSubscription();
    const result = this.sessionAuthority.accept(
      effectiveTicket,
      toSessionSnapshot(delivery.snapshot, this.sessionId),
      delivery.kind,
    );
    if (result.kind === "conflict") {
      this.emitConnectionState({ ...this.connectionState, stale: true });
      return;
    }
    this.emitSnapshotConnectionState();
    if (!result.snapshot) return;
    if (result.kind === "stale") return;
    if (result.kind === "duplicate" && delivery.kind === "update" && delivery.claim === undefined) {
      return;
    }
    for (const listener of this.snapshotListeners) {
      listener({
        ...structuredClone(delivery),
        snapshot: structuredClone(result.snapshot.snapshot),
      });
    }
  }

  private acceptSnapshot(
    snapshot: NotificationSnapshotDto,
    delivery: "baseline" | "update" | "command" | "request",
    ticket: RpcSessionTicket,
  ) {
    const result = this.sessionAuthority.accept(
      ticket,
      toSessionSnapshot(snapshot, this.sessionId),
      delivery,
    );
    if (result.kind === "conflict") {
      this.emitConnectionState({ ...this.connectionState, stale: true });
      return result.snapshot?.snapshot ?? snapshot;
    }
    this.emitSnapshotConnectionState();
    return result.snapshot?.snapshot ?? snapshot;
  }

  private emitSnapshotConnectionState() {
    this.emitConnectionState({
      attempt: 0,
      phase: "connected",
      stale: this.sessionAuthority.isStale(),
    });
  }

  private presentationIdentity(): NotificationPresentationIdentityDto {
    return { clientId: this.clientId, sessionId: this.sessionId };
  }

  private activePresentationIdentity(): NotificationPresentationIdentityDto {
    return this.subscriptionIdentity ?? this.presentationIdentity();
  }
}

function toSessionSnapshot(
  snapshot: NotificationSnapshotDto,
  authorityId: string,
): NotificationSessionSnapshot {
  return {
    applicationOrder: { authorityId, epoch: 0, order: snapshot.revision },
    snapshot,
  };
}

function createPresentationIdentifier(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}
