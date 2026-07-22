import {
  PolicyGroupSchema,
  type GroupDelayTestDto,
  type PolicyGroupDto,
  type ProxyNodeDto,
} from "@mish/contracts";
import { describe, expect, it } from "vitest";
import {
  POLICY_ENTITY_BATCH_SIZE,
  buildRouteGraph,
  createRouteSearchState,
  filterDirectPolicyChildIds,
  getBoundedPolicyEntityIds,
  normalizeMeasuredLatency,
  sortRouteChildIds,
} from "./routes-model";

const nodes: ProxyNodeDto[] = [
  { id: "slow", label: "Zulu", latencyMilliseconds: 180, protocol: "VLESS" },
  { id: "unknown", label: "Charlie", latencyMilliseconds: null, protocol: "Trojan" },
  { id: "fast", label: "Alpha", latencyMilliseconds: 38, protocol: "Hysteria2" },
  { id: "unicode", label: "台北・開発 🚄", latencyMilliseconds: 72, protocol: "TUIC" },
  { id: "zero", label: "Zero is unknown", latencyMilliseconds: 0, protocol: "SS" },
];

function selector(
  id: string,
  childIds: string[],
  selectedChildId = childIds[0] ?? "missing",
): PolicyGroupDto {
  return { childIds, id, label: id, selectedChildId, type: "selector" };
}

describe("Routes graph model", () => {
  it("keeps the legacy selector payload and accepts every extended group type", () => {
    expect(
      PolicyGroupSchema.parse({
        childIds: ["fast"],
        id: "legacy",
        label: "Legacy selector",
        selectedChildId: "fast",
        type: "selector",
      }),
    ).toEqual({
      childIds: ["fast"],
      id: "legacy",
      label: "Legacy selector",
      selectedChildId: "fast",
      type: "selector",
    });

    for (const type of [
      "url-test",
      "fallback",
      "load-balance",
      "relay",
      "direct",
      "reject",
    ] as const) {
      expect(
        PolicyGroupSchema.safeParse({
          childIds: [],
          id: type,
          label: type,
          selectedChildId: null,
          type,
        }).success,
      ).toBe(true);
    }
    expect(
      PolicyGroupSchema.safeParse({
        childIds: [],
        id: "future",
        label: "Future group",
        selectedChildId: null,
        type: "unsupported",
        unsupportedType: "future-strategy",
      }).success,
    ).toBe(true);
  });

  it("preserves nested group relationships and derives only graph roots", () => {
    const groups: PolicyGroupDto[] = [
      selector("root", ["nested", "slow"], "nested"),
      {
        childIds: ["fast"],
        id: "nested",
        label: "Nested",
        selectedChildId: "fast",
        type: "url-test",
      },
    ];
    const graph = buildRouteGraph(groups, nodes);

    expect(graph.errors).toEqual([]);
    expect(graph.rootGroupIds).toEqual(["root"]);
    expect(graph.groupById.get("root")?.childIds).toEqual(["nested", "slow"]);
    expect(graph.groupById.get("nested")?.childIds).toEqual(["fast"]);
  });

  it("rejects cycles, missing children, duplicates, invalid selections, and terminal children", () => {
    const groups: PolicyGroupDto[] = [
      selector("a", ["b", "b", "missing"], "outside"),
      { childIds: ["a"], id: "b", label: "b", selectedChildId: "a", type: "fallback" },
      {
        childIds: ["fast"],
        id: "terminal",
        label: "terminal",
        selectedChildId: null,
        type: "direct",
      },
    ];
    const graph = buildRouteGraph(groups, [...nodes, { ...nodes[0] }]);

    expect(new Set(graph.errors.map((error) => error.code))).toEqual(
      new Set([
        "cycle",
        "duplicate-child",
        "duplicate-entity",
        "missing-child",
        "selection-outside-group",
        "terminal-has-children",
      ]),
    );
  });

  it("matches complete Unicode labels while retaining and expanding their ancestors", () => {
    const groups: PolicyGroupDto[] = [
      selector("root", ["nested"], "nested"),
      {
        childIds: ["unicode"],
        id: "nested",
        label: "東京 🌏",
        selectedChildId: "unicode",
        type: "url-test",
      },
    ];
    const graph = buildRouteGraph(groups, nodes);
    const search = createRouteSearchState(graph, "開発 🚄", "zh-CN");

    expect(search.visibleEntityIds).toEqual(new Set(["unicode", "nested", "root"]));
    expect(search.autoExpandedGroupIds).toEqual(new Set(["nested", "root"]));
    expect(search.matchPathByEntityId.get("unicode")).toEqual(["root", "nested", "unicode"]);
  });

  it("matches node protocols and policy group types globally but scopes picker search to direct children", () => {
    const nested = {
      childIds: ["unicode"],
      id: "nested",
      label: "Automatic",
      selectedChildId: "unicode",
      type: "url-test" as const,
    };
    const root = selector("root", ["fast", "nested"], "fast");
    const graph = buildRouteGraph([root, nested], nodes);

    expect(createRouteSearchState(graph, "tuic", "en").visibleEntityIds).toEqual(
      new Set(["unicode", "nested", "root"]),
    );
    expect(createRouteSearchState(graph, "url-test", "en").directMatchEntityIds).toContain(
      "nested",
    );
    expect(filterDirectPolicyChildIds(graph, root, "tuic", "en")).toEqual([]);
    expect(filterDirectPolicyChildIds(graph, nested, "tuic", "en")).toEqual(["unicode"]);
  });

  it("sorts each group's direct children without treating missing latency as zero", () => {
    const group = selector("root", ["slow", "zero", "unknown", "fast"]);
    const graph = buildRouteGraph([group], nodes);

    expect(sortRouteChildIds(graph, group, "configuration", "en")).toEqual([
      "slow",
      "zero",
      "unknown",
      "fast",
    ]);
    expect(sortRouteChildIds(graph, group, "latency", "en")).toEqual([
      "fast",
      "slow",
      "zero",
      "unknown",
    ]);
    expect(sortRouteChildIds(graph, group, "label", "en")).toEqual([
      "fast",
      "unknown",
      "zero",
      "slow",
    ]);
    expect(normalizeMeasuredLatency(0)).toBeNull();
    expect(normalizeMeasuredLatency(-1)).toBeNull();
    expect(normalizeMeasuredLatency(38)).toBe(38);
  });

  it("freezes latency ordering while a delay test is active and applies results only on completion", () => {
    const group = selector("root", ["slow", "unknown", "fast"]);
    const graph = buildRouteGraph([group], nodes);
    const activeTest: GroupDelayTestDto = {
      children: [
        {
          childId: "slow",
          failure: null,
          latencyMilliseconds: 1,
          observedAt: 1,
          phase: "success",
        },
      ],
      finishedAt: null,
      groupId: "root",
      phase: "progress",
      profileId: "profile",
      startedAt: 1,
      testId: "active",
    };

    expect(sortRouteChildIds(graph, group, "latency", "en", activeTest)).toEqual([
      "fast",
      "slow",
      "unknown",
    ]);
    expect(
      sortRouteChildIds(graph, group, "latency", "en", {
        ...activeTest,
        finishedAt: 2,
        phase: "completed",
      }),
    ).toEqual(["slow", "fast", "unknown"]);
  });

  it("sorts current successful measurements first and failed or timed-out results last", () => {
    const group = selector("root", ["slow", "unknown", "fast"]);
    const graph = buildRouteGraph([group], nodes);
    const test: GroupDelayTestDto = {
      children: [
        {
          childId: "slow",
          failure: "timeout",
          latencyMilliseconds: null,
          observedAt: 1_720_000_000_001,
          phase: "failed",
        },
        {
          childId: "unknown",
          failure: null,
          latencyMilliseconds: 24,
          observedAt: 1_720_000_000_002,
          phase: "success",
        },
        {
          childId: "fast",
          failure: null,
          latencyMilliseconds: 91,
          observedAt: 1_720_000_000_003,
          phase: "success",
        },
      ],
      finishedAt: 1_720_000_000_004,
      groupId: "root",
      phase: "partial",
      profileId: "profile",
      startedAt: 1_720_000_000_000,
      testId: "test",
    };

    expect(sortRouteChildIds(graph, group, "latency", "en", test)).toEqual([
      "unknown",
      "fast",
      "slow",
    ]);
  });

  it("searches an 8,192-child group across the full data set while exposing 100-row batches", () => {
    const largeNodes = Array.from(
      { length: 8_192 },
      (_, index): ProxyNodeDto => ({
        id: `large-${index + 1}`,
        label: index === 8_191 ? "末尾 Upper-bound target" : `Upper-bound node ${index + 1}`,
        latencyMilliseconds: index % 3 === 0 ? index + 1 : null,
        protocol: index % 2 === 0 ? "VLESS" : "Trojan",
      }),
    );
    const group = selector(
      "large-root",
      largeNodes.map((node) => node.id),
    );
    const startedAt = performance.now();
    const graph = buildRouteGraph([group], largeNodes);
    const matches = filterDirectPolicyChildIds(graph, group, "末尾", "zh-CN");

    expect(graph.errors).toEqual([]);
    expect(matches).toEqual(["large-8192"]);
    expect(getBoundedPolicyEntityIds(group.childIds, POLICY_ENTITY_BATCH_SIZE)).toHaveLength(100);
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });
});
