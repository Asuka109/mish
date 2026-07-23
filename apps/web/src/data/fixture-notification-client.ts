import type {
  EventsConnectionState,
  NotificationClient,
  NotificationPublicationDto,
  NotificationRecordDto,
  NotificationSnapshotDelivery,
  NotificationSnapshotDto,
} from "@mish/contracts";

export class FixtureNotificationCenter {
  private readonly clients = new Set<FixtureNotificationClient>();
  private nextId = 0;
  private snapshot: NotificationSnapshotDto = { notifications: [], revision: 0 };

  attach(client: FixtureNotificationClient) {
    this.clients.add(client);
    return () => this.clients.delete(client);
  }

  getSnapshot() {
    return structuredClone(this.snapshot);
  }

  publish(publication: NotificationPublicationDto) {
    const existing = this.snapshot.notifications.find(
      ({ dedupeKey, resolved }) =>
        dedupeKey === publication.dedupeKey && (!resolved || publication.resolved),
    );
    if (
      existing &&
      existing.type === publication.type &&
      existing.severity === publication.severity &&
      existing.resolved === publication.resolved &&
      JSON.stringify(existing.params) === JSON.stringify(publication.params) &&
      publication.replaces.length === 0
    ) {
      return this.getSnapshot();
    }
    const revision = this.snapshot.revision + 1;
    const observedAt = Date.now();
    const replaced = new Set(publication.replaces);
    const record: NotificationRecordDto = existing
      ? {
          ...existing,
          observedAt,
          params: structuredClone(publication.params),
          resolved: publication.resolved,
          revision,
          severity: publication.severity,
          type: publication.type,
        }
      : {
          createdRevision: revision,
          dedupeKey: publication.dedupeKey,
          id: `notification:${++this.nextId}`,
          observedAt,
          params: structuredClone(publication.params),
          read: false,
          resolved: publication.resolved,
          revision,
          severity: publication.severity,
          type: publication.type,
        };
    this.snapshot = {
      notifications: [
        record,
        ...this.snapshot.notifications.filter(
          ({ dedupeKey, id }) => id !== existing?.id && !replaced.has(dedupeKey),
        ),
      ].slice(0, 128),
      revision,
    };
    return this.commit();
  }

  markRead(ids: readonly string[]) {
    if (!this.snapshot.notifications.some(({ id, read }) => ids.includes(id) && !read)) {
      return this.getSnapshot();
    }
    const revision = this.snapshot.revision + 1;
    this.snapshot = {
      notifications: this.snapshot.notifications.map((record) =>
        ids.includes(record.id) ? { ...record, read: true, revision } : record,
      ),
      revision,
    };
    return this.commit();
  }

  remove(id: string) {
    return this.removeMatching(({ id: candidate }) => candidate === id);
  }

  removeByDedupeKey(dedupeKey: string) {
    return this.removeMatching(({ dedupeKey: candidate }) => candidate === dedupeKey);
  }

  private removeMatching(predicate: (record: NotificationRecordDto) => boolean) {
    const notifications = this.snapshot.notifications.filter((record) => !predicate(record));
    if (notifications.length === this.snapshot.notifications.length) return this.getSnapshot();
    this.snapshot = { notifications, revision: this.snapshot.revision + 1 };
    return this.commit();
  }

  private commit() {
    const snapshot = this.getSnapshot();
    for (const client of this.clients) client.receive(snapshot);
    return snapshot;
  }
}

export class FixtureNotificationClient implements NotificationClient {
  private readonly listeners = new Set<(delivery: NotificationSnapshotDelivery) => void>();
  private readonly detach: () => void;

  constructor(private readonly center = new FixtureNotificationCenter()) {
    this.detach = center.attach(this);
  }

  dispose() {
    this.detach();
    this.listeners.clear();
  }

  getConnectionState(): EventsConnectionState {
    return { attempt: 0, phase: "fixture", stale: false };
  }

  async getSnapshot() {
    return this.center.getSnapshot();
  }

  async markRead(ids: readonly string[]) {
    return this.center.markRead(ids);
  }

  async publish(publication: NotificationPublicationDto) {
    return this.center.publish(publication);
  }

  async remove(id: string) {
    return this.center.remove(id);
  }

  async removeByDedupeKey(dedupeKey: string) {
    return this.center.removeByDedupeKey(dedupeKey);
  }

  subscribeConnection(listener: (state: EventsConnectionState) => void) {
    listener(this.getConnectionState());
    return () => false;
  }

  subscribeSnapshots(listener: (delivery: NotificationSnapshotDelivery) => void) {
    this.listeners.add(listener);
    listener({ kind: "baseline", snapshot: this.center.getSnapshot() });
    return () => this.listeners.delete(listener);
  }

  receive(snapshot: NotificationSnapshotDto) {
    for (const listener of this.listeners) {
      listener({ kind: "update", snapshot: structuredClone(snapshot) });
    }
  }

  reconnect() {
    const snapshot = this.center.getSnapshot();
    for (const listener of this.listeners) {
      listener({ kind: "baseline", snapshot: structuredClone(snapshot) });
    }
  }
}
