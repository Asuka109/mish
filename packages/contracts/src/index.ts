import * as z from "zod";

const IdentifierSchema = z.string().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const NonNegativeNumberSchema = z.number().nonnegative().finite();

export const RoutingModeSchema = z.enum(["rule", "global", "direct"]);
export type RoutingMode = z.infer<typeof RoutingModeSchema>;

export const RuntimePhaseSchema = z.enum([
  "inactive",
  "connecting",
  "healthy",
  "stopping",
  "error",
]);
export type RuntimePhase = z.infer<typeof RuntimePhaseSchema>;

export const ProbeStatusSchema = z.enum(["pending", "healthy", "error"]);
export type ProbeStatus = z.infer<typeof ProbeStatusSchema>;

export const CaptureSelectionSchema = z
  .object({ systemProxy: z.boolean(), tun: z.boolean() })
  .strict();
export interface CaptureSelectionDto extends z.infer<typeof CaptureSelectionSchema> {}

export const RuntimeStatusSchema = z
  .object({
    captureSelection: CaptureSelectionSchema,
    message: z.string(),
    phase: RuntimePhaseSchema,
    systemProxyEnabled: z.boolean(),
    tunEnabled: z.boolean(),
  })
  .strict();
export interface RuntimeStatusDto extends z.infer<typeof RuntimeStatusSchema> {}

export const TrafficSnapshotSchema = z
  .object({
    downloadBytesPerSecond: NonNegativeNumberSchema,
    downloadSeries: z.array(NonNegativeNumberSchema).max(512),
    downloadedBytes: NonNegativeNumberSchema,
    uploadBytesPerSecond: NonNegativeNumberSchema,
    uploadSeries: z.array(NonNegativeNumberSchema).max(512),
    uploadedBytes: NonNegativeNumberSchema,
  })
  .strict();
export interface TrafficSnapshotDto extends z.infer<typeof TrafficSnapshotSchema> {}

export const RuntimeMetricsSchema = z
  .object({
    activeConnections: NonNegativeIntegerSchema,
    effectiveRules: NonNegativeIntegerSchema,
    memoryBytes: NonNegativeNumberSchema,
    uptimeSeconds: NonNegativeIntegerSchema,
  })
  .strict();
export interface RuntimeMetricsDto extends z.infer<typeof RuntimeMetricsSchema> {}

export const ProfileSummarySchema = z
  .object({
    id: IdentifierSchema,
    label: z.string(),
  })
  .strict();
export interface ProfileSummaryDto extends z.infer<typeof ProfileSummarySchema> {}

export const ProxyNodeSchema = z
  .object({
    id: IdentifierSchema,
    label: z.string(),
    latencyMilliseconds: NonNegativeNumberSchema.nullable(),
    protocol: z.string(),
  })
  .strict();
export interface ProxyNodeDto extends z.infer<typeof ProxyNodeSchema> {}

export const PolicyGroupSchema = z
  .object({
    childIds: z.array(IdentifierSchema),
    id: IdentifierSchema,
    label: z.string(),
    selectedChildId: IdentifierSchema,
    type: z.literal("selector"),
  })
  .strict();
export interface PolicyGroupDto extends z.infer<typeof PolicyGroupSchema> {}

export const GroupUsageSchema = z
  .object({
    groupId: IdentifierSchema,
    observedConnectionCount: NonNegativeIntegerSchema,
  })
  .strict();
export interface GroupUsageDto extends z.infer<typeof GroupUsageSchema> {}

export const ServiceIconSchema = z.enum([
  "apple",
  "baidu",
  "cloudflare",
  "github",
  "globe",
  "google",
  "microsoft",
]);

export const ServiceMonitorSchema = z
  .object({
    icon: ServiceIconSchema,
    id: IdentifierSchema,
    label: z.string(),
    url: z.string(),
  })
  .strict();
export interface ServiceMonitorDto extends z.infer<typeof ServiceMonitorSchema> {}

export const ProbeRouteTargetSchema = z.union([
  z.literal("fixture-only"),
  z.literal("direct"),
  z.string().regex(/^(group|proxy):.+$/u),
]);
export type ProbeRouteTarget = z.infer<typeof ProbeRouteTargetSchema>;

export const ServiceProbeResultSchema = z
  .object({
    latencyMilliseconds: NonNegativeNumberSchema.nullable(),
    monitorId: IdentifierSchema,
    observedAt: z.string().min(1),
    routeTarget: ProbeRouteTargetSchema,
    status: ProbeStatusSchema,
  })
  .strict();
export interface ServiceProbeResultDto extends z.infer<typeof ServiceProbeResultSchema> {}

export const CapabilityAvailabilitySchema = z.enum([
  "fixture-only",
  "supported",
  "unavailable",
  "permission-required",
]);
export type CapabilityAvailability = z.infer<typeof CapabilityAvailabilitySchema>;

export const PlatformCapabilitiesSchema = z
  .object({
    systemProxy: CapabilityAvailabilitySchema,
    tun: CapabilityAvailabilitySchema,
  })
  .strict();
export interface PlatformCapabilitiesDto extends z.infer<typeof PlatformCapabilitiesSchema> {}

export const StatusSnapshotSchema = z
  .object({
    activeProfileId: IdentifierSchema,
    adapterKind: z.enum(["fixture", "rpc"]),
    capabilities: PlatformCapabilitiesSchema,
    groups: z.array(PolicyGroupSchema),
    groupUsage: z.array(GroupUsageSchema),
    metrics: RuntimeMetricsSchema,
    nodes: z.array(ProxyNodeSchema),
    probeResults: z.array(ServiceProbeResultSchema),
    profiles: z.array(ProfileSummarySchema),
    routingMode: RoutingModeSchema,
    runtime: RuntimeStatusSchema,
    services: z.array(ServiceMonitorSchema),
    traffic: TrafficSnapshotSchema,
  })
  .strict();
export interface StatusSnapshotDto extends z.infer<typeof StatusSnapshotSchema> {}

export const RpcStatusSnapshotSchema = StatusSnapshotSchema.extend({
  adapterKind: z.literal("rpc"),
});
export interface RpcStatusSnapshotDto extends z.infer<typeof RpcStatusSnapshotSchema> {}

export const ServiceMonitorDraftSchema = ServiceMonitorSchema.omit({ id: true })
  .extend({ id: IdentifierSchema.optional() })
  .strict();
export interface ServiceMonitorDraft extends z.infer<typeof ServiceMonitorDraftSchema> {}

export const SetRoutingModeCommandSchema = z.object({ mode: RoutingModeSchema }).strict();
export interface SetRoutingModeCommand extends z.infer<typeof SetRoutingModeCommandSchema> {}

export const SetCaptureCommandSchema = z
  .object({ active: z.boolean(), selection: CaptureSelectionSchema })
  .strict();
export interface SetCaptureCommand extends z.infer<typeof SetCaptureCommandSchema> {}

export const SetActiveProfileCommandSchema = z.object({ profileId: IdentifierSchema }).strict();
export interface SetActiveProfileCommand extends z.infer<typeof SetActiveProfileCommandSchema> {}

export const SelectGroupChildCommandSchema = z
  .object({ childId: IdentifierSchema, groupId: IdentifierSchema })
  .strict();
export interface SelectGroupChildCommand extends z.infer<typeof SelectGroupChildCommandSchema> {}

export const UpsertServiceMonitorCommandSchema = z
  .object({ draft: ServiceMonitorDraftSchema })
  .strict();
export interface UpsertServiceMonitorCommand extends z.infer<
  typeof UpsertServiceMonitorCommandSchema
> {}

export const RemoveServiceMonitorCommandSchema = z.object({ monitorId: IdentifierSchema }).strict();
export interface RemoveServiceMonitorCommand extends z.infer<
  typeof RemoveServiceMonitorCommandSchema
> {}

export const EmptyCommandSchema = z.object({}).strict();

export const StatusSubscriptionSchema = z.object({ subscriptionId: IdentifierSchema }).strict();
export interface StatusSubscriptionDto extends z.infer<typeof StatusSubscriptionSchema> {}

export const StatusSnapshotNotificationSchema = z
  .object({ snapshot: RpcStatusSnapshotSchema, subscriptionId: IdentifierSchema })
  .strict();
export interface StatusSnapshotNotificationDto extends z.infer<
  typeof StatusSnapshotNotificationSchema
> {}

export const statusRpcMethods = {
  "status.getSnapshot": { params: EmptyCommandSchema, result: RpcStatusSnapshotSchema },
  "status.removeServiceMonitor": {
    params: RemoveServiceMonitorCommandSchema,
    result: RpcStatusSnapshotSchema,
  },
  "status.restoreDefaultServices": {
    params: EmptyCommandSchema,
    result: RpcStatusSnapshotSchema,
  },
  "status.selectGroupChild": {
    params: SelectGroupChildCommandSchema,
    result: RpcStatusSnapshotSchema,
  },
  "status.setActiveProfile": {
    params: SetActiveProfileCommandSchema,
    result: RpcStatusSnapshotSchema,
  },
  "status.setCapture": { params: SetCaptureCommandSchema, result: RpcStatusSnapshotSchema },
  "status.setRoutingMode": { params: SetRoutingModeCommandSchema, result: RpcStatusSnapshotSchema },
  "status.subscribe": { params: EmptyCommandSchema, result: StatusSubscriptionSchema },
  "status.unsubscribe": { params: StatusSubscriptionSchema, result: z.boolean() },
  "status.upsertServiceMonitor": {
    params: UpsertServiceMonitorCommandSchema,
    result: RpcStatusSnapshotSchema,
  },
} as const;

export const statusRpcNotifications = {
  "status.snapshot": StatusSnapshotNotificationSchema,
} as const;

export type StatusConnectionPhase =
  | "fixture"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "disposed";

export interface StatusConnectionState {
  attempt: number;
  phase: StatusConnectionPhase;
  stale: boolean;
}

export type StatusClientErrorCode =
  | "cancelled"
  | "conflict"
  | "disconnected"
  | "invalid-request"
  | "not-found"
  | "protocol"
  | "remote"
  | "unknown"
  | "validation";

export class StatusClientError extends Error {
  readonly code: StatusClientErrorCode;
  readonly retryable: boolean;

  constructor(code: StatusClientErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "StatusClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface StatusClient {
  dispose(): void;
  getConnectionState(): StatusConnectionState;
  getSnapshot(options?: { signal?: AbortSignal }): Promise<StatusSnapshotDto>;
  removeServiceMonitor(
    monitorId: string,
    options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto>;
  restoreDefaultServices(options?: { signal?: AbortSignal }): Promise<StatusSnapshotDto>;
  selectGroupChild(
    groupId: string,
    childId: string,
    options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto>;
  setActiveProfile(
    profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto>;
  setCapture(
    selection: CaptureSelectionDto,
    active: boolean,
    options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto>;
  setRoutingMode(mode: RoutingMode, options?: { signal?: AbortSignal }): Promise<StatusSnapshotDto>;
  subscribeConnection(listener: (state: StatusConnectionState) => void): () => void;
  subscribeSnapshots(listener: (snapshot: StatusSnapshotDto) => void): () => void;
  upsertServiceMonitor(
    draft: ServiceMonitorDraft,
    options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto>;
}
