import type { ApplicationSnapshotOrderDto } from "@mish/contracts";

export type RpcSessionDelivery = "baseline" | "update" | "command" | "request";
export type RpcSessionTicketKind = "request" | "subscription";
export type RpcSessionAcceptanceKind = "accepted" | "duplicate" | "stale" | "conflict";

export interface RpcSessionSnapshot {
  applicationOrder: ApplicationSnapshotOrderDto;
}

export interface RpcSessionTicket {
  readonly kind: RpcSessionTicketKind;
  readonly sequence: number;
  readonly generation: number | null;
}

export type RpcSessionTraceEvent =
  | {
      kind: "generation";
      phase: "connected" | "disconnected";
      generation: number;
      baselinePending: boolean;
    }
  | {
      kind: "delivery";
      source: RpcSessionTicketKind;
      delivery: RpcSessionDelivery;
      generation: number;
      sequence: number;
      acceptance: RpcSessionAcceptanceKind;
    };

export interface RpcSessionAuthorityOptions {
  trace?: (event: RpcSessionTraceEvent) => void;
}

export interface RpcSessionRequestOptions {
  /**
   * Allows an adapter with a complete initial request snapshot to seed the
   * first observation before its connection callback has arrived. This is
   * deliberately one-shot and never reopens an existing generation.
   */
  bootstrap?: boolean;
}

export interface RpcSessionAcceptanceResult<T> {
  kind: RpcSessionAcceptanceKind;
  snapshot: T | null;
}

/**
 * Owns the client-side session boundary shared by RPC snapshot consumers.
 *
 * The wire client remains responsible for deadlines, request IDs, envelopes,
 * and schema validation. This module binds the resulting deliveries to one
 * transport generation and applies one baseline/order policy before a consumer
 * can project a snapshot.
 */
export class RpcSessionAuthority<T extends RpcSessionSnapshot> {
  private connected = false;
  private current: T | null = null;
  private disposed = false;
  private baselinePending = true;
  private reconnectPending = false;
  private transportGeneration = 0;
  private nextTicketSequence = 1;
  private readonly pendingTickets = new Set<RpcSessionTicket>();
  private readonly ticketGenerations = new WeakMap<object, number>();

  constructor(private readonly options: RpcSessionAuthorityOptions = {}) {}

  observeTransport(connected: boolean) {
    if (this.disposed) return;

    if (connected) {
      if (this.connected) return;
      this.connected = true;
      this.transportGeneration = increment(this.transportGeneration);
      for (const ticket of this.pendingTickets) {
        this.ticketGenerations.set(ticket, this.transportGeneration);
      }
      this.pendingTickets.clear();
      this.baselinePending = true;
      this.reconnectPending = this.current !== null;
      this.trace({
        baselinePending: this.baselinePending,
        generation: this.transportGeneration,
        kind: "generation",
        phase: "connected",
      });
      return;
    }

    if (!this.connected) return;
    this.connected = false;
    this.baselinePending = true;
    this.reconnectPending = this.current !== null;
    this.trace({
      baselinePending: this.baselinePending,
      generation: this.transportGeneration,
      kind: "generation",
      phase: "disconnected",
    });
  }

  beginRequest(options: RpcSessionRequestOptions = {}): RpcSessionTicket {
    if (options.bootstrap && !this.connected && this.transportGeneration === 0) {
      this.observeTransport(true);
    }
    return this.beginTicket("request");
  }

  beginSubscription(): RpcSessionTicket {
    return this.beginTicket("subscription");
  }

  accept(
    ticket: RpcSessionTicket,
    next: T,
    delivery: RpcSessionDelivery,
  ): RpcSessionAcceptanceResult<T> {
    const generation = this.resolveGeneration(ticket);
    if (generation === null || !this.connected || generation !== this.transportGeneration) {
      return this.recordDelivery(ticket, delivery, "stale");
    }

    const current = this.current;
    if (!current) {
      if (delivery === "update") return this.recordDelivery(ticket, delivery, "stale");
      return this.replace(ticket, delivery, next);
    }
    if (this.baselinePending && delivery === "update") {
      return this.recordDelivery(ticket, delivery, "stale");
    }

    const incoming = next.applicationOrder;
    const accepted = current.applicationOrder;
    if (incoming.authorityId !== accepted.authorityId) {
      if (
        delivery !== "baseline" &&
        !(this.reconnectPending && (delivery === "command" || delivery === "request"))
      ) {
        return this.recordDelivery(ticket, delivery, "stale");
      }
      return this.replace(ticket, delivery, next);
    }
    if (incoming.epoch < accepted.epoch) {
      return this.recordDelivery(ticket, delivery, "stale");
    }
    if (incoming.epoch > accepted.epoch) {
      return this.replace(ticket, delivery, next);
    }
    if (incoming.order < accepted.order) {
      return this.recordDelivery(ticket, delivery, "stale");
    }
    if (incoming.order > accepted.order) {
      return this.replace(ticket, delivery, next);
    }
    if (deepEqual(current, next)) {
      this.confirmBaseline();
      return this.recordDelivery(ticket, delivery, "duplicate");
    }
    return this.recordDelivery(ticket, delivery, "conflict");
  }

  clear() {
    this.current = null;
    this.baselinePending = true;
    this.reconnectPending = false;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.connected = false;
    this.baselinePending = true;
    this.reconnectPending = true;
    this.pendingTickets.clear();
  }

  getGeneration() {
    return this.transportGeneration;
  }

  isBaselinePending() {
    return this.baselinePending;
  }

  isReconnectPending() {
    return this.reconnectPending;
  }

  isStale() {
    return !this.connected || this.baselinePending;
  }

  snapshot() {
    return this.current;
  }

  private beginTicket(kind: RpcSessionTicketKind): RpcSessionTicket {
    const sequence = this.nextTicketSequence;
    this.nextTicketSequence = increment(this.nextTicketSequence);
    const ticket = {
      generation: this.connected ? this.transportGeneration : null,
      kind,
      sequence,
    };
    if (ticket.generation === null) this.pendingTickets.add(ticket);
    return ticket;
  }

  private resolveGeneration(ticket: RpcSessionTicket) {
    const boundGeneration = this.ticketGenerations.get(ticket);
    if (boundGeneration !== undefined) return boundGeneration;
    if (ticket.generation !== null) {
      this.ticketGenerations.set(ticket, ticket.generation);
      return ticket.generation;
    }
    if (!this.connected || this.transportGeneration === 0) return null;
    this.ticketGenerations.set(ticket, this.transportGeneration);
    return this.transportGeneration;
  }

  private replace(
    ticket: RpcSessionTicket,
    delivery: RpcSessionDelivery,
    next: T,
  ): RpcSessionAcceptanceResult<T> {
    this.current = structuredClone(next);
    this.confirmBaseline();
    return this.recordDelivery(ticket, delivery, "accepted", next);
  }

  private confirmBaseline() {
    this.baselinePending = false;
    this.reconnectPending = false;
  }

  private recordDelivery(
    ticket: RpcSessionTicket,
    delivery: RpcSessionDelivery,
    acceptance: RpcSessionAcceptanceKind,
    snapshot = this.current,
  ): RpcSessionAcceptanceResult<T> {
    this.trace({
      acceptance,
      delivery,
      generation: this.transportGeneration,
      kind: "delivery",
      sequence: ticket.sequence,
      source: ticket.kind,
    });
    return { kind: acceptance, snapshot };
  }

  private trace(event: RpcSessionTraceEvent) {
    this.options.trace?.(event);
  }
}

function increment(value: number) {
  if (!Number.isSafeInteger(value) || value >= Number.MAX_SAFE_INTEGER) {
    throw new RangeError("RPC session generation or ticket sequence exhausted");
  }
  return value + 1;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left !== typeof right || left === null || right === null) return false;
  if (typeof left !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  if (leftKeys.length !== rightKeys.length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      deepEqual(leftRecord[key], rightRecord[key]),
  );
}
