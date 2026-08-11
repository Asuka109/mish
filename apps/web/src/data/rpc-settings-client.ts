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
  type StatusConnectionState,
  type StartupPreferencesDto,
  type WindowCloseBehavior,
  type WindowSurfacePreference,
  type SystemProxyTakeoverPolicy,
  type TunHelperLifecycleOptions,
} from "@mish/contracts";
import {
  RpcSessionAuthority,
  type RpcClient,
  type RpcConnectionState,
  type RpcRequestOptions,
  type RpcSessionTicket,
} from "@mish/rpc-client";
import { projectRpcConnectionState } from "./web-rpc-transport";

type SettingsSnapshotMethod =
  | "settings.getSnapshot"
  | "settings.refreshNetworkDns"
  | "settings.installTunHelper"
  | "settings.repairTunHelper"
  | "settings.removeTunHelper"
  | "settings.setAppearance"
  | "settings.setLanguage"
  | "settings.setOnboardingWelcomeState"
  | "settings.setStartup"
  | "settings.setApplicationLaunchBehavior"
  | "settings.setManagedPorts"
  | "settings.findManagedPorts"
  | "settings.findManagedPort"
  | "settings.setSystemProxyTakeoverPolicy"
  | "settings.setProcessDiscoveryMode"
  | "settings.setCloseOldConnectionsAfterGroupSwitch"
  | "settings.setWindowCloseBehavior"
  | "settings.setWindowSurface";

export class RpcSettingsClient implements SettingsClient {
  private readonly connectionListeners = new Set<(state: StatusConnectionState) => void>();
  private connectionState: StatusConnectionState;
  private readonly sessionAuthority = new RpcSessionAuthority<SettingsSnapshotDto>();
  private readonly snapshotListeners = new Set<
    (snapshot: SettingsSnapshotDto, delivery?: SettingsSnapshotDelivery) => void
  >();
  private remoteSubscriptionId: string | null = null;
  private subscriptionPromise: Promise<void> | null = null;
  private subscriptionRetryPending = false;
  private disposed = false;
  private readonly unsubscribeNotification: () => void;
  private readonly unsubscribeRpcConnection: () => void;
  private subscriptionTicket: RpcSessionTicket | null = null;

  constructor(
    private readonly rpc: RpcClient<typeof mishRpcMethods>,
    private readonly nativeWindowCapabilities = true,
  ) {
    this.connectionState = projectRpcConnectionState(
      "getConnectionState" in rpc && typeof rpc.getConnectionState === "function"
        ? rpc.getConnectionState()
        : { attempt: 0, phase: "disconnected", stale: true },
    );
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

  subscribeConnection(listener: (state: StatusConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener({ ...this.connectionState });
    return () => this.connectionListeners.delete(listener);
  }

  getSnapshot(options?: RpcRequestOptions) {
    return this.requestSnapshot("settings.getSnapshot", {}, options, "request");
  }

  refreshNetworkDns(options?: RpcRequestOptions) {
    return this.requestSnapshot("settings.refreshNetworkDns", {}, options, "command");
  }

  installTunHelper(options?: TunHelperLifecycleOptions) {
    const { resumeCapture = false, ...requestOptions } = options ?? {};
    return this.requestSnapshot(
      "settings.installTunHelper",
      { resumeCapture },
      requestOptions,
      "command",
    );
  }

  repairTunHelper(options?: TunHelperLifecycleOptions) {
    const { resumeCapture = false, ...requestOptions } = options ?? {};
    return this.requestSnapshot(
      "settings.repairTunHelper",
      { resumeCapture },
      requestOptions,
      "command",
    );
  }

  removeTunHelper(options?: RpcRequestOptions) {
    return this.requestSnapshot("settings.removeTunHelper", {}, options, "command");
  }

  setAppearance(appearance: AppearancePreference, options?: RpcRequestOptions) {
    return this.requestSnapshot("settings.setAppearance", { appearance }, options, "command");
  }

  setLanguage(language: LanguagePreference, options?: RpcRequestOptions) {
    return this.requestSnapshot("settings.setLanguage", { language }, options, "command");
  }

  setOnboardingWelcomeState(action: OnboardingWelcomeAction, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      "settings.setOnboardingWelcomeState",
      { action },
      options,
      "command",
    );
  }

  setStartup(startup: StartupPreferencesDto, options?: RpcRequestOptions) {
    return this.requestSnapshot("settings.setStartup", { startup }, options, "command");
  }

  setApplicationLaunchBehavior(
    launchBehavior: ApplicationLaunchBehavior,
    options?: RpcRequestOptions,
  ) {
    return this.requestSnapshot(
      "settings.setApplicationLaunchBehavior",
      { launchBehavior },
      options,
      "command",
    );
  }

  setManagedPorts(managedPorts: ManagedPortPreferencesDto, options?: RpcRequestOptions) {
    return this.requestSnapshot("settings.setManagedPorts", { managedPorts }, options, "command");
  }

  findManagedPorts(options?: RpcRequestOptions) {
    return this.requestSnapshot("settings.findManagedPorts", {}, options, "command");
  }

  findManagedPort(kind: ManagedPortKind, options?: RpcRequestOptions) {
    return this.requestSnapshot("settings.findManagedPort", { kind }, options, "command");
  }

  setSystemProxyTakeoverPolicy(policy: SystemProxyTakeoverPolicy, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      "settings.setSystemProxyTakeoverPolicy",
      { policy },
      options,
      "command",
    );
  }

  setProcessDiscoveryMode(mode: ProcessDiscoveryMode, options?: RpcRequestOptions) {
    return this.requestSnapshot("settings.setProcessDiscoveryMode", { mode }, options, "command");
  }

  setCloseOldConnectionsAfterGroupSwitch(enabled: boolean, options?: RpcRequestOptions) {
    return this.requestSnapshot(
      "settings.setCloseOldConnectionsAfterGroupSwitch",
      { enabled },
      options,
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
      "settings.setWindowCloseBehavior",
      { behavior },
      options,
      "command",
    );
  }

  setWindowSurface(surface: WindowSurfacePreference, options?: RpcRequestOptions) {
    return this.requestSnapshot("settings.setWindowSurface", { surface }, options, "command");
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
    if (this.connectionState.phase !== "connected") {
      this.sessionAuthority.observeTransport(true);
    }
    const ticket = this.sessionAuthority.beginSubscription();
    this.subscriptionPromise = this.rpc
      .request("settings.subscribe", {})
      .then(({ snapshot, subscriptionId }) => {
        if (
          this.snapshotListeners.size === 0 ||
          (ticket.generation !== null &&
            ticket.generation !== this.sessionAuthority.getGeneration())
        ) {
          void this.rpc.request("settings.unsubscribe", { subscriptionId }).catch(() => undefined);
          return;
        }
        this.remoteSubscriptionId = subscriptionId;
        this.subscriptionTicket = ticket;
        this.receiveSnapshot({ snapshot, subscriptionId }, "baseline", ticket);
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
    ticket = this.subscriptionTicket,
  ) {
    if (notification.subscriptionId !== this.remoteSubscriptionId || !ticket) return;
    this.acceptSnapshot(notification.snapshot, delivery, ticket);
  }

  private receiveConnectionState(state: RpcConnectionState) {
    const mapped = projectRpcConnectionState(state);
    const previous = this.connectionState;
    this.connectionState = mapped;
    for (const listener of this.connectionListeners) listener({ ...mapped });
    if (
      mapped.phase === "connected" &&
      (previous.phase === "connected" || this.remoteSubscriptionId !== null)
    ) {
      this.sessionAuthority.observeTransport(false);
      this.sessionAuthority.observeTransport(true);
    } else {
      this.sessionAuthority.observeTransport(mapped.phase === "connected");
    }
    if (mapped.phase !== "connected") return;
    this.remoteSubscriptionId = null;
    this.subscriptionTicket = null;
    void this.ensureRemoteSubscription();
  }

  private emitConnectionState(state: StatusConnectionState) {
    this.connectionState = state;
    for (const listener of this.connectionListeners) listener({ ...state });
  }

  private async requestSnapshot(
    method: SettingsSnapshotMethod,
    params: Parameters<RpcClient<typeof mishRpcMethods>["request"]>[1],
    options: RpcRequestOptions | undefined,
    delivery: "command" | "request",
  ) {
    const ticket = this.sessionAuthority.beginRequest();
    return this.acceptSnapshot(
      (await this.rpc.request(method, params as never, options)) as SettingsSnapshotDto,
      delivery,
      ticket,
    );
  }

  private acceptSnapshot(
    snapshot: SettingsSnapshotDto,
    delivery: SettingsSnapshotDelivery | "command" | "request",
    ticket: RpcSessionTicket,
  ) {
    const normalized = this.normalizeSnapshot(snapshot);
    const result = this.sessionAuthority.accept(ticket, normalized, delivery);
    if (result.kind === "conflict") {
      this.emitConnectionState({ ...this.connectionState, stale: true });
      return result.snapshot ?? normalized;
    }
    this.emitSnapshotConnectionState();
    if (!result.snapshot) return normalized;
    const effectiveDelivery = delivery;
    for (const listener of this.snapshotListeners) listener(result.snapshot, effectiveDelivery);
    return result.snapshot;
  }

  private emitSnapshotConnectionState() {
    this.emitConnectionState({
      attempt: 0,
      phase: "connected",
      stale: this.sessionAuthority.isStale(),
    });
  }
}
