import {
  BRIDGE_INFO_REQUEST,
  TrafficClientError,
  trafficRpcNotifications,
  type ApplicationSnapshotDelivery,
  type TrafficClient,
  type TrafficCommandAuthorityDto,
  type TrafficCommandOperation,
  type TrafficCommandResultDto,
  type TrafficConnectionState,
  type TrafficDataSnapshotDto,
  type TrafficSnapshotNotificationDto,
} from "@mish/contracts";
import {
  RpcRemoteError,
  RpcSessionAuthority,
  type RpcRequestOptions,
  type RpcSessionTicket,
} from "@mish/rpc-client";
import { mapStatusRpcError } from "./rpc-status-client";
import {
  projectRpcClientFailure,
  projectRpcConnectionState,
  type WebRpcTransport,
} from "./web-rpc-transport";

export type TrafficRpcClient = WebRpcTransport;

export class RpcTrafficClient implements TrafficClient {
  private readonly connectionListeners = new Set<(state: TrafficConnectionState) => void>();
  private readonly snapshotListeners = new Set<
    (snapshot: TrafficDataSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private connectionState: TrafficConnectionState;
  private disposed = false;
  private readonly supportedCommands = new Set<TrafficCommandOperation>();
  private capabilitiesLoaded = false;
  private capabilitiesPromise: Promise<void> | null = null;
  private remoteSubscriptionId: string | null = null;
  private observedSessionId: string | null | undefined;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;
  private readonly sessionAuthority = new RpcSessionAuthority<TrafficDataSnapshotDto>();
  private subscriptionTicket: RpcSessionTicket | null = null;

  constructor(private readonly rpc: TrafficRpcClient) {
    this.connectionState = projectRpcConnectionState(rpc.getConnectionState());
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
    const ticket = this.sessionAuthority.beginRequest();
    await this.ensureCapabilities();
    try {
      return this.acceptCommandResult(
        await this.rpc.request("traffic.closeAllActive", { authority }, options),
        ticket,
      );
    } catch (error) {
      throw toTrafficClientError(error);
    }
  }

  async closeConnection(
    authority: TrafficCommandAuthorityDto,
    connectionId: string,
    options?: RpcRequestOptions,
  ): Promise<TrafficCommandResultDto> {
    const ticket = this.sessionAuthority.beginRequest();
    await this.ensureCapabilities();
    try {
      return this.acceptCommandResult(
        await this.rpc.request("traffic.closeConnection", { authority, connectionId }, options),
        ticket,
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
    const ticket = this.sessionAuthority.beginRequest();
    await this.ensureCapabilities();
    try {
      return this.acceptCommandResult(
        await this.rpc.request(
          "traffic.closeFilteredVisible",
          { authority, connectionIds },
          options,
        ),
        ticket,
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
    this.sessionAuthority.dispose();
    this.connectionListeners.clear();
    this.snapshotListeners.clear();
  }

  getConnectionState() {
    return { ...this.connectionState };
  }

  async getSnapshot(options?: RpcRequestOptions): Promise<TrafficDataSnapshotDto> {
    const ticket = this.sessionAuthority.beginRequest();
    try {
      await this.ensureCapabilities();
      const result = this.sessionAuthority.accept(
        ticket,
        await this.rpc.request("traffic.getSnapshot", {}, options),
        "request",
      );
      if (result.kind === "conflict") {
        throw new TrafficClientError("validation", "Traffic snapshot order conflict");
      }
      if (!result.snapshot) {
        throw new TrafficClientError(
          "disconnected",
          "Traffic snapshot baseline is not established",
          true,
        );
      }
      this.emitSnapshotConnectionState();
      return result.snapshot;
    } catch (error) {
      throw toTrafficClientError(error);
    }
  }

  async getProcessIcon(connectionId: string, options?: RpcRequestOptions) {
    try {
      return await this.rpc.request("traffic.getProcessIcon", { connectionId }, options);
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

  subscribeSnapshots(
    listener: (snapshot: TrafficDataSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ) {
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

    const ticket = this.sessionAuthority.beginSubscription();
    this.subscriptionPromise = this.ensureCapabilities()
      .then(() => this.rpc.request("traffic.subscribe", {}))
      .then(({ snapshot, subscriptionId }) => {
        if (this.snapshotListeners.size === 0) {
          void this.rpc.request("traffic.unsubscribe", { subscriptionId }).catch(() => undefined);
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
      this.capabilitiesLoaded = false;
      this.observedSessionId = undefined;
      this.remoteSubscriptionId = null;
      this.subscriptionTicket = null;
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
      .request("bridge.getInfo", BRIDGE_INFO_REQUEST)
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

  private receiveSnapshot(
    notification: TrafficSnapshotNotificationDto,
    delivery: ApplicationSnapshotDelivery = "update",
    ticket = this.subscriptionTicket,
  ) {
    if (notification.subscriptionId !== this.remoteSubscriptionId || !ticket) return;
    const result = this.sessionAuthority.accept(ticket, notification.snapshot, delivery);
    if (result.kind === "conflict") {
      this.emitConnectionState({ ...this.connectionState, stale: true });
      return;
    }
    this.emitSnapshotConnectionState();
    if (result.kind !== "accepted" || !result.snapshot) return;
    const snapshot = result.snapshot;
    const sessionChanged =
      this.observedSessionId !== undefined && this.observedSessionId !== snapshot.sessionId;
    this.observedSessionId = snapshot.sessionId;
    if (sessionChanged) {
      this.capabilitiesLoaded = false;
      void this.ensureCapabilities()
        .then(() => this.publishSnapshot(snapshot, delivery))
        .catch(() => {
          if (this.connectionState.phase !== "connected") return;
          this.emitConnectionState({ ...this.connectionState, stale: true });
        });
      return;
    }
    this.publishSnapshot(snapshot, delivery);
  }

  private acceptCommandResult(
    result: TrafficCommandResultDto,
    ticket: RpcSessionTicket,
  ): TrafficCommandResultDto {
    const acceptance = this.sessionAuthority.accept(ticket, result.snapshot, "command");
    if (acceptance.kind === "conflict") {
      throw new TrafficClientError("validation", "Traffic snapshot order conflict");
    }
    if (!acceptance.snapshot) {
      throw new TrafficClientError(
        "disconnected",
        "Traffic snapshot baseline is not established",
        true,
      );
    }
    this.emitSnapshotConnectionState();
    return { ...result, snapshot: acceptance.snapshot };
  }

  private publishSnapshot(snapshot: TrafficDataSnapshotDto, delivery: ApplicationSnapshotDelivery) {
    this.emitSnapshotConnectionState();
    for (const listener of this.snapshotListeners) listener(snapshot, delivery);
  }

  private emitSnapshotConnectionState() {
    this.emitConnectionState({
      attempt: 0,
      phase: "connected",
      stale: this.sessionAuthority.isStale(),
    });
  }
}

function toTrafficClientError(error: unknown) {
  if (error instanceof TrafficClientError) return error;
  const mapped =
    error instanceof RpcRemoteError ? mapStatusRpcError(error) : projectRpcClientFailure(error);
  return new TrafficClientError(mapped.code, mapped.message, mapped.retryable);
}
