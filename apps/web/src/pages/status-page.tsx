import { ArrowDown } from "@phosphor-icons/react/ArrowDown";
import { ArrowUp } from "@phosphor-icons/react/ArrowUp";
import { CaretRight } from "@phosphor-icons/react/CaretRight";
import {
  Badge,
  Button,
  SectionGrid,
  SectionGridItem,
  ToggleGroup,
  ToggleGroupItem,
} from "@mish/ui";
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { ProxyPickerDialog } from "../components/proxy-picker-dialog";
import { ServiceMonitorSection } from "../components/service-monitor-section";
import { TrafficCaptureControl } from "../components/traffic-capture-control";
import { TrafficSparkline } from "../components/traffic-sparkline";
import { useProduct } from "../data/product-provider";
import type { PolicyGroupDto, RoutingMode } from "@mish/contracts";
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
    isLoading,
    selectGroupChild,
    setCapture,
    setRoutingMode,
    snapshot,
  } = useProduct();
  const { LL, locale } = useI18nContext();
  const [pickerGroupId, setPickerGroupId] = useState<string | null>(null);
  const modeLabels: Record<RoutingMode, string> = {
    direct: LL.status.modeDirect(),
    global: LL.status.modeGlobal(),
    rule: LL.status.modeRule(),
  };
  const capturePending = isCommandPending("capture");
  const groupPending = isCommandPending("group");
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
    return <div className="status-loading">{LL.status.loading()}</div>;
  }

  if (!snapshot) {
    return (
      <div className="status-loading" role="alert">
        {error ?? LL.status.fixtureUnavailable()}
      </div>
    );
  }

  const pickerGroup = snapshot.groups.find((group) => group.id === pickerGroupId) ?? null;
  const pickerNodes = pickerGroup
    ? snapshot.nodes.filter((node) => pickerGroup.childIds.includes(node.id))
    : [];
  const captureRuntime = snapshot.runtime;
  const captureActive = captureRuntime.systemProxyEnabled || captureRuntime.tunEnabled;

  function changeCaptureMode(mode: "systemProxy" | "tun", selected: boolean) {
    const selection = { ...captureRuntime.captureSelection, [mode]: selected };
    const active = captureActive ? selection.systemProxy || selection.tun : selected;
    void setCapture(selection, active);
  }

  function openPicker(group: PolicyGroupDto) {
    setPickerGroupId(group.id);
  }

  return (
    <div className="page-scroll">
      <div className="status-page">
        <h1 className="sr-only">{LL.navigation.status()}</h1>
        {error ? (
          <p className="fixture-error" role="alert">
            {error}
          </p>
        ) : null}
        {snapshot.adapterKind !== "fixture" && connection.stale ? (
          <p className="fixture-error" role="status">
            {connection.phase === "reconnecting" ? LL.status.reconnecting() : LL.status.staleData()}
          </p>
        ) : null}
        <div className="status-controls">
          <SectionGrid className="status-control-card">
            <SectionGridItem className="status-control-cell">
              <span className="status-control-label">{LL.status.routingMode()}</span>
              <ToggleGroup
                aria-label={LL.status.routingMode()}
                className="routing-mode-group"
                onValueChange={(values) => {
                  const nextMode = values[0] as RoutingMode | undefined;
                  if (nextMode) void setRoutingMode(nextMode);
                }}
                spacing={0}
                value={[snapshot.routingMode]}
                variant="outline"
              >
                {(Object.keys(modeLabels) as RoutingMode[]).map((mode) => (
                  <ToggleGroupItem
                    className="routing-mode-button"
                    disabled={routingPending}
                    key={mode}
                    value={mode}
                  >
                    {modeLabels[mode]}
                  </ToggleGroupItem>
                ))}
              </ToggleGroup>
            </SectionGridItem>
            <SectionGridItem className="status-control-cell">
              <span className="status-control-label">{LL.status.trafficCapture()}</span>
              <TrafficCaptureControl
                disabled={capturePending}
                onSystemProxyChange={(selected) => changeCaptureMode("systemProxy", selected)}
                onTunChange={(selected) => changeCaptureMode("tun", selected)}
                systemProxyEnabled={captureRuntime.systemProxyEnabled}
                systemProxySelected={captureRuntime.captureSelection.systemProxy}
                tunEnabled={captureRuntime.tunEnabled}
                tunSelected={captureRuntime.captureSelection.tun}
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
                <p>{LL.status.fixtureActivity()}</p>
              </div>
              <Link className="text-link" to="/traffic">
                {LL.status.openLiveTraffic()} <CaretRight aria-hidden="true" />
              </Link>
            </div>
            <SectionGrid className="session-list" columns={2}>
              <SectionGridItem className="session-row traffic-session-row" columnSpan={2}>
                <span className="traffic-session-label" data-direction="download">
                  <ArrowDown aria-hidden="true" />
                  <span className="traffic-session-copy">
                    <span>{LL.status.downloaded()}</span>
                    <small>{formatBytes(snapshot.traffic.downloadedBytes, locale)}</small>
                  </span>
                </span>
                <TrafficSparkline
                  color="var(--color-traffic-download)"
                  data={snapshot.traffic.downloadSeries}
                  id="download"
                />
                <strong className="traffic-rate-value tabular">
                  {formatRate(snapshot.traffic.downloadBytesPerSecond, locale)}
                </strong>
              </SectionGridItem>
              <SectionGridItem className="session-row traffic-session-row" columnSpan={2}>
                <span className="traffic-session-label" data-direction="upload">
                  <ArrowUp aria-hidden="true" />
                  <span className="traffic-session-copy">
                    <span>{LL.status.uploaded()}</span>
                    <small>{formatBytes(snapshot.traffic.uploadedBytes, locale)}</small>
                  </span>
                </span>
                <TrafficSparkline
                  color="var(--color-traffic-upload)"
                  data={snapshot.traffic.uploadSeries}
                  id="upload"
                />
                <strong className="traffic-rate-value tabular">
                  {formatRate(snapshot.traffic.uploadBytesPerSecond, locale)}
                </strong>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>{LL.status.connections()}</span>
                <strong className="tabular">{snapshot.metrics.activeConnections}</strong>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>{LL.status.activeRules()}</span>
                <strong className="tabular">
                  {new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en").format(
                    snapshot.metrics.effectiveRules,
                  )}
                </strong>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>{LL.status.memory()}</span>
                <strong className="tabular">
                  {formatBytes(snapshot.metrics.memoryBytes, locale)}
                </strong>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>{LL.status.uptime()}</span>
                <strong className="tabular">{formatUptime(snapshot.metrics.uptimeSeconds)}</strong>
              </SectionGridItem>
            </SectionGrid>
          </section>

          <section aria-label={LL.status.groupsAria()} className="flat-section">
            <div className="section-heading">
              <div className="section-heading-copy">
                <h2>{LL.status.groups()}</h2>
                <p>{LL.status.usedFirst()}</p>
              </div>
              <Link className="text-link" to="/routes">
                {LL.status.viewAll()} <CaretRight aria-hidden="true" />
              </Link>
            </div>
            <SectionGrid className="policy-group-list">
              {frequentGroups.map((group, index) => {
                const selectedNode = snapshot.nodes.find(
                  (node) => node.id === group.selectedChildId,
                );
                return (
                  <Button
                    className="section-grid-item policy-group-row"
                    disabled={groupPending}
                    key={group.id}
                    onClick={() => openPicker(group)}
                    type="button"
                    variant="ghost"
                  >
                    <span className="policy-group-leading">
                      <span className="policy-group-rank tabular">{index + 1}</span>
                      <span className="policy-group-copy">
                        <strong className="policy-group-primary user-authored-label">
                          {group.label}
                        </strong>
                        <span className="policy-group-secondary user-authored-label">
                          {selectedNode?.label ?? LL.status.noSelection()}
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
                      <CaretRight aria-hidden="true" />
                    </span>
                  </Button>
                );
              })}
            </SectionGrid>
          </section>
        </div>

        <ServiceMonitorSection />
      </div>

      <ProxyPickerDialog
        group={pickerGroup}
        nodes={pickerNodes}
        onOpenChange={(open) => !open && setPickerGroupId(null)}
        onSelect={(nodeId) => {
          if (pickerGroup) void selectGroupChild(pickerGroup.id, nodeId);
        }}
        open={pickerGroup !== null}
      />
    </div>
  );
}
