import type {
  EventsConnectionState,
  NotificationClient,
  NotificationPresentationClaimDto,
  NotificationPresentationClaimResultDto,
  NotificationPresentationCompletionResultDto,
  NotificationPresentationFoldReason,
  NotificationPresentationIdentityDto,
  NotificationPresentationState,
  NotificationPublicationDto,
  NotificationRecordDto,
  NotificationSnapshotDelivery,
  NotificationSnapshotDto,
} from "@mish/contracts";

const presentationLeaseMilliseconds = 30_000;
let nextFixtureIdentity = 0;

interface FixturePresentationLease {
  expiresAt: number;
  generation: number;
  identity: NotificationPresentationIdentityDto;
}

/** A deterministic in-memory adapter that mirrors Rust's claim/lease/ack notification contract. */
export class FixtureNotificationCenter {
  private readonly clients = new Set<FixtureNotificationClient>();
  private nextId = 0;
  private readonly presentationGenerations = new Map<string, number>();
  private readonly presentationLeases = new Map<string, FixturePresentationLease>();
  private snapshot: NotificationSnapshotDto = { notifications: [], revision: 0 };

  attach(client: FixtureNotificationClient) {
    this.clients.add(client);
    return () => {
      this.releasePresentationLeases(client.presentationIdentity, client);
      this.clients.delete(client);
    };
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
      existing.severity === publication.severity &&
      existing.pinned === publication.pinned &&
      existing.resolved === publication.resolved &&
      JSON.stringify(existing.presentation) === JSON.stringify(publication.presentation) &&
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
          pinned: publication.pinned,
          presentation: structuredClone(publication.presentation),
          resolved: publication.resolved,
          revision,
          severity: publication.severity,
        }
      : {
          createdRevision: revision,
          dedupeKey: publication.dedupeKey,
          id: `notification:${++this.nextId}`,
          observedAt,
          pinned: publication.pinned,
          presentation: structuredClone(publication.presentation),
          presentationState: { phase: "unpresented" },
          read: false,
          resolved: publication.resolved,
          revision,
          severity: publication.severity,
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
    this.discardRemovedPresentationState();
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

  claimPresentation(
    identity: NotificationPresentationIdentityDto,
    excludedClient?: FixtureNotificationClient,
  ): NotificationPresentationClaimResultDto {
    const states = this.expirePresentationLeases(Date.now());
    const existing = [...this.presentationLeases.entries()].find(([, lease]) =>
      sameIdentity(lease.identity, identity),
    );
    if (existing) {
      const snapshot = this.commitPresentationStates(states, excludedClient);
      const record = snapshot.notifications.find(({ id }) => id === existing[0]);
      return { claim: record ? claimFor(record) : null, snapshot };
    }

    // Mirror Rust's single global presentation queue: another client cannot leapfrog a
    // presenting record just because a later notification is otherwise eligible.
    if (this.presentationLeases.size > 0) {
      return { claim: null, snapshot: this.commitPresentationStates(states, excludedClient) };
    }

    const candidate = [...this.snapshot.notifications]
      .filter(({ id, presentationState }) => {
        const state = states.get(id) ?? presentationState;
        return state.phase === "unpresented";
      })
      .sort(
        (left, right) =>
          left.createdRevision - right.createdRevision || left.id.localeCompare(right.id),
      )[0];
    if (candidate) {
      const generation = (this.presentationGenerations.get(candidate.id) ?? 0) + 1;
      const expiresAt = Date.now() + presentationLeaseMilliseconds;
      this.presentationGenerations.set(candidate.id, generation);
      this.presentationLeases.set(candidate.id, { expiresAt, generation, identity });
      states.set(candidate.id, {
        leaseExpiresAt: expiresAt,
        leaseGeneration: generation,
        phase: "presenting",
      });
    }
    const snapshot = this.commitPresentationStates(states, excludedClient);
    const claim = candidate
      ? snapshot.notifications.find(({ id }) => id === candidate.id)
      : undefined;
    return { claim: claim ? claimFor(claim) : null, snapshot };
  }

  completePresentation(
    identity: NotificationPresentationIdentityDto,
    claim: NotificationPresentationClaimDto,
    outcome: NotificationPresentationFoldReason,
    excludedClient?: FixtureNotificationClient,
  ): NotificationPresentationCompletionResultDto {
    const states = this.expirePresentationLeases(Date.now());
    const record = this.snapshot.notifications.find(({ id }) => id === claim.id);
    const lease = this.presentationLeases.get(claim.id);
    const accepted = Boolean(
      record &&
      lease &&
      record.revision === claim.revision &&
      lease.generation === claim.leaseGeneration &&
      sameIdentity(lease.identity, identity),
    );
    if (accepted) {
      this.presentationLeases.delete(claim.id);
      states.set(claim.id, { foldReason: outcome, foldedAt: Date.now(), phase: "folded" });
    }
    return { accepted, snapshot: this.commitPresentationStates(states, excludedClient) };
  }

  releasePresentationLeases(
    identity: NotificationPresentationIdentityDto,
    excludedClient?: FixtureNotificationClient,
  ) {
    const states = this.expirePresentationLeases(Date.now());
    for (const [id, lease] of this.presentationLeases) {
      if (!sameIdentity(lease.identity, identity)) continue;
      this.presentationLeases.delete(id);
      states.set(id, { phase: "unpresented" });
    }
    return this.commitPresentationStates(states, excludedClient);
  }

  remove(id: string) {
    return this.removeMatching(({ id: candidate, pinned }) => candidate === id && !pinned);
  }

  removeByDedupeKey(dedupeKey: string) {
    return this.removeMatching(({ dedupeKey: candidate }) => candidate === dedupeKey);
  }

  subscribe(client: FixtureNotificationClient): NotificationSnapshotDelivery {
    const result = this.claimPresentation(client.presentationIdentity, client);
    return { claim: result.claim, kind: "baseline", snapshot: result.snapshot };
  }

  unsubscribe(client: FixtureNotificationClient) {
    this.releasePresentationLeases(client.presentationIdentity, client);
  }

  private commitPresentationStates(
    states: ReadonlyMap<string, NotificationPresentationState>,
    excludedClient?: FixtureNotificationClient,
  ) {
    if (states.size === 0) return this.getSnapshot();
    const revision = this.snapshot.revision + 1;
    this.snapshot = {
      notifications: this.snapshot.notifications.map((record) => {
        const presentationState = states.get(record.id);
        return presentationState ? { ...record, presentationState, revision } : record;
      }),
      revision,
    };
    return this.commit(excludedClient);
  }

  private expirePresentationLeases(now: number) {
    const states = new Map<string, NotificationPresentationState>();
    for (const [id, lease] of this.presentationLeases) {
      if (lease.expiresAt > now) continue;
      this.presentationLeases.delete(id);
      states.set(id, { phase: "unpresented" });
    }
    return states;
  }

  private removeMatching(predicate: (record: NotificationRecordDto) => boolean) {
    const notifications = this.snapshot.notifications.filter((record) => !predicate(record));
    if (notifications.length === this.snapshot.notifications.length) return this.getSnapshot();
    this.snapshot = { notifications, revision: this.snapshot.revision + 1 };
    this.discardRemovedPresentationState();
    return this.commit();
  }

  private discardRemovedPresentationState() {
    const retained = new Set(this.snapshot.notifications.map(({ id }) => id));
    for (const id of this.presentationLeases.keys()) {
      if (!retained.has(id)) this.presentationLeases.delete(id);
    }
    for (const id of this.presentationGenerations.keys()) {
      if (!retained.has(id)) this.presentationGenerations.delete(id);
    }
  }

  private commit(excludedClient?: FixtureNotificationClient) {
    const snapshot = this.getSnapshot();
    for (const client of this.clients) {
      if (client === excludedClient) continue;
      client.receive(snapshot);
    }
    return snapshot;
  }
}

export class FixtureNotificationClient implements NotificationClient {
  private readonly listeners = new Set<(delivery: NotificationSnapshotDelivery) => void>();
  private readonly detach: () => void;
  private clientId = createFixtureIdentifier("fixture-client");
  private sessionId = createFixtureIdentifier("fixture-session");

  constructor(private readonly center = new FixtureNotificationCenter()) {
    this.detach = center.attach(this);
  }

  get presentationIdentity(): NotificationPresentationIdentityDto {
    return { clientId: this.clientId, sessionId: this.sessionId };
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

  async claimPresentation() {
    const result = this.center.claimPresentation(this.presentationIdentity, this);
    this.receiveDelivery({ claim: result.claim, kind: "update", snapshot: result.snapshot });
    return result;
  }

  async completePresentation(
    claim: NotificationPresentationClaimDto,
    outcome: NotificationPresentationFoldReason,
  ) {
    const result = this.center.completePresentation(
      this.presentationIdentity,
      claim,
      outcome,
      this,
    );
    this.receiveDelivery({ kind: "update", snapshot: result.snapshot });
    return result;
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
    const firstSubscriber = this.listeners.size === 0;
    this.listeners.add(listener);
    listener(
      firstSubscriber
        ? this.center.subscribe(this)
        : { kind: "baseline", snapshot: this.center.getSnapshot() },
    );
    return () => {
      this.listeners.delete(listener);
      if (this.listeners.size === 0) this.center.unsubscribe(this);
    };
  }

  receive(snapshot: NotificationSnapshotDto) {
    this.receiveDelivery({ kind: "update", snapshot });
  }

  reconnect() {
    this.center.releasePresentationLeases(this.presentationIdentity, this);
    this.sessionId = createFixtureIdentifier("fixture-session");
    if (this.listeners.size === 0) return;
    const delivery = this.center.subscribe(this);
    for (const listener of this.listeners) listener(structuredClone(delivery));
  }

  private receiveDelivery(delivery: NotificationSnapshotDelivery) {
    for (const listener of this.listeners) listener(structuredClone(delivery));
  }
}

function claimFor(record: NotificationRecordDto): NotificationPresentationClaimDto | null {
  if (record.presentationState.phase !== "presenting") return null;
  return {
    id: record.id,
    leaseExpiresAt: record.presentationState.leaseExpiresAt,
    leaseGeneration: record.presentationState.leaseGeneration,
    revision: record.revision,
  };
}

function createFixtureIdentifier(prefix: string) {
  nextFixtureIdentity += 1;
  return `${prefix}-${nextFixtureIdentity}`;
}

function sameIdentity(
  left: NotificationPresentationIdentityDto,
  right: NotificationPresentationIdentityDto,
) {
  return left.clientId === right.clientId && left.sessionId === right.sessionId;
}
