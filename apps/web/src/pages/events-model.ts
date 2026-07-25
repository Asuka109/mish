import type {
  DiagnosticCheckDto,
  DiagnosticFailure,
  DiagnosticRunDto,
  EventLevel,
  EventRecordDto,
  EventSource,
  EventsSnapshotDto,
} from "@mish/contracts";

export const EVENTS_LOCAL_BUFFER_LIMIT = 1_024;

export interface EventsBufferState {
  events: EventRecordDto[];
  profileId: string | null;
  seenIds: Set<string>;
  sequence: number;
  sessionId: string | null;
}

export type EventsOrder = "oldest" | "newest";

export type DiagnosticConclusionKind =
  | "capture"
  | "core"
  | "dns"
  | "profile"
  | "proxy"
  | "reachability"
  | "retry"
  | "running"
  | "unavailable"
  | "healthy";

export interface DiagnosticConclusion {
  evidence: readonly DiagnosticCheckDto[];
  kind: DiagnosticConclusionKind;
}

const failurePriority: readonly DiagnosticFailure[] = [
  "capture-drift",
  "permission-denied",
  "core-unhealthy",
  "version-drift",
  "no-active-profile",
  "profile-invalid",
  "dns-failed",
  "endpoint-unreachable",
  "timeout",
  "controller-disconnected",
  "unavailable",
  "runtime-replaced",
  "cancelled",
];

export function selectDiagnosticConclusion(run: DiagnosticRunDto): DiagnosticConclusion {
  if (run.status === "running") return { evidence: run.checks.slice(-1), kind: "running" };
  if (run.status === "cancelled" || run.status === "invalidated")
    return { evidence: [], kind: "retry" };
  const failed = run.checks.filter((check) => check.failure !== null);
  const primary = failurePriority.find((failure) =>
    failed.some((check) => check.failure === failure),
  );
  const kind = conclusionKind(primary);
  return {
    evidence: failed.filter((check) => conclusionKind(check.failure) === kind).slice(0, 2),
    kind,
  };
}

export function conclusionKind(
  failure: DiagnosticFailure | null | undefined,
): DiagnosticConclusionKind {
  switch (failure) {
    case "capture-drift":
    case "permission-denied":
      return "capture";
    case "core-unhealthy":
    case "version-drift":
      return "core";
    case "no-active-profile":
    case "profile-invalid":
      return "profile";
    case "dns-failed":
      return "dns";
    case "endpoint-unreachable":
    case "timeout":
      return "reachability";
    case "controller-disconnected":
      return "proxy";
    case "unavailable":
      return "unavailable";
    case "runtime-replaced":
    case "cancelled":
      return "retry";
    default:
      return "healthy";
  }
}

export function createEventsBufferState(): EventsBufferState {
  return { events: [], profileId: null, seenIds: new Set(), sequence: 0, sessionId: null };
}

export function reconcileEventsSnapshot(
  state: EventsBufferState,
  snapshot: EventsSnapshotDto,
  limit = EVENTS_LOCAL_BUFFER_LIMIT,
): EventsBufferState {
  if (!snapshot.sessionId) {
    return { ...createEventsBufferState(), profileId: snapshot.profileId };
  }

  const sessionChanged =
    state.sessionId !== snapshot.sessionId || state.profileId !== snapshot.profileId;
  if (sessionChanged) {
    const events = stableEvents(snapshot.events).slice(-limit);
    return {
      events,
      profileId: snapshot.profileId,
      seenIds: new Set(snapshot.events.map(({ id }) => id)),
      sequence: snapshot.sequence,
      sessionId: snapshot.sessionId,
    };
  }

  const incoming = snapshot.events.filter(({ id }) => !state.seenIds.has(id));
  if (incoming.length === 0 && snapshot.sequence <= state.sequence) return state;
  const seenIds = new Set(state.seenIds);
  for (const event of snapshot.events) seenIds.add(event.id);
  return {
    events: stableEvents([...state.events, ...incoming]).slice(-limit),
    profileId: snapshot.profileId,
    seenIds,
    sequence: Math.max(state.sequence, snapshot.sequence),
    sessionId: snapshot.sessionId,
  };
}

export function clearLocalEvents(state: EventsBufferState): EventsBufferState {
  return { ...state, events: [] };
}

export function filterEvents(
  events: EventRecordDto[],
  query: string,
  levels: ReadonlySet<EventLevel>,
  sources: ReadonlySet<EventSource>,
) {
  const search = query.trim().toLocaleLowerCase();
  return events.filter((event) => {
    if (levels.size > 0 && !levels.has(event.level)) return false;
    if (sources.size > 0 && !sources.has(event.source)) return false;
    if (!search) return true;
    return `${event.message}\n${event.detail ?? ""}`.toLocaleLowerCase().includes(search);
  });
}

export function sortEvents(events: EventRecordDto[], order: EventsOrder) {
  const sorted = stableEvents(events);
  return order === "newest" ? sorted.toReversed() : sorted;
}

function stableEvents(events: EventRecordDto[]) {
  return events
    .map((event, index) => ({ event, index }))
    .toSorted(
      (left, right) =>
        left.event.sequence - right.event.sequence ||
        left.event.id.localeCompare(right.event.id) ||
        left.index - right.index,
    )
    .map(({ event }) => event);
}
