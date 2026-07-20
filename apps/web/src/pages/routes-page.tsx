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
  selectionPending: boolean;
}

function RouteNodeRow({
  commandDescriptionId,
  commandPending,
  commandSupported,
  group,
  delayResult,
  node,
  onSelect,
  selectionPending,
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
      loading={selectionPending}
      loadingText={LL.common.pending()}
      onClick={() => onSelect(group.id, node.id)}
      variant="ghost"
    >
      {content}
    </Button>
  );
}

interface RouteGroupReferenceRowProps {
  commandDescriptionId: string | undefined;
  commandPending: boolean;
  commandSupported: boolean;
  delayResult?: GroupDelayChildResultDto;
  group: PolicyGroupDto;
  parentGroup: PolicyGroupDto;
  onSelect(groupId: string, childId: string): void;
  selectionPending: boolean;
}

function RouteGroupReferenceRow({
  commandDescriptionId,
  commandPending,
  commandSupported,
  delayResult,
  group,
  parentGroup,
  onSelect,
  selectionPending,
}: RouteGroupReferenceRowProps) {
  const { LL } = useI18nContext();
  const selected = parentGroup.selectedChildId === group.id;
  const content = (
    <>
      <span className="route-child-copy">
        <strong className="user-authored-label" title={group.label}>
          {group.label}
        </strong>
        <span>{LL.routes.groupReferenceType({ type: getGroupTypeLabel(LL, group) })}</span>
      </span>
      <span className="route-child-status">
        <DelayResult result={delayResult} />
        {selected ? (
          <span className="route-selected-status">
            <Check aria-hidden="true" />
            {LL.routes.selected()}
          </span>
        ) : null}
      </span>
    </>
  );

  if (parentGroup.type !== "selector") {
    return <div className="route-child-row route-group-reference">{content}</div>;
  }

  return (
    <Button
      aria-describedby={commandDescriptionId}
      aria-label={LL.routes.selectChild({ child: group.label, group: parentGroup.label })}
      aria-pressed={selected}
      className="route-child-row route-child-select route-group-reference"
      disabled={commandPending || !commandSupported}
      loading={selectionPending}
      loadingText={LL.common.pending()}
      onClick={() => onSelect(parentGroup.id, group.id)}
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
  delayPendingAction:
    | { groupId: string; kind: "start" }
    | { kind: "cancel"; testId: string }
    | null;
  delayPolicy: GroupDelayPolicyDto;
  delayTest: GroupDelayTestDto;
  disabled: boolean;
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
  pendingSelectionId?: string;
  search: RouteSearchState;
  sortByGroupId: ReadonlyMap<string, RouteSort>;
}

function RouteGroup({
  commandDescriptionId,
  commandSupported,
  delayCommandPending,
  delayCommandSupported,
  delayPendingAction,
  delayPolicy,
  delayTest,
  disabled,
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
  pendingSelectionId,
  search,
  sortByGroupId,
}: RouteGroupProps) {
  const { LL } = useI18nContext();
  const hasChildren = group.childIds.length > 0;
  const expanded =
    !disabled &&
    hasChildren &&
    (expandedGroupIds.has(group.id) || search.autoExpandedGroupIds.has(group.id));
  const childrenId = `route-group-${encodeURIComponent(group.id)}`;
  const currentChild = getEntityLabel(graph, group.selectedChildId);
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
    </>
  );

  return (
    <li className="route-group-item">
      <article className="route-group" data-disabled={disabled ? "true" : undefined}>
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
              disabled={disabled}
              onClick={() => onToggle(group.id)}
              variant="ghost"
            >
              {headerContent}
            </Button>
          ) : (
            <div className="route-group-toggle route-group-static">{headerContent}</div>
          )}
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
                    disabled={delayCommandPending}
                    loading={
                      delayCommandPending &&
                      delayPendingAction?.kind === "cancel" &&
                      delayPendingAction.testId === delayTest.testId
                    }
                    loadingText={LL.routes.cancelDelayButton()}
                    aria-label={LL.routes.cancelDelay({ group: group.label })}
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
                    loading={
                      delayCommandPending &&
                      delayPendingAction?.kind === "start" &&
                      delayPendingAction.groupId === group.id
                    }
                    loadingText={LL.routes.startDelayButton()}
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
                      <li key={childId}>
                        <RouteGroupReferenceRow
                          commandDescriptionId={commandDescriptionId}
                          commandPending={isGroupCommandPending(group.id)}
                          commandSupported={commandSupported}
                          delayResult={getGroupDelayResult(delayTest, group.id, childId)}
                          group={childGroup}
                          onSelect={onSelect}
                          parentGroup={group}
                          selectionPending={pendingSelectionId === childId}
                        />
                      </li>
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
                        selectionPending={pendingSelectionId === childId}
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
  const [pendingSelections, setPendingSelections] = useState<Map<string, string>>(() => new Map());
  const [delayPendingAction, setDelayPendingAction] = useState<
    { groupId: string; kind: "start" } | { kind: "cancel"; testId: string } | null
  >(null);
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
  const modeGroups = snapshot.groups
    .filter((group) => snapshot.routingMode === "global" || !isGlobalGroup(group))
    .toSorted((first, second) => {
      if (snapshot.routingMode !== "global") return 0;
      return Number(isGlobalGroup(second)) - Number(isGlobalGroup(first));
    });
  const visibleGroupIds = modeGroups
    .map((group) => group.id)
    .filter((groupId) => !search.queryActive || search.visibleEntityIds.has(groupId));

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
    try {
      await selectGroupChild(groupId, childId);
    } finally {
      setPendingSelections((current) => {
        const next = new Map(current);
        next.delete(groupId);
        return next;
      });
    }
  }

  async function startDelay(groupId: string) {
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

  return (
    <div className="routes-page page-scroll">
      <div className="routes-workspace">
        <header className="routes-header">
          <h1>{LL.routes.title()}</h1>
          <p>{LL.routes.description()}</p>
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
        ) : visibleGroupIds.length === 0 ? (
          <Empty className="routes-empty">
            <EmptyHeader>
              <EmptyTitle>{LL.routes.noMatchesTitle()}</EmptyTitle>
              <EmptyDescription>{LL.routes.noMatchesDescription()}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <section aria-label={LL.routes.title()} className="routes-graph">
            <ul className="route-root-list">
              {visibleGroupIds.map((groupId) => {
                const group = graph.groupById.get(groupId);
                if (!group) return null;
                const pendingSelectionId = pendingSelections.get(groupId);
                const displayedGroup = pendingSelectionId
                  ? { ...group, selectedChildId: pendingSelectionId }
                  : group;
                return (
                  <RouteGroup
                    commandDescriptionId={commandDescriptionId}
                    commandSupported={commandSupported}
                    delayCommandPending={delayCommandPending}
                    delayCommandSupported={delayCommandSupported}
                    delayPendingAction={delayPendingAction}
                    delayPolicy={snapshot.groupDelayPolicy}
                    delayTest={snapshot.groupDelayTest}
                    disabled={snapshot.routingMode === "global" && !isGlobalGroup(group)}
                    expandedGroupIds={expandedGroupIds}
                    graph={graph}
                    group={displayedGroup}
                    isGroupCommandPending={isGroupCommandPending}
                    key={groupId}
                    locale={locale}
                    onCancelDelay={(testId) => void cancelDelay(testId)}
                    onSelect={(groupId, childId) => void selectChild(groupId, childId)}
                    onSort={changeSort}
                    onStartDelay={(groupId) => void startDelay(groupId)}
                    onToggle={toggleGroup}
                    pendingSelectionId={pendingSelectionId}
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
