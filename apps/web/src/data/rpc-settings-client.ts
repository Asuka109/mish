import {
  mishRpcMethods,
  settingsRpcNotifications,
  type AppearancePreference,
  type LanguagePreference,
  type ManagedPortPreferencesDto,
  type OnboardingWelcomeAction,
  type SettingsClient,
  type SettingsSnapshotDto,
  type SettingsSnapshotNotificationDto,
  type StartupPreferencesDto,
  type WindowCloseBehavior,
  type WindowSurfacePreference,
} from "@mish/contracts";
import type { RpcClient, RpcConnectionState, RpcRequestOptions } from "@mish/rpc-client";

export class RpcSettingsClient implements SettingsClient {
  private readonly snapshotListeners = new Set<(snapshot: SettingsSnapshotDto) => void>();
  private remoteSubscriptionId: string | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private latestRevision = 0;
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
    return this.rpc
      .request("settings.getSnapshot", {}, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  refreshNetworkDns(options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.refreshNetworkDns", {}, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  installTunHelper(options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.installTunHelper", {}, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  repairTunHelper(options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.repairTunHelper", {}, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  removeTunHelper(options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.removeTunHelper", {}, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setAppearance(appearance: AppearancePreference, options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.setAppearance", { appearance }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setLanguage(language: LanguagePreference, options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.setLanguage", { language }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setOnboardingWelcomeState(action: OnboardingWelcomeAction, options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.setOnboardingWelcomeState", { action }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setStartup(startup: StartupPreferencesDto, options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.setStartup", { startup }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setLaunchProxyWhenMishLaunches(
    launchProxyWhenMishLaunches: boolean,
    options?: RpcRequestOptions,
  ) {
    return this.rpc
      .request("settings.setLaunchProxyWhenMishLaunches", { launchProxyWhenMishLaunches }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setManagedPorts(managedPorts: ManagedPortPreferencesDto, options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.setManagedPorts", { managedPorts }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  findManagedPorts(options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.findManagedPorts", {}, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  subscribeSnapshots(listener: (snapshot: SettingsSnapshotDto) => void) {
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
    return this.rpc
      .request("settings.setWindowCloseBehavior", { behavior }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
  }

  setWindowSurface(surface: WindowSurfacePreference, options?: RpcRequestOptions) {
    return this.rpc
      .request("settings.setWindowSurface", { surface }, options)
      .then((snapshot) => this.normalizeSnapshot(snapshot));
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
    this.subscriptionPromise = this.rpc
      .request("settings.subscribe", {})
      .then(({ snapshot, subscriptionId }) => {
        if (this.snapshotListeners.size === 0) {
          void this.rpc.request("settings.unsubscribe", { subscriptionId }).catch(() => undefined);
          return;
        }
        this.remoteSubscriptionId = subscriptionId;
        this.receiveSnapshot({ snapshot, subscriptionId });
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

  private receiveSnapshot(notification: SettingsSnapshotNotificationDto) {
    if (notification.subscriptionId !== this.remoteSubscriptionId) return;
    const snapshot = this.normalizeSnapshot(notification.snapshot);
    if (snapshot.revision < this.latestRevision) return;
    this.latestRevision = snapshot.revision;
    for (const listener of this.snapshotListeners) listener(snapshot);
  }

  private receiveConnectionState(state: RpcConnectionState) {
    if (state.phase !== "connected") return;
    this.remoteSubscriptionId = null;
    void this.ensureRemoteSubscription();
  }
}
