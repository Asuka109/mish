import {
  type EventRecordDto,
  type EventsClient,
  type EventsConnectionState,
  type EventsSnapshotDto,
} from "@mish/contracts";

const fixtureEvents: EventRecordDto[] = [
  {
    detail: "Synthetic session boundary; no desktop Controller was contacted",
    id: "fixture-events:1",
    level: "info",
    message: "Fixture event session started",
    observedAt: Date.parse("2026-07-18T08:00:00Z"),
    sequence: 1,
    source: "application",
  },
  {
    detail: null,
    id: "fixture-events:2",
    level: "warning",
    message: "Synthetic DNS lookup timed out for api.fixture.invalid",
    observedAt: Date.parse("2026-07-18T08:00:01Z"),
    sequence: 2,
    source: "core",
  },
  {
    detail: "Documentation address 198.51.100.24 was replaced before this fixture was committed",
    id: "fixture-events:3",
    level: "error",
    message: "Synthetic route check failed",
    observedAt: Date.parse("2026-07-18T08:00:02Z"),
    sequence: 3,
    source: "application",
  },
];

export class FixtureEventsClient implements EventsClient {
  private readonly connectionListeners = new Set<(state: EventsConnectionState) => void>();
  private readonly snapshotListeners = new Set<(snapshot: EventsSnapshotDto) => void>();
  private snapshot: EventsSnapshotDto = {
    adapterKind: "fixture",
    events: fixtureEvents.map((event) => ({ ...event })),
    phase: "ready",
    profileId: "fixture-profile",
    reconnectCount: 0,
    sequence: 3,
    sessionId: "fixture-events",
    sourceStatuses: ["application", "core", "platform", "rpc"].map((source) => ({
      detail: "Synthetic demo fixture; no desktop source was contacted",
      phase: "fixture-only" as const,
      source: source as "application" | "core" | "platform" | "rpc",
    })),
  };

  dispose() {
    this.connectionListeners.clear();
    this.snapshotListeners.clear();
  }

  getConnectionState(): EventsConnectionState {
    return { attempt: 0, phase: "fixture", stale: false };
  }

  async getSnapshot() {
    return structuredClone(this.snapshot);
  }

  publishSnapshot(snapshot: EventsSnapshotDto) {
    this.snapshot = structuredClone(snapshot);
    for (const listener of this.snapshotListeners) listener(structuredClone(this.snapshot));
  }

  subscribeConnection(listener: (state: EventsConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  subscribeSnapshots(listener: (snapshot: EventsSnapshotDto) => void) {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }
}

export function createFixtureEventsClient() {
  return new FixtureEventsClient();
}
