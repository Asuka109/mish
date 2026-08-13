import {
  MobileTrafficCommandResultSchema,
  TrafficDataSnapshotSchema,
  type ApplicationSnapshotDelivery,
  type ProcessIconResultDto,
  type TrafficClient,
  type TrafficCommandAuthorityDto,
  type TrafficCommandOperation,
  type TrafficCommandResultDto,
  type TrafficConnectionState,
  type TrafficDataSnapshotDto,
} from "@mish/contracts";
import { invoke } from "@tauri-apps/api/core";

const POLL_INTERVAL_MILLIS = 1_000;

interface MobileTrafficTransport {
  invoke(command: string, args?: Record<string, unknown>): Promise<unknown>;
  setInterval(callback: () => void, milliseconds: number): ReturnType<typeof setInterval>;
  clearInterval(interval: ReturnType<typeof setInterval>): void;
}

const defaultTransport: MobileTrafficTransport = {
  invoke: (command, args) => invoke(`plugin:mish-vpn|${command}`, args),
  setInterval,
  clearInterval,
};

export class MobileTrafficClient implements TrafficClient {
  private connection: TrafficConnectionState = { attempt: 0, phase: "connecting", stale: true };
  private readonly connectionListeners = new Set<(state: TrafficConnectionState) => void>();
  private disposed = false;
  private operationSequence = 0;
  private poll?: ReturnType<typeof setInterval>;
  private polling = false;
  private snapshot?: TrafficDataSnapshotDto;
  private readonly snapshotListeners = new Set<
    (snapshot: TrafficDataSnapshotDto, delivery?: ApplicationSnapshotDelivery | "command") => void
  >();

  constructor(private readonly transport: MobileTrafficTransport = defaultTransport) {}

  async closeAllActive(
    _authority: TrafficCommandAuthorityDto,
    options?: { signal?: AbortSignal },
  ): Promise<TrafficCommandResultDto> {
    return this.unsupported("close-all-active", options);
  }

  async closeConnection(
    authority: TrafficCommandAuthorityDto,
    connectionId: string,
    options: { operationId?: string; signal?: AbortSignal } = {},
  ): Promise<TrafficCommandResultDto> {
    if (options.signal?.aborted) return this.cancelledResult("close-connection");
    const current = this.snapshot ?? (await this.getSnapshot(options));
    const operationId =
      options.operationId ?? `mobile-traffic-${Date.now()}-${++this.operationSequence}`;
    const result = MobileTrafficCommandResultSchema.parse(
      await this.transport.invoke("close_traffic_connection", {
        request: {
          connectionId,
          operationId,
          profileId: authority.profileId,
          runtimeAuthorityId: current.applicationOrder.authorityId,
          sequence: authority.sequence,
          sessionId: authority.sessionId,
        },
      }),
    );
    if (result.operationId !== operationId) {
      throw new Error("Mobile Traffic operation identity mismatch");
    }
    this.acceptSnapshot(result.snapshot, "command");
    if (options.signal?.aborted) return this.cancelledResult("close-connection", result.snapshot);
    const { operationId: _operationId, ...sharedResult } = result;
    return sharedResult;
  }

  async closeFilteredVisible(
    _authority: TrafficCommandAuthorityDto,
    _connectionIds: string[],
    options?: { signal?: AbortSignal },
  ): Promise<TrafficCommandResultDto> {
    return this.unsupported("close-filtered-visible", options);
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.poll) this.transport.clearInterval(this.poll);
    this.poll = undefined;
    this.connection = { attempt: 0, phase: "disposed", stale: true };
    this.publishConnection();
    this.connectionListeners.clear();
    this.snapshotListeners.clear();
  }

  getConnectionState() {
    return { ...this.connection };
  }

  async getProcessIcon(_connectionId: string): Promise<ProcessIconResultDto> {
    return { dataUrl: null };
  }

  async getSnapshot(options: { signal?: AbortSignal } = {}): Promise<TrafficDataSnapshotDto> {
    if (options.signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    const snapshot = TrafficDataSnapshotSchema.parse(
      await this.transport.invoke("get_traffic_snapshot"),
    );
    if (options.signal?.aborted) throw new DOMException("Request cancelled", "AbortError");
    this.acceptSnapshot(snapshot, this.snapshot ? "request" : "baseline");
    return structuredClone(this.snapshot ?? snapshot);
  }

  subscribeConnection(listener: (state: TrafficConnectionState) => void) {
    this.connectionListeners.add(listener);
    listener(this.getConnectionState());
    return () => this.connectionListeners.delete(listener);
  }

  supportsCommand(command: TrafficCommandOperation) {
    return command === "close-connection";
  }

  subscribeSnapshots(
    listener: (
      snapshot: TrafficDataSnapshotDto,
      delivery?: ApplicationSnapshotDelivery | "command",
    ) => void,
  ) {
    this.snapshotListeners.add(listener);
    this.ensurePolling();
    return () => {
      this.snapshotListeners.delete(listener);
      if (this.snapshotListeners.size === 0 && this.poll) {
        this.transport.clearInterval(this.poll);
        this.poll = undefined;
      }
    };
  }

  private acceptSnapshot(
    snapshot: TrafficDataSnapshotDto,
    delivery: ApplicationSnapshotDelivery | "command" | "request",
  ) {
    if (this.disposed) return;
    const previous = this.snapshot;
    const sameAuthority =
      previous?.applicationOrder.authorityId === snapshot.applicationOrder.authorityId &&
      previous.applicationOrder.epoch === snapshot.applicationOrder.epoch;
    if (
      sameAuthority &&
      previous &&
      (snapshot.applicationOrder.order < previous.applicationOrder.order ||
        (snapshot.applicationOrder.order === previous.applicationOrder.order &&
          snapshot.sequence <= previous.sequence))
    ) {
      return;
    }
    this.snapshot = structuredClone(snapshot);
    this.connection = { attempt: 0, phase: "connected", stale: false };
    this.publishConnection();
    const publishedDelivery: ApplicationSnapshotDelivery | "command" =
      !previous || !sameAuthority ? "baseline" : delivery === "request" ? "update" : delivery;
    for (const listener of this.snapshotListeners) {
      listener(structuredClone(snapshot), publishedDelivery);
    }
  }

  private cancelledResult(
    operation: TrafficCommandOperation,
    snapshot = this.snapshot,
  ): TrafficCommandResultDto {
    if (!snapshot) throw new DOMException("Request cancelled", "AbortError");
    return {
      failure: "disconnected",
      operation,
      remainingConnectionIds: [],
      snapshot: structuredClone(snapshot),
      status: "failure",
      targetCount: 0,
    };
  }

  private ensurePolling() {
    if (this.poll || this.disposed) return;
    void this.pollOnce();
    this.poll = this.transport.setInterval(() => void this.pollOnce(), POLL_INTERVAL_MILLIS);
  }

  private async pollOnce() {
    if (this.polling || this.disposed) return;
    this.polling = true;
    try {
      await this.getSnapshot();
    } catch {
      this.connection = {
        attempt: this.connection.attempt + 1,
        phase: this.snapshot ? "reconnecting" : "connecting",
        stale: true,
      };
      this.publishConnection();
    } finally {
      this.polling = false;
    }
  }

  private publishConnection() {
    for (const listener of this.connectionListeners) listener(this.getConnectionState());
  }

  private async unsupported(
    operation: TrafficCommandOperation,
    options?: { signal?: AbortSignal },
  ): Promise<TrafficCommandResultDto> {
    const snapshot = await this.getSnapshot(options);
    return {
      failure: "unsupported",
      operation,
      remainingConnectionIds: [],
      snapshot,
      status: "failure",
      targetCount: 0,
    };
  }
}
