import type { EventRecordDto, EventsSnapshotDto } from "@mish/contracts";
import { beforeAll, describe, expect, it } from "vitest";
import { presentEvent } from "../data/event-presentation";
import { i18nObject } from "../i18n/i18n-util";
import { loadAllLocales } from "../i18n/i18n-util.sync";
import {
  clearLocalEvents,
  createEventsBufferState,
  filterEvents,
  reconcileEventsSnapshot,
  selectDiagnosticConclusion,
  sortEvents,
} from "./events-model";

function event(sequence: number, overrides: Partial<EventRecordDto> = {}): EventRecordDto {
  return {
    application: null,
    evidence: { detail: null, message: `event ${sequence}` },
    id: `session-a:${sequence}`,
    level: "info",
    observedAt: 1_720_000_000_000 + sequence,
    sequence,
    source: "core",
    ...overrides,
  };
}

beforeAll(loadAllLocales);

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
  it("does not claim a healthy conclusion while a run is still active", () => {
    const conclusion = selectDiagnosticConclusion({
      adapterKind: "fixture",
      checks: [],
      finishedAt: null,
      id: "running",
      policy: {
        endpointLabel: "fixture",
        expectedHttpStatus: 204,
        id: "fixture",
        timeoutMilliseconds: 1,
      },
      profileId: null,
      startedAt: 1,
      status: "running",
    });

    expect(conclusion.kind).toBe("running");
  });

  it("prioritizes one actionable conclusion over an unstructured failure list", () => {
    const check = (
      kind: "capture" | "core" | "dns",
      failure: "capture-drift" | "core-unhealthy" | "dns-failed",
    ) => ({
      failure,
      finishedAt: 2,
      id: `run:${kind}`,
      interpretation: "fixture",
      kind,
      observedFact: { kind: "failure" as const, reason: "fixture" },
      routeTarget: { kind: "local-bridge" as const },
      scope: "fixture",
      startedAt: 1,
      status: "failed" as const,
    });
    const conclusion = selectDiagnosticConclusion({
      adapterKind: "fixture",
      checks: [
        check("dns", "dns-failed"),
        check("core", "core-unhealthy"),
        check("capture", "capture-drift"),
      ],
      finishedAt: 2,
      id: "run",
      policy: {
        endpointLabel: "fixture",
        expectedHttpStatus: 204,
        id: "fixture",
        timeoutMilliseconds: 1,
      },
      profileId: null,
      startedAt: 1,
      status: "completed",
    });

    expect(conclusion.kind).toBe("capture");
    expect(conclusion.evidence.map(({ kind }) => kind)).toEqual(["capture"]);
  });

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
      snapshot(
        1,
        [event(1, { evidence: { detail: null, message: "new session" }, id: "session-b:1" })],
        {
          profileId: "profile-a",
          reconnectCount: 1,
          sessionId: "session-b",
        },
      ),
    );
    expect(state.events.map(({ evidence }) => evidence?.message)).toEqual(["new session"]);

    state = reconcileEventsSnapshot(
      state,
      snapshot(
        1,
        [event(1, { evidence: { detail: null, message: "replacement" }, id: "runtime-c:1" })],
        {
          profileId: "profile-b",
          sessionId: "runtime-c",
        },
      ),
    );
    expect(state.events.map(({ evidence }) => evidence?.message)).toEqual(["replacement"]);

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
      event(1, {
        evidence: { detail: "dns fixture.invalid", message: "event 1" },
        level: "warning",
        source: "core",
      }),
      event(2, { evidence: { detail: null, message: "RPC connected" }, source: "rpc" }),
      event(3, {
        evidence: { detail: null, message: "DNS failed" },
        level: "error",
        source: "core",
      }),
    ].map((value) => presentEvent(value, i18nObject("en")));
    const filtered = filterEvents(values, "dns", new Set(["warning", "error"]), new Set(["core"]));
    expect(filtered.map(({ sequence }) => sequence)).toEqual([1, 3]);
    expect(sortEvents(filtered, "newest").map(({ sequence }) => sequence)).toEqual([3, 1]);
  });
});
