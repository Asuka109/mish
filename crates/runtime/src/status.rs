use serde::Serialize;

use crate::{CorePhase, CoreStatus};

pub const STATUS_TRAFFIC_SERIES_LIMIT: usize = 512;

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusAdapterKind {
    Native,
    Rpc,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RoutingMode {
    Rule,
    Global,
    Direct,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RuntimePhase {
    Inactive,
    Connecting,
    Healthy,
    Stopping,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityAvailability {
    FixtureOnly,
    Supported,
    Unavailable,
    PermissionRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeStatus {
    Pending,
    Healthy,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ServiceIcon {
    Apple,
    Baidu,
    Cloudflare,
    Github,
    Globe,
    Google,
    Microsoft,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSelection {
    pub system_proxy: bool,
    pub tun: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub capture_selection: CaptureSelection,
    pub message: String,
    pub phase: RuntimePhase,
    pub system_proxy_enabled: bool,
    pub tun_enabled: bool,
}

impl RuntimeStatus {
    pub fn from_core(core: &CoreStatus, capture_selection: CaptureSelection) -> Self {
        let (phase, fallback_message) = match core.phase {
            CorePhase::Stopped => (RuntimePhase::Inactive, "Mihomo is stopped"),
            CorePhase::Starting => (RuntimePhase::Connecting, "Mihomo is starting"),
            CorePhase::Running => (RuntimePhase::Healthy, "Mihomo is running"),
            CorePhase::Stopping => (RuntimePhase::Stopping, "Mihomo is stopping"),
            CorePhase::Failed => (RuntimePhase::Error, "Mihomo failed"),
        };
        Self {
            capture_selection,
            message: core
                .error
                .clone()
                .unwrap_or_else(|| fallback_message.to_owned()),
            phase,
            system_proxy_enabled: false,
            tun_enabled: false,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TrafficSnapshot {
    pub download_bytes_per_second: u64,
    pub download_series: Vec<u64>,
    pub downloaded_bytes: u64,
    pub upload_bytes_per_second: u64,
    pub upload_series: Vec<u64>,
    pub uploaded_bytes: u64,
}

#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeMetrics {
    pub active_connections: usize,
    pub effective_rules: usize,
    pub memory_bytes: u64,
    pub uptime_seconds: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ProfileSummary {
    pub id: String,
    pub label: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProxyNode {
    pub id: String,
    pub label: String,
    pub latency_milliseconds: Option<u16>,
    pub protocol: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyGroup {
    pub child_ids: Vec<String>,
    pub id: String,
    pub label: String,
    pub selected_child_id: String,
    #[serde(rename = "type")]
    pub kind: PolicyGroupKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum PolicyGroupKind {
    Selector,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupUsage {
    pub group_id: String,
    pub observed_connection_count: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct ServiceMonitor {
    pub icon: ServiceIcon,
    pub id: String,
    pub label: String,
    pub url: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceProbeResult {
    pub latency_milliseconds: Option<u64>,
    pub monitor_id: String,
    pub observed_at: String,
    pub route_target: String,
    pub status: ProbeStatus,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlatformCapabilities {
    pub system_proxy: CapabilityAvailability,
    pub tun: CapabilityAvailability,
}

impl PlatformCapabilities {
    pub const fn unavailable() -> Self {
        Self {
            system_proxy: CapabilityAvailability::Unavailable,
            tun: CapabilityAvailability::Unavailable,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StatusSnapshot {
    pub active_profile_id: String,
    pub adapter_kind: StatusAdapterKind,
    pub capabilities: PlatformCapabilities,
    pub groups: Vec<PolicyGroup>,
    pub group_usage: Vec<GroupUsage>,
    pub metrics: RuntimeMetrics,
    pub nodes: Vec<ProxyNode>,
    pub probe_results: Vec<ServiceProbeResult>,
    pub profiles: Vec<ProfileSummary>,
    pub routing_mode: RoutingMode,
    pub runtime: RuntimeStatus,
    pub services: Vec<ServiceMonitor>,
    pub traffic: TrafficSnapshot,
}

impl StatusSnapshot {
    pub fn lifecycle_only(core: &CoreStatus, adapter_kind: StatusAdapterKind) -> Self {
        Self {
            active_profile_id: "local".into(),
            adapter_kind,
            capabilities: PlatformCapabilities::unavailable(),
            groups: Vec::new(),
            group_usage: Vec::new(),
            metrics: RuntimeMetrics::default(),
            nodes: Vec::new(),
            probe_results: Vec::new(),
            profiles: vec![ProfileSummary {
                id: "local".into(),
                label: "Local Mihomo".into(),
            }],
            routing_mode: RoutingMode::Rule,
            runtime: RuntimeStatus::from_core(
                core,
                CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            ),
            services: default_services(),
            traffic: TrafficSnapshot::default(),
        }
    }
}

fn default_services() -> Vec<ServiceMonitor> {
    [
        (
            ServiceIcon::Google,
            "google",
            "Google",
            "https://www.google.com/generate_204",
        ),
        (
            ServiceIcon::Github,
            "github",
            "GitHub",
            "https://github.com",
        ),
        (
            ServiceIcon::Cloudflare,
            "cloudflare",
            "Cloudflare",
            "https://cp.cloudflare.com/generate_204",
        ),
        (
            ServiceIcon::Baidu,
            "baidu",
            "Baidu",
            "https://www.baidu.com",
        ),
        (
            ServiceIcon::Apple,
            "apple",
            "Apple",
            "https://www.apple.com/library/test/success.html",
        ),
        (
            ServiceIcon::Microsoft,
            "microsoft",
            "Microsoft",
            "https://www.msftconnecttest.com/connecttest.txt",
        ),
    ]
    .into_iter()
    .map(|(icon, id, label, url)| ServiceMonitor {
        icon,
        id: id.into(),
        label: label.into(),
        url: url.into(),
    })
    .collect()
}
