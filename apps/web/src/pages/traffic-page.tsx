import { MagnifyingGlass } from "@phosphor-icons/react/MagnifyingGlass";
import { Question } from "@phosphor-icons/react/Question";
import type { EffectiveRuleDto, TrafficConnectionDto } from "@mish/contracts";
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
} from "@mish/ui";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
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

type TrafficTab = "active" | "closed" | "rules";
type SelectedConnection = TrafficConnectionDto | ClosedTrafficConnection;

const connectionSortValues: ConnectionSort[] = [
  "started-desc",
  "destination-asc",
  "download-desc",
  "upload-desc",
];
const ruleSortValues: RuleSort[] = ["priority-asc", "type-asc", "target-asc", "hits-desc"];

export function TrafficPage() {
  const { LL, locale } = useI18nContext();
  const {
    clearClosed,
    closeAllActive,
    closeConnection,
    closed,
    connection,
    error,
    isCloseAllPending,
    isCloseConnectionPending,
    isCommandSupported,
    isCurrent,
    isLoading,
    snapshot,
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
  const [closeAllConfirmationOpen, setCloseAllConfirmationOpen] = useState(false);
  const [searchHelpOpen, setSearchHelpOpen] = useState(false);
  const deferredQuery = useDeferredValue(query);
  const activeConnections = isCurrent ? (snapshot?.activeConnections ?? []) : [];
  const networks = useMemo(
    () =>
      [
        "all",
        ...new Set([...activeConnections, ...closed].map((item) => item.network.toLowerCase())),
      ].map((value) => ({
        label: value === "all" ? LL.traffic.allNetworks() : value.toUpperCase(),
        value,
      })),
    [LL, activeConnections, closed],
  );
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

  useEffect(
    () => setVisibleLimit(TRAFFIC_RENDER_BATCH_SIZE),
    [tab, deferredQuery, network, connectionSort, ruleSort],
  );

  useEffect(() => setTab(trafficTab(searchParams.get("tab"))), [searchParams]);

  async function confirmCloseConnection() {
    if (!closeTarget) return;
    const result = await closeConnection(closeTarget.id);
    if (result?.status === "success") {
      toast.success(LL.traffic.closeConnectionSucceeded());
      setSelectedConnection(null);
    }
    setCloseTarget(null);
  }

  async function confirmCloseAllActive() {
    const result = await closeAllActive();
    if (result?.status === "success") {
      toast.success(LL.traffic.closeAllActiveSucceeded({ count: result.targetCount }));
    }
    setCloseAllConfirmationOpen(false);
  }

  return (
    <div className="traffic-page">
      <header className="traffic-header">
        <div>
          <h1>{LL.traffic.title()}</h1>
          <p>{LL.traffic.retention()}</p>
        </div>
        <div className="traffic-actions">
          <Button
            aria-describedby="traffic-close-scope"
            disabled={
              activeConnections.length === 0 ||
              isCloseAllPending ||
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
        snapshot={snapshot}
      />
      <p className="sr-only" id="traffic-close-scope">
        {isCommandSupported("close-all-active")
          ? LL.traffic.closeAllScope()
          : LL.traffic.closeUnsupported()}
      </p>

      <div className="traffic-tabs">
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
          <ToggleGroupItem className="traffic-view-switch-button px-3" value="active">
            {LL.traffic.active()} <Badge variant="outline">{activeConnections.length}</Badge>
          </ToggleGroupItem>
          <ToggleGroupItem className="traffic-view-switch-button px-3" value="closed">
            {LL.traffic.closed()} <Badge variant="outline">{closed.length}</Badge>
          </ToggleGroupItem>
          <ToggleGroupItem className="traffic-view-switch-button px-3" value="rules">
            {LL.traffic.rules()} <Badge variant="outline">{snapshot?.rules.length ?? 0}</Badge>
          </ToggleGroupItem>
        </ToggleGroup>

        <div className="traffic-tools">
          <div className="traffic-search-row">
            <Field className="traffic-search-field">
              <FieldLabel className="sr-only" htmlFor="traffic-search">
                {LL.traffic.searchLabel()}
              </FieldLabel>
              <div className="traffic-search-control">
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
              className="traffic-search-help-button"
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
            canClose={isCommandSupported("close-connection")}
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
        <div className="traffic-load-more">
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
        canClose={isCommandSupported("close-connection")}
        isClosePending={isCloseConnectionPending}
        onRequestClose={setCloseTarget}
        onOpenChange={(open) => {
          if (!open) setSelectedConnection(null);
        }}
      />

      <Dialog onOpenChange={setSearchHelpOpen} open={searchHelpOpen}>
        <DialogContent className="traffic-search-help-dialog" closeLabel={LL.common.close()}>
          <DialogHeader>
            <div>
              <DialogTitle className="dialog-title">{LL.traffic.searchHelpTitle()}</DialogTitle>
              <DialogDescription className="dialog-description">
                {LL.traffic.searchHelpDescription()}
              </DialogDescription>
            </div>
          </DialogHeader>
          <div className="traffic-search-help-content">
            <p>{LL.traffic.searchHelpFields()}</p>
            <div className="traffic-search-examples">
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
              disabled={activeConnections.length === 0 || isCloseAllPending}
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
  snapshot: ReturnType<typeof useTraffic>["snapshot"];
}

function TrafficSourceStatus({
  LL,
  connectionStale,
  error,
  isLoading,
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
    <div className="traffic-source-status" data-state={state} role="status">
      <span>{message}</span>
      {snapshot?.sessionId ? (
        <span className="tabular">
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
      <Empty className="traffic-empty">
        <EmptyHeader>
          <EmptyTitle>{emptyTitle}</EmptyTitle>
          <EmptyDescription>{emptyDescription}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const showsClosedTime = connections.some((connection) => "closedAt" in connection);

  return (
    <Table className="traffic-table">
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
          <TableRow key={connection.id}>
            <TableCell>
              <Button
                className="traffic-destination-button"
                onClick={() => onSelect(connection)}
                variant="ghost"
              >
                <span>{destinationLabel(connection) || LL.traffic.unavailable()}</span>
                <small className="tabular">:{connection.destinationPort}</small>
              </Button>
            </TableCell>
            <TableCell title={connection.processPath ?? undefined}>
              {connection.processName ?? LL.traffic.unavailable()}
            </TableCell>
            <TableCell className="tabular">
              {connection.network.toUpperCase()} · {connection.protocol}
            </TableCell>
            <TableCell className="tabular">
              {formatDate(
                "closedAt" in connection && typeof connection.closedAt === "string"
                  ? connection.closedAt
                  : connection.startedAt,
                locale,
              )}
            </TableCell>
            <TableCell className="tabular">{formatBytes(connection.downloadBytes)}</TableCell>
            <TableCell className="tabular">{formatBytes(connection.uploadBytes)}</TableCell>
            <TableCell>
              <span className="traffic-rule-cell">{connection.matchedRule.type}</span>
              <small>{connection.matchedRule.payload || LL.traffic.unavailable()}</small>
            </TableCell>
            <TableCell title={connection.routeChain.join(" → ")}>
              {connection.routeChain.length > 0
                ? connection.routeChain.join(" → ")
                : LL.traffic.unavailable()}
            </TableCell>
            <TableCell>
              <Button
                aria-describedby={canClose ? undefined : "traffic-close-scope"}
                disabled={!canClose || isClosePending(connection.id)}
                loading={isClosePending(connection.id)}
                loadingText={LL.traffic.closingConnection()}
                onClick={() => onRequestClose(connection)}
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

function RulesPanel({ LL, rules }: { LL: TranslationFunctions; rules: EffectiveRuleDto[] }) {
  if (rules.length === 0) {
    return (
      <Empty className="traffic-empty">
        <EmptyHeader>
          <EmptyTitle>{LL.traffic.rulesEmpty()}</EmptyTitle>
          <EmptyDescription>{LL.traffic.rulesEmptyDescription()}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return (
    <Table className="traffic-table rules-table">
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
            <TableCell className="tabular">{rule.priority + 1}</TableCell>
            <TableCell>{rule.type}</TableCell>
            <TableCell title={rule.payload}>{rule.payload || LL.traffic.unavailable()}</TableCell>
            <TableCell>{rule.target}</TableCell>
            <TableCell>
              <Badge variant="outline">
                {rule.enabled ? LL.traffic.enabled() : LL.traffic.disabled()}
              </Badge>
            </TableCell>
            <TableCell className="tabular">{rule.hitCount ?? LL.traffic.unavailable()}</TableCell>
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
      <DialogContent className="traffic-detail-dialog" closeLabel={LL.common.close()}>
        <div className="dialog-header">
          <div>
            <DialogTitle className="dialog-title">{LL.traffic.connectionDetails()}</DialogTitle>
            <DialogDescription className="dialog-description">
              {LL.traffic.detailDescription()}
            </DialogDescription>
          </div>
        </div>
        {connection ? (
          <div className="traffic-detail-body">
            <dl className="traffic-detail-grid">
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
                value={`${connection.network} · ${connection.protocol}`}
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
            <section className="traffic-chain-detail">
              <h2>{LL.traffic.orderedChain()}</h2>
              {connection.routeChain.length > 0 ? (
                <ol>
                  {connection.routeChain.map((hop, index) => (
                    <li key={`${index}:${hop}`}>
                      <span className="tabular">{index + 1}</span>
                      <strong>{hop}</strong>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>{LL.traffic.unavailable()}</p>
              )}
            </section>
            <div className="dialog-footer">
              {!("closedAt" in connection) ? (
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
            </div>
          </div>
        ) : null}
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
