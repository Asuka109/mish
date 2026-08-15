import type { Correlation, DomainContext } from "./shared.ts";

export interface SnapshotContext extends DomainContext {
  readonly acceptedSnapshotRevision: number;
}

export type SnapshotEvent = {
  readonly type: "SNAPSHOT";
  readonly generation: number;
  readonly revision: number;
  readonly effectId?: number;
};

export type SessionBoundaryEvent =
  | { readonly type: "CONNECT"; readonly operation?: number }
  | { readonly type: "DISCONNECT" }
  | { readonly type: "RECONNECT"; readonly operation?: number }
  | { readonly type: "REFRESH" }
  | { readonly type: "CANCEL" }
  | { readonly type: "RETRY" }
  | { readonly type: "DISPOSE" }
  | ({ readonly type: "STALE_COMPLETION" } & Correlation);

export const snapshotContext = (context: DomainContext): SnapshotContext => ({
  ...context,
  acceptedSnapshotRevision: 0,
});

export const snapshotIsNewer = (context: SnapshotContext, event: SnapshotEvent): boolean =>
  event.generation === context.generation && event.revision > context.acceptedSnapshotRevision;

export const snapshotResult = (
  context: SnapshotContext,
  event: SnapshotEvent,
): "stale" | "equal" | "duplicate" => {
  if (
    event.generation !== context.generation ||
    event.revision < context.acceptedSnapshotRevision
  ) {
    return "stale";
  }
  if (
    event.revision === context.acceptedSnapshotRevision &&
    event.effectId !== undefined &&
    event.effectId === context.effectId
  ) {
    return "duplicate";
  }
  return "equal";
};
