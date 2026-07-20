import { ArrowClockwise } from "@phosphor-icons/react/ArrowClockwise";
import { CaretDown } from "@phosphor-icons/react/CaretDown";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import { Check } from "@phosphor-icons/react/Check";
import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { XCircle } from "@phosphor-icons/react/XCircle";
import type {
  GroupDelayChildResultDto,
  GroupDelayPolicyDto,
  GroupDelayTestDto,
  PolicyGroupDto,
  PolicyGroupType,
  ProxyNodeDto,
} from "@mish/contracts";
import {
  Badge,
  Button,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldLabel,
  Input,
  ToggleGroup,
  ToggleGroupItem,
} from "@mish/ui";
import { useDeferredValue, useMemo, useState } from "react";
import { useProduct } from "../data/product-provider";
import { getCommandDescriptionId } from "../data/status-capabilities";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";
import {
  buildRouteGraph,
  createRouteSearchState,
  getGroupDelayResult,
  sortRouteChildIds,
  type RouteGraph,
  type RouteGraphError,
  type RouteSearchState,
  type RouteSort,
} from "./routes-model";

const routeSorts: RouteSort[] = ["configuration", "latency", "label"];

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

function getDelayFailureLabel(
  LL: TranslationFunctions,
  failure: GroupDelayChildResultDto["failure"],
) {
  switch (failure) {
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

function DelayResult({ result }: { result?: GroupDelayChildResultDto }) {
  const { LL, locale } = useI18nContext();
  if (!result) return null;
  const outcome =
    result.phase === "success"
      ? LL.routes.latencyMilliseconds({ latency: result.latencyMilliseconds! })
      : result.phase === "pending"
        ? LL.routes.delayPending()
        : getDelayFailureLabel(LL, result.failure);
  return (
    <span className={`route-delay-result route-delay-${result.phase}`}>
      <span>{outcome}</span>
      {result.observedAt === null ? null : (
        <time dateTime={new Date(result.observedAt).toISOString()}>
          {new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
          }).format(result.observedAt)}
        </time>
      )}
    </span>
  );
}

interface RouteNodeRowProps {
  commandDescriptionId: string | undefined;
  commandPending: boolean;
  commandSupported: boolean;
  group: PolicyGroupDto;
  delayResult?: GroupDelayChildResultDto;
  node: ProxyNodeDto;
  onSelect(groupId: string, childId: string): void;
}

function RouteNodeRow({
  commandDescriptionId,
  commandPending,
  commandSupported,
  group,
  delayResult,
  node,
  onSelect,
}: RouteNodeRowProps) {
  const { LL } = useI18nContext();
  const selected = group.selectedChildId === node.id;
  const content = (
    <>
      <span className="route-child-copy">
        <strong className="user-authored-label" title={node.label}>
          {node.label}
        </strong>
        <span>{node.protocol}</span>
      </span>
      <span className="route-child-status">
        {delayResult ? (
          <DelayResult result={delayResult} />
        ) : (
          <span className="route-latency tabular">
            {node.latencyMilliseconds === null
              ? LL.routes.latencyUnavailable()
              : LL.routes.latencyMilliseconds({ latency: node.latencyMilliseconds })}
          </span>
        )}
        {selected ? (
          <span className="route-selected-status">
            <Check aria-hidden="true" />
            {LL.routes.selected()}
          </span>
        ) : null}
      </span>
    </>
  );

  if (group.type !== "selector") {
    return <div className="route-child-row">{content}</div>;
  }

  return (
    <Button
      aria-describedby={commandDescriptionId}
      aria-label={LL.routes.selectChild({ child: node.label, group: group.label })}
      aria-pressed={selected}
      className="route-child-row route-child-select"
      disabled={commandPending || !commandSupported}
      onClick={() => onSelect(group.id, node.id)}
      variant="ghost"
    >
      {content}
    </Button>
  );
}

interface RouteGroupProps {
  commandDescriptionId: string | undefined;
  commandSupported: boolean;
  delayCommandPending: boolean;
  delayCommandSupported: boolean;
  delayPolicy: GroupDelayPolicyDto;
  delayTest: GroupDelayTestDto;
  depth: number;
  expandedGroupIds: Set<string>;
  graph: RouteGraph;
  group: PolicyGroupDto;
  isGroupCommandPending(groupId: string): boolean;
  locale: Locales;
  onCancelDelay(testId: string): void;
  onSelect(groupId: string, childId: string): void;
  onSort(groupId: string, sort: RouteSort): void;
  onStartDelay(groupId: string): void;
  onToggle(groupId: string): void;
  parentGroup?: PolicyGroupDto;
  parentDelayResult?: GroupDelayChildResultDto;
  search: RouteSearchState;
  sortByGroupId: ReadonlyMap<string, RouteSort>;
}

function RouteGroup({
  commandDescriptionId,
  commandSupported,
  delayCommandPending,
  delayCommandSupported,
  delayPolicy,
  delayTest,
  depth,
  expandedGroupIds,
  graph,
  group,
  isGroupCommandPending,
  locale,
  onCancelDelay,
  onSelect,
  onSort,
  onStartDelay,
  onToggle,
  parentGroup,
  parentDelayResult,
  search,
  sortByGroupId,
}: RouteGroupProps) {
  const { LL } = useI18nContext();
  const hasChildren = group.childIds.length > 0;
  const expanded =
    hasChildren && (expandedGroupIds.has(group.id) || search.autoExpandedGroupIds.has(group.id));
  const childrenId = `route-group-${encodeURIComponent(group.id)}`;
  const currentChild = getEntityLabel(graph, group.selectedChildId);
  const selectedInParent = parentGroup?.selectedChildId === group.id;
  const canSelectInParent = parentGroup?.type === "selector";
  const sort = sortByGroupId.get(group.id) ?? "configuration";
  const sortedChildIds = expanded ? sortRouteChildIds(graph, group, sort, locale, delayTest) : [];
  const delayIsActive = delayTest.phase === "pending" || delayTest.phase === "progress";
  const delayMatchesGroup = delayTest.groupId === group.id;
  const activeDelayGroup = delayTest.groupId
    ? (graph.groupById.get(delayTest.groupId)?.label ?? delayTest.groupId)
    : "";
  const completedDelayChildren = delayMatchesGroup
    ? delayTest.children.filter((child) => child.phase !== "pending").length
    : 0;
  const visibleChildIds = search.queryActive
    ? sortedChildIds.filter(
        (childId) =>
          search.directMatchEntityIds.has(group.id) || search.visibleEntityIds.has(childId),
      )
    : sortedChildIds;
  const headerContent = (
    <>
      <span className="route-group-chevron">
        {expanded ? <CaretDown aria-hidden="true" /> : <CaretRight aria-hidden="true" />}
      </span>
      <span className="route-group-copy">
        <span className="route-group-title-line">
          <strong className="user-authored-label" title={group.label}>
            {group.label}
          </strong>
          <Badge variant="outline">{getGroupTypeLabel(LL, group)}</Badge>
        </span>
        <span className="route-group-current user-authored-label">
          {currentChild
            ? LL.routes.currentChild({ child: currentChild })
            : LL.routes.noCurrentChild()}
        </span>
      </span>
      <Badge aria-label={LL.routes.childCount({ count: group.childIds.length })} variant="outline">
        {group.childIds.length}
      </Badge>
      <DelayResult result={parentDelayResult} />
    </>
  );

  return (
    <li className="route-group-item" data-depth={depth}>
      <article className="route-group">
        <div className="route-group-header">
          {hasChildren ? (
            <Button
              aria-controls={childrenId}
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? LL.routes.collapseGroup({ group: group.label })
                  : LL.routes.expandGroup({ group: group.label })
              }
              className="route-group-toggle"
              onClick={() => onToggle(group.id)}
              variant="ghost"
            >
              {headerContent}
            </Button>
          ) : (
            <div className="route-group-toggle route-group-static">{headerContent}</div>
          )}
          {canSelectInParent && parentGroup ? (
            <Button
              aria-describedby={commandDescriptionId}
              aria-label={LL.routes.selectChild({ child: group.label, group: parentGroup.label })}
              aria-pressed={selectedInParent}
              className="route-group-select"
              disabled={isGroupCommandPending(parentGroup.id) || !commandSupported}
              onClick={() => onSelect(parentGroup.id, group.id)}
              size="sm"
              variant={selectedInParent ? "outline" : "ghost"}
            >
              {selectedInParent ? <Check aria-hidden="true" /> : null}
              {selectedInParent ? LL.routes.selected() : getGroupTypeLabel(LL, group)}
            </Button>
          ) : null}
        </div>

        {expanded ? (
          <div className="route-group-body" id={childrenId}>
            <div className="route-group-tools">
              <div className="route-sort-tools">
                <span>{LL.routes.sortChildren({ group: group.label })}</span>
                <ToggleGroup
                  aria-label={LL.routes.sortChildren({ group: group.label })}
                  className="route-sort-group"
                  onValueChange={(values) => {
                    const nextSort = values[0] as RouteSort | undefined;
                    if (nextSort) onSort(group.id, nextSort);
                  }}
                  spacing={0}
                  value={[sort]}
                  variant="outline"
                >
                  {routeSorts.map((option) => (
                    <ToggleGroupItem className="route-sort-button" key={option} value={option}>
                      {getSortLabel(LL, option)}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </div>
              <div className="route-delay-tools">
                <span className="route-delay-copy">
                  <strong className="user-authored-label">
                    {delayMatchesGroup && delayIsActive
                      ? LL.routes.delayTestingGroup({ group: group.label })
                      : delayIsActive
                        ? LL.routes.delayTestingGroup({ group: activeDelayGroup })
                        : LL.routes.delayTestGroup({ group: group.label })}
                  </strong>
                  <span>
                    {delayMatchesGroup && delayTest.phase !== "idle"
                      ? LL.routes.delayStateProgress({
                          completed: completedDelayChildren,
                          state: getDelayPhaseLabel(LL, delayTest),
                          total: delayTest.children.length,
                        })
                      : LL.routes.delayPolicy({
                          policy: delayPolicy.id,
                          seconds: delayPolicy.timeoutMilliseconds / 1000,
                        })}
                  </span>
                </span>
                {delayMatchesGroup && delayIsActive && delayTest.testId ? (
                  <Button
                    aria-label={LL.routes.cancelDelay({ group: group.label })}
                    disabled={delayCommandPending}
                    onClick={() => onCancelDelay(delayTest.testId!)}
                    size="sm"
                    variant="outline"
                  >
                    <XCircle aria-hidden="true" data-icon="inline-start" />
                    {LL.routes.cancelDelayButton()}
                  </Button>
                ) : (
                  <Button
                    aria-label={LL.routes.startDelay({ group: group.label })}
                    disabled={
                      delayCommandPending ||
                      !delayCommandSupported ||
                      delayIsActive ||
                      group.childIds.length === 0
                    }
                    onClick={() => onStartDelay(group.id)}
                    size="sm"
                    variant="outline"
                  >
                    <ArrowClockwise aria-hidden="true" data-icon="inline-start" />
                    {LL.routes.startDelayButton()}
                  </Button>
                )}
              </div>
            </div>

            {visibleChildIds.length > 0 ? (
              <ul className="route-children-list">
                {visibleChildIds.map((childId) => {
                  const childGroup = graph.groupById.get(childId);
                  if (childGroup) {
                    return (
                      <RouteGroup
                        commandDescriptionId={commandDescriptionId}
                        commandSupported={commandSupported}
                        delayCommandPending={delayCommandPending}
                        delayCommandSupported={delayCommandSupported}
                        delayPolicy={delayPolicy}
                        delayTest={delayTest}
                        depth={depth + 1}
                        expandedGroupIds={expandedGroupIds}
                        graph={graph}
                        group={childGroup}
                        isGroupCommandPending={isGroupCommandPending}
                        key={childId}
                        locale={locale}
                        onCancelDelay={onCancelDelay}
                        onSelect={onSelect}
                        onSort={onSort}
                        onStartDelay={onStartDelay}
                        onToggle={onToggle}
                        parentGroup={group}
                        parentDelayResult={getGroupDelayResult(delayTest, group.id, childId)}
                        search={search}
                        sortByGroupId={sortByGroupId}
                      />
                    );
                  }
                  const node = graph.nodeById.get(childId);
                  if (!node) return null;
                  return (
                    <li key={childId}>
                      <RouteNodeRow
                        commandDescriptionId={commandDescriptionId}
                        commandPending={isGroupCommandPending(group.id)}
                        commandSupported={commandSupported}
                        delayResult={getGroupDelayResult(delayTest, group.id, childId)}
                        group={group}
                        node={node}
                        onSelect={onSelect}
                      />
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="route-group-empty">{LL.routes.noChildren()}</p>
            )}
          </div>
        ) : null}
      </article>
    </li>
  );
}

export function RoutesPage() {
  const {
    connection,
    error,
    isCommandPending,
    isCommandSupported,
    isGroupCommandPending,
    isLoading,
    cancelGroupDelayTest,
    selectGroupChild,
    snapshot,
    startGroupDelayTest,
  } = useProduct();
  const { LL, locale } = useI18nContext();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set());
  const [sortByGroupId, setSortByGroupId] = useState<Map<string, RouteSort>>(() => new Map());
  const graph = useMemo(
    () => buildRouteGraph(snapshot?.groups ?? [], snapshot?.nodes ?? []),
    [snapshot],
  );
  const search = useMemo(
    () => createRouteSearchState(graph, deferredQuery, locale === "zh" ? "zh-CN" : "en"),
    [deferredQuery, graph, locale],
  );

  if (isLoading) {
    return (
      <div className="status-loading">
        {connection.phase === "fixture" ? LL.status.loadingFixture() : LL.status.loadingDesktop()}
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="status-loading" role="alert">
        {error ?? LL.status.desktopUnavailable()}
      </div>
    );
  }

  const commandSupported = isCommandSupported("group");
  const delayCommandSupported = isCommandSupported("group-delay");
  const delayCommandPending = isCommandPending("group-delay");
  const commandDescriptionId = getCommandDescriptionId(snapshot.adapterKind, commandSupported);
  const activeProfile =
    snapshot.profiles.find((profile) => profile.id === snapshot.activeProfileId)?.label ??
    snapshot.activeProfileId;
  const visibleRootGroupIds = search.queryActive
    ? graph.rootGroupIds.filter((groupId) => search.visibleEntityIds.has(groupId))
    : graph.rootGroupIds;
  const sourceDescription =
    snapshot.adapterKind === "fixture"
      ? LL.routes.fixtureDescription()
      : snapshot.adapterKind === "rpc"
        ? LL.routes.desktopDescription()
        : LL.routes.deviceDescription();

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

  return (
    <div className="routes-page page-scroll">
      <div className="routes-workspace">
        <header className="routes-header">
          <div>
            <h1>{LL.routes.title()}</h1>
            <p>{LL.routes.description()}</p>
          </div>
          <div className="routes-context">
            <strong className="user-authored-label" title={activeProfile}>
              {LL.routes.activeProfile({ profile: activeProfile })}
            </strong>
            <span>{sourceDescription}</span>
          </div>
        </header>

        {snapshot.adapterKind !== "fixture" && connection.stale ? (
          <p className="fixture-error" role="status">
            {connection.phase === "reconnecting" ? LL.status.reconnecting() : LL.status.staleData()}
          </p>
        ) : null}
        {!commandSupported ? (
          <aside className="routes-read-only" role="note">
            <strong>{LL.routes.readOnlyTitle()}</strong>
            <span>{LL.routes.readOnlyDescription()}</span>
          </aside>
        ) : null}

        <Field className="routes-search-field">
          <FieldLabel htmlFor="routes-search">{LL.routes.searchLabel()}</FieldLabel>
          <span className="routes-search-control">
            <MagnifyingGlass aria-hidden="true" />
            <Input
              autoComplete="off"
              data-native-search
              id="routes-search"
              onValueChange={setQuery}
              placeholder={LL.routes.searchPlaceholder()}
              spellCheck={false}
              type="search"
              value={query}
            />
          </span>
        </Field>

        {graph.errors.length > 0 ? (
          <section className="routes-graph-error" role="alert">
            <h2>{LL.routes.graphErrorTitle()}</h2>
            <p>{LL.routes.graphErrorDescription()}</p>
            <ul>
              {graph.errors.map((graphError, index) => (
                <li key={`${graphError.code}-${index}`}>
                  {getGraphErrorMessage(LL, graph, graphError)}
                </li>
              ))}
            </ul>
          </section>
        ) : snapshot.groups.length === 0 ? (
          <Empty className="routes-empty">
            <EmptyHeader>
              <EmptyTitle>{LL.routes.noGroupsTitle()}</EmptyTitle>
              <EmptyDescription>{LL.routes.noGroupsDescription()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : visibleRootGroupIds.length === 0 ? (
          <Empty className="routes-empty">
            <EmptyHeader>
              <EmptyTitle>{LL.routes.noMatchesTitle()}</EmptyTitle>
              <EmptyDescription>{LL.routes.noMatchesDescription()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <section aria-label={LL.routes.title()} className="routes-graph">
            <ul className="route-root-list">
              {visibleRootGroupIds.map((groupId) => {
                const group = graph.groupById.get(groupId);
                if (!group) return null;
                return (
                  <RouteGroup
                    commandDescriptionId={commandDescriptionId}
                    commandSupported={commandSupported}
                    delayCommandPending={delayCommandPending}
                    delayCommandSupported={delayCommandSupported}
                    delayPolicy={snapshot.groupDelayPolicy}
                    delayTest={snapshot.groupDelayTest}
                    depth={0}
                    expandedGroupIds={expandedGroupIds}
                    graph={graph}
                    group={group}
                    isGroupCommandPending={isGroupCommandPending}
                    key={groupId}
                    locale={locale}
                    onCancelDelay={(testId) => void cancelGroupDelayTest(testId)}
                    onSelect={(groupId, childId) => void selectGroupChild(groupId, childId)}
                    onSort={changeSort}
                    onStartDelay={(groupId) => void startGroupDelayTest(groupId)}
                    onToggle={toggleGroup}
                    search={search}
                    sortByGroupId={sortByGroupId}
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
