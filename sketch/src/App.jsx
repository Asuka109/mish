import { useMemo, useState } from "react";
import { Button as BaseButton } from "@base-ui/react/button";
import { Tabs } from "@base-ui/react/tabs";
import { Tooltip } from "@base-ui/react/tooltip";
import {
  ArrowDown,
  ArrowUp,
  CaretDown,
  CaretRight,
  Check,
  Circle,
  CirclesFour,
  FileText,
  Gauge,
  GearSix,
  ListBullets,
  MagnifyingGlass,
  PlugsConnected,
  Power,
  SlidersHorizontal,
  Stack,
  WifiHigh,
  XCircle,
} from "@phosphor-icons/react";
import { StatusShimmer } from "./components/status-shimmer";
import { TrafficSparkline } from "./components/traffic-sparkline";
import { ProxyPickerDialog } from "./components/proxy-picker-dialog";
import { ServiceMonitorSection } from "./components/service-monitor-section";
import { TrafficCaptureControl } from "./components/traffic-capture-control";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SectionGrid, SectionGridItem } from "./components/ui/section-grid";
import { Toaster } from "@/components/ui/sonner";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";

const navigation = [
  { id: "overview", label: "Status", icon: Gauge },
  { id: "proxies", label: "Routes", icon: CirclesFour },
  { id: "profiles", label: "Profiles", icon: FileText },
  { id: "connections", label: "Traffic", icon: PlugsConnected },
  { id: "logs", label: "Events", icon: ListBullets },
];

const viewTitles = {
  overview: "Status",
  proxies: "Routes",
  profiles: "Profiles",
  connections: "Traffic",
  logs: "Events",
  settings: "Settings",
};

const profiles = [
  { id: "home", name: "Home" },
  { id: "work", name: "Work" },
  { id: "travel", name: "Travel" },
];

const proxies = [
  { emoji: "🇭🇰", id: "hkg-02", name: "HKG-02", protocol: "Hysteria2", latency: 38 },
  { emoji: "🇭🇰", id: "hkg-01", name: "HKG-01", protocol: "Hysteria2", latency: 52 },
  { emoji: "🇯🇵", id: "nrt-03", name: "NRT-03", protocol: "VLESS", latency: 71 },
  { emoji: "🇸🇬", id: "sin-01", name: "SIN-01", protocol: "Trojan", latency: 83 },
];

const trafficSeries = {
  download: [18, 22, 19, 27, 25, 34, 31, 39, 33, 36, 42, 38, 44, 40, 47, 43],
  upload: [12, 15, 14, 18, 17, 21, 19, 24, 22, 27, 25, 29, 26, 31, 28, 33],
};

const coreSnapshot = {
  connections: 24,
  memory: {
    inuse: 90_177_536,
  },
  traffic: {
    down: 2_568_192,
    downTotal: 13_781_123_072,
    up: 1_237_074,
    upTotal: 4_144_644_096,
  },
  rules: 12_846,
  uptime: "01:24:07",
};

const policyGroups = [
  { connectionCount: 12842, emoji: "🌐", id: "proxy", name: "Proxy", proxyIds: ["hkg-02", "hkg-01", "nrt-03", "sin-01"], selectedProxyId: "hkg-02" },
  { connectionCount: 4906, emoji: "🎬", id: "streaming", name: "Streaming", proxyIds: ["sin-01", "hkg-02", "nrt-03"], selectedProxyId: "sin-01" },
  { connectionCount: 2741, emoji: "🤖", id: "ai-services", name: "AI services", proxyIds: ["nrt-03", "hkg-02"], selectedProxyId: "nrt-03" },
  { connectionCount: 986, emoji: "💬", id: "messaging", name: "Messaging", proxyIds: ["hkg-01", "sin-01"], selectedProxyId: "hkg-01" },
  { connectionCount: 742, emoji: "🛠️", id: "development", name: "Development", proxyIds: ["hkg-02", "nrt-03", "sin-01"], selectedProxyId: "hkg-02" },
];

const initialGroupSelections = Object.fromEntries(
  policyGroups.map((group) => [group.id, group.selectedProxyId]),
);

const placeholderCopy = {
  profiles: "Import, update, and organize local and remote profiles.",
  connections: "Inspect active connections and close individual sessions.",
  logs: "Follow core and application events without leaving the client.",
  settings: "Configure startup, system proxy, TUN, DNS, and appearance.",
};

function formatBytes(value) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unitIndex = 0;

  while (amount >= 1024 && unitIndex < units.length - 1) {
    amount /= 1024;
    unitIndex += 1;
  }

  const maximumFractionDigits = amount < 10 ? 2 : 1;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits }).format(amount)} ${units[unitIndex]}`;
}

function formatRate(value) {
  return `${formatBytes(value)}/s`;
}

function formatCount(value) {
  return new Intl.NumberFormat().format(value);
}

function ProxyControlButton({ connected, onToggle, proxy }) {
  const connectionStatus = connected ? "healthy" : "inactive";

  return (
    <Button
      aria-label={connected ? "关闭代理" : "启动代理"}
      className="proxy-control-button"
      data-status={connectionStatus}
      onClick={() => onToggle(!connected)}
      style={connected ? { backgroundColor: "var(--status-water-base, #2f82dc)" } : undefined}
      type="button"
    >
      {connected ? <StatusShimmer active /> : null}
      {connected ? (
        <>
          <span className="proxy-control-state proxy-control-default">
            <WifiHigh aria-hidden="true" data-icon="inline-start" size={16} weight="bold" />
            <span className="proxy-control-label user-authored-label user-authored-label-node">
              <span className="proxy-control-flag" aria-hidden="true">{proxy.emoji}</span>
              <span>{proxy.name}</span>
            </span>
          </span>
          <span className="proxy-control-state proxy-control-hover" aria-hidden="true">
            <XCircle data-icon="inline-start" size={17} weight="regular" />
            <span className="proxy-control-label">关闭代理</span>
          </span>
        </>
      ) : (
        <span className="proxy-control-state proxy-control-default">
          <Power aria-hidden="true" data-icon="inline-start" size={17} weight="regular" />
          <span className="proxy-control-label">启动代理</span>
        </span>
      )}
    </Button>
  );
}

function Sidebar({ connected, onToggle, proxy }) {
  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="traffic-lights" aria-hidden="true">
        <Circle size={12} weight="fill" color="#ff5f57" />
        <Circle size={12} weight="fill" color="#febc2e" />
        <Circle size={12} weight="fill" color="#28c840" />
      </div>

      <div className="brand-row" aria-label="Mish">
        <Stack size={18} weight="regular" />
        <span>Mish</span>
      </div>

      <Tabs.List className="nav-list" aria-label="Workspace sections">
        {navigation.map(({ id, label, icon: Icon }) => (
          <Tabs.Tab className="nav-item" key={id} value={id}>
            <Icon size={17} weight="regular" />
            <span>{label}</span>
          </Tabs.Tab>
        ))}
        <Tabs.Tab className="nav-item settings-link" value="settings">
          <GearSix size={17} weight="regular" />
          <span>Settings</span>
        </Tabs.Tab>
      </Tabs.List>

      <div className="sidebar-status-area">
        <ProxyControlButton connected={connected} onToggle={onToggle} proxy={proxy} />
      </div>
    </aside>
  );
}

function ProfileMenu({ activeProfileId, onProfileChange }) {
  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0];

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        aria-label={`Switch profile. Current profile: ${activeProfile.name}`}
        className="toolbar-button profile-menu-trigger"
      >
        <FileText aria-hidden="true" size={15} />
        <span className="user-authored-label">{activeProfile.name}</span>
        <CaretDown aria-hidden="true" size={12} weight="bold" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="profile-menu" sideOffset={8}>
        <DropdownMenuRadioGroup onValueChange={onProfileChange} value={activeProfile.id}>
          <DropdownMenuLabel className="profile-menu-label">Profiles</DropdownMenuLabel>
          {profiles.map((profile) => (
            <DropdownMenuRadioItem className="profile-menu-item" key={profile.id} value={profile.id}>
              <span className="user-authored-label">{profile.name}</span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function Toolbar({ activeProfileId, onProfileChange, title }) {
  return (
    <header className="toolbar">
      <span className="toolbar-title">{title}</span>
      <div className="toolbar-actions">
        <ProfileMenu activeProfileId={activeProfileId} onProfileChange={onProfileChange} />
      </div>
    </header>
  );
}

function ModeControl({ mode, onChange }) {
  return (
    <ToggleGroup
      aria-label="Routing mode"
      className="routing-mode-group"
      onValueChange={(nextValue) => {
        const selectedMode = nextValue[0];
        if (selectedMode) onChange(selectedMode);
      }}
      spacing={0}
      value={[mode]}
      variant="outline"
    >
      {["Rule", "Global", "Direct"].map((item) => (
        <ToggleGroupItem
          className="routing-mode-button"
          key={item}
          value={item}
        >
          {item}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}

function Overview({
  groupSelections,
  mode,
  onModeChange,
  onOpenProxies,
  onOpenTraffic,
  onSelectGroupProxy,
  onSystemProxyChange,
  onTunChange,
  systemProxyEnabled,
  tunEnabled,
}) {
  const [pickerGroupId, setPickerGroupId] = useState(null);
  const frequentGroups = [...policyGroups]
    .sort((first, second) => second.connectionCount - first.connectionCount)
    .slice(0, 5);
  const pickerGroup = policyGroups.find((group) => group.id === pickerGroupId) ?? null;
  const pickerOptions = pickerGroup
    ? proxies.filter((candidate) => pickerGroup.proxyIds.includes(candidate.id))
    : [];

  return (
    <Tabs.Panel className="page-scroll" value="overview">
      <div className="status-page">
        <h1 className="sr-only">Status</h1>
        <div className="status-controls">
          <SectionGrid className="status-control-card">
            <SectionGridItem className="status-control-cell">
              <span className="status-control-label">Routing mode</span>
              <ModeControl mode={mode} onChange={onModeChange} />
            </SectionGridItem>
            <SectionGridItem className="status-control-cell status-capture-cell">
              <span className="status-control-label">Traffic capture</span>
              <TrafficCaptureControl
                onSystemProxyChange={onSystemProxyChange}
                onTunChange={onTunChange}
                systemProxyEnabled={systemProxyEnabled}
                tunEnabled={tunEnabled}
              />
            </SectionGridItem>
          </SectionGrid>
        </div>

        <div className="content-grid">
          <section className="flat-section session-section" aria-label="Current session">
            <div className="section-heading">
              <div className="section-heading-copy">
                <h2>Session</h2>
                <p>Live activity at a glance.</p>
              </div>
              <Button className="text-button" onClick={onOpenTraffic} size="sm" type="button" variant="ghost">
                Open live traffic <CaretRight data-icon="inline-end" size={13} />
              </Button>
            </div>
            <SectionGrid className="session-list" columns={2}>
              <SectionGridItem className="session-row traffic-session-row" columnSpan={2}>
                <span className="traffic-session-label" data-direction="download">
                  <ArrowDown aria-hidden="true" size={14} />
                  <span className="traffic-session-copy">
                    <span>Downloaded</span>
                    <small>{formatBytes(coreSnapshot.traffic.downTotal)}</small>
                  </span>
                </span>
                <TrafficSparkline color="var(--color-traffic-download)" data={trafficSeries.download} id="download" />
                <strong className="traffic-rate-value tabular">{formatRate(coreSnapshot.traffic.down)}</strong>
              </SectionGridItem>
              <SectionGridItem className="session-row traffic-session-row" columnSpan={2}>
                <span className="traffic-session-label" data-direction="upload">
                  <ArrowUp aria-hidden="true" size={14} />
                  <span className="traffic-session-copy">
                    <span>Uploaded</span>
                    <small>{formatBytes(coreSnapshot.traffic.upTotal)}</small>
                  </span>
                </span>
                <TrafficSparkline color="var(--color-traffic-upload)" data={trafficSeries.upload} id="upload" />
                <strong className="traffic-rate-value tabular">{formatRate(coreSnapshot.traffic.up)}</strong>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>Connections</span>
                <strong className="tabular">{coreSnapshot.connections}</strong>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>Active rules</span>
                <strong className="tabular">{formatCount(coreSnapshot.rules)}</strong>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>Memory</span>
                <strong className="tabular">{formatBytes(coreSnapshot.memory.inuse)}</strong>
              </SectionGridItem>
              <SectionGridItem className="session-metric">
                <span>Uptime</span>
                <strong className="tabular">{coreSnapshot.uptime}</strong>
              </SectionGridItem>
            </SectionGrid>
          </section>

          <section className="flat-section" aria-label="Frequently used policy groups">
            <div className="section-heading">
              <div className="section-heading-copy">
                <h2>Groups</h2>
                <p>Most used first.</p>
              </div>
              <Button className="text-button" onClick={onOpenProxies} size="sm" type="button" variant="ghost">
                View all <CaretRight data-icon="inline-end" size={13} />
              </Button>
            </div>

            <SectionGrid className="policy-group-list">
              {frequentGroups.map((group, index) => {
                const selectedProxyId = groupSelections[group.id] ?? group.selectedProxyId;
                const selectedProxy = proxies.find((candidate) => candidate.id === selectedProxyId) ?? proxies[0];

                return (
                  <SectionGridItem
                    as={Button}
                    className="policy-group-row"
                    key={group.id}
                    onClick={() => setPickerGroupId(group.id)}
                    type="button"
                    variant="ghost"
                  >
                    <span className="policy-group-rank tabular">{index + 1}</span>
                    <span className="policy-group-copy">
                      <span className="policy-group-primary user-authored-label">
                        <span className="policy-group-emoji" aria-hidden="true">{group.emoji}</span>
                        <strong>{group.name}</strong>
                      </span>
                      <span className="policy-group-secondary user-authored-label user-authored-label-node">
                        <span className="node-flag" aria-hidden="true">{selectedProxy.emoji}</span>
                        <span>{selectedProxy.name} · {selectedProxy.latency} ms</span>
                      </span>
                    </span>
                    <Badge
                      aria-label={`${group.proxyIds.length} available nodes`}
                      className="policy-group-badge tabular"
                      variant="outline"
                    >
                      {group.proxyIds.length}
                    </Badge>
                    <CaretRight aria-hidden="true" data-icon="inline-end" size={13} />
                  </SectionGridItem>
                );
              })}
            </SectionGrid>
          </section>
        </div>

        <ServiceMonitorSection />
      </div>
      <ProxyPickerDialog
        groupName={pickerGroup?.name}
        onOpenChange={(open) => {
          if (!open) setPickerGroupId(null);
        }}
        onSelect={(proxyId) => {
          if (!pickerGroup) return;
          onSelectGroupProxy(pickerGroup.id, proxyId);
        }}
        open={pickerGroup !== null}
        options={pickerOptions}
        selectedProxyId={pickerGroup ? groupSelections[pickerGroup.id] : undefined}
      />
    </Tabs.Panel>
  );
}

function ProxyWorkspace({ activeProxyId, onSelect, onUse }) {
  const [query, setQuery] = useState("");
  const visibleProxies = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return proxies;
    return proxies.filter((proxy) => `${proxy.name} ${proxy.protocol}`.toLowerCase().includes(normalizedQuery));
  }, [query]);

  return (
    <Tabs.Panel className="proxy-workspace" value="proxies">
      <div className="proxy-list-pane">
        <label className="search-field">
          <MagnifyingGlass size={16} />
          <input aria-label="Search proxies" onChange={(event) => setQuery(event.target.value)} placeholder="Search routes" value={query} />
          <kbd>⌘K</kbd>
        </label>
        <div className="list-heading">
          <span>Available routes</span>
          <Tooltip.Root>
          <Tooltip.Trigger className="icon-button" aria-label="Test latency"><Gauge size={17} /></Tooltip.Trigger>
            <Tooltip.Portal>
              <Tooltip.Positioner sideOffset={6}><Tooltip.Popup className="tooltip">Test latency</Tooltip.Popup></Tooltip.Positioner>
            </Tooltip.Portal>
          </Tooltip.Root>
        </div>
        <div className="proxy-list">
          {visibleProxies.map((proxy) => {
            const selected = proxy.id === activeProxyId;
            return (
              <button className="proxy-row" data-selected={selected} key={proxy.id} onClick={() => onSelect(proxy.id)} type="button">
                <span className="proxy-check">{selected && <Check size={14} weight="bold" />}</span>
                <span className="proxy-copy">
                  <strong className="user-authored-label user-authored-label-node"><span className="node-flag" aria-hidden="true">{proxy.emoji}</span>{proxy.name}</strong>
                  <span>{proxy.protocol} · {proxy.latency} ms</span>
                </span>
                <span className="latency tabular">{proxy.latency} ms</span>
              </button>
            );
          })}
        </div>
      </div>
      <ProxyInspector onUse={onUse} proxy={proxies.find((proxy) => proxy.id === activeProxyId) ?? proxies[0]} />
    </Tabs.Panel>
  );
}

function ProxyInspector({ onUse, proxy }) {
  return (
    <aside className="inspector">
      <div className="inspector-title-row">
        <h1 className="user-authored-label user-authored-label-node"><span className="inspector-node-flag" aria-hidden="true">{proxy.emoji}</span>{proxy.name}</h1>
        <Tooltip.Root>
          <Tooltip.Trigger className="icon-button" aria-label="Route settings"><SlidersHorizontal size={17} /></Tooltip.Trigger>
          <Tooltip.Portal><Tooltip.Positioner sideOffset={6}><Tooltip.Popup className="tooltip">Route settings</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal>
        </Tooltip.Root>
      </div>
      <p className="inspector-subtitle">{proxy.protocol}</p>
      <div className="inspector-rows">
        <div className="data-row"><span>Status</span><span className="status-pair"><span className="status-dot" data-active /> Available</span></div>
        <div className="data-row"><span>Latency</span><span className="latency tabular">{proxy.latency} ms</span></div>
        <div className="data-row"><span>Protocol</span><span>{proxy.protocol}</span></div>
        <div className="data-row"><span>Provider</span><span>Home</span></div>
        <div className="data-row"><span>Last tested</span><span>Just now</span></div>
      </div>
      <BaseButton className="primary-button" onClick={onUse} type="button">Use this route</BaseButton>
      <h2>Diagnostics</h2>
      <div className="inspector-rows diagnostics-rows">
        <div className="data-row"><span>Outbound IP</span><span className="tabular">203.0.113.45</span></div>
        <div className="data-row"><span>Core version</span><span>v1.18.0</span></div>
        <button className="data-row interactive-row" type="button"><span>Test connection</span><CaretRight size={14} /></button>
      </div>
    </aside>
  );
}

function PlaceholderView({ view }) {
  const title = viewTitles[view] ?? view;
  return (
    <Tabs.Panel className="placeholder-view" value={view}>
      <div className="placeholder-icon">
        {view === "profiles" ? <FileText size={21} /> : null}
        {view === "connections" ? <PlugsConnected size={21} /> : null}
        {view === "logs" ? <ListBullets size={21} /> : null}
        {view === "settings" ? <GearSix size={21} /> : null}
      </div>
      <h1>{title}</h1>
      <p>{placeholderCopy[view]}</p>
    </Tabs.Panel>
  );
}

export function App() {
  const [activeView, setActiveView] = useState("overview");
  const [mode, setMode] = useState("Rule");
  const [activeProfileId, setActiveProfileId] = useState("home");
  const [activeProxyId, setActiveProxyId] = useState("hkg-02");
  const [groupSelections, setGroupSelections] = useState(initialGroupSelections);
  const [systemProxyEnabled, setSystemProxyEnabled] = useState(true);
  const [tunEnabled, setTunEnabled] = useState(false);
  const activeProxy = proxies.find((proxy) => proxy.id === activeProxyId) ?? proxies[0];
  const connected = systemProxyEnabled || tunEnabled;

  const handleSelectGroupProxy = (groupId, proxyId) => {
    setGroupSelections((current) => ({ ...current, [groupId]: proxyId }));
    if (groupId === "proxy") setActiveProxyId(proxyId);
  };

  const handleToggleProxy = (nextConnected) => {
    if (nextConnected) {
      setSystemProxyEnabled(true);
      return;
    }

    setSystemProxyEnabled(false);
    setTunEnabled(false);
  };

  return (
    <Tooltip.Provider delay={500}>
      <Tabs.Root className="app-shell" onValueChange={setActiveView} orientation="vertical" value={activeView}>
        <Sidebar connected={connected} onToggle={handleToggleProxy} proxy={activeProxy} />
        <section className="workspace">
          <Toolbar
            activeProfileId={activeProfileId}
            onProfileChange={setActiveProfileId}
            title={viewTitles[activeView]}
          />
          <Overview
            groupSelections={groupSelections}
            mode={mode}
            onModeChange={setMode}
            onOpenProxies={() => setActiveView("proxies")}
            onOpenTraffic={() => setActiveView("connections")}
            onSelectGroupProxy={handleSelectGroupProxy}
            onSystemProxyChange={setSystemProxyEnabled}
            onTunChange={setTunEnabled}
            systemProxyEnabled={systemProxyEnabled}
            tunEnabled={tunEnabled}
          />
          <ProxyWorkspace activeProxyId={activeProxyId} onSelect={setActiveProxyId} onUse={() => setActiveView("overview")} />
          {["profiles", "connections", "logs", "settings"].map((view) => <PlaceholderView key={view} view={view} />)}
        </section>
      </Tabs.Root>
      <Toaster position="bottom-right" />
    </Tooltip.Provider>
  );
}
