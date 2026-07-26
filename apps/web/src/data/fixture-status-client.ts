import type {
  CaptureSelectionDto,
  CaptureRecoveryAction,
  ApplicationSnapshotDelivery,
  LocalProxyTestResultDto,
  ServiceMonitorDto,
  ServiceMonitorDraft,
  ServiceProbeIntervalSeconds,
  StatusClient,
  StatusConnectionState,
  StatusCommand,
  StatusSnapshotDto,
  RoutingMode,
} from "@mish/contracts";
import { SERVICE_ICON_URLS, StatusClientError } from "@mish/contracts";

const defaultServices: ServiceMonitorDto[] = [
  {
    icon: SERVICE_ICON_URLS.google,
    id: "google",
    label: "Google",
    url: "https://www.google.com/generate_204",
  },
  {
    icon: SERVICE_ICON_URLS.github,
    id: "github",
    label: "GitHub",
    url: "https://github.com/favicon.ico",
  },
  {
    icon: SERVICE_ICON_URLS.cloudflare,
    id: "cloudflare",
    label: "Cloudflare",
    url: "https://cp.cloudflare.com/generate_204",
  },
  {
    icon: SERVICE_ICON_URLS.baidu,
    id: "baidu",
    label: "Baidu",
    url: "https://www.baidu.com/favicon.ico",
  },
  {
    icon: SERVICE_ICON_URLS.weixin,
    id: "weixin",
    label: "Weixin",
    url: "https://res.wx.qq.com/a/wx_fed/assets/res/NTI4MWU5.ico",
  },
  {
    icon: SERVICE_ICON_URLS.aws,
    id: "aws-us-east-1",
    label: "AWS (us-east-1)",
    url: "https://dynamodb.us-east-1.amazonaws.com/ping",
  },
];

const fixtureNodes = [
  { id: "hkg-02", label: "🇭🇰 HKG-02", latencyMilliseconds: 38, protocol: "Hysteria2" },
  { id: "hkg-01", label: "🇭🇰 HKG-01", latencyMilliseconds: 52, protocol: "Hysteria2" },
  { id: "nrt-03", label: "🇯🇵 NRT-03", latencyMilliseconds: 71, protocol: "VLESS" },
  { id: "sin-01", label: "🇸🇬 SIN-01", latencyMilliseconds: 83, protocol: "Trojan" },
  { id: "fra-01", label: "🇩🇪 Frankfurt · Arbeit", latencyMilliseconds: 164, protocol: "VLESS" },
  { id: "unicode-01", label: "台北・開発 🚄", latencyMilliseconds: null, protocol: "TUIC" },
] satisfies StatusSnapshotDto["nodes"];

const largeFixtureNodes = Array.from({ length: 160 }, (_, index) => {
  const sequence = String(index + 1).padStart(3, "0");
  return {
    id: `fixture-scale-${sequence}`,
    label: `Scale fixture node ${sequence}`,
    latencyMilliseconds: index % 9 === 0 ? null : 40 + ((index * 17) % 280),
    protocol: index % 2 === 0 ? "VLESS" : "Hysteria2",
  };
}) satisfies StatusSnapshotDto["nodes"];

const initialSnapshot: StatusSnapshotDto = {
  adapterKind: "fixture",
  activeProfileId: "home",
  applicationOrder: { authorityId: "fixture-status-application", epoch: 1, order: 1 },
  capabilities: {
    systemProxy: "fixture-only",
    tun: "fixture-only",
  },
  groups: [
    {
      childIds: [
        "hkg-02",
        "hkg-01",
        "nrt-03",
        "sin-01",
        "auto-fast",
        "fallback-global",
        "balanced",
        "relay-chain",
        "direct-route",
        "reject-route",
        "unsupported-smart",
      ],
      id: "proxy",
      label: "🌐 Proxy",
      selectedChildId: "hkg-02",
      type: "selector",
    },
    {
      childIds: ["sin-01", "hkg-02", "nrt-03"],
      id: "streaming",
      label: "🎬 Streaming",
      selectedChildId: "sin-01",
      type: "selector",
    },
    {
      childIds: ["nrt-03", "hkg-02"],
      id: "ai-services",
      label: "🤖 AI services",
      selectedChildId: "nrt-03",
      type: "selector",
    },
    {
      childIds: ["hkg-01", "sin-01"],
      id: "messaging",
      label: "Messaging",
      selectedChildId: "hkg-01",
      type: "selector",
    },
    {
      childIds: ["hkg-02", "nrt-03", "sin-01"],
      id: "development",
      label: "🛠️ Development",
      selectedChildId: "hkg-02",
      type: "selector",
    },
    {
      childIds: ["nrt-03", "sin-01", "unicode-01"],
      id: "auto-fast",
      label: "⚡ 自动选择・Auto",
      selectedChildId: "nrt-03",
      type: "url-test",
    },
    {
      childIds: ["auto-fast", "hkg-02", "fra-01"],
      id: "fallback-global",
      label: "Fallback Europe",
      selectedChildId: "auto-fast",
      type: "fallback",
    },
    {
      childIds: ["hkg-01", "nrt-03", "sin-01", "fra-01", "unicode-01"],
      id: "balanced",
      label: "Balanced pool",
      selectedChildId: null,
      type: "load-balance",
    },
    {
      childIds: ["hkg-01", "sin-01"],
      id: "relay-chain",
      label: "Relay chain",
      selectedChildId: null,
      type: "relay",
    },
    {
      childIds: [],
      id: "direct-route",
      label: "DIRECT",
      selectedChildId: null,
      type: "direct",
    },
    {
      childIds: [],
      id: "reject-route",
      label: "REJECT",
      selectedChildId: null,
      type: "reject",
    },
    {
      childIds: ["unicode-01"],
      id: "unsupported-smart",
      label: "Provider smart policy",
      selectedChildId: "unicode-01",
      type: "unsupported",
      unsupportedType: "smart-group",
    },
    {
      childIds: largeFixtureNodes.map((node) => node.id),
      id: "large-fixture",
      label: "Scale verification pool · 160",
      selectedChildId: null,
      type: "load-balance",
    },
  ],
  groupDelayPolicy: {
    id: "fixture-only",
    timeoutMilliseconds: 5_000,
    url: "https://www.gstatic.com/generate_204",
  },
  groupDelayTest: {
    children: [],
    finishedAt: null,
    groupId: null,
    phase: "idle",
    profileId: null,
    startedAt: null,
    testId: null,
  },
  groupUsage: [
    { groupId: "proxy", observedConnectionCount: 12_842 },
    { groupId: "streaming", observedConnectionCount: 4_906 },
    { groupId: "ai-services", observedConnectionCount: 2_741 },
    { groupId: "messaging", observedConnectionCount: 986 },
    { groupId: "development", observedConnectionCount: 742 },
  ],
  metrics: {
    activeConnections: 24,
    effectiveRules: 12_846,
    memoryBytes: 90_177_536,
    uptimeSeconds: 0,
  },
  nodes: [...fixtureNodes, ...largeFixtureNodes],
  probeResults: [
    {
      latencyMilliseconds: 48,
      monitorId: "google",
      observedAt: "2026-07-18T08:00:00Z",
      routeTarget: "fixture-only",
      status: "healthy",
    },
    {
      latencyMilliseconds: 92,
      monitorId: "github",
      observedAt: "2026-07-18T08:00:00Z",
      routeTarget: "fixture-only",
      status: "healthy",
    },
    {
      latencyMilliseconds: 31,
      monitorId: "cloudflare",
      observedAt: "2026-07-18T08:00:00Z",
      routeTarget: "fixture-only",
      status: "healthy",
    },
    {
      latencyMilliseconds: 12,
      monitorId: "baidu",
      observedAt: "2026-07-18T08:00:00Z",
      routeTarget: "fixture-only",
      status: "healthy",
    },
    {
      latencyMilliseconds: 56,
      monitorId: "weixin",
      observedAt: "2026-07-18T08:00:00Z",
      routeTarget: "fixture-only",
      status: "healthy",
    },
    {
      latencyMilliseconds: 64,
      monitorId: "aws-us-east-1",
      observedAt: "2026-07-18T08:00:00Z",
      routeTarget: "fixture-only",
      status: "healthy",
    },
  ],
  profiles: [
    { id: "home", label: "Home" },
    { id: "work", label: "Work 工作" },
    { id: "travel", label: "旅行 ✈️" },
  ],
  recentTraffic: {
    authorityId: "fixture-status-authority",
    revision: 0,
    phase: "idle",
    sessionId: null,
    profileId: null,
    cadenceMilliseconds: 1_000,
    windowMilliseconds: 60_000,
    downloadedBytes: 0,
    uploadedBytes: 0,
    downloadBytesPerSecond: 0,
    uploadBytesPerSecond: 0,
    samples: [],
  },
  routingMode: "rule",
  runtime: {
    captureOperation: {
      operationId: null,
      phase: "idle",
      scopeEpoch: "fixture-capture-scope",
    },
    captureSelection: { systemProxy: false, tun: false },
    message: "Fixture capture is inactive",
    phase: "healthy",
    systemProxy: {
      desired: false,
      failure: null,
      observed: "disabled",
      phase: "off",
      recoveryActions: [],
    },
    systemProxyEnabled: false,
    tun: {
      desired: false,
      failure: null,
      observation: null,
      observed: "disabled",
      phase: "off",
    },
    tunEnabled: false,
  },
  serviceProbePolicy: { intervalSeconds: 5 },
  services: defaultServices,
  traffic: {
    downloadBytesPerSecond: 2_568_192,
    downloadSeries: [18, 22, 19, 27, 25, 34, 31, 39, 33, 36, 42, 38, 44, 40, 47, 43],
    downloadedBytes: 13_781_123_072,
    uploadBytesPerSecond: 1_237_074,
    uploadSeries: [12, 15, 14, 18, 17, 21, 19, 24, 22, 27, 25, 29, 26, 31, 28, 33],
    uploadedBytes: 4_144_644_096,
  },
};

function cloneSnapshot(snapshot: StatusSnapshotDto) {
  return structuredClone(snapshot);
}

function createMonitorId() {
  return globalThis.crypto?.randomUUID?.() ?? `service-${Date.now()}`;
}

export class FixtureStatusClient implements StatusClient {
  private snapshot = cloneSnapshot(initialSnapshot);
  private captureOperationId = 0;
  private recentTrafficSession = 0;
  private readonly connectionListeners = new Set<(state: StatusConnectionState) => void>();
  private readonly snapshotListeners = new Set<
    (snapshot: StatusSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();

  dispose() {
    this.connectionListeners.clear();
    this.snapshotListeners.clear();
  }

  getConnectionState(): StatusConnectionState {
    return { attempt: 0, phase: "fixture", stale: false };
  }

  subscribeConnection(listener: (state: StatusConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  subscribeSnapshots(
    listener: (snapshot: StatusSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ) {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }

  supportsCommand(command: StatusCommand): boolean {
    return command !== "group-delay";
  }

  private async snapshotAfterCommand() {
    this.snapshot.applicationOrder.order += 1;
    const snapshot = await this.getSnapshot();
    for (const listener of this.snapshotListeners) listener(snapshot, "update");
    return snapshot;
  }

  async getSnapshot(options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture request was cancelled");
    }
    return cloneSnapshot(this.snapshot);
  }

  async setRoutingMode(mode: RoutingMode, options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture command was cancelled");
    }
    this.snapshot.routingMode = mode;
    return this.snapshotAfterCommand();
  }

  async setServiceProbeInterval(
    intervalSeconds: ServiceProbeIntervalSeconds,
    options?: { signal?: AbortSignal },
  ) {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture command was cancelled");
    }
    this.snapshot.serviceProbePolicy.intervalSeconds = intervalSeconds;
    return this.snapshotAfterCommand();
  }

  async testServiceMonitor(monitorId: string, options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture command was cancelled");
    }
    const result = this.snapshot.probeResults.find(
      (candidate) => candidate.monitorId === monitorId,
    );
    if (!result) {
      throw new StatusClientError("not-found", "Service monitor not found");
    }
    result.observedAt = new Date().toISOString();
    return this.snapshotAfterCommand();
  }

  async setCapture(
    selection: CaptureSelectionDto,
    active: boolean,
    options?: { signal?: AbortSignal },
  ) {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture command was cancelled");
    }
    const systemProxyEnabled = active && selection.systemProxy;
    const tunEnabled = active && selection.tun;
    const captureActive = systemProxyEnabled || tunEnabled;
    this.captureOperationId += 1;
    this.snapshot.metrics.uptimeSeconds = captureActive ? 1 : 0;
    this.snapshot.runtime = {
      captureOperation: {
        operationId: this.captureOperationId.toString(),
        phase: "applied",
        scopeEpoch: "fixture-capture-scope",
      },
      captureSelection: { ...selection },
      message: captureActive ? "Fixture capture is active" : "Fixture capture is inactive",
      phase: captureActive ? "healthy" : "inactive",
      systemProxy: {
        desired: systemProxyEnabled,
        failure: null,
        observed: systemProxyEnabled ? "mish" : "disabled",
        phase: systemProxyEnabled ? "applied" : "off",
        recoveryActions: [],
      },
      systemProxyEnabled,
      tun: {
        desired: tunEnabled,
        failure: null,
        observation: tunEnabled
          ? {
              core: "confirmed",
              dns: "confirmed",
              interface: "confirmed",
              observedAt: Date.now(),
              routes: "confirmed",
              schemaVersion: 1,
            }
          : null,
        observed: tunEnabled ? "enabled" : "disabled",
        phase: tunEnabled ? "applied" : "off",
      },
      tunEnabled,
    };
    this.snapshot.recentTraffic.revision += 1;
    if (captureActive) {
      if (this.snapshot.recentTraffic.phase === "idle") {
        this.recentTrafficSession += 1;
        this.snapshot.recentTraffic.sessionId = `fixture-status-session-${this.recentTrafficSession}`;
      }
      this.snapshot.recentTraffic.phase = "active";
      this.snapshot.recentTraffic.profileId = this.snapshot.activeProfileId;
    } else {
      this.snapshot.recentTraffic = {
        ...this.snapshot.recentTraffic,
        revision: this.snapshot.recentTraffic.revision,
        phase: "idle",
        sessionId: null,
        profileId: null,
        downloadedBytes: 0,
        uploadedBytes: 0,
        downloadBytesPerSecond: 0,
        uploadBytesPerSecond: 0,
        samples: [],
      };
    }
    return this.snapshotAfterCommand();
  }

  async recoverSystemProxy(
    _action: CaptureRecoveryAction,
    options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto> {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture command was cancelled");
    }
    throw new StatusClientError("invalid-request", "The fixture has no observed system drift");
  }

  async testLocalProxy(options?: { signal?: AbortSignal }): Promise<LocalProxyTestResultDto> {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture request was cancelled");
    }
    throw new StatusClientError("unsupported", "Demo mode has no local Mihomo proxy listener");
  }

  async setActiveProfile(profileId: string, options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture command was cancelled");
    }
    if (!this.snapshot.profiles.some((profile) => profile.id === profileId)) {
      throw new StatusClientError("not-found", "Unknown fixture profile");
    }

    this.snapshot.activeProfileId = profileId;
    if (this.snapshot.recentTraffic.phase !== "idle") {
      this.recentTrafficSession += 1;
      this.snapshot.recentTraffic = {
        ...this.snapshot.recentTraffic,
        revision: this.snapshot.recentTraffic.revision + 1,
        sessionId: `fixture-status-session-${this.recentTrafficSession}`,
        profileId,
        downloadedBytes: 0,
        uploadedBytes: 0,
        downloadBytesPerSecond: 0,
        uploadBytesPerSecond: 0,
        samples: [],
      };
    }
    return this.snapshotAfterCommand();
  }

  async selectGroupChild(groupId: string, childId: string, options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture command was cancelled");
    }
    const group = this.snapshot.groups.find((candidate) => candidate.id === groupId);
    if (!group || group.type !== "selector" || !group.childIds.includes(childId)) {
      throw new StatusClientError(
        "invalid-request",
        "The fixture child does not belong to this group or the group is not a selector",
      );
    }

    group.selectedChildId = childId;
    return this.snapshotAfterCommand();
  }

  async startGroupDelayTest(
    _groupId: string,
    _options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto> {
    throw new StatusClientError("unsupported", "Demo mode does not execute Mihomo delay tests");
  }

  async cancelGroupDelayTest(
    _testId: string,
    _options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto> {
    throw new StatusClientError("unsupported", "Demo mode does not own Mihomo delay tests");
  }

  async upsertServiceMonitor(draft: ServiceMonitorDraft, options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture command was cancelled");
    }
    const monitor: ServiceMonitorDto = {
      icon: draft.icon,
      id: draft.id ?? createMonitorId(),
      label: draft.label.trim(),
      url: draft.url.trim(),
    };
    const existingIndex = this.snapshot.services.findIndex((service) => service.id === monitor.id);

    if (existingIndex >= 0) {
      this.snapshot.services[existingIndex] = monitor;
    } else {
      if (this.snapshot.services.length >= 12) {
        throw new StatusClientError("invalid-request", "Service monitor limit reached");
      }
      this.snapshot.services.push(monitor);
      this.snapshot.probeResults.push({
        latencyMilliseconds: null,
        monitorId: monitor.id,
        observedAt: "2026-07-18T08:00:00Z",
        routeTarget: "fixture-only",
        status: "pending",
      });
    }

    return this.snapshotAfterCommand();
  }

  async removeServiceMonitor(monitorId: string, options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture command was cancelled");
    }
    this.snapshot.services = this.snapshot.services.filter((service) => service.id !== monitorId);
    this.snapshot.probeResults = this.snapshot.probeResults.filter(
      (result) => result.monitorId !== monitorId,
    );
    return this.snapshotAfterCommand();
  }

  async restoreDefaultServices(options?: { signal?: AbortSignal }) {
    if (options?.signal?.aborted) {
      throw new StatusClientError("cancelled", "The fixture command was cancelled");
    }
    this.snapshot.services = structuredClone(defaultServices);
    this.snapshot.serviceProbePolicy.intervalSeconds = 5;
    this.snapshot.probeResults = structuredClone(initialSnapshot.probeResults);
    return this.snapshotAfterCommand();
  }
}

export function createFixtureStatusClient() {
  return new FixtureStatusClient();
}
