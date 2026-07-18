export type RoutingMode = "rule" | "global" | "direct";
export type RuntimePhase = "inactive" | "connecting" | "healthy" | "stopping" | "error";
export type ProbeStatus = "pending" | "healthy" | "error";

export interface RuntimeStatusDto {
  phase: RuntimePhase;
  systemProxyEnabled: boolean;
  tunEnabled: boolean;
  message: string;
}

export interface TrafficSnapshotDto {
  downloadBytesPerSecond: number;
  uploadBytesPerSecond: number;
  downloadedBytes: number;
  uploadedBytes: number;
  downloadSeries: number[];
  uploadSeries: number[];
}

export interface RuntimeMetricsDto {
  activeConnections: number;
  effectiveRules: number;
  memoryBytes: number;
  uptimeSeconds: number;
}

export interface ProfileSummaryDto {
  id: string;
  label: string;
}

export interface ProxyNodeDto {
  id: string;
  label: string;
  latencyMilliseconds: number | null;
  protocol: string;
}

export interface PolicyGroupDto {
  id: string;
  label: string;
  childIds: string[];
  selectedChildId: string;
  type: "selector";
}

export interface GroupUsageDto {
  groupId: string;
  observedConnectionCount: number;
}

export interface ServiceMonitorDto {
  id: string;
  icon: "apple" | "baidu" | "cloudflare" | "github" | "globe" | "google" | "microsoft";
  label: string;
  url: string;
}

export interface ServiceProbeResultDto {
  monitorId: string;
  latencyMilliseconds: number | null;
  status: ProbeStatus;
  observedAt: string;
  routeTarget: "fixture-only";
}

export interface PlatformCapabilitiesDto {
  systemProxy: "fixture-only";
  tun: "fixture-only";
}

export interface StatusSnapshotDto {
  adapterKind: "fixture";
  activeProfileId: string;
  capabilities: PlatformCapabilitiesDto;
  groups: PolicyGroupDto[];
  groupUsage: GroupUsageDto[];
  metrics: RuntimeMetricsDto;
  nodes: ProxyNodeDto[];
  probeResults: ServiceProbeResultDto[];
  profiles: ProfileSummaryDto[];
  routingMode: RoutingMode;
  runtime: RuntimeStatusDto;
  services: ServiceMonitorDto[];
  traffic: TrafficSnapshotDto;
}

export interface ServiceMonitorDraft {
  id?: string;
  icon: ServiceMonitorDto["icon"];
  label: string;
  url: string;
}

export interface StatusClient {
  getSnapshot(): Promise<StatusSnapshotDto>;
  restoreDefaultServices(): Promise<StatusSnapshotDto>;
  removeServiceMonitor(monitorId: string): Promise<StatusSnapshotDto>;
  selectGroupChild(groupId: string, childId: string): Promise<StatusSnapshotDto>;
  setActiveProfile(profileId: string): Promise<StatusSnapshotDto>;
  setCapture(systemProxyEnabled: boolean, tunEnabled: boolean): Promise<StatusSnapshotDto>;
  setRoutingMode(mode: RoutingMode): Promise<StatusSnapshotDto>;
  upsertServiceMonitor(draft: ServiceMonitorDraft): Promise<StatusSnapshotDto>;
}
