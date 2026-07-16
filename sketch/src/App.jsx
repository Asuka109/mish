import { useEffect, useMemo, useState } from "react";
import { Button } from "@base-ui/react/button";
import { Popover } from "@base-ui/react/popover";
import { Switch } from "@base-ui/react/switch";
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
  Globe,
  ListBullets,
  MagnifyingGlass,
  PlugsConnected,
  Pulse,
  SlidersHorizontal,
  Stack,
  X,
} from "@phosphor-icons/react";
import { StatusShimmer } from "./components/status-shimmer";
import { TrafficSparkline } from "./components/traffic-sparkline";
import { ButtonGroup } from "./components/ui/button-group";

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

const proxies = [
  { id: "hkg-02", name: "HKG-02", location: "Hong Kong", protocol: "Hysteria2", latency: 38 },
  { id: "hkg-01", name: "HKG-01", location: "Hong Kong", protocol: "Hysteria2", latency: 52 },
  { id: "nrt-03", name: "NRT-03", location: "Tokyo", protocol: "VLESS", latency: 71 },
  { id: "sin-01", name: "SIN-01", location: "Singapore", protocol: "Trojan", latency: 83 },
];

const sidebarRates = [
  { direction: "download", symbol: "↓", value: "2.45 MB/s" },
  { direction: "upload", symbol: "↑", value: "1.18 MB/s" },
];

const trafficSeries = {
  download: [18, 22, 19, 27, 25, 34, 31, 39, 33, 36, 42, 38, 44, 40, 47, 43],
  upload: [12, 15, 14, 18, 17, 21, 19, 24, 22, 27, 25, 29, 26, 31, 28, 33],
};

const policyGroups = [
  { connectionCount: 12842, id: "proxy", name: "Proxy", selectedProxyId: "hkg-02" },
  { connectionCount: 4906, id: "streaming", name: "Streaming", selectedProxyId: "sin-01" },
  { connectionCount: 2741, id: "ai-services", name: "AI services", selectedProxyId: "nrt-03" },
  { connectionCount: 986, id: "messaging", name: "Messaging", selectedProxyId: "hkg-01" },
];

const compactNumberFormatter = new Intl.NumberFormat("en", {
  compactDisplay: "short",
  maximumFractionDigits: 1,
  notation: "compact",
});

const placeholderCopy = {
  profiles: "Import, update, and organize local and remote profiles.",
  connections: "Inspect active connections and close individual sessions.",
  logs: "Follow core and application events without leaving the client.",
  settings: "Configure startup, system proxy, TUN, DNS, and appearance.",
};

function Sidebar({ connected, onToggle, proxy }) {
  const connectionStatus = connected ? "healthy" : "inactive";
  const [rateIndex, setRateIndex] = useState(0);
  const rate = sidebarRates[rateIndex];

  useEffect(() => {
    if (!connected) return undefined;

    const interval = window.setInterval(() => {
      setRateIndex((current) => (current + 1) % sidebarRates.length);
    }, 3200);

    return () => window.clearInterval(interval);
  }, [connected]);

  return (
    <aside className="sidebar" aria-label="Primary navigation">
      <div className="traffic-lights" aria-hidden="true">
        <Circle size={12} weight="fill" color="#ff5f57" />
        <Circle size={12} weight="fill" color="#febc2e" />
        <Circle size={12} weight="fill" color="#28c840" />
      </div>

      <div className="brand-row" aria-label="Mihomo">
        <Stack size={18} weight="regular" />
        <span>Mihomo</span>
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
        <Button
          aria-label={connected ? "Disable system proxy" : "Enable system proxy"}
          className="sidebar-status"
          data-status={connectionStatus}
          onClick={() => onToggle(!connected)}
          type="button"
        >
          <StatusShimmer active={connected} />
          <span className="sidebar-status-node">{proxy.name}</span>
          {connected ? (
            <span className="sidebar-status-rate" data-direction={rate.direction} key={rate.direction}>
              <span aria-hidden="true">{rate.symbol}</span>
              {rate.value}
            </span>
          ) : null}
        </Button>
      </div>
    </aside>
  );
}

function DiagnosticsPopover() {
  return (
    <Popover.Root>
      <Popover.Trigger className="toolbar-button">
        <Pulse size={17} />
        <span>Diagnostics</span>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner sideOffset={8} align="end">
          <Popover.Popup className="diagnostics-popover">
            <div className="popover-header">
              <Popover.Title>Diagnostics</Popover.Title>
              <Popover.Close className="icon-button" aria-label="Close diagnostics">
                <X size={16} />
              </Popover.Close>
            </div>
            <Popover.Description className="popover-description">
              Core services are responding normally.
            </Popover.Description>
            <div className="diagnostic-item"><Globe size={17} /><span>DNS resolution</span><em>Healthy</em></div>
            <div className="diagnostic-item"><Pulse size={17} /><span>Mihomo core</span><em>Running</em></div>
            <div className="diagnostic-item"><PlugsConnected size={17} /><span>System proxy</span><em>Enabled</em></div>
            <button className="secondary-button popover-action" type="button">Run diagnostics</button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

function Toolbar({ activeProxy, onSelectProxy, title }) {
  return (
    <header className="toolbar">
      <span className="toolbar-title">{title}</span>
      <div className="toolbar-actions">
        <button className="toolbar-button" onClick={onSelectProxy} type="button">
          <CirclesFour size={17} />
          <span>{activeProxy.name}</span>
          <CaretDown size={12} weight="bold" />
        </button>
        <span className="toolbar-divider" />
        <DiagnosticsPopover />
      </div>
    </header>
  );
}

function ModeControl({ mode, onChange }) {
  return (
    <ButtonGroup aria-label="Routing mode" className="routing-mode-group">
      {['Rule', 'Global', 'Direct'].map((item) => (
        <Button
          aria-pressed={mode === item}
          className="routing-mode-button"
          key={item}
          onClick={() => onChange(item)}
          type="button"
        >
          {item}
        </Button>
      ))}
    </ButtonGroup>
  );
}

function ConnectionSwitch({ connected, onToggle }) {
  return (
    <Switch.Root
      checked={connected}
      className="switch"
      nativeButton
      onCheckedChange={onToggle}
      render={<button aria-label={connected ? "Disconnect" : "Connect"} type="button" />}
    >
      <Switch.Thumb className="switch-thumb" />
    </Switch.Root>
  );
}

function Overview({ connected, mode, proxy, onModeChange, onOpenProxies, onOpenTraffic, onToggle }) {
  const frequentGroups = [...policyGroups]
    .sort((first, second) => second.connectionCount - first.connectionCount)
    .slice(0, 3);

  return (
    <Tabs.Panel className="page-scroll" value="overview">
      <div className="status-page">
        <div className="page-heading">
          <div>
            <h1>Network status</h1>
            <p>Connection, route, and live session details.</p>
          </div>
          <span className="health-summary"><span className="status-dot" data-active /> All systems normal</span>
        </div>

        <section className="connection-card" aria-label="Current network status">
          <div className="connection-header">
            <div className="connection-state">
              <span className="status-dot connection-dot" data-active={connected} />
              <div>
                <strong>{connected ? "Connected" : "Connection paused"}</strong>
                <span>{connected ? `Traffic is routed through ${proxy.location} · ${proxy.name}` : "Traffic is not using the system proxy"}</span>
              </div>
            </div>
            <ConnectionSwitch connected={connected} onToggle={onToggle} />
          </div>

          <div className="connection-details">
            <button className="detail-block detail-action" onClick={onOpenProxies} type="button">
              <span>Route</span>
              <strong>{proxy.location} · {proxy.name}</strong>
              <CaretRight size={14} />
            </button>
            <div className="detail-block">
              <span>Profile</span>
              <strong>Home</strong>
            </div>
            <div className="detail-block mode-block">
              <span>Mode</span>
              <ModeControl mode={mode} onChange={onModeChange} />
            </div>
            <div className="detail-block throughput-block">
              <span>Current traffic</span>
              <strong className="tabular">↓ 2.45&nbsp;&nbsp;↑ 1.18 MB/s</strong>
            </div>
          </div>
        </section>

        <div className="content-grid">
          <section className="flat-section" aria-label="Most used policy groups">
            <div className="section-heading">
              <div>
                <h2>Most used groups</h2>
                <p>Ranked by cumulative connections.</p>
              </div>
              <button className="text-button" onClick={onOpenProxies} type="button">View all <CaretRight size={13} /></button>
            </div>

            <div className="policy-group-list">
              {frequentGroups.map((group, index) => {
                const selectedProxy = group.id === "proxy"
                  ? proxy
                  : proxies.find((candidate) => candidate.id === group.selectedProxyId) ?? proxies[0];

                return (
                  <Button className="policy-group-row" key={group.id} onClick={onOpenProxies} type="button">
                    <span className="policy-group-rank tabular">{index + 1}</span>
                    <span className="policy-group-copy">
                      <strong>{group.name}</strong>
                      <span>{selectedProxy.name} · {selectedProxy.location}</span>
                    </span>
                    <span
                      aria-label={`${group.connectionCount.toLocaleString()} cumulative connections`}
                      className="policy-group-count tabular"
                      title={`${group.connectionCount.toLocaleString()} cumulative connections`}
                    >
                      {compactNumberFormatter.format(group.connectionCount)}
                    </span>
                    <CaretRight aria-hidden="true" size={13} />
                  </Button>
                );
              })}
            </div>
          </section>

          <section className="flat-section" aria-label="Current session">
            <div className="section-heading">
              <div>
                <h2>Session</h2>
                <p>Live activity at a glance.</p>
              </div>
            </div>
            <div className="session-list">
              <div className="session-row traffic-session-row">
                <span className="traffic-session-label"><ArrowDown size={14} /> Download</span>
                <TrafficSparkline color="var(--traffic-download)" data={trafficSeries.download} id="download" />
                <strong className="tabular">2.45 MB/s</strong>
              </div>
              <div className="session-row traffic-session-row">
                <span className="traffic-session-label"><ArrowUp size={14} /> Upload</span>
                <TrafficSparkline color="var(--traffic-upload)" data={trafficSeries.upload} id="upload" />
                <strong className="tabular">1.18 MB/s</strong>
              </div>
              <div className="session-row"><span>Connections</span><strong className="tabular">24</strong></div>
              <div className="session-row"><span>Uptime</span><strong className="tabular">01:24:07</strong></div>
            </div>
            <button className="text-button section-link" onClick={onOpenTraffic} type="button">Open live traffic <CaretRight size={13} /></button>
          </section>
        </div>
      </div>
    </Tabs.Panel>
  );
}

function ProxyWorkspace({ activeProxyId, onSelect, onUse }) {
  const [query, setQuery] = useState("");
  const visibleProxies = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    if (!normalizedQuery) return proxies;
    return proxies.filter((proxy) => `${proxy.name} ${proxy.location} ${proxy.protocol}`.toLowerCase().includes(normalizedQuery));
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
                <span className="proxy-copy"><strong>{proxy.name}</strong><span>{proxy.location} · {proxy.protocol}</span></span>
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
        <h1>{proxy.name}</h1>
        <Tooltip.Root>
          <Tooltip.Trigger className="icon-button" aria-label="Route settings"><SlidersHorizontal size={17} /></Tooltip.Trigger>
          <Tooltip.Portal><Tooltip.Positioner sideOffset={6}><Tooltip.Popup className="tooltip">Route settings</Tooltip.Popup></Tooltip.Positioner></Tooltip.Portal>
        </Tooltip.Root>
      </div>
      <p className="inspector-subtitle">{proxy.location}</p>
      <div className="inspector-rows">
        <div className="data-row"><span>Status</span><span className="status-pair"><span className="status-dot" data-active /> Available</span></div>
        <div className="data-row"><span>Latency</span><span className="latency tabular">{proxy.latency} ms</span></div>
        <div className="data-row"><span>Protocol</span><span>{proxy.protocol}</span></div>
        <div className="data-row"><span>Provider</span><span>Home</span></div>
        <div className="data-row"><span>Last tested</span><span>Just now</span></div>
      </div>
      <button className="primary-button" onClick={onUse} type="button">Use this route</button>
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
  const [connected, setConnected] = useState(true);
  const [mode, setMode] = useState("Rule");
  const [activeProxyId, setActiveProxyId] = useState("hkg-02");
  const activeProxy = proxies.find((proxy) => proxy.id === activeProxyId) ?? proxies[0];

  return (
    <Tooltip.Provider delay={500}>
      <Tabs.Root className="app-shell" onValueChange={setActiveView} orientation="vertical" value={activeView}>
        <Sidebar connected={connected} onToggle={setConnected} proxy={activeProxy} />
        <section className="workspace">
          <Toolbar activeProxy={activeProxy} onSelectProxy={() => setActiveView("proxies")} title={viewTitles[activeView]} />
          <Overview
            connected={connected}
            mode={mode}
            onModeChange={setMode}
            onOpenProxies={() => setActiveView("proxies")}
            onOpenTraffic={() => setActiveView("connections")}
            onToggle={setConnected}
            proxy={activeProxy}
          />
          <ProxyWorkspace activeProxyId={activeProxyId} onSelect={setActiveProxyId} onUse={() => setActiveView("overview")} />
          {['profiles', 'connections', 'logs', 'settings'].map((view) => <PlaceholderView key={view} view={view} />)}
        </section>
      </Tabs.Root>
    </Tooltip.Provider>
  );
}
