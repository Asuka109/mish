import * as z from "zod";

const IdentifierSchema = z.string().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const NonNegativeNumberSchema = z.number().nonnegative().finite();
const BoundedTextSchema = z.string().max(8_192);
const DecimalIntegerSchema = z.string().regex(/^(0|[1-9]\d*)$/u);
const SignedDecimalIntegerSchema = z.string().regex(/^-?(0|[1-9]\d*)$/u);

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

export const StatusAdapterKindSchema = z.enum(["fixture", "native", "rpc"]);
export type StatusAdapterKind = z.infer<typeof StatusAdapterKindSchema>;

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

export const TrafficDataPhaseSchema = z.enum(["ready", "stale", "unavailable"]);
export type TrafficDataPhase = z.infer<typeof TrafficDataPhaseSchema>;

export const TrafficMatchedRuleSchema = z
  .object({ payload: BoundedTextSchema, type: BoundedTextSchema })
  .strict();
export interface TrafficMatchedRuleDto extends z.infer<typeof TrafficMatchedRuleSchema> {}

export const TrafficConnectionSchema = z
  .object({
    destinationHost: BoundedTextSchema.nullable(),
    destinationIp: BoundedTextSchema.nullable(),
    destinationPort: z.number().int().min(0).max(65_535),
    downloadBytes: DecimalIntegerSchema,
    id: IdentifierSchema,
    matchedRule: TrafficMatchedRuleSchema,
    network: BoundedTextSchema,
    processName: BoundedTextSchema.nullable(),
    processPath: BoundedTextSchema.nullable(),
    protocol: BoundedTextSchema,
    providerChain: z.array(BoundedTextSchema).max(256),
    remoteDestination: BoundedTextSchema.nullable(),
    routeChain: z.array(BoundedTextSchema).max(256),
    sniffHost: BoundedTextSchema.nullable(),
    sourceIp: BoundedTextSchema.nullable(),
    sourcePort: z.number().int().min(0).max(65_535),
    startedAt: BoundedTextSchema.min(1),
    uploadBytes: DecimalIntegerSchema,
  })
  .strict();
export interface TrafficConnectionDto extends z.infer<typeof TrafficConnectionSchema> {}

export const EffectiveRuleSchema = z
  .object({
    enabled: z.boolean(),
    hitCount: DecimalIntegerSchema.nullable(),
    lastHitAt: BoundedTextSchema.nullable(),
    payload: BoundedTextSchema,
    priority: NonNegativeIntegerSchema,
    size: SignedDecimalIntegerSchema,
    target: BoundedTextSchema,
    type: BoundedTextSchema,
  })
  .strict();
export interface EffectiveRuleDto extends z.infer<typeof EffectiveRuleSchema> {}

const TrafficDataSnapshotBaseSchema = z
  .object({
    activeConnections: z.array(TrafficConnectionSchema).max(20_000),
    adapterKind: StatusAdapterKindSchema,
    phase: TrafficDataPhaseSchema,
    profileId: IdentifierSchema,
    reconnectCount: NonNegativeIntegerSchema,
    rules: z.array(EffectiveRuleSchema).max(100_000),
    sequence: NonNegativeIntegerSchema,
    sessionId: IdentifierSchema.nullable(),
  })
  .strict();

export const TrafficDataSnapshotSchema = TrafficDataSnapshotBaseSchema.superRefine(
  (snapshot, context) => {
    if (snapshot.phase === "unavailable" || snapshot.sessionId !== null) return;
    context.addIssue({
      code: "custom",
      message: "A ready or stale Traffic snapshot requires a session ID",
      path: ["sessionId"],
    });
  },
);
export interface TrafficDataSnapshotDto extends z.infer<typeof TrafficDataSnapshotSchema> {}

export const RpcTrafficDataSnapshotSchema = TrafficDataSnapshotBaseSchema.extend({
  adapterKind: z.literal("rpc"),
}).superRefine((snapshot, context) => {
  if (snapshot.phase === "unavailable" || snapshot.sessionId !== null) return;
  context.addIssue({
    code: "custom",
    message: "A ready or stale Traffic snapshot requires a session ID",
    path: ["sessionId"],
  });
});
export interface RpcTrafficDataSnapshotDto extends z.infer<typeof RpcTrafficDataSnapshotSchema> {}

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

export const PolicyGroupTypeSchema = z.enum([
  "selector",
  "url-test",
  "fallback",
  "load-balance",
  "relay",
  "direct",
  "reject",
  "unsupported",
]);
export type PolicyGroupType = z.infer<typeof PolicyGroupTypeSchema>;

const PolicyGroupBaseSchema = z.object({
  childIds: z.array(IdentifierSchema),
  id: IdentifierSchema,
  label: z.string(),
});

export const SelectorPolicyGroupSchema = PolicyGroupBaseSchema.extend({
  selectedChildId: IdentifierSchema,
  type: z.literal("selector"),
}).strict();

export const AutomaticPolicyGroupSchema = PolicyGroupBaseSchema.extend({
  selectedChildId: IdentifierSchema.nullable(),
  type: z.enum(["url-test", "fallback", "load-balance", "relay", "direct", "reject"]),
}).strict();

export const UnsupportedPolicyGroupSchema = PolicyGroupBaseSchema.extend({
  selectedChildId: IdentifierSchema.nullable(),
  type: z.literal("unsupported"),
  unsupportedType: z.string().min(1),
}).strict();

export const PolicyGroupSchema = z.discriminatedUnion("type", [
  SelectorPolicyGroupSchema,
  AutomaticPolicyGroupSchema,
  UnsupportedPolicyGroupSchema,
]);
export type PolicyGroupDto = z.infer<typeof PolicyGroupSchema>;
export type SelectorPolicyGroupDto = z.infer<typeof SelectorPolicyGroupSchema>;

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
    adapterKind: StatusAdapterKindSchema,
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

export const NativeStatusSnapshotSchema = StatusSnapshotSchema.extend({
  adapterKind: z.literal("native"),
});
export interface NativeStatusSnapshotDto extends z.infer<typeof NativeStatusSnapshotSchema> {}

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

export const CorePhaseSchema = z.enum(["stopped", "starting", "running", "stopping", "failed"]);
export type CorePhase = z.infer<typeof CorePhaseSchema>;

export const CoreStatusSchema = z
  .object({
    error: z.string().nullable(),
    phase: CorePhaseSchema,
    pid: NonNegativeIntegerSchema.nullable(),
    version: z.string().nullable(),
  })
  .strict();
export interface CoreStatusDto extends z.infer<typeof CoreStatusSchema> {}

export const CoreErrorKindSchema = z.enum(["unavailable", "start-failed", "stop-failed"]);
export type CoreErrorKind = z.infer<typeof CoreErrorKindSchema>;

export const CoreErrorDataSchema = z
  .object({ detail: z.string(), kind: CoreErrorKindSchema })
  .strict();
export interface CoreErrorDataDto extends z.infer<typeof CoreErrorDataSchema> {}

export const BridgeInfoSchema = z
  .object({
    bridgeVersion: z.string().min(1),
    coreConfigured: z.boolean(),
    protocolVersion: z.literal(2),
  })
  .strict();
export interface BridgeInfoDto extends z.infer<typeof BridgeInfoSchema> {}

export const ProfileSourceTypeSchema = z.enum(["local-file", "https"]);
export type ProfileSourceType = z.infer<typeof ProfileSourceTypeSchema>;

export const ProfileValidationIssueCodeSchema = z.enum([
  "source-formatting-not-round-tripped",
  "unknown-keys-preserved",
  "application-settings-overridden",
  "platform-settings-disabled",
  "unsafe-paths-rejected",
  "sensitive-data-present",
]);
export type ProfileValidationIssueCode = z.infer<typeof ProfileValidationIssueCodeSchema>;

export const ProfileAttemptOutcomeSchema = z.enum(["succeeded", "failed"]);
export type ProfileAttemptOutcome = z.infer<typeof ProfileAttemptOutcomeSchema>;

export const ProfileStatusFlagsSchema = z
  .object({
    active: z.boolean(),
    error: z.boolean(),
    stale: z.boolean(),
    updating: z.boolean(),
    valid: z.boolean(),
    warning: z.boolean(),
  })
  .strict();
export interface ProfileStatusFlagsDto extends z.infer<typeof ProfileStatusFlagsSchema> {}

export const ProfileSourceSummarySchema = z
  .object({ display: z.string(), sourceType: ProfileSourceTypeSchema })
  .strict();
export interface ProfileSourceSummaryDto extends z.infer<typeof ProfileSourceSummarySchema> {}

export const ProfileAttemptSchema = z
  .object({ attemptedAt: NonNegativeIntegerSchema, outcome: ProfileAttemptOutcomeSchema })
  .strict();
export interface ProfileAttemptDto extends z.infer<typeof ProfileAttemptSchema> {}

export const ProfileListItemSchema = z
  .object({
    id: IdentifierSchema,
    label: z.string(),
    lastAttempt: ProfileAttemptSchema.nullable(),
    lastKnownValid: z.boolean(),
    lastSuccessAt: NonNegativeIntegerSchema.nullable(),
    source: ProfileSourceSummarySchema,
    status: ProfileStatusFlagsSchema,
    warningCodes: z.array(ProfileValidationIssueCodeSchema),
  })
  .strict();
export interface ProfileListItemDto extends z.infer<typeof ProfileListItemSchema> {}

export const ProfileCapabilityAvailabilitySchema = z.enum([
  "fixture-only",
  "supported",
  "permission-required",
  "unavailable",
]);
export type ProfileCapabilityAvailability = z.infer<typeof ProfileCapabilityAvailabilitySchema>;

export const ProfileCapabilitiesSchema = z
  .object({
    activation: ProfileCapabilityAvailabilitySchema,
    deletion: ProfileCapabilityAvailabilitySchema,
    httpsImport: ProfileCapabilityAvailabilitySchema,
    localFileImport: ProfileCapabilityAvailabilitySchema,
    refresh: ProfileCapabilityAvailabilitySchema,
    save: ProfileCapabilityAvailabilitySchema,
  })
  .strict();
export interface ProfileCapabilitiesDto extends z.infer<typeof ProfileCapabilitiesSchema> {}

export const ProfileActivationAvailabilitySchema = z.enum([
  "available",
  "missing-binary",
  "unavailable",
]);
export type ProfileActivationAvailability = z.infer<typeof ProfileActivationAvailabilitySchema>;

export const ProfileActivationPhaseSchema = z.enum(["idle", "pending", "success", "failure"]);
export type ProfileActivationPhase = z.infer<typeof ProfileActivationPhaseSchema>;

export const ProfileActivationOperationSchema = z.enum(["activate", "stop"]);
export type ProfileActivationOperation = z.infer<typeof ProfileActivationOperationSchema>;

export const ProfileActivationFailureSchema = z.enum([
  "invalid-profile",
  "missing-binary",
  "unsafe-runtime",
  "staging",
  "validation",
  "start",
  "early-exit",
  "version-mismatch",
  "controller",
  "timeout",
  "cancelled",
  "prior-stop",
  "state-commit",
]);
export type ProfileActivationFailure = z.infer<typeof ProfileActivationFailureSchema>;

export const ProfileActivationSnapshotSchema = z
  .object({
    activeProfileId: IdentifierSchema.nullable(),
    attemptedAt: NonNegativeIntegerSchema.nullable(),
    availability: ProfileActivationAvailabilitySchema,
    commandId: IdentifierSchema.nullable(),
    failure: ProfileActivationFailureSchema.nullable(),
    operation: ProfileActivationOperationSchema.nullable(),
    phase: ProfileActivationPhaseSchema,
    safeStopped: z.boolean(),
    startupPolicy: z.literal("safe-stopped"),
    targetProfileId: IdentifierSchema.nullable(),
  })
  .strict();
export interface ProfileActivationSnapshotDto extends z.infer<
  typeof ProfileActivationSnapshotSchema
> {}

export const ProfileSnapshotSchema = z
  .object({
    activation: ProfileActivationSnapshotSchema,
    adapterKind: z.enum(["fixture", "rpc", "native"]),
    capabilities: ProfileCapabilitiesSchema,
    profiles: z.array(ProfileListItemSchema),
  })
  .strict();
export interface ProfileSnapshotDto extends z.infer<typeof ProfileSnapshotSchema> {}

export const RpcProfileSnapshotSchema = ProfileSnapshotSchema.extend({
  adapterKind: z.literal("rpc"),
});

export const ProfileSensitiveDataNoticeSchema = z.enum([
  "none",
  "source-url-contains-sensitive-data",
  "configuration-contains-sensitive-data",
  "source-and-configuration-contain-sensitive-data",
]);
export type ProfileSensitiveDataNotice = z.infer<typeof ProfileSensitiveDataNoticeSchema>;

export const ProfilePreviewSchema = z
  .object({
    classificationCounts: z
      .object({
        disabled: NonNegativeIntegerSchema,
        overridden: NonNegativeIntegerSchema,
        preserved: NonNegativeIntegerSchema,
        rejected: NonNegativeIntegerSchema,
      })
      .strict(),
    groupCount: NonNegativeIntegerSchema,
    label: z.string(),
    previewId: IdentifierSchema,
    proxyCount: NonNegativeIntegerSchema,
    ruleCount: NonNegativeIntegerSchema,
    sensitiveDataNotice: ProfileSensitiveDataNoticeSchema,
    sourceType: ProfileSourceTypeSchema,
    warningCodes: z.array(ProfileValidationIssueCodeSchema),
  })
  .strict();
export interface ProfilePreviewDto extends z.infer<typeof ProfilePreviewSchema> {}

export const ProfilePreflightHttpsCommandSchema = z
  .object({ label: z.string().optional(), url: z.string().min(1).max(8192) })
  .strict();
export const ProfileSaveCommandSchema = z.object({ previewId: IdentifierSchema }).strict();
export const ProfileIdCommandSchema = z.object({ profileId: IdentifierSchema }).strict();
export const ProfileActivationCommandSchema = z
  .object({ commandId: IdentifierSchema, profileId: IdentifierSchema })
  .strict();
export const ProfileActivationControlCommandSchema = z
  .object({ commandId: IdentifierSchema })
  .strict();

export const bridgeRpcMethods = {
  "bridge.getInfo": { params: EmptyCommandSchema, result: BridgeInfoSchema },
  "core.getStatus": { params: EmptyCommandSchema, result: CoreStatusSchema },
  "core.start": { params: EmptyCommandSchema, result: CoreStatusSchema },
  "core.stop": { params: EmptyCommandSchema, result: CoreStatusSchema },
} as const;

export const StatusSubscriptionIdSchema = z.object({ subscriptionId: IdentifierSchema }).strict();
export const StatusSubscriptionSchema = StatusSubscriptionIdSchema.extend({
  snapshot: RpcStatusSnapshotSchema,
}).strict();
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
  "status.unsubscribe": { params: StatusSubscriptionIdSchema, result: z.boolean() },
  "status.upsertServiceMonitor": {
    params: UpsertServiceMonitorCommandSchema,
    result: RpcStatusSnapshotSchema,
  },
} as const;

export const ProfileSubscriptionIdSchema = z.object({ subscriptionId: IdentifierSchema }).strict();
export const ProfileSubscriptionSchema = ProfileSubscriptionIdSchema.extend({
  snapshot: RpcProfileSnapshotSchema,
}).strict();
export interface ProfileSubscriptionDto extends z.infer<typeof ProfileSubscriptionSchema> {}

export const ProfileSnapshotNotificationSchema = z
  .object({ snapshot: RpcProfileSnapshotSchema, subscriptionId: IdentifierSchema })
  .strict();
export interface ProfileSnapshotNotificationDto extends z.infer<
  typeof ProfileSnapshotNotificationSchema
> {}

export const profileRpcMethods = {
  "profiles.activate": {
    params: ProfileActivationCommandSchema,
    result: ProfileActivationSnapshotSchema,
  },
  "profiles.cancelActivation": {
    params: ProfileActivationControlCommandSchema,
    result: ProfileActivationSnapshotSchema,
  },
  "profiles.delete": { params: ProfileIdCommandSchema, result: RpcProfileSnapshotSchema },
  "profiles.getSnapshot": { params: EmptyCommandSchema, result: RpcProfileSnapshotSchema },
  "profiles.preflightHttps": {
    params: ProfilePreflightHttpsCommandSchema,
    result: ProfilePreviewSchema,
  },
  "profiles.refresh": { params: ProfileIdCommandSchema, result: RpcProfileSnapshotSchema },
  "profiles.save": { params: ProfileSaveCommandSchema, result: RpcProfileSnapshotSchema },
  "profiles.stop": {
    params: ProfileActivationControlCommandSchema,
    result: ProfileActivationSnapshotSchema,
  },
  "profiles.subscribe": { params: EmptyCommandSchema, result: ProfileSubscriptionSchema },
  "profiles.unsubscribe": { params: ProfileSubscriptionIdSchema, result: z.boolean() },
} as const;

export const TrafficSubscriptionIdSchema = z.object({ subscriptionId: IdentifierSchema }).strict();
export const TrafficSubscriptionSchema = TrafficSubscriptionIdSchema.extend({
  snapshot: RpcTrafficDataSnapshotSchema,
}).strict();
export interface TrafficSubscriptionDto extends z.infer<typeof TrafficSubscriptionSchema> {}

export const TrafficSnapshotNotificationSchema = z
  .object({ snapshot: RpcTrafficDataSnapshotSchema, subscriptionId: IdentifierSchema })
  .strict();
export interface TrafficSnapshotNotificationDto extends z.infer<
  typeof TrafficSnapshotNotificationSchema
> {}

export const trafficRpcMethods = {
  "traffic.getSnapshot": { params: EmptyCommandSchema, result: RpcTrafficDataSnapshotSchema },
  "traffic.subscribe": { params: EmptyCommandSchema, result: TrafficSubscriptionSchema },
  "traffic.unsubscribe": { params: TrafficSubscriptionIdSchema, result: z.boolean() },
} as const;

export const mishRpcMethods = {
  ...bridgeRpcMethods,
  ...profileRpcMethods,
  ...statusRpcMethods,
  ...trafficRpcMethods,
} as const;

export const statusRpcNotifications = {
  "status.snapshot": StatusSnapshotNotificationSchema,
} as const;

export const profileRpcNotifications = {
  "profiles.snapshot": ProfileSnapshotNotificationSchema,
} as const;

export const trafficRpcNotifications = {
  "traffic.snapshot": TrafficSnapshotNotificationSchema,
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

export type StatusCommand = "capture" | "group" | "profile" | "routing" | "services";

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
  supportsCommand(command: StatusCommand): boolean;
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

export type ProfileClientErrorCode =
  | "cancelled"
  | "conflict"
  | "disconnected"
  | "invalid-request"
  | "not-found"
  | "protocol"
  | "remote"
  | "unsupported"
  | "unknown"
  | "validation";

export class ProfileClientError extends Error {
  readonly code: ProfileClientErrorCode;
  readonly retryable: boolean;

  constructor(code: ProfileClientErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "ProfileClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export type ProfileConnectionPhase = StatusConnectionPhase;
export interface ProfileConnectionState extends StatusConnectionState {}

export type TrafficConnectionPhase =
  | "fixture"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "disconnected"
  | "disposed";

export interface TrafficConnectionState {
  attempt: number;
  phase: TrafficConnectionPhase;
  stale: boolean;
}

export class TrafficClientError extends Error {
  readonly code: StatusClientErrorCode;
  readonly retryable: boolean;

  constructor(code: StatusClientErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "TrafficClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ProfileClient {
  activateProfile(
    commandId: string,
    profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileActivationSnapshotDto>;
  cancelActivation(
    commandId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileActivationSnapshotDto>;
  deleteProfile(profileId: string, options?: { signal?: AbortSignal }): Promise<ProfileSnapshotDto>;
  dispose(): void;
  getConnectionState(): ProfileConnectionState;
  getSnapshot(options?: { signal?: AbortSignal }): Promise<ProfileSnapshotDto>;
  preflightHttps(
    url: string,
    label?: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfilePreviewDto>;
  preflightLocal(label?: string): Promise<ProfilePreviewDto | null>;
  refreshProfile(
    profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileSnapshotDto>;
  savePreview(previewId: string, options?: { signal?: AbortSignal }): Promise<ProfileSnapshotDto>;
  stopActiveProfile(
    commandId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileActivationSnapshotDto>;
  subscribeConnection(listener: (state: ProfileConnectionState) => void): () => void;
  subscribeSnapshots(listener: (snapshot: ProfileSnapshotDto) => void): () => void;
}

export interface TrafficClient {
  dispose(): void;
  getConnectionState(): TrafficConnectionState;
  getSnapshot(options?: { signal?: AbortSignal }): Promise<TrafficDataSnapshotDto>;
  subscribeConnection(listener: (state: TrafficConnectionState) => void): () => void;
  subscribeSnapshots(listener: (snapshot: TrafficDataSnapshotDto) => void): () => void;
}
