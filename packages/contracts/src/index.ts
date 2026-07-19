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

export const CaptureFailureKindSchema = z.enum([
  "apply-failed",
  "capability-unavailable",
  "confirmation-failed",
  "core-unhealthy",
  "external-drift",
  "invalid-recovery",
  "observation-failed",
  "permission-denied",
  "persistence-failed",
  "rollback-failed",
  "unsafe-existing-configuration",
  "unsupported-selection",
]);
export type CaptureFailureKind = z.infer<typeof CaptureFailureKindSchema>;

export const SystemProxyPhaseSchema = z.enum(["off", "pending", "applied", "failed", "drift"]);
export type SystemProxyPhase = z.infer<typeof SystemProxyPhaseSchema>;

export const SystemProxyObservedStateSchema = z.enum(["disabled", "mish", "other", "unknown"]);
export type SystemProxyObservedState = z.infer<typeof SystemProxyObservedStateSchema>;

export const CaptureRecoveryActionSchema = z.enum(["repair", "leave-as-is"]);
export type CaptureRecoveryAction = z.infer<typeof CaptureRecoveryActionSchema>;

export const SystemProxyRuntimeStatusSchema = z
  .object({
    desired: z.boolean(),
    failure: CaptureFailureKindSchema.nullable(),
    observed: SystemProxyObservedStateSchema,
    phase: SystemProxyPhaseSchema,
    recoveryActions: z.array(CaptureRecoveryActionSchema).max(2),
  })
  .strict()
  .superRefine((status, context) => {
    if (new Set(status.recoveryActions).size !== status.recoveryActions.length) {
      context.addIssue({
        code: "custom",
        message: "System Proxy recovery actions must be unique",
        path: ["recoveryActions"],
      });
    }
    if (status.phase === "applied") {
      if (!status.desired || status.observed !== "mish" || status.failure !== null) {
        context.addIssue({
          code: "custom",
          message: "Applied System Proxy state must be desired, observed, and failure-free",
        });
      }
    } else if (status.phase === "off") {
      if (status.desired || status.failure !== null) {
        context.addIssue({
          code: "custom",
          message: "Off System Proxy state cannot remain desired or failed",
        });
      }
    } else if (status.phase === "failed" && status.failure === null) {
      context.addIssue({
        code: "custom",
        message: "Failed System Proxy state requires a typed failure",
        path: ["failure"],
      });
    }
    if (status.phase === "drift" && status.recoveryActions.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Drifted System Proxy state requires a recovery action",
        path: ["recoveryActions"],
      });
    }
    if (status.phase !== "drift" && status.recoveryActions.length > 0) {
      context.addIssue({
        code: "custom",
        message: "System Proxy recovery actions are valid only during drift",
        path: ["recoveryActions"],
      });
    }
  });
export interface SystemProxyRuntimeStatusDto extends z.infer<
  typeof SystemProxyRuntimeStatusSchema
> {}

export const RuntimeStatusSchema = z
  .object({
    captureSelection: CaptureSelectionSchema,
    message: z.string(),
    phase: RuntimePhaseSchema,
    systemProxy: SystemProxyRuntimeStatusSchema,
    systemProxyEnabled: z.boolean(),
    tunEnabled: z.boolean(),
  })
  .strict()
  .superRefine((runtime, context) => {
    const confirmed =
      runtime.systemProxy.phase === "applied" && runtime.systemProxy.observed === "mish";
    if (runtime.systemProxyEnabled !== confirmed) {
      context.addIssue({
        code: "custom",
        message: "System Proxy enabled state must match confirmed reconciliation state",
        path: ["systemProxyEnabled"],
      });
    }
  });
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

export const TrafficCommandAuthoritySchema = z
  .object({
    profileId: BoundedTextSchema.min(1),
    sequence: NonNegativeIntegerSchema,
    sessionId: BoundedTextSchema.min(1),
  })
  .strict();
export interface TrafficCommandAuthorityDto extends z.infer<typeof TrafficCommandAuthoritySchema> {}

export const TrafficCommandOperationSchema = z.enum(["close-connection", "close-all-active"]);
export type TrafficCommandOperation = z.infer<typeof TrafficCommandOperationSchema>;

export const TrafficCommandFailureSchema = z.enum([
  "unsupported",
  "invalid-request",
  "conflict",
  "stale-snapshot",
  "stale-connection",
  "timeout",
  "disconnected",
  "version-drift",
  "controller-rejected",
  "runtime-replaced",
  "partial-remaining",
  "inconsistent-observation",
]);
export type TrafficCommandFailure = z.infer<typeof TrafficCommandFailureSchema>;

export const TrafficCommandResultSchema = z
  .object({
    failure: TrafficCommandFailureSchema.nullable(),
    operation: TrafficCommandOperationSchema,
    remainingConnectionIds: z.array(IdentifierSchema).max(20_000),
    snapshot: TrafficDataSnapshotSchema,
    status: z.enum(["success", "failure"]),
    targetCount: NonNegativeIntegerSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (result.status === "success" && result.failure !== null) {
      context.addIssue({ code: "custom", message: "Successful Traffic commands cannot fail" });
    }
    if (result.status === "failure" && result.failure === null) {
      context.addIssue({ code: "custom", message: "Failed Traffic commands require a failure" });
    }
    if (result.remainingConnectionIds.length > result.targetCount) {
      context.addIssue({
        code: "custom",
        message: "Remaining Traffic targets cannot exceed the command target count",
      });
    }
    if (result.status === "success" && result.remainingConnectionIds.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Successful Traffic commands cannot retain target IDs",
      });
    }
  });
export interface TrafficCommandResultDto extends z.infer<typeof TrafficCommandResultSchema> {}

export const RpcTrafficCommandResultSchema = TrafficCommandResultSchema.superRefine(
  (result, context) => {
    if (result.snapshot.adapterKind === "rpc") return;
    context.addIssue({
      code: "custom",
      message: "Desktop Traffic command results require an RPC snapshot",
      path: ["snapshot", "adapterKind"],
    });
  },
);

export const CloseTrafficConnectionCommandSchema = z
  .object({ authority: TrafficCommandAuthoritySchema, connectionId: BoundedTextSchema.min(1) })
  .strict();
export const CloseAllActiveTrafficCommandSchema = z
  .object({ authority: TrafficCommandAuthoritySchema })
  .strict();

export const EventLevelSchema = z.enum(["debug", "info", "warning", "error"]);
export type EventLevel = z.infer<typeof EventLevelSchema>;

export const EventSourceSchema = z.enum(["application", "core", "platform", "rpc"]);
export type EventSource = z.infer<typeof EventSourceSchema>;

export const EventsDataPhaseSchema = z.enum(["connecting", "ready", "stale", "unavailable"]);
export type EventsDataPhase = z.infer<typeof EventsDataPhaseSchema>;

export const EventSourcePhaseSchema = z.enum(["fixture-only", "ready", "stale", "unavailable"]);
export type EventSourcePhase = z.infer<typeof EventSourcePhaseSchema>;

export const EventRecordSchema = z
  .object({
    detail: BoundedTextSchema.nullable(),
    id: IdentifierSchema,
    level: EventLevelSchema,
    message: BoundedTextSchema,
    observedAt: NonNegativeIntegerSchema,
    sequence: NonNegativeIntegerSchema,
    source: EventSourceSchema,
  })
  .strict();
export interface EventRecordDto extends z.infer<typeof EventRecordSchema> {}

export const EventSourceStatusSchema = z
  .object({
    detail: BoundedTextSchema.nullable(),
    phase: EventSourcePhaseSchema,
    source: EventSourceSchema,
  })
  .strict();
export interface EventSourceStatusDto extends z.infer<typeof EventSourceStatusSchema> {}

const EventsSnapshotBaseSchema = z
  .object({
    adapterKind: StatusAdapterKindSchema,
    events: z.array(EventRecordSchema).max(1_024),
    phase: EventsDataPhaseSchema,
    profileId: IdentifierSchema,
    reconnectCount: NonNegativeIntegerSchema,
    sequence: NonNegativeIntegerSchema,
    sessionId: IdentifierSchema.nullable(),
    sourceStatuses: z.array(EventSourceStatusSchema).length(4),
  })
  .strict();

function validateEventsSnapshot(
  snapshot: z.infer<typeof EventsSnapshotBaseSchema>,
  context: z.RefinementCtx,
) {
  if ((snapshot.phase === "ready" || snapshot.phase === "stale") && snapshot.sessionId === null) {
    context.addIssue({
      code: "custom",
      message: "A ready or stale Events snapshot requires a session ID",
      path: ["sessionId"],
    });
  }
  if (snapshot.sessionId === null && snapshot.events.length > 0) {
    context.addIssue({
      code: "custom",
      message: "An Events snapshot without a session cannot contain event rows",
      path: ["events"],
    });
  }
  if (new Set(snapshot.events.map(({ id }) => id)).size !== snapshot.events.length) {
    context.addIssue({
      code: "custom",
      message: "Event IDs must be unique within a snapshot",
      path: ["events"],
    });
  }
  for (let index = 1; index < snapshot.events.length; index += 1) {
    if (snapshot.events[index - 1].sequence < snapshot.events[index].sequence) continue;
    context.addIssue({
      code: "custom",
      message: "Events must use a strictly increasing sequence order",
      path: ["events", index, "sequence"],
    });
  }
  if (
    new Set(snapshot.sourceStatuses.map(({ source }) => source)).size !==
    snapshot.sourceStatuses.length
  ) {
    context.addIssue({
      code: "custom",
      message: "Events source statuses must be unique",
      path: ["sourceStatuses"],
    });
  }
}

export const EventsSnapshotSchema = EventsSnapshotBaseSchema.superRefine(validateEventsSnapshot);
export interface EventsSnapshotDto extends z.infer<typeof EventsSnapshotSchema> {}

export const RpcEventsSnapshotSchema = EventsSnapshotBaseSchema.extend({
  adapterKind: z.literal("rpc"),
}).superRefine(validateEventsSnapshot);
export interface RpcEventsSnapshotDto extends z.infer<typeof RpcEventsSnapshotSchema> {}

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

export const GroupDelayTestPhaseSchema = z.enum([
  "idle",
  "pending",
  "progress",
  "cancelled",
  "completed",
  "partial",
  "failed",
]);
export type GroupDelayTestPhase = z.infer<typeof GroupDelayTestPhaseSchema>;

export const GroupDelayChildPhaseSchema = z.enum(["pending", "success", "failed", "cancelled"]);
export type GroupDelayChildPhase = z.infer<typeof GroupDelayChildPhaseSchema>;

export const GroupDelayFailureSchema = z.enum([
  "timeout",
  "unavailable",
  "stale-membership",
  "disconnected",
  "version-drift",
  "inconsistent-observation",
  "cancelled",
]);
export type GroupDelayFailure = z.infer<typeof GroupDelayFailureSchema>;

export const GroupDelayChildResultSchema = z
  .object({
    childId: IdentifierSchema,
    failure: GroupDelayFailureSchema.nullable(),
    latencyMilliseconds: z.number().int().positive().max(65_535).nullable(),
    observedAt: NonNegativeIntegerSchema.nullable(),
    phase: GroupDelayChildPhaseSchema,
  })
  .strict()
  .superRefine((result, context) => {
    if (
      result.phase === "pending" &&
      (result.failure !== null || result.latencyMilliseconds !== null || result.observedAt !== null)
    ) {
      context.addIssue({ code: "custom", message: "Pending delay results cannot have an outcome" });
    }
    if (
      result.phase === "success" &&
      (result.failure !== null || result.latencyMilliseconds === null || result.observedAt === null)
    ) {
      context.addIssue({ code: "custom", message: "Successful delay results require a latency" });
    }
    if (
      result.phase === "failed" &&
      (result.failure === null ||
        result.failure === "cancelled" ||
        result.latencyMilliseconds !== null ||
        result.observedAt === null)
    ) {
      context.addIssue({ code: "custom", message: "Failed delay results require a failure" });
    }
    if (
      result.phase === "cancelled" &&
      (result.failure !== "cancelled" ||
        result.latencyMilliseconds !== null ||
        result.observedAt === null)
    ) {
      context.addIssue({ code: "custom", message: "Cancelled delay results require cancellation" });
    }
  });
export interface GroupDelayChildResultDto extends z.infer<typeof GroupDelayChildResultSchema> {}

export const GroupDelayPolicySchema = z
  .object({ id: IdentifierSchema, timeoutMilliseconds: z.number().int().nonnegative().max(32_767) })
  .strict();
export interface GroupDelayPolicyDto extends z.infer<typeof GroupDelayPolicySchema> {}

export const GroupDelayTestSchema = z
  .object({
    children: z.array(GroupDelayChildResultSchema).max(8_192),
    finishedAt: NonNegativeIntegerSchema.nullable(),
    groupId: IdentifierSchema.nullable(),
    phase: GroupDelayTestPhaseSchema,
    profileId: IdentifierSchema.nullable(),
    startedAt: NonNegativeIntegerSchema.nullable(),
    testId: IdentifierSchema.nullable(),
  })
  .strict()
  .superRefine((test, context) => {
    const identifiers = [test.groupId, test.profileId, test.startedAt, test.testId];
    if (
      test.phase === "idle" &&
      (test.children.length > 0 ||
        test.finishedAt !== null ||
        identifiers.some((value) => value !== null))
    ) {
      context.addIssue({ code: "custom", message: "Idle delay tests cannot own group state" });
    }
    if (test.phase !== "idle" && identifiers.some((value) => value === null)) {
      context.addIssue({ code: "custom", message: "Active delay tests require stable identity" });
    }
    const terminal = ["cancelled", "completed", "partial", "failed"].includes(test.phase);
    if (terminal !== (test.finishedAt !== null)) {
      context.addIssue({ code: "custom", message: "Only terminal delay tests have a finish time" });
    }
  });
export interface GroupDelayTestDto extends z.infer<typeof GroupDelayTestSchema> {}

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
    groupDelayPolicy: GroupDelayPolicySchema,
    groupDelayTest: GroupDelayTestSchema,
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

export const RecoverSystemProxyCommandSchema = z
  .object({ action: CaptureRecoveryActionSchema })
  .strict();
export interface RecoverSystemProxyCommand extends z.infer<
  typeof RecoverSystemProxyCommandSchema
> {}

export const SetActiveProfileCommandSchema = z.object({ profileId: IdentifierSchema }).strict();
export interface SetActiveProfileCommand extends z.infer<typeof SetActiveProfileCommandSchema> {}

export const SelectGroupChildCommandSchema = z
  .object({ childId: IdentifierSchema, groupId: IdentifierSchema })
  .strict();
export interface SelectGroupChildCommand extends z.infer<typeof SelectGroupChildCommandSchema> {}

export const StartGroupDelayTestCommandSchema = z.object({ groupId: IdentifierSchema }).strict();
export interface StartGroupDelayTestCommand extends z.infer<
  typeof StartGroupDelayTestCommandSchema
> {}

export const CancelGroupDelayTestCommandSchema = z.object({ testId: IdentifierSchema }).strict();
export interface CancelGroupDelayTestCommand extends z.infer<
  typeof CancelGroupDelayTestCommandSchema
> {}

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
    protocolVersion: z.literal(5),
    statusCommands: z
      .object({ group: z.boolean(), groupDelay: z.boolean(), routing: z.boolean() })
      .strict(),
    trafficCommands: z
      .object({ closeAllActive: z.boolean(), closeConnection: z.boolean() })
      .strict(),
  })
  .strict();
export interface BridgeInfoDto extends z.infer<typeof BridgeInfoSchema> {}

export const ProfileSourceTypeSchema = z.enum(["local-file", "https"]);
export type ProfileSourceType = z.infer<typeof ProfileSourceTypeSchema>;

const ProfileFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const ProfileFieldIdentitySchema = z.string().regex(/^[a-z0-9.*-]{1,120}$/u);

export const ProfilePolicyOwnerSchema = z.enum([
  "source",
  "application-policy",
  "platform-integration",
]);
export const ProfilePolicyDispositionSchema = z.enum([
  "preserved",
  "application-overridden",
  "platform-overridden",
  "disabled",
  "rejected",
]);
export const ProfilePolicyReasonSchema = z.enum([
  "portable-source-policy",
  "unknown-key-preserved",
  "managed-proxy-ingress",
  "loopback-only-binding",
  "private-controller",
  "managed-runtime-behavior",
  "capture-requires-explicit-permission",
  "passive-inspection-only",
  "runtime-persistence-disabled",
  "dns-integration-managed",
  "external-surface-disabled",
  "device-integration-unsafe",
  "provider-path-unsafe",
  "relative-provider-path",
]);
export const ProfileActivationImpactSchema = z.enum([
  "preserved-in-effective-runtime",
  "replaced-by-application-value",
  "replaced-by-platform-value",
  "forced-off",
  "blocks-import",
  "excluded-from-effective-runtime",
]);
export const ProfileRuntimeLayerSchema = z.enum([
  "source",
  "application-policy",
  "platform-integration",
  "effective-runtime",
]);
export const ProfilePolicyClassificationSchema = z
  .object({
    activationImpact: ProfileActivationImpactSchema,
    disposition: ProfilePolicyDispositionSchema,
    fieldIdentity: ProfileFieldIdentitySchema,
    owner: ProfilePolicyOwnerSchema,
    reason: ProfilePolicyReasonSchema,
    sourcePresent: z.boolean(),
  })
  .strict();
export interface ProfilePolicyClassificationDto extends z.infer<
  typeof ProfilePolicyClassificationSchema
> {}

export const ProfileRuntimeProvenanceSchema = z
  .object({
    artifactFingerprint: ProfileFingerprintSchema,
    authority: z.enum([
      "desktop-policy",
      "illustrative-browser-fixture",
      "migrated-legacy-baseline",
    ]),
    items: z.array(ProfilePolicyClassificationSchema).max(128),
    layers: z.tuple([
      z.literal("source"),
      z.literal("application-policy"),
      z.literal("platform-integration"),
      z.literal("effective-runtime"),
    ]),
    sourceRevision: ProfileFingerprintSchema,
    unknownKeyCount: NonNegativeIntegerSchema,
  })
  .strict();
export interface ProfileRuntimeProvenanceDto extends z.infer<
  typeof ProfileRuntimeProvenanceSchema
> {}

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
    runtimeProvenance: ProfileRuntimeProvenanceSchema,
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
    activeFingerprint: ProfileFingerprintSchema.nullable(),
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
        applicationOverridden: NonNegativeIntegerSchema,
        disabled: NonNegativeIntegerSchema,
        platformOverridden: NonNegativeIntegerSchema,
        preserved: NonNegativeIntegerSchema,
        rejected: NonNegativeIntegerSchema,
      })
      .strict(),
    groupCount: NonNegativeIntegerSchema,
    label: z.string(),
    previewId: IdentifierSchema,
    proxyCount: NonNegativeIntegerSchema,
    ruleCount: NonNegativeIntegerSchema,
    runtimeProvenance: ProfileRuntimeProvenanceSchema,
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
  "status.cancelGroupDelayTest": {
    params: CancelGroupDelayTestCommandSchema,
    result: RpcStatusSnapshotSchema,
  },
  "status.getSnapshot": { params: EmptyCommandSchema, result: RpcStatusSnapshotSchema },
  "status.removeServiceMonitor": {
    params: RemoveServiceMonitorCommandSchema,
    result: RpcStatusSnapshotSchema,
  },
  "status.restoreDefaultServices": {
    params: EmptyCommandSchema,
    result: RpcStatusSnapshotSchema,
  },
  "status.recoverSystemProxy": {
    params: RecoverSystemProxyCommandSchema,
    result: RpcStatusSnapshotSchema,
  },
  "status.selectGroupChild": {
    params: SelectGroupChildCommandSchema,
    result: RpcStatusSnapshotSchema,
  },
  "status.startGroupDelayTest": {
    params: StartGroupDelayTestCommandSchema,
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
  "traffic.closeAllActive": {
    params: CloseAllActiveTrafficCommandSchema,
    result: RpcTrafficCommandResultSchema,
  },
  "traffic.closeConnection": {
    params: CloseTrafficConnectionCommandSchema,
    result: RpcTrafficCommandResultSchema,
  },
  "traffic.getSnapshot": { params: EmptyCommandSchema, result: RpcTrafficDataSnapshotSchema },
  "traffic.subscribe": { params: EmptyCommandSchema, result: TrafficSubscriptionSchema },
  "traffic.unsubscribe": { params: TrafficSubscriptionIdSchema, result: z.boolean() },
} as const;

export const EventsSubscriptionIdSchema = z.object({ subscriptionId: IdentifierSchema }).strict();
export const EventsSubscriptionSchema = EventsSubscriptionIdSchema.extend({
  snapshot: RpcEventsSnapshotSchema,
}).strict();
export interface EventsSubscriptionDto extends z.infer<typeof EventsSubscriptionSchema> {}

export const EventsSnapshotNotificationSchema = z
  .object({ snapshot: RpcEventsSnapshotSchema, subscriptionId: IdentifierSchema })
  .strict();
export interface EventsSnapshotNotificationDto extends z.infer<
  typeof EventsSnapshotNotificationSchema
> {}

export const eventsRpcMethods = {
  "events.getSnapshot": { params: EmptyCommandSchema, result: RpcEventsSnapshotSchema },
  "events.subscribe": { params: EmptyCommandSchema, result: EventsSubscriptionSchema },
  "events.unsubscribe": { params: EventsSubscriptionIdSchema, result: z.boolean() },
} as const;

export const mishRpcMethods = {
  ...bridgeRpcMethods,
  ...eventsRpcMethods,
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

export const eventsRpcNotifications = {
  "events.snapshot": EventsSnapshotNotificationSchema,
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

export type StatusCommand =
  | "capture"
  | "group"
  | "group-delay"
  | "profile"
  | "routing"
  | "services";

export type StatusClientErrorCode =
  | "cancelled"
  | "conflict"
  | "disconnected"
  | "invalid-request"
  | "not-found"
  | "protocol"
  | "remote"
  | "stale-membership"
  | "timeout"
  | "unsupported"
  | "version-drift"
  | "inconsistent-observation"
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
  recoverSystemProxy(
    action: CaptureRecoveryAction,
    options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto>;
  restoreDefaultServices(options?: { signal?: AbortSignal }): Promise<StatusSnapshotDto>;
  selectGroupChild(
    groupId: string,
    childId: string,
    options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto>;
  startGroupDelayTest(
    groupId: string,
    options?: { signal?: AbortSignal },
  ): Promise<StatusSnapshotDto>;
  cancelGroupDelayTest(
    testId: string,
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
  closeAllActive(
    authority: TrafficCommandAuthorityDto,
    options?: { signal?: AbortSignal },
  ): Promise<TrafficCommandResultDto>;
  closeConnection(
    authority: TrafficCommandAuthorityDto,
    connectionId: string,
    options?: { signal?: AbortSignal },
  ): Promise<TrafficCommandResultDto>;
  dispose(): void;
  getConnectionState(): TrafficConnectionState;
  getSnapshot(options?: { signal?: AbortSignal }): Promise<TrafficDataSnapshotDto>;
  supportsCommand(command: TrafficCommandOperation): boolean;
  subscribeConnection(listener: (state: TrafficConnectionState) => void): () => void;
  subscribeSnapshots(listener: (snapshot: TrafficDataSnapshotDto) => void): () => void;
}

export type EventsConnectionState = TrafficConnectionState;

export class EventsClientError extends Error {
  readonly code: StatusClientErrorCode;
  readonly retryable: boolean;

  constructor(code: StatusClientErrorCode, message: string, retryable = false) {
    super(message);
    this.name = "EventsClientError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface EventsClient {
  dispose(): void;
  getConnectionState(): EventsConnectionState;
  getSnapshot(options?: { signal?: AbortSignal }): Promise<EventsSnapshotDto>;
  subscribeConnection(listener: (state: EventsConnectionState) => void): () => void;
  subscribeSnapshots(listener: (snapshot: EventsSnapshotDto) => void): () => void;
}
