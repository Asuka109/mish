import type {
  GroupDelayChildResultDto,
  GroupDelayTestDto,
  PolicyGroupDto,
  ProxyNodeDto,
} from "@mish/contracts";

export type RouteSort = "configuration" | "latency" | "label";

export type RouteGraphErrorCode =
  | "cycle"
  | "duplicate-child"
  | "duplicate-entity"
  | "missing-child"
  | "selection-outside-group"
  | "terminal-has-children";

export interface RouteGraphError {
  code: RouteGraphErrorCode;
  childId?: string;
  entityId?: string;
  groupId?: string;
  path?: string[];
}

export interface RouteGraph {
  errors: RouteGraphError[];
  groupById: Map<string, PolicyGroupDto>;
  nodeById: Map<string, ProxyNodeDto>;
  rootGroupIds: string[];
}

export interface RouteSearchState {
  autoExpandedGroupIds: Set<string>;
  directMatchEntityIds: Set<string>;
  queryActive: boolean;
  visibleEntityIds: Set<string>;
}

function pushDuplicateErrors<T extends { id: string }>(
  entities: T[],
  seen: Set<string>,
  errors: RouteGraphError[],
) {
  for (const entity of entities) {
    if (seen.has(entity.id)) {
      errors.push({ code: "duplicate-entity", entityId: entity.id });
      continue;
    }
    seen.add(entity.id);
  }
}

function findCycles(groupById: Map<string, PolicyGroupDto>) {
  const errors: RouteGraphError[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  const path: string[] = [];

  function visit(groupId: string) {
    if (active.has(groupId)) {
      const cycleStart = path.indexOf(groupId);
      errors.push({
        code: "cycle",
        groupId,
        path: [...path.slice(cycleStart), groupId],
      });
      return;
    }
    if (visited.has(groupId)) return;

    visited.add(groupId);
    active.add(groupId);
    path.push(groupId);
    const group = groupById.get(groupId);
    for (const childId of group?.childIds ?? []) {
      if (groupById.has(childId)) visit(childId);
    }
    path.pop();
    active.delete(groupId);
  }

  for (const groupId of groupById.keys()) visit(groupId);
  return errors;
}

export function buildRouteGraph(groups: PolicyGroupDto[], nodes: ProxyNodeDto[]): RouteGraph {
  const errors: RouteGraphError[] = [];
  const groupIds = new Set<string>();
  const nodeIds = new Set<string>();
  pushDuplicateErrors(groups, groupIds, errors);
  pushDuplicateErrors(nodes, nodeIds, errors);

  for (const id of groupIds) {
    if (nodeIds.has(id)) errors.push({ code: "duplicate-entity", entityId: id });
  }

  const groupById = new Map(groups.map((group) => [group.id, group]));
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const referencedGroupIds = new Set<string>();

  for (const group of groups) {
    const childIds = new Set<string>();
    if ((group.type === "direct" || group.type === "reject") && group.childIds.length > 0) {
      errors.push({ code: "terminal-has-children", groupId: group.id });
    }

    for (const childId of group.childIds) {
      if (childIds.has(childId)) {
        errors.push({ code: "duplicate-child", childId, groupId: group.id });
        continue;
      }
      childIds.add(childId);
      if (!groupById.has(childId) && !nodeById.has(childId)) {
        errors.push({ code: "missing-child", childId, groupId: group.id });
      }
      if (groupById.has(childId)) referencedGroupIds.add(childId);
    }

    if (group.selectedChildId !== null && !childIds.has(group.selectedChildId)) {
      errors.push({
        childId: group.selectedChildId,
        code: "selection-outside-group",
        groupId: group.id,
      });
    }
  }

  errors.push(...findCycles(groupById));
  return {
    errors,
    groupById,
    nodeById,
    rootGroupIds: groups
      .filter((group) => !referencedGroupIds.has(group.id))
      .map((group) => group.id),
  };
}

function findSelectedLatency(
  graph: RouteGraph,
  group: PolicyGroupDto,
  visited: Set<string>,
): number | null {
  if (!group.selectedChildId || visited.has(group.id)) return null;
  const node = graph.nodeById.get(group.selectedChildId);
  if (node) return node.latencyMilliseconds;

  const childGroup = graph.groupById.get(group.selectedChildId);
  if (!childGroup) return null;
  visited.add(group.id);
  return findSelectedLatency(graph, childGroup, visited);
}

export function getRouteChildLatency(graph: RouteGraph, childId: string) {
  const node = graph.nodeById.get(childId);
  if (node) return node.latencyMilliseconds;
  const group = graph.groupById.get(childId);
  if (!group) return null;
  return findSelectedLatency(graph, group, new Set());
}

export function getGroupDelayResult(
  test: GroupDelayTestDto,
  groupId: string,
  childId: string,
): GroupDelayChildResultDto | undefined {
  if (test.groupId !== groupId || test.phase === "idle") return undefined;
  return test.children.find((result) => result.childId === childId);
}

function getRouteChildLabel(graph: RouteGraph, childId: string) {
  return graph.nodeById.get(childId)?.label ?? graph.groupById.get(childId)?.label ?? childId;
}

export function sortRouteChildIds(
  graph: RouteGraph,
  group: PolicyGroupDto,
  sort: RouteSort,
  locale: string,
  delayTest?: GroupDelayTestDto,
) {
  if (sort === "configuration") return [...group.childIds];

  const configuredIndex = new Map(group.childIds.map((childId, index) => [childId, index]));
  const collator = new Intl.Collator(locale, { numeric: true, sensitivity: "base" });
  return group.childIds.toSorted((firstId, secondId) => {
    if (sort === "label") {
      const byLabel = collator.compare(
        getRouteChildLabel(graph, firstId),
        getRouteChildLabel(graph, secondId),
      );
      return byLabel || configuredIndex.get(firstId)! - configuredIndex.get(secondId)!;
    }

    const firstResult = delayTest && getGroupDelayResult(delayTest, group.id, firstId);
    const secondResult = delayTest && getGroupDelayResult(delayTest, group.id, secondId);
    const firstFailed = firstResult?.phase === "failed" || firstResult?.phase === "cancelled";
    const secondFailed = secondResult?.phase === "failed" || secondResult?.phase === "cancelled";
    if (firstFailed !== secondFailed) return firstFailed ? 1 : -1;
    const firstLatency =
      firstResult?.phase === "success"
        ? firstResult.latencyMilliseconds
        : getRouteChildLatency(graph, firstId);
    const secondLatency =
      secondResult?.phase === "success"
        ? secondResult.latencyMilliseconds
        : getRouteChildLatency(graph, secondId);
    if (firstLatency === null && secondLatency !== null) return 1;
    if (firstLatency !== null && secondLatency === null) return -1;
    if (firstLatency !== null && secondLatency !== null && firstLatency !== secondLatency) {
      return firstLatency - secondLatency;
    }
    return configuredIndex.get(firstId)! - configuredIndex.get(secondId)!;
  });
}

export function createRouteSearchState(
  graph: RouteGraph,
  rawQuery: string,
  locale: string,
): RouteSearchState {
  const query = rawQuery.trim().toLocaleLowerCase(locale);
  const visibleEntityIds = new Set<string>();
  const autoExpandedGroupIds = new Set<string>();
  if (!query) {
    return {
      autoExpandedGroupIds,
      directMatchEntityIds: new Set(),
      queryActive: false,
      visibleEntityIds,
    };
  }

  const directMatches = new Set<string>();
  for (const group of graph.groupById.values()) {
    if (group.label.toLocaleLowerCase(locale).includes(query)) directMatches.add(group.id);
  }
  for (const node of graph.nodeById.values()) {
    if (node.label.toLocaleLowerCase(locale).includes(query)) directMatches.add(node.id);
  }

  const matchMemo = new Map<string, boolean>();
  const activeGroupIds = new Set<string>();
  function includeGroup(groupId: string): boolean {
    const memoized = matchMemo.get(groupId);
    if (memoized !== undefined) return memoized;
    if (activeGroupIds.has(groupId)) return false;
    const group = graph.groupById.get(groupId);
    if (!group) return false;

    activeGroupIds.add(groupId);
    let descendantMatches = false;
    for (const childId of group.childIds) {
      const childMatches = graph.groupById.has(childId)
        ? includeGroup(childId)
        : directMatches.has(childId);
      if (!childMatches) continue;
      descendantMatches = true;
      visibleEntityIds.add(childId);
    }

    const matches = directMatches.has(groupId) || descendantMatches;
    if (matches) visibleEntityIds.add(groupId);
    if (descendantMatches) autoExpandedGroupIds.add(groupId);
    activeGroupIds.delete(groupId);
    matchMemo.set(groupId, matches);
    return matches;
  }

  for (const groupId of graph.groupById.keys()) includeGroup(groupId);
  return {
    autoExpandedGroupIds,
    directMatchEntityIds: directMatches,
    queryActive: true,
    visibleEntityIds,
  };
}
