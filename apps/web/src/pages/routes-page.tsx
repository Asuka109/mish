import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import type {
  GroupDelayChildResultDto,
  GroupDelayPolicyDto,
  GroupDelayTestDto,
  PolicyGroupDto,
  PolicyGroupType,
} from "@mish/contracts";
import {
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldLabel,
  Input,
} from "@mish/ui";
import { cx, tv } from "@mish/ui/tv";
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  BoundedEntityList,
  LatencyStatus,
  PolicyBrowserToolbar,
  PolicyEntityRow,
  PolicyGroupSummaryRow,
  handlePolicyPeerNavigation,
} from "../components/policy-browser";
import { useConfiguredRouteCatalog } from "../data/configured-route-catalog";
import { useNotificationDelivery } from "../data/notification-delivery";
import { useProduct } from "../data/product-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";
import {
  buildRouteGraph,
  createRouteSearchState,
  filterDirectPolicyChildIds,
  getGroupDelayResult,
  getRouteChildLatency,
  normalizeMeasuredLatency,
  sortRouteChildIds,
  type RouteGraph,
  type RouteGraphError,
  type RouteSearchState,
  type RouteSort,
} from "./routes-model";

const routeSorts: RouteSort[] = ["configuration", "latency", "label"];

const routeStyles = tv({
  slots: {
    loading: "grid min-h-full place-content-center gap-2.5 text-center text-muted-foreground",
    page: "routes-page min-h-0",
    workspace: cx(
      "routes-workspace mx-auto min-h-full w-full max-w-page px-8 pt-7 pb-9 max-page-compact:p-6",
      "max-shell-mobile:px-4 max-shell-mobile:pt-4.5 max-shell-mobile:pb-6",
    ),
    header: cx(
      "routes-header border-b border-hairline-soft pb-5 [&_p]:mt-1.5 [&_p]:max-w-170",
      "[&_p]:leading-5.25 [&_p]:text-muted-foreground",
    ),
    back: cx(
      "mb-1.5 inline-flex min-h-7.5 items-center text-metadata text-muted-foreground",
      "no-underline hover:text-ink hover:underline",
    ),
    stale:
      "mt-4 rounded-md border border-feedback-error-border px-3 py-2.5 text-metadata text-error",
    searchField: "routes-search-field mt-5 max-w-130",
    searchControl: cx(
      "routes-search-control relative flex items-center [&>svg]:pointer-events-none [&>svg]:absolute [&>svg]:left-2.75",
      "[&>svg]:size-4 [&>svg]:text-muted-foreground [&_.ui-input]:pl-8.5",
    ),
    graph: "routes-graph mt-5",
    graphError: cx(
      "routes-graph-error mt-5 rounded-md border border-route-graph-error-border p-4 [&_p]:mt-1.25",
      "[&_p]:text-metadata [&_p]:leading-4.75 [&_p]:text-muted-foreground",
      "[&_ul]:mt-2.5 [&_ul]:grid [&_ul]:list-none [&_ul]:gap-0.75 [&_ul]:p-0",
      "[&_li]:text-metadata [&_li]:leading-4.75 [&_li]:text-muted-foreground",
      "[&_li]:before:mr-1.75 [&_li]:before:text-error [&_li]:before:content-['•']",
    ),
    rootList: "route-root-list m-0 flex list-none flex-col gap-3 p-0 max-shell-mobile:gap-2",
    groupItem: "route-group-item min-w-0",
    group:
      "route-group min-w-0 overflow-hidden rounded-md border border-hairline bg-canvas data-[disabled=true]:opacity-55",
    groupHeader: "route-group-header flex min-h-14.5 min-w-0 items-stretch",
    groupToggle: cx(
      "route-group-toggle grid min-h-14.5 min-w-0 w-full grid-cols-[18px_minmax(0,1fr)] items-center",
      "justify-stretch gap-2.5 rounded-none border-0 bg-transparent p-0 text-left text-fg",
      "hover:bg-accent hover:text-ink max-shell-mobile:hidden",
    ),
    chevron: "route-group-chevron grid place-items-center text-muted-foreground [&_svg]:size-3.5",
    mobileLink:
      "route-group-mobile-link hidden w-full text-inherit no-underline max-shell-mobile:block",
    groupBody: "route-group-body border-t border-hairline bg-surface-soft",
    detail: "policy-group-detail min-w-0",
    groupEmpty:
      "route-group-empty border-t border-hairline-soft bg-canvas px-3.5 py-4.5 text-center text-metadata text-muted-foreground",
    empty: "mt-5",
    singleGroup: "routes-single-group mt-4 overflow-hidden rounded-md border border-hairline",
  },
});

function getGroupTypeLabel(LL: TranslationFunctions, group: PolicyGroupDto) {
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

function getEntityLabel(graph: RouteGraph, entityId: string | null | undefined) {
  if (!entityId) return "";
  return graph.groupById.get(entityId)?.label ?? graph.nodeById.get(entityId)?.label ?? entityId;
}

function isGlobalGroup(group: PolicyGroupDto) {
  return group.label === "GLOBAL";
}

function getGraphErrorMessage(LL: TranslationFunctions, graph: RouteGraph, error: RouteGraphError) {
  const group = getEntityLabel(graph, error.groupId);
  const child = getEntityLabel(graph, error.childId);
  switch (error.code) {
    case "cycle":
      return LL.routes.invalidCycle({
        path: (error.path ?? []).map((id) => getEntityLabel(graph, id)).join(" → "),
      });
    case "duplicate-child":
      return LL.routes.invalidDuplicateChild({ child, group });
    case "duplicate-entity":
      return LL.routes.invalidDuplicateEntity({ entity: error.entityId ?? "" });
    case "missing-child":
      return LL.routes.invalidMissingChild({ child, group });
    case "selection-outside-group":
      return LL.routes.invalidSelection({ child, group });
    case "terminal-has-children":
      return LL.routes.invalidTerminalChildren({ group });
  }
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

interface PolicyGroupDetailProps {
  delayCommandPending: boolean;
  delayCommandSupported: boolean;
  delayPendingAction:
    | { groupId: string; kind: "start" }
    | { kind: "cancel"; testId: string }
    | null;
  delayPolicy: GroupDelayPolicyDto;
  delayTest: GroupDelayTestDto;
  density?: "default" | "compact";
  graph: RouteGraph;
  group: PolicyGroupDto;
  frozenDelayOrder: { childIds: readonly string[]; groupId: string } | null;
  isGroupCommandPending(groupId: string): boolean;
  locale: Locales;
  onCancelDelay(testId: string): void;
  onQueryChange?(query: string): void;
  onSelect(groupId: string, childId: string): void;
  onSort(groupId: string, sort: RouteSort): void;
  onStartDelay(groupId: string): void;
  pendingSelectionId?: string;
  query: string;
  search?: RouteSearchState;
  selectionDisabled: boolean;
  showSearch?: boolean;
  sortByGroupId: ReadonlyMap<string, RouteSort>;
}

export function PolicyGroupDetail({
  delayCommandPending,
  delayCommandSupported,
  delayPendingAction,
  delayPolicy,
  delayTest,
  density = "default",
  graph,
  group,
  frozenDelayOrder,
  isGroupCommandPending,
  locale,
  onCancelDelay,
  onQueryChange = () => undefined,
  onSelect,
  onSort,
  onStartDelay,
  pendingSelectionId,
  query,
  search,
  selectionDisabled,
  showSearch = false,
  sortByGroupId,
}: PolicyGroupDetailProps) {
  const { LL } = useI18nContext();
  const language = locale === "zh" ? "zh-CN" : "en";
  const sort = sortByGroupId.get(group.id) ?? "configuration";
  const delayIsActive = delayTest.phase === "pending" || delayTest.phase === "progress";
  const delayMatchesGroup = delayTest.groupId === group.id;
  const sortedIds =
    delayMatchesGroup && delayIsActive && frozenDelayOrder?.groupId === group.id
      ? [...frozenDelayOrder.childIds]
      : sortRouteChildIds(graph, group, sort, language, delayTest);
  const directFilteredIds = showSearch
    ? filterDirectPolicyChildIds(graph, group, query, language)
    : sortedIds;
  const directFilteredSet = new Set(directFilteredIds);
  const visibleChildIds = sortedIds.filter((childId) => {
    if (showSearch) return directFilteredSet.has(childId);
    if (!search?.queryActive) return true;
    return search.directMatchEntityIds.has(group.id) || search.visibleEntityIds.has(childId);
  });
  const activeDelayGroup = delayTest.groupId
    ? (graph.groupById.get(delayTest.groupId)?.label ?? delayTest.groupId)
    : "";
  const completedDelayChildren = delayMatchesGroup
    ? delayTest.children.filter((child) => child.phase !== "pending").length
    : 0;
  const groupSelectionPending = isGroupCommandPending(group.id);
  const delayProgress =
    delayMatchesGroup && delayTest.phase !== "idle"
      ? LL.routes.delayStateProgress({
          completed: completedDelayChildren,
          state: getDelayPhaseLabel(LL, delayTest),
          total: delayTest.children.length,
        })
      : delayIsActive
        ? LL.routes.delayTestingGroup({ group: activeDelayGroup })
        : LL.routes.delayPolicy({
            policy: delayPolicy.id,
            seconds: delayPolicy.timeoutMilliseconds / 1000,
          });

  return (
    <div className={routeStyles().detail()}>
      <PolicyBrowserToolbar
        cancelAriaLabel={LL.routes.cancelDelay({ group: group.label })}
        cancelLabel={LL.routes.cancelDelayButton()}
        delayActive={delayMatchesGroup && delayIsActive}
        delayBusy={delayCommandPending}
        delayDisabled={!delayCommandSupported || delayIsActive || group.childIds.length === 0}
        delayProgress={delayProgress}
        onCancel={() => delayTest.testId && onCancelDelay(delayTest.testId)}
        onQueryChange={onQueryChange}
        onSortChange={(nextSort) => onSort(group.id, nextSort)}
        onTest={() => onStartDelay(group.id)}
        query={query}
        searchLabel={LL.routes.searchCurrentGroup({ group: group.label })}
        searchPlaceholder={LL.routes.searchCurrentGroupPlaceholder()}
        showSearch={showSearch}
        sort={sort}
        sortDisabled={delayMatchesGroup && delayIsActive}
        sortLabel={LL.routes.sortChildren({ group: group.label })}
        sortOptionLabel={(option) => getSortLabel(LL, option)}
        sorts={routeSorts}
        testLabel={LL.routes.startDelayButton()}
        testAriaLabel={LL.routes.startDelay({ group: group.label })}
      />
      <span aria-live="polite" className="sr-only" role="status">
        {LL.routes.searchResultCount({ count: visibleChildIds.length })}
      </span>
      <BoundedEntityList
        empty={<p className={routeStyles().groupEmpty()}>{LL.routes.noChildren()}</p>}
        ids={visibleChildIds}
        key={`${group.id}:${showSearch ? query : search?.queryActive ? query : "all"}`}
        loadedAnnouncement={(added, total) => LL.routes.loadedMore({ added, total })}
        showMoreLabel={(remaining) => LL.routes.showMore({ count: Math.min(100, remaining) })}
      >
        {(visibleIds) =>
          visibleIds.map((childId) => {
            const childGroup = graph.groupById.get(childId);
            const node = graph.nodeById.get(childId);
            const entity = childGroup ?? node;
            if (!entity) return null;
            const selected = group.selectedChildId === childId;
            const result = getGroupDelayResult(delayTest, group.id, childId);
            const canSelectNode = group.type === "selector" && Boolean(node);
            const canSelectGroup = group.type === "selector" && childGroup?.type === "selector";
            const path = search?.matchPathByEntityId.get(childId);
            const pathLabel = path
              ? path.map((entityId) => getEntityLabel(graph, entityId)).join(" / ")
              : null;
            return (
              <li key={childId}>
                <PolicyEntityRow
                  automaticLabel={LL.routes.automaticSelection()}
                  browseLabel={
                    childGroup ? LL.routes.browseGroup({ group: childGroup.label }) : undefined
                  }
                  browseTo={childGroup ? `/routes/${encodeURIComponent(childGroup.id)}` : undefined}
                  currentLabel={LL.routes.selected()}
                  density={density}
                  disabled={selectionDisabled || groupSelectionPending}
                  entity={entity}
                  entityKind={childGroup ? "group" : "node"}
                  latency={
                    <LatencyStatus
                      cancelledLabel={LL.routes.delayCancelled()}
                      failureLabel={(delayResult) => getDelayFailureLabel(LL, delayResult)}
                      latencyMilliseconds={
                        node?.latencyMilliseconds ?? getRouteChildLatency(graph, childId)
                      }
                      measuredLabel={(latency) => LL.routes.latencyMilliseconds({ latency })}
                      result={result}
                      testingLabel={LL.routes.delayPending()}
                      unknownLabel={LL.routes.latencyUnavailable()}
                    />
                  }
                  metadata={
                    pathLabel && search?.directMatchEntityIds.has(childId)
                      ? LL.routes.ownedByPath({ path: pathLabel })
                      : (node?.protocol ??
                        LL.routes.groupReferenceType({
                          type: childGroup ? getGroupTypeLabel(LL, childGroup) : "",
                        }))
                  }
                  onSelect={
                    canSelectNode || canSelectGroup ? () => onSelect(group.id, childId) : undefined
                  }
                  pendingLabel={LL.routes.switching()}
                  readOnlyLabel={LL.routes.readOnly()}
                  selectLabel={LL.routes.selectChild({ child: entity.label, group: group.label })}
                  selected={selected}
                  selectionPending={pendingSelectionId === childId}
                />
              </li>
            );
          })
        }
      </BoundedEntityList>
      <span className="sr-only">
        {delayPendingAction?.kind === "start" && delayPendingAction.groupId === group.id
          ? LL.routes.delayTestingGroup({ group: group.label })
          : null}
      </span>
    </div>
  );
}

interface RouteGroupProps extends Omit<PolicyGroupDetailProps, "density" | "query" | "showSearch"> {
  disabled: boolean;
  expandedGroupIds: Set<string>;
  onToggle(groupId: string): void;
}

function RouteGroup({
  disabled,
  expandedGroupIds,
  graph,
  group,
  onToggle,
  search,
  ...detailProps
}: RouteGroupProps) {
  const { LL } = useI18nContext();
  const hasChildren = group.childIds.length > 0;
  const expanded =
    !disabled &&
    hasChildren &&
    (expandedGroupIds.has(group.id) || Boolean(search?.autoExpandedGroupIds.has(group.id)));
  const currentChild = getEntityLabel(graph, group.selectedChildId) || LL.routes.noCurrentChild();
  const latency = normalizeMeasuredLatency(
    getRouteChildLatency(graph, group.selectedChildId ?? ""),
  );
  return (
    <li className={routeStyles().groupItem()}>
      <article className={routeStyles().group()} data-disabled={disabled ? "true" : undefined}>
        <div className={routeStyles().groupHeader()}>
          <Button
            aria-controls={`route-group-${encodeURIComponent(group.id)}`}
            aria-expanded={expanded}
            aria-label={
              expanded
                ? LL.routes.collapseGroup({ group: group.label })
                : LL.routes.expandGroup({ group: group.label })
            }
            className={routeStyles().groupToggle({ className: "route-group-desktop-toggle" })}
            data-policy-row-primary
            disabled={disabled || !hasChildren}
            onClick={() => onToggle(group.id)}
            type="button"
            variant="ghost"
          >
            <span className={routeStyles().chevron()}>
              {expanded ? <CaretDown aria-hidden="true" /> : <CaretRight aria-hidden="true" />}
            </span>
            <PolicyGroupSummaryRow
              childCount={group.childIds.length}
              childCountLabel={LL.routes.childCount({ count: group.childIds.length })}
              currentLabel={LL.routes.currentChild({ child: currentChild })}
              group={group}
              latency={
                latency === null ? null : (
                  <span className="text-success-text tabular-nums"> · {latency} ms</span>
                )
              }
              typeLabel={getGroupTypeLabel(LL, group)}
            />
          </Button>
          <Link
            aria-label={LL.routes.browseGroup({ group: group.label })}
            className={routeStyles().mobileLink()}
            to={`/routes/${encodeURIComponent(group.id)}`}
          >
            <PolicyGroupSummaryRow
              childCount={group.childIds.length}
              childCountLabel={LL.routes.childCount({ count: group.childIds.length })}
              currentLabel={LL.routes.currentChild({ child: currentChild })}
              density="compact"
              group={group}
              latency={
                latency === null ? null : (
                  <span className="text-success-text tabular-nums"> · {latency} ms</span>
                )
              }
              typeLabel={getGroupTypeLabel(LL, group)}
            />
          </Link>
        </div>
        {expanded ? (
          <div
            className={routeStyles().groupBody()}
            id={`route-group-${encodeURIComponent(group.id)}`}
          >
            <PolicyGroupDetail
              {...detailProps}
              graph={graph}
              group={group}
              query={search?.queryActive ? "search" : ""}
              search={search}
            />
          </div>
        ) : null}
      </article>
    </li>
  );
}

function GraphError({ children }: { children: ReactNode }) {
  const { LL } = useI18nContext();
  return (
    <section className={routeStyles().graphError()} role="alert">
      <h2>{LL.routes.graphErrorTitle()}</h2>
      <p>{LL.routes.graphErrorDescription()}</p>
      {children}
    </section>
  );
}

export function RoutesPage() {
  const {
    cancelGroupDelayTest,
    connection,
    error,
    isCommandPending,
    isCommandSupported,
    isGroupCommandPending,
    isLoading,
    selectGroupChild,
    snapshot,
    startGroupDelayTest,
  } = useProduct();
  const { publish } = useNotificationDelivery();
  const { LL, locale } = useI18nContext();
  const { groupId: routeGroupId } = useParams<{ groupId?: string }>();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set());
  const [sortByGroupId, setSortByGroupId] = useState<Map<string, RouteSort>>(() => new Map());
  const [pendingSelections, setPendingSelections] = useState<Map<string, string>>(() => new Map());
  const [delayPendingAction, setDelayPendingAction] = useState<
    { groupId: string; kind: "start" } | { kind: "cancel"; testId: string } | null
  >(null);
  const [frozenDelayOrder, setFrozenDelayOrder] = useState<{
    childIds: readonly string[];
    groupId: string;
  } | null>(null);
  const preSearchState = useRef<{ expanded: Set<string>; scrollTop: number } | null>(null);
  const configuredRoutes = useConfiguredRouteCatalog(snapshot);
  const configuredRoutesActive = configuredRoutes !== null;
  const groups = configuredRoutesActive ? configuredRoutes.groups : (snapshot?.groups ?? []);
  const nodes = configuredRoutesActive ? configuredRoutes.nodes : (snapshot?.nodes ?? []);
  const routingMode = configuredRoutesActive
    ? configuredRoutes.routingMode
    : (snapshot?.routingMode ?? "rule");
  const graph = useMemo(() => buildRouteGraph(groups, nodes), [groups, nodes]);
  const search = useMemo(
    () => createRouteSearchState(graph, deferredQuery, locale === "zh" ? "zh-CN" : "en"),
    [deferredQuery, graph, locale],
  );

  useEffect(() => {
    const scroller = document.querySelector<HTMLElement>("main .workspace-page-scroll");
    if (query && !preSearchState.current) {
      preSearchState.current = {
        expanded: new Set(expandedGroupIds),
        scrollTop: scroller?.scrollTop ?? 0,
      };
      return;
    }
    if (query || !preSearchState.current) return;
    const previous = preSearchState.current;
    preSearchState.current = null;
    setExpandedGroupIds(previous.expanded);
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = previous.scrollTop;
    });
  }, [expandedGroupIds, query]);

  useEffect(() => {
    function handleSearchShortcut(event: globalThis.KeyboardEvent) {
      const searchInput = document.querySelector<HTMLInputElement>(
        ".routes-page input[type='search']",
      );
      if (!searchInput) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
        event.preventDefault();
        searchInput.focus({ preventScroll: true });
        searchInput.select();
        return;
      }
      if (event.key !== "Escape" || document.activeElement !== searchInput) return;
      event.preventDefault();
      if (query) setQuery("");
      else searchInput.blur();
    }
    window.addEventListener("keydown", handleSearchShortcut);
    return () => window.removeEventListener("keydown", handleSearchShortcut);
  }, [query]);

  useEffect(() => {
    if (
      snapshot?.groupDelayTest.phase !== "pending" &&
      snapshot?.groupDelayTest.phase !== "progress"
    ) {
      setFrozenDelayOrder(null);
    }
  }, [snapshot?.groupDelayTest.phase]);

  if (isLoading) {
    return (
      <div className={routeStyles().loading()}>
        {connection.phase === "fixture" ? LL.status.loadingFixture() : LL.status.loadingDesktop()}
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className={routeStyles().loading()} role="alert">
        {error ?? LL.status.desktopUnavailable()}
      </div>
    );
  }

  const liveCommandSupported = isCommandSupported("group") && !configuredRoutesActive;
  const delayCommandSupported = isCommandSupported("group-delay") && !configuredRoutesActive;
  const delayCommandPending = isCommandPending("group-delay");
  const modeGroups = groups.filter((group) => routingMode === "global" || !isGlobalGroup(group));
  const visibleGroupIds = modeGroups
    .map((group) => group.id)
    .filter((id) => !search.queryActive || search.visibleEntityIds.has(id));
  const decodedRouteGroupId = routeGroupId ? decodeURIComponent(routeGroupId) : null;
  const standaloneGroup = decodedRouteGroupId ? graph.groupById.get(decodedRouteGroupId) : null;

  function toggleGroup(groupId: string) {
    setExpandedGroupIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) next.delete(groupId);
      else next.add(groupId);
      return next;
    });
  }

  function changeSort(groupId: string, sort: RouteSort) {
    setSortByGroupId((current) => new Map(current).set(groupId, sort));
  }

  async function selectChild(groupId: string, childId: string) {
    setPendingSelections((current) => new Map(current).set(groupId, childId));
    const result = await selectGroupChild(groupId, childId);
    setPendingSelections((current) => {
      const next = new Map(current);
      next.delete(groupId);
      return next;
    });
    if (result.ok) return;
    const child = getEntityLabel(graph, childId);
    publish({
      id: `policy-selection-failed-${groupId}`,
      level: "error",
      message: LL.routes.selectionFailed({ child }),
      title: LL.routes.selectionFailedTitle(),
    });
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-entity-id="${CSS.escape(childId)}"]`)
        ?.querySelector<HTMLElement>("[data-policy-row-primary]")
        ?.focus({ preventScroll: true });
    });
  }

  async function startDelay(groupId: string) {
    if (!snapshot) return;
    const group = graph.groupById.get(groupId);
    if (group) {
      setFrozenDelayOrder({
        childIds: sortRouteChildIds(
          graph,
          group,
          sortByGroupId.get(groupId) ?? "configuration",
          locale === "zh" ? "zh-CN" : "en",
          snapshot.groupDelayTest,
        ),
        groupId,
      });
    }
    setDelayPendingAction({ groupId, kind: "start" });
    try {
      await startGroupDelayTest(groupId);
    } finally {
      setDelayPendingAction(null);
    }
  }

  async function cancelDelay(testId: string) {
    setDelayPendingAction({ kind: "cancel", testId });
    try {
      await cancelGroupDelayTest(testId);
    } finally {
      setDelayPendingAction(null);
    }
  }

  const sharedDetailProps = {
    delayCommandPending,
    delayCommandSupported,
    delayPendingAction,
    delayPolicy: snapshot.groupDelayPolicy,
    delayTest: snapshot.groupDelayTest,
    frozenDelayOrder,
    graph,
    isGroupCommandPending,
    locale,
    onCancelDelay: (testId: string) => void cancelDelay(testId),
    onSelect: (groupId: string, childId: string) => void selectChild(groupId, childId),
    onSort: changeSort,
    onStartDelay: (groupId: string) => void startDelay(groupId),
    selectionDisabled: !liveCommandSupported,
    sortByGroupId,
  };

  return (
    <div className={routeStyles().page()}>
      <div className={routeStyles().workspace()}>
        <header className={routeStyles().header()}>
          {standaloneGroup ? (
            <Link className={routeStyles().back()} to="/routes">
              {LL.routes.backToRoutes()}
            </Link>
          ) : null}
          <h1 className={standaloneGroup ? "user-authored-label" : undefined}>
            {standaloneGroup?.label ?? LL.routes.title()}
          </h1>
          <p>
            {standaloneGroup
              ? LL.routes.currentGroupDescription({ group: standaloneGroup.label })
              : LL.routes.description()}
          </p>
        </header>

        {connection.stale && snapshot.adapterKind !== "fixture" ? (
          <p className={routeStyles().stale()} role="status">
            {connection.phase === "reconnecting" ? LL.status.reconnecting() : LL.status.staleData()}
          </p>
        ) : null}
        {!standaloneGroup ? (
          <Field className={routeStyles().searchField()}>
            <FieldLabel htmlFor="routes-search">{LL.routes.searchLabel()}</FieldLabel>
            <span className={routeStyles().searchControl()}>
              <MagnifyingGlass aria-hidden="true" />
              <Input
                autoComplete="off"
                data-native-search
                id="routes-search"
                name="routes-search"
                onValueChange={setQuery}
                placeholder={LL.routes.searchPlaceholder()}
                spellCheck={false}
                type="search"
                value={query}
              />
            </span>
            <span aria-live="polite" className="sr-only" role="status">
              {LL.routes.searchResultCount({ count: visibleGroupIds.length })}
            </span>
          </Field>
        ) : null}

        {graph.errors.length > 0 ? (
          <GraphError>
            <ul>
              {graph.errors.map((graphError, index) => (
                <li key={`${graphError.code}-${index}`}>
                  {getGraphErrorMessage(LL, graph, graphError)}
                </li>
              ))}
            </ul>
          </GraphError>
        ) : groups.length === 0 ? (
          <Empty className={routeStyles().empty()}>
            <EmptyHeader>
              <EmptyTitle>{LL.routes.noGroupsTitle()}</EmptyTitle>
              <EmptyDescription>{LL.routes.noGroupsDescription()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : standaloneGroup ? (
          <section aria-label={standaloneGroup.label} className={routeStyles().singleGroup()}>
            <PolicyGroupDetail
              {...sharedDetailProps}
              density="compact"
              group={standaloneGroup}
              onQueryChange={setQuery}
              pendingSelectionId={pendingSelections.get(standaloneGroup.id)}
              query={query}
              showSearch
            />
          </section>
        ) : decodedRouteGroupId ? (
          <Empty className={routeStyles().empty()}>
            <EmptyHeader>
              <EmptyTitle>{LL.routes.groupNotFoundTitle()}</EmptyTitle>
              <EmptyDescription>{LL.routes.groupNotFoundDescription()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : visibleGroupIds.length === 0 ? (
          <Empty className={routeStyles().empty()}>
            <EmptyHeader>
              <EmptyTitle>{LL.routes.noMatchesTitle()}</EmptyTitle>
              <EmptyDescription>{LL.routes.noMatchesDescription()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <section aria-label={LL.routes.title()} className={routeStyles().graph()}>
            <ul className={routeStyles().rootList()} onKeyDown={handlePolicyPeerNavigation}>
              {visibleGroupIds.map((groupId) => {
                const group = graph.groupById.get(groupId);
                if (!group) return null;
                return (
                  <RouteGroup
                    {...sharedDetailProps}
                    disabled={routingMode === "global" && !isGlobalGroup(group)}
                    expandedGroupIds={expandedGroupIds}
                    group={group}
                    key={groupId}
                    onToggle={toggleGroup}
                    pendingSelectionId={pendingSelections.get(groupId)}
                    search={search}
                  />
                );
              })}
            </ul>
          </section>
        )}
      </div>
    </div>
  );
}
