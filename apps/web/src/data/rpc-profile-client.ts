import {
  ProfileClientError,
  ProfilePreviewSchema,
  mishRpcMethods,
  profileRpcNotifications,
  type ProfileClient,
  type ProfileConnectionState,
  type ProfilePatchAuthorityDto,
  type ProfilePatchDto,
  type ProfileRefreshPolicy,
  type ProfileSnapshotDto,
  type ProfileSnapshotNotificationDto,
  type ProviderAuthorityDto,
  type ProviderKind,
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

export type MishRpcClient = RpcClient<typeof mishRpcMethods>;
export type LocalProfilePreflight = (label?: string) => Promise<unknown>;

export class RpcProfileClient implements ProfileClient {
  private readonly connectionListeners = new Set<(state: ProfileConnectionState) => void>();
  private readonly snapshotListeners = new Set<(snapshot: ProfileSnapshotDto) => void>();
  private connectionState: ProfileConnectionState;
  private disposed = false;
  private remoteSubscriptionId: string | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;

  constructor(
    private readonly rpc: MishRpcClient,
    private readonly localPreflight: LocalProfilePreflight | null,
  ) {
    this.connectionState = mapConnectionState(rpc.getConnectionState());
    this.unsubscribeNotification = rpc.onNotification(
      "profiles.snapshot",
      profileRpcNotifications["profiles.snapshot"],
      (notification) => this.receiveSnapshot(notification),
    );
    this.unsubscribeRpcConnection = rpc.subscribeConnection((state) =>
      this.receiveConnectionState(state),
    );
  }

  activateProfile(commandId: string, profileId: string, options?: RpcRequestOptions) {
    return this.request("profiles.activate", { commandId, profileId }, options);
  }

  cancelActivation(commandId: string, options?: RpcRequestOptions) {
    return this.request("profiles.cancelActivation", { commandId }, options);
  }

  deleteProfile(profileId: string, options?: RpcRequestOptions) {
    return this.request("profiles.delete", { profileId }, options).then((snapshot) =>
      this.normalizeSnapshot(snapshot),
    );
  }

  getSnapshot(options?: RpcRequestOptions) {
    return this.request("profiles.getSnapshot", {}, options).then((snapshot) =>
      this.normalizeSnapshot(snapshot),
    );
  }

  getPatches(authority: ProfilePatchAuthorityDto, options?: RpcRequestOptions) {
    return this.request("profiles.getPatches", authority, options);
  }

  getRoutes(profileId: string, options?: RpcRequestOptions) {
    return this.request("profiles.getRoutes", { profileId }, options);
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

  preflightHttps(url: string, label?: string, options?: RpcRequestOptions) {
    return this.request("profiles.preflightHttps", { label, url }, options);
  }

  async preflightLocal(label?: string) {
    if (!this.localPreflight) {
      throw new ProfileClientError(
        "unsupported",
        "Local profile import is unavailable in the browser client",
      );
    }
    try {
      return ProfilePreviewSchema.nullable().parse(await this.localPreflight(label));
    } catch (error) {
      if (error instanceof ProfileClientError) throw error;
      throw new ProfileClientError("validation", "Local profile preflight failed");
    }
  }

  refreshProfile(profileId: string, options?: RpcRequestOptions) {
    return this.request("profiles.refresh", { profileId }, options).then((snapshot) =>
      this.normalizeSnapshot(snapshot),
    );
  }

  replacePatches(
    authority: ProfilePatchAuthorityDto,
    patches: ProfilePatchDto[],
    options?: RpcRequestOptions,
  ) {
    return this.request(
      "profiles.replacePatches",
      { authority, patches, schemaVersion: 1 },
      options,
    );
  }

  setRefreshPolicy(profileId: string, policy: ProfileRefreshPolicy, options?: RpcRequestOptions) {
    return this.request("profiles.setRefreshPolicy", { profileId, policy }, options).then(
      (snapshot) => this.normalizeSnapshot(snapshot),
    );
  }

  savePreview(previewId: string, options?: RpcRequestOptions) {
    return this.request("profiles.save", { previewId }, options).then((snapshot) =>
      this.normalizeSnapshot(snapshot),
    );
  }

  stopActiveProfile(commandId: string, options?: RpcRequestOptions) {
    return this.request("profiles.stop", { commandId }, options);
  }

  updateAllProviders(
    authority: ProviderAuthorityDto,
    kind: ProviderKind,
    options?: RpcRequestOptions,
  ) {
    return this.request("profiles.updateAllProviders", { authority, kind }, options);
  }

  updateProvider(authority: ProviderAuthorityDto, providerId: string, options?: RpcRequestOptions) {
    return this.request("profiles.updateProvider", { authority, providerId }, options);
  }

  subscribeConnection(listener: (state: ProfileConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  subscribeSnapshots(listener: (snapshot: ProfileSnapshotDto) => void) {
    this.snapshotListeners.add(listener);
    void this.ensureRemoteSubscription();
    return () => {
      this.snapshotListeners.delete(listener);
      if (this.snapshotListeners.size > 0 || !this.remoteSubscriptionId) return;
      const subscriptionId = this.remoteSubscriptionId;
      this.remoteSubscriptionId = null;
      void this.rpc.request("profiles.unsubscribe", { subscriptionId }).catch(() => undefined);
    };
  }

  private emitConnectionState(state: ProfileConnectionState) {
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
      .request("profiles.subscribe", {})
      .then(({ snapshot, subscriptionId }) => {
        if (this.snapshotListeners.size === 0) {
          void this.rpc.request("profiles.unsubscribe", { subscriptionId }).catch(() => undefined);
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

  private receiveSnapshot(notification: ProfileSnapshotNotificationDto) {
    if (notification.subscriptionId !== this.remoteSubscriptionId) return;
    this.emitConnectionState({ attempt: 0, phase: "connected", stale: false });
    const snapshot = this.normalizeSnapshot(notification.snapshot);
    for (const listener of this.snapshotListeners) listener(snapshot);
  }

  private normalizeSnapshot(snapshot: ProfileSnapshotDto) {
    if (this.localPreflight) return snapshot;
    return {
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        localFileImport: "unavailable" as const,
      },
    };
  }

  private async request<Method extends keyof typeof mishRpcMethods>(
    method: Method,
    params: Parameters<MishRpcClient["request"]>[1],
    options?: RpcRequestOptions,
  ) {
    try {
      return await this.rpc.request(method, params as never, options);
    } catch (error) {
      throw mapRpcError(error);
    }
  }
}

function mapConnectionState(state: RpcConnectionState): ProfileConnectionState {
  if (state.phase === "authenticating" || state.phase === "connecting") {
    return { attempt: state.attempt, phase: "connecting", stale: true };
  }
  return { attempt: state.attempt, phase: state.phase, stale: state.stale };
}

function mapRpcError(error: unknown) {
  if (error instanceof RpcCancelledError) {
    return new ProfileClientError("cancelled", error.message);
  }
  if (error instanceof RpcDisconnectedError || error instanceof RpcDisposedError) {
    return new ProfileClientError("disconnected", error.message, true);
  }
  if (error instanceof RpcValidationError) {
    return new ProfileClientError("validation", "Profile response validation failed");
  }
  if (error instanceof RpcMessageTooLargeError || error instanceof RpcProtocolError) {
    return new ProfileClientError("protocol", error.message);
  }
  if (error instanceof RpcRemoteError) {
    if (error.code === -32_602) return new ProfileClientError("invalid-request", error.message);
    if (error.code === -32_004) return new ProfileClientError("not-found", error.message);
    if (error.code === -32_009) return new ProfileClientError("conflict", error.message);
    return new ProfileClientError("remote", error.message, error.code === -32_040);
  }
  return new ProfileClientError("unknown", "Unknown profile client failure");
}
