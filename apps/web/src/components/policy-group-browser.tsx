import type {
  GroupDelayChildResultDto,
  GroupDelayTestDto,
  PolicyGroupDto,
  PolicyGroupType,
} from "@mish/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";
import { notificationPublication, useNotificationDelivery } from "../data/notification-delivery";
import { useProduct } from "../data/product-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";
import {
  filterDirectPolicyChildIds,
  getGroupDelayResult,
  getRouteChildLatency,
  sortRouteChildIds,
  type RouteGraph,
  type RouteSort,
} from "../pages/routes-model";
import {
  BoundedEntityList,
  LatencyStatus,
  PolicyBrowserToolbar,
  PolicyEntityRow,
  type PolicyBrowserDensity,
} from "./policy-browser";

const routeSorts: RouteSort[] = ["configuration", "latency", "label"];

export function usePolicyGroupBrowserSession() {
  const [sortByGroupId, setSortByGroupId] = useState<Map<string, RouteSort>>(() => new Map());
  return {
    setSort(groupId: string, sort: RouteSort) {
      setSortByGroupId((current) => new Map(current).set(groupId, sort));
    },
    sortFor(groupId: string) {
      return sortByGroupId.get(groupId) ?? "configuration";
    },
  };
}

interface PolicyGroupSelectionOptions {
  commandsDisabled?: boolean;
  graph: RouteGraph;
  group: PolicyGroupDto | null;
  onSelectionConfirmed?(): void;
}

export function usePolicyGroupSelection({
  commandsDisabled = false,
  graph,
  group,
  onSelectionConfirmed,
}: PolicyGroupSelectionOptions) {
  const { isGroupCommandPending, isCommandSupported, selectGroupChild, snapshot } = useProduct();
  const { LL } = useI18nContext();
  const { publish } = useNotificationDelivery();
  const [pendingSelectionId, setPendingSelectionId] = useState<string | null>(null);
  const selectionDisabled = !group || commandsDisabled || !isCommandSupported("group");
  const selectionDisabledReason =
    snapshot?.groupSelectionAvailability === "core-not-running" ||
    (selectionDisabled && snapshot?.runtime.phase === "inactive")
      ? LL.routes.selectionRequiresRunningProxy()
      : undefined;
  const selectionPending = group ? isGroupCommandPending(group.id) : false;

  useEffect(() => {
    setPendingSelectionId(null);
  }, [group?.id]);

  const selectChild = useCallback(
    async (childId: string) => {
      if (!group || selectionDisabled || isGroupCommandPending(group.id)) return;
      setPendingSelectionId(childId);
      const result = await selectGroupChild(group.id, childId);
      setPendingSelectionId(null);
      if (result.ok) {
        const cleanup = result.snapshot?.groupSelectionOperation;
        if (cleanup && cleanup.cleanupPhase !== "idle") {
          publish(
            notificationPublication("route.old-child-cleanup", {
              data: {
                catalogRevision: cleanup.catalogRevision,
                closedCount: cleanup.closedCount,
                controllerSessionRevision: cleanup.controllerSessionRevision,
                failedCount: cleanup.failedCount,
                failure: cleanup.cleanupFailure ?? undefined,
                membershipRevision: cleanup.membershipRevision,
                mode: cleanup.cleanupMode,
                phase: cleanup.cleanupPhase,
                targetCount: cleanup.targetCount,
              },
              dedupeKey: "route.old-child-cleanup",
              severity:
                cleanup.cleanupPhase === "completed"
                  ? "success"
                  : cleanup.cleanupPhase === "skipped"
                    ? "info"
                    : cleanup.cleanupPhase === "partial"
                      ? "warning"
                      : "error",
            }),
          );
        }
        onSelectionConfirmed?.();
        return;
      }
      if (result.error.code === "core-not-running") return;
      publish(
        notificationPublication("route.selection-failed", {
          data: {
            child:
              graph.nodeById.get(childId)?.label ?? graph.groupById.get(childId)?.label ?? childId,
          },
          severity: "error",
        }),
      );
      requestAnimationFrame(() => {
        document
          .querySelector<HTMLElement>('[data-entity-id="' + CSS.escape(childId) + '"]')
          ?.querySelector<HTMLElement>("[data-policy-row-primary]")
          ?.focus({ preventScroll: true });
      });
    },
    [
      graph,
      group,
      isGroupCommandPending,
      onSelectionConfirmed,
      publish,
      selectGroupChild,
      selectionDisabled,
    ],
  );

  return {
    pendingSelectionId,
    selectChild,
    selectionDisabled,
    selectionDisabledReason,
    selectionPending,
  };
}

function getSortLabel(LL: TranslationFunctions, sort: RouteSort) {
  if (sort === "configuration") return LL.routes.configurationOrder();
  if (sort === "latency") return LL.routes.latency();
  return LL.routes.labelOrder();
}

function getDelayFailureLabel(LL: TranslationFunctions, result: GroupDelayChildResultDto) {
  switch (result.failure) {
    case "timeout":
      return LL.routes.delayTimeout();
    case "stale-membership":
      return LL.routes.delayStaleMembership();
    case "disconnected":
      return LL.routes.delayDisconnected();
    case "version-drift":
      return LL.routes.delayVersionDrift();
    case "inconsistent-observation":
      return LL.routes.delayInconsistent();
    case "cancelled":
      return LL.routes.delayCancelled();
    default:
      return LL.routes.delayUnavailable();
  }
}

function getDelayPhaseLabel(LL: TranslationFunctions, test: GroupDelayTestDto) {
  switch (test.phase) {
    case "pending":
      return LL.routes.delayPhasePending();
    case "progress":
      return LL.routes.delayPhaseProgress();
    case "cancelled":
      return LL.routes.delayPhaseCancelled();
    case "completed":
      return LL.routes.delayPhaseCompleted();
    case "partial":
      return LL.routes.delayPhasePartial();
    case "failed":
      return LL.routes.delayPhaseFailed();
    default:
      return "";
  }
}

export function getPolicyGroupTypeLabel(LL: TranslationFunctions, group: PolicyGroupDto) {
  if (group.type === "unsupported") {
    return LL.routes.groupType.unsupported({ type: group.unsupportedType });
  }
  const labels: Record<Exclude<PolicyGroupType, "unsupported">, string> = {
    direct: LL.routes.groupType.direct(),
    fallback: LL.routes.groupType.fallback(),
    "load-balance": LL.routes.groupType.loadBalance(),
    reject: LL.routes.groupType.reject(),
    relay: LL.routes.groupType.relay(),
    selector: LL.routes.groupType.selector(),
    "url-test": LL.routes.groupType.urlTest(),
  };
  return labels[group.type];
}

interface PolicyGroupBrowserProps {
  childBrowseLabel?(childId: string): string;
  childBrowseTo?(childId: string): string | undefined;
  commandsDisabled?: boolean;
  density?: PolicyBrowserDensity;
  emptyClassName?: string;
  emptyLabel: string;
  graph: RouteGraph;
  group: PolicyGroupDto;
  listClassName?: string;
  mobile?: boolean;
  onQueryChange(query: string): void;
  onSelectionConfirmed?(): void;
  onSortChange(sort: RouteSort): void;
  query: string;
  searchLabel: string;
  searchPlaceholder: string;
  sort: RouteSort;
}

export function PolicyGroupBrowser({
  childBrowseLabel,
  childBrowseTo,
  commandsDisabled = false,
  density = "compact",
  emptyClassName,
  emptyLabel,
  graph,
  group,
  listClassName,
  mobile = false,
  onQueryChange,
  onSelectionConfirmed,
  onSortChange,
  query,
  searchLabel,
  searchPlaceholder,
  sort,
}: PolicyGroupBrowserProps) {
  const {
    cancelGroupDelayTest,
    isCommandPending,
    isCommandSupported,
    snapshot,
    startGroupDelayTest,
  } = useProduct();
  const { LL, locale } = useI18nContext();
  const [delayBusy, setDelayBusy] = useState(false);
  const [frozenDelayOrder, setFrozenDelayOrder] = useState<{
    childIds: readonly string[];
    groupId: string;
  } | null>(null);
  const language = locale === "zh" ? "zh-CN" : "en";
  const delayTest = snapshot?.groupDelayTest;
  const selection = usePolicyGroupSelection({
    commandsDisabled,
    graph,
    group,
    onSelectionConfirmed,
  });

  useEffect(() => {
    setFrozenDelayOrder(null);
  }, [group.id]);

  useEffect(() => {
    if (delayTest?.phase !== "pending" && delayTest?.phase !== "progress") {
      setFrozenDelayOrder(null);
    }
  }, [delayTest?.phase]);

  const directChildIds = useMemo(() => {
    const filtered = filterDirectPolicyChildIds(graph, group, query, language);
    const filteredSet = new Set(filtered);
    const sortedIds =
      frozenDelayOrder?.groupId === group.id &&
      delayTest?.groupId === group.id &&
      (delayTest.phase === "pending" || delayTest.phase === "progress")
        ? [...frozenDelayOrder.childIds]
        : sortRouteChildIds(graph, group, sort, language, delayTest);
    return sortedIds.filter((childId) => filteredSet.has(childId));
  }, [delayTest, frozenDelayOrder, graph, group, language, query, sort]);

  if (!snapshot || !delayTest) return null;

  const delayIsActive = delayTest.phase === "pending" || delayTest.phase === "progress";
  const delayMatchesGroup = delayTest.groupId === group.id;
  const delayActiveForGroup = delayIsActive && delayMatchesGroup;
  const activeDelayGroup = delayTest.groupId
    ? (graph.groupById.get(delayTest.groupId)?.label ?? delayTest.groupId)
    : "";
  const completedDelayChildren = delayMatchesGroup
    ? delayTest.children.filter((child) => child.phase !== "pending").length
    : 0;
  const selectionDisabled = selection.selectionDisabled;
  const selectionPending = selection.selectionPending;
  const delayDisabled = commandsDisabled || !isCommandSupported("group-delay");
  const delayProgress =
    delayMatchesGroup && delayTest.phase !== "idle"
      ? LL.routes.delayStateProgress({
          completed: completedDelayChildren,
          state: getDelayPhaseLabel(LL, delayTest),
          total: delayTest.children.length,
        })
      : delayIsActive
        ? LL.routes.delayTestingGroup({ group: activeDelayGroup })
        : snapshot.groupDelayPolicy.url
          ? LL.routes.delayPolicy({ url: snapshot.groupDelayPolicy.url })
          : null;

  async function startDelay() {
    setFrozenDelayOrder({
      childIds: sortRouteChildIds(graph, group, sort, language, delayTest),
      groupId: group.id,
    });
    setDelayBusy(true);
    try {
      await startGroupDelayTest(group.id);
    } finally {
      setDelayBusy(false);
    }
  }

  async function cancelDelay() {
    const testId = delayTest?.testId;
    if (!delayActiveForGroup || !testId) return;
    setDelayBusy(true);
    try {
      await cancelGroupDelayTest(testId);
    } finally {
      setDelayBusy(false);
    }
  }

  return (
    <>
      <PolicyBrowserToolbar
        cancelAriaLabel={LL.routes.cancelDelay({ group: group.label })}
        cancelLabel={LL.routes.cancelDelayButton()}
        delayActive={delayActiveForGroup}
        delayBusy={delayBusy || isCommandPending("group-delay")}
        delayDisabled={delayDisabled || delayIsActive || group.childIds.length === 0}
        delayProgress={delayProgress}
        mobile={mobile}
        onCancel={() => void cancelDelay()}
        onQueryChange={onQueryChange}
        onSortChange={onSortChange}
        onTest={() => void startDelay()}
        query={query}
        searchLabel={searchLabel}
        searchPlaceholder={searchPlaceholder}
        sort={sort}
        sortDisabled={delayActiveForGroup}
        sortLabel={LL.routes.sortChildren({ group: group.label })}
        sortOptionLabel={(option) => getSortLabel(LL, option)}
        sorts={routeSorts}
        testAriaLabel={LL.routes.startDelay({ group: group.label })}
        testLabel={LL.routes.startDelayButton()}
      />
      <span aria-live="polite" className="sr-only" role="status">
        {LL.routes.searchResultCount({ count: directChildIds.length })}
      </span>
      <div className={listClassName}>
        <BoundedEntityList
          empty={<p className={emptyClassName}>{emptyLabel}</p>}
          ids={directChildIds}
          key={`${group.id}:${query}`}
          loadedAnnouncement={(added, total) => LL.routes.loadedMore({ added, total })}
          showMoreLabel={(remaining) => LL.routes.showMore({ count: Math.min(100, remaining) })}
        >
          {(visibleIds) =>
            visibleIds.map((childId) => {
              const childGroup = graph.groupById.get(childId);
              const node = graph.nodeById.get(childId);
              const entity = childGroup ?? node;
              if (!entity) return null;
              const canSelectNode = group.type === "selector" && Boolean(node);
              const canSelectGroup = group.type === "selector" && childGroup?.type === "selector";
              return (
                <li key={childId}>
                  <PolicyEntityRow
                    automaticLabel={LL.routes.automaticSelection()}
                    browseLabel={childBrowseLabel?.(childId)}
                    browseTo={childBrowseTo?.(childId)}
                    currentLabel={LL.routes.selected()}
                    density={density}
                    disabled={selectionDisabled || selectionPending}
                    disabledReason={selection.selectionDisabledReason}
                    entity={entity}
                    entityKind={childGroup ? "group" : "node"}
                    latency={
                      <LatencyStatus
                        cancelledLabel={LL.routes.delayCancelled()}
                        failureLabel={(result) => getDelayFailureLabel(LL, result)}
                        latencyMilliseconds={
                          node?.latencyMilliseconds ?? getRouteChildLatency(graph, childId)
                        }
                        measuredLabel={(latency) => LL.routes.latencyMilliseconds({ latency })}
                        result={getGroupDelayResult(delayTest, group.id, childId)}
                        testingLabel={LL.routes.delayPending()}
                      />
                    }
                    metadata={
                      node?.protocol ??
                      LL.routes.groupReferenceType({
                        type: childGroup ? getPolicyGroupTypeLabel(LL, childGroup) : "",
                      })
                    }
                    muted={selectionDisabled}
                    onSelect={
                      canSelectNode || canSelectGroup
                        ? () => void selection.selectChild(childId)
                        : undefined
                    }
                    pendingLabel={LL.routes.switching()}
                    readOnlyPresentation={group.type === "selector" ? "explicit" : "passive"}
                    readOnlyLabel={LL.routes.readOnly()}
                    selectLabel={LL.routes.selectChild({ child: entity.label, group: group.label })}
                    selected={group.selectedChildId === childId}
                    selectionPending={selection.pendingSelectionId === childId}
                  />
                </li>
              );
            })
          }
        </BoundedEntityList>
      </div>
    </>
  );
}
