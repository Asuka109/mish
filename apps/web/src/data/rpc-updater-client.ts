import {
  UpdaterClientError,
  updaterRpcNotifications,
  type StatusConnectionState,
  type UpdateChannel,
  type UpdaterClient,
  type UpdaterSnapshotDto,
  type UpdaterSnapshotNotificationDto,
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

export type UpdaterRpcClient = WebRpcTransport;

// Updater's public DTO has no parent application-order envelope. Keep the
// transport order internal while preserving authorityId/revision as product state.
interface UpdaterSessionSnapshot extends RpcSessionSnapshot {
  snapshot: UpdaterSnapshotDto;
}

export class RpcUpdaterClient implements UpdaterClient {
  private readonly connectionListeners = new Set<(state: StatusConnectionState) => void>();
  private readonly snapshotListeners = new Set<(snapshot: UpdaterSnapshotDto) => void>();
  private acceptedSnapshot: UpdaterSnapshotDto | null = null;
  private readonly sessionAuthority = new RpcSessionAuthority<UpdaterSessionSnapshot>();
  private connectionState: StatusConnectionState;
  private disposed = false;
  private remoteSubscriptionId: string | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;
  private subscriptionTicket: RpcSessionTicket | null = null;

  constructor(private readonly rpc: UpdaterRpcClient) {
    this.connectionState = projectRpcConnectionState(rpc.getConnectionState());
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
    this.sessionAuthority.dispose();
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
    const ticket = this.sessionAuthority.beginRequest();
    try {
      const delivery = method === "updater.getSnapshot" ? "request" : "command";
      const result = this.sessionAuthority.accept(
        ticket,
        toSessionSnapshot(await this.rpc.request(method, params, options)),
        delivery,
      );
      if (result.kind === "conflict") {
        throw new UpdaterClientError("validation", "Updater snapshot order conflict");
      }
      if (!result.snapshot) {
        throw new UpdaterClientError(
          "disconnected",
          "Updater snapshot baseline is not established",
          true,
        );
      }
      return this.acceptSnapshot(result.snapshot.snapshot);
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
    const ticket = this.sessionAuthority.beginSubscription();
    this.subscriptionPromise = this.rpc
      .request("updater.subscribe", {})
      .then(({ snapshot, subscriptionId }) => {
        if (this.snapshotListeners.size === 0) {
          void this.rpc.request("updater.unsubscribe", { subscriptionId }).catch(() => undefined);
          return;
        }
        this.subscriptionTicket = ticket;
        this.remoteSubscriptionId = subscriptionId;
        this.receiveSnapshot({ snapshot, subscriptionId }, "baseline", ticket);
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
      this.subscriptionTicket = null;
      this.emitConnectionState({ ...mapped, stale: true });
      void this.ensureRemoteSubscription();
      return;
    }
    this.emitConnectionState(mapped);
  }

  private receiveSnapshot(
    notification: UpdaterSnapshotNotificationDto,
    delivery: "baseline" | "update" = "update",
    ticket = this.subscriptionTicket,
  ) {
    if (notification.subscriptionId !== this.remoteSubscriptionId || !ticket) return;
    const result = this.sessionAuthority.accept(
      ticket,
      toSessionSnapshot(notification.snapshot),
      delivery,
    );
    if (result.kind === "conflict") {
      this.emitConnectionState({ ...this.connectionState, stale: true });
      return;
    }
    this.emitSnapshotConnectionState();
    if (result.kind !== "accepted" || !result.snapshot) return;
    const snapshot = this.acceptSnapshot(result.snapshot.snapshot);
    if (
      snapshot.authorityId !== notification.snapshot.authorityId ||
      snapshot.revision !== notification.snapshot.revision
    ) {
      return;
    }
    for (const listener of this.snapshotListeners) listener(snapshot);
  }

  private emitSnapshotConnectionState() {
    this.emitConnectionState({
      attempt: 0,
      phase: "connected",
      stale: this.sessionAuthority.isStale(),
    });
  }
}

function toSessionSnapshot(snapshot: UpdaterSnapshotDto): UpdaterSessionSnapshot {
  return {
    applicationOrder: {
      authorityId: snapshot.authorityId,
      epoch: 0,
      order: snapshot.revision,
    },
    snapshot,
  };
}

function mapUpdaterError(error: unknown) {
  if (error instanceof UpdaterClientError) return error;
  const mapped =
    error instanceof RpcRemoteError ? mapStatusRpcError(error) : projectRpcClientFailure(error);
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
