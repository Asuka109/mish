import { ArrowDown } from "@phosphor-icons/react/ArrowDown";
import { Copy } from "@phosphor-icons/react/Copy";
import { Pause } from "@phosphor-icons/react/Pause";
import { Play } from "@phosphor-icons/react/Play";
import { Trash } from "@phosphor-icons/react/Trash";
import {
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
  Input,
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
  SectionGrid,
  SectionGridItem,
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@mish/ui";
import type {
  DiagnosticCheckDto,
  DiagnosticObservedFactDto,
  DiagnosticRouteTargetDto,
  DiagnosticRunDto,
  EventLevel,
  EventRecordDto,
  EventSource,
  EventSourcePhase,
  SupportBundleCategory,
  SupportBundleRedactionCategory,
} from "@mish/contracts";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Link, useSearchParams } from "react-router";
import { tv } from "tailwind-variants";
import { useEvents } from "../data/events-provider";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";
import { filterEvents, sortEvents, type EventsOrder } from "./events-model";

const eventLevels: EventLevel[] = ["debug", "info", "warning", "error"];
const eventSources: EventSource[] = ["application", "core", "platform", "rpc"];

const eventStyles = tv({
  slots: {
    page: "events-page mx-auto min-h-full w-[min(100%,1180px)] px-8 pt-7 pb-9",
    heading:
      "events-heading flex items-start justify-between gap-6 [&_p]:mt-[5px] [&_p]:max-w-[680px] [&_p]:text-(--text-metadata) [&_p]:text-(--color-text-muted)",
    retention:
      "events-retention flex-none pt-[5px] text-[12px] text-(--color-text-muted) whitespace-nowrap",
    status:
      "events-source-status mt-5 flex min-h-[38px] items-center justify-between gap-4 rounded-(--radius-md) border border-(--color-hairline) bg-(--color-surface-soft) px-3 py-2 text-(--text-metadata) text-(--color-body) data-[state=stale]:border-[color-mix(in_srgb,var(--color-warning)_28%,var(--color-hairline))] data-[state=stale]:text-(--color-warning) data-[state=connecting]:border-[color-mix(in_srgb,var(--color-warning)_28%,var(--color-hairline))] data-[state=connecting]:text-(--color-warning) [&>span:last-child]:flex-none [&>span:last-child]:text-[12px] [&>span:last-child]:text-(--color-text-muted)",
    sources: "events-sources-section mt-4",
    sourceHeading:
      "events-source-heading [&_p]:mt-[3px] [&_p]:text-[12px] [&_p]:leading-[17px] [&_p]:text-(--color-text-muted)",
    sourceGrid:
      "events-source-grid mt-2 grid grid-cols-4 gap-px overflow-hidden rounded-(--radius-md) border border-(--color-hairline) bg-(--color-hairline-soft)",
    sourceItem:
      "events-source-item flex min-h-[42px] min-w-0 items-center justify-between gap-[10px] bg-(--color-canvas) px-[10px] py-2 text-(--text-metadata) [&>span]:overflow-hidden [&>span]:text-ellipsis [&>span]:whitespace-nowrap [&>span]:font-(--font-weight-control)",
    sourcePhase:
      "events-source-phase inline-flex flex-none items-center gap-[6px] text-[12px] text-(--color-text-muted) whitespace-nowrap data-[phase=ready]:text-(--color-success-text) data-[phase=stale]:text-(--color-warning)",
    sourceIndicator:
      "events-source-indicator size-[7px] flex-none rounded-(--radius-full) bg-(--color-muted-soft) [.events-source-phase[data-phase=ready]_&]:bg-(--color-success) [.events-source-phase[data-phase=stale]_&]:bg-(--color-warning) [.events-source-phase[data-phase=fixture-only]_&]:bg-(--color-brand)",
  },
});

export function EventsPage() {
  const {
    cancelDiagnosticRun,
    clearLocal,
    connection,
    diagnosticError,
    diagnosticHistory,
    diagnosticPending,
    error,
    events,
    isLoading,
    snapshot,
    startDiagnosticRun,
    clearSupportBundlePreview,
    previewSupportBundle,
    saveSupportBundle,
    supportBundleAvailability,
    supportBundlePending,
    supportBundlePreview,
    supportBundleResult,
  } = useEvents();
  const { LL, locale } = useI18nContext();
  const [query, setQuery] = useState("");
  const [level, setLevel] = useState<EventLevel | "all">("all");
  const [source, setSource] = useState<EventSource | "all">("all");
  const [order, setOrder] = useState<EventsOrder>("oldest");
  const [paused, setPaused] = useState(false);
  const [pausedEvents, setPausedEvents] = useState<EventRecordDto[]>([]);
  const [pausedSessionId, setPausedSessionId] = useState<string | null>(null);
  const [followLatest, setFollowLatest] = useState(true);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const diagnosticsRef = useRef<HTMLElement>(null);
  const [searchParams] = useSearchParams();

  const viewPaused = paused && pausedSessionId === snapshot?.sessionId;
  const displayedEvents = viewPaused ? pausedEvents : events;
  const filteredEvents = useMemo(
    () =>
      sortEvents(
        filterEvents(
          displayedEvents,
          query,
          level === "all" ? new Set() : new Set([level]),
          source === "all" ? new Set() : new Set([source]),
        ),
        order,
      ),
    [displayedEvents, level, order, query, source],
  );
  const pausedIds = useMemo(() => new Set(pausedEvents.map(({ id }) => id)), [pausedEvents]);
  const bufferedWhilePaused = viewPaused ? events.filter(({ id }) => !pausedIds.has(id)).length : 0;

  useEffect(() => {
    if (!followLatest || viewPaused) return;
    const list = listRef.current;
    if (!list) return;
    list.scrollTop = order === "oldest" ? list.scrollHeight : 0;
  }, [filteredEvents.length, followLatest, order, viewPaused]);

  useEffect(() => {
    if (!paused || pausedSessionId === snapshot?.sessionId) return;
    setPaused(false);
    setPausedEvents([]);
    setPausedSessionId(null);
  }, [paused, pausedSessionId, snapshot?.sessionId]);

  useEffect(() => {
    if (searchParams.get("diagnostics") !== "1") return;
    diagnosticsRef.current?.focus();
    diagnosticsRef.current?.scrollIntoView({ block: "start" });
  }, [searchParams]);

  function togglePause() {
    if (viewPaused) {
      setPaused(false);
      setPausedEvents([]);
      setPausedSessionId(null);
      return;
    }
    setPausedEvents(events);
    setPausedSessionId(snapshot?.sessionId ?? null);
    setPaused(true);
  }

  function clearVisibleLocal() {
    clearLocal();
    setPausedEvents([]);
  }

  function followNow() {
    setFollowLatest(true);
    requestAnimationFrame(() => {
      const list = listRef.current;
      if (!list) return;
      list.scrollTop = order === "oldest" ? list.scrollHeight : 0;
    });
  }

  function observeScroll() {
    const list = listRef.current;
    if (!list || viewPaused) return;
    const atLatest =
      order === "oldest"
        ? list.scrollHeight - list.scrollTop - list.clientHeight < 8
        : list.scrollTop < 8;
    setFollowLatest(atLatest);
  }

  async function copyEvent(event: EventRecordDto) {
    if (!navigator.clipboard?.writeText) return;
    await navigator.clipboard.writeText(formatEventForCopy(event));
    setCopiedId(event.id);
    window.setTimeout(
      () => setCopiedId((current) => (current === event.id ? null : current)),
      1_500,
    );
  }

  const sourceState = getSourceState(LL, connection.stale, error, isLoading, snapshot);
  const hasFilters = Boolean(query || level !== "all" || source !== "all");

  return (
    <div className={eventStyles().page()}>
      <div className={eventStyles().heading({ className: "page-heading" })}>
        <div>
          <h1>{LL.events.title()}</h1>
          <p>{LL.events.description()}</p>
        </div>
        <span className={eventStyles().retention()}>{LL.events.retention()}</span>
      </div>

      <div className={eventStyles().status()} data-state={sourceState.state} role="status">
        <span>{sourceState.message}</span>
        {snapshot?.sessionId ? (
          <span className="tabular">
            {LL.events.session({
              count: snapshot.reconnectCount,
              session: snapshot.sessionId,
            })}
          </span>
        ) : null}
      </div>

      {snapshot ? (
        <section aria-labelledby="event-sources-title" className={eventStyles().sources()}>
          <div className={eventStyles().sourceHeading()}>
            <h2 id="event-sources-title">{LL.events.sourceAvailability()}</h2>
            <p>{LL.events.sourceDescription()}</p>
          </div>
          <div className={eventStyles().sourceGrid()}>
            {snapshot.sourceStatuses.map((status) => (
              <div className={eventStyles().sourceItem()} key={status.source}>
                <span>{sourceLabel(LL, status.source)}</span>
                <span className={eventStyles().sourcePhase()} data-phase={status.phase}>
                  <span aria-hidden="true" className={eventStyles().sourceIndicator()} />
                  {sourcePhaseLabel(LL, status.phase)}
                </span>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section
        aria-labelledby="guided-diagnostics-title"
        className="diagnostics-section"
        id="diagnostics"
        ref={diagnosticsRef}
        tabIndex={-1}
      >
        <div className="section-heading diagnostics-heading">
          <div>
            <h2 id="guided-diagnostics-title">{LL.diagnostics.title()}</h2>
            <p>{LL.diagnostics.description()}</p>
          </div>
          {diagnosticHistory?.activeRunId ? (
            <Button
              disabled={diagnosticPending}
              loading={diagnosticPending}
              loadingText={LL.diagnostics.cancel()}
              onClick={() => void cancelDiagnosticRun(diagnosticHistory.activeRunId!)}
              variant="outline"
            >
              {LL.diagnostics.cancel()}
            </Button>
          ) : (
            <Button
              disabled={diagnosticPending}
              loading={diagnosticPending}
              loadingText={LL.diagnostics.run()}
              onClick={() => void startDiagnosticRun()}
            >
              {LL.diagnostics.run()}
            </Button>
          )}
        </div>
        {diagnosticHistory?.adapterKind === "fixture" ? (
          <p className="diagnostics-fixture-note" role="status">
            {LL.diagnostics.fixtureNotice()}
          </p>
        ) : null}
        {diagnosticError ? (
          <p className="diagnostics-error" role="alert">
            {LL.diagnostics.error()}
          </p>
        ) : null}
        {diagnosticHistory?.runs.length ? (
          <div className="diagnostic-history">
            {diagnosticHistory.runs.map((run) => (
              <DiagnosticRun key={run.id} locale={locale} run={run} translations={LL} />
            ))}
          </div>
        ) : (
          <p className="diagnostics-empty">{LL.diagnostics.empty()}</p>
        )}
        <div className="support-bundle-section">
          <div>
            <h3>{LL.diagnostics.export.title()}</h3>
            <p>{LL.diagnostics.export.description()}</p>
          </div>
          <Button
            disabled={supportBundleAvailability !== "supported" || supportBundlePending}
            loading={supportBundlePending}
            loadingText={LL.diagnostics.export.preparing()}
            onClick={() => void previewSupportBundle()}
            variant="outline"
          >
            {LL.diagnostics.export.preview()}
          </Button>
        </div>
        {supportBundleAvailability !== "supported" ? (
          <p className="support-bundle-status" role="status">
            {LL.diagnostics.export.unavailable()}
          </p>
        ) : null}
        {supportBundleResult !== "idle" ? (
          <p
            className="support-bundle-status"
            data-status={supportBundleResult}
            role={supportBundleResult === "failed" ? "alert" : "status"}
          >
            {LL.diagnostics.export.result[supportBundleResult]()}
          </p>
        ) : null}
      </section>

      {supportBundlePreview ? (
        <Dialog onOpenChange={(open) => (open ? undefined : clearSupportBundlePreview())} open>
          <DialogContent className="support-bundle-dialog" closeLabel={LL.common.close()}>
            <>
              <DialogHeader>
                <DialogTitle className="dialog-title">
                  {LL.diagnostics.export.previewTitle()}
                </DialogTitle>
                <DialogDescription className="dialog-description">
                  {LL.diagnostics.export.previewDescription()}
                </DialogDescription>
              </DialogHeader>
              <dl className="support-bundle-metadata">
                <div>
                  <dt>{LL.diagnostics.export.format()}</dt>
                  <dd>JSON · v{supportBundlePreview.formatVersion}</dd>
                </div>
                <div>
                  <dt>{LL.diagnostics.export.size()}</dt>
                  <dd>
                    {formatBytes(supportBundlePreview.contentBytes)} /{" "}
                    {formatBytes(supportBundlePreview.maxBytes)}
                  </dd>
                </div>
                <div>
                  <dt>{LL.diagnostics.export.timeRange()}</dt>
                  <dd>
                    {formatSupportBundleTimeRange(
                      supportBundlePreview.timeRange,
                      locale,
                      LL.diagnostics.export.noHistory(),
                    )}
                  </dd>
                </div>
              </dl>
              <div className="support-bundle-preview-body">
                <section aria-labelledby="support-bundle-categories">
                  <h4 id="support-bundle-categories">{LL.diagnostics.export.categories()}</h4>
                  <SectionGrid className="support-bundle-category-grid">
                    {supportBundlePreview.categories.map(({ category, itemCount }) => (
                      <SectionGridItem className="support-bundle-category" key={category}>
                        <span>{supportBundleCategoryLabel(LL, category)}</span>
                        <strong className="tabular">{itemCount}</strong>
                      </SectionGridItem>
                    ))}
                  </SectionGrid>
                </section>
                <section aria-labelledby="support-bundle-redactions">
                  <h4 id="support-bundle-redactions">{LL.diagnostics.export.redactions()}</h4>
                  <ul className="support-bundle-redactions">
                    {supportBundlePreview.excludedOrRedacted.map((category) => (
                      <li key={category}>{supportBundleRedactionLabel(LL, category)}</li>
                    ))}
                  </ul>
                </section>
              </div>
              <DialogFooter>
                <Button onClick={clearSupportBundlePreview} variant="outline">
                  {LL.common.cancel()}
                </Button>
                <Button
                  disabled={supportBundlePending}
                  loading={supportBundlePending}
                  loadingText={LL.diagnostics.export.saving()}
                  onClick={() => void saveSupportBundle(supportBundlePreview.previewId)}
                >
                  {LL.diagnostics.export.confirmSave()}
                </Button>
              </DialogFooter>
            </>
          </DialogContent>
        </Dialog>
      ) : null}

      <div className="events-controls">
        <Input
          aria-label={LL.events.searchLabel()}
          autoComplete="off"
          data-native-search
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={LL.events.searchPlaceholder()}
          spellCheck={false}
          type="search"
          value={query}
        />
        <EventFilterSelect
          label={LL.events.levelLabel()}
          onChange={(value) => setLevel(value as EventLevel | "all")}
          options={["all", ...eventLevels]}
          value={level}
          valueLabel={(value) => levelLabel(LL, value as EventLevel | "all")}
        />
        <EventFilterSelect
          label={LL.events.sourceLabel()}
          onChange={(value) => setSource(value as EventSource | "all")}
          options={["all", ...eventSources]}
          value={source}
          valueLabel={(value) => sourceFilterLabel(LL, value as EventSource | "all")}
        />
        <EventFilterSelect
          label={LL.events.orderLabel()}
          onChange={(value) => setOrder(value as EventsOrder)}
          options={["oldest", "newest"]}
          value={order}
          valueLabel={(value) =>
            value === "newest" ? LL.events.newestFirst() : LL.events.oldestFirst()
          }
        />
        <EventsToolbarButton
          label={viewPaused ? LL.events.resume() : LL.events.pause()}
          onClick={togglePause}
        >
          {viewPaused ? <Play aria-hidden="true" /> : <Pause aria-hidden="true" />}
        </EventsToolbarButton>
        <EventsToolbarButton
          disabled={followLatest || viewPaused}
          label={followLatest ? LL.events.followingLatest() : LL.events.followLatest()}
          onClick={followNow}
        >
          <ArrowDown aria-hidden="true" />
        </EventsToolbarButton>
        <EventsToolbarButton
          disabled={events.length === 0}
          label={LL.events.clearLocal()}
          onClick={clearVisibleLocal}
        >
          <Trash aria-hidden="true" />
        </EventsToolbarButton>
      </div>

      <p className="events-local-note">{LL.events.clearLocalDescription()}</p>
      {viewPaused ? (
        <p className="events-paused-note" role="status">
          {LL.events.paused({ count: bufferedWhilePaused })}
        </p>
      ) : null}

      {filteredEvents.length === 0 ? (
        <Empty className="events-empty">
          <EmptyHeader>
            <EmptyTitle>{hasFilters ? LL.events.noMatches() : LL.events.noEvents()}</EmptyTitle>
            <EmptyDescription>
              {hasFilters ? LL.events.noMatchesDescription() : LL.events.noEventsDescription()}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol className="events-list" onScroll={observeScroll} ref={listRef}>
          {filteredEvents.map((event) => (
            <li className="event-row" data-level={event.level} key={event.id}>
              <time className="tabular" dateTime={new Date(event.observedAt).toISOString()}>
                {formatEventTime(event.observedAt, locale)}
              </time>
              <Badge variant={levelBadge(event.level)}>{levelLabel(LL, event.level)}</Badge>
              <span className="event-source">{sourceLabel(LL, event.source)}</span>
              <div className="event-copy">
                <strong>{event.message}</strong>
                {event.detail ? <small>{event.detail}</small> : null}
                {offersDiagnostics(event) ? (
                  <Link className="event-diagnostics-link" to="/events?diagnostics=1">
                    {LL.diagnostics.open()}
                  </Link>
                ) : null}
              </div>
              <Button
                aria-label={copiedId === event.id ? LL.events.copied() : LL.events.copyEvent()}
                onClick={() => void copyEvent(event)}
                size="icon-sm"
                variant="ghost"
              >
                <Copy aria-hidden="true" data-icon="icon-only" />
              </Button>
            </li>
          ))}
        </ol>
      )}
      <span aria-live="polite" className="sr-only">
        {copiedId ? LL.events.copied() : ""}
      </span>
    </div>
  );
}

function EventsToolbarButton({
  children,
  disabled = false,
  label,
  onClick,
}: {
  children: ReactNode;
  disabled?: boolean;
  label: string;
  onClick(): void;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            aria-label={label}
            className="events-toolbar-button"
            disabled={disabled}
            onClick={onClick}
            size="icon-sm"
            variant="outline"
          />
        }
      >
        {children}
        <span className="events-toolbar-button-label">{label}</span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function DiagnosticRun({
  locale,
  run,
  translations: LL,
}: {
  locale: Locales;
  run: DiagnosticRunDto;
  translations: TranslationFunctions;
}) {
  return (
    <div className="diagnostic-run" data-status={run.status}>
      <div className="diagnostic-run-summary">
        <Badge variant={runBadge(run)}>{LL.diagnostics.status[run.status]()}</Badge>
        <span className="tabular">{formatEventTime(run.startedAt, locale)}</span>
        <span>
          {LL.diagnostics.policy({
            endpoint: run.policy.endpointLabel,
            id: run.policy.id,
            status: run.policy.expectedHttpStatus,
            timeout: run.policy.timeoutMilliseconds,
          })}
        </span>
      </div>
      <SectionGrid className="diagnostic-checks">
        {run.checks.map((check) => (
          <SectionGridItem className="diagnostic-check" data-status={check.status} key={check.id}>
            <div className="diagnostic-check-heading">
              <strong>{diagnosticCheckLabel(LL, check)}</strong>
              <Badge variant={checkBadge(check.status)}>
                {LL.diagnostics.status[check.status]()}
              </Badge>
            </div>
            <dl>
              <div>
                <dt>{LL.diagnostics.scope()}</dt>
                <dd>{check.scope}</dd>
              </div>
              <div>
                <dt>{LL.diagnostics.route()}</dt>
                <dd>{formatRouteTarget(check.routeTarget)}</dd>
              </div>
              <div>
                <dt>{LL.diagnostics.observation()}</dt>
                <dd>{formatObservedFact(check.observedFact)}</dd>
              </div>
              <div>
                <dt>{LL.diagnostics.inference()}</dt>
                <dd>{check.interpretation}</dd>
              </div>
            </dl>
          </SectionGridItem>
        ))}
      </SectionGrid>
    </div>
  );
}

function diagnosticCheckLabel(LL: TranslationFunctions, check: DiagnosticCheckDto) {
  const labels = LL.diagnostics.check;
  if (check.kind === "desktop-bridge") return labels.desktopBridge();
  if (check.kind === "direct-reachability") return labels.directReachability();
  if (check.kind === "proxy-reachability") return labels.proxyReachability();
  return labels[check.kind]();
}

function formatRouteTarget(target: DiagnosticRouteTargetDto) {
  if (target.kind === "policy-group") {
    return `group:${shortIdentifier(target.groupId)} → child:${shortIdentifier(target.childId)}`;
  }
  if (target.kind === "fixed-endpoint") return `${target.route}:fixed-policy-endpoint`;
  return target.kind;
}

function formatObservedFact(fact: DiagnosticObservedFactDto) {
  if (fact.kind === "bridge") return `authenticated=${String(fact.authenticated)}`;
  if (fact.kind === "core") return `phase=${fact.phase}; version=${fact.version ?? "redacted"}`;
  if (fact.kind === "profile")
    return `present=${String(fact.present)}; valid=${String(fact.valid)}`;
  if (fact.kind === "capture") {
    return `desired=${String(fact.desired)}; observed=${fact.observed}; drift=${String(fact.drift)}`;
  }
  if (fact.kind === "dns") return `address-record-count=${fact.addressCount}; values=redacted`;
  if (fact.kind === "reachability") {
    return `HTTP ${fact.httpStatus}; ${fact.latencyMilliseconds} ms`;
  }
  return fact.reason;
}

function shortIdentifier(value: string) {
  const separator = value.indexOf(":");
  const suffix = separator >= 0 ? value.slice(separator + 1) : value;
  return suffix.slice(0, 12);
}

function offersDiagnostics(event: EventRecordDto) {
  if (event.level !== "warning" && event.level !== "error") return false;
  return /core|start|profile|valid|permission|dns|system proxy|drift/iu.test(
    `${event.message} ${event.detail ?? ""}`,
  );
}

function runBadge(run: DiagnosticRunDto) {
  if (run.status === "completed" && run.checks.every((check) => check.status === "passed")) {
    return "success" as const;
  }
  if (run.status === "running") return "warning" as const;
  return "outline" as const;
}

function checkBadge(status: DiagnosticCheckDto["status"]) {
  if (status === "passed") return "success" as const;
  if (status === "failed") return "destructive" as const;
  if (status === "cancelled") return "warning" as const;
  return "outline" as const;
}

interface EventFilterSelectProps {
  label: string;
  onChange(value: string): void;
  options: string[];
  value: string;
  valueLabel(value: string): string;
}

function EventFilterSelect({
  label,
  onChange,
  options,
  value,
  valueLabel,
}: EventFilterSelectProps) {
  const items = options.map((option) => ({ label: valueLabel(option), value: option }));
  return (
    <Select
      items={items}
      onValueChange={(next) => (typeof next === "string" ? onChange(next) : undefined)}
      value={value}
    >
      <SelectTrigger aria-label={label}>
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

function getSourceState(
  LL: TranslationFunctions,
  connectionStale: boolean,
  error: string | null,
  isLoading: boolean,
  snapshot: ReturnType<typeof useEvents>["snapshot"],
) {
  if (error) return { message: LL.events.loadError(), state: "unavailable" };
  if (snapshot?.adapterKind === "fixture") {
    return { message: LL.events.fixtureNotice(), state: "fixture" };
  }
  if (connectionStale || snapshot?.phase === "stale") {
    return { message: LL.events.staleNotice(), state: "stale" };
  }
  if (isLoading || snapshot?.phase === "connecting") {
    return { message: LL.events.connectingNotice(), state: "connecting" };
  }
  if (snapshot?.phase === "ready") return { message: LL.events.liveNotice(), state: "ready" };
  return { message: LL.events.unavailableNotice(), state: "unavailable" };
}

function levelLabel(LL: TranslationFunctions, level: EventLevel | "all") {
  if (level === "all") return LL.events.allLevels();
  return LL.events.level[level]();
}

function sourceLabel(LL: TranslationFunctions, source: EventSource) {
  return LL.events.source[source]();
}

function sourceFilterLabel(LL: TranslationFunctions, source: EventSource | "all") {
  return source === "all" ? LL.events.allSources() : sourceLabel(LL, source);
}

function sourcePhaseLabel(LL: TranslationFunctions, phase: EventSourcePhase) {
  return LL.events.sourcePhase[phase]();
}

function levelBadge(level: EventLevel) {
  if (level === "error") return "destructive" as const;
  if (level === "warning") return "warning" as const;
  return "outline" as const;
}

function formatEventTime(value: number, locale: Locales) {
  return new Intl.DateTimeFormat(locale, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(value);
}

export function formatEventForCopy(event: EventRecordDto) {
  const header = `${new Date(event.observedAt).toISOString()} [${event.level.toUpperCase()}] [${event.source}] ${event.message}`;
  return event.detail ? `${header}\n${event.detail}` : header;
}

function supportBundleCategoryLabel(LL: TranslationFunctions, category: SupportBundleCategory) {
  return LL.diagnostics.export.category[category]();
}

function supportBundleRedactionLabel(
  LL: TranslationFunctions,
  category: SupportBundleRedactionCategory,
) {
  return LL.diagnostics.export.redaction[category]();
}

function formatBytes(value: number) {
  if (value < 1_024) return `${value} B`;
  return `${(value / 1_024).toFixed(1)} KiB`;
}

function formatSupportBundleTimeRange(
  range: { endedAt: number; startedAt: number } | null,
  locale: Locales,
  empty: string,
) {
  if (!range) return empty;
  const formatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "medium",
  });
  return `${formatter.format(range.startedAt)} – ${formatter.format(range.endedAt)}`;
}
