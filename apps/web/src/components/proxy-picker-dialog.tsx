import { ArrowLeft } from "@phosphor-icons/react/ArrowLeft";
import type { GroupDelayChildResultDto } from "@mish/contracts";
import { Button, Dialog, DialogContent, DialogDescription, DialogTitle } from "@mish/ui";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useNotificationDelivery } from "../data/notification-delivery";
import { useProduct } from "../data/product-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { TranslationFunctions } from "../i18n/i18n-types";
import {
  BoundedEntityList,
  LatencyStatus,
  PolicyBrowserToolbar,
  PolicyEntityRow,
} from "./policy-browser";
import {
  filterDirectPolicyChildIds,
  getGroupDelayResult,
  getRouteChildLatency,
  sortRouteChildIds,
  type RouteGraph,
  type RouteSort,
} from "../pages/routes-model";

const routeSorts: RouteSort[] = ["configuration", "latency", "label"];

function sortLabel(LL: TranslationFunctions, sort: RouteSort) {
  if (sort === "configuration") return LL.routes.configurationOrder();
  if (sort === "latency") return LL.routes.latency();
  return LL.routes.labelOrder();
}

function failureLabel(LL: TranslationFunctions, result: GroupDelayChildResultDto) {
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

interface PolicyPickerDialogProps {
  graph: RouteGraph;
  groupId: string | null;
  onOpenChange(open: boolean): void;
  open: boolean;
  readOnly?: boolean;
}

export function PolicyPickerDialog({
  graph,
  groupId,
  onOpenChange,
  open,
  readOnly = false,
}: PolicyPickerDialogProps) {
  const {
    cancelGroupDelayTest,
    isCommandPending,
    isCommandSupported,
    isGroupCommandPending,
    selectGroupChild,
    snapshot,
    startGroupDelayTest,
  } = useProduct();
  const { publish } = useNotificationDelivery();
  const { LL, locale } = useI18nContext();
  const [navigationStack, setNavigationStack] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [sortByGroupId, setSortByGroupId] = useState<Map<string, RouteSort>>(() => new Map());
  const [pendingSelectionId, setPendingSelectionId] = useState<string | null>(null);
  const [delayBusy, setDelayBusy] = useState(false);
  const [frozenDelayOrder, setFrozenDelayOrder] = useState<readonly string[] | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  function focusSearch() {
    const search = dialogRef.current?.querySelector<HTMLInputElement>("input[type=search]");
    search?.focus({ preventScroll: true });
    search?.select();
  }

  useEffect(() => {
    if (!open || !groupId) return;
    setNavigationStack([groupId]);
    setQuery("");
    setPendingSelectionId(null);
    setFrozenDelayOrder(null);
  }, [groupId, open]);

  useEffect(() => {
    const phase = snapshot?.groupDelayTest.phase;
    if (phase !== "pending" && phase !== "progress") setFrozenDelayOrder(null);
  }, [snapshot?.groupDelayTest.phase]);

  const currentGroupId = navigationStack.at(-1) ?? groupId;
  const group = currentGroupId ? graph.groupById.get(currentGroupId) : undefined;
  const language = locale === "zh" ? "zh-CN" : "en";
  const sort: RouteSort = currentGroupId
    ? (sortByGroupId.get(currentGroupId) ?? "configuration")
    : "configuration";
  const directChildIds = useMemo(() => {
    if (!group) return [];
    const filtered = filterDirectPolicyChildIds(graph, group, query, language);
    const filteredSet = new Set(filtered);
    const sortedIds =
      frozenDelayOrder &&
      snapshot?.groupDelayTest.groupId === group.id &&
      (snapshot.groupDelayTest.phase === "pending" || snapshot.groupDelayTest.phase === "progress")
        ? [...frozenDelayOrder]
        : sortRouteChildIds(graph, group, sort, language, snapshot?.groupDelayTest);
    return sortedIds.filter((childId) => filteredSet.has(childId));
  }, [frozenDelayOrder, graph, group, language, query, snapshot?.groupDelayTest, sort]);

  if (!group || !snapshot) return null;
  const activeGroupId = group.id;

  const delayTest = snapshot.groupDelayTest;
  const delayIsActive = delayTest.phase === "pending" || delayTest.phase === "progress";
  const delayMatchesGroup = delayIsActive && delayTest.groupId === group.id;
  const activeDelayGroup = delayTest.groupId
    ? (graph.groupById.get(delayTest.groupId)?.label ?? delayTest.groupId)
    : "";
  const completedDelayChildren = delayMatchesGroup
    ? delayTest.children.filter((child) => child.phase !== "pending").length
    : 0;
  const groupCommandsSupported = isCommandSupported("group") && !readOnly;
  const groupSelectionPending = isGroupCommandPending(group.id);
  const delaySupported = isCommandSupported("group-delay") && !readOnly;
  const pathLabels = navigationStack.map(
    (pathGroupId) => graph.groupById.get(pathGroupId)?.label ?? pathGroupId,
  );

  function navigateBack() {
    if (navigationStack.length <= 1) return;
    const returningGroupId = navigationStack.at(-1)!;
    setNavigationStack((current) => current.slice(0, -1));
    setQuery("");
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-entity-id="${CSS.escape(returningGroupId)}"]`)
        ?.querySelector<HTMLElement>("[data-policy-row-primary], .policy-browser-browse")
        ?.focus({ preventScroll: true });
    });
  }

  function browseGroup(childGroupId: string) {
    setNavigationStack((current) => [...current, childGroupId]);
    setQuery("");
    requestAnimationFrame(focusSearch);
  }

  async function selectChild(childId: string) {
    if (isGroupCommandPending(activeGroupId) || !groupCommandsSupported) return;
    setPendingSelectionId(childId);
    const result = await selectGroupChild(activeGroupId, childId);
    setPendingSelectionId(null);
    if (result.ok) {
      onOpenChange(false);
      return;
    }
    publish({
      id: `policy-selection-failed-${activeGroupId}`,
      level: "error",
      message: LL.routes.selectionFailed({
        child: graph.nodeById.get(childId)?.label ?? graph.groupById.get(childId)?.label ?? childId,
      }),
      title: LL.routes.selectionFailedTitle(),
    });
    requestAnimationFrame(() => {
      document
        .querySelector<HTMLElement>(`[data-entity-id="${CSS.escape(childId)}"]`)
        ?.querySelector<HTMLElement>("[data-policy-row-primary]")
        ?.focus({ preventScroll: true });
    });
  }

  async function startDelay() {
    if (!group) return;
    setFrozenDelayOrder(sortRouteChildIds(graph, group, sort, language, delayTest));
    setDelayBusy(true);
    try {
      await startGroupDelayTest(activeGroupId);
    } finally {
      setDelayBusy(false);
    }
  }

  async function cancelDelay() {
    if (!delayMatchesGroup || !delayTest.testId) return;
    setDelayBusy(true);
    try {
      await cancelGroupDelayTest(delayTest.testId);
    } finally {
      setDelayBusy(false);
    }
  }

  function handleDialogKeys(event: KeyboardEvent<HTMLDivElement>) {
    if ((event.metaKey || event.ctrlKey) && event.key.toLocaleLowerCase() === "f") {
      event.preventDefault();
      focusSearch();
    }
  }

  const delayProgress = delayMatchesGroup
    ? LL.routes.delayStateProgress({
        completed: completedDelayChildren,
        state: LL.routes.delayPhaseProgress(),
        total: delayTest.children.length,
      })
    : delayIsActive
      ? LL.routes.delayTestingGroup({ group: activeDelayGroup })
      : LL.routes.delayPolicy({
          policy: snapshot.groupDelayPolicy.id,
          seconds: snapshot.groupDelayPolicy.timeoutMilliseconds / 1000,
        });

  return (
    <Dialog
      onOpenChange={(nextOpen, details) => {
        if (!nextOpen && details.reason === "escape-key") {
          if (query) {
            details.cancel();
            setQuery("");
            return;
          }
          if (navigationStack.length > 1) {
            details.cancel();
            navigateBack();
            return;
          }
        }
        onOpenChange(nextOpen);
      }}
      open={open}
    >
      <DialogContent
        className="proxy-picker-dialog policy-picker-dialog"
        closeLabel={LL.common.close()}
        onKeyDownCapture={handleDialogKeys}
        ref={dialogRef}
      >
        <div className="proxy-picker-header policy-picker-header">
          {navigationStack.length > 1 ? (
            <Button
              aria-label={LL.routes.backToGroup({ group: pathLabels.at(-2) ?? "" })}
              className="policy-picker-back"
              onClick={navigateBack}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <ArrowLeft aria-hidden="true" />
            </Button>
          ) : null}
          <div>
            <DialogTitle className="proxy-picker-title user-authored-label">
              {group.label}
            </DialogTitle>
            <DialogDescription className="proxy-picker-description">
              {LL.proxyPicker.description()}
            </DialogDescription>
            <div aria-label={LL.routes.currentPath()} className="policy-picker-breadcrumb">
              {pathLabels.join(" / ")}
            </div>
          </div>
        </div>
        {readOnly ? (
          <p className="policy-browser-read-only" role="status">
            {LL.routes.configuredReadOnly()}
          </p>
        ) : null}
        <PolicyBrowserToolbar
          cancelAriaLabel={LL.routes.cancelDelay({ group: group.label })}
          cancelLabel={LL.routes.cancelDelayButton()}
          delayActive={delayMatchesGroup}
          delayBusy={delayBusy || isCommandPending("group-delay")}
          delayDisabled={!delaySupported || delayIsActive || group.childIds.length === 0}
          delayProgress={delayProgress}
          onCancel={() => void cancelDelay()}
          onQueryChange={setQuery}
          onSortChange={(nextSort) =>
            setSortByGroupId((current) => new Map(current).set(activeGroupId, nextSort))
          }
          onTest={() => void startDelay()}
          query={query}
          searchLabel={LL.proxyPicker.searchAria()}
          searchPlaceholder={LL.proxyPicker.searchPlaceholder()}
          sort={sort}
          sortDisabled={delayMatchesGroup}
          sortLabel={LL.routes.sortChildren({ group: group.label })}
          sortOptionLabel={(option) => sortLabel(LL, option)}
          sorts={routeSorts}
          testLabel={LL.routes.startDelayButton()}
          testAriaLabel={LL.routes.startDelay({ group: group.label })}
        />
        <span aria-live="polite" className="sr-only" role="status">
          {LL.routes.searchResultCount({ count: directChildIds.length })}
        </span>
        <div className="policy-picker-list">
          <BoundedEntityList
            empty={<p className="command-empty">{LL.proxyPicker.empty()}</p>}
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
                const delayResult = getGroupDelayResult(delayTest, group.id, childId);
                const canSelectNode = group.type === "selector" && Boolean(node) && !readOnly;
                const canSelectGroup =
                  group.type === "selector" && childGroup?.type === "selector" && !readOnly;
                return (
                  <li key={childId}>
                    <PolicyEntityRow
                      browseLabel={
                        childGroup ? LL.routes.browseGroup({ group: childGroup.label }) : undefined
                      }
                      currentLabel={LL.routes.selected()}
                      density="compact"
                      disabled={groupSelectionPending}
                      entity={entity}
                      entityKind={childGroup ? "group" : "node"}
                      latency={
                        <LatencyStatus
                          cancelledLabel={LL.routes.delayCancelled()}
                          failureLabel={(result) => failureLabel(LL, result)}
                          latencyMilliseconds={
                            node?.latencyMilliseconds ?? getRouteChildLatency(graph, childId)
                          }
                          measuredLabel={(latency) => LL.routes.latencyMilliseconds({ latency })}
                          result={delayResult}
                          testingLabel={LL.routes.delayPending()}
                          unknownLabel={LL.routes.latencyUnavailable()}
                        />
                      }
                      metadata={
                        node?.protocol ??
                        LL.routes.groupReferenceType({
                          type:
                            childGroup?.type === "unsupported"
                              ? childGroup.unsupportedType
                              : (childGroup?.type ?? ""),
                        })
                      }
                      onBrowse={childGroup ? () => browseGroup(childGroup.id) : undefined}
                      onSelect={
                        canSelectNode || canSelectGroup
                          ? () => void selectChild(childId)
                          : undefined
                      }
                      pendingLabel={LL.routes.switching()}
                      readOnlyLabel={LL.routes.readOnly()}
                      selectLabel={LL.routes.selectChild({
                        child: entity.label,
                        group: group.label,
                      })}
                      selected={group.selectedChildId === childId}
                      selectionPending={pendingSelectionId === childId}
                    />
                  </li>
                );
              })
            }
          </BoundedEntityList>
        </div>
      </DialogContent>
    </Dialog>
  );
}

export { PolicyPickerDialog as ProxyPickerDialog };
