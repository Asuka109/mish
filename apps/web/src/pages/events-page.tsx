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
import { cx, tv } from "@mish/ui/tv";
import { useEvents } from "../data/events-provider";
import { presentEvent, type PresentedEventRecord } from "../data/event-presentation";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales, TranslationFunctions } from "../i18n/i18n-types";
import {
  conclusionKind,
  filterEvents,
  selectDiagnosticConclusion,
  sortEvents,
  type DiagnosticConclusionKind,
  type EventsOrder,
} from "./events-model";

const eventLevels: EventLevel[] = ["debug", "info", "warning", "error"];
const eventSources: EventSource[] = ["application", "core", "platform", "rpc"];

const eventStyles = tv({
  slots: {
    page: cx(
      "events-page mx-auto min-h-full w-full max-w-page-wide px-page-gutter pt-7 pb-9",
      "max-page-compact:px-page-gutter-compact max-page-compact:py-xl",
      "max-shell-mobile:px-page-gutter-mobile max-shell-mobile:pt-4.5 max-shell-mobile:pb-6",
    ),
    heading: cx(
      "events-heading flex items-start justify-between gap-6 max-toolbar-compact:flex-col",
      "max-toolbar-compact:items-stretch max-toolbar-compact:gap-1.75 [&_p]:mt-1.25 [&_p]:max-w-170",
      "[&_p]:text-metadata [&_p]:text-muted-foreground",
    ),
    retention:
      "events-retention flex-none pt-1.25 text-caption text-muted-foreground whitespace-nowrap",
    status: cx(
      "events-source-status mt-5 flex min-h-9.5 items-center justify-between gap-4 rounded-md",
      "border border-hairline bg-surface-soft px-3 py-2 text-metadata text-fg",
      "max-toolbar-compact:flex-col max-toolbar-compact:items-stretch max-toolbar-compact:gap-1.75",
      "data-[state=stale]:border-feedback-warning-border data-[state=stale]:text-warning",
      "data-[state=connecting]:border-feedback-warning-border data-[state=connecting]:text-warning",
      "[&>span:last-child]:flex-none [&>span:last-child]:text-caption",
      "[&>span:last-child]:text-muted-foreground",
    ),
    sources: "events-sources-section mt-4",
    sourceHeading:
      "events-source-heading [&_p]:mt-0.75 [&_p]:text-caption [&_p]:leading-4.25 [&_p]:text-muted-foreground",
    sourceGrid: cx(
      "events-source-grid mt-2 grid grid-cols-4 gap-px overflow-hidden rounded-md border",
      "border-hairline bg-hairline-soft max-page-compact:grid-cols-2",
      "max-toolbar-compact:grid-cols-1",
    ),
    sourceItem: cx(
      "events-source-item flex min-h-10.5 min-w-0 items-center justify-between gap-2.5 bg-canvas",
      "px-2.5 py-2 text-metadata [&>span]:overflow-hidden [&>span]:text-ellipsis",
      "[&>span]:whitespace-nowrap [&>span]:font-medium",
    ),
    sourcePhase: cx(
      "events-source-phase inline-flex flex-none items-center gap-1.5 text-caption",
      "text-muted-foreground whitespace-nowrap data-[phase=ready]:text-success-text",
      "data-[phase=stale]:text-warning",
    ),
    sourceIndicator: cx(
      "events-source-indicator size-1.75 flex-none rounded-full bg-muted-soft",
      "[.events-source-phase[data-phase=ready]_&]:bg-success",
      "[.events-source-phase[data-phase=stale]_&]:bg-warning",
      "[.events-source-phase[data-phase=fixture-only]_&]:bg-brand",
    ),
    controls: cx(
      "events-controls mt-4 flex flex-wrap items-center gap-2 [&_.ui-input]:min-w-55",
      "[&_.ui-input]:flex-1 [&_.ui-input]:basis-65 max-shell-mobile:[&_.ui-input]:min-w-0",
      "[&_.ui-select-trigger]:min-w-33 [&_.ui-button_svg]:size-3.75",
    ),
    toolbarButton: "events-toolbar-button max-page-compact:w-auto max-page-compact:px-3.25",
    toolbarLabel: "events-toolbar-button-label hidden max-page-compact:inline",
    localNote: "events-local-note mt-2 text-caption leading-4.25 text-muted-foreground",
    pausedNote: "events-paused-note mt-2 text-caption leading-4.25 text-warning",
    empty: "events-empty mt-4 min-h-55 border-solid",
    list: cx(
      "events-list mt-4 min-h-55 max-h-[min(560px,calc(100vh_-_430px))] list-none overflow-auto",
      "overscroll-contain rounded-md border border-hairline p-0",
    ),
    row: cx(
      "event-row grid min-w-0 grid-cols-[86px_82px_104px_minmax(180px,1fr)_34px] items-start",
      "gap-2.5 border-b border-hairline-soft px-2.5 py-2.25 last:border-b-0",
      "max-page-compact:grid-cols-[76px_76px_92px_minmax(140px,1fr)_32px] max-page-compact:gap-1.75",
      "max-toolbar-compact:grid-cols-[74px_76px_minmax(0,1fr)_32px]",
      "max-shell-mobile:grid-cols-[62px_68px_minmax(0,1fr)_32px] max-shell-mobile:gap-1.5",
      "[&>time]:pt-0.75 [&>time]:text-caption [&>time]:text-muted-foreground",
      "[&_.ui-badge]:justify-self-start [&_.ui-button_svg]:size-3.75",
    ),
    source: "event-source pt-0.75 text-caption text-muted-foreground max-toolbar-compact:hidden",
    copy: cx(
      "event-copy grid min-w-0 gap-0.75 [&_strong]:wrap-anywhere [&_strong]:text-metadata",
      "[&_strong]:leading-4.75 [&_strong]:font-medium [&_small]:wrap-anywhere",
      "[&_small]:text-caption [&_small]:leading-4.25 [&_small]:text-muted-foreground",
    ),
    diagnostics:
      "diagnostics-section mt-6 scroll-mt-4 outline-none focus-visible:rounded-md focus-visible:shadow-focus-ring",
    diagnosticsHeading: cx(
      "diagnostics-heading flex min-h-11 items-start justify-between gap-4 px-1 pb-2.5",
      "max-toolbar-compact:flex-col max-toolbar-compact:items-stretch max-toolbar-compact:gap-1.75",
      "[&>div]:min-w-0 [&_p]:mt-1 [&_p]:max-w-190 [&_p]:text-metadata [&_p]:text-muted-foreground",
    ),
    diagnosticMessage: "text-metadata leading-4.75 text-muted-foreground",
    diagnosticStatus: "mt-2.5 min-h-4.75",
    diagnosticFixture: "text-warning",
    diagnosticError: "text-error",
    diagnosticHistory: "diagnostic-history grid gap-6",
    diagnosticConclusion:
      "diagnostic-conclusion mb-3 grid gap-1.5 rounded-md border border-hairline bg-surface-soft px-3.5 py-3 text-metadata [&_strong]:font-semibold [&_small]:text-caption [&_small]:text-muted-foreground",
    diagnosticRun: cx(
      "diagnostic-run mt-3 [.diagnostic-history_&+&]:border-t",
      "[.diagnostic-history_&+&]:border-hairline-soft [.diagnostic-history_&+&]:pt-5",
    ),
    diagnosticSummary: cx(
      "diagnostic-run-summary mb-2.5 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2",
      "text-caption text-muted-foreground [&>span:last-child]:min-w-55 [&>span:last-child]:flex-1",
      "[&>span:last-child]:wrap-anywhere max-shell-mobile:[&>span:last-child]:min-w-0",
    ),
    diagnosticChecks: "diagnostic-checks",
    diagnosticCheck: cx(
      "diagnostic-check min-w-0 px-3.5 py-3 first:rounded-ss-section-grid-inner",
      "first:rounded-se-section-grid-inner last:rounded-es-section-grid-inner",
      "last:rounded-ee-section-grid-inner",
    ),
    diagnosticCheckHeading:
      "diagnostic-check-heading flex items-center justify-between gap-3 [&_strong]:text-body [&_strong]:font-semibold",
    diagnosticFacts: cx(
      "mt-2.5 grid grid-cols-2 gap-x-4.5 gap-y-2.5 max-page-compact:grid-cols-1 [&>div]:min-w-0",
      "[&_dt]:text-label-small [&_dt]:font-medium [&_dt]:tracking-label",
      "[&_dt]:text-muted-foreground [&_dt]:uppercase [&_dd]:mt-0.5 [&_dd]:wrap-anywhere",
      "[&_dd]:text-metadata [&_dd]:leading-4.5 [&_dd]:text-fg",
    ),
    supportBundle: cx(
      "support-bundle-section mt-5 flex items-start justify-between gap-5 border-t",
      "border-hairline-soft pt-4.5 max-page-compact:flex-col max-page-compact:items-stretch",
      "[&>div]:min-w-0 [&>button]:max-page-compact:self-start [&_h3]:text-body [&_h3]:font-semibold",
      "[&_p]:mt-1 [&_p]:max-w-180 [&_p]:text-metadata [&_p]:leading-4.75",
      "[&_p]:text-muted-foreground",
    ),
    supportStatus: cx(
      "support-bundle-status mt-2.25 text-metadata text-muted-foreground",
      "data-[status=failed]:text-error data-[status=written]:text-success-text",
    ),
    supportDialog:
      "support-bundle-dialog w-[min(680px,calc(100vw_-_32px))] max-h-[min(760px,calc(100vh_-_32px))]",
    supportMetadata: cx(
      "support-bundle-metadata grid grid-cols-3 gap-px border-y border-hairline-soft",
      "bg-hairline-soft max-toolbar-compact:grid-cols-1 [&>div]:grid [&>div]:gap-1",
      "[&>div]:bg-canvas [&>div]:px-3.5 [&>div]:py-2.75 [&_dt]:text-caption",
      "[&_dt]:text-muted-foreground [&_dd]:wrap-anywhere [&_dd]:text-metadata [&_dd]:text-fg",
    ),
    supportPreview: cx(
      "support-bundle-preview-body grid min-h-0 gap-4.5 overflow-auto p-4 [&_section]:grid",
      "[&_section]:gap-2.25 [&_h4]:text-body [&_h4]:font-semibold",
    ),
    supportCategories:
      "support-bundle-category-grid [--section-grid-columns:2] max-toolbar-compact:[--section-grid-columns:1]",
    supportCategory: cx(
      "support-bundle-category flex min-w-0 items-center justify-between gap-3 px-2.75 py-2.25",
      "text-metadata text-fg first:rounded-ss-section-grid-inner",
      "first:rounded-se-section-grid-inner last:rounded-es-section-grid-inner",
      "last:rounded-ee-section-grid-inner [&_strong]:flex-none [&_strong]:font-medium",
      "[&_strong]:text-ink",
    ),
    supportRedactions: cx(
      "support-bundle-redactions grid grid-cols-2 gap-x-4.5 gap-y-1.5 pl-4.5 text-caption",
      "leading-4.25 text-muted-foreground max-toolbar-compact:grid-cols-1",
    ),
    diagnosticsLink:
      "event-diagnostics-link w-fit text-caption font-medium text-brand no-underline hover:underline",
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
  const diagnosticFailure = searchParams.get("failure");

  const viewPaused = paused && pausedSessionId === snapshot?.sessionId;
  const displayedEvents = viewPaused ? pausedEvents : events;
  const presentedEvents = useMemo(
    () => displayedEvents.map((event) => presentEvent(event, LL)),
    [LL, displayedEvents],
  );
  const filteredEvents = useMemo(
    () =>
      sortEvents(
        filterEvents(
          presentedEvents,
          query,
          level === "all" ? new Set() : new Set([level]),
          source === "all" ? new Set() : new Set([source]),
        ),
        order,
      ),
    [level, order, presentedEvents, query, source],
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

  async function copyEvent(event: PresentedEventRecord) {
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
          <span className="tabular-nums">
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
        className={eventStyles().diagnostics()}
        id="diagnostics"
        ref={diagnosticsRef}
        tabIndex={-1}
      >
        <div className={eventStyles().diagnosticsHeading()}>
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
        <div className={eventStyles().diagnosticStatus()}>
          {diagnosticHistory?.adapterKind === "fixture" ? (
            <p
              className={eventStyles().diagnosticMessage({
                className: eventStyles().diagnosticFixture(),
              })}
              role="status"
            >
              {LL.diagnostics.fixtureNotice()}
            </p>
          ) : diagnosticError ? (
            <p
              className={eventStyles().diagnosticMessage({
                className: eventStyles().diagnosticError(),
              })}
              role="alert"
            >
              {LL.diagnostics.error()}
            </p>
          ) : null}
        </div>
        {diagnosticHistory?.runs.length ? (
          <div className={eventStyles().diagnosticHistory()}>
            {diagnosticHistory.runs.map((run) => (
              <DiagnosticRun
                contextFailure={diagnosticFailure}
                key={run.id}
                locale={locale}
                run={run}
                translations={LL}
              />
            ))}
          </div>
        ) : (
          <p className={eventStyles().diagnosticMessage()}>{LL.diagnostics.empty()}</p>
        )}
        <div className={eventStyles().supportBundle()}>
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
          <p className={eventStyles().supportStatus()} role="status">
            {LL.diagnostics.export.unavailable()}
          </p>
        ) : null}
        {supportBundleResult !== "idle" ? (
          <p
            className={eventStyles().supportStatus()}
            data-status={supportBundleResult}
            role={supportBundleResult === "failed" ? "alert" : "status"}
          >
            {LL.diagnostics.export.result[supportBundleResult]()}
          </p>
        ) : null}
      </section>

      {supportBundlePreview ? (
        <Dialog onOpenChange={(open) => (open ? undefined : clearSupportBundlePreview())} open>
          <DialogContent className={eventStyles().supportDialog()} closeLabel={LL.common.close()}>
            <>
              <DialogHeader>
                <DialogTitle className="dialog-title">
                  {LL.diagnostics.export.previewTitle()}
                </DialogTitle>
                <DialogDescription className="dialog-description">
                  {LL.diagnostics.export.previewDescription()}
                </DialogDescription>
              </DialogHeader>
              <dl className={eventStyles().supportMetadata()}>
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
              <div className={eventStyles().supportPreview()}>
                <section aria-labelledby="support-bundle-categories">
                  <h4 id="support-bundle-categories">{LL.diagnostics.export.categories()}</h4>
                  <SectionGrid className={eventStyles().supportCategories()}>
                    {supportBundlePreview.categories.map(({ category, itemCount }) => (
                      <SectionGridItem className={eventStyles().supportCategory()} key={category}>
                        <span>{supportBundleCategoryLabel(LL, category)}</span>
                        <strong className="tabular-nums">{itemCount}</strong>
                      </SectionGridItem>
                    ))}
                  </SectionGrid>
                </section>
                <section aria-labelledby="support-bundle-redactions">
                  <h4 id="support-bundle-redactions">{LL.diagnostics.export.redactions()}</h4>
                  <ul className={eventStyles().supportRedactions()}>
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

      <div className={eventStyles().controls()}>
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

      <p className={eventStyles().localNote()}>{LL.events.clearLocalDescription()}</p>
      {viewPaused ? (
        <p className={eventStyles().pausedNote()} role="status">
          {LL.events.paused({ count: bufferedWhilePaused })}
        </p>
      ) : null}

      {filteredEvents.length === 0 ? (
        <Empty className={eventStyles().empty()}>
          <EmptyHeader>
            <EmptyTitle>{hasFilters ? LL.events.noMatches() : LL.events.noEvents()}</EmptyTitle>
            <EmptyDescription>
              {hasFilters ? LL.events.noMatchesDescription() : LL.events.noEventsDescription()}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ol className={eventStyles().list()} onScroll={observeScroll} ref={listRef}>
          {filteredEvents.map((event) => (
            <li className={eventStyles().row()} data-level={event.level} key={event.id}>
              <time className="tabular-nums" dateTime={new Date(event.observedAt).toISOString()}>
                {formatEventTime(event.observedAt, locale)}
              </time>
              <Badge variant={levelBadge(event.level)}>{levelLabel(LL, event.level)}</Badge>
              <span className={eventStyles().source()}>{sourceLabel(LL, event.source)}</span>
              <div className={eventStyles().copy()}>
                <strong>{event.message}</strong>
                {event.detail ? <small>{event.detail}</small> : null}
                {offersDiagnostics(event) ? (
                  <Link className={eventStyles().diagnosticsLink()} to="/events?diagnostics=1">
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
            className={eventStyles().toolbarButton()}
            disabled={disabled}
            onClick={onClick}
            size="icon-sm"
            variant="outline"
          />
        }
      >
        {children}
        <span className={eventStyles().toolbarLabel()}>{label}</span>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function DiagnosticRun({
  contextFailure,
  locale,
  run,
  translations: LL,
}: {
  contextFailure: string | null;
  locale: Locales;
  run: DiagnosticRunDto;
  translations: TranslationFunctions;
}) {
  const conclusion = selectDiagnosticConclusion(run);
  const fromNotification =
    contextFailure !== null && conclusionKind(contextFailure as never) === conclusion.kind;
  return (
    <div className={eventStyles().diagnosticRun()} data-status={run.status}>
      <div className={eventStyles().diagnosticSummary()}>
        <Badge variant={runBadge(run)}>{LL.diagnostics.status[run.status]()}</Badge>
        <span className="tabular-nums">{formatEventTime(run.startedAt, locale)}</span>
        <span>
          {LL.diagnostics.policy({
            endpoint: run.policy.endpointLabel,
            id: run.policy.id,
            status: run.policy.expectedHttpStatus,
            timeout: run.policy.timeoutMilliseconds,
          })}
        </span>
      </div>
      <section
        aria-label={LL.diagnostics.conclusion.title()}
        className={eventStyles().diagnosticConclusion()}
        data-notification-context={fromNotification || undefined}
      >
        <strong>{LL.diagnostics.conclusion.title()}</strong>
        <span>{diagnosticConclusionCopy(LL, conclusion.kind)}</span>
        {conclusion.evidence.length ? (
          <small>{LL.diagnostics.conclusion.evidence({ count: conclusion.evidence.length })}</small>
        ) : null}
      </section>
      <SectionGrid className={eventStyles().diagnosticChecks()}>
        {run.checks.map((check) => (
          <SectionGridItem
            className={eventStyles().diagnosticCheck()}
            data-status={check.status}
            key={check.id}
          >
            <div className={eventStyles().diagnosticCheckHeading()}>
              <strong>{diagnosticCheckLabel(LL, check)}</strong>
              <Badge variant={checkBadge(check.status)}>
                {LL.diagnostics.status[check.status]()}
              </Badge>
            </div>
            <dl className={eventStyles().diagnosticFacts()}>
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

function diagnosticConclusionCopy(LL: TranslationFunctions, kind: DiagnosticConclusionKind) {
  return LL.diagnostics.conclusion[kind]();
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

function offersDiagnostics(event: PresentedEventRecord) {
  if (event.level !== "warning" && event.level !== "error") return false;
  return event.actionIds.includes("open-diagnostics");
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

export function formatEventForCopy(event: PresentedEventRecord) {
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
