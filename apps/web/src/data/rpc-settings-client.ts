import {
  mishRpcMethods,
  settingsRpcNotifications,
  type ApplicationLaunchBehavior,
  type AppearancePreference,
  type LanguagePreference,
  type ManagedPortPreferencesDto,
  type ManagedPortKind,
  type OnboardingWelcomeAction,
  type ProcessDiscoveryMode,
  type SettingsClient,
  type SettingsSnapshotDelivery,
  type SettingsSnapshotDto,
  type SettingsSnapshotNotificationDto,
  type StartupPreferencesDto,
  type WindowCloseBehavior,
  type WindowSurfacePreference,
  type SystemProxyTakeoverPolicy,
  type TunHelperLifecycleOptions,
} from "@mish/contracts";
import type { RpcClient, RpcConnectionState, RpcRequestOptions } from "@mish/rpc-client";
import { ApplicationSnapshotAcceptance } from "./application-snapshot-acceptance";

export class RpcSettingsClient implements SettingsClient {
  private readonly snapshotAcceptance = new ApplicationSnapshotAcceptance<SettingsSnapshotDto>();
  private readonly snapshotListeners = new Set<
    (snapshot: SettingsSnapshotDto, delivery?: SettingsSnapshotDelivery) => void
  >();
  private remoteSubscriptionId: string | null = null;
  private subscriptionGeneration = 0;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private disposed = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;

  constructor(
    private readonly rpc: RpcClient<typeof mishRpcMethods>,
    private readonly nativeWindowCapabilities = true,
  ) {
    this.unsubscribeNotification =
      "onNotification" in rpc
        ? rpc.onNotification(
            "settings.snapshot",
            settingsRpcNotifications["settings.snapshot"],
            (notification) => this.receiveSnapshot(notification),
          )
        : () => undefined;
    this.unsubscribeRpcConnection =
      "subscribeConnection" in rpc
        ? rpc.subscribeConnection((state) => this.receiveConnectionState(state))
        : () => undefined;
  }

  getSnapshot(options?: RpcRequestOptions) {
    return this.requestSnapshot(this.rpc.request("settings.getSnapshot", {}, options), "request");
  }

  refreshNetworkDns(options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.refreshNetworkDns", {}, options),
      "command",
    );
  }

  installTunHelper(options?: TunHelperLifecycleOptions) {
    const { resumeCapture = false, ...requestOptions } = options ?? {};
    return this.requestSnapshot(
      this.rpc.request("settings.installTunHelper", { resumeCapture }, requestOptions),
      "command",
    );
  }

  repairTunHelper(options?: TunHelperLifecycleOptions) {
    const { resumeCapture = false, ...requestOptions } = options ?? {};
    return this.requestSnapshot(
      this.rpc.request("settings.repairTunHelper", { resumeCapture }, requestOptions),
      "command",
    );
  }

  removeTunHelper(options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.removeTunHelper", {}, options),
      "command",
    );
  }

  setAppearance(appearance: AppearancePreference, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.setAppearance", { appearance }, options),
      "command",
    );
  }

  setLanguage(language: LanguagePreference, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.setLanguage", { language }, options),
      "command",
    );
  }

  setOnboardingWelcomeState(action: OnboardingWelcomeAction, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.setOnboardingWelcomeState", { action }, options),
      "command",
    );
  }

  setStartup(startup: StartupPreferencesDto, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.setStartup", { startup }, options),
      "command",
    );
  }

  setApplicationLaunchBehavior(
    launchBehavior: ApplicationLaunchBehavior,
    options?: RpcRequestOptions,
  ) {
    return this.requestSnapshot(
      this.rpc.request("settings.setApplicationLaunchBehavior", { launchBehavior }, options),
      "command",
    );
  }

  setManagedPorts(managedPorts: ManagedPortPreferencesDto, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.setManagedPorts", { managedPorts }, options),
      "command",
    );
  }

  findManagedPorts(options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.findManagedPorts", {}, options),
      "command",
    );
  }

  findManagedPort(kind: ManagedPortKind, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.findManagedPort", { kind }, options),
      "command",
    );
  }

  setSystemProxyTakeoverPolicy(policy: SystemProxyTakeoverPolicy, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.setSystemProxyTakeoverPolicy", { policy }, options),
      "command",
    );
  }

  setProcessDiscoveryMode(mode: ProcessDiscoveryMode, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.setProcessDiscoveryMode", { mode }, options),
      "command",
    );
  }

  setCloseOldConnectionsAfterGroupSwitch(enabled: boolean, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.setCloseOldConnectionsAfterGroupSwitch", { enabled }, options),
      "command",
    );
  }

  subscribeSnapshots(
    listener: (snapshot: SettingsSnapshotDto, delivery?: SettingsSnapshotDelivery) => void,
  ) {
    this.snapshotListeners.add(listener);
    void this.ensureRemoteSubscription();
    return () => {
      this.snapshotListeners.delete(listener);
      if (this.snapshotListeners.size > 0 || !this.remoteSubscriptionId) return;
      const subscriptionId = this.remoteSubscriptionId;
      this.remoteSubscriptionId = null;
      void this.rpc.request("settings.unsubscribe", { subscriptionId }).catch(() => undefined);
    };
  }

  setWindowCloseBehavior(behavior: WindowCloseBehavior, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.setWindowCloseBehavior", { behavior }, options),
      "command",
    );
  }

  setWindowSurface(surface: WindowSurfacePreference, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      this.rpc.request("settings.setWindowSurface", { surface }, options),
      "command",
    );
  }

  private normalizeSnapshot(snapshot: SettingsSnapshotDto) {
    if (this.nativeWindowCapabilities) return snapshot;
    return {
      ...snapshot,
      capabilities: {
        ...snapshot.capabilities,
        backupRestore: "unavailable" as const,
        nativeSidebarMaterial: "unavailable" as const,
        windowLifecycle: "unavailable" as const,
      },
    };
  }

  private async ensureRemoteSubscription() {
    if (this.disposed || this.snapshotListeners.size === 0 || this.remoteSubscriptionId) return;
    if (this.subscriptionPromise) {
      this.subscriptionRetryPending = true;
      return this.subscriptionPromise;
    }
    const generation = this.subscriptionGeneration;
    this.subscriptionPromise = this.rpc
      .request("settings.subscribe", {})
      .then(({ snapshot, subscriptionId }) => {
        if (generation !== this.subscriptionGeneration || this.snapshotListeners.size === 0) {
          void this.rpc.request("settings.unsubscribe", { subscriptionId }).catch(() => undefined);
          return;
        }
        this.remoteSubscriptionId = subscriptionId;
        this.receiveSnapshot({ snapshot, subscriptionId }, "baseline");
      })
      .catch(() => undefined)
      .finally(() => {
        this.subscriptionPromise = null;
        if (!this.subscriptionRetryPending) return;
        this.subscriptionRetryPending = false;
        void this.ensureRemoteSubscription();
      });
    return this.subscriptionPromise;
  }

  private receiveSnapshot(
    notification: SettingsSnapshotNotificationDto,
    delivery: SettingsSnapshotDelivery = "update",
  ) {
    if (notification.subscriptionId !== this.remoteSubscriptionId) return;
    this.acceptSnapshot(notification.snapshot, delivery);
  }

  private receiveConnectionState(state: RpcConnectionState) {
    if (state.phase !== "connected") return;
    this.snapshotAcceptance.armReconnect();
    this.subscriptionGeneration += 1;
    this.remoteSubscriptionId = null;
    void this.ensureRemoteSubscription();
  }

  private async requestSnapshot(
    request: Promise<SettingsSnapshotDto>,
    delivery: "command" | "request",
  ) {
    return this.acceptSnapshot(await request, delivery);
  }

  private acceptSnapshot(snapshot: SettingsSnapshotDto, delivery: SettingsSnapshotDelivery) {
    const normalized = this.normalizeSnapshot(snapshot);
    const previous = this.snapshotAcceptance.snapshot();
    const result = this.snapshotAcceptance.accept(normalized, delivery);
    if (result.kind === "duplicate") this.snapshotAcceptance.completeReconnect();
    if (result.kind !== "accepted") return result.snapshot;

    const effectiveDelivery =
      previous &&
      previous.applicationOrder.authorityId !== result.snapshot.applicationOrder.authorityId
        ? "baseline"
        : delivery;
    for (const listener of this.snapshotListeners) listener(result.snapshot, effectiveDelivery);
    return result.snapshot;
  }
}
