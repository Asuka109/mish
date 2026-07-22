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
  ProfileRouteCatalogDto,
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
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { tv } from "tailwind-variants";
import { useOptionalProfiles } from "../data/profile-provider";
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

const routeStyles = tv({
  slots: {
    delayResult: "route-delay-result grid min-w-[74px] text-right text-(--text-metadata)",
    delayTime: "text-[10px] text-(--color-text-subtle)",
    childRow:
      "route-child-row grid min-h-[52px] w-full grid-cols-[minmax(0,1fr)_auto] items-center gap-4 rounded-none border-0 bg-(--color-canvas) py-[7px] pr-[14px] pl-11 text-left text-(--color-body)",
    childSelectable:
      "route-child-select hover:bg-(--color-accent) hover:text-(--color-ink) aria-pressed:bg-(--color-accent) aria-pressed:text-(--color-ink)",
    childCopy:
      "route-child-copy grid min-w-0 gap-0.5 [&>*]:overflow-hidden [&>*]:text-ellipsis [&>*]:whitespace-nowrap [&_strong]:font-(--font-weight-control) [&_span]:text-(--text-metadata) [&_span]:text-(--color-text-muted)",
    childStatus: "route-child-status inline-flex items-center justify-end gap-[14px]",
    latency: "route-latency text-(--text-metadata) text-(--color-text-muted)",
    selectedStatus:
      "route-selected-status inline-flex items-center gap-[5px] text-[12px] text-(--color-success-text) [&_svg]:size-[13px]",
    group:
      "route-group min-w-0 overflow-hidden rounded-(--radius-md) border border-(--color-hairline) bg-(--color-canvas) data-[disabled=true]:opacity-[0.55]",
    groupHeader: "route-group-header flex min-h-[58px] min-w-0 items-stretch",
    groupToggle:
      "route-group-toggle grid min-h-[58px] min-w-0 w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center justify-stretch gap-2.5 rounded-none border-0 bg-transparent px-3 py-2 text-left text-(--color-body) hover:bg-(--color-accent) hover:text-(--color-ink)",
    chevron:
      "route-group-chevron grid place-items-center text-(--color-text-muted) [&_svg]:size-[14px]",
    groupCopy: "route-group-copy grid min-w-0 gap-[3px]",
    groupTitle:
      "route-group-title-line flex min-w-0 items-center gap-2 [&_strong]:min-w-0 [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:whitespace-nowrap [&_strong]:font-(--font-weight-control) [&_.ui-badge]:h-5 [&_.ui-badge]:shrink-0 [&_.ui-badge]:rounded-(--radius-sm) [&_.ui-badge]:bg-transparent [&_.ui-badge]:font-normal",
    groupCurrent:
      "route-group-current overflow-hidden text-(--text-metadata) text-(--color-text-muted) text-ellipsis whitespace-nowrap",
    groupBody: "route-group-body border-t border-(--color-hairline) bg-(--color-surface-soft)",
    groupTools:
      "route-group-tools grid min-h-[78px] gap-px px-[10px] py-[7px] pl-[14px] text-[12px] text-(--color-text-muted)",
    toolsRow: "flex min-w-0 items-center justify-between gap-4",
    delayTools: "border-t border-(--color-hairline-soft) pt-[5px]",
    delayCopy:
      "route-delay-copy grid min-w-0 gap-px overflow-hidden text-ellipsis whitespace-nowrap [&_strong]:overflow-hidden [&_strong]:text-ellipsis [&_strong]:font-(--font-weight-control) [&_strong]:text-(--color-ink) [&_span]:overflow-hidden [&_span]:text-ellipsis [&_span]:text-(--color-text-muted)",
    rootList: "route-root-list m-0 flex list-none flex-col gap-3 p-0",
    childrenList:
      "route-children-list m-0 flex list-none flex-col gap-px bg-(--color-hairline-soft) p-0 [&>li]:min-w-0 [&>li]:bg-(--color-canvas)",
    empty:
      "route-group-empty border-t border-(--color-hairline-soft) bg-(--color-canvas) px-[14px] py-[18px] text-center text-(--text-metadata) text-(--color-text-muted)",
  },
  variants: {
    delayPhase: {
      pending: "text-(--color-text-muted)",
      success: "text-(--color-success-text)",
      failed: "text-(--color-error)",
      cancelled: "text-(--color-error)",
    },
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
    <span className={routeStyles({ delayPhase: result.phase }).delayResult()}>
      <span>{outcome}</span>
      {result.observedAt === null ? null : (
        <time
          className={routeStyles().delayTime()}
          dateTime={new Date(result.observedAt).toISOString()}
        >
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
      <span className={routeStyles().childCopy()}>
        <strong className="user-authored-label" title={node.label}>
          {node.label}
        </strong>
        <span>{node.protocol}</span>
      </span>
      <span className={routeStyles().childStatus()}>
        {delayResult ? (
          <DelayResult result={delayResult} />
        ) : (
          <span className={`${routeStyles().latency()} tabular`}>
            {node.latencyMilliseconds === null
              ? LL.routes.latencyUnavailable()
              : LL.routes.latencyMilliseconds({ latency: node.latencyMilliseconds })}
          </span>
        )}
        {selected ? (
          <span className={routeStyles().selectedStatus()}>
            <Check aria-hidden="true" />
            {LL.routes.selected()}
          </span>
        ) : null}
      </span>
    </>
  );

  if (group.type !== "selector") {
    return <div className={routeStyles().childRow()}>{content}</div>;
  }

  return (
    <Button
      aria-describedby={commandDescriptionId}
      aria-label={LL.routes.selectChild({ child: node.label, group: group.label })}
      aria-pressed={selected}
      className={`${routeStyles().childRow()} ${routeStyles().childSelectable()}`}
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
      <span className={routeStyles().childCopy()}>
        <strong className="user-authored-label" title={group.label}>
          {group.label}
        </strong>
        <span>{LL.routes.groupReferenceType({ type: getGroupTypeLabel(LL, group) })}</span>
      </span>
      <span className={routeStyles().childStatus()}>
        <DelayResult result={delayResult} />
        {selected ? (
          <span className={routeStyles().selectedStatus()}>
            <Check aria-hidden="true" />
            {LL.routes.selected()}
          </span>
        ) : null}
      </span>
    </>
  );

  if (parentGroup.type !== "selector") {
    return <div className={`${routeStyles().childRow()} route-group-reference`}>{content}</div>;
  }

  return (
    <Button
      aria-describedby={commandDescriptionId}
      aria-label={LL.routes.selectChild({ child: group.label, group: parentGroup.label })}
      aria-pressed={selected}
      className={`${routeStyles().childRow()} ${routeStyles().childSelectable()} route-group-reference`}
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
      <span className={routeStyles().chevron()}>
        {expanded ? <CaretDown aria-hidden="true" /> : <CaretRight aria-hidden="true" />}
      </span>
      <span className={routeStyles().groupCopy()}>
        <span className={routeStyles().groupTitle()}>
          <strong className="user-authored-label" title={group.label}>
            {group.label}
          </strong>
          <Badge variant="outline">{getGroupTypeLabel(LL, group)}</Badge>
        </span>
        <span className={`${routeStyles().groupCurrent()} user-authored-label`}>
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
      <article className={routeStyles().group()} data-disabled={disabled ? "true" : undefined}>
        <div className={routeStyles().groupHeader()}>
          {hasChildren ? (
            <Button
              aria-controls={childrenId}
              aria-expanded={expanded}
              aria-label={
                expanded
                  ? LL.routes.collapseGroup({ group: group.label })
                  : LL.routes.expandGroup({ group: group.label })
              }
              className={routeStyles().groupToggle()}
              disabled={disabled}
              onClick={() => onToggle(group.id)}
              variant="ghost"
            >
              {headerContent}
            </Button>
          ) : (
            <div className={`${routeStyles().groupToggle()} route-group-static`}>
              {headerContent}
            </div>
          )}
        </div>

        {expanded ? (
          <div className={routeStyles().groupBody()} id={childrenId}>
            <div className={routeStyles().groupTools()}>
              <div className={routeStyles().toolsRow()}>
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
              <div className={`${routeStyles().toolsRow()} ${routeStyles().delayTools()}`}>
                <span className={routeStyles().delayCopy()}>
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
              <ul className={routeStyles().childrenList()}>
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
              <p className={routeStyles().empty()}>{LL.routes.noChildren()}</p>
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
  const profiles = useOptionalProfiles();
  const { LL, locale } = useI18nContext();
  const [query, setQuery] = useState("");
  const deferredQuery = useDeferredValue(query);
  const [expandedGroupIds, setExpandedGroupIds] = useState<Set<string>>(() => new Set());
  const [sortByGroupId, setSortByGroupId] = useState<Map<string, RouteSort>>(() => new Map());
  const [pendingSelections, setPendingSelections] = useState<Map<string, string>>(() => new Map());
  const [delayPendingAction, setDelayPendingAction] = useState<
    { groupId: string; kind: "start" } | { kind: "cancel"; testId: string } | null
  >(null);
  const configuredProfileId =
    snapshot &&
    snapshot.groups.length === 0 &&
    snapshot.runtime.phase !== "healthy" &&
    profiles?.selectedProfileId
      ? profiles.selectedProfileId
      : null;
  const [configuredRoutes, setConfiguredRoutes] = useState<ProfileRouteCatalogDto | null>(null);
  const configuredRoutesActive =
    configuredProfileId !== null && configuredRoutes?.profileId === configuredProfileId;
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
    if (!configuredProfileId || !profiles) {
      setConfiguredRoutes(null);
      return;
    }
    let cancelled = false;
    void profiles.loadRoutes(configuredProfileId).then((result) => {
      if (cancelled || !result.ok) return;
      setConfiguredRoutes(result.catalog);
    });
    return () => {
      cancelled = true;
    };
  }, [configuredProfileId, profiles]);

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
  const liveCommandSupported = commandSupported && !configuredRoutesActive;
  const delayCommandSupported = isCommandSupported("group-delay") && !configuredRoutesActive;
  const delayCommandPending = isCommandPending("group-delay");
  const commandDescriptionId = getCommandDescriptionId(snapshot.adapterKind, liveCommandSupported);
  const modeGroups = groups.filter((group) => routingMode === "global" || !isGlobalGroup(group));
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
    <div className="routes-page">
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
        ) : groups.length === 0 ? (
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
            <ul className={routeStyles().rootList()}>
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
                    commandSupported={liveCommandSupported}
                    delayCommandPending={delayCommandPending}
                    delayCommandSupported={delayCommandSupported}
                    delayPendingAction={delayPendingAction}
                    delayPolicy={snapshot.groupDelayPolicy}
                    delayTest={snapshot.groupDelayTest}
                    disabled={routingMode === "global" && !isGlobalGroup(group)}
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
