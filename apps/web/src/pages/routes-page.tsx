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
import { useDeferredValue, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useParams } from "react-router";
import {
  getPolicyGroupTypeLabel,
  PolicyGroupBrowser,
  usePolicyGroupBrowserSession,
} from "../components/policy-group-browser";
import { PolicyGroupSummaryRow, handlePolicyPeerNavigation } from "../components/policy-browser";
import { PolicyPickerDialog } from "../components/proxy-picker-dialog";
import { useConfiguredRouteCatalog } from "../data/configured-route-catalog";
import { useProduct } from "../data/product-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";
import {
  buildRouteGraph,
  createRouteSearchState,
  getRouteChildLatency,
  isGlobalRouteGroup,
  normalizeMeasuredLatency,
  type RouteGraph,
  type RouteGraphError,
  type RouteSearchState,
} from "./routes-model";

const routeStyles = tv({
  slots: {
    loading: "grid min-h-full place-content-center gap-2.5 text-center text-muted-foreground",
    page: "routes-page min-h-0",
    workspace: cx(
      "routes-workspace mx-auto min-h-full w-full max-w-page px-page-gutter pt-7 pb-9",
      "max-page-compact:px-page-gutter-compact max-page-compact:py-xl",
      "max-shell-mobile:px-page-gutter-mobile max-shell-mobile:pt-4.5 max-shell-mobile:pb-6",
    ),
    header: cx(
      "routes-header border-b border-hairline-soft pb-5 [&_p]:mt-1.5 [&_p]:max-w-170",
      "[&_p]:leading-5.25 [&_p]:text-muted-foreground",
    ),
    back: cx(
      "mb-1.5 inline-flex min-h-7.5 items-center text-metadata text-muted-foreground",
      "no-underline hover:text-ink hover:underline",
    ),
    searchField: "routes-search-field mt-5 max-w-130",
    searchControl: cx(
      "routes-search-control relative flex items-center [&>svg]:pointer-events-none [&>svg]:absolute [&>svg]:left-2.75",
      "[&>svg]:size-4 [&>svg]:text-muted-foreground [&_.ui-input]:pl-8.5",
    ),
    graph: "routes-graph mt-5 overflow-hidden rounded-md border border-hairline bg-canvas",
    graphError: cx(
      "routes-graph-error mt-5 rounded-md border border-route-graph-error-border p-4 [&_p]:mt-1.25",
      "[&_p]:text-metadata [&_p]:leading-4.75 [&_p]:text-muted-foreground",
      "[&_ul]:mt-2.5 [&_ul]:grid [&_ul]:list-none [&_ul]:gap-0.75 [&_ul]:p-0",
      "[&_li]:text-metadata [&_li]:leading-4.75 [&_li]:text-muted-foreground",
      "[&_li]:before:mr-1.75 [&_li]:before:text-error [&_li]:before:content-['•']",
    ),
    rootList: "route-root-list m-0 flex list-none flex-col p-0",
    groupItem: "route-group-item min-w-0 border-b border-hairline-soft last:border-b-0",
    group: "route-group min-w-0 bg-canvas",
    groupHeader: "route-group-header flex min-h-14.5 min-w-0 items-stretch",
    desktopOpen: "route-group-desktop-open min-w-0 flex-1 max-shell-mobile:hidden",
    mobileLink:
      "route-group-mobile-link hidden w-full text-inherit no-underline max-shell-mobile:block",
    empty: "mt-5",
    singleGroup: "routes-single-group mt-4 overflow-hidden rounded-md border border-hairline",
  },
});

function getEntityLabel(graph: RouteGraph, entityId: string | null | undefined) {
  if (!entityId) return "";
  return graph.groupById.get(entityId)?.label ?? graph.nodeById.get(entityId)?.label ?? entityId;
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

interface RouteGroupProps {
  graph: RouteGraph;
  group: PolicyGroupDto;
  onOpen(groupId: string): void;
  search: RouteSearchState;
}

function RouteGroup({ graph, group, onOpen, search }: RouteGroupProps) {
  const { LL } = useI18nContext();
  const currentChild = getEntityLabel(graph, group.selectedChildId) || LL.routes.noCurrentChild();
  const matchingPath = search.queryActive
    ? [...search.matchPathByEntityId.entries()].find(([, path]) => path.includes(group.id))?.[1]
    : undefined;
  const currentLabel = matchingPath
    ? LL.routes.ownedByPath({
        path: matchingPath.map((entityId) => getEntityLabel(graph, entityId)).join(" / "),
      })
    : LL.routes.currentChild({ child: currentChild });
  const latency = normalizeMeasuredLatency(
    getRouteChildLatency(graph, group.selectedChildId ?? ""),
  );
  return (
    <li className={routeStyles().groupItem()}>
      <article className={routeStyles().group()}>
        <div className={routeStyles().groupHeader()}>
          <div className={routeStyles().desktopOpen()}>
            <PolicyGroupSummaryRow
              childCount={group.childIds.length}
              childCountLabel={LL.routes.childCount({ count: group.childIds.length })}
              currentLabel={currentLabel}
              group={group}
              latency={
                matchingPath || latency === null ? null : (
                  <span className="text-success-text tabular-nums"> · {latency} ms</span>
                )
              }
              onOpen={() => onOpen(group.id)}
              openLabel={LL.routes.browseGroup({ group: group.label })}
              typeLabel={getPolicyGroupTypeLabel(LL, group)}
            />
          </div>
          <Link
            aria-label={LL.routes.browseGroup({ group: group.label })}
            className={routeStyles().mobileLink()}
            to={`/routes/${encodeURIComponent(group.id)}`}
          >
            <PolicyGroupSummaryRow
              childCount={group.childIds.length}
              childCountLabel={LL.routes.childCount({ count: group.childIds.length })}
              currentLabel={currentLabel}
              density="compact"
              group={group}
              latency={
                matchingPath || latency === null ? null : (
                  <span className="text-success-text tabular-nums"> · {latency} ms</span>
                )
              }
              typeLabel={getPolicyGroupTypeLabel(LL, group)}
            />
          </Link>
        </div>
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
  const { connection, error, isLoading, snapshot } = useProduct();
  const { LL, locale } = useI18nContext();
  const { groupId: routeGroupId } = useParams<{ groupId?: string }>();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [pickerGroupId, setPickerGroupId] = useState<string | null>(null);
  const pickerTriggerRef = useRef<HTMLElement | null>(null);
  const browserSession = usePolicyGroupBrowserSession();
  const preSearchScrollTop = useRef<number | null>(null);
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
    if (query && preSearchScrollTop.current === null) {
      preSearchScrollTop.current = scroller?.scrollTop ?? 0;
      return;
    }
    if (query || preSearchScrollTop.current === null) return;
    const previousScrollTop = preSearchScrollTop.current;
    preSearchScrollTop.current = null;
    requestAnimationFrame(() => {
      if (scroller) scroller.scrollTop = previousScrollTop;
    });
  }, [query]);

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

  if (isLoading) {
    return (
      <div aria-busy="true" className={routeStyles().loading()}>
        <span role="status">
          {connection.phase === "fixture" ? LL.status.loadingFixture() : LL.status.loadingDesktop()}
        </span>
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

  const modeGroups = groups.filter(
    (group) => routingMode === "global" || !isGlobalRouteGroup(group),
  );
  const visibleGroupIds = modeGroups
    .map((group) => group.id)
    .filter((id) => !search.queryActive || search.visibleEntityIds.has(id));
  const decodedRouteGroupId = routeGroupId ? decodeURIComponent(routeGroupId) : null;
  const standaloneGroup = decodedRouteGroupId ? graph.groupById.get(decodedRouteGroupId) : null;
  const pickerGroup = pickerGroupId ? graph.groupById.get(pickerGroupId) : null;

  function openPicker(groupId: string) {
    pickerTriggerRef.current = document.activeElement as HTMLElement | null;
    setPickerGroupId(groupId);
  }

  return (
    <>
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
              <PolicyGroupBrowser
                commandsDisabled={
                  configuredRoutesActive ||
                  connection.stale ||
                  (routingMode === "global" && !isGlobalRouteGroup(standaloneGroup))
                }
                emptyClassName="route-group-empty border-t border-hairline-soft bg-canvas px-3.5 py-4.5 text-center text-metadata text-muted-foreground"
                emptyLabel={LL.routes.noChildren()}
                graph={graph}
                group={standaloneGroup}
                onQueryChange={setQuery}
                onSortChange={(sort) => browserSession.setSort(standaloneGroup.id, sort)}
                query={query}
                searchLabel={LL.routes.searchCurrentGroup({ group: standaloneGroup.label })}
                searchPlaceholder={LL.routes.searchCurrentGroupPlaceholder()}
                sort={browserSession.sortFor(standaloneGroup.id)}
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
                      graph={graph}
                      group={group}
                      key={groupId}
                      onOpen={openPicker}
                      search={search}
                    />
                  );
                })}
              </ul>
            </section>
          )}
        </div>
      </div>
      <PolicyPickerDialog
        commandsDisabled={
          configuredRoutesActive ||
          connection.stale ||
          Boolean(pickerGroup && routingMode === "global" && !isGlobalRouteGroup(pickerGroup))
        }
        graph={graph}
        groupId={pickerGroup?.id ?? null}
        onOpenChange={(open) => {
          if (open) return;
          setPickerGroupId(null);
          requestAnimationFrame(() => pickerTriggerRef.current?.focus({ preventScroll: true }));
        }}
        open={pickerGroup !== null}
      />
    </>
  );
}
