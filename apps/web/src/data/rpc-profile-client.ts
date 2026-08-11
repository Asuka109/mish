import {
  ProfileClientError,
  ProfilePreviewSchema,
  mishRpcMethods,
  profileRpcNotifications,
  type ApplicationSnapshotDelivery,
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
  RpcRemoteError,
  RpcSessionAuthority,
  type RpcRequestOptions,
  type RpcSessionTicket,
} from "@mish/rpc-client";
import {
  projectRpcClientFailure,
  projectRpcConnectionState,
  type WebRpcTransport,
} from "./web-rpc-transport";

export type MishRpcClient = WebRpcTransport;
export type LocalProfilePreflight = (label?: string) => Promise<unknown>;
type ProfileSnapshotMethod =
  | "profiles.create"
  | "profiles.delete"
  | "profiles.detachSubscription"
  | "profiles.getSnapshot"
  | "profiles.refresh"
  | "profiles.save"
  | "profiles.select"
  | "profiles.setRefreshPolicy";

export class RpcProfileClient implements ProfileClient {
  private readonly connectionListeners = new Set<(state: ProfileConnectionState) => void>();
  private readonly snapshotListeners = new Set<
    (snapshot: ProfileSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private connectionState: ProfileConnectionState;
  private disposed = false;
  private remoteSubscriptionId: string | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;
  private readonly sessionAuthority = new RpcSessionAuthority<ProfileSnapshotDto>();
  private subscriptionTicket: RpcSessionTicket | null = null;

  constructor(
    private readonly rpc: MishRpcClient,
    private readonly localPreflight: LocalProfilePreflight | null,
  ) {
    this.connectionState = projectRpcConnectionState(rpc.getConnectionState());
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

  createProfile(fileName: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("profiles.create", { fileName }, options);
  }

  deleteProfile(profileId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("profiles.delete", { profileId }, options);
  }

  detachSubscription(profileId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("profiles.detachSubscription", { profileId }, options);
  }

  getSnapshot(options?: RpcRequestOptions) {
    return this.requestSnapshot("profiles.getSnapshot", {}, options, "request");
  }

  openProfileDirectory(options?: RpcRequestOptions) {
    return this.request("profiles.openDirectory", {}, options).then(() => undefined);
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
    this.sessionAuthority.dispose();
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
    return this.requestSnapshot("profiles.refresh", { profileId }, options);
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
    return this.requestSnapshot("profiles.setRefreshPolicy", { profileId, policy }, options);
  }

  savePreview(previewId: string, options?: RpcRequestOptions) {
    return this.requestSnapshot("profiles.save", { previewId }, options);
  }

  selectProfile(
    profileId: string,
    options?: RpcRequestOptions & {
      expectedSelection?: ProfileSnapshotDto["selection"];
    },
  ) {
    return this.requestSnapshot(
      "profiles.select",
      { expectedSelection: options?.expectedSelection, profileId },
      options,
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

  subscribeSnapshots(
    listener: (snapshot: ProfileSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ) {
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
    const ticket = this.sessionAuthority.beginSubscription();
    this.subscriptionPromise = this.rpc
      .request("profiles.subscribe", {})
      .then(({ snapshot, subscriptionId }) => {
        if (this.snapshotListeners.size === 0) {
          void this.rpc.request("profiles.unsubscribe", { subscriptionId }).catch(() => undefined);
          return;
        }
        this.remoteSubscriptionId = subscriptionId;
        this.subscriptionTicket = ticket;
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
    notification: ProfileSnapshotNotificationDto,
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
    const snapshot = this.projectCapabilities(result.snapshot);
    for (const listener of this.snapshotListeners) listener(snapshot, delivery);
  }

  private async requestSnapshot(
    method: ProfileSnapshotMethod,
    params: Parameters<MishRpcClient["request"]>[1],
    options?: RpcRequestOptions,
    delivery: "command" | "request" = method === "profiles.getSnapshot" ? "request" : "command",
  ) {
    const ticket = this.sessionAuthority.beginRequest();
    const result = this.sessionAuthority.accept(
      ticket,
      (await this.request(method, params, options)) as ProfileSnapshotDto,
      delivery,
    );
    if (result.kind === "conflict") {
      throw new ProfileClientError("validation", "Profile snapshot order conflict");
    }
    this.emitSnapshotConnectionState();
    if (!result.snapshot) {
      throw new ProfileClientError(
        "disconnected",
        "Profile snapshot baseline is not established",
        true,
      );
    }
    return this.projectCapabilities(result.snapshot);
  }

  private emitSnapshotConnectionState() {
    this.emitConnectionState({
      attempt: 0,
      phase: "connected",
      stale: this.sessionAuthority.isStale(),
    });
  }

  private projectCapabilities(snapshot: ProfileSnapshotDto) {
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

function mapRpcError(error: unknown) {
  if (error instanceof RpcRemoteError) {
    if (error.code === -32_602) return new ProfileClientError("invalid-request", error.message);
    if (error.code === -32_004) return new ProfileClientError("not-found", error.message);
    if (error.code === -32_009) return new ProfileClientError("conflict", error.message);
    return new ProfileClientError("remote", error.message, error.code === -32_040);
  }
  const projected = projectRpcClientFailure(error);
  const message =
    projected.code === "validation"
      ? "Profile response validation failed"
      : projected.code === "unknown"
        ? "Unknown profile client failure"
        : projected.message;
  return new ProfileClientError(projected.code, message, projected.retryable);
}
