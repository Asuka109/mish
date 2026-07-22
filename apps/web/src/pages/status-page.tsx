import { ArrowDown } from "@phosphor-icons/react/ArrowDown";
import { ArrowUp } from "@phosphor-icons/react/ArrowUp";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import {
  Empty,
  EmptyHeader,
  EmptyTitle,
  SectionGrid,
  SectionGridItem,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
} from "@mish/ui";
import { useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { cx, tv } from "@mish/ui/tv";
import { ProxyPickerDialog } from "../components/proxy-picker-dialog";
import { PolicyGroupSummaryRow } from "../components/policy-browser";
import { ServiceMonitorSection } from "../components/service-monitor-section";
import { TrafficCaptureControl } from "../components/traffic-capture-control";
import { TrafficSparkline } from "../components/traffic-sparkline";
import { emptyStatusSessionTraffic, useStatusSessionTraffic } from "./status-session";
import { useCaptureCommand } from "../data/capture-command";
import { useConfiguredRouteCatalog } from "../data/configured-route-catalog";
import { useProduct } from "../data/product-provider";
import { useOptionalSettings } from "../data/settings-provider";
import { getCommandDescriptionId } from "../data/status-capabilities";
import type { CaptureSelectionDto, RoutingMode } from "@mish/contracts";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales } from "../i18n/i18n-types";
import { buildRouteGraph, getRouteChildLatency, normalizeMeasuredLatency } from "./routes-model";
import styles from "./status-page.module.css";

const statusStyles = tv({
  slots: {
    page: cx(
      "mx-auto min-h-full w-full max-w-page px-8 pt-6 pb-8 max-page-compact:p-6",
      "max-shell-mobile:px-4 max-shell-mobile:pt-4.5 max-shell-mobile:pb-6",
    ),
    loading: "grid min-h-full place-content-center gap-2.5 text-center text-muted-foreground",
    error:
      "mb-3 rounded-md border border-feedback-error-border px-3 py-2.5 text-metadata text-error",
    diagnostics:
      "my-2 inline-flex text-metadata font-medium text-brand no-underline hover:underline",
    controls: "pb-4",
    controlCell: cx(
      "flex min-h-13.5 items-center gap-6 px-3.5 first:rounded-t-section-grid-inner",
      "last:rounded-b-section-grid-inner max-toolbar-compact:gap-4 max-shell-mobile:min-h-0",
      "max-shell-mobile:flex-col max-shell-mobile:items-start max-shell-mobile:gap-2",
      "max-shell-mobile:p-3",
    ),
    controlLabel: "font-medium text-fg whitespace-nowrap",
    routingItem: "px-3",
    contentGrid: cx(
      "content-grid mt-6 grid grid-cols-[minmax(340px,.95fr)_minmax(0,1.05fr)] gap-12",
      "max-profile-stack:gap-8 max-page-compact:grid-cols-1 runtime-mobile:grid-cols-1",
      "runtime-mobile:gap-6",
    ),
    section: "min-w-0",
    sessionSection: "min-w-0 @container/session",
    heading:
      "flex min-h-11 items-center justify-between gap-4 px-1 pb-2.5 max-shell-mobile:items-start",
    headingCopy: cx(
      "flex min-w-0 flex-1 items-baseline gap-2 [&_h2]:shrink-0 [&_p]:min-w-0 [&_p]:truncate",
      "[&_p]:text-metadata [&_p]:text-muted-foreground max-shell-mobile:flex-col",
      "max-shell-mobile:items-start max-shell-mobile:gap-0.5",
      "max-shell-mobile:[&_p]:overflow-visible max-shell-mobile:[&_p]:text-clip",
      "max-shell-mobile:[&_p]:whitespace-normal max-shell-mobile:[&_p]:wrap-anywhere",
    ),
    action: cx(
      "inline-flex shrink-0 items-center gap-1 rounded-sm p-1 text-metadata leading-4.5 text-fg",
      "no-underline whitespace-nowrap hover:text-ink hover:underline [&_svg]:size-3.25",
      "[&_svg]:shrink-0",
    ),
    sessionList: cx(
      "session-list flex flex-wrap gap-px overflow-visible rounded-md border border-hairline",
      "bg-hairline-soft p-0 [&>*]:min-w-0 [&>*]:overflow-clip [&>*]:bg-canvas",
      "[&>:first-child]:rounded-t-section-grid-inner",
      "[&>:nth-last-child(2)]:rounded-bl-section-grid-inner",
      "[&>:last-child]:rounded-br-section-grid-inner",
    ),
    trafficPair: cx(
      "traffic-session-pair relative flex min-h-32 grow-0 shrink-0 basis-full items-stretch gap-3",
      "after:pointer-events-none after:absolute after:inset-x-0 after:top-1/2 after:h-px",
      "after:-translate-y-1/2 after:bg-hairline-soft after:content-['']",
    ),
    trafficColumn: "traffic-session-column flex min-h-32 flex-col",
    trafficSummaryColumn: cx(
      "traffic-session-summary-column w-36 flex-none",
      "@max-session-compact/session:w-32",
    ),
    trafficRateColumn: cx(
      "traffic-session-rate-column w-24 min-w-24 flex-none",
      "@max-session-compact/session:w-19 @max-session-compact/session:min-w-19",
    ),
    trafficCurveColumn: "traffic-session-curve-column relative min-w-0 flex-1 overflow-hidden",
    trafficChartStack:
      "traffic-session-chart-stack absolute top-0 right-0 ml-auto flex h-32 w-90 min-w-90 flex-col",
    trafficChartCell: "traffic-session-chart-cell flex min-h-0 flex-1 items-center",
    trafficLabel: cx(
      "traffic-session-label flex min-h-0 min-w-0 flex-1 items-center gap-2 pl-3",
      "text-metadata text-muted-soft",
      "[&>svg]:size-3.5 data-[direction=download]:[&>svg]:text-traffic-download",
      "data-[direction=upload]:[&>svg]:text-traffic-upload",
    ),
    trafficCopy: cx(
      "traffic-session-copy grid min-w-0 gap-px [&>span]:text-muted-foreground",
      "[&>span]:whitespace-nowrap",
      "[&>small]:text-caption [&>small]:text-muted-soft [&>small]:whitespace-nowrap",
    ),
    trafficRate: cx(
      "traffic-rate-value flex min-h-0 min-w-0 flex-1 items-center px-2 text-metadata",
      "font-medium text-muted-foreground whitespace-nowrap",
    ),
    metric: cx(
      "session-metric grid min-h-13 grow shrink basis-[calc(50%_-_0.5px)] content-center",
      "gap-0.5 px-3 py-1.75 [&>span]:text-metadata",
      "[&>span]:text-muted-foreground [&>strong]:truncate [&>strong]:text-metadata",
      "[&>strong]:font-medium",
    ),
    policyList: cx(
      "policy-group-list gap-0 bg-canvas [&>:not(:first-child)]:border-t [&>:not(:first-child)]:border-hairline-soft",
      "[&>:first-child]:rounded-t-section-grid-inner [&>:last-child]:rounded-b-section-grid-inner",
    ),
    policyRow: cx(
      "flex min-h-12.5 w-full items-center justify-between gap-2.5 rounded-none border-0",
      "bg-transparent py-0 pr-3 pl-2.5 text-left text-fg hover:bg-accent hover:text-ink-active",
    ),
    policyLeading: "flex min-w-0 items-center gap-2.5",
    policyTrailing: "flex shrink-0 items-center gap-2.5 [&>svg]:size-3.25 [&>svg]:text-muted-soft",
    policyRank: "text-center text-caption text-muted-soft",
    policyCopy: "grid min-w-0 gap-0.5",
    policyPrimary: "truncate text-body font-medium",
    policySecondary: "truncate text-metadata text-muted-foreground",
  },
});

function formatBytes(value: number, locale: Locales) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unitIndex = 0;
  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }
  const maximumFractionDigits = amount < 10 ? 2 : 1;
  const language = locale === "zh" ? "zh-CN" : "en";
  return `${new Intl.NumberFormat(language, { maximumFractionDigits }).format(amount)} ${units[unitIndex]}`;
}

function formatRate(value: number, locale: Locales) {
  return `${formatBytes(value, locale)}/s`;
}

function formatUptime(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainingSeconds = seconds % 60;
  return [hours, minutes, remainingSeconds].map((part) => String(part).padStart(2, "0")).join(":");
}

export function StatusPage() {
  const {
    connection,
    error,
    isCommandPending,
    isCommandSupported,
    isLoading,
    setRoutingMode,
    snapshot,
  } = useProduct();
  const { pending: capturePending, setCapture } = useCaptureCommand();
  const settings = useOptionalSettings();
  const { LL, locale } = useI18nContext();
  const [pickerGroupId, setPickerGroupId] = useState<string | null>(null);
  const pickerTriggerRef = useRef<HTMLElement | null>(null);
  const [optimisticCaptureSelection, setOptimisticCaptureSelection] =
    useState<CaptureSelectionDto | null>(null);
  const [optimisticRoutingMode, setOptimisticRoutingMode] = useState<RoutingMode | null>(null);
  const [pendingCaptureMode, setPendingCaptureMode] = useState<"systemProxy" | "tun" | null>(null);
  const captureActive = Boolean(
    snapshot?.runtime.systemProxyEnabled || snapshot?.runtime.tunEnabled,
  );
  const sessionTraffic = useStatusSessionTraffic(
    snapshot?.traffic ?? emptyStatusSessionTraffic,
    captureActive,
  );
  const configuredRoutes = useConfiguredRouteCatalog(snapshot);
  const groups = configuredRoutes?.groups ?? snapshot?.groups ?? [];
  const nodes = configuredRoutes?.nodes ?? snapshot?.nodes ?? [];
  const routeGraph = useMemo(() => buildRouteGraph(groups, nodes), [groups, nodes]);
  const modeLabels: Record<RoutingMode, string> = {
    direct: LL.status.modeDirect(),
    global: LL.status.modeGlobal(),
    rule: LL.status.modeRule(),
  };
  const routingPending = isCommandPending("routing");

  const frequentGroups = useMemo(() => {
    if (!snapshot) return [];
    const usageByGroup = new Map(
      snapshot.groupUsage.map((usage) => [usage.groupId, usage.observedConnectionCount]),
    );
    return groups
      .toSorted(
        (first, second) => (usageByGroup.get(second.id) ?? 0) - (usageByGroup.get(first.id) ?? 0),
      )
      .slice(0, 5);
  }, [groups, snapshot]);

  if (isLoading) {
    return (
      <div className={statusStyles().loading()}>
        {connection.phase === "fixture" ? LL.status.loadingFixture() : LL.status.loadingDesktop()}
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className={statusStyles().loading()} role="alert">
        {error ??
          (connection.phase === "fixture"
            ? LL.status.fixtureUnavailable()
            : LL.status.desktopUnavailable())}
      </div>
    );
  }

  const pickerGroup = pickerGroupId ? routeGraph.groupById.get(pickerGroupId) : null;
  const captureRuntime = snapshot.runtime;
  const captureSupported = isCommandSupported("capture");
  const groupSupported = isCommandSupported("group") && configuredRoutes === null;
  const routingSupported = isCommandSupported("routing");
  const routingDescriptionId = getCommandDescriptionId(snapshot.adapterKind, routingSupported);
  const sessionActivity =
    snapshot.adapterKind === "fixture"
      ? LL.status.fixtureActivity()
      : snapshot.adapterKind === "rpc"
        ? LL.status.desktopActivity()
        : LL.status.deviceActivity();

  async function changeCaptureMode(mode: "systemProxy" | "tun", selected: boolean) {
    if (!captureSupported) return;
    const selection = { ...captureRuntime.captureSelection, [mode]: selected };
    const active = captureActive ? selection.systemProxy || selection.tun : selected;
    setOptimisticCaptureSelection(selection);
    setPendingCaptureMode(mode);
    try {
      await setCapture(selection, active);
    } finally {
      setOptimisticCaptureSelection(null);
      setPendingCaptureMode(null);
    }
  }

  async function changeRoutingMode(mode: RoutingMode) {
    setOptimisticRoutingMode(mode);
    try {
      await setRoutingMode(mode);
    } finally {
      setOptimisticRoutingMode(null);
    }
  }

  function openPicker(groupId: string) {
    pickerTriggerRef.current = document.activeElement as HTMLElement | null;
    setPickerGroupId(groupId);
  }

  return (
    <div>
      <div className={statusStyles().page()}>
        <h1 className="sr-only">{LL.navigation.status()}</h1>
        {snapshot.adapterKind !== "fixture" && connection.stale ? (
          <p className={statusStyles().error()} role="status">
            {connection.phase === "reconnecting" ? LL.status.reconnecting() : LL.status.staleData()}
          </p>
        ) : null}
        {snapshot.adapterKind !== "fixture" &&
        (Boolean(error) ||
          connection.stale ||
          snapshot.runtime.phase === "error" ||
          snapshot.runtime.systemProxy.phase === "drift") ? (
          <Link className={statusStyles().diagnostics()} to="/events?diagnostics=1">
            {LL.diagnostics.open()}
          </Link>
        ) : null}
        <div className={statusStyles().controls()}>
          <SectionGrid>
            <SectionGridItem className={statusStyles().controlCell()}>
              <span className={statusStyles().controlLabel()}>{LL.status.routingMode()}</span>
              <ToggleGroup
                aria-label={LL.status.routingMode()}
                aria-describedby={routingDescriptionId}
                onValueChange={(values) => {
                  if (!routingSupported) return;
                  const nextMode = values[0] as RoutingMode | undefined;
                  if (nextMode) void changeRoutingMode(nextMode);
                }}
                spacing={0}
                value={[snapshot.routingMode]}
                variant="segmented"
              >
                {(Object.keys(modeLabels) as RoutingMode[]).map((mode) => (
                  <ToggleGroupItem
                    aria-busy={routingPending && optimisticRoutingMode === mode}
                    aria-describedby={routingDescriptionId}
                    className={statusStyles().routingItem()}
                    disabled={routingPending || !routingSupported}
                    key={mode}
                    value={mode}
                  >
                    {routingPending && optimisticRoutingMode === mode ? (
                      <Spinner data-icon="inline-start" />
                    ) : null}
                    {modeLabels[mode]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </SectionGridItem>
            <SectionGridItem className={statusStyles().controlCell()}>
              <span className={statusStyles().controlLabel()}>{LL.status.trafficCapture()}</span>
              <TrafficCaptureControl
                adapterKind={snapshot.adapterKind}
                capabilities={snapshot.capabilities}
                commandSupported={captureSupported}
                disabled={capturePending || captureRuntime.systemProxy.recoveryActions.length > 0}
                onSystemProxyChange={(selected) => changeCaptureMode("systemProxy", selected)}
                onTunHelperInstall={settings?.installTunHelper}
                onTunChange={(selected) => changeCaptureMode("tun", selected)}
                pending={capturePending}
                pendingMode={pendingCaptureMode}
                systemProxyEnabled={captureRuntime.systemProxyEnabled}
                systemProxySelected={
                  optimisticCaptureSelection?.systemProxy ??
                  captureRuntime.captureSelection.systemProxy
                }
                systemProxyStatus={captureRuntime.systemProxy}
                tunEnabled={captureRuntime.tunEnabled}
                tunGuideIdentity={
                  settings?.snapshot.tunHelper.installationId ??
                  settings?.snapshot.tunHelper.installedVersion ??
                  settings?.snapshot.tunHelper.expectedVersion ??
                  null
                }
                tunHelperReady={
                  settings?.snapshot.tunHelper.availability === "available" &&
                  settings.snapshot.tunHelper.health === "healthy" &&
                  settings.snapshot.tunHelper.installedVersion ===
                    settings.snapshot.tunHelper.expectedVersion &&
                  settings.snapshot.tunHelper.phase === "idle" &&
                  settings.snapshot.tunHelper.lastFailure === null
                }
                tunSelected={optimisticCaptureSelection?.tun ?? captureRuntime.captureSelection.tun}
                tunStatus={captureRuntime.tun}
              />
            </SectionGridItem>
          </SectionGrid>
        </div>

        <div className={statusStyles().contentGrid()}>
          <section
            aria-label={LL.status.currentSessionAria()}
            className={statusStyles().sessionSection()}
          >
            <div className={statusStyles().heading()}>
              <div className={statusStyles().headingCopy()}>
                <h2>{LL.status.session()}</h2>
                <p title={sessionActivity}>{sessionActivity}</p>
              </div>
              <Link
                aria-label={LL.status.openLiveTrafficAria()}
                className={statusStyles().action()}
                to="/traffic"
              >
                <span>{LL.status.openLiveTraffic()}</span>
                <CaretRight aria-hidden="true" />
              </Link>
            </div>
            <div className={statusStyles().sessionList()}>
              <div className={statusStyles().trafficPair()}>
                <div
                  className={statusStyles().trafficColumn({
                    className: statusStyles().trafficSummaryColumn(),
                  })}
                >
                  <span className={statusStyles().trafficLabel()} data-direction="download">
                    <ArrowDown aria-hidden="true" />
                    <span className={statusStyles().trafficCopy()}>
                      <span>{LL.status.downloaded()}</span>
                      <small>
                        {captureActive ? formatBytes(sessionTraffic.downloadedBytes, locale) : "-"}
                      </small>
                    </span>
                  </span>
                  <span className={statusStyles().trafficLabel()} data-direction="upload">
                    <ArrowUp aria-hidden="true" />
                    <span className={statusStyles().trafficCopy()}>
                      <span>{LL.status.uploaded()}</span>
                      <small>
                        {captureActive ? formatBytes(sessionTraffic.uploadedBytes, locale) : "-"}
                      </small>
                    </span>
                  </span>
                </div>
                <div
                  className={statusStyles().trafficColumn({
                    className: statusStyles().trafficRateColumn(),
                  })}
                >
                  <strong className={statusStyles().trafficRate({ className: "tabular-nums" })}>
                    {captureActive
                      ? formatRate(sessionTraffic.downloadBytesPerSecond, locale)
                      : "- B/s"}
                  </strong>
                  <strong className={statusStyles().trafficRate({ className: "tabular-nums" })}>
                    {captureActive
                      ? formatRate(sessionTraffic.uploadBytesPerSecond, locale)
                      : "- B/s"}
                  </strong>
                </div>
                <div
                  className={statusStyles().trafficColumn({
                    className: statusStyles().trafficCurveColumn({
                      className: styles.trafficCurveColumn,
                    }),
                  })}
                >
                  <div className={statusStyles().trafficChartStack()}>
                    <div className={statusStyles().trafficChartCell()}>
                      <TrafficSparkline
                        color="var(--color-traffic-download)"
                        data={sessionTraffic.downloadSeries}
                      />
                    </div>
                    <div className={statusStyles().trafficChartCell()}>
                      <TrafficSparkline
                        color="var(--color-traffic-upload)"
                        data={sessionTraffic.uploadSeries}
                      />
                    </div>
                  </div>
                </div>
              </div>
              <div className={statusStyles().metric()}>
                <span>{LL.status.connections()}</span>
                <strong className="tabular-nums">
                  {captureActive ? snapshot.metrics.activeConnections : "-"}
                </strong>
              </div>
              <div className={statusStyles().metric()}>
                <span>{LL.status.activeRules()}</span>
                <strong className="tabular-nums">
                  {captureActive
                    ? new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en").format(
                        snapshot.metrics.effectiveRules,
                      )
                    : "-"}
                </strong>
              </div>
              <div className={statusStyles().metric()}>
                <span>{LL.status.memory()}</span>
                <strong className="tabular-nums">
                  {captureActive ? formatBytes(snapshot.metrics.memoryBytes, locale) : "-"}
                </strong>
              </div>
              <div className={statusStyles().metric()}>
                <span>{LL.status.uptime()}</span>
                <strong className="tabular-nums">
                  {captureActive ? formatUptime(snapshot.metrics.uptimeSeconds) : "-"}
                </strong>
              </div>
            </div>
          </section>

          <section aria-label={LL.status.groupsAria()} className={statusStyles().section()}>
            <div className={statusStyles().heading()}>
              <div className={statusStyles().headingCopy()}>
                <h2>{LL.status.groups()}</h2>
                <p title={configuredRoutes ? LL.status.configuredOrder() : LL.status.usedFirst()}>
                  {configuredRoutes ? LL.status.configuredOrder() : LL.status.usedFirst()}
                </p>
              </div>
              <Link
                aria-label={LL.status.viewAllGroupsAria()}
                className={statusStyles().action()}
                to="/routes"
              >
                <span>{LL.status.viewAll()}</span>
                <CaretRight aria-hidden="true" />
              </Link>
            </div>
            {routeGraph.errors.length > 0 ? (
              <p
                className="rounded-md border border-hairline bg-surface-soft p-3 text-metadata text-muted-foreground"
                role="alert"
              >
                {LL.routes.graphErrorTitle()}
              </p>
            ) : frequentGroups.length > 0 ? (
              <SectionGrid className={statusStyles().policyList()}>
                {frequentGroups.map((group, index) => {
                  const selectedLabel = group.selectedChildId
                    ? (routeGraph.nodeById.get(group.selectedChildId)?.label ??
                      routeGraph.groupById.get(group.selectedChildId)?.label)
                    : null;
                  const latency = normalizeMeasuredLatency(
                    getRouteChildLatency(routeGraph, group.selectedChildId ?? ""),
                  );
                  return (
                    <SectionGridItem key={group.id}>
                      <PolicyGroupSummaryRow
                        childCount={group.childIds.length}
                        childCountLabel={LL.status.availableChildren({
                          count: group.childIds.length,
                        })}
                        currentLabel={selectedLabel ?? LL.status.noSelection()}
                        density="compact"
                        group={group}
                        latency={
                          latency === null ? null : (
                            <span className="text-success-text tabular-nums"> · {latency} ms</span>
                          )
                        }
                        onOpen={group.childIds.length > 0 ? () => openPicker(group.id) : undefined}
                        rank={index + 1}
                      />
                    </SectionGridItem>
                  );
                })}
              </SectionGrid>
            ) : (
              <Empty>
                <EmptyHeader>
                  <EmptyTitle>{LL.status.groupsEmpty()}</EmptyTitle>
                </EmptyHeader>
              </Empty>
            )}
          </section>
        </div>

        <ServiceMonitorSection />
      </div>

      <ProxyPickerDialog
        commandsDisabled={!groupSupported || configuredRoutes !== null || connection.stale}
        graph={routeGraph}
        groupId={pickerGroup?.id ?? null}
        onOpenChange={(open) => {
          if (open) return;
          setPickerGroupId(null);
          requestAnimationFrame(() => pickerTriggerRef.current?.focus({ preventScroll: true }));
        }}
        open={pickerGroup !== null}
      />
    </div>
  );
}
