import { ArrowDown } from "@phosphor-icons/react/ArrowDown";
import { ArrowUp } from "@phosphor-icons/react/ArrowUp";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import {
  Badge,
  Button,
  Empty,
  EmptyHeader,
  EmptyTitle,
  SectionGrid,
  SectionGridItem,
  Spinner,
  ToggleGroup,
  ToggleGroupItem,
} from "@mish/ui";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { tv } from "tailwind-variants";
import { ProxyPickerDialog } from "../components/proxy-picker-dialog";
import { ServiceMonitorSection } from "../components/service-monitor-section";
import { TrafficCaptureControl } from "../components/traffic-capture-control";
import { TrafficSparkline } from "../components/traffic-sparkline";
import { useCaptureCommand } from "../data/capture-command";
import { useProduct } from "../data/product-provider";
import { useOptionalSettings } from "../data/settings-provider";
import { getCommandDescriptionId } from "../data/status-capabilities";
import type { CaptureSelectionDto, RoutingMode, SelectorPolicyGroupDto } from "@mish/contracts";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales } from "../i18n/i18n-types";

const statusStyles = tv({
  slots: {
    page: "mx-auto min-h-full w-[min(100%,1080px)] px-8 pt-6 pb-8 max-[900px]:p-6 max-[600px]:px-4 max-[600px]:pt-[18px] max-[600px]:pb-6",
    loading: "grid min-h-full place-content-center gap-2.5 text-center text-(--color-text-muted)",
    error:
      "mb-3 rounded-(--radius-md) border border-[color-mix(in_srgb,var(--color-error)_30%,var(--color-hairline))] px-3 py-2.5 text-(--text-metadata) text-(--color-error)",
    diagnostics:
      "my-2 inline-flex text-(--text-metadata) font-(--font-weight-control) text-(--color-brand) no-underline hover:underline",
    controls: "pb-4",
    controlCell:
      "flex min-h-[54px] items-center gap-6 px-[14px] first:rounded-t-[7px] last:rounded-b-[7px] max-[820px]:gap-4 max-[600px]:min-h-0 max-[600px]:flex-col max-[600px]:items-start max-[600px]:gap-2 max-[600px]:p-3",
    controlLabel: "font-(--font-weight-control) text-(--color-body) whitespace-nowrap",
    routingItem: "px-3",
    contentGrid:
      "content-grid mt-6 grid grid-cols-[minmax(340px,.95fr)_minmax(0,1.05fr)] gap-12 max-[1060px]:gap-8 max-[900px]:grid-cols-1",
    section: "min-w-0",
    sessionSection: "min-w-0 @container/session",
    heading: "flex min-h-11 items-center justify-between gap-4 px-1 pb-2.5 max-[600px]:items-start",
    headingCopy:
      "flex min-w-0 flex-1 items-baseline gap-2 [&_h2]:shrink-0 [&_p]:min-w-0 [&_p]:truncate [&_p]:text-(--text-metadata) [&_p]:text-(--color-text-muted) max-[600px]:flex-col max-[600px]:items-start max-[600px]:gap-0.5 max-[600px]:[&_p]:overflow-visible max-[600px]:[&_p]:text-clip max-[600px]:[&_p]:whitespace-normal max-[600px]:[&_p]:[overflow-wrap:anywhere]",
    action:
      "inline-flex shrink-0 items-center gap-1 rounded-(--radius-sm) p-1 text-(--text-metadata) leading-[18px] text-(--color-body) no-underline whitespace-nowrap hover:text-(--color-ink) hover:underline [&_svg]:size-[13px] [&_svg]:shrink-0",
    sessionList:
      "[--section-grid-columns:2] [&>:first-child]:rounded-t-[7px] [&>:nth-last-child(2)]:rounded-bl-[7px] [&>:last-child]:rounded-br-[7px]",
    trafficRow:
      "grid min-h-16 grid-cols-[auto_max-content_minmax(72px,1fr)] items-center gap-3 px-3 @max-[320px]/session:grid-cols-[minmax(0,1fr)_auto]",
    trafficLabel:
      "grid grid-cols-[auto_minmax(0,1fr)] items-center gap-2 text-(--text-metadata) text-(--color-muted-soft) [&>svg]:size-3.5 data-[direction=download]:[&>svg]:text-(--color-traffic-download) data-[direction=upload]:[&>svg]:text-(--color-traffic-upload)",
    trafficCopy:
      "grid min-w-0 gap-px [&>span]:text-(--color-text-muted) [&>small]:text-[12px] [&>small]:text-(--color-muted-soft)",
    trafficRate:
      "text-(--text-metadata) font-(--font-weight-control) text-(--color-text-muted) whitespace-nowrap",
    metric:
      "grid min-h-[52px] content-center gap-0.5 px-3 py-[7px] [&>span]:text-(--text-metadata) [&>span]:text-(--color-text-muted) [&>strong]:truncate [&>strong]:text-(--text-metadata) [&>strong]:font-(--font-weight-control)",
    policyList:
      "gap-0 bg-(--color-canvas) [&>:not(:first-child)]:border-t [&>:not(:first-child)]:border-(--color-hairline-soft) [&>:first-child]:rounded-t-[7px] [&>:last-child]:rounded-b-[7px]",
    policyRow:
      "flex min-h-[50px] w-full items-center justify-between gap-2.5 rounded-none border-0 bg-transparent py-0 pr-3 pl-2.5 text-left text-(--color-body) hover:bg-(--color-accent) hover:text-(--color-ink-active)",
    policyLeading: "flex min-w-0 items-center gap-2.5",
    policyTrailing:
      "flex shrink-0 items-center gap-2.5 [&>svg]:size-[13px] [&>svg]:text-(--color-muted-soft)",
    policyRank: "text-center text-[12px] text-(--color-muted-soft)",
    policyCopy: "grid min-w-0 gap-0.5",
    policyPrimary: "truncate text-(--text-body) font-(--font-weight-control)",
    policySecondary: "truncate text-(--text-metadata) text-(--color-text-muted)",
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
    isGroupCommandPending,
    isLoading,
    selectGroupChild,
    setRoutingMode,
    snapshot,
  } = useProduct();
  const { pending: capturePending, setCapture } = useCaptureCommand();
  const settings = useOptionalSettings();
  const { LL, locale } = useI18nContext();
  const [pickerGroupId, setPickerGroupId] = useState<string | null>(null);
  const [optimisticCaptureSelection, setOptimisticCaptureSelection] =
    useState<CaptureSelectionDto | null>(null);
  const [optimisticRoutingMode, setOptimisticRoutingMode] = useState<RoutingMode | null>(null);
  const [pendingCaptureMode, setPendingCaptureMode] = useState<"systemProxy" | "tun" | null>(null);
  const [pendingGroupSelections, setPendingGroupSelections] = useState<Map<string, string>>(
    () => new Map(),
  );
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
    return snapshot.groups
      .toSorted(
        (first, second) => (usageByGroup.get(second.id) ?? 0) - (usageByGroup.get(first.id) ?? 0),
      )
      .slice(0, 5);
  }, [snapshot]);

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

  const pickerGroupCandidate = snapshot.groups.find((group) => group.id === pickerGroupId);
  const pickerGroup = pickerGroupCandidate?.type === "selector" ? pickerGroupCandidate : null;
  const pickerNodes = pickerGroup
    ? snapshot.nodes.filter((node) => pickerGroup.childIds.includes(node.id))
    : [];
  const captureRuntime = snapshot.runtime;
  const captureSupported = isCommandSupported("capture");
  const groupSupported = isCommandSupported("group");
  const routingSupported = isCommandSupported("routing");
  const groupDescriptionId = getCommandDescriptionId(snapshot.adapterKind, groupSupported);
  const routingDescriptionId = getCommandDescriptionId(snapshot.adapterKind, routingSupported);
  const captureActive = captureRuntime.systemProxyEnabled || captureRuntime.tunEnabled;
  const hasTrafficData =
    snapshot.traffic.downloadSeries.length > 0 ||
    snapshot.traffic.uploadSeries.length > 0 ||
    snapshot.traffic.downloadBytesPerSecond > 0 ||
    snapshot.traffic.downloadedBytes > 0 ||
    snapshot.traffic.uploadBytesPerSecond > 0 ||
    snapshot.traffic.uploadedBytes > 0;
  const hasMetricsData = Object.values(snapshot.metrics).some((value) => value > 0);
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

  function openPicker(group: SelectorPolicyGroupDto) {
    setPickerGroupId(group.id);
  }

  async function selectGroupNode(groupId: string, nodeId: string) {
    setPendingGroupSelections((current) => new Map(current).set(groupId, nodeId));
    try {
      await selectGroupChild(groupId, nodeId);
    } finally {
      setPendingGroupSelections((current) => {
        const next = new Map(current);
        next.delete(groupId);
        return next;
      });
    }
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
            <SectionGrid className={statusStyles().sessionList()} columns={2}>
              <SectionGridItem className={statusStyles().trafficRow()} columnSpan={2}>
                <span className={statusStyles().trafficLabel()} data-direction="download">
                  <ArrowDown aria-hidden="true" />
                  <span className={statusStyles().trafficCopy()}>
                    <span>{LL.status.downloaded()}</span>
                    <small>
                      {hasTrafficData ? formatBytes(snapshot.traffic.downloadedBytes, locale) : "-"}
                    </small>
                  </span>
                </span>
                <strong className={`${statusStyles().trafficRate()} tabular`}>
                  {hasTrafficData
                    ? formatRate(snapshot.traffic.downloadBytesPerSecond, locale)
                    : "- B/s"}
                </strong>
                <TrafficSparkline
                  color="var(--color-traffic-download)"
                  data={snapshot.traffic.downloadSeries}
                  id="download"
                />
              </SectionGridItem>
              <SectionGridItem className={statusStyles().trafficRow()} columnSpan={2}>
                <span className={statusStyles().trafficLabel()} data-direction="upload">
                  <ArrowUp aria-hidden="true" />
                  <span className={statusStyles().trafficCopy()}>
                    <span>{LL.status.uploaded()}</span>
                    <small>
                      {hasTrafficData ? formatBytes(snapshot.traffic.uploadedBytes, locale) : "-"}
                    </small>
                  </span>
                </span>
                <strong className={`${statusStyles().trafficRate()} tabular`}>
                  {hasTrafficData
                    ? formatRate(snapshot.traffic.uploadBytesPerSecond, locale)
                    : "- B/s"}
                </strong>
                <TrafficSparkline
                  color="var(--color-traffic-upload)"
                  data={snapshot.traffic.uploadSeries}
                  id="upload"
                />
              </SectionGridItem>
              <SectionGridItem className={statusStyles().metric()}>
                <span>{LL.status.connections()}</span>
                <strong className="tabular">
                  {hasMetricsData ? snapshot.metrics.activeConnections : "-"}
                </strong>
              </SectionGridItem>
              <SectionGridItem className={statusStyles().metric()}>
                <span>{LL.status.activeRules()}</span>
                <strong className="tabular">
                  {hasMetricsData
                    ? new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en").format(
                        snapshot.metrics.effectiveRules,
                      )
                    : "-"}
                </strong>
              </SectionGridItem>
              <SectionGridItem className={statusStyles().metric()}>
                <span>{LL.status.memory()}</span>
                <strong className="tabular">
                  {hasMetricsData ? formatBytes(snapshot.metrics.memoryBytes, locale) : "-"}
                </strong>
              </SectionGridItem>
              <SectionGridItem className={statusStyles().metric()}>
                <span>{LL.status.uptime()}</span>
                <strong className="tabular">
                  {captureActive && hasMetricsData
                    ? formatUptime(snapshot.metrics.uptimeSeconds)
                    : "-"}
                </strong>
              </SectionGridItem>
            </SectionGrid>
          </section>

          <section aria-label={LL.status.groupsAria()} className={statusStyles().section()}>
            <div className={statusStyles().heading()}>
              <div className={statusStyles().headingCopy()}>
                <h2>{LL.status.groups()}</h2>
                <p title={LL.status.usedFirst()}>{LL.status.usedFirst()}</p>
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
            {frequentGroups.length > 0 ? (
              <SectionGrid className={statusStyles().policyList()}>
                {frequentGroups.map((group, index) => {
                  const pendingSelectionId = pendingGroupSelections.get(group.id);
                  const displayedChildId = pendingSelectionId ?? group.selectedChildId;
                  const selectedNode = snapshot.nodes.find((node) => node.id === displayedChildId);
                  const selectedGroup = snapshot.groups.find(
                    (candidate) => candidate.id === displayedChildId,
                  );
                  const rowContent = (
                    <>
                      <span className={statusStyles().policyLeading()}>
                        <span className={`${statusStyles().policyRank()} tabular`}>
                          {index + 1}
                        </span>
                        <span className={statusStyles().policyCopy()}>
                          <strong
                            className={`${statusStyles().policyPrimary()} user-authored-label`}
                          >
                            {group.label}
                          </strong>
                          <span
                            className={`${statusStyles().policySecondary()} user-authored-label`}
                          >
                            {selectedNode?.label ?? selectedGroup?.label ?? LL.status.noSelection()}
                            {selectedNode?.latencyMilliseconds === null ||
                            selectedNode?.latencyMilliseconds === undefined
                              ? ""
                              : ` · ${selectedNode.latencyMilliseconds} ms`}
                          </span>
                        </span>
                      </span>
                      <span className={statusStyles().policyTrailing()}>
                        <Badge
                          aria-label={LL.status.availableChildren({ count: group.childIds.length })}
                          variant="outline"
                        >
                          {group.childIds.length}
                        </Badge>
                        {group.type === "selector" ? <CaretRight aria-hidden="true" /> : null}
                      </span>
                    </>
                  );
                  if (group.type !== "selector") {
                    return (
                      <SectionGridItem className={statusStyles().policyRow()} key={group.id}>
                        {rowContent}
                      </SectionGridItem>
                    );
                  }
                  return (
                    <Button
                      aria-describedby={groupDescriptionId}
                      className={statusStyles().policyRow()}
                      disabled={isGroupCommandPending(group.id) || !groupSupported}
                      key={group.id}
                      loading={Boolean(pendingSelectionId)}
                      loadingText={LL.common.pending()}
                      onClick={() => openPicker(group)}
                      type="button"
                      variant="ghost"
                    >
                      {rowContent}
                    </Button>
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
        group={pickerGroup}
        nodes={pickerNodes}
        onOpenChange={(open) => !open && setPickerGroupId(null)}
        onSelect={(nodeId) => {
          if (pickerGroup) void selectGroupNode(pickerGroup.id, nodeId);
        }}
        open={pickerGroup !== null}
      />
    </div>
  );
}
