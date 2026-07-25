import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { Pause } from "@phosphor-icons/react/Pause";
import { Play } from "@phosphor-icons/react/Play";
import { Question } from "@phosphor-icons/react/Question";
import type {
  EffectiveRuleDto,
  TrafficCommandAuthorityDto,
  TrafficConnectionDto,
} from "@mish/contracts";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  Badge,
  Button,
  Dialog,
  DialogFooter,
  DialogHeader,
  DialogContent,
  DialogDescription,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Field,
  FieldLabel,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
  ToggleGroup,
  ToggleGroupItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mish/ui";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { cx, tv } from "@mish/ui/tv";
import { notificationPublication, useNotificationDelivery } from "../data/notification-delivery";
import { useTraffic } from "../data/traffic-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";
import {
  TRAFFIC_RENDER_BATCH_SIZE,
  destinationLabel,
  filterConnections,
  filterRules,
  sortConnections,
  sortRules,
  type ClosedTrafficConnection,
  type ConnectionSort,
  type RuleSort,
} from "./traffic-model";
import { formatConnectionProtocolLabel, formatNetworkIdentifier } from "./traffic-presentation";

type TrafficTab = "active" | "closed" | "rules";
type SelectedConnection = TrafficConnectionDto | ClosedTrafficConnection;
interface CloseVisibleTarget {
  authority: TrafficCommandAuthorityDto;
  connectionIds: string[];
}

const connectionSortValues: ConnectionSort[] = [
  "started-desc",
  "destination-asc",
  "download-desc",
  "upload-desc",
];
const ruleSortValues: RuleSort[] = ["priority-asc", "type-asc", "target-asc", "hits-desc"];

const trafficStyles = tv({
  slots: {
    page: cx(
      "traffic-page w-full px-7 pt-7 pb-9 max-page-compact:px-6 max-page-compact:pt-6",
      "max-page-compact:pb-8 max-shell-mobile:px-4 max-shell-mobile:pt-4.5 max-shell-mobile:pb-6",
    ),
    header: cx(
      "flex items-start justify-between gap-6 max-toolbar-compact:flex-col",
      "max-toolbar-compact:items-stretch [&_p]:mt-1.25 [&_p]:text-metadata",
      "[&_p]:text-muted-foreground",
    ),
    actions: "flex flex-wrap gap-2 max-toolbar-compact:self-start",
    sourceStatus: cx(
      "mt-5 flex min-h-9.5 items-center justify-between gap-4 rounded-md border border-hairline",
      "bg-surface-soft px-3 py-2 text-metadata text-fg",
      "data-[state=stale]:border-feedback-warning-border data-[state=stale]:text-warning",
      "[&>span:last-child]:shrink-0 [&>span:last-child]:text-caption",
      "[&>span:last-child]:text-muted-foreground max-toolbar-compact:flex-col",
      "max-toolbar-compact:items-start max-toolbar-compact:gap-1",
    ),
    attributionNotice: "mt-2 text-metadata text-muted-foreground",
    tabs: "mt-5",
    viewButton: cx(
      "traffic-view-switch-button gap-1.75 px-3 [&_.ui-badge]:min-w-5 [&_.ui-badge]:justify-center",
      "[&_.ui-badge]:px-1.25",
    ),
    tools:
      "my-3 flex flex-wrap items-center gap-2 max-toolbar-compact:flex-col max-toolbar-compact:items-stretch",
    searchRow: "flex min-w-60 flex-1 items-center gap-2 max-shell-mobile:min-w-0",
    searchField: "min-w-0 flex-1",
    searchControl: cx(
      "relative flex items-center [&>svg]:pointer-events-none [&>svg]:absolute [&>svg]:left-2.75",
      "[&>svg]:size-4 [&>svg]:text-muted-foreground [&_.ui-input]:pl-8.5",
    ),
    searchHelp: "shrink-0 text-muted-foreground hover:text-fg",
    searchHelpDialog: "w-[min(520px,calc(100vw_-_32px))]",
    searchHelpContent: "grid gap-3 px-4 py-1 text-metadata leading-5 text-fg",
    searchExamples: cx(
      "grid gap-2 [&_code]:select-text [&_code]:rounded-sm [&_code]:border [&_code]:border-border",
      "[&_code]:bg-surface-soft [&_code]:px-2.5 [&_code]:py-2 [&_code]:text-fg",
    ),
    connectionTable: cx(
      "traffic-table min-w-270 table-fixed [&_.ui-table-head:nth-child(1)]:w-44.5",
      "[&_.ui-table-head:nth-child(2)]:w-33 [&_.ui-table-head:nth-child(3)]:w-28",
      "[&_.ui-table-head:nth-child(4)]:w-28 [&_.ui-table-head:nth-child(5)]:w-28",
      "[&_.ui-table-head:nth-child(6)]:w-28 [&_.ui-table-head:last-child]:w-25",
    ),
    connectionRow: cx(
      "cursor-pointer outline-none focus-visible:outline-2 focus-visible:outline-focus-accent",
      "focus-visible:outline-offset-[-2px]",
    ),
    connectionAction: "text-clip",
    rulesTable: cx(
      "traffic-table min-w-190 table-fixed [&_.ui-table-head:nth-child(1)]:w-23",
      "[&_.ui-table-head:nth-child(2)]:w-37.5 [&_.ui-table-head:nth-child(5)]:w-23",
      "[&_.ui-table-head:nth-child(6)]:w-23 [&_.ui-table-head:last-child]:w-23",
    ),
    destination: cx(
      "inline-flex h-auto min-h-0 w-full justify-start gap-0.5 overflow-hidden rounded-none",
      "border-0 bg-transparent p-0 text-left text-ink hover:bg-transparent [&_span]:truncate",
      "[&_small]:text-metadata [&_small]:text-muted-foreground",
    ),
    processIdentity: "flex min-w-0 items-center gap-2",
    processIcon: "size-5 shrink-0 rounded-sm object-contain",
    processName: "truncate",
    rule: cx(
      "block overflow-hidden text-ellipsis font-medium text-fg [&+small]:block",
      "[&+small]:overflow-hidden [&+small]:text-ellipsis [&+small]:text-muted-foreground",
    ),
    empty: "mt-4 min-h-55 rounded-md border border-hairline",
    loadMore: "mt-3 flex items-center justify-end gap-3 pt-4 text-metadata text-muted-foreground",
    detailDialog: cx(
      "traffic-detail-dialog flex max-h-[min(760px,calc(100vh_-_48px))] flex-col",
      "w-[min(680px,calc(100vw_-_32px))] overflow-hidden",
    ),
    detailHeader: "shrink-0",
    detailBody: cx(
      "traffic-detail-body min-h-0 flex-1 cursor-text overflow-x-hidden overflow-y-auto",
      "overscroll-contain select-text",
    ),
    detailFooter: "shrink-0",
    detailGrid: cx(
      "m-4 grid grid-cols-2 gap-px overflow-hidden rounded-md border border-hairline",
      "bg-hairline-soft max-shell-mobile:m-3 max-shell-mobile:grid-cols-1 [&>div]:min-w-0",
      "[&>div]:bg-canvas [&>div]:px-3 [&>div]:py-2.5 [&_dt]:text-caption",
      "[&_dt]:text-muted-foreground [&_dd]:mt-0.75 [&_dd]:wrap-anywhere",
      "[&_dd]:text-metadata [&_dd]:text-fg",
    ),
    chain: cx(
      "px-4 pb-4 [&_ol]:mt-2 [&_ol]:flex [&_ol]:list-none [&_ol]:flex-col [&_ol]:gap-px",
      "[&_ol]:overflow-hidden [&_ol]:rounded-md [&_ol]:border [&_ol]:border-hairline",
      "[&_ol]:bg-hairline-soft [&_ol]:p-0 [&_li]:grid [&_li]:min-h-9.5",
      "[&_li]:grid-cols-[28px_minmax(0,1fr)] [&_li]:items-center [&_li]:gap-2 [&_li]:bg-canvas",
      "[&_li]:px-2.5 [&_li>span]:text-caption [&_li>span]:text-muted-foreground",
      "[&_li>strong]:truncate [&_li>strong]:text-metadata [&_li>strong]:font-medium",
    ),
  },
});

export function TrafficPage() {
  const { publish } = useNotificationDelivery();
  const { LL, locale } = useI18nContext();
  const {
    clearClosed,
    closeAllActive,
    closeConnection,
    closeFilteredVisible,
    closed,
    connection,
    error,
    isCloseAllPending,
    isCloseConnectionPending,
    isCloseFilteredVisiblePending,
    isCommandSupported,
    isCurrent,
    isLoading,
    isViewPaused,
    pausedAt,
    pausedUpdateCount,
    snapshot,
    toggleViewPause,
  } = useTraffic();
  const [searchParams, setSearchParams] = useSearchParams();
  const [tab, setTab] = useState<TrafficTab>(() => trafficTab(searchParams.get("tab")));
  const [query, setQuery] = useState("");
  const [network, setNetwork] = useState("all");
  const [connectionSort, setConnectionSort] = useState<ConnectionSort>("started-desc");
  const [ruleSort, setRuleSort] = useState<RuleSort>("priority-asc");
  const [visibleLimit, setVisibleLimit] = useState(TRAFFIC_RENDER_BATCH_SIZE);
  const [selectedConnection, setSelectedConnection] = useState<SelectedConnection | null>(null);
  const [closeTarget, setCloseTarget] = useState<TrafficConnectionDto | null>(null);
  const [closeVisibleTarget, setCloseVisibleTarget] = useState<CloseVisibleTarget | null>(null);
  const [closeAllConfirmationOpen, setCloseAllConfirmationOpen] = useState(false);
  const [searchHelpOpen, setSearchHelpOpen] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const activeConnections = isCurrent ? (snapshot?.activeConnections ?? []) : [];
  const networks = useMemo(() => {
    const identifiers = new Map<string, string>();
    for (const connection of [...activeConnections, ...closed]) {
      const normalized = connection.network.toLocaleLowerCase();
      if (!identifiers.has(normalized)) identifiers.set(normalized, connection.network);
    }
    return [
      { label: LL.traffic.allNetworks(), value: "all" },
      ...[...identifiers].map(([value, raw]) => ({
        label: formatNetworkIdentifier(raw),
        value,
      })),
    ];
  }, [LL, activeConnections, closed]);
  const filteredConnections = useMemo(() => {
    const source = tab === "closed" ? closed : activeConnections;
    return sortConnections(
      filterConnections(source, deferredQuery, tab === "closed" ? "closed" : "active", network),
      connectionSort,
      locale,
    );
  }, [activeConnections, closed, connectionSort, deferredQuery, locale, network, tab]);
  const filteredRules = useMemo(
    () => sortRules(filterRules(snapshot?.rules ?? [], deferredQuery), ruleSort, locale),
    [deferredQuery, locale, ruleSort, snapshot?.rules],
  );
  const total = tab === "rules" ? filteredRules.length : filteredConnections.length;
  const unavailableProcessCount = activeConnections.filter(
    (item) => !item.processName && !item.processPath,
  ).length;

  useEffect(
    () => setVisibleLimit(TRAFFIC_RENDER_BATCH_SIZE),
    [tab, deferredQuery, network, connectionSort, ruleSort],
  );

  useEffect(() => setTab(trafficTab(searchParams.get("tab"))), [searchParams]);

  useEffect(() => {
    setSelectedConnection(null);
    setCloseTarget(null);
    setCloseVisibleTarget(null);
    setCloseAllConfirmationOpen(false);
  }, [snapshot?.profileId, snapshot?.sessionId]);

  async function confirmCloseConnection() {
    if (!closeTarget) return;
    const result = await closeConnection(closeTarget.id);
    if (result?.status === "success") {
      publish(
        notificationPublication("traffic.connection-closed", {
          severity: "success",
        }),
      );
      setSelectedConnection(null);
    }
    setCloseTarget(null);
  }

  async function confirmCloseAllActive() {
    const result = await closeAllActive();
    if (result?.status === "success") {
      publish(
        notificationPublication("traffic.connections-closed", {
          params: { count: result.targetCount },
          severity: "success",
        }),
      );
    }
    setCloseAllConfirmationOpen(false);
  }

  async function confirmCloseFilteredVisible() {
    if (!closeVisibleTarget) return;
    const result = await closeFilteredVisible(
      closeVisibleTarget.authority,
      closeVisibleTarget.connectionIds,
    );
    if (result?.status === "success") {
      publish(
        notificationPublication("traffic.connections-closed", {
          params: { count: result.targetCount },
          severity: "success",
        }),
      );
    }
    setCloseVisibleTarget(null);
  }

  function requestCloseFilteredVisible() {
    if (!snapshot?.sessionId || snapshot.phase !== "ready") return;
    setCloseVisibleTarget({
      authority: {
        profileId: snapshot.profileId,
        sequence: snapshot.sequence,
        sessionId: snapshot.sessionId,
      },
      connectionIds: filteredConnections.map(({ id }) => id),
    });
  }

  return (
    <div className={trafficStyles().page()}>
      <header className={trafficStyles().header()}>
        <div>
          <h1>{LL.traffic.title()}</h1>
          <p>{LL.traffic.retention()}</p>
        </div>
        <div className={trafficStyles().actions()}>
          <Button
            aria-pressed={isViewPaused}
            disabled={
              !isViewPaused && (!snapshot || snapshot.phase !== "ready" || connection.stale)
            }
            onClick={toggleViewPause}
            variant="outline"
          >
            {isViewPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
            {isViewPaused ? LL.traffic.resume() : LL.traffic.pause()}
          </Button>
          <Button
            disabled={
              tab !== "active" ||
              filteredConnections.length === 0 ||
              isCloseAllPending ||
              isCloseFilteredVisiblePending ||
              !isCommandSupported("close-filtered-visible")
            }
            loading={isCloseFilteredVisiblePending}
            loadingText={LL.traffic.closingVisible()}
            onClick={requestCloseFilteredVisible}
            variant="outline"
          >
            {LL.traffic.closeVisibleConnections()}
          </Button>
          <Button
            aria-describedby="traffic-close-scope"
            disabled={
              activeConnections.length === 0 ||
              isCloseAllPending ||
              isCloseFilteredVisiblePending ||
              !isCommandSupported("close-all-active")
            }
            loading={isCloseAllPending}
            loadingText={LL.traffic.closingAllActive()}
            onClick={() => setCloseAllConfirmationOpen(true)}
            variant="outline"
          >
            {LL.traffic.closeAllActiveConnections()}
          </Button>
        </div>
      </header>

      <TrafficSourceStatus
        LL={LL}
        connectionStale={connection.stale}
        error={error}
        isLoading={isLoading}
        isViewPaused={isViewPaused}
        locale={locale}
        pausedAt={pausedAt}
        pausedUpdateCount={pausedUpdateCount}
        snapshot={snapshot}
      />
      {unavailableProcessCount > 0 && snapshot?.adapterKind === "rpc" ? (
        <p className={trafficStyles().attributionNotice()} role="status">
          {LL.traffic.processUnavailableNotice({ count: unavailableProcessCount })}
        </p>
      ) : null}
      <p className="sr-only" id="traffic-close-scope">
        {isCommandSupported("close-all-active")
          ? LL.traffic.closeAllScope()
          : LL.traffic.closeUnsupported()}
      </p>

      <div className={trafficStyles().tabs()}>
        <ToggleGroup
          aria-label={LL.traffic.title()}
          onValueChange={(values) => {
            const value = values[0];
            if (value !== "active" && value !== "closed" && value !== "rules") return;
            setTab(value);
            setSearchParams(value === "active" ? {} : { tab: value }, { replace: true });
          }}
          spacing={0}
          value={[tab]}
          variant="segmented"
        >
          <ToggleGroupItem className={trafficStyles().viewButton()} value="active">
            {LL.traffic.active()} <Badge variant="outline">{activeConnections.length}</Badge>
          </ToggleGroupItem>
          <ToggleGroupItem className={trafficStyles().viewButton()} value="closed">
            {LL.traffic.closed()} <Badge variant="outline">{closed.length}</Badge>
          </ToggleGroupItem>
          <ToggleGroupItem className={trafficStyles().viewButton()} value="rules">
            {LL.traffic.rules()} <Badge variant="outline">{snapshot?.rules.length ?? 0}</Badge>
          </ToggleGroupItem>
        </ToggleGroup>

        <div className={trafficStyles().tools()}>
          <div className={trafficStyles().searchRow()}>
            <Field className={trafficStyles().searchField()}>
              <FieldLabel className="sr-only" htmlFor="traffic-search">
                {LL.traffic.searchLabel()}
              </FieldLabel>
              <div className={trafficStyles().searchControl()}>
                <MagnifyingGlass aria-hidden="true" />
                <Input
                  autoComplete="off"
                  data-native-search
                  id="traffic-search"
                  onValueChange={setQuery}
                  placeholder={LL.traffic.searchPlaceholder()}
                  spellCheck={false}
                  value={query}
                />
              </div>
            </Field>
            <Button
              aria-label={LL.traffic.searchHelpAria()}
              className={trafficStyles().searchHelp()}
              onClick={() => setSearchHelpOpen(true)}
              size="icon-sm"
              type="button"
              variant="outline"
            >
              <Question aria-hidden="true" />
            </Button>
          </div>
          {tab === "rules" ? (
            <RuleSortSelect LL={LL} onChange={setRuleSort} value={ruleSort} />
          ) : (
            <>
              <Select
                items={networks}
                onValueChange={(value) => typeof value === "string" && setNetwork(value)}
                value={network}
              >
                <SelectTrigger aria-label={LL.traffic.network()}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {networks.map((item) => (
                      <SelectItem key={item.value} value={item.value}>
                        {item.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              <ConnectionSortSelect LL={LL} onChange={setConnectionSort} value={connectionSort} />
            </>
          )}
          {tab === "closed" ? (
            <Button
              aria-describedby="clear-closed-description"
              disabled={closed.length === 0}
              onClick={clearClosed}
              variant="outline"
            >
              {LL.traffic.clearClosed()}
            </Button>
          ) : null}
        </div>
        <p className="sr-only" id="clear-closed-description">
          {LL.traffic.clearClosedDescription()}
        </p>

        {tab === "active" ? (
          <ConnectionPanel
            LL={LL}
            connections={filteredConnections.slice(0, visibleLimit)}
            emptyDescription={
              query || network !== "all"
                ? LL.traffic.noMatchesDescription()
                : LL.traffic.activeEmptyDescription()
            }
            emptyTitle={
              query || network !== "all" ? LL.traffic.noMatches() : LL.traffic.activeEmpty()
            }
            locale={locale}
            canClose={
              isCommandSupported("close-connection") &&
              !isCloseAllPending &&
              !isCloseFilteredVisiblePending
            }
            isClosePending={isCloseConnectionPending}
            onRequestClose={setCloseTarget}
            onSelect={setSelectedConnection}
          />
        ) : null}
        {tab === "closed" ? (
          <ConnectionPanel
            LL={LL}
            connections={filteredConnections.slice(0, visibleLimit)}
            emptyDescription={
              query || network !== "all"
                ? LL.traffic.noMatchesDescription()
                : LL.traffic.closedEmptyDescription()
            }
            emptyTitle={
              query || network !== "all" ? LL.traffic.noMatches() : LL.traffic.closedEmpty()
            }
            locale={locale}
            canClose={false}
            isClosePending={() => false}
            onRequestClose={() => undefined}
            onSelect={setSelectedConnection}
          />
        ) : null}
        {tab === "rules" ? (
          <RulesPanel LL={LL} rules={filteredRules.slice(0, visibleLimit)} />
        ) : null}
      </div>

      {total > visibleLimit ? (
        <div className={trafficStyles().loadMore()}>
          <span>{LL.traffic.showing({ total, visible: visibleLimit })}</span>
          <Button
            onClick={() => setVisibleLimit((current) => current + TRAFFIC_RENDER_BATCH_SIZE)}
            variant="outline"
          >
            {LL.traffic.loadMore()}
          </Button>
        </div>
      ) : null}

      <ConnectionDetailDialog
        connection={selectedConnection}
        LL={LL}
        locale={locale}
        canClose={
          isCommandSupported("close-connection") &&
          !isCloseAllPending &&
          !isCloseFilteredVisiblePending
        }
        isClosePending={isCloseConnectionPending}
        onRequestClose={setCloseTarget}
        onOpenChange={(open) => {
          if (!open) setSelectedConnection(null);
        }}
      />

      <Dialog onOpenChange={setSearchHelpOpen} open={searchHelpOpen}>
        <DialogContent
          className={trafficStyles().searchHelpDialog()}
          closeLabel={LL.common.close()}
        >
          <DialogHeader>
            <div>
              <DialogTitle className="dialog-title">{LL.traffic.searchHelpTitle()}</DialogTitle>
              <DialogDescription className="dialog-description">
                {LL.traffic.searchHelpDescription()}
              </DialogDescription>
            </div>
          </DialogHeader>
          <div className={trafficStyles().searchHelpContent()}>
            <p>{LL.traffic.searchHelpFields()}</p>
            <div className={trafficStyles().searchExamples()}>
              <code>destination:example.com</code>
              <code>process:browser network:tcp</code>
            </div>
          </div>
          <DialogFooter>
            <Button onClick={() => setSearchHelpOpen(false)} variant="outline">
              {LL.common.close()}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!isCloseConnectionPending(closeTarget?.id ?? ""))
            setCloseTarget(open ? closeTarget : null);
        }}
        open={closeTarget !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{LL.traffic.closeConnectionTitle()}</AlertDialogTitle>
            <AlertDialogDescription>
              {LL.traffic.closeConnectionDescription({
                destination: closeTarget ? destinationLabel(closeTarget) : "",
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{LL.common.cancel()}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!closeTarget || isCloseConnectionPending(closeTarget.id)}
              loading={Boolean(closeTarget && isCloseConnectionPending(closeTarget.id))}
              loadingText={LL.traffic.closingConnection()}
              onClick={confirmCloseConnection}
              variant="destructive"
            >
              {LL.traffic.closeConnectionConfirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!isCloseFilteredVisiblePending) {
            setCloseVisibleTarget(open ? closeVisibleTarget : null);
          }
        }}
        open={closeVisibleTarget !== null}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{LL.traffic.closeVisibleTitle()}</AlertDialogTitle>
            <AlertDialogDescription>
              {LL.traffic.closeVisibleDescription({
                count: closeVisibleTarget?.connectionIds.length ?? 0,
              })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{LL.common.cancel()}</AlertDialogCancel>
            <AlertDialogAction
              disabled={!closeVisibleTarget?.connectionIds.length || isCloseFilteredVisiblePending}
              loading={isCloseFilteredVisiblePending}
              loadingText={LL.traffic.closingVisible()}
              onClick={confirmCloseFilteredVisible}
              variant="destructive"
            >
              {LL.traffic.closeVisibleConfirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        onOpenChange={(open) => {
          if (!isCloseAllPending) setCloseAllConfirmationOpen(open);
        }}
        open={closeAllConfirmationOpen}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{LL.traffic.closeAllActiveTitle()}</AlertDialogTitle>
            <AlertDialogDescription>
              {LL.traffic.closeAllActiveDescription({ count: activeConnections.length })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{LL.common.cancel()}</AlertDialogCancel>
            <AlertDialogAction
              disabled={
                activeConnections.length === 0 || isCloseAllPending || isCloseFilteredVisiblePending
              }
              loading={isCloseAllPending}
              loadingText={LL.traffic.closingAllActive()}
              onClick={confirmCloseAllActive}
              variant="destructive"
            >
              {LL.traffic.closeAllActiveConfirm()}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function trafficTab(value: string | null): TrafficTab {
  return value === "closed" || value === "rules" ? value : "active";
}

interface TrafficSourceStatusProps {
  LL: TranslationFunctions;
  connectionStale: boolean;
  error: string | null;
  isLoading: boolean;
  isViewPaused: boolean;
  locale: Locales;
  pausedAt: Date | null;
  pausedUpdateCount: number;
  snapshot: ReturnType<typeof useTraffic>["snapshot"];
}

function TrafficSourceStatus({
  LL,
  connectionStale,
  error,
  isLoading,
  isViewPaused,
  locale,
  pausedAt,
  pausedUpdateCount,
  snapshot,
}: TrafficSourceStatusProps) {
  let message: string = LL.traffic.unavailableNotice();
  let state = "unavailable";
  if (isLoading) message = LL.traffic.liveNotice();
  if (error) message = LL.traffic.loadError();
  if (snapshot?.adapterKind === "fixture") {
    message = LL.traffic.fixtureNotice();
    state = "fixture";
  } else if (connectionStale || snapshot?.phase === "stale") {
    message = LL.traffic.staleNotice();
    state = "stale";
  } else if (snapshot?.phase === "ready") {
    message = LL.traffic.liveNotice();
    state = "ready";
  }

  return (
    <div className={trafficStyles().sourceStatus()} data-state={state} role="status">
      <span>
        {isViewPaused && pausedAt
          ? LL.traffic.paused({
              time: formatDate(pausedAt.toISOString(), locale),
              updates: pausedUpdateCount,
            })
          : message}
      </span>
      {snapshot?.sessionId ? (
        <span className="tabular-nums">
          {LL.traffic.reconnect({
            count: snapshot.reconnectCount,
            session: snapshot.sessionId,
          })}
        </span>
      ) : null}
    </div>
  );
}

interface ConnectionPanelProps<T extends TrafficConnectionDto> {
  canClose: boolean;
  LL: TranslationFunctions;
  connections: T[];
  emptyDescription: string;
  emptyTitle: string;
  locale: Locales;
  isClosePending(connectionId: string): boolean;
  onRequestClose(connection: T): void;
  onSelect(connection: T): void;
}

function ConnectionPanel<T extends TrafficConnectionDto>({
  LL,
  canClose,
  connections,
  emptyDescription,
  emptyTitle,
  locale,
  isClosePending,
  onRequestClose,
  onSelect,
}: ConnectionPanelProps<T>) {
  if (connections.length === 0) {
    return (
      <Empty className={trafficStyles().empty()}>
        <EmptyHeader>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const showsClosedTime = connections.some((connection) => "closedAt" in connection);

  return (
    <Table className={trafficStyles().connectionTable()}>
      <TableHeader>
        <TableRow>
          <TableHead>{LL.traffic.destination()}</TableHead>
          <TableHead>{LL.traffic.process()}</TableHead>
          <TableHead>{LL.traffic.network()}</TableHead>
          <TableHead>{showsClosedTime ? LL.traffic.closedAt() : LL.traffic.started()}</TableHead>
          <TableHead>{LL.traffic.download()}</TableHead>
          <TableHead>{LL.traffic.upload()}</TableHead>
          <TableHead>{LL.traffic.rule()}</TableHead>
          <TableHead>{LL.traffic.route()}</TableHead>
          <TableHead>
            <span className="sr-only">{LL.traffic.state()}</span>
          </TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {connections.map((connection) => (
          <TableRow
            className={trafficStyles().connectionRow()}
            key={connection.id}
            onClick={(event) => {
              if (
                event.target instanceof Element &&
                event.target.closest("[data-traffic-row-action]")
              ) {
                return;
              }
              onSelect(connection);
            }}
            onKeyDown={(event) => {
              if (
                event.target !== event.currentTarget ||
                (event.key !== "Enter" && event.key !== " ")
              ) {
                return;
              }
              event.preventDefault();
              onSelect(connection);
            }}
            tabIndex={0}
          >
            <TableCell>
              <span className={trafficStyles().destination()}>
                <span>{destinationLabel(connection) || LL.traffic.unavailable()}</span>
                <small className="tabular-nums">:{connection.destinationPort}</small>
              </span>
            </TableCell>
            <TableCell>
              <ProcessIdentity connection={connection} LL={LL} />
            </TableCell>
            <TableCell className="tabular-nums">
              {formatConnectionProtocolLabel(connection)}
            </TableCell>
            <TableCell className="tabular-nums">
              {formatDate(
                "closedAt" in connection && typeof connection.closedAt === "string"
                  ? connection.closedAt
                  : connection.startedAt,
                locale,
              )}
            </TableCell>
            <TableCell className="tabular-nums">{formatBytes(connection.downloadBytes)}</TableCell>
            <TableCell className="tabular-nums">{formatBytes(connection.uploadBytes)}</TableCell>
            <TableCell>
              <span className={trafficStyles().rule()}>{connection.matchedRule.type}</span>
              <small>{connection.matchedRule.payload || LL.traffic.unavailable()}</small>
            </TableCell>
            <TableCell title={connection.routeChain.join(" → ")}>
              {connection.routeChain.length > 0
                ? connection.routeChain.join(" → ")
                : LL.traffic.unavailable()}
            </TableCell>
            <TableCell className={trafficStyles().connectionAction()} data-traffic-row-action="">
              <Button
                aria-describedby={canClose ? undefined : "traffic-close-scope"}
                disabled={!canClose || isClosePending(connection.id)}
                loading={isClosePending(connection.id)}
                loadingText={LL.traffic.closingConnection()}
                onClick={(event) => {
                  event.stopPropagation();
                  onRequestClose(connection);
                }}
                size="sm"
                variant="ghost"
              >
                {LL.traffic.close()}
              </Button>
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ProcessIdentity({
  connection,
  LL,
}: {
  connection: TrafficConnectionDto;
  LL: TranslationFunctions;
}) {
  const { getProcessIcon } = useTraffic();
  const [dataUrl, setDataUrl] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    setDataUrl(null);
    void getProcessIcon(connection.id, connection.processPath).then((icon) => {
      if (active) setDataUrl(icon);
    });
    return () => {
      active = false;
    };
  }, [connection.id, connection.processPath, getProcessIcon]);

  const processName = connection.processName ?? LL.traffic.unavailable();
  const name = connection.processPath ? (
    <Tooltip>
      <TooltipTrigger render={<span className={trafficStyles().processName()} tabIndex={0} />}>
        {processName}
      </TooltipTrigger>
      <TooltipContent>{connection.processPath}</TooltipContent>
    </Tooltip>
  ) : (
    <span className={trafficStyles().processName()}>{processName}</span>
  );

  return (
    <span className={trafficStyles().processIdentity()}>
      {dataUrl ? (
        <img
          alt=""
          aria-hidden="true"
          className={trafficStyles().processIcon()}
          height={20}
          src={dataUrl}
          width={20}
        />
      ) : null}
      {name}
    </span>
  );
}

function RulesPanel({ LL, rules }: { LL: TranslationFunctions; rules: EffectiveRuleDto[] }) {
  if (rules.length === 0) {
    return (
      <Empty className={trafficStyles().empty()}>
        <EmptyHeader>
          <EmptyTitle>{LL.traffic.rulesEmpty()}</EmptyTitle>
          <EmptyDescription>{LL.traffic.rulesEmptyDescription()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Table className={trafficStyles().rulesTable()}>
      <TableHeader>
        <TableRow>
          <TableHead>{LL.traffic.priority()}</TableHead>
          <TableHead>{LL.traffic.rule()}</TableHead>
          <TableHead>{LL.traffic.payload()}</TableHead>
          <TableHead>{LL.traffic.target()}</TableHead>
          <TableHead>{LL.traffic.state()}</TableHead>
          <TableHead>{LL.traffic.hits()}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rules.map((rule) => (
          <TableRow key={`${rule.priority}:${rule.type}:${rule.payload}`}>
            <TableCell className="tabular-nums">{rule.priority + 1}</TableCell>
            <TableCell>{rule.type}</TableCell>
            <TableCell title={rule.payload}>{rule.payload || LL.traffic.unavailable()}</TableCell>
            <TableCell>{rule.target}</TableCell>
            <TableCell>
              <Badge variant="outline">
                {rule.enabled ? LL.traffic.enabled() : LL.traffic.disabled()}
              </Badge>
            </TableCell>
            <TableCell className="tabular-nums">
              {rule.hitCount ?? LL.traffic.unavailable()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

function ConnectionSortSelect({
  LL,
  onChange,
  value,
}: {
  LL: TranslationFunctions;
  onChange(value: ConnectionSort): void;
  value: ConnectionSort;
}) {
  const items = connectionSortValues.map((sort) => ({
    label: getConnectionSortLabel(LL, sort),
    value: sort,
  }));
  return (
    <Select
      items={items}
      onValueChange={(next) =>
        typeof next === "string" && connectionSortValues.includes(next as ConnectionSort)
          ? onChange(next as ConnectionSort)
          : undefined
      }
      value={value}
    >
      <SelectTrigger aria-label={LL.traffic.sortLabel()}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function RuleSortSelect({
  LL,
  onChange,
  value,
}: {
  LL: TranslationFunctions;
  onChange(value: RuleSort): void;
  value: RuleSort;
}) {
  const items = ruleSortValues.map((sort) => ({ label: getRuleSortLabel(LL, sort), value: sort }));
  return (
    <Select
      items={items}
      onValueChange={(next) =>
        typeof next === "string" && ruleSortValues.includes(next as RuleSort)
          ? onChange(next as RuleSort)
          : undefined
      }
      value={value}
    >
      <SelectTrigger aria-label={LL.traffic.sortLabel()}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        <SelectGroup>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectGroup>
      </SelectContent>
    </Select>
  );
}

function ConnectionDetailDialog({
  canClose,
  connection,
  isClosePending,
  LL,
  locale,
  onOpenChange,
  onRequestClose,
}: {
  canClose: boolean;
  connection: SelectedConnection | null;
  isClosePending(connectionId: string): boolean;
  LL: TranslationFunctions;
  locale: Locales;
  onOpenChange(open: boolean): void;
  onRequestClose(connection: TrafficConnectionDto): void;
}) {
  return (
    <Dialog onOpenChange={onOpenChange} open={connection !== null}>
      <DialogContent className={trafficStyles().detailDialog()} closeLabel={LL.common.close()}>
        <DialogHeader className={trafficStyles().detailHeader()}>
          <div>
            <DialogTitle className="dialog-title">{LL.traffic.connectionDetails()}</DialogTitle>
            <DialogDescription className="dialog-description">
              {LL.traffic.detailDescription()}
            </DialogDescription>
          </div>
        </DialogHeader>
        {connection ? (
          <div className={trafficStyles().detailBody()} data-native-text-interaction tabIndex={-1}>
            <dl className={trafficStyles().detailGrid()}>
              <Detail
                label={LL.traffic.destinationHost()}
                value={connection.destinationHost}
                LL={LL}
              />
              <Detail
                label={LL.traffic.destinationIp()}
                value={
                  connection.destinationIp
                    ? `${connection.destinationIp}:${connection.destinationPort}`
                    : null
                }
                LL={LL}
              />
              <Detail
                label={LL.traffic.remoteDestination()}
                value={connection.remoteDestination}
                LL={LL}
              />
              <Detail label={LL.traffic.sniffHost()} value={connection.sniffHost} LL={LL} />
              <Detail
                label={LL.traffic.protocol()}
                value={formatConnectionProtocolLabel(connection)}
                LL={LL}
              />
              <Detail
                label={LL.traffic.source()}
                value={
                  connection.sourceIp ? `${connection.sourceIp}:${connection.sourcePort}` : null
                }
                LL={LL}
              />
              <Detail label={LL.traffic.process()} value={connection.processName} LL={LL} />
              <Detail
                label={LL.traffic.started()}
                value={formatDate(connection.startedAt, locale)}
                LL={LL}
              />
              {"closedAt" in connection && typeof connection.closedAt === "string" ? (
                <Detail
                  label={LL.traffic.closedAt()}
                  value={formatDate(connection.closedAt, locale)}
                  LL={LL}
                />
              ) : null}
              <Detail label={LL.traffic.processPath()} value={connection.processPath} LL={LL} />
              <Detail
                label={LL.traffic.download()}
                value={formatBytes(connection.downloadBytes)}
                LL={LL}
              />
              <Detail
                label={LL.traffic.upload()}
                value={formatBytes(connection.uploadBytes)}
                LL={LL}
              />
              <Detail label={LL.traffic.rule()} value={connection.matchedRule.type} LL={LL} />
              <Detail label={LL.traffic.payload()} value={connection.matchedRule.payload} LL={LL} />
              <Detail
                label={LL.traffic.providerChain()}
                value={
                  connection.providerChain.length > 0 ? connection.providerChain.join(" → ") : null
                }
                LL={LL}
              />
            </dl>
            <section className={trafficStyles().chain()}>
              <h2>{LL.traffic.orderedChain()}</h2>
              {connection.routeChain.length > 0 ? (
                <ol>
                  {connection.routeChain.map((hop, index) => (
                    <li key={`${index}:${hop}`}>
                      <span className="tabular-nums">{index + 1}</span>
                      <strong>{hop}</strong>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>{LL.traffic.unavailable()}</p>
              )}
            </section>
          </div>
        ) : null}
        <DialogFooter className={trafficStyles().detailFooter()}>
          {connection && !("closedAt" in connection) ? (
            <Button
              aria-describedby={canClose ? undefined : "traffic-close-scope"}
              disabled={!canClose || isClosePending(connection.id)}
              loading={isClosePending(connection.id)}
              loadingText={LL.traffic.closingConnection()}
              onClick={() => onRequestClose(connection)}
              variant="destructive"
            >
              {LL.traffic.close()}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Detail({
  label,
  LL,
  value,
}: {
  label: string;
  LL: TranslationFunctions;
  value: string | null;
}) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value || LL.traffic.unavailable()}</dd>
    </div>
  );
}

function getConnectionSortLabel(LL: TranslationFunctions, sort: ConnectionSort) {
  if (sort === "destination-asc") return LL.traffic.sortDestination();
  if (sort === "download-desc") return LL.traffic.sortDownload();
  if (sort === "upload-desc") return LL.traffic.sortUpload();
  return LL.traffic.sortStarted();
}

function getRuleSortLabel(LL: TranslationFunctions, sort: RuleSort) {
  if (sort === "type-asc") return LL.traffic.sortType();
  if (sort === "target-asc") return LL.traffic.sortTarget();
  if (sort === "hits-desc") return LL.traffic.sortHits();
  return LL.traffic.sortPriority();
}

function formatDate(value: string, locale: Locales) {
  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return value;
  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
  }).format(timestamp);
}

function formatBytes(value: string) {
  const bytes = BigInt(value);
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let unit = 0;
  let divisor = 1n;
  while (unit < units.length - 1 && bytes >= divisor * 1_024n) {
    divisor *= 1_024n;
    unit += 1;
  }
  if (unit === 0) return `${bytes} ${units[unit]}`;
  const whole = bytes / divisor;
  const decimal = ((bytes % divisor) * 10n) / divisor;
  return `${whole}.${decimal} ${units[unit]}`;
}
