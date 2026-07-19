import type { EventRecordDto, EventsSnapshotDto } from "@mish/contracts";
import { describe, expect, it } from "vitest";
import {
  clearLocalEvents,
  createEventsBufferState,
  filterEvents,
  reconcileEventsSnapshot,
  sortEvents,
} from "./events-model";

function event(sequence: number, overrides: Partial<EventRecordDto> = {}): EventRecordDto {
  return {
    detail: null,
    id: `session-a:${sequence}`,
    level: "info",
    message: `event ${sequence}`,
    observedAt: 1_720_000_000_000 + sequence,
    sequence,
    source: "core",
    ...overrides,
  };
}

function snapshot(
  sequence: number,
  events: EventRecordDto[],
  overrides: Partial<EventsSnapshotDto> = {},
): EventsSnapshotDto {
  return {
    adapterKind: "fixture",
    events,
    phase: "ready",
    profileId: "profile-a",
    reconnectCount: 0,
    sequence,
    sessionId: "session-a",
    sourceStatuses: ["application", "core", "platform", "rpc"].map((source) => ({
      detail: null,
      phase: source === "core" ? ("ready" as const) : ("unavailable" as const),
      source: source as "application" | "core" | "platform" | "rpc",
    })),
    ...overrides,
  };
}

describe("Events local buffer", () => {
  it("keeps a stable bounded order and clear only affects the local view", () => {
    let state = reconcileEventsSnapshot(
      createEventsBufferState(),
      snapshot(3, [event(3), event(1), event(2)]),
      2,
    );
    expect(state.events.map(({ sequence }) => sequence)).toEqual([2, 3]);

    state = clearLocalEvents(state);
    expect(state.events).toEqual([]);
    state = reconcileEventsSnapshot(state, snapshot(3, [event(1), event(2), event(3)]), 2);
    expect(state.events).toEqual([]);

    state = reconcileEventsSnapshot(state, snapshot(4, [event(2), event(3), event(4)]), 2);
    expect(state.events.map(({ sequence }) => sequence)).toEqual([4]);
  });

  it("replaces rather than concatenates sessions and profile/runtime replacements", () => {
    let state = reconcileEventsSnapshot(createEventsBufferState(), snapshot(1, [event(1)]));
    state = reconcileEventsSnapshot(
      state,
      snapshot(1, [event(1, { id: "session-b:1", message: "new session" })], {
        profileId: "profile-a",
        reconnectCount: 1,
        sessionId: "session-b",
      }),
    );
    expect(state.events.map(({ message }) => message)).toEqual(["new session"]);

    state = reconcileEventsSnapshot(
      state,
      snapshot(1, [event(1, { id: "runtime-c:1", message: "replacement" })], {
        profileId: "profile-b",
        sessionId: "runtime-c",
      }),
    );
    expect(state.events.map(({ message }) => message)).toEqual(["replacement"]);

    state = reconcileEventsSnapshot(
      state,
      snapshot(0, [], {
        phase: "connecting",
        profileId: "profile-b",
        sessionId: null,
      }),
    );
    expect(state.events).toEqual([]);
    expect(state.sessionId).toBeNull();
  });

  it("composes text, level, and source filters with stable order switching", () => {
    const values = [
      event(1, { detail: "dns fixture.invalid", level: "warning", source: "core" }),
      event(2, { message: "RPC connected", source: "rpc" }),
      event(3, { level: "error", message: "DNS failed", source: "core" }),
    ];
    const filtered = filterEvents(values, "dns", new Set(["warning", "error"]), new Set(["core"]));
    expect(filtered.map(({ sequence }) => sequence)).toEqual([1, 3]);
    expect(sortEvents(filtered, "newest").map(({ sequence }) => sequence)).toEqual([3, 1]);
  });
});
