import type {
  ServiceMonitorDto,
  ServiceMonitorDraft,
  StatusClient,
  StatusSnapshotDto,
  RoutingMode,
} from "./status-client";

const defaultServices: ServiceMonitorDto[] = [
  {
    icon: "google",
    id: "google",
    label: "Google",
    url: "https://www.google.com/generate_204",
  },
  { icon: "github", id: "github", label: "GitHub", url: "https://github.com" },
  {
    icon: "cloudflare",
    id: "cloudflare",
    label: "Cloudflare",
    url: "https://cp.cloudflare.com/generate_204",
  },
  { icon: "baidu", id: "baidu", label: "Baidu", url: "https://www.baidu.com" },
  {
    icon: "apple",
    id: "apple",
    label: "Apple",
    url: "https://www.apple.com/library/test/success.html",
  },
  {
    icon: "microsoft",
    id: "microsoft",
    label: "Microsoft",
    url: "https://www.msftconnecttest.com/connecttest.txt",
  },
];

const initialSnapshot: StatusSnapshotDto = {
  adapterKind: "fixture",
  activeProfileId: "home",
  capabilities: {
    systemProxy: "fixture-only",
    tun: "fixture-only",
  },
  groups: [
    {
      childIds: ["hkg-02", "hkg-01", "nrt-03", "sin-01"],
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
  ],
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
    uptimeSeconds: 5_047,
  },
  nodes: [
    { id: "hkg-02", label: "🇭🇰 HKG-02", latencyMilliseconds: 38, protocol: "Hysteria2" },
    { id: "hkg-01", label: "🇭🇰 HKG-01", latencyMilliseconds: 52, protocol: "Hysteria2" },
    { id: "nrt-03", label: "🇯🇵 NRT-03", latencyMilliseconds: 71, protocol: "VLESS" },
    { id: "sin-01", label: "🇸🇬 SIN-01", latencyMilliseconds: 83, protocol: "Trojan" },
  ],
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
      monitorId: "apple",
      observedAt: "2026-07-18T08:00:00Z",
      routeTarget: "fixture-only",
      status: "healthy",
    },
    {
      latencyMilliseconds: 64,
      monitorId: "microsoft",
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
  routingMode: "rule",
  runtime: {
    message: "Fixture capture is active",
    phase: "healthy",
    systemProxyEnabled: true,
    tunEnabled: false,
  },
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

  async getSnapshot() {
    return cloneSnapshot(this.snapshot);
  }

  async setRoutingMode(mode: RoutingMode) {
    this.snapshot.routingMode = mode;
    return this.getSnapshot();
  }

  async setCapture(systemProxyEnabled: boolean, tunEnabled: boolean) {
    this.snapshot.runtime = {
      message:
        systemProxyEnabled || tunEnabled
          ? "Fixture capture is active"
          : "Fixture capture is inactive",
      phase: systemProxyEnabled || tunEnabled ? "healthy" : "inactive",
      systemProxyEnabled,
      tunEnabled,
    };
    return this.getSnapshot();
  }

  async setActiveProfile(profileId: string) {
    if (!this.snapshot.profiles.some((profile) => profile.id === profileId)) {
      throw new Error("Unknown fixture profile");
    }

    this.snapshot.activeProfileId = profileId;
    return this.getSnapshot();
  }

  async selectGroupChild(groupId: string, childId: string) {
    const group = this.snapshot.groups.find((candidate) => candidate.id === groupId);
    if (!group || !group.childIds.includes(childId)) {
      throw new Error("The fixture child does not belong to this group");
    }

    group.selectedChildId = childId;
    return this.getSnapshot();
  }

  async upsertServiceMonitor(draft: ServiceMonitorDraft) {
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
      this.snapshot.services.push(monitor);
      this.snapshot.probeResults.push({
        latencyMilliseconds: null,
        monitorId: monitor.id,
        observedAt: "2026-07-18T08:00:00Z",
        routeTarget: "fixture-only",
        status: "pending",
      });
    }

    return this.getSnapshot();
  }

  async removeServiceMonitor(monitorId: string) {
    this.snapshot.services = this.snapshot.services.filter((service) => service.id !== monitorId);
    this.snapshot.probeResults = this.snapshot.probeResults.filter(
      (result) => result.monitorId !== monitorId,
    );
    return this.getSnapshot();
  }

  async restoreDefaultServices() {
    this.snapshot.services = structuredClone(defaultServices);
    this.snapshot.probeResults = structuredClone(initialSnapshot.probeResults);
    return this.getSnapshot();
  }
}

export function createFixtureStatusClient() {
  return new FixtureStatusClient();
}
