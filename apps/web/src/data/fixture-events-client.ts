import {
  type ApplicationSnapshotDelivery,
  type EventRecordDto,
  type EventsClient,
  type EventsConnectionState,
  type EventsSnapshotDto,
} from "@mish/contracts";

const fixtureEvents: EventRecordDto[] = [
  {
    application: {
      actionIds: [],
      data: { failure: "fixture-capture-failed" },
      kind: "capture.failure",
    },
    evidence: null,
    id: "fixture-events:1",
    level: "error",
    observedAt: Date.parse("2026-07-18T08:00:00Z"),
    sequence: 1,
    source: "application",
  },
  {
    application: null,
    evidence: {
      detail: null,
      message: "Synthetic DNS lookup timed out for api.fixture.invalid",
    },
    id: "fixture-events:2",
    level: "warning",
    observedAt: Date.parse("2026-07-18T08:00:01Z"),
    sequence: 2,
    source: "core",
  },
  {
    application: null,
    evidence: {
      detail: "Documentation address 198.51.100.24 was replaced before this fixture was committed",
      message: "Synthetic route check failed",
    },
    id: "fixture-events:3",
    level: "error",
    observedAt: Date.parse("2026-07-18T08:00:02Z"),
    sequence: 3,
    source: "core",
  },
];

export class FixtureEventsClient implements EventsClient {
  private readonly connectionListeners = new Set<(state: EventsConnectionState) => void>();
  private readonly snapshotListeners = new Set<
    (snapshot: EventsSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private snapshot: EventsSnapshotDto = {
    adapterKind: "fixture",
    applicationOrder: { authorityId: "fixture-events-application", epoch: 1, order: 1 },
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
    const next = structuredClone(snapshot);
    if (
      next.applicationOrder.authorityId === this.snapshot.applicationOrder.authorityId &&
      next.applicationOrder.epoch === this.snapshot.applicationOrder.epoch &&
      next.applicationOrder.order <= this.snapshot.applicationOrder.order &&
      (next.sessionId !== this.snapshot.sessionId ||
        next.profileId !== this.snapshot.profileId ||
        next.sequence >= this.snapshot.sequence)
    ) {
      next.applicationOrder.order = this.snapshot.applicationOrder.order + 1;
    }
    this.snapshot = next;
    for (const listener of this.snapshotListeners) {
      listener(structuredClone(this.snapshot), "update");
    }
  }

  subscribeConnection(listener: (state: EventsConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  subscribeSnapshots(
    listener: (snapshot: EventsSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ) {
    this.snapshotListeners.add(listener);
    return () => this.snapshotListeners.delete(listener);
  }
}

export function createFixtureEventsClient() {
  return new FixtureEventsClient();
}
