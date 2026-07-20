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

export const MobilePlatformKindSchema = z.enum(["android", "ios"]);
export type MobilePlatformKind = z.infer<typeof MobilePlatformKindSchema>;

export const MobileFixtureCapabilitySchema = z
  .object({ availability: z.literal("unavailable"), kind: z.literal("fixture") })
  .strict();
export interface MobileFixtureCapabilityDto extends z.infer<typeof MobileFixtureCapabilitySchema> {}

export const MobileFixtureBootstrapSchema = z
  .object({
    adapterKind: z.literal("native"),
    contractVersion: z.literal(1),
    core: MobileFixtureCapabilitySchema,
    message: z.string().min(1).max(512),
    platform: MobilePlatformKindSchema,
    targetAbis: z
      .array(z.enum(["arm64-v8a", "x86_64"]))
      .length(2)
      .refine((abis) => new Set(abis).size === abis.length, "Target ABIs must be unique"),
    vpn: MobileFixtureCapabilitySchema,
  })
  .strict();
export interface MobileFixtureBootstrapDto extends z.infer<typeof MobileFixtureBootstrapSchema> {}

export const MobileVpnPhaseSchema = z.enum([
  "stopped",
  "permission-required",
  "starting",
  "running",
  "stopping",
  "failed",
  "recovery-required",
  "unavailable",
]);
export type MobileVpnPhase = z.infer<typeof MobileVpnPhaseSchema>;

export const MobileVpnPermissionSchema = z.enum(["unknown", "required", "granted"]);
export type MobileVpnPermission = z.infer<typeof MobileVpnPermissionSchema>;

export const MobileVpnNotificationPermissionSchema = z.enum([
  "not-required",
  "required",
  "granted",
  "denied",
]);
export type MobileVpnNotificationPermission = z.infer<typeof MobileVpnNotificationPermissionSchema>;

export const MobileVpnSnapshotSchema = z
  .object({
    backendKind: z.literal("fixture"),
    contractVersion: z.literal(1),
    coreAbiVersion: z.literal(1).nullable(),
    coreAvailability: z.enum(["unavailable", "available"]),
    coreCommit: z.string().min(7).max(64).nullable(),
    coreVersion: z.string().min(1).max(32).nullable(),
    coreWrapperRevision: z.string().min(1).max(64).nullable(),
    foreground: z.boolean(),
    message: z.string().min(1).max(512),
    notificationPermission: MobileVpnNotificationPermissionSchema,
    permission: MobileVpnPermissionSchema,
    phase: MobileVpnPhaseSchema,
    sequence: z.number().int().nonnegative(),
    sessionId: z.string().min(1).max(128),
    updatedAtMillis: z.number().int().nonnegative(),
    vpnActive: z.literal(false),
  })
  .strict()
  .superRefine((snapshot, context) => {
    const coreIdentity = [
      snapshot.coreAbiVersion,
      snapshot.coreCommit,
      snapshot.coreVersion,
      snapshot.coreWrapperRevision,
    ];
    if (
      (snapshot.coreAvailability === "available" && coreIdentity.some((value) => value === null)) ||
      (snapshot.coreAvailability === "unavailable" && coreIdentity.some((value) => value !== null))
    ) {
      context.addIssue({
        code: "custom",
        message: "Mobile Core availability and identity evidence must agree",
        path: ["coreAvailability"],
      });
    }
    if (snapshot.foreground && !["starting", "stopping", "unavailable"].includes(snapshot.phase)) {
      context.addIssue({
        code: "custom",
        message:
          "The Phase 0 fixture may be foreground only during a transition or its explicit unavailable lifecycle",
        path: ["foreground"],
      });
    }
    if (snapshot.phase === "running") {
      context.addIssue({
        code: "custom",
        message: "The Phase 0 fixture must never report a running VPN",
        path: ["phase"],
      });
    }
  });
export interface MobileVpnSnapshotDto extends z.infer<typeof MobileVpnSnapshotSchema> {}

export const MobileVpnEventSchema = z
  .object({
    eventKind: z.literal("snapshot-changed"),
    eventVersion: z.literal(1),
    sequence: z.number().int().nonnegative(),
    sessionId: z.string().min(1).max(128),
    snapshot: MobileVpnSnapshotSchema,
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.sequence !== event.snapshot.sequence ||
      event.sessionId !== event.snapshot.sessionId
    ) {
      context.addIssue({
        code: "custom",
        message: "Mobile VPN event authority must match its snapshot",
      });
    }
  });
export interface MobileVpnEventDto extends z.infer<typeof MobileVpnEventSchema> {}

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

export const TunPhaseSchema = z.enum(["off", "pending", "applied", "failed", "drift"]);
export type TunPhase = z.infer<typeof TunPhaseSchema>;

export const TunObservedStateSchema = z.enum(["disabled", "enabled", "unknown"]);
export type TunObservedState = z.infer<typeof TunObservedStateSchema>;

export const TunFailureKindSchema = z.enum([
  "capability-unavailable",
  "confirmation-failed",
  "core-unhealthy",
  "helper-connection-failed",
  "helper-identity-rejected",
  "helper-invalid-signature",
  "helper-operation-failed",
  "helper-permission-denied",
  "helper-protocol-mismatch",
  "helper-version-mismatch",
  "rollback-failed",
  "runtime-transition",
]);
export type TunFailureKind = z.infer<typeof TunFailureKindSchema>;

export const TunRuntimeStatusSchema = z
  .object({
    desired: z.boolean(),
    failure: TunFailureKindSchema.nullable(),
    observed: TunObservedStateSchema,
    phase: TunPhaseSchema,
  })
  .strict()
  .superRefine((status, context) => {
    if (status.phase === "applied" && (!status.desired || status.observed !== "enabled")) {
      context.addIssue({ code: "custom", message: "Applied TUN state must be confirmed enabled" });
    }
    if (status.phase === "failed" && status.failure === null) {
      context.addIssue({ code: "custom", message: "Failed TUN state requires a typed failure" });
    }
  });
export interface TunRuntimeStatusDto extends z.infer<typeof TunRuntimeStatusSchema> {}

export const RuntimeStatusSchema = z
  .object({
    captureSelection: CaptureSelectionSchema,
    message: z.string(),
    phase: RuntimePhaseSchema,
    systemProxy: SystemProxyRuntimeStatusSchema,
    systemProxyEnabled: z.boolean(),
    tun: TunRuntimeStatusSchema,
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
    const tunConfirmed = runtime.tun.phase === "applied" && runtime.tun.observed === "enabled";
    if (runtime.tunEnabled !== tunConfirmed) {
      context.addIssue({
        code: "custom",
        message: "TUN enabled state must match confirmed reconciliation state",
        path: ["tunEnabled"],
      });
    }
  });
export interface RuntimeStatusDto extends z.infer<typeof RuntimeStatusSchema> {}

export const LocalProxyTestPhaseSchema = z.enum([
  "core-unhealthy",
  "listener-unavailable",
  "ready",
  "runtime-transition",
]);
export type LocalProxyTestPhase = z.infer<typeof LocalProxyTestPhaseSchema>;

export const LOCAL_PROXY_HOST = "127.0.0.1" as const;
export const LOCAL_PROXY_PORT = 7890 as const;

export const LocalProxyTestResultSchema = z
  .object({
    host: z.literal(LOCAL_PROXY_HOST),
    phase: LocalProxyTestPhaseSchema,
    port: z.literal(LOCAL_PROXY_PORT),
  })
  .strict();
export interface LocalProxyTestResultDto extends z.infer<typeof LocalProxyTestResultSchema> {}

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

export const DiagnosticRunStatusSchema = z.enum([
  "running",
  "completed",
  "cancelled",
  "invalidated",
]);
export type DiagnosticRunStatus = z.infer<typeof DiagnosticRunStatusSchema>;

export const DiagnosticCheckKindSchema = z.enum([
  "desktop-bridge",
  "core",
  "profile",
  "capture",
  "dns",
  "direct-reachability",
  "proxy-reachability",
]);
export type DiagnosticCheckKind = z.infer<typeof DiagnosticCheckKindSchema>;

export const DiagnosticCheckStatusSchema = z.enum(["passed", "failed", "unavailable", "cancelled"]);
export type DiagnosticCheckStatus = z.infer<typeof DiagnosticCheckStatusSchema>;

export const DiagnosticFailureSchema = z.enum([
  "cancelled",
  "capture-drift",
  "controller-disconnected",
  "core-unhealthy",
  "dns-failed",
  "endpoint-unreachable",
  "no-active-profile",
  "permission-denied",
  "profile-invalid",
  "runtime-replaced",
  "timeout",
  "unavailable",
  "version-drift",
]);
export type DiagnosticFailure = z.infer<typeof DiagnosticFailureSchema>;

export const DiagnosticRouteTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("local-bridge") }).strict(),
  z.object({ kind: z.literal("managed-core") }).strict(),
  z.object({ kind: z.literal("active-profile") }).strict(),
  z.object({ kind: z.literal("capture-state") }).strict(),
  z.object({ kind: z.literal("fixed-endpoint"), route: z.literal("direct") }).strict(),
  z.object({ kind: z.literal("policy-group-unavailable") }).strict(),
  z
    .object({
      childId: IdentifierSchema,
      groupId: IdentifierSchema,
      kind: z.literal("policy-group"),
    })
    .strict(),
]);
export type DiagnosticRouteTargetDto = z.infer<typeof DiagnosticRouteTargetSchema>;

export const DiagnosticObservedFactSchema = z.discriminatedUnion("kind", [
  z.object({ authenticated: z.boolean(), kind: z.literal("bridge") }).strict(),
  z
    .object({
      kind: z.literal("core"),
      phase: z.enum(["stopped", "starting", "running", "stopping", "failed"]),
      version: BoundedTextSchema.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("profile"), present: z.boolean(), valid: z.boolean() }).strict(),
  z
    .object({
      desired: z.boolean(),
      drift: z.boolean(),
      kind: z.literal("capture"),
      observed: SystemProxyObservedStateSchema,
    })
    .strict(),
  z.object({ addressCount: NonNegativeIntegerSchema, kind: z.literal("dns") }).strict(),
  z
    .object({
      httpStatus: z.number().int().min(100).max(599),
      kind: z.literal("reachability"),
      latencyMilliseconds: NonNegativeIntegerSchema,
    })
    .strict(),
  z.object({ kind: z.literal("unavailable"), reason: BoundedTextSchema }).strict(),
  z.object({ kind: z.literal("failure"), reason: BoundedTextSchema }).strict(),
]);
export type DiagnosticObservedFactDto = z.infer<typeof DiagnosticObservedFactSchema>;

export const DiagnosticCheckSchema = z
  .object({
    failure: DiagnosticFailureSchema.nullable(),
    finishedAt: NonNegativeIntegerSchema,
    id: IdentifierSchema,
    interpretation: BoundedTextSchema,
    kind: DiagnosticCheckKindSchema,
    observedFact: DiagnosticObservedFactSchema,
    routeTarget: DiagnosticRouteTargetSchema,
    scope: BoundedTextSchema,
    startedAt: NonNegativeIntegerSchema,
    status: DiagnosticCheckStatusSchema,
  })
  .strict()
  .superRefine((check, context) => {
    if (check.finishedAt < check.startedAt) {
      context.addIssue({ code: "custom", message: "Diagnostic check time must be monotonic" });
    }
    if (check.status === "passed" && check.failure !== null) {
      context.addIssue({ code: "custom", message: "Passed diagnostic checks cannot fail" });
    }
    if (check.status !== "passed" && check.failure === null) {
      context.addIssue({
        code: "custom",
        message: "Non-passing diagnostic checks require a failure",
      });
    }
  });
export interface DiagnosticCheckDto extends z.infer<typeof DiagnosticCheckSchema> {}

export const DiagnosticProbePolicySchema = z
  .object({
    endpointLabel: BoundedTextSchema,
    expectedHttpStatus: z.number().int().min(100).max(599),
    id: IdentifierSchema,
    timeoutMilliseconds: z.number().int().positive().max(30_000),
  })
  .strict();
export interface DiagnosticProbePolicyDto extends z.infer<typeof DiagnosticProbePolicySchema> {}

export const DiagnosticRunSchema = z
  .object({
    adapterKind: StatusAdapterKindSchema,
    checks: z.array(DiagnosticCheckSchema).max(16),
    finishedAt: NonNegativeIntegerSchema.nullable(),
    id: IdentifierSchema,
    policy: DiagnosticProbePolicySchema,
    profileId: IdentifierSchema.nullable(),
    startedAt: NonNegativeIntegerSchema,
    status: DiagnosticRunStatusSchema,
  })
  .strict()
  .superRefine((run, context) => {
    if (new Set(run.checks.map((check) => check.id)).size !== run.checks.length) {
      context.addIssue({ code: "custom", message: "Diagnostic check IDs must be unique" });
    }
    if ((run.status === "running") !== (run.finishedAt === null)) {
      context.addIssue({
        code: "custom",
        message: "Only running diagnostic runs omit finish time",
      });
    }
  });
export interface DiagnosticRunDto extends z.infer<typeof DiagnosticRunSchema> {}

export const DiagnosticHistorySchema = z
  .object({
    activeRunId: IdentifierSchema.nullable(),
    adapterKind: StatusAdapterKindSchema,
    runs: z.array(DiagnosticRunSchema).max(8),
  })
  .strict()
  .superRefine((history, context) => {
    if (new Set(history.runs.map((run) => run.id)).size !== history.runs.length) {
      context.addIssue({ code: "custom", message: "Diagnostic run IDs must be unique" });
    }
    const running = history.runs.filter((run) => run.status === "running");
    if (running.length > 1) {
      context.addIssue({ code: "custom", message: "Only one diagnostic run may be active" });
    }
    if (history.activeRunId !== (running[0]?.id ?? null)) {
      context.addIssue({
        code: "custom",
        message: "Active diagnostic ID must identify the running history item",
      });
    }
  });
export interface DiagnosticHistoryDto extends z.infer<typeof DiagnosticHistorySchema> {}

export const SupportBundleAvailabilitySchema = z.enum(["supported", "unavailable"]);
export type SupportBundleAvailability = z.infer<typeof SupportBundleAvailabilitySchema>;

export const SupportBundleCategorySchema = z.enum([
  "application",
  "platform",
  "capabilities",
  "active-profile",
  "capture",
  "events-summary",
  "diagnostic-runs",
  "redaction-report",
]);
export type SupportBundleCategory = z.infer<typeof SupportBundleCategorySchema>;

export const SupportBundleRedactionCategorySchema = z.enum([
  "raw-profile-configuration",
  "subscription-urls",
  "credentials-and-secrets",
  "full-paths",
  "node-labels",
  "connection-destinations",
  "process-paths",
  "network-addresses-and-hostnames",
  "private-endpoints",
  "controller-payloads",
  "status-bar-labels",
  "event-text",
  "diagnostic-prose",
]);
export type SupportBundleRedactionCategory = z.infer<typeof SupportBundleRedactionCategorySchema>;

export const SupportBundleTimeRangeSchema = z
  .object({ endedAt: NonNegativeIntegerSchema, startedAt: NonNegativeIntegerSchema })
  .strict()
  .refine(({ endedAt, startedAt }) => endedAt >= startedAt, {
    message: "Support bundle time range must be monotonic",
  });

export const SupportBundleCategoryPreviewSchema = z
  .object({ category: SupportBundleCategorySchema, itemCount: NonNegativeIntegerSchema })
  .strict();

export const SupportBundlePreviewSchema = z
  .object({
    categories: z.array(SupportBundleCategoryPreviewSchema).length(8),
    contentBytes: NonNegativeIntegerSchema.max(256 * 1_024),
    excludedOrRedacted: z.array(SupportBundleRedactionCategorySchema).length(13),
    fileType: z.literal("application/json"),
    formatVersion: z.literal(1),
    maxBytes: z.literal(256 * 1_024),
    previewId: IdentifierSchema,
    timeRange: SupportBundleTimeRangeSchema.nullable(),
  })
  .strict()
  .superRefine((preview, context) => {
    if (new Set(preview.categories.map(({ category }) => category)).size !== 8) {
      context.addIssue({ code: "custom", message: "Support bundle categories must be unique" });
    }
    if (new Set(preview.excludedOrRedacted).size !== 13) {
      context.addIssue({ code: "custom", message: "Redaction categories must be unique" });
    }
    if (preview.contentBytes > preview.maxBytes) {
      context.addIssue({ code: "custom", message: "Support bundle exceeds its size limit" });
    }
  });
export interface SupportBundlePreviewDto extends z.infer<typeof SupportBundlePreviewSchema> {}

export const SupportBundleSaveResultSchema = z
  .object({ status: z.enum(["cancelled", "written"]) })
  .strict();
export interface SupportBundleSaveResultDto extends z.infer<typeof SupportBundleSaveResultSchema> {}

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
  selectedChildId: IdentifierSchema.nullable(),
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
  "repair-required",
]);
export type CapabilityAvailability = z.infer<typeof CapabilityAvailabilitySchema>;

export const PlatformCapabilitiesSchema = z
  .object({
    systemProxy: CapabilityAvailabilitySchema,
    tun: CapabilityAvailabilitySchema,
  })
  .strict();
export interface PlatformCapabilitiesDto extends z.infer<typeof PlatformCapabilitiesSchema> {}

export const AppearancePreferenceSchema = z.enum(["system", "light", "dark"]);
export type AppearancePreference = z.infer<typeof AppearancePreferenceSchema>;

export const LanguagePreferenceSchema = z.enum(["en", "zh"]);
export type LanguagePreference = z.infer<typeof LanguagePreferenceSchema>;

export const LoginLaunchBehaviorSchema = z.enum(["show-window", "background"]);
export type LoginLaunchBehavior = z.infer<typeof LoginLaunchBehaviorSchema>;

export const WindowCloseBehaviorSchema = z.enum(["hide-to-status-bar", "quit"]);
export type WindowCloseBehavior = z.infer<typeof WindowCloseBehaviorSchema>;

export const WindowSurfacePreferenceSchema = z.enum(["opaque", "material"]);
export type WindowSurfacePreference = z.infer<typeof WindowSurfacePreferenceSchema>;

export const StartupPreferencesSchema = z
  .object({
    launchAtLogin: z.boolean(),
    loginLaunchBehavior: LoginLaunchBehaviorSchema,
  })
  .strict();
export interface StartupPreferencesDto extends z.infer<typeof StartupPreferencesSchema> {}

export const SettingsPreferencesSchema = z
  .object({
    appearance: AppearancePreferenceSchema,
    language: LanguagePreferenceSchema,
    startup: StartupPreferencesSchema,
    windowCloseBehavior: WindowCloseBehaviorSchema,
    windowSurface: WindowSurfacePreferenceSchema,
  })
  .strict();
export interface SettingsPreferencesDto extends z.infer<typeof SettingsPreferencesSchema> {}

export const SettingsAdapterKindSchema = z.enum(["fixture", "rpc"]);
export type SettingsAdapterKind = z.infer<typeof SettingsAdapterKindSchema>;

export const SettingsAvailabilitySchema = z.enum(["supported", "unavailable", "coming-later"]);
export type SettingsAvailability = z.infer<typeof SettingsAvailabilitySchema>;

export const SettingsCapabilitiesSchema = z
  .object({
    backgroundLaunch: SettingsAvailabilitySchema,
    backupRestore: SettingsAvailabilitySchema,
    expertConfiguration: SettingsAvailabilitySchema,
    launchAtLogin: SettingsAvailabilitySchema,
    nativeSidebarMaterial: SettingsAvailabilitySchema,
    networkDns: SettingsAvailabilitySchema,
    statusBar: SettingsAvailabilitySchema,
    tun: SettingsAvailabilitySchema,
    updates: SettingsAvailabilitySchema,
    windowLifecycle: SettingsAvailabilitySchema,
  })
  .strict();
export interface SettingsCapabilitiesDto extends z.infer<typeof SettingsCapabilitiesSchema> {}

export const ConfirmationStateSchema = z.enum(["confirmed", "unavailable"]);
export type ConfirmationState = z.infer<typeof ConfirmationStateSchema>;

export const PrivacyAccessSnapshotSchema = z
  .object({
    authenticated: ConfirmationStateSchema,
    lanControl: SettingsAvailabilitySchema,
    loopbackOnly: ConfirmationStateSchema,
    originValidated: ConfirmationStateSchema,
  })
  .strict();
export interface PrivacyAccessSnapshotDto extends z.infer<typeof PrivacyAccessSnapshotSchema> {}

export const StartupRegistrationPhaseSchema = z.enum(["applied", "drift", "failed", "unavailable"]);
export type StartupRegistrationPhase = z.infer<typeof StartupRegistrationPhaseSchema>;

export const StartupRegistrationSnapshotSchema = z
  .object({
    desired: z.boolean(),
    observed: z.boolean().nullable(),
    phase: StartupRegistrationPhaseSchema,
  })
  .strict()
  .superRefine((registration, context) => {
    if (registration.phase === "applied" && registration.observed !== registration.desired) {
      context.addIssue({
        code: "custom",
        message: "Applied startup registration must match the observed platform state",
      });
    }
    if (registration.phase === "drift" && registration.observed === registration.desired) {
      context.addIssue({ code: "custom", message: "Drift requires an observed mismatch" });
    }
  });
export interface StartupRegistrationSnapshotDto extends z.infer<
  typeof StartupRegistrationSnapshotSchema
> {}

export const TunHelperAvailabilitySchema = z.enum([
  "available",
  "permission-required",
  "repair-required",
  "unpackaged",
  "unsigned-app",
  "unsupported-system",
  "unavailable",
]);
export type TunHelperAvailability = z.infer<typeof TunHelperAvailabilitySchema>;

export const TunHelperHealthSchema = z.enum([
  "healthy",
  "invalid-signature",
  "not-installed",
  "unknown",
  "unreachable",
  "version-mismatch",
]);
export type TunHelperHealth = z.infer<typeof TunHelperHealthSchema>;

export const TunHelperLifecyclePhaseSchema = z.enum([
  "failed",
  "idle",
  "installing",
  "removing",
  "repairing",
]);
export type TunHelperLifecyclePhase = z.infer<typeof TunHelperLifecyclePhaseSchema>;

export const TunHelperFailureKindSchema = z.enum([
  "authorization-cancelled",
  "confirmation-failed",
  "connection-failed",
  "identity-rejected",
  "installation-failed",
  "installer-unavailable",
  "invalid-signature",
  "message-too-large",
  "operation-failed",
  "permission-denied",
  "preparation-failed",
  "protocol-mismatch",
  "registration-failed",
  "registration-requires-approval",
  "unpackaged",
  "unsigned-app",
  "unsupported-system",
  "version-mismatch",
]);
export type TunHelperFailureKind = z.infer<typeof TunHelperFailureKindSchema>;

export const TunHelperSnapshotSchema = z
  .object({
    availability: TunHelperAvailabilitySchema,
    expectedVersion: z.string().min(1).max(64),
    health: TunHelperHealthSchema,
    installationId: z
      .string()
      .length(64)
      .regex(/^[a-f0-9]+$/)
      .nullable(),
    installedVersion: z.string().min(1).max(64).nullable(),
    lastFailure: TunHelperFailureKindSchema.nullable(),
    phase: TunHelperLifecyclePhaseSchema,
  })
  .strict();
export interface TunHelperSnapshotDto extends z.infer<typeof TunHelperSnapshotSchema> {}

export const SettingsSnapshotSchema = z
  .object({
    adapterKind: SettingsAdapterKindSchema,
    capabilities: SettingsCapabilitiesSchema,
    networkDns: z
      .object({
        dns: z
          .object({
            resolverCount: z.number().int().min(0).max(64),
            scopedResolverCount: z.number().int().min(0).max(64),
            searchDomains: z.array(z.string().min(1).max(253)).max(32),
            servers: z.array(z.string().min(1).max(253)).max(32),
          })
          .strict()
          .nullable(),
        failure: z
          .enum([
            "command-failed",
            "command-unavailable",
            "invalid-output",
            "output-too-large",
            "timed-out",
          ])
          .nullable(),
        observedAt: z.number().int().nonnegative().nullable(),
        phase: z.enum(["failed", "ready", "stale", "unavailable", "unknown"]),
        interfaces: z
          .array(
            z
              .object({
                interface: z.string().min(1).max(64),
                interfaceKind: z.enum([
                  "ethernet",
                  "other",
                  "thunderbolt-bridge",
                  "unknown",
                  "wifi",
                ]),
                ipv4Available: z.boolean(),
                ipv6Available: z.boolean(),
                service: z.string().min(1).max(253).nullable(),
              })
              .strict(),
          )
          .max(16),
        source: z.literal("macos-system-configuration").nullable(),
      })
      .strict(),
    preferences: SettingsPreferencesSchema,
    privacy: PrivacyAccessSnapshotSchema,
    startupRegistration: StartupRegistrationSnapshotSchema,
    storageRecovered: z.boolean(),
    tunHelper: TunHelperSnapshotSchema,
  })
  .strict();
export interface SettingsSnapshotDto extends z.infer<typeof SettingsSnapshotSchema> {}

export const RpcSettingsSnapshotSchema = SettingsSnapshotSchema.extend({
  adapterKind: z.literal("rpc"),
});
export interface RpcSettingsSnapshotDto extends z.infer<typeof RpcSettingsSnapshotSchema> {}

export const LocalBackupAvailabilitySchema = z.enum(["supported", "unavailable"]);
export type LocalBackupAvailability = z.infer<typeof LocalBackupAvailabilitySchema>;

export const LocalBackupScopeSchema = z
  .object({
    patches: z.boolean(),
    profiles: z.boolean(),
    schedules: z.boolean(),
    settings: z.boolean(),
    sourceLocators: z.boolean(),
  })
  .strict()
  .superRefine((scope, context) => {
    if (!scope.patches && !scope.profiles && !scope.schedules && !scope.settings) {
      context.addIssue({ code: "custom", message: "Select at least one backup category" });
    }
    if (scope.sourceLocators && !scope.profiles) {
      context.addIssue({ code: "custom", message: "Source locators require profile contents" });
    }
  });
export interface LocalBackupScopeDto extends z.infer<typeof LocalBackupScopeSchema> {}

export const LocalBackupSensitiveDataSchema = z.enum([
  "credentials-and-profile-contents",
  "subscription-urls-and-full-paths",
]);
export type LocalBackupSensitiveData = z.infer<typeof LocalBackupSensitiveDataSchema>;

export const LocalBackupIncludedCountsSchema = z
  .object({
    patches: NonNegativeIntegerSchema.max(128 * 128),
    profiles: NonNegativeIntegerSchema.max(128),
    schedules: NonNegativeIntegerSchema.max(128),
    settings: NonNegativeIntegerSchema.max(1),
  })
  .strict();
export interface LocalBackupIncludedCountsDto extends z.infer<
  typeof LocalBackupIncludedCountsSchema
> {}

export const LocalBackupPreviewSchema = z
  .object({
    contentBytes: NonNegativeIntegerSchema.max(8 * 1_024 * 1_024),
    excludedSensitiveData: z.array(LocalBackupSensitiveDataSchema).max(2),
    fileType: z.literal("application/json"),
    formatVersion: z.literal(1),
    included: LocalBackupIncludedCountsSchema,
    includedSensitiveData: z.array(LocalBackupSensitiveDataSchema).max(2),
    maxBytes: z.literal(8 * 1_024 * 1_024),
    previewId: IdentifierSchema,
    scope: LocalBackupScopeSchema,
  })
  .strict()
  .superRefine((preview, context) => {
    const categories = [...preview.excludedSensitiveData, ...preview.includedSensitiveData];
    if (new Set(categories).size !== 2 || categories.length !== 2) {
      context.addIssue({ code: "custom", message: "Sensitive categories must form a partition" });
    }
  });
export interface LocalBackupPreviewDto extends z.infer<typeof LocalBackupPreviewSchema> {}

export const LocalRestoreConflictResolutionSchema = z.enum(["keep-existing", "use-backup"]);
export type LocalRestoreConflictResolution = z.infer<typeof LocalRestoreConflictResolutionSchema>;

export const LocalRestoreConflictKindSchema = z.enum([
  "active-profile",
  "duplicate-fingerprint",
  "id-mismatch",
  "missing-profile",
  "revision-mismatch",
]);
export type LocalRestoreConflictKind = z.infer<typeof LocalRestoreConflictKindSchema>;

const LocalBackupFingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);

export const LocalRestoreConflictSchema = z
  .object({
    backupFingerprint: LocalBackupFingerprintSchema,
    backupRevision: LocalBackupFingerprintSchema,
    currentFingerprint: LocalBackupFingerprintSchema.nullable(),
    currentRevision: LocalBackupFingerprintSchema.nullable(),
    kind: LocalRestoreConflictKindSchema,
    label: z.string().min(1).max(256),
    profileId: IdentifierSchema,
    replaceAllowed: z.boolean(),
  })
  .strict();
export interface LocalRestoreConflictDto extends z.infer<typeof LocalRestoreConflictSchema> {}

export const LocalRestoreActionCountsSchema = z
  .object({
    add: NonNegativeIntegerSchema.max(128),
    replace: NonNegativeIntegerSchema.max(128),
    skip: NonNegativeIntegerSchema.max(128),
    update: NonNegativeIntegerSchema.max(129),
  })
  .strict();
export interface LocalRestoreActionCountsDto extends z.infer<
  typeof LocalRestoreActionCountsSchema
> {}

export const LocalRestorePreviewSchema = z
  .object({
    actions: LocalRestoreActionCountsSchema,
    conflicts: z.array(LocalRestoreConflictSchema).max(128),
    contentBytes: NonNegativeIntegerSchema.max(8 * 1_024 * 1_024),
    excludedSensitiveData: z.array(LocalBackupSensitiveDataSchema).max(2),
    fileType: z.literal("application/json"),
    formatVersion: z.literal(1),
    included: LocalBackupIncludedCountsSchema,
    includedSensitiveData: z.array(LocalBackupSensitiveDataSchema).max(2),
    maxBytes: z.literal(8 * 1_024 * 1_024),
    previewId: IdentifierSchema,
    scope: LocalBackupScopeSchema,
  })
  .strict()
  .superRefine((preview, context) => {
    const categories = [...preview.excludedSensitiveData, ...preview.includedSensitiveData];
    if (new Set(categories).size !== 2 || categories.length !== 2) {
      context.addIssue({ code: "custom", message: "Sensitive categories must form a partition" });
    }
  });
export interface LocalRestorePreviewDto extends z.infer<typeof LocalRestorePreviewSchema> {}

export const LocalRestoreResultSchema = z
  .object({
    applied: LocalRestoreActionCountsSchema,
    settingsSnapshot: SettingsSnapshotSchema,
  })
  .strict();
export interface LocalRestoreResultDto extends z.infer<typeof LocalRestoreResultSchema> {}

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
    protocolVersion: z.literal(14),
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
  "user-patches",
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
      z.literal("user-patches"),
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

export const ProfileRefreshPolicySchema = z.enum([
  "off",
  "six-hours",
  "twelve-hours",
  "daily",
  "weekly",
]);
export type ProfileRefreshPolicy = z.infer<typeof ProfileRefreshPolicySchema>;

export const ProfileRefreshStateSchema = z
  .object({
    consecutiveFailures: NonNegativeIntegerSchema.max(255),
    lastFailureAt: NonNegativeIntegerSchema.nullable(),
    lastSuccessAt: NonNegativeIntegerSchema.nullable(),
    nextRunAt: NonNegativeIntegerSchema.nullable(),
    policy: ProfileRefreshPolicySchema,
  })
  .strict();

export const ProfileListItemSchema = z
  .object({
    effectiveFingerprint: ProfileFingerprintSchema,
    id: IdentifierSchema,
    label: z.string(),
    lastAttempt: ProfileAttemptSchema.nullable(),
    lastKnownValid: z.boolean(),
    lastSuccessAt: NonNegativeIntegerSchema.nullable(),
    refresh: ProfileRefreshStateSchema,
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
    patches: ProfileCapabilityAvailabilitySchema,
    refresh: ProfileCapabilityAvailabilitySchema,
    scheduling: ProfileCapabilityAvailabilitySchema,
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
  "capture",
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

export const ProviderKindSchema = z.enum(["proxy", "rule"]);
export type ProviderKind = z.infer<typeof ProviderKindSchema>;
export const ProviderCapabilityAvailabilitySchema = z.enum([
  "fixture-only",
  "supported",
  "unavailable",
]);
export const ProviderAuthoritySchema = z
  .object({ profileId: IdentifierSchema, runtimeFingerprint: ProfileFingerprintSchema })
  .strict();
export interface ProviderAuthorityDto extends z.infer<typeof ProviderAuthoritySchema> {}
export const ProviderUpdateFailureSchema = z.enum([
  "conflict",
  "disconnected",
  "inconsistent-observation",
  "not-found",
  "runtime-replaced",
  "stale-authority",
  "timeout",
  "update-rejected",
  "version-drift",
]);
export const ProviderUpdateStateSchema = z
  .object({
    attemptedAt: NonNegativeIntegerSchema.nullable(),
    failure: ProviderUpdateFailureSchema.nullable(),
    finishedAt: NonNegativeIntegerSchema.nullable(),
    phase: z.enum(["idle", "pending", "success", "failure"]),
  })
  .strict();
export const RuntimeProviderSchema = z
  .object({
    behavior: BoundedTextSchema.nullable(),
    healthyRecordCount: NonNegativeIntegerSchema.nullable(),
    health: z.enum(["available", "degraded", "unavailable", "unknown"]),
    id: IdentifierSchema,
    kind: ProviderKindSchema,
    label: BoundedTextSchema,
    recordCount: NonNegativeIntegerSchema,
    sourceType: z.enum(["file", "http", "compatible", "inline"]),
    updatedAt: BoundedTextSchema.nullable(),
    update: ProviderUpdateStateSchema,
  })
  .strict();
export interface RuntimeProviderDto extends z.infer<typeof RuntimeProviderSchema> {}
export const ProviderSnapshotSchema = z
  .object({
    authority: ProviderAuthoritySchema.nullable(),
    capability: ProviderCapabilityAvailabilitySchema,
    observationFailure: ProviderUpdateFailureSchema.nullable(),
    observedAt: NonNegativeIntegerSchema.nullable(),
    providers: z.array(RuntimeProviderSchema).max(1024),
    remotelyCancellable: z.literal(false),
  })
  .strict();
export interface ProviderSnapshotDto extends z.infer<typeof ProviderSnapshotSchema> {}
export const ProviderCommandResultSchema = z
  .object({
    failed: z
      .array(
        z.object({ failure: ProviderUpdateFailureSchema, providerId: IdentifierSchema }).strict(),
      )
      .max(1024),
    failure: ProviderUpdateFailureSchema.nullable(),
    operation: z.enum(["update-one", "update-all"]),
    phase: z.enum(["success", "partial", "failure"]),
    snapshot: ProviderSnapshotSchema,
    succeededProviderIds: z.array(IdentifierSchema).max(1024),
  })
  .strict();
export interface ProviderCommandResultDto extends z.infer<typeof ProviderCommandResultSchema> {}

export const ProfileSnapshotSchema = z
  .object({
    activation: ProfileActivationSnapshotSchema,
    adapterKind: z.enum(["fixture", "rpc", "native"]),
    capabilities: ProfileCapabilitiesSchema,
    profiles: z.array(ProfileListItemSchema),
    providers: ProviderSnapshotSchema,
  })
  .strict();
export interface ProfileSnapshotDto extends z.infer<typeof ProfileSnapshotSchema> {}

export const ProfileRouteCatalogSchema = z
  .object({
    fingerprint: ProfileFingerprintSchema,
    groups: z.array(PolicyGroupSchema).max(1024),
    nodes: z.array(ProxyNodeSchema).max(8192),
    profileId: IdentifierSchema,
    routingMode: RoutingModeSchema,
  })
  .strict();
export interface ProfileRouteCatalogDto extends z.infer<typeof ProfileRouteCatalogSchema> {}

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

const ProfilePatchEntityIdSchema = ProfileFingerprintSchema;
export const ProfilePatchAuthoritySchema = z
  .object({
    artifactFingerprint: ProfileFingerprintSchema,
    profileId: IdentifierSchema,
    sourceRevision: ProfileFingerprintSchema,
  })
  .strict();
export interface ProfilePatchAuthorityDto extends z.infer<typeof ProfilePatchAuthoritySchema> {}

export const ProfilePatchEntityKindSchema = z.enum([
  "built-in",
  "policy-group",
  "proxy",
  "rule-provider",
]);
export const ProfilePatchEntitySchema = z
  .object({
    id: ProfilePatchEntityIdSchema,
    kind: ProfilePatchEntityKindSchema,
    label: z.string().max(256),
  })
  .strict();
export interface ProfilePatchEntityDto extends z.infer<typeof ProfilePatchEntitySchema> {}

export const ProfilePatchGroupSchema = z
  .object({
    id: ProfilePatchEntityIdSchema,
    label: z.string().max(256),
    memberIds: z.array(ProfilePatchEntityIdSchema).max(1024),
    position: NonNegativeIntegerSchema,
    supported: z.boolean(),
  })
  .strict();
export interface ProfilePatchGroupDto extends z.infer<typeof ProfilePatchGroupSchema> {}

export const ProfilePatchRuleSchema = z
  .object({
    id: ProfilePatchEntityIdSchema,
    position: NonNegativeIntegerSchema,
    ruleType: z.string().min(1).max(64),
    target: z.string().min(1).max(256),
  })
  .strict();
export interface ProfilePatchRuleDto extends z.infer<typeof ProfilePatchRuleSchema> {}

export const ProfilePatchCatalogSchema = z
  .object({
    groups: z.array(ProfilePatchGroupSchema).max(1024),
    outbounds: z.array(ProfilePatchEntitySchema).max(2048),
    ruleProviders: z.array(ProfilePatchEntitySchema).max(1024),
    rules: z.array(ProfilePatchRuleSchema).max(8192),
  })
  .strict();
export interface ProfilePatchCatalogDto extends z.infer<typeof ProfilePatchCatalogSchema> {}

export const CommonRuleTypeSchema = z.enum([
  "domain",
  "domain-suffix",
  "domain-keyword",
  "ip-cidr",
  "ip-cidr6",
  "geo-ip",
  "geo-site",
  "process-name",
]);
export type CommonRuleType = z.infer<typeof CommonRuleTypeSchema>;

export const StructuredRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("match"), targetId: ProfilePatchEntityIdSchema }).strict(),
  z
    .object({
      kind: z.literal("rule-set"),
      noResolve: z.boolean(),
      providerId: ProfilePatchEntityIdSchema,
      targetId: ProfilePatchEntityIdSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("standard"),
      noResolve: z.boolean(),
      ruleType: CommonRuleTypeSchema,
      targetId: ProfilePatchEntityIdSchema,
      value: z.string().min(1).max(1024),
    })
    .strict(),
]);
export type StructuredRuleDto = z.infer<typeof StructuredRuleSchema>;

export const ProfilePatchOperationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("rule-insert"),
      position: z.enum(["prefix", "suffix"]),
      rule: StructuredRuleSchema,
    })
    .strict(),
  z.object({ kind: z.literal("rule-disable"), ruleId: ProfilePatchEntityIdSchema }).strict(),
  z.object({ kind: z.literal("rule-delete"), ruleId: ProfilePatchEntityIdSchema }).strict(),
  z
    .object({
      kind: z.literal("group-add"),
      label: z.string().min(1).max(256),
      memberIds: z.array(ProfilePatchEntityIdSchema).min(1).max(1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("group-members"),
      groupId: ProfilePatchEntityIdSchema,
      memberIds: z.array(ProfilePatchEntityIdSchema).min(1).max(1024),
    })
    .strict(),
  z
    .object({
      kind: z.literal("group-reorder"),
      groupIds: z.array(ProfilePatchEntityIdSchema).max(1024),
    })
    .strict(),
]);
export type ProfilePatchOperationDto = z.infer<typeof ProfilePatchOperationSchema>;

export const ProfilePatchSchema = z
  .object({
    enabled: z.boolean(),
    id: z.uuid(),
    operation: ProfilePatchOperationSchema,
  })
  .strict();
export interface ProfilePatchDto extends z.infer<typeof ProfilePatchSchema> {}

export const ProfilePatchValidationResultSchema = z.enum(["valid", "stale", "invalid"]);
export type ProfilePatchValidationResult = z.infer<typeof ProfilePatchValidationResultSchema>;
export const ProfilePatchValidationCodeSchema = z.enum([
  "valid",
  "disabled",
  "revision-mismatch",
  "target-missing",
  "duplicate-target",
  "duplicate-label",
  "unsafe-reference",
  "invalid-value",
  "invalid-order",
  "semantic-conflict",
]);
export type ProfilePatchValidationCode = z.infer<typeof ProfilePatchValidationCodeSchema>;
export const ProfilePatchActivationImpactSchema = z.enum([
  "insert-rule",
  "exclude-rule",
  "add-group",
  "replace-group-members",
  "reorder-groups",
  "no-change",
  "blocks-activation",
]);
export const ProfilePatchStatusSchema = z.enum(["enabled", "disabled", "stale", "invalid"]);
export type ProfilePatchStatus = z.infer<typeof ProfilePatchStatusSchema>;
export const ProfilePatchViewSchema = ProfilePatchSchema.extend({
  activationImpact: ProfilePatchActivationImpactSchema,
  order: NonNegativeIntegerSchema,
  status: ProfilePatchStatusSchema,
  target: z.string().min(1).max(512),
  validationCode: ProfilePatchValidationCodeSchema,
  validationResult: ProfilePatchValidationResultSchema,
}).strict();
export interface ProfilePatchViewDto extends z.infer<typeof ProfilePatchViewSchema> {}

export const ProfilePatchEditorSchema = z
  .object({
    activationBlocked: z.boolean(),
    authority: ProfilePatchAuthoritySchema,
    catalog: ProfilePatchCatalogSchema,
    effectiveFingerprint: ProfileFingerprintSchema,
    patches: z.array(ProfilePatchViewSchema).max(128),
    schemaVersion: z.literal(1),
  })
  .strict();
export interface ProfilePatchEditorDto extends z.infer<typeof ProfilePatchEditorSchema> {}

export const ProfilePreflightHttpsCommandSchema = z
  .object({ label: z.string().optional(), url: z.string().min(1).max(8192) })
  .strict();
export const ProfileSaveCommandSchema = z.object({ previewId: IdentifierSchema }).strict();
export const ProfileIdCommandSchema = z.object({ profileId: IdentifierSchema }).strict();
export const ProfileRefreshPolicyCommandSchema = z
  .object({ profileId: IdentifierSchema, policy: ProfileRefreshPolicySchema })
  .strict();
export const ProfileReplacePatchesCommandSchema = z
  .object({
    authority: ProfilePatchAuthoritySchema,
    patches: z.array(ProfilePatchSchema).max(128),
    schemaVersion: z.literal(1),
  })
  .strict();
export const UpdateProviderCommandSchema = z
  .object({ authority: ProviderAuthoritySchema, providerId: IdentifierSchema })
  .strict();
export const UpdateAllProvidersCommandSchema = z
  .object({ authority: ProviderAuthoritySchema, kind: ProviderKindSchema })
  .strict();
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
  "status.testLocalProxy": {
    params: EmptyCommandSchema,
    result: LocalProxyTestResultSchema,
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
  "profiles.getPatches": {
    params: ProfilePatchAuthoritySchema,
    result: ProfilePatchEditorSchema,
  },
  "profiles.getRoutes": {
    params: ProfileIdCommandSchema,
    result: ProfileRouteCatalogSchema,
  },
  "profiles.preflightHttps": {
    params: ProfilePreflightHttpsCommandSchema,
    result: ProfilePreviewSchema,
  },
  "profiles.refresh": { params: ProfileIdCommandSchema, result: RpcProfileSnapshotSchema },
  "profiles.replacePatches": {
    params: ProfileReplacePatchesCommandSchema,
    result: ProfilePatchEditorSchema,
  },
  "profiles.setRefreshPolicy": {
    params: ProfileRefreshPolicyCommandSchema,
    result: RpcProfileSnapshotSchema,
  },
  "profiles.save": { params: ProfileSaveCommandSchema, result: RpcProfileSnapshotSchema },
  "profiles.stop": {
    params: ProfileActivationControlCommandSchema,
    result: ProfileActivationSnapshotSchema,
  },
  "profiles.updateAllProviders": {
    params: UpdateAllProvidersCommandSchema,
    result: ProviderCommandResultSchema,
  },
  "profiles.updateProvider": {
    params: UpdateProviderCommandSchema,
    result: ProviderCommandResultSchema,
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

export const CancelDiagnosticRunCommandSchema = z.object({ runId: IdentifierSchema }).strict();
const RpcDiagnosticHistorySchema = DiagnosticHistorySchema.safeExtend({
  adapterKind: z.literal("rpc"),
});

export const diagnosticsRpcMethods = {
  "diagnostics.cancelRun": {
    params: CancelDiagnosticRunCommandSchema,
    result: RpcDiagnosticHistorySchema,
  },
  "diagnostics.getHistory": {
    params: EmptyCommandSchema,
    result: RpcDiagnosticHistorySchema,
  },
  "diagnostics.startRun": {
    params: EmptyCommandSchema,
    result: RpcDiagnosticHistorySchema,
  },
} as const;

export const SetAppearancePreferenceCommandSchema = z
  .object({ appearance: AppearancePreferenceSchema })
  .strict();
export const SetLanguagePreferenceCommandSchema = z
  .object({ language: LanguagePreferenceSchema })
  .strict();
export const SetStartupPreferencesCommandSchema = z
  .object({ startup: StartupPreferencesSchema })
  .strict();
export const SetWindowCloseBehaviorCommandSchema = z
  .object({ behavior: WindowCloseBehaviorSchema })
  .strict();
export const SetWindowSurfacePreferenceCommandSchema = z
  .object({ surface: WindowSurfacePreferenceSchema })
  .strict();

export const settingsRpcMethods = {
  "settings.getSnapshot": { params: EmptyCommandSchema, result: RpcSettingsSnapshotSchema },
  "settings.refreshNetworkDns": {
    params: EmptyCommandSchema,
    result: RpcSettingsSnapshotSchema,
  },
  "settings.installTunHelper": {
    params: EmptyCommandSchema,
    result: RpcSettingsSnapshotSchema,
  },
  "settings.repairTunHelper": {
    params: EmptyCommandSchema,
    result: RpcSettingsSnapshotSchema,
  },
  "settings.removeTunHelper": {
    params: EmptyCommandSchema,
    result: RpcSettingsSnapshotSchema,
  },
  "settings.setAppearance": {
    params: SetAppearancePreferenceCommandSchema,
    result: RpcSettingsSnapshotSchema,
  },
  "settings.setLanguage": {
    params: SetLanguagePreferenceCommandSchema,
    result: RpcSettingsSnapshotSchema,
  },
  "settings.setStartup": {
    params: SetStartupPreferencesCommandSchema,
    result: RpcSettingsSnapshotSchema,
  },
  "settings.setWindowCloseBehavior": {
    params: SetWindowCloseBehaviorCommandSchema,
    result: RpcSettingsSnapshotSchema,
  },
  "settings.setWindowSurface": {
    params: SetWindowSurfacePreferenceCommandSchema,
    result: RpcSettingsSnapshotSchema,
  },
} as const;

export const mishRpcMethods = {
  ...bridgeRpcMethods,
  ...diagnosticsRpcMethods,
  ...eventsRpcMethods,
  ...profileRpcMethods,
  ...settingsRpcMethods,
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
  testLocalProxy(options?: { signal?: AbortSignal }): Promise<LocalProxyTestResultDto>;
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

export interface SettingsClient {
  getSnapshot(options?: { signal?: AbortSignal }): Promise<SettingsSnapshotDto>;
  refreshNetworkDns(options?: { signal?: AbortSignal }): Promise<SettingsSnapshotDto>;
  installTunHelper(options?: { signal?: AbortSignal }): Promise<SettingsSnapshotDto>;
  repairTunHelper(options?: { signal?: AbortSignal }): Promise<SettingsSnapshotDto>;
  removeTunHelper(options?: { signal?: AbortSignal }): Promise<SettingsSnapshotDto>;
  setAppearance(
    appearance: AppearancePreference,
    options?: { signal?: AbortSignal },
  ): Promise<SettingsSnapshotDto>;
  setLanguage(
    language: LanguagePreference,
    options?: { signal?: AbortSignal },
  ): Promise<SettingsSnapshotDto>;
  setStartup(
    startup: StartupPreferencesDto,
    options?: { signal?: AbortSignal },
  ): Promise<SettingsSnapshotDto>;
  setWindowCloseBehavior(
    behavior: WindowCloseBehavior,
    options?: { signal?: AbortSignal },
  ): Promise<SettingsSnapshotDto>;
  setWindowSurface(
    surface: WindowSurfacePreference,
    options?: { signal?: AbortSignal },
  ): Promise<SettingsSnapshotDto>;
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
  getPatches(
    authority: ProfilePatchAuthorityDto,
    options?: { signal?: AbortSignal },
  ): Promise<ProfilePatchEditorDto>;
  getRoutes?(
    profileId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileRouteCatalogDto>;
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
  replacePatches(
    authority: ProfilePatchAuthorityDto,
    patches: ProfilePatchDto[],
    options?: { signal?: AbortSignal },
  ): Promise<ProfilePatchEditorDto>;
  setRefreshPolicy(
    profileId: string,
    policy: ProfileRefreshPolicy,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileSnapshotDto>;
  savePreview(previewId: string, options?: { signal?: AbortSignal }): Promise<ProfileSnapshotDto>;
  stopActiveProfile(
    commandId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProfileActivationSnapshotDto>;
  updateAllProviders(
    authority: ProviderAuthorityDto,
    kind: ProviderKind,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderCommandResultDto>;
  updateProvider(
    authority: ProviderAuthorityDto,
    providerId: string,
    options?: { signal?: AbortSignal },
  ): Promise<ProviderCommandResultDto>;
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

export interface DiagnosticsClient {
  cancelRun(runId: string, options?: { signal?: AbortSignal }): Promise<DiagnosticHistoryDto>;
  dispose(): void;
  getHistory(options?: { signal?: AbortSignal }): Promise<DiagnosticHistoryDto>;
  startRun(options?: { signal?: AbortSignal }): Promise<DiagnosticHistoryDto>;
}

export interface SupportBundleClient {
  readonly availability: SupportBundleAvailability;
  preview(options?: { signal?: AbortSignal }): Promise<SupportBundlePreviewDto>;
  save(previewId: string, options?: { signal?: AbortSignal }): Promise<SupportBundleSaveResultDto>;
}

export interface LocalBackupClient {
  readonly availability: LocalBackupAvailability;
  previewExport(
    scope: LocalBackupScopeDto,
    options?: { signal?: AbortSignal },
  ): Promise<LocalBackupPreviewDto>;
  saveExport(
    previewId: string,
    options?: { signal?: AbortSignal },
  ): Promise<SupportBundleSaveResultDto>;
  previewRestore(options?: { signal?: AbortSignal }): Promise<LocalRestorePreviewDto | null>;
  commitRestore(
    previewId: string,
    resolution: LocalRestoreConflictResolution,
    options?: { signal?: AbortSignal },
  ): Promise<LocalRestoreResultDto>;
}
