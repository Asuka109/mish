import { PolicyGroupSchema, type PolicyGroupDto, type ProxyNodeDto } from "@mish/contracts";
import { describe, expect, it } from "vitest";
import { buildRouteGraph, createRouteSearchState, sortRouteChildIds } from "./routes-model";

const nodes: ProxyNodeDto[] = [
  { id: "slow", label: "Zulu", latencyMilliseconds: 180, protocol: "VLESS" },
  { id: "unknown", label: "Charlie", latencyMilliseconds: null, protocol: "Trojan" },
  { id: "fast", label: "Alpha", latencyMilliseconds: 38, protocol: "Hysteria2" },
  { id: "unicode", label: "台北・開発 🚄", latencyMilliseconds: 72, protocol: "TUIC" },
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
  });

  it("sorts each group's direct children without treating missing latency as zero", () => {
    const group = selector("root", ["slow", "unknown", "fast"]);
    const graph = buildRouteGraph([group], nodes);

    expect(sortRouteChildIds(graph, group, "configuration", "en")).toEqual([
      "slow",
      "unknown",
      "fast",
    ]);
    expect(sortRouteChildIds(graph, group, "latency", "en")).toEqual(["fast", "slow", "unknown"]);
    expect(sortRouteChildIds(graph, group, "label", "en")).toEqual(["fast", "unknown", "slow"]);
  });
});
