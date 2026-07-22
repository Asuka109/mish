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
import { ProxyPickerDialog } from "../components/proxy-picker-dialog";
import { ServiceMonitorSection } from "../components/service-monitor-section";
import { TrafficCaptureControl } from "../components/traffic-capture-control";
import { TrafficSparkline } from "../components/traffic-sparkline";
import { emptyStatusSessionTraffic, useStatusSessionTraffic } from "./status-session";
import { useCaptureCommand } from "../data/capture-command";
import { useConfiguredRouteCatalog } from "../data/configured-route-catalog";
import { useProduct } from "../data/product-provider";
import { useOptionalSettings } from "../data/settings-provider";
import { getCommandDescriptionId } from "../data/status-capabilities";
import type { CaptureSelectionDto, RoutingMode, SelectorPolicyGroupDto } from "@mish/contracts";
import { useI18nContext } from "../i18n/i18n-react";
import type { Locales } from "../i18n/i18n-types";

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
      <div className="status-loading">
        {connection.phase === "fixture" ? LL.status.loadingFixture() : LL.status.loadingDesktop()}
      </div>
    );
  }

  if (!snapshot) {
    return (
      <div className="status-loading" role="alert">
        {error ??
          (connection.phase === "fixture"
            ? LL.status.fixtureUnavailable()
            : LL.status.desktopUnavailable())}
      </div>
    );
  }

  const pickerGroupCandidate = groups.find((group) => group.id === pickerGroupId);
  const pickerGroup = pickerGroupCandidate?.type === "selector" ? pickerGroupCandidate : null;
  const pickerNodes = pickerGroup
    ? nodes.filter((node) => pickerGroup.childIds.includes(node.id))
    : [];
  const captureRuntime = snapshot.runtime;
  const captureSupported = isCommandSupported("capture");
  const groupSupported = isCommandSupported("group") && configuredRoutes === null;
  const routingSupported = isCommandSupported("routing");
  const groupDescriptionId = getCommandDescriptionId(snapshot.adapterKind, groupSupported);
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
      <div className="status-page">
        <h1 className="sr-only">{LL.navigation.status()}</h1>
        {snapshot.adapterKind !== "fixture" && connection.stale ? (
          <p className="fixture-error" role="status">
            {connection.phase === "reconnecting" ? LL.status.reconnecting() : LL.status.staleData()}
          </p>
        ) : null}
        {snapshot.adapterKind !== "fixture" &&
        (Boolean(error) ||
          connection.stale ||
          snapshot.runtime.phase === "error" ||
          snapshot.runtime.systemProxy.phase === "drift") ? (
          <Link className="status-diagnostics-link" to="/events?diagnostics=1">
            {LL.diagnostics.open()}
          </Link>
        ) : null}
        <div className="status-controls">
          <SectionGrid className="status-control-card">
            <SectionGridItem className="status-control-cell">
              <span className="status-control-label">{LL.status.routingMode()}</span>
              <ToggleGroup
                aria-label={LL.status.routingMode()}
                aria-describedby={routingDescriptionId}
                className="routing-mode-group"
                onValueChange={(values) => {
                  if (!routingSupported) return;
                  const nextMode = values[0] as RoutingMode | undefined;
                  if (nextMode) void changeRoutingMode(nextMode);
                }}
                spacing={0}
                value={[snapshot.routingMode]}
                variant="outline"
              >
                {(Object.keys(modeLabels) as RoutingMode[]).map((mode) => (
                  <ToggleGroupItem
                    aria-busy={routingPending && optimisticRoutingMode === mode}
                    aria-describedby={routingDescriptionId}
                    className="routing-mode-button"
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
            <SectionGridItem className="status-control-cell">
              <span className="status-control-label">{LL.status.trafficCapture()}</span>
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

        <div className="content-grid">
          <section
            aria-label={LL.status.currentSessionAria()}
            className="flat-section session-section"
          >
            <div className="section-heading">
              <div className="section-heading-copy">
                <h2>{LL.status.session()}</h2>
                <p title={sessionActivity}>{sessionActivity}</p>
              </div>
              <Link
                aria-label={LL.status.openLiveTrafficAria()}
                className="text-link"
                to="/traffic"
              >
                <span className="section-heading-action-label">{LL.status.openLiveTraffic()}</span>
                <CaretRight aria-hidden="true" />
              </Link>
            </div>
            <SectionGrid className="session-list" columns={2}>
              <SectionGridItem className="traffic-session-pair" columnSpan={2}>
                <div className="traffic-session-column traffic-session-summary-column">
                  <span className="traffic-session-label" data-direction="download">
                    <ArrowDown aria-hidden="true" />
                    <span className="traffic-session-copy">
                      <span>{LL.status.downloaded()}</span>
                      <small>
                        {captureActive ? formatBytes(sessionTraffic.downloadedBytes, locale) : "-"}
                      </small>
                    </span>
                  </span>
                  <span className="traffic-session-label" data-direction="upload">
                    <ArrowUp aria-hidden="true" />
                    <span className="traffic-session-copy">
                      <span>{LL.status.uploaded()}</span>
                      <small>
                        {captureActive ? formatBytes(sessionTraffic.uploadedBytes, locale) : "-"}
                      </small>
                    </span>
                  </span>
                </div>
                <div className="traffic-session-column traffic-session-rate-column">
                  <strong className="traffic-rate-value tabular">
                    {captureActive
                      ? formatRate(sessionTraffic.downloadBytesPerSecond, locale)
                      : "- B/s"}
                  </strong>
                  <strong className="traffic-rate-value tabular">
                    {captureActive
                      ? formatRate(sessionTraffic.uploadBytesPerSecond, locale)
                      : "- B/s"}
                  </strong>
                </div>
                <div className="traffic-session-column traffic-session-curve-column">
                  <div className="traffic-session-chart-stack">
                    <div className="traffic-session-chart-cell">
                      <TrafficSparkline
                        color="var(--color-traffic-download)"
                        data={sessionTraffic.downloadSeries}
                      />
                    </div>
                    <div className="traffic-session-chart-cell">
                      <TrafficSparkline
                        color="var(--color-traffic-upload)"
                        data={sessionTraffic.uploadSeries}
                      />
                    </div>
                  </div>
                </div>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>{LL.status.connections()}</span>
                <strong className="tabular">
                  {captureActive ? snapshot.metrics.activeConnections : "-"}
                </strong>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>{LL.status.activeRules()}</span>
                <strong className="tabular">
                  {captureActive
                    ? new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en").format(
                        snapshot.metrics.effectiveRules,
                      )
                    : "-"}
                </strong>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>{LL.status.memory()}</span>
                <strong className="tabular">
                  {captureActive ? formatBytes(snapshot.metrics.memoryBytes, locale) : "-"}
                </strong>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>{LL.status.uptime()}</span>
                <strong className="tabular">
                  {captureActive ? formatUptime(snapshot.metrics.uptimeSeconds) : "-"}
                </strong>
              </SectionGridItem>
            </SectionGrid>
          </section>

          <section aria-label={LL.status.groupsAria()} className="flat-section">
            <div className="section-heading">
              <div className="section-heading-copy">
                <h2>{LL.status.groups()}</h2>
                <p title={configuredRoutes ? LL.status.configuredOrder() : LL.status.usedFirst()}>
                  {configuredRoutes ? LL.status.configuredOrder() : LL.status.usedFirst()}
                </p>
              </div>
              <Link aria-label={LL.status.viewAllGroupsAria()} className="text-link" to="/routes">
                <span className="section-heading-action-label">{LL.status.viewAll()}</span>
                <CaretRight aria-hidden="true" />
              </Link>
            </div>
            {frequentGroups.length > 0 ? (
              <SectionGrid className="policy-group-list">
                {frequentGroups.map((group, index) => {
                  const pendingSelectionId = pendingGroupSelections.get(group.id);
                  const displayedChildId = pendingSelectionId ?? group.selectedChildId;
                  const selectedNode = nodes.find((node) => node.id === displayedChildId);
                  const selectedGroup = groups.find(
                    (candidate) => candidate.id === displayedChildId,
                  );
                  const rowContent = (
                    <>
                      <span className="policy-group-leading">
                        <span className="policy-group-rank tabular">{index + 1}</span>
                        <span className="policy-group-copy">
                          <strong className="policy-group-primary user-authored-label">
                            {group.label}
                          </strong>
                          <span className="policy-group-secondary user-authored-label">
                            {selectedNode?.label ?? selectedGroup?.label ?? LL.status.noSelection()}
                            {selectedNode?.latencyMilliseconds === null ||
                            selectedNode?.latencyMilliseconds === undefined
                              ? ""
                              : ` · ${selectedNode.latencyMilliseconds} ms`}
                          </span>
                        </span>
                      </span>
                      <span className="policy-group-trailing">
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
                      <SectionGridItem className="policy-group-row" key={group.id}>
                        {rowContent}
                      </SectionGridItem>
                    );
                  }
                  return (
                    <Button
                      aria-describedby={groupDescriptionId}
                      className="section-grid-item policy-group-row"
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
              <Empty className="policy-group-empty">
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
