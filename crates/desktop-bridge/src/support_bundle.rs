use std::{collections::BTreeMap, sync::Arc};

use mish_runtime::{
    CapabilityAvailability, CorePhase, CoreStatus, DiagnosticCheck, DiagnosticCheckKind,
    DiagnosticCheckStatus, DiagnosticFailure, DiagnosticHistory, DiagnosticObservedFact,
    DiagnosticRouteTarget, DiagnosticRun, DiagnosticRunStatus, EventLevel, EventSource,
    EventSourcePhase, EventsDataPhase, EventsSnapshot, StatusAdapterKind, StatusSnapshot,
    SystemProxyObservedState, SystemProxyPhase,
};
use serde::Serialize;

use crate::{DesktopRuntimeHost, ManagedActivationState, MihomoActivationManager};

pub const SUPPORT_BUNDLE_MAX_BYTES: usize = 256 * 1_024;
const SUPPORT_BUNDLE_EVENT_LIMIT: usize = 256;
const SUPPORT_BUNDLE_RUN_LIMIT: usize = 8;
const SUPPORT_BUNDLE_CHECK_LIMIT: usize = 16;
const SUPPORT_BUNDLE_FORMAT_VERSION: u32 = 1;
const SUPPORT_BUNDLE_PROTOCOL_VERSION: u32 = 9;

#[derive(Clone, Debug)]
pub struct SupportBundlePlatform {
    pub architecture: String,
    pub operating_system: String,
    pub operating_system_version: String,
}

#[derive(Clone)]
pub struct SupportBundleService {
    activation: Arc<MihomoActivationManager>,
    application_version: &'static str,
    platform: SupportBundlePlatform,
    runtime: DesktopRuntimeHost,
}

impl SupportBundleService {
    pub fn new(
        runtime: DesktopRuntimeHost,
        activation: Arc<MihomoActivationManager>,
        application_version: &'static str,
        platform: SupportBundlePlatform,
    ) -> Self {
        Self {
            activation,
            application_version,
            platform,
            runtime,
        }
    }

    pub async fn prepare(
        &self,
        preview_id: String,
        generated_at: u64,
    ) -> Result<PreparedSupportBundle, SupportBundleError> {
        let (core, status, events) = self
            .runtime
            .support_bundle_runtime_snapshot(StatusAdapterKind::Rpc)
            .await;
        let diagnostics = self.runtime.diagnostic_history(StatusAdapterKind::Rpc);
        let activation = self.activation.managed_state().await;
        build_support_bundle(
            preview_id,
            SupportBundleInput {
                activation: &activation,
                application_version: self.application_version,
                core: &core,
                diagnostics: &diagnostics,
                events: &events,
                generated_at,
                platform: &self.platform,
                status: &status,
            },
        )
    }
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundlePreview {
    pub categories: Vec<SupportBundleCategoryPreview>,
    pub content_bytes: usize,
    pub excluded_or_redacted: Vec<RedactionCategory>,
    pub file_type: &'static str,
    pub format_version: u32,
    pub max_bytes: usize,
    pub preview_id: String,
    pub time_range: Option<SupportTimeRange>,
}

#[derive(Clone, Debug)]
pub struct PreparedSupportBundle {
    pub bytes: Vec<u8>,
    pub preview: SupportBundlePreview,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SupportBundleError {
    Serialization,
    SizeLimitExceeded,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportBundleManifest {
    active_profile: Option<SupportActiveProfile>,
    application: SupportApplication,
    capabilities: SupportCapabilities,
    capture: SupportCapture,
    diagnostics: SupportDiagnostics,
    events: SupportEventsSummary,
    format_version: u32,
    generated_at: u64,
    platform: SupportPlatform,
    redaction_report: SupportRedactionReport,
}

struct SupportBundleInput<'a> {
    activation: &'a ManagedActivationState,
    application_version: &'a str,
    core: &'a CoreStatus,
    diagnostics: &'a DiagnosticHistory,
    events: &'a EventsSnapshot,
    generated_at: u64,
    platform: &'a SupportBundlePlatform,
    status: &'a StatusSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportApplication {
    application_version: String,
    bridge_version: &'static str,
    core_phase: CorePhase,
    core_version: Option<&'static str>,
    core_version_status: CoreVersionStatus,
    protocol_version: u32,
}

#[derive(Serialize)]
#[serde(rename_all = "kebab-case")]
enum CoreVersionStatus {
    Matched,
    Missing,
    Mismatch,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportPlatform {
    architecture: String,
    operating_system: String,
    operating_system_version: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportCapabilities {
    diagnostics: CapabilityAvailability,
    events: EventsDataPhase,
    event_sources: Vec<SupportEventSourceStatus>,
    support_bundle_export: CapabilityAvailability,
    system_proxy: CapabilityAvailability,
    tun: CapabilityAvailability,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportEventSourceStatus {
    phase: EventSourcePhase,
    source: EventSource,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportActiveProfile {
    fingerprint: String,
    id: String,
    revision: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportCapture {
    desired: bool,
    drift: bool,
    observed: SystemProxyObservedState,
    phase: SystemProxyPhase,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportEventsSummary {
    counts_by_level: BTreeMap<&'static str, usize>,
    counts_by_source: BTreeMap<&'static str, usize>,
    included_count: usize,
    phase: EventsDataPhase,
    retained_count: usize,
    time_range: Option<SupportTimeRange>,
    truncated_count: usize,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportTimeRange {
    pub ended_at: u64,
    pub started_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportDiagnostics {
    active_run_present: bool,
    runs: Vec<SupportDiagnosticRun>,
    truncated_run_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportDiagnosticRun {
    adapter_kind: StatusAdapterKind,
    checks: Vec<SupportDiagnosticCheck>,
    finished_at: Option<u64>,
    policy: SupportDiagnosticPolicy,
    profile_id: Option<String>,
    sequence: usize,
    started_at: u64,
    status: DiagnosticRunStatus,
    truncated_check_count: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportDiagnosticPolicy {
    expected_http_status: u16,
    id: Option<String>,
    timeout_milliseconds: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportDiagnosticCheck {
    failure: Option<DiagnosticFailure>,
    finished_at: u64,
    kind: DiagnosticCheckKind,
    observed_fact: SupportObservedFact,
    route_target: SupportRouteTarget,
    started_at: u64,
    status: DiagnosticCheckStatus,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum SupportObservedFact {
    Bridge {
        authenticated: bool,
    },
    Core {
        phase: CorePhase,
        version: Option<&'static str>,
    },
    Profile {
        present: bool,
        valid: bool,
    },
    Capture {
        desired: bool,
        drift: bool,
        observed: SystemProxyObservedState,
    },
    Dns {
        address_count: usize,
    },
    Reachability {
        http_status: u16,
        latency_milliseconds: u64,
    },
    Failure,
    Unavailable,
}

#[derive(Serialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
enum SupportRouteTarget {
    LocalBridge,
    ManagedCore,
    ActiveProfile,
    CaptureState,
    FixedEndpoint {
        route: &'static str,
    },
    PolicyGroupUnavailable,
    PolicyGroup {
        child_id: Option<String>,
        group_id: Option<String>,
    },
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SupportBundleCategoryPreview {
    pub category: SupportBundleCategory,
    pub item_count: usize,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SupportBundleCategory {
    Application,
    Platform,
    Capabilities,
    ActiveProfile,
    Capture,
    EventsSummary,
    DiagnosticRuns,
    RedactionReport,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportRedactionReport {
    categories: Vec<SupportRedactionEntry>,
    strategy_version: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportRedactionEntry {
    category: RedactionCategory,
    treatment: RedactionTreatment,
}

#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RedactionCategory {
    RawProfileConfiguration,
    SubscriptionUrls,
    CredentialsAndSecrets,
    FullPaths,
    NodeLabels,
    ConnectionDestinations,
    ProcessPaths,
    NetworkAddressesAndHostnames,
    PrivateEndpoints,
    ControllerPayloads,
    StatusBarLabels,
    EventText,
    DiagnosticProse,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RedactionTreatment {
    AggregatedOnly,
    ExcludedAtSource,
    StructuredFieldsOnly,
}

fn build_support_bundle(
    preview_id: String,
    input: SupportBundleInput<'_>,
) -> Result<PreparedSupportBundle, SupportBundleError> {
    let events = summarize_events(input.events);
    let diagnostics = summarize_diagnostics(input.diagnostics);
    let active_profile = active_profile(input.activation, input.status);
    let time_range = combined_time_range(events.time_range.as_ref(), &diagnostics.runs);
    let check_count = diagnostics
        .runs
        .iter()
        .map(|run| run.checks.len())
        .sum::<usize>();
    let manifest = SupportBundleManifest {
        active_profile,
        application: application_summary(input.application_version, input.core),
        capabilities: SupportCapabilities {
            diagnostics: CapabilityAvailability::Supported,
            events: input.events.phase,
            event_sources: input
                .events
                .source_statuses
                .iter()
                .map(|status| SupportEventSourceStatus {
                    phase: status.phase,
                    source: status.source,
                })
                .collect(),
            support_bundle_export: CapabilityAvailability::Supported,
            system_proxy: input.status.capabilities.system_proxy,
            tun: input.status.capabilities.tun,
        },
        capture: SupportCapture {
            desired: input.status.runtime.system_proxy.desired,
            drift: input.status.runtime.system_proxy.phase == SystemProxyPhase::Drift,
            observed: input.status.runtime.system_proxy.observed,
            phase: input.status.runtime.system_proxy.phase,
        },
        diagnostics,
        events,
        format_version: SUPPORT_BUNDLE_FORMAT_VERSION,
        generated_at: input.generated_at,
        platform: SupportPlatform {
            architecture: bounded_platform_value(&input.platform.architecture),
            operating_system: bounded_platform_value(&input.platform.operating_system),
            operating_system_version: bounded_platform_value(
                &input.platform.operating_system_version,
            ),
        },
        redaction_report: SupportRedactionReport {
            categories: redaction_entries(),
            strategy_version: "mish-support-bundle-redaction-v1",
        },
    };
    let bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|_| SupportBundleError::Serialization)?;
    if bytes.len() > SUPPORT_BUNDLE_MAX_BYTES {
        return Err(SupportBundleError::SizeLimitExceeded);
    }
    let preview = SupportBundlePreview {
        categories: vec![
            preview_category(SupportBundleCategory::Application, 1),
            preview_category(SupportBundleCategory::Platform, 1),
            preview_category(SupportBundleCategory::Capabilities, 1),
            preview_category(
                SupportBundleCategory::ActiveProfile,
                usize::from(manifest.active_profile.is_some()),
            ),
            preview_category(SupportBundleCategory::Capture, 1),
            preview_category(
                SupportBundleCategory::EventsSummary,
                manifest.events.included_count,
            ),
            preview_category(SupportBundleCategory::DiagnosticRuns, check_count),
            preview_category(
                SupportBundleCategory::RedactionReport,
                manifest.redaction_report.categories.len(),
            ),
        ],
        content_bytes: bytes.len(),
        excluded_or_redacted: redaction_categories(),
        file_type: "application/json",
        format_version: SUPPORT_BUNDLE_FORMAT_VERSION,
        max_bytes: SUPPORT_BUNDLE_MAX_BYTES,
        preview_id,
        time_range,
    };
    Ok(PreparedSupportBundle { bytes, preview })
}

fn application_summary(version: &str, core: &CoreStatus) -> SupportApplication {
    let pinned = mish_mihomo_controller::PINNED_MIHOMO_VERSION;
    let version_status = match core.version.as_deref() {
        Some(version) if version.contains(pinned) => CoreVersionStatus::Matched,
        Some(_) => CoreVersionStatus::Mismatch,
        None => CoreVersionStatus::Missing,
    };
    SupportApplication {
        application_version: bounded_platform_value(version),
        bridge_version: env!("CARGO_PKG_VERSION"),
        core_phase: core.phase,
        core_version: matches!(version_status, CoreVersionStatus::Matched).then_some(pinned),
        core_version_status: version_status,
        protocol_version: SUPPORT_BUNDLE_PROTOCOL_VERSION,
    }
}

fn active_profile(
    activation: &ManagedActivationState,
    status: &StatusSnapshot,
) -> Option<SupportActiveProfile> {
    let id = activation.active_profile_id()?;
    if status.active_profile_id != id {
        return None;
    }
    Some(SupportActiveProfile {
        fingerprint: safe_identifier(activation.active_fingerprint()?)?,
        id: safe_identifier(id)?,
        revision: safe_identifier(activation.active_revision()?)?,
    })
}

fn summarize_events(snapshot: &EventsSnapshot) -> SupportEventsSummary {
    let retained_count = snapshot.events.len();
    let start = retained_count.saturating_sub(SUPPORT_BUNDLE_EVENT_LIMIT);
    let included = &snapshot.events[start..];
    let mut counts_by_level =
        BTreeMap::from([("debug", 0), ("error", 0), ("info", 0), ("warning", 0)]);
    let mut counts_by_source =
        BTreeMap::from([("application", 0), ("core", 0), ("platform", 0), ("rpc", 0)]);
    for event in included {
        *counts_by_level
            .entry(event_level_key(event.level))
            .or_default() += 1;
        *counts_by_source
            .entry(event_source_key(event.source))
            .or_default() += 1;
    }
    SupportEventsSummary {
        counts_by_level,
        counts_by_source,
        included_count: included.len(),
        phase: snapshot.phase,
        retained_count,
        time_range: time_range(included.iter().map(|event| event.observed_at)),
        truncated_count: retained_count.saturating_sub(included.len()),
    }
}

fn summarize_diagnostics(history: &DiagnosticHistory) -> SupportDiagnostics {
    let runs = history
        .runs
        .iter()
        .take(SUPPORT_BUNDLE_RUN_LIMIT)
        .enumerate()
        .map(|(sequence, run)| summarize_run(sequence, run))
        .collect();
    SupportDiagnostics {
        active_run_present: history.active_run_id.is_some(),
        runs,
        truncated_run_count: history.runs.len().saturating_sub(SUPPORT_BUNDLE_RUN_LIMIT),
    }
}

fn summarize_run(sequence: usize, run: &DiagnosticRun) -> SupportDiagnosticRun {
    SupportDiagnosticRun {
        adapter_kind: run.adapter_kind,
        checks: run
            .checks
            .iter()
            .take(SUPPORT_BUNDLE_CHECK_LIMIT)
            .map(summarize_check)
            .collect(),
        finished_at: run.finished_at,
        policy: SupportDiagnosticPolicy {
            expected_http_status: run.policy.expected_http_status,
            id: safe_identifier(run.policy.id),
            timeout_milliseconds: run.policy.timeout_milliseconds.min(30_000),
        },
        profile_id: run.profile_id.as_deref().and_then(safe_identifier),
        sequence,
        started_at: run.started_at,
        status: run.status,
        truncated_check_count: run.checks.len().saturating_sub(SUPPORT_BUNDLE_CHECK_LIMIT),
    }
}

fn summarize_check(check: &DiagnosticCheck) -> SupportDiagnosticCheck {
    SupportDiagnosticCheck {
        failure: check.failure,
        finished_at: check.finished_at,
        kind: check.kind,
        observed_fact: observed_fact(&check.observed_fact),
        route_target: route_target(&check.route_target),
        started_at: check.started_at,
        status: check.status,
    }
}

fn observed_fact(fact: &DiagnosticObservedFact) -> SupportObservedFact {
    match fact {
        DiagnosticObservedFact::Bridge { authenticated } => SupportObservedFact::Bridge {
            authenticated: *authenticated,
        },
        DiagnosticObservedFact::Core { phase, version } => SupportObservedFact::Core {
            phase: *phase,
            version: version
                .as_deref()
                .is_some_and(|value| value.contains(mish_mihomo_controller::PINNED_MIHOMO_VERSION))
                .then_some(mish_mihomo_controller::PINNED_MIHOMO_VERSION),
        },
        DiagnosticObservedFact::Profile { present, valid } => SupportObservedFact::Profile {
            present: *present,
            valid: *valid,
        },
        DiagnosticObservedFact::Capture {
            desired,
            drift,
            observed,
        } => SupportObservedFact::Capture {
            desired: *desired,
            drift: *drift,
            observed: *observed,
        },
        DiagnosticObservedFact::Dns { address_count } => SupportObservedFact::Dns {
            address_count: *address_count,
        },
        DiagnosticObservedFact::Reachability {
            http_status,
            latency_milliseconds,
        } => SupportObservedFact::Reachability {
            http_status: *http_status,
            latency_milliseconds: *latency_milliseconds,
        },
        DiagnosticObservedFact::Unavailable { .. } => SupportObservedFact::Unavailable,
        DiagnosticObservedFact::Failure { .. } => SupportObservedFact::Failure,
    }
}

fn route_target(target: &DiagnosticRouteTarget) -> SupportRouteTarget {
    match target {
        DiagnosticRouteTarget::LocalBridge => SupportRouteTarget::LocalBridge,
        DiagnosticRouteTarget::ManagedCore => SupportRouteTarget::ManagedCore,
        DiagnosticRouteTarget::ActiveProfile => SupportRouteTarget::ActiveProfile,
        DiagnosticRouteTarget::CaptureState => SupportRouteTarget::CaptureState,
        DiagnosticRouteTarget::FixedEndpoint { route } => {
            SupportRouteTarget::FixedEndpoint { route }
        }
        DiagnosticRouteTarget::PolicyGroupUnavailable => SupportRouteTarget::PolicyGroupUnavailable,
        DiagnosticRouteTarget::PolicyGroup { child_id, group_id } => {
            SupportRouteTarget::PolicyGroup {
                child_id: safe_identifier(child_id),
                group_id: safe_identifier(group_id),
            }
        }
    }
}

fn preview_category(
    category: SupportBundleCategory,
    item_count: usize,
) -> SupportBundleCategoryPreview {
    SupportBundleCategoryPreview {
        category,
        item_count,
    }
}

fn redaction_entries() -> Vec<SupportRedactionEntry> {
    redaction_categories()
        .into_iter()
        .map(|category| SupportRedactionEntry {
            treatment: match category {
                RedactionCategory::EventText => RedactionTreatment::AggregatedOnly,
                RedactionCategory::DiagnosticProse => RedactionTreatment::StructuredFieldsOnly,
                _ => RedactionTreatment::ExcludedAtSource,
            },
            category,
        })
        .collect()
}

fn redaction_categories() -> Vec<RedactionCategory> {
    vec![
        RedactionCategory::RawProfileConfiguration,
        RedactionCategory::SubscriptionUrls,
        RedactionCategory::CredentialsAndSecrets,
        RedactionCategory::FullPaths,
        RedactionCategory::NodeLabels,
        RedactionCategory::ConnectionDestinations,
        RedactionCategory::ProcessPaths,
        RedactionCategory::NetworkAddressesAndHostnames,
        RedactionCategory::PrivateEndpoints,
        RedactionCategory::ControllerPayloads,
        RedactionCategory::StatusBarLabels,
        RedactionCategory::EventText,
        RedactionCategory::DiagnosticProse,
    ]
}

fn combined_time_range(
    event_range: Option<&SupportTimeRange>,
    runs: &[SupportDiagnosticRun],
) -> Option<SupportTimeRange> {
    let mut values = Vec::with_capacity(runs.len() * 2 + 2);
    if let Some(range) = event_range {
        values.extend([range.started_at, range.ended_at]);
    }
    for run in runs {
        values.push(run.started_at);
        values.push(run.finished_at.unwrap_or(run.started_at));
    }
    time_range(values)
}

fn time_range(values: impl IntoIterator<Item = u64>) -> Option<SupportTimeRange> {
    let mut values = values.into_iter();
    let first = values.next()?;
    let (started_at, ended_at) = values.fold((first, first), |(started, ended), value| {
        (started.min(value), ended.max(value))
    });
    Some(SupportTimeRange {
        ended_at,
        started_at,
    })
}

fn safe_identifier(value: &str) -> Option<String> {
    (!value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':')))
    .then(|| value.to_owned())
}

fn bounded_platform_value(value: &str) -> String {
    value
        .chars()
        .filter(|character| character.is_ascii_alphanumeric() || " ._-+()".contains(*character))
        .take(128)
        .collect()
}

const fn event_level_key(level: EventLevel) -> &'static str {
    match level {
        EventLevel::Debug => "debug",
        EventLevel::Info => "info",
        EventLevel::Warning => "warning",
        EventLevel::Error => "error",
    }
}

const fn event_source_key(source: EventSource) -> &'static str {
    match source {
        EventSource::Application => "application",
        EventSource::Core => "core",
        EventSource::Platform => "platform",
        EventSource::Rpc => "rpc",
    }
}

#[cfg(test)]
mod tests {
    use mish_runtime::{
        CorePhase, DiagnosticCheck, DiagnosticCheckKind, DiagnosticCheckStatus, DiagnosticFailure,
        DiagnosticHistory, DiagnosticObservedFact, DiagnosticProbePolicy, DiagnosticRouteTarget,
        DiagnosticRun, DiagnosticRunStatus, EventLevel, EventRecord, EventSource, EventsSnapshot,
        StatusAdapterKind, StatusSnapshot,
    };

    use super::{
        SUPPORT_BUNDLE_CHECK_LIMIT, SUPPORT_BUNDLE_EVENT_LIMIT, SUPPORT_BUNDLE_MAX_BYTES,
        SUPPORT_BUNDLE_RUN_LIMIT, SupportBundleInput, SupportBundlePlatform, build_support_bundle,
    };
    use crate::ManagedActivationState;

    #[test]
    fn manifest_is_deterministic_and_excludes_sensitive_categories_at_the_source() {
        let core = core_status();
        let status = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        let events = malicious_events(2);
        let diagnostics = malicious_diagnostics(1, 1);
        let activation = ManagedActivationState::default();
        let platform = platform();
        let input = || SupportBundleInput {
            activation: &activation,
            application_version: "0.1.0",
            core: &core,
            diagnostics: &diagnostics,
            events: &events,
            generated_at: 1_721_286_400_000,
            platform: &platform,
            status: &status,
        };

        let first = build_support_bundle("preview-1".into(), input()).unwrap();
        let second = build_support_bundle("preview-2".into(), input()).unwrap();
        assert_eq!(first.bytes, second.bytes);
        let exported = String::from_utf8(first.bytes).unwrap();
        for forbidden in [
            "secret-token-value",
            "subscription.example.invalid",
            "raw-profile-yaml",
            "/synthetic/private/profile.yaml",
            "/synthetic/private/process-bin",
            "Sensitive Node Label",
            "connection-destination.invalid",
            "198.51.100.23",
            "raw-hostname.invalid",
            "private-controller.invalid",
            "Controller payload",
            "Status bar label",
            "diagnostic private prose",
        ] {
            assert!(!exported.contains(forbidden), "leaked {forbidden}");
        }
        assert!(exported.contains("raw-profile-configuration"));
        assert!(exported.contains("event-text"));
        assert!(exported.contains("structured-fields-only"));
        assert!(first.preview.content_bytes < SUPPORT_BUNDLE_MAX_BYTES);
    }

    #[test]
    fn manifest_enforces_event_run_check_and_size_bounds() {
        let core = core_status();
        let status = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        let events = malicious_events(SUPPORT_BUNDLE_EVENT_LIMIT + 40);
        let diagnostics =
            malicious_diagnostics(SUPPORT_BUNDLE_RUN_LIMIT + 3, SUPPORT_BUNDLE_CHECK_LIMIT + 4);
        let activation = ManagedActivationState::default();
        let platform = platform();
        let bundle = build_support_bundle(
            "preview-2".into(),
            SupportBundleInput {
                activation: &activation,
                application_version: "0.1.0",
                core: &core,
                diagnostics: &diagnostics,
                events: &events,
                generated_at: 1,
                platform: &platform,
                status: &status,
            },
        )
        .unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&bundle.bytes).unwrap();
        assert_eq!(
            manifest["events"]["includedCount"],
            SUPPORT_BUNDLE_EVENT_LIMIT
        );
        assert_eq!(manifest["events"]["truncatedCount"], 40);
        assert_eq!(
            manifest["diagnostics"]["runs"].as_array().unwrap().len(),
            SUPPORT_BUNDLE_RUN_LIMIT
        );
        assert!(
            manifest["diagnostics"]["runs"]
                .as_array()
                .unwrap()
                .iter()
                .all(|run| run["checks"].as_array().unwrap().len() == SUPPORT_BUNDLE_CHECK_LIMIT)
        );
        assert!(bundle.preview.content_bytes <= bundle.preview.max_bytes);
    }

    #[test]
    fn building_a_manifest_does_not_mutate_source_history() {
        let core = core_status();
        let status = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        let events = malicious_events(3);
        let diagnostics = malicious_diagnostics(2, 2);
        let activation = ManagedActivationState::default();
        let platform = platform();
        let before_events = serde_json::to_vec(&events).unwrap();
        let before_diagnostics = serde_json::to_vec(&diagnostics).unwrap();
        build_support_bundle(
            "preview-3".into(),
            SupportBundleInput {
                activation: &activation,
                application_version: "0.1.0",
                core: &core,
                diagnostics: &diagnostics,
                events: &events,
                generated_at: 1,
                platform: &platform,
                status: &status,
            },
        )
        .unwrap();
        assert_eq!(serde_json::to_vec(&events).unwrap(), before_events);
        assert_eq!(
            serde_json::to_vec(&diagnostics).unwrap(),
            before_diagnostics
        );
    }

    fn core_status() -> mish_runtime::CoreStatus {
        mish_runtime::CoreStatus {
            error: None,
            phase: CorePhase::Running,
            pid: Some(42),
            version: Some(format!(
                "Mihomo {}",
                mish_mihomo_controller::PINNED_MIHOMO_VERSION
            )),
        }
    }

    fn platform() -> SupportBundlePlatform {
        SupportBundlePlatform {
            architecture: "aarch64".into(),
            operating_system: "macos".into(),
            operating_system_version: "26.0".into(),
        }
    }

    fn malicious_events(count: usize) -> EventsSnapshot {
        let mut snapshot = EventsSnapshot::unavailable(StatusAdapterKind::Rpc);
        snapshot.events = (0..count)
            .map(|sequence| EventRecord {
                detail: Some("Controller payload token=secret-token-value Status bar label raw-profile-yaml /synthetic/private/process-bin".into()),
                id: format!("event-{sequence}"),
                level: EventLevel::Error,
                message: "Sensitive Node Label connected to connection-destination.invalid at 198.51.100.23 from raw-hostname.invalid /synthetic/private/profile.yaml and https://subscription.example.invalid/?token=secret-token-value".into(),
                observed_at: 1_000 + sequence as u64,
                sequence: sequence as u64,
                source: EventSource::Core,
            })
            .collect();
        snapshot
    }

    fn malicious_diagnostics(run_count: usize, check_count: usize) -> DiagnosticHistory {
        DiagnosticHistory {
            active_run_id: None,
            adapter_kind: StatusAdapterKind::Rpc,
            runs: (0..run_count)
                .map(|run| DiagnosticRun {
                    adapter_kind: StatusAdapterKind::Rpc,
                    checks: (0..check_count)
                        .map(|check| DiagnosticCheck {
                            failure: Some(DiagnosticFailure::Unavailable),
                            finished_at: 2_001 + check as u64,
                            id: format!("run-{run}:check-{check}"),
                            interpretation: "diagnostic private prose",
                            kind: DiagnosticCheckKind::ProxyReachability,
                            observed_fact: DiagnosticObservedFact::Failure {
                                reason: "private-controller.invalid and Controller payload",
                            },
                            route_target: DiagnosticRouteTarget::PolicyGroup {
                                child_id: "child:abcdef".into(),
                                group_id: "group:abcdef".into(),
                            },
                            scope: "Sensitive Node Label",
                            started_at: 2_000 + check as u64,
                            status: DiagnosticCheckStatus::Unavailable,
                        })
                        .collect(),
                    finished_at: Some(3_000 + run as u64),
                    id: format!("run-{run}"),
                    policy: DiagnosticProbePolicy {
                        endpoint_label: "private-controller.invalid",
                        expected_http_status: 204,
                        id: "mish-guided-diagnostics-v1",
                        timeout_milliseconds: 5_000,
                    },
                    profile_id: Some("profile:abcdef".into()),
                    started_at: 2_000 + run as u64,
                    status: DiagnosticRunStatus::Completed,
                })
                .collect(),
        }
    }
}
