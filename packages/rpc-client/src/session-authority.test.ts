import { describe, expect, it } from "vitest";
import {
  RpcSessionAuthority,
  type RpcSessionSnapshot,
  type RpcSessionTraceEvent,
} from "./session-authority";

interface Snapshot extends RpcSessionSnapshot {
  value: string;
}

function snapshot(authorityId: string, epoch: number, order: number, value: string): Snapshot {
  return {
    applicationOrder: { authorityId, epoch, order },
    value,
  };
}

describe("RpcSessionAuthority", () => {
  it("binds deliveries to deterministic transport generations", () => {
    const events: RpcSessionTraceEvent[] = [];
    const authority = new RpcSessionAuthority<Snapshot>({ trace: (event) => events.push(event) });
    const firstRequest = authority.beginRequest();
    const delayedPreconnectRequest = authority.beginRequest();

    authority.observeTransport(true);
    expect(firstRequest.generation).toBeNull();
    expect(delayedPreconnectRequest.generation).toBeNull();
    expect(authority.getGeneration()).toBe(1);
    expect(authority.accept(firstRequest, snapshot("A", 1, 1, "A1"), "request").kind).toBe(
      "accepted",
    );

    const firstSubscription = authority.beginSubscription();
    expect(authority.accept(firstSubscription, snapshot("A", 1, 2, "A2"), "update").kind).toBe(
      "accepted",
    );

    authority.observeTransport(false);
    expect(authority.accept(firstSubscription, snapshot("A", 1, 3, "late A"), "update").kind).toBe(
      "stale",
    );

    authority.observeTransport(true);
    expect(authority.getGeneration()).toBe(2);
    expect(
      authority.accept(
        delayedPreconnectRequest,
        snapshot("A", 1, 99, "late preconnect response"),
        "request",
      ).kind,
    ).toBe("stale");
    const queuedSubscription = authority.beginSubscription();
    expect(
      authority.accept(queuedSubscription, snapshot("A", 1, 3, "queued A3"), "update").kind,
    ).toBe("stale");
    const replacementBaseline = authority.beginSubscription();
    expect(authority.accept(replacementBaseline, snapshot("B", 1, 1, "B1"), "baseline").kind).toBe(
      "accepted",
    );

    expect(
      authority.accept(firstRequest, snapshot("A", 1, 99, "late A response"), "request"),
    ).toMatchObject({ kind: "stale", snapshot: snapshot("B", 1, 1, "B1") });
    expect(
      events
        .filter((event) => event.kind === "generation")
        .map((event) => `${event.phase}:${event.generation}`),
    ).toEqual(["connected:1", "disconnected:1", "connected:2"]);
  });

  it("requires a baseline and centralizes stale, duplicate, and equal-order policy", () => {
    const authority = new RpcSessionAuthority<Snapshot>();
    authority.observeTransport(true);
    const subscription = authority.beginSubscription();

    expect(
      authority.accept(subscription, snapshot("A", 1, 1, "update before baseline"), "update"),
    ).toMatchObject({ kind: "stale", snapshot: null });
    expect(authority.accept(subscription, snapshot("A", 1, 1, "A1"), "baseline").kind).toBe(
      "accepted",
    );
    expect(authority.accept(subscription, snapshot("A", 1, 1, "A1"), "update").kind).toBe(
      "duplicate",
    );
    expect(
      authority.accept(subscription, snapshot("A", 1, 1, "conflicting equal order"), "update"),
    ).toMatchObject({ kind: "conflict", snapshot: snapshot("A", 1, 1, "A1") });
    expect(authority.accept(subscription, snapshot("A", 1, 2, "A2"), "update").kind).toBe(
      "accepted",
    );
    expect(authority.accept(subscription, snapshot("A", 1, 1, "late A1"), "request")).toMatchObject(
      { kind: "stale", snapshot: snapshot("A", 1, 2, "A2") },
    );
  });

  it("allows a replacement request only during a reconnect baseline window", () => {
    const authority = new RpcSessionAuthority<Snapshot>();
    authority.observeTransport(true);
    const initial = authority.beginSubscription();
    authority.accept(initial, snapshot("A", 1, 1, "A1"), "baseline");

    const sameGenerationRequest = authority.beginRequest();
    expect(authority.accept(sameGenerationRequest, snapshot("B", 1, 1, "B1"), "request").kind).toBe(
      "stale",
    );

    authority.observeTransport(false);
    authority.observeTransport(true);
    const reconnectRequest = authority.beginRequest();
    expect(authority.accept(reconnectRequest, snapshot("B", 1, 1, "B1"), "request").kind).toBe(
      "accepted",
    );
    expect(authority.isStale()).toBe(false);
  });
});
