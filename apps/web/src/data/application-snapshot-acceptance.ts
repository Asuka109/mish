import type { ApplicationSnapshotDelivery, ApplicationSnapshotOrderDto } from "@mish/contracts";

export type SnapshotDelivery = ApplicationSnapshotDelivery | "command" | "request";
export type SnapshotAcceptanceKind = "accepted" | "duplicate" | "stale" | "conflict";

interface OrderedApplicationSnapshot {
  applicationOrder: ApplicationSnapshotOrderDto;
}

export interface SnapshotAcceptanceResult<T> {
  kind: SnapshotAcceptanceKind;
  snapshot: T;
}

export class ApplicationSnapshotAcceptance<T extends OrderedApplicationSnapshot> {
  private current: T | null = null;
  private reconnectPending = false;

  accept(next: T, delivery: SnapshotDelivery): SnapshotAcceptanceResult<T> {
    const current = this.current;
    if (!current) return this.replace(next);

    const incoming = next.applicationOrder;
    const accepted = current.applicationOrder;
    if (incoming.authorityId !== accepted.authorityId) {
      if (
        delivery === "baseline" ||
        (this.reconnectPending && (delivery === "command" || delivery === "request"))
      ) {
        return this.replace(next);
      }
      return { kind: "stale", snapshot: current };
    }
    if (incoming.epoch < accepted.epoch) return { kind: "stale", snapshot: current };
    if (incoming.epoch > accepted.epoch) return this.replace(next);
    if (incoming.order < accepted.order) return { kind: "stale", snapshot: current };
    if (incoming.order > accepted.order) return this.replace(next);
    if (deepEqual(current, next)) {
      this.reconnectPending = false;
      return { kind: "duplicate", snapshot: current };
    }
    return { kind: "conflict", snapshot: current };
  }

  armReconnect() {
    this.reconnectPending = true;
  }

  clear() {
    this.current = null;
    this.reconnectPending = false;
  }

  isReconnectPending() {
    return this.reconnectPending;
  }

  snapshot() {
    return this.current;
  }

  private replace(next: T): SnapshotAcceptanceResult<T> {
    this.current = structuredClone(next);
    this.reconnectPending = false;
    return { kind: "accepted", snapshot: next };
  }
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
