import type {
  EffectiveRuleDto,
  TrafficConnectionDto,
  TrafficDataSnapshotDto,
} from "@mish/contracts";
import { describe, expect, it } from "vitest";
import {
  clearClosedHistory,
  createTrafficHistoryState,
  filterConnections,
  filterRules,
  reconcileTrafficSnapshot,
  sortConnections,
  sortRules,
} from "./traffic-model";

function connection(
  id: string,
  overrides: Partial<TrafficConnectionDto> = {},
): TrafficConnectionDto {
  return {
    destinationHost: `${id}.fixture.invalid`,
    destinationIp: "198.51.100.1",
    destinationPort: 443,
    downloadBytes: "10",
    id,
    matchedRule: { payload: "fixture.invalid", type: "DomainSuffix" },
    network: "tcp",
    processName: "Fixture App",
    processPath: "/synthetic/fixture-app",
    protocol: "HTTP",
    providerChain: [],
    remoteDestination: null,
    routeChain: ["Fixture Group", "Fixture Exit"],
    sniffHost: null,
    sourceIp: "192.0.2.2",
    sourcePort: 50_000,
    startedAt: "2026-01-01T00:00:00Z",
    uploadBytes: "5",
    ...overrides,
  };
}

function snapshot(
  sequence: number,
  activeConnections: TrafficConnectionDto[],
  overrides: Partial<TrafficDataSnapshotDto> = {},
): TrafficDataSnapshotDto {
  return {
    activeConnections,
    adapterKind: "fixture",
    phase: "ready",
    profileId: "fixture-profile",
    reconnectCount: 0,
    rules: [],
    sequence,
    sessionId: "session-a",
    ...overrides,
  };
}

describe("Traffic closed history", () => {
  it("moves missing active rows into bounded local Closed history", () => {
    const now = new Date("2026-01-01T00:10:00Z");
    let state = reconcileTrafficSnapshot(
      createTrafficHistoryState(),
      snapshot(1, [connection("a"), connection("b")]),
      now,
      { maxAgeMilliseconds: 60_000, maxEntries: 1 },
    );
    state = reconcileTrafficSnapshot(state, snapshot(2, []), now, {
      maxAgeMilliseconds: 60_000,
      maxEntries: 1,
    });

    expect(state.closed).toHaveLength(1);
    expect(state.closed[0].id).toBe("a");
    expect(state.closed[0].closedAt).toBe(now.toISOString());
    expect(clearClosedHistory(state).closed).toEqual([]);
    expect(state.baseline?.connections.size).toBe(0);
  });

  it("expires old rows and never infers closure across stale or reconnected sessions", () => {
    const first = snapshot(1, [connection("a")]);
    let state = reconcileTrafficSnapshot(createTrafficHistoryState(), first);
    state = reconcileTrafficSnapshot(state, {
      ...first,
      phase: "stale",
      sequence: 2,
    });
    state = reconcileTrafficSnapshot(
      state,
      snapshot(3, [], {
        reconnectCount: 1,
        sessionId: "session-b",
      }),
    );
    expect(state.closed).toEqual([]);

    state = {
      ...state,
      closed: [{ ...connection("old"), closedAt: "2026-01-01T00:00:00Z" }],
    };
    state = reconcileTrafficSnapshot(
      state,
      snapshot(4, [], { reconnectCount: 1, sessionId: "session-b" }),
      new Date("2026-01-01T01:00:00Z"),
      { maxAgeMilliseconds: 1_000, maxEntries: 512 },
    );
    expect(state.closed).toEqual([]);
  });
});

describe("Traffic filters and stable sorting", () => {
  it("composes plain text with structured connection dimensions", () => {
    const values = [
      connection("one", {
        processName: "Fixture Browser",
        providerChain: ["Provider A", "东京 🚀", "Provider A"],
        routeChain: ["Fixture Media"],
      }),
      connection("two", { network: "udp", processName: null, routeChain: ["Fixture Direct"] }),
    ];
    expect(
      filterConnections(values, "process:browser chain:media state:active", "active", "all"),
    ).toEqual([values[0]]);
    expect(filterConnections(values, "destination:two network:udp", "active", "udp")).toEqual([
      values[1],
    ]);
    expect(filterConnections(values, "provider:东京", "active", "all")).toEqual([values[0]]);
    expect(values[0]?.providerChain).toEqual(["Provider A", "东京 🚀", "Provider A"]);
  });

  it("searches the normalized route chain without merging provider-chain labels", () => {
    const value = connection("isolated", {
      providerChain: ["Provider-only label"],
      routeChain: ["Front group", "Final exit"],
    });
    expect(filterConnections([value], "chain:front", "active", "all")).toEqual([value]);
    expect(filterConnections([value], "chain:provider-only", "active", "all")).toEqual([]);
    expect(filterConnections([value], "provider:provider-only", "active", "all")).toEqual([value]);
  });

  it("sorts exact decimal counters without losing stable ties", () => {
    const values = [
      connection("first", { downloadBytes: "9007199254740993" }),
      connection("second", { downloadBytes: "9007199254740993" }),
      connection("third", { downloadBytes: "9007199254740994" }),
    ];
    expect(sortConnections(values, "download-desc", "en").map((item) => item.id)).toEqual([
      "third",
      "first",
      "second",
    ]);
  });

  it("filters and sorts ordered rule reference data", () => {
    const rules: EffectiveRuleDto[] = [
      {
        enabled: true,
        hitCount: "10",
        lastHitAt: null,
        payload: "a",
        priority: 0,
        size: "-1",
        target: "Fixture A",
        type: "Domain",
      },
      {
        enabled: false,
        hitCount: null,
        lastHitAt: null,
        payload: "b",
        priority: 1,
        size: "-1",
        target: "Fixture B",
        type: "Match",
      },
    ];
    expect(filterRules(rules, "enabled:false target:fixture")).toEqual([rules[1]]);
    expect(sortRules(rules, "hits-desc", "en")).toEqual(rules);
  });
});
