import {
  EventsSnapshotSchema,
  MobileDiagnosticCommandResultSchema,
  MobileDiagnosticSnapshotSchema,
  type ApplicationSnapshotDelivery,
  type EventsClient,
  type EventsConnectionState,
  type EventsSnapshotDto,
  type MobileDiagnosticClient,
  type MobileDiagnosticCommandResultDto,
  type MobileDiagnosticSnapshotDto,
} from "@mish/contracts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

interface MobileEventsTransport {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  listen(event: string, handler: (payload: unknown) => void): Promise<() => void>;
}

const defaultTransport: MobileEventsTransport = {
  invoke: (command, args) => invoke(`plugin:mish-vpn|${command}`, args),
  listen: async (event, handler) => {
    const unlisten = await listen(event, ({ payload }) => handler(payload));
    return unlisten;
  },
};

export class MobileEventsClient implements EventsClient, MobileDiagnosticClient {
  readonly availability = "supported" as const;
  private baselinePending = false;
  private connection: EventsConnectionState = { attempt: 0, phase: "connected", stale: false };
  private disposed = false;
  private events?: EventsSnapshotDto;
  private diagnostic?: MobileDiagnosticSnapshotDto;
  private eventsUnlisten?: () => void;
  private diagnosticUnlisten?: () => void;
  private eventsRecovery?: Promise<void>;
  private diagnosticRecovery?: Promise<void>;
  private readonly retiredEventAuthorities = new Set<string>();
  private readonly retiredDiagnosticAuthorities = new Set<string>();
  private readonly connectionSubscribers = new Set<(state: EventsConnectionState) => void>();
  private readonly eventSubscribers = new Set<
    (snapshot: EventsSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void
  >();
  private readonly diagnosticSubscribers = new Set<
    (snapshot: MobileDiagnosticSnapshotDto) => void
  >();

  constructor(private readonly transport: MobileEventsTransport = defaultTransport) {}

  async initialize(): Promise<void> {
    if (this.eventsUnlisten) return;
    this.baselinePending = true;
    this.eventsUnlisten = await this.transport.listen("mish-vpn://events", (payload) => {
      const snapshot = EventsSnapshotSchema.parse(payload);
      void this.acceptEvent(snapshot, "update");
    });
    this.diagnosticUnlisten = await this.transport.listen("mish-vpn://diagnostic", (payload) => {
      void this.acceptDiagnostic(MobileDiagnosticSnapshotSchema.parse(payload), "update");
    });
    const [events, diagnostic] = await Promise.all([this.fetchEvents(), this.fetchDiagnostic()]);
    this.acceptEventBaseline(events);
    this.acceptDiagnosticBaseline(diagnostic);
    this.baselinePending = false;
  }

  dispose(): void {
    this.disposed = true;
    this.eventsUnlisten?.();
    this.diagnosticUnlisten?.();
    this.eventsUnlisten = undefined;
    this.diagnosticUnlisten = undefined;
    this.connectionSubscribers.clear();
    this.eventSubscribers.clear();
    this.diagnosticSubscribers.clear();
  }

  getConnectionState(): EventsConnectionState {
    return this.connection;
  }

  async getSnapshot(options: { signal?: AbortSignal } = {}): Promise<EventsSnapshotDto> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await this.initialize();
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    return this.events ?? this.fetchEvents();
  }

  subscribeConnection(listener: (state: EventsConnectionState) => void): () => void {
    this.connectionSubscribers.add(listener);
    listener(this.connection);
    return () => this.connectionSubscribers.delete(listener);
  }

  subscribeSnapshots(
    listener: (snapshot: EventsSnapshotDto, delivery?: ApplicationSnapshotDelivery) => void,
  ): () => void {
    this.eventSubscribers.add(listener);
    if (this.events) listener(this.events, "baseline");
    return () => this.eventSubscribers.delete(listener);
  }

  async start(
    operationId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<MobileDiagnosticCommandResultDto> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const result = MobileDiagnosticCommandResultSchema.parse(
      await this.transport.invoke("start_diagnostic", { request: { operationId } }),
    );
    this.acceptDiagnosticBaseline(result.snapshot);
    if (options.signal) {
      const onAbort = () => {
        if (result.runId) void this.cancel(operationId, result.runId).catch(() => undefined);
      };
      options.signal.addEventListener("abort", onAbort, { once: true });
      if (options.signal.aborted) onAbort();
    }
    return result;
  }

  async cancel(
    operationId: string,
    runId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<MobileDiagnosticCommandResultDto> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const result = MobileDiagnosticCommandResultSchema.parse(
      await this.transport.invoke("cancel_diagnostic", {
        request: { operationId, runId },
      }),
    );
    this.acceptDiagnosticBaseline(result.snapshot);
    return result;
  }

  async getDiagnosticSnapshot(
    options: { signal?: AbortSignal } = {},
  ): Promise<MobileDiagnosticSnapshotDto> {
    if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
    await this.initialize();
    return this.diagnostic ?? this.fetchDiagnostic();
  }

  subscribe(listener: (snapshot: MobileDiagnosticSnapshotDto) => void): () => void {
    this.diagnosticSubscribers.add(listener);
    if (this.diagnostic) listener(this.diagnostic);
    return () => this.diagnosticSubscribers.delete(listener);
  }

  private async acceptEvent(
    snapshot: EventsSnapshotDto,
    delivery: ApplicationSnapshotDelivery,
  ): Promise<void> {
    if (this.disposed || this.baselinePending) return;
    const current = this.events;
    if (!current) return this.acceptEventBaseline(snapshot);
    const sameAuthority =
      snapshot.applicationOrder.authorityId === current.applicationOrder.authorityId &&
      snapshot.applicationOrder.epoch === current.applicationOrder.epoch;
    const authority = eventAuthority(snapshot);
    if (!sameAuthority) {
      if (this.retiredEventAuthorities.has(authority)) return;
      await this.recoverEventsBaseline();
      return;
    }
    const sameSession = snapshot.sessionId === current.sessionId;
    if (sameAuthority && sameSession && snapshot.sequence > current.sequence + 1) {
      await this.recoverEventsBaseline();
      return;
    }
    if (sameSession && snapshot.sequence <= current.sequence) {
      return;
    }
    this.events = snapshot;
    for (const listener of this.eventSubscribers) listener(snapshot, delivery);
  }

  private acceptEventBaseline(snapshot: EventsSnapshotDto): void {
    if (this.disposed) return;
    const current = this.events;
    const authority = eventAuthority(snapshot);
    if (this.retiredEventAuthorities.has(authority)) return;
    if (
      current &&
      eventAuthority(current) === authority &&
      snapshot.applicationOrder.epoch < current.applicationOrder.epoch
    ) {
      return;
    }
    if (current && eventAuthority(current) !== authority) {
      this.retiredEventAuthorities.add(eventAuthority(current));
    }
    this.events = snapshot;
    this.connection = { attempt: 0, phase: "connected", stale: false };
    this.publishConnection();
    for (const listener of this.eventSubscribers) listener(snapshot, "baseline");
  }

  private async acceptDiagnostic(
    snapshot: MobileDiagnosticSnapshotDto,
    delivery: ApplicationSnapshotDelivery,
  ): Promise<void> {
    if (this.disposed) return;
    const current = this.diagnostic;
    if (!current) return this.acceptDiagnosticBaseline(snapshot);
    const authority = diagnosticAuthority(snapshot);
    if (authority !== diagnosticAuthority(current)) {
      if (this.retiredDiagnosticAuthorities.has(authority)) return;
      if (delivery === "update") await this.recoverDiagnosticBaseline();
      return;
    }
    if (snapshot.sequence <= current.sequence) return;
    this.diagnostic = snapshot;
    for (const listener of this.diagnosticSubscribers) listener(snapshot);
  }

  private acceptDiagnosticBaseline(snapshot: MobileDiagnosticSnapshotDto): void {
    if (this.disposed) return;
    const current = this.diagnostic;
    const authority = diagnosticAuthority(snapshot);
    if (this.retiredDiagnosticAuthorities.has(authority)) return;
    if (
      current &&
      diagnosticAuthority(current) === authority &&
      snapshot.sequence < current.sequence
    ) {
      return;
    }
    if (current && diagnosticAuthority(current) !== authority) {
      this.retiredDiagnosticAuthorities.add(diagnosticAuthority(current));
    }
    this.diagnostic = snapshot;
    for (const listener of this.diagnosticSubscribers) listener(snapshot);
  }

  private async recoverEventsBaseline(): Promise<void> {
    if (this.eventsRecovery) return this.eventsRecovery;
    this.connection = { ...this.connection, stale: true };
    this.publishConnection();
    this.eventsRecovery = this.fetchEvents()
      .then((snapshot) => this.acceptEventBaseline(snapshot))
      .finally(() => {
        this.eventsRecovery = undefined;
      });
    return this.eventsRecovery;
  }

  private async recoverDiagnosticBaseline(): Promise<void> {
    if (this.diagnosticRecovery) return this.diagnosticRecovery;
    this.diagnosticRecovery = this.fetchDiagnostic()
      .then((snapshot) => this.acceptDiagnosticBaseline(snapshot))
      .finally(() => {
        this.diagnosticRecovery = undefined;
      });
    return this.diagnosticRecovery;
  }

  private publishConnection(): void {
    for (const listener of this.connectionSubscribers) listener(this.connection);
  }

  private async fetchEvents(): Promise<EventsSnapshotDto> {
    return EventsSnapshotSchema.parse(await this.transport.invoke("get_events_snapshot"));
  }

  private async fetchDiagnostic(): Promise<MobileDiagnosticSnapshotDto> {
    return MobileDiagnosticSnapshotSchema.parse(
      await this.transport.invoke("get_diagnostic_snapshot"),
    );
  }
}

function eventAuthority(snapshot: EventsSnapshotDto): string {
  return `${snapshot.applicationOrder.authorityId}:${snapshot.applicationOrder.epoch}`;
}

function diagnosticAuthority(snapshot: MobileDiagnosticSnapshotDto): string {
  return `${snapshot.authorityId}:${snapshot.applicationOrder.epoch}`;
}
