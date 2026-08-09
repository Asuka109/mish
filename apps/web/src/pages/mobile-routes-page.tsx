import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import type { PolicyGroupDto } from "@mish/contracts";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldLabel,
  Input,
} from "@mish/ui";
import { cx, tv } from "@mish/ui/tv";
import { useDeferredValue, useEffect, useMemo, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import {
  getPolicyGroupTypeLabel,
  PolicyGroupBrowser,
  usePolicyGroupSelection,
} from "../components/policy-group-browser";
import {
  LatencyStatus,
  PolicyEntityRow,
  PolicyGroupSummaryRow,
} from "../components/policy-browser";
import { useConfiguredRouteCatalog } from "../data/configured-route-catalog";
import { useProduct } from "../data/product-provider";
import { useI18nContext } from "../i18n/i18n-react";
import {
  buildRouteGraph,
  createRouteSearchState,
  getRouteChildLatency,
  isGlobalRouteGroup,
  normalizeMeasuredLatency,
  type RouteSort,
} from "./routes-model";

const mobileRoutesStyles = tv({
  slots: {
    actionNotice: cx(
      "mobile-routes-action-notice rounded-md border border-feedback-warning-border",
      "bg-badge-warning-background px-3 py-2.5 text-metadata leading-4.5 text-warning",
    ),
    child: "mobile-route-child grid min-w-0 gap-3",
    childMeta: "text-metadata leading-5 text-muted-foreground",
    childTitle: "user-authored-label min-w-0 text-title leading-7 font-semibold text-ink",
    content: "mx-auto grid w-full max-w-130 min-w-0 gap-4",
    description: "max-w-120 text-body leading-5 text-muted-foreground",
    group: "mobile-routes-group grid min-w-0 gap-3",
    groupHeader: "grid min-w-0 gap-1",
    groupList: "overflow-hidden rounded-md border border-hairline bg-canvas",
    groupTitle: "user-authored-label min-w-0 text-title leading-7 font-semibold text-ink",
    list: "mobile-routes-list m-0 overflow-hidden rounded-md border border-hairline bg-canvas p-0",
    listItem: "min-w-0 border-b border-hairline-soft last:border-b-0",
    listLink: "block min-w-0 text-inherit no-underline touch-manipulation",
    loading: "grid min-h-48 place-items-center text-metadata text-muted-foreground",
    page: cx(
      "mobile-route-scroller h-full min-h-0 min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain",
      "bg-canvas px-4 pt-4 pb-6",
    ),
    pageHeader: "grid min-w-0 gap-1 border-b border-hairline-soft pb-4",
    search: "mobile-routes-search",
    searchControl: cx(
      "relative flex min-w-0 items-center [&>svg]:pointer-events-none [&>svg]:absolute [&>svg]:left-3",
      "[&>svg]:size-4.5 [&>svg]:text-muted-foreground [&_.ui-input]:min-h-11 [&_.ui-input]:pl-9.5",
    ),
  },
});

function getEntityLabel(
  graph: ReturnType<typeof buildRouteGraph>,
  entityId: string | null | undefined,
) {
  if (!entityId) return "";
  return graph.groupById.get(entityId)?.label ?? graph.nodeById.get(entityId)?.label ?? entityId;
}

function decodeRouteParam(value: string | undefined) {
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function groupPath(groupId: string) {
  return "/routes/" + encodeURIComponent(groupId);
}

function childPath(groupId: string, childId: string, search: string) {
  return groupPath(groupId) + "/children/" + encodeURIComponent(childId) + search;
}

function parseRouteSort(value: string | null): RouteSort {
  if (value === "latency" || value === "label") return value;
  return "configuration";
}

function serializeGroupRouteSearch(searchParams: URLSearchParams, query: string, sort: RouteSort) {
  const next = new URLSearchParams(searchParams);
  next.delete("query");
  next.delete("sort");
  if (sort !== "configuration") next.set("sort", sort);
  if (query) next.set("query", query);
  const value = next.toString();
  return value ? "?" + value : "";
}

function useMobileRouteData() {
  const product = useProduct();
  const configuredRoutes = useConfiguredRouteCatalog(product.snapshot, product.connection);
  const configuredRoutesActive = configuredRoutes !== null;
  const groups = configuredRoutesActive
    ? configuredRoutes.groups
    : (product.snapshot?.groups ?? []);
  const nodes = configuredRoutesActive ? configuredRoutes.nodes : (product.snapshot?.nodes ?? []);
  const routingMode = configuredRoutesActive
    ? configuredRoutes.routingMode
    : (product.snapshot?.routingMode ?? "rule");
  const graph = useMemo(() => buildRouteGraph(groups, nodes), [groups, nodes]);

  return {
    ...product,
    configuredRoutesActive,
    graph,
    groups,
    routingMode,
  };
}

function MobileRoutePage({ children }: { children: ReactNode }) {
  const styles = mobileRoutesStyles();
  return (
    <div className={styles.page()} data-mobile-route-scroller>
      <div className={styles.content()}>{children}</div>
    </div>
  );
}

function MobileRouteLoading({ children }: { children: ReactNode }) {
  const styles = mobileRoutesStyles();
  return (
    <MobileRoutePage>
      <div className={styles.loading()} role="status">
        {children}
      </div>
    </MobileRoutePage>
  );
}

function MobileRouteUnavailable({ description, title }: { description: string; title: string }) {
  return (
    <MobileRoutePage>
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{description}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    </MobileRoutePage>
  );
}

function commandsAreDisabled(
  configuredRoutesActive: boolean,
  stale: boolean,
  routingMode: "direct" | "global" | "rule",
  group: PolicyGroupDto | null,
) {
  if (configuredRoutesActive || stale) return true;
  if (routingMode !== "global" || !group) return false;
  return !isGlobalRouteGroup(group);
}

export function MobileRoutesPage() {
  const data = useMobileRouteData();
  const { LL, locale } = useI18nContext();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const styles = mobileRoutesStyles();
  const language = locale === "zh" ? "zh-CN" : "en";
  const search = useMemo(
    () => createRouteSearchState(data.graph, deferredQuery, language),
    [data.graph, deferredQuery, language],
  );

  if (data.isLoading) return <MobileRouteLoading>{LL.common.loading()}</MobileRouteLoading>;
  if (!data.snapshot) {
    return (
      <MobileRouteUnavailable
        description={data.error ?? LL.status.desktopUnavailable()}
        title={LL.routes.title()}
      />
    );
  }
  if (data.graph.errors.length > 0) {
    return (
      <MobileRouteUnavailable
        description={LL.routes.graphErrorDescription()}
        title={LL.routes.graphErrorTitle()}
      />
    );
  }
  if (data.groups.length === 0) {
    return (
      <MobileRouteUnavailable
        description={LL.routes.noGroupsDescription()}
        title={LL.routes.noGroupsTitle()}
      />
    );
  }

  const groups = data.groups.filter(
    (group) => data.routingMode === "global" || !isGlobalRouteGroup(group),
  );
  const visibleGroups = groups.filter(
    (group) => !search.queryActive || search.visibleEntityIds.has(group.id),
  );

  return (
    <MobileRoutePage>
      <header className={styles.pageHeader()}>
        <h2 className="text-title leading-7 font-semibold text-ink">{LL.routes.title()}</h2>
        <p className={styles.description()}>{LL.routes.description()}</p>
      </header>
      <Field className={styles.search()}>
        <FieldLabel className="sr-only" htmlFor="mobile-routes-search">
          {LL.routes.searchLabel()}
        </FieldLabel>
        <span className={styles.searchControl()}>
          <MagnifyingGlass aria-hidden="true" />
          <Input
            autoComplete="off"
            data-native-search
            id="mobile-routes-search"
            name="mobile-routes-search"
            onValueChange={setQuery}
            placeholder={LL.routes.searchPlaceholder()}
            spellCheck={false}
            type="search"
            value={query}
          />
        </span>
        <span aria-live="polite" className="sr-only" role="status">
          {LL.routes.searchResultCount({ count: visibleGroups.length })}
        </span>
      </Field>
      {visibleGroups.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{LL.routes.noMatchesTitle()}</EmptyTitle>
            <EmptyDescription>{LL.routes.noMatchesDescription()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <section aria-label={LL.routes.title()} className={styles.groupList()}>
          <ul className={styles.list()}>
            {visibleGroups.map((group) => {
              const currentChild = getEntityLabel(data.graph, group.selectedChildId);
              const latency = normalizeMeasuredLatency(
                getRouteChildLatency(data.graph, group.selectedChildId ?? ""),
              );
              return (
                <li className={styles.listItem()} key={group.id}>
                  <Link
                    aria-label={LL.routes.browseGroup({ group: group.label })}
                    className={styles.listLink()}
                    to={groupPath(group.id)}
                  >
                    <PolicyGroupSummaryRow
                      childCount={group.childIds.length}
                      childCountLabel={LL.routes.childCount({ count: group.childIds.length })}
                      currentLabel={LL.routes.currentChild({
                        child: currentChild || LL.routes.noCurrentChild(),
                      })}
                      density="compact"
                      group={group}
                      latency={
                        latency === null ? null : (
                          <span className="text-success-text tabular-nums"> · {latency} ms</span>
                        )
                      }
                      typeLabel={getPolicyGroupTypeLabel(LL, group)}
                    />
                  </Link>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </MobileRoutePage>
  );
}

export function MobileRouteGroupPage() {
  const data = useMobileRouteData();
  const { LL } = useI18nContext();
  const { groupId: routeGroupId } = useParams<{ groupId: string }>();
  const [searchParams] = useSearchParams();
  const styles = mobileRoutesStyles();
  const groupId = decodeRouteParam(routeGroupId);
  const group = groupId ? (data.graph.groupById.get(groupId) ?? null) : null;
  const routeQuery = searchParams.get("query") ?? "";
  const routeSort = parseRouteSort(searchParams.get("sort"));
  const [query, setQuery] = useState(routeQuery);
  const [sort, setSort] = useState<RouteSort>(routeSort);
  const commandDisabled = commandsAreDisabled(
    data.configuredRoutesActive,
    data.connection.stale,
    data.routingMode,
    group,
  );

  useEffect(() => {
    setQuery(routeQuery);
    setSort(routeSort);
  }, [groupId, routeQuery, routeSort]);

  const routeSearch = serializeGroupRouteSearch(searchParams, query, sort);
  const selectionUnavailable = commandDisabled || !data.isCommandSupported("group");
  const delayUnavailable = commandDisabled || !data.isCommandSupported("group-delay");
  const actionNotice = data.connection.stale
    ? null
    : selectionUnavailable && delayUnavailable
      ? LL.mobileRoutes.actionsUnavailable()
      : selectionUnavailable
        ? LL.mobileRoutes.selectionUnavailable()
        : delayUnavailable
          ? LL.mobileRoutes.delayUnavailable()
          : null;

  if (data.isLoading) return <MobileRouteLoading>{LL.common.loading()}</MobileRouteLoading>;
  if (!data.snapshot) {
    return (
      <MobileRouteUnavailable
        description={data.error ?? LL.status.desktopUnavailable()}
        title={LL.routes.title()}
      />
    );
  }
  if (data.graph.errors.length > 0) {
    return (
      <MobileRouteUnavailable
        description={LL.routes.graphErrorDescription()}
        title={LL.routes.graphErrorTitle()}
      />
    );
  }
  if (!group) {
    return (
      <MobileRouteUnavailable
        description={LL.routes.groupNotFoundDescription()}
        title={LL.routes.groupNotFoundTitle()}
      />
    );
  }

  return (
    <MobileRoutePage>
      <section aria-labelledby="mobile-routes-group-title" className={styles.group()}>
        <header className={styles.groupHeader()}>
          <h2 className={styles.groupTitle()} id="mobile-routes-group-title">
            {group.label}
          </h2>
          <p className={styles.description()}>
            {LL.routes.currentGroupDescription({ group: group.label })}
          </p>
        </header>
        {data.connection.stale ? (
          <p className={styles.actionNotice()} role="status">
            {LL.mobileRoutes.reconnecting()}
          </p>
        ) : null}
        {actionNotice ? <p className={styles.actionNotice()}>{actionNotice}</p> : null}
        <div className={styles.groupList()}>
          <PolicyGroupBrowser
            childBrowseLabel={(childId) =>
              LL.mobileRoutes.childDetails({
                child: getEntityLabel(data.graph, childId),
              })
            }
            childBrowseTo={(childId) => childPath(group.id, childId, routeSearch)}
            commandsDisabled={commandDisabled}
            emptyClassName="px-4 py-7 text-center text-metadata text-muted-foreground"
            emptyLabel={LL.routes.noChildren()}
            graph={data.graph}
            group={group}
            listClassName="min-w-0"
            mobile
            onQueryChange={setQuery}
            onSortChange={setSort}
            query={query}
            searchLabel={LL.routes.searchCurrentGroup({ group: group.label })}
            searchPlaceholder={LL.routes.searchCurrentGroupPlaceholder()}
            sort={sort}
          />
        </div>
      </section>
    </MobileRoutePage>
  );
}

export function MobileRouteChildPage() {
  const data = useMobileRouteData();
  const { LL } = useI18nContext();
  const { childId: routeChildId, groupId: routeGroupId } = useParams<{
    childId: string;
    groupId: string;
  }>();
  const styles = mobileRoutesStyles();
  const groupId = decodeRouteParam(routeGroupId);
  const childId = decodeRouteParam(routeChildId);
  const group = groupId ? (data.graph.groupById.get(groupId) ?? null) : null;
  const commandDisabled = commandsAreDisabled(
    data.configuredRoutesActive,
    data.connection.stale,
    data.routingMode,
    group,
  );
  const selection = usePolicyGroupSelection({
    commandsDisabled: commandDisabled,
    graph: data.graph,
    group,
  });
  const childGroup = childId ? data.graph.groupById.get(childId) : undefined;
  const node = childId ? data.graph.nodeById.get(childId) : undefined;
  const entity = childGroup ?? node;

  if (data.isLoading) return <MobileRouteLoading>{LL.common.loading()}</MobileRouteLoading>;
  if (!data.snapshot) {
    return (
      <MobileRouteUnavailable
        description={data.error ?? LL.status.desktopUnavailable()}
        title={LL.routes.title()}
      />
    );
  }
  if (data.graph.errors.length > 0) {
    return (
      <MobileRouteUnavailable
        description={LL.routes.graphErrorDescription()}
        title={LL.routes.graphErrorTitle()}
      />
    );
  }
  if (!group || !childId || !entity || !group.childIds.includes(childId)) {
    return (
      <MobileRouteUnavailable
        description={LL.routes.groupNotFoundDescription()}
        title={LL.routes.groupNotFoundTitle()}
      />
    );
  }

  const canSelect = group.type === "selector" && (Boolean(node) || childGroup?.type === "selector");
  const latency = node?.latencyMilliseconds ?? getRouteChildLatency(data.graph, childId);

  return (
    <MobileRoutePage>
      <section aria-labelledby="mobile-routes-child-title" className={styles.child()}>
        <header className={styles.groupHeader()}>
          <h2 className={styles.childTitle()} id="mobile-routes-child-title">
            {entity.label}
          </h2>
          <p className={styles.childMeta()}>
            {node?.protocol ??
              LL.routes.groupReferenceType({
                type: childGroup ? getPolicyGroupTypeLabel(LL, childGroup) : "",
              })}
          </p>
          <p className={styles.description()}>
            {LL.routes.currentGroupDescription({ group: group.label })}
          </p>
        </header>
        {data.connection.stale || selection.selectionDisabled ? (
          <p className={styles.actionNotice()} role={data.connection.stale ? "status" : undefined}>
            {data.connection.stale
              ? LL.mobileRoutes.reconnecting()
              : LL.mobileRoutes.selectionUnavailable()}
          </p>
        ) : null}
        <div className={styles.groupList()}>
          <PolicyEntityRow
            automaticLabel={LL.routes.automaticSelection()}
            currentLabel={LL.routes.selected()}
            density="compact"
            disabled={selection.selectionDisabled || selection.selectionPending}
            entity={entity}
            entityKind={childGroup ? "group" : "node"}
            latency={
              <LatencyStatus
                cancelledLabel={LL.routes.delayCancelled()}
                failureLabel={() => LL.routes.delayUnavailable()}
                latencyMilliseconds={latency}
                measuredLabel={(milliseconds) =>
                  LL.routes.latencyMilliseconds({ latency: milliseconds })
                }
                testingLabel={LL.routes.delayPending()}
              />
            }
            metadata={
              node?.protocol ??
              LL.routes.groupReferenceType({
                type: childGroup ? getPolicyGroupTypeLabel(LL, childGroup) : "",
              })
            }
            muted={selection.selectionDisabled}
            onSelect={canSelect ? () => void selection.selectChild(childId) : undefined}
            pendingLabel={LL.routes.switching()}
            readOnlyPresentation={group.type === "selector" ? "explicit" : "passive"}
            readOnlyLabel={LL.routes.readOnly()}
            selectLabel={LL.routes.selectChild({ child: entity.label, group: group.label })}
            selected={group.selectedChildId === childId}
            selectionPending={selection.pendingSelectionId === childId}
          />
        </div>
      </section>
    </MobileRoutePage>
  );
}
