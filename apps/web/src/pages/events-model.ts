import type { EventLevel, EventRecordDto, EventSource, EventsSnapshotDto } from "@mish/contracts";
import type { PresentedEventRecord } from "../data/event-presentation";

export const EVENTS_LOCAL_BUFFER_LIMIT = 1_024;

export interface EventsBufferState {
  events: EventRecordDto[];
  profileId: string | null;
  seenIds: Set<string>;
  sequence: number;
  sessionId: string | null;
}

export type EventsOrder = "oldest" | "newest";

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
  events: PresentedEventRecord[],
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

export function sortEvents<T extends Pick<EventRecordDto, "id" | "sequence">>(
  events: T[],
  order: EventsOrder,
): T[] {
  const sorted = stableEvents(events);
  return order === "newest" ? sorted.toReversed() : sorted;
}

function stableEvents<T extends Pick<EventRecordDto, "id" | "sequence">>(events: T[]): T[] {
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
