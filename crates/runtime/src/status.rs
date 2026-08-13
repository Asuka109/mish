use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use serde::{Deserialize, Serialize};

use crate::{
    ApplicationSnapshotOrder, CaptureOperationStatus, CaptureRuntimeStatus, CorePhase, CoreStatus,
    RecentTrafficSnapshot, SystemProxyRuntimeStatus, TunRuntimeStatus,
};

pub const STATUS_TRAFFIC_SERIES_LIMIT: usize = 512;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum StatusAdapterKind {
    Native,
    Rpc,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
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
    RecoveryRequired,
    RepairRequired,
    Supported,
    Unavailable,
    PermissionRequired,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GroupSelectionAvailability {
    Available,
    CoreNotRunning,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ProbeStatus {
    Pending,
    Healthy,
    Error,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GroupDelayTestPhase {
    Idle,
    Pending,
    Progress,
    Cancelled,
    Completed,
    Partial,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GroupDelayChildPhase {
    Pending,
    Success,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GroupDelayFailure {
    Timeout,
    Unavailable,
    StaleMembership,
    Disconnected,
    VersionDrift,
    InconsistentObservation,
    Cancelled,
}

#[derive(Clone, Debug, Default)]
pub struct PolicyGroupConnectionCleanupPreference {
    enabled: Arc<AtomicBool>,
}

impl PolicyGroupConnectionCleanupPreference {
    pub fn enabled(&self) -> bool {
        self.enabled.load(Ordering::Acquire)
    }

    pub fn set_enabled(&self, enabled: bool) {
        self.enabled.store(enabled, Ordering::Release);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GroupSelectionCleanupMode {
    Off,
    OldDirectChild,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GroupSelectionCleanupPhase {
    Idle,
    Completed,
    Skipped,
    Partial,
    Failed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum GroupSelectionCleanupFailure {
    Cancelled,
    ControllerRejected,
    Disconnected,
    InconsistentObservation,
    RuntimeReplaced,
    StaleRevision,
    Timeout,
    VersionDrift,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupSelectionOperation {
    pub catalog_revision: String,
    pub cleanup_failure: Option<GroupSelectionCleanupFailure>,
    pub cleanup_mode: GroupSelectionCleanupMode,
    pub cleanup_phase: GroupSelectionCleanupPhase,
    pub closed_count: u32,
    pub controller_session_revision: u64,
    pub failed_count: u32,
    pub membership_revision: String,
    pub operation_id: Option<String>,
    pub scan_count: u16,
    pub selection_confirmed: bool,
    pub target_count: u32,
}

impl GroupSelectionOperation {
    pub fn idle() -> Self {
        Self {
            catalog_revision: String::new(),
            cleanup_failure: None,
            cleanup_mode: GroupSelectionCleanupMode::Off,
            cleanup_phase: GroupSelectionCleanupPhase::Idle,
            closed_count: 0,
            controller_session_revision: 0,
            failed_count: 0,
            membership_revision: String::new(),
            operation_id: None,
            scan_count: 0,
            selection_confirmed: false,
            target_count: 0,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDelayChildResult {
    pub child_id: String,
    pub failure: Option<GroupDelayFailure>,
    pub latency_milliseconds: Option<u16>,
    pub observed_at: Option<u64>,
    pub phase: GroupDelayChildPhase,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDelayTest {
    pub children: Vec<GroupDelayChildResult>,
    pub finished_at: Option<u64>,
    pub group_id: Option<String>,
    pub phase: GroupDelayTestPhase,
    pub profile_id: Option<String>,
    pub started_at: Option<u64>,
    pub test_id: Option<String>,
}

impl GroupDelayTest {
    pub const fn idle() -> Self {
        Self {
            children: Vec::new(),
            finished_at: None,
            group_id: None,
            phase: GroupDelayTestPhase::Idle,
            profile_id: None,
            started_at: None,
            test_id: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupDelayPolicy {
    pub id: String,
    pub timeout_milliseconds: u16,
    pub url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureSelection {
    pub system_proxy: bool,
    pub tun: bool,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeStatus {
    pub capture_operation: CaptureOperationStatus,
    pub capture_selection: CaptureSelection,
    pub message: String,
    pub phase: RuntimePhase,
    pub system_proxy_enabled: bool,
    pub system_proxy: SystemProxyRuntimeStatus,
    pub tun: TunRuntimeStatus,
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
        let capture = CaptureRuntimeStatus::off();
        Self {
            capture_operation: capture.capture_operation,
            capture_selection,
            message: core
                .error
                .clone()
                .unwrap_or_else(|| fallback_message.to_owned()),
            phase,
            system_proxy_enabled: false,
            system_proxy: capture.system_proxy,
            tun: capture.tun,
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
    pub selected_child_id: Option<String>,
    #[serde(rename = "type")]
    pub kind: PolicyGroupKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unsupported_type: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PolicyGroupKind {
    Selector,
    UrlTest,
    Fallback,
    LoadBalance,
    Relay,
    Direct,
    Reject,
    Unsupported,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GroupUsage {
    pub group_id: String,
    pub observed_connection_count: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ServiceMonitor {
    pub icon: String,
    pub id: String,
    pub label: String,
    pub url: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceProbeResult {
    pub failure_stage: Option<ServiceProbeFailureStage>,
    pub latency_milliseconds: Option<u64>,
    pub monitor_id: String,
    pub observed_at: String,
    pub route_target: String,
    pub status: ProbeStatus,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ServiceProbeFailureStage {
    AddressPolicy,
    ClientSetup,
    DnsResolution,
    HttpStatus,
    TargetValidation,
    Transport,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceProbePolicy {
    pub interval_seconds: u16,
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
    pub application_order: ApplicationSnapshotOrder,
    pub capabilities: PlatformCapabilities,
    pub groups: Vec<PolicyGroup>,
    pub group_usage: Vec<GroupUsage>,
    pub group_delay_policy: GroupDelayPolicy,
    pub group_delay_test: GroupDelayTest,
    pub group_selection_operation: GroupSelectionOperation,
    pub group_selection_availability: GroupSelectionAvailability,
    pub metrics: RuntimeMetrics,
    pub nodes: Vec<ProxyNode>,
    pub probe_results: Vec<ServiceProbeResult>,
    pub profiles: Vec<ProfileSummary>,
    pub recent_traffic: RecentTrafficSnapshot,
    pub routing_mode: RoutingMode,
    pub runtime: RuntimeStatus,
    pub service_probe_policy: ServiceProbePolicy,
    pub services: Vec<ServiceMonitor>,
    pub traffic: TrafficSnapshot,
}

impl StatusSnapshot {
    pub fn lifecycle_only(core: &CoreStatus, adapter_kind: StatusAdapterKind) -> Self {
        Self {
            active_profile_id: "local".into(),
            adapter_kind,
            application_order: ApplicationSnapshotOrder::detached(),
            capabilities: PlatformCapabilities::unavailable(),
            groups: Vec::new(),
            group_usage: Vec::new(),
            group_delay_policy: GroupDelayPolicy {
                id: "unavailable".into(),
                timeout_milliseconds: 0,
                url: None,
            },
            group_delay_test: GroupDelayTest::idle(),
            group_selection_operation: GroupSelectionOperation::idle(),
            group_selection_availability: GroupSelectionAvailability::Unavailable,
            metrics: RuntimeMetrics::default(),
            nodes: Vec::new(),
            probe_results: Vec::new(),
            profiles: vec![ProfileSummary {
                id: "local".into(),
                label: "Local Mihomo".into(),
            }],
            recent_traffic: RecentTrafficSnapshot::detached(),
            routing_mode: RoutingMode::Rule,
            runtime: RuntimeStatus::from_core(
                core,
                CaptureSelection {
                    system_proxy: false,
                    tun: false,
                },
            ),
            service_probe_policy: ServiceProbePolicy {
                interval_seconds: 5,
            },
            services: default_service_monitors(),
            traffic: TrafficSnapshot::default(),
        }
    }
}

pub fn default_service_monitors() -> Vec<ServiceMonitor> {
    [
        (
            "/assets/remix-icon/google.svg",
            "google",
            "Google",
            "https://www.google.com/generate_204",
        ),
        (
            "/assets/remix-icon/github.svg",
            "github",
            "GitHub",
            "https://github.com/favicon.ico",
        ),
        (
            "/assets/remix-icon/cloud.svg",
            "cloudflare",
            "Cloudflare",
            "https://cp.cloudflare.com/generate_204",
        ),
        (
            "/assets/remix-icon/baidu.svg",
            "baidu",
            "Baidu",
            "https://www.baidu.com/favicon.ico",
        ),
        (
            "/assets/remix-icon/wechat.svg",
            "weixin",
            "Weixin",
            "https://res.wx.qq.com/a/wx_fed/assets/res/NTI4MWU5.ico",
        ),
        (
            "/assets/remix-icon/aws.svg",
            "aws-us-east-1",
            "AWS (us-east-1)",
            "https://dynamodb.us-east-1.amazonaws.com/ping",
        ),
    ]
    .into_iter()
    .map(|(icon, id, label, url)| ServiceMonitor {
        icon: icon.into(),
        id: id.into(),
        label: label.into(),
        url: url.into(),
    })
    .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_service_monitors_are_the_six_bounded_probe_targets() {
        let targets: Vec<_> = default_service_monitors()
            .into_iter()
            .map(|monitor| (monitor.id, monitor.url))
            .collect();
        assert_eq!(
            targets,
            [
                (
                    "google".into(),
                    "https://www.google.com/generate_204".into()
                ),
                ("github".into(), "https://github.com/favicon.ico".into()),
                (
                    "cloudflare".into(),
                    "https://cp.cloudflare.com/generate_204".into()
                ),
                ("baidu".into(), "https://www.baidu.com/favicon.ico".into()),
                (
                    "weixin".into(),
                    "https://res.wx.qq.com/a/wx_fed/assets/res/NTI4MWU5.ico".into()
                ),
                (
                    "aws-us-east-1".into(),
                    "https://dynamodb.us-east-1.amazonaws.com/ping".into()
                ),
            ]
        );
    }

    #[test]
    fn default_service_monitors_use_root_relative_bundled_icons() {
        let icons: Vec<_> = default_service_monitors()
            .into_iter()
            .map(|monitor| monitor.icon)
            .collect();

        assert_eq!(
            icons,
            [
                "/assets/remix-icon/google.svg",
                "/assets/remix-icon/github.svg",
                "/assets/remix-icon/cloud.svg",
                "/assets/remix-icon/baidu.svg",
                "/assets/remix-icon/wechat.svg",
                "/assets/remix-icon/aws.svg",
            ]
        );
        assert!(icons.iter().all(|icon| icon.starts_with('/')));
    }

    #[test]
    fn default_aws_monitor_names_the_fixed_region() {
        let aws = default_service_monitors()
            .into_iter()
            .find(|monitor| monitor.id == "aws-us-east-1")
            .unwrap();

        assert_eq!(aws.label, "AWS (us-east-1)");
    }
}
