use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use mish_runtime::{
    CapabilityAvailability, CorePhase, CoreStatus, EventLevel, EventSource, EventSourcePhase,
    EventsDataPhase, EventsSnapshot, ProbeStatus, ServiceProbeFailureStage, StatusAdapterKind,
    StatusSnapshot, SystemProxyObservedState, SystemProxyPhase,
};
use mish_updater::{UpdaterDiagnosticSnapshot, UpdaterService};
use serde::{Deserialize, Serialize};

use crate::{
    ActivationFailureKind, ActivationOutcome, DesktopRuntimeHost, ManagedActivationState,
    MihomoActivationManager,
};

pub const SUPPORT_BUNDLE_MAX_BYTES: usize = 256 * 1_024;
const SUPPORT_BUNDLE_EVENT_LIMIT: usize = 256;
const SUPPORT_BUNDLE_FORMAT_VERSION: u32 = 3;
const SUPPORT_BUNDLE_PROTOCOL_VERSION: u32 = 10;
pub const TERMINATION_EVIDENCE_MAX_RECORDS: usize = 32;
pub const TERMINATION_EVIDENCE_MAX_AGE_MILLISECONDS: u64 = 30 * 24 * 60 * 60 * 1_000;
pub const TERMINATION_EVIDENCE_MAX_RECORD_BYTES: usize = 512;
pub const TERMINATION_EVIDENCE_MAX_BYTES: usize = 16 * 1_024;
const TERMINATION_EVIDENCE_FILE: &str = "termination-evidence.json";
const TERMINATION_SESSION_FILE: &str = "termination-session.json";

#[derive(Clone, Debug)]
pub struct SupportBundlePlatform {
    pub architecture: String,
    pub operating_system: String,
    pub operating_system_version: String,
}

#[derive(Clone)]
pub struct TerminationEvidenceStore {
    root: PathBuf,
    platform: SupportBundlePlatform,
    application_version: &'static str,
    lock: Arc<Mutex<()>>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TerminationEvidenceRecord {
    application_version: String,
    architecture: String,
    category: TerminationCategory,
    component: TerminationComponent,
    observed_at: u64,
    operating_system: String,
    recovery_result: RecoveryResult,
    safe_error_code: SafeTerminationErrorCode,
    source_identity: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminationComponent {
    Application,
    ManagedCore,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TerminationCategory {
    NormalQuit,
    ForcedTerminationBoundary,
    ApplicationCrashBoundary,
    ManagedCoreExit,
    StartupFailure,
    UnknownTermination,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SafeTerminationErrorCode {
    None,
    StartupRecoveryFailed,
    ManagedCoreUnavailable,
}
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecoveryResult {
    NotApplicable,
    NoRecoveryNeeded,
    Recovered,
    Failed,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminationEvidenceFile {
    records: Vec<TerminationEvidenceRecord>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct TerminationSession {
    started_at: u64,
}

impl TerminationEvidenceRecord {
    fn new(
        observed_at: u64,
        component: TerminationComponent,
        category: TerminationCategory,
        safe_error_code: SafeTerminationErrorCode,
        recovery_result: RecoveryResult,
    ) -> Self {
        Self {
            application_version: String::new(),
            architecture: String::new(),
            category,
            component,
            observed_at,
            operating_system: String::new(),
            recovery_result,
            safe_error_code,
            source_identity: "mish-desktop".into(),
        }
    }
}

impl TerminationEvidenceStore {
    pub fn new(
        root: PathBuf,
        application_version: &'static str,
        platform: SupportBundlePlatform,
    ) -> Self {
        Self {
            root,
            platform,
            application_version,
            lock: Arc::new(Mutex::new(())),
        }
    }

    /// Returns true only when a prior session marker was present. This is an unknown
    /// termination boundary, never proof that the application crashed.
    pub fn begin_session(&self, observed_at: u64) -> bool {
        let _guard = self
            .lock
            .lock()
            .expect("termination evidence lock poisoned");
        let previous = self.read_session().is_some();
        if previous {
            self.record_locked(TerminationEvidenceRecord::new(
                observed_at,
                TerminationComponent::Application,
                TerminationCategory::UnknownTermination,
                SafeTerminationErrorCode::None,
                RecoveryResult::NoRecoveryNeeded,
            ));
        }
        let _ = self.write_private(
            &self.session_path(),
            &TerminationSession {
                started_at: observed_at,
            },
        );
        previous
    }

    pub fn clear_session(&self) {
        let _guard = self
            .lock
            .lock()
            .expect("termination evidence lock poisoned");
        let _ = fs::remove_file(self.session_path());
    }
    pub fn record_startup_recovery(&self, observed_at: u64, recovered: bool) {
        self.record(TerminationEvidenceRecord::new(
            observed_at,
            TerminationComponent::Application,
            TerminationCategory::UnknownTermination,
            SafeTerminationErrorCode::None,
            if recovered {
                RecoveryResult::Recovered
            } else {
                RecoveryResult::NoRecoveryNeeded
            },
        ));
    }
    pub fn record_startup_failure(&self, observed_at: u64) {
        self.record(TerminationEvidenceRecord::new(
            observed_at,
            TerminationComponent::Application,
            TerminationCategory::StartupFailure,
            SafeTerminationErrorCode::StartupRecoveryFailed,
            RecoveryResult::Failed,
        ));
    }
    pub fn record_detected_application_crash_boundary(&self, observed_at: u64) {
        self.record(TerminationEvidenceRecord::new(
            observed_at,
            TerminationComponent::Application,
            TerminationCategory::ApplicationCrashBoundary,
            SafeTerminationErrorCode::None,
            RecoveryResult::NotApplicable,
        ));
    }
    pub fn record(&self, record: TerminationEvidenceRecord) {
        let _guard = self
            .lock
            .lock()
            .expect("termination evidence lock poisoned");
        self.record_locked(record);
    }
    pub fn records(&self) -> Vec<TerminationEvidenceRecord> {
        let _guard = self
            .lock
            .lock()
            .expect("termination evidence lock poisoned");
        self.load_records().unwrap_or_default()
    }

    fn record_locked(&self, mut record: TerminationEvidenceRecord) {
        record.application_version = bounded_platform_value(self.application_version);
        record.architecture = bounded_platform_value(&self.platform.architecture);
        record.operating_system = bounded_platform_value(&self.platform.operating_system);
        if serde_json::to_vec(&record).map_or(true, |bytes| {
            bytes.len() > TERMINATION_EVIDENCE_MAX_RECORD_BYTES
        }) {
            return;
        }
        let mut records = self.load_records().unwrap_or_default();
        let newest = record.observed_at;
        records.push(record);
        records.retain(|record| {
            newest.saturating_sub(record.observed_at) <= TERMINATION_EVIDENCE_MAX_AGE_MILLISECONDS
        });
        records.sort_by_key(|record| record.observed_at);
        while records.len() > TERMINATION_EVIDENCE_MAX_RECORDS
            || serde_json::to_vec(&TerminationEvidenceFile {
                records: records.clone(),
            })
            .map_or(true, |bytes| bytes.len() > TERMINATION_EVIDENCE_MAX_BYTES)
        {
            records.remove(0);
        }
        let _ = self.write_private(&self.records_path(), &TerminationEvidenceFile { records });
    }

    fn load_records(&self) -> Option<Vec<TerminationEvidenceRecord>> {
        let bytes = fs::read(self.records_path()).ok()?;
        if bytes.len() > TERMINATION_EVIDENCE_MAX_BYTES {
            return None;
        }
        let file: TerminationEvidenceFile = serde_json::from_slice(&bytes).ok()?;
        if file.records.iter().any(|record| {
            serde_json::to_vec(record).map_or(true, |bytes| {
                bytes.len() > TERMINATION_EVIDENCE_MAX_RECORD_BYTES
            })
        }) {
            return None;
        }
        Some(file.records)
    }
    fn read_session(&self) -> Option<TerminationSession> {
        let bytes = fs::read(self.session_path()).ok()?;
        if bytes.len() > 256 {
            return None;
        }
        serde_json::from_slice(&bytes).ok()
    }
    fn write_private<T: Serialize>(&self, path: &Path, value: &T) -> std::io::Result<()> {
        fs::create_dir_all(&self.root)?;
        let bytes = serde_json::to_vec(value).map_err(std::io::Error::other)?;
        if bytes.len() > TERMINATION_EVIDENCE_MAX_BYTES {
            return Err(std::io::Error::other("too large"));
        }
        let temporary = path.with_extension("tmp");
        fs::write(&temporary, bytes)?;
        fs::rename(temporary, path)
    }
    fn records_path(&self) -> PathBuf {
        self.root.join(TERMINATION_EVIDENCE_FILE)
    }
    fn session_path(&self) -> PathBuf {
        self.root.join(TERMINATION_SESSION_FILE)
    }
}

fn now_milliseconds() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |value| value.as_millis() as u64)
}

#[derive(Clone)]
pub struct SupportBundleService {
    activation: Arc<MihomoActivationManager>,
    application_version: &'static str,
    platform: SupportBundlePlatform,
    runtime: DesktopRuntimeHost,
    termination_evidence: TerminationEvidenceStore,
    updater: Arc<UpdaterService>,
}

impl SupportBundleService {
    pub fn new(
        runtime: DesktopRuntimeHost,
        activation: Arc<MihomoActivationManager>,
        application_version: &'static str,
        platform: SupportBundlePlatform,
        termination_evidence: TerminationEvidenceStore,
        updater: Arc<UpdaterService>,
    ) -> Self {
        Self {
            activation,
            application_version,
            platform,
            runtime,
            termination_evidence,
            updater,
        }
    }

    pub fn begin_session(&self, observed_at: u64) -> bool {
        self.termination_evidence.begin_session(observed_at)
    }

    pub fn record_normal_quit(&self, observed_at: u64) {
        self.termination_evidence
            .record(TerminationEvidenceRecord::new(
                observed_at,
                TerminationComponent::Application,
                TerminationCategory::NormalQuit,
                SafeTerminationErrorCode::None,
                RecoveryResult::NotApplicable,
            ));
        self.termination_evidence.clear_session();
    }

    pub fn record_forced_termination_boundary(&self, observed_at: u64) {
        self.termination_evidence
            .record(TerminationEvidenceRecord::new(
                observed_at,
                TerminationComponent::Application,
                TerminationCategory::ForcedTerminationBoundary,
                SafeTerminationErrorCode::None,
                RecoveryResult::NotApplicable,
            ));
    }

    pub fn record_startup_recovery(&self, observed_at: u64, recovered: bool) {
        self.termination_evidence
            .record(TerminationEvidenceRecord::new(
                observed_at,
                TerminationComponent::Application,
                TerminationCategory::UnknownTermination,
                SafeTerminationErrorCode::None,
                if recovered {
                    RecoveryResult::Recovered
                } else {
                    RecoveryResult::NoRecoveryNeeded
                },
            ));
    }

    pub fn record_startup_failure(&self, observed_at: u64) {
        self.termination_evidence
            .record(TerminationEvidenceRecord::new(
                observed_at,
                TerminationComponent::Application,
                TerminationCategory::StartupFailure,
                SafeTerminationErrorCode::StartupRecoveryFailed,
                RecoveryResult::Failed,
            ));
    }

    pub fn start_managed_core_exit_observation(&self) {
        let runtime = self.runtime.clone();
        let evidence = self.termination_evidence.clone();
        tokio::spawn(async move {
            let mut previous = runtime.current().core_status().await.phase;
            let mut interval = tokio::time::interval(std::time::Duration::from_secs(1));
            loop {
                interval.tick().await;
                let status = runtime.current().core_status().await;
                if matches!(previous, CorePhase::Running)
                    && matches!(status.phase, CorePhase::Failed | CorePhase::Stopped)
                {
                    evidence.record(TerminationEvidenceRecord::new(
                        now_milliseconds(),
                        TerminationComponent::ManagedCore,
                        TerminationCategory::ManagedCoreExit,
                        SafeTerminationErrorCode::ManagedCoreUnavailable,
                        RecoveryResult::NotApplicable,
                    ));
                }
                previous = status.phase;
            }
        });
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
        let activation = self.activation.managed_state().await;
        let termination_evidence = self.termination_evidence.records();
        let updater = self.updater.diagnostic_snapshot();
        build_support_bundle(
            preview_id,
            SupportBundleInput {
                activation: &activation,
                application_version: self.application_version,
                core: &core,
                events: &events,
                generated_at,
                platform: &self.platform,
                status: &status,
                termination_evidence: &termination_evidence,
                updater: &updater,
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
    activation: SupportActivation,
    active_profile: Option<SupportActiveProfile>,
    application: SupportApplication,
    capabilities: SupportCapabilities,
    capture: SupportCapture,
    events: SupportEventsSummary,
    format_version: u32,
    generated_at: u64,
    platform: SupportPlatform,
    redaction_report: SupportRedactionReport,
    service_probes: SupportServiceProbes,
    termination_recovery_evidence: Vec<TerminationEvidenceRecord>,
    updater: UpdaterDiagnosticSnapshot,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportActivation {
    has_last_successful_profile: bool,
    last_failure: Option<ActivationFailureKind>,
    last_outcome: Option<ActivationOutcome>,
    safe_stopped: bool,
}

struct SupportBundleInput<'a> {
    activation: &'a ManagedActivationState,
    application_version: &'a str,
    core: &'a CoreStatus,
    events: &'a EventsSnapshot,
    generated_at: u64,
    platform: &'a SupportBundlePlatform,
    status: &'a StatusSnapshot,
    termination_evidence: &'a [TerminationEvidenceRecord],
    updater: &'a UpdaterDiagnosticSnapshot,
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

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportServiceProbes {
    address_policy_failures: usize,
    client_setup_failures: usize,
    dns_resolution_failures: usize,
    error: usize,
    healthy: usize,
    http_status_failures: usize,
    pending: usize,
    target_validation_failures: usize,
    transport_failures: usize,
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
    Activation,
    Platform,
    Capabilities,
    ActiveProfile,
    Capture,
    ServiceProbes,
    EventsSummary,
    RedactionReport,
    TerminationRecoveryEvidence,
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
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "kebab-case")]
enum RedactionTreatment {
    AggregatedOnly,
    ExcludedAtSource,
}

fn build_support_bundle(
    preview_id: String,
    input: SupportBundleInput<'_>,
) -> Result<PreparedSupportBundle, SupportBundleError> {
    let events = summarize_events(input.events);
    let active_profile = active_profile(input.activation, input.status);
    let time_range = events.time_range.clone();
    let manifest = SupportBundleManifest {
        activation: SupportActivation {
            has_last_successful_profile: input.activation.last_successful_profile_id().is_some(),
            last_failure: input
                .activation
                .last_attempt()
                .and_then(|attempt| attempt.failure()),
            last_outcome: input
                .activation
                .last_attempt()
                .map(|attempt| attempt.outcome()),
            safe_stopped: input.activation.is_safe_stopped(),
        },
        active_profile,
        application: application_summary(input.application_version, input.core),
        capabilities: SupportCapabilities {
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
        service_probes: summarize_service_probes(input.status),
        termination_recovery_evidence: input.termination_evidence.to_vec(),
        updater: input.updater.clone(),
    };
    let bytes =
        serde_json::to_vec_pretty(&manifest).map_err(|_| SupportBundleError::Serialization)?;
    if bytes.len() > SUPPORT_BUNDLE_MAX_BYTES {
        return Err(SupportBundleError::SizeLimitExceeded);
    }
    let preview = SupportBundlePreview {
        categories: vec![
            preview_category(SupportBundleCategory::Application, 1),
            preview_category(SupportBundleCategory::Activation, 1),
            preview_category(SupportBundleCategory::Platform, 1),
            preview_category(SupportBundleCategory::Capabilities, 1),
            preview_category(
                SupportBundleCategory::ActiveProfile,
                usize::from(manifest.active_profile.is_some()),
            ),
            preview_category(SupportBundleCategory::Capture, 1),
            preview_category(
                SupportBundleCategory::ServiceProbes,
                input.status.probe_results.len(),
            ),
            preview_category(
                SupportBundleCategory::EventsSummary,
                manifest.events.included_count,
            ),
            preview_category(
                SupportBundleCategory::RedactionReport,
                manifest.redaction_report.categories.len(),
            ),
            preview_category(
                SupportBundleCategory::TerminationRecoveryEvidence,
                manifest.termination_recovery_evidence.len(),
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

fn summarize_service_probes(status: &StatusSnapshot) -> SupportServiceProbes {
    let mut summary = SupportServiceProbes::default();
    for result in &status.probe_results {
        match result.status {
            ProbeStatus::Healthy => summary.healthy += 1,
            ProbeStatus::Pending => summary.pending += 1,
            ProbeStatus::Error => summary.error += 1,
        }
        match result.failure_stage {
            Some(ServiceProbeFailureStage::AddressPolicy) => summary.address_policy_failures += 1,
            Some(ServiceProbeFailureStage::ClientSetup) => summary.client_setup_failures += 1,
            Some(ServiceProbeFailureStage::DnsResolution) => summary.dns_resolution_failures += 1,
            Some(ServiceProbeFailureStage::HttpStatus) => summary.http_status_failures += 1,
            Some(ServiceProbeFailureStage::TargetValidation) => {
                summary.target_validation_failures += 1
            }
            Some(ServiceProbeFailureStage::Transport) => summary.transport_failures += 1,
            None => {}
        }
    }
    summary
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
    ]
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
        CorePhase, EventLevel, EventRecord, EventSource, EventsSnapshot, ProbeStatus,
        RecentTrafficPhase, RecentTrafficSample, ServiceProbeFailureStage, ServiceProbeResult,
        StatusAdapterKind, StatusSnapshot,
    };

    use super::{
        SUPPORT_BUNDLE_EVENT_LIMIT, SUPPORT_BUNDLE_MAX_BYTES, SupportBundleInput,
        SupportBundlePlatform, TERMINATION_EVIDENCE_MAX_AGE_MILLISECONDS,
        TERMINATION_EVIDENCE_MAX_RECORDS, TerminationCategory, TerminationComponent,
        TerminationEvidenceRecord, TerminationEvidenceStore, build_support_bundle,
    };
    use crate::ManagedActivationState;
    use mish_updater::{UpdatePhase, UpdaterDiagnosticSnapshot};

    #[test]
    fn manifest_is_deterministic_and_excludes_sensitive_categories_at_the_source() {
        let core = core_status();
        let mut status = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        status.recent_traffic.authority_id = "private-recent-authority".into();
        status.recent_traffic.revision = 7;
        status.recent_traffic.phase = RecentTrafficPhase::Active;
        status.recent_traffic.session_id = Some("private-recent-session".into());
        status.recent_traffic.profile_id = Some(status.active_profile_id.clone());
        status.recent_traffic.downloaded_bytes = 123_456;
        status.recent_traffic.download_bytes_per_second = 321;
        status.recent_traffic.samples = vec![RecentTrafficSample {
            sequence: 1,
            offset_milliseconds: 1_000,
            download_bytes_per_second: 321,
            upload_bytes_per_second: 123,
        }];
        let events = malicious_events(2);
        let activation = ManagedActivationState::default();
        let platform = platform();
        let updater = updater();
        let input = || SupportBundleInput {
            activation: &activation,
            application_version: "0.1.0",
            core: &core,
            events: &events,
            generated_at: 1_721_286_400_000,
            platform: &platform,
            status: &status,
            termination_evidence: &[],
            updater: &updater,
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
            "Controller payload",
            "Status bar label",
            "private-recent-authority",
            "private-recent-session",
            "recentTraffic",
        ] {
            assert!(!exported.contains(forbidden), "leaked {forbidden}");
        }
        assert!(exported.contains("raw-profile-configuration"));
        assert!(exported.contains("event-text"));
        assert!(exported.contains("\"formatVersion\": 3"));
        assert_eq!(first.preview.format_version, 3);
        assert!(first.preview.content_bytes < SUPPORT_BUNDLE_MAX_BYTES);
    }

    #[test]
    fn termination_evidence_is_bounded_private_and_honest_about_unknown_termination() {
        let root = tempfile::tempdir().unwrap();
        let store =
            TerminationEvidenceStore::new(root.path().join("evidence"), "0.1.0", platform());
        assert!(!store.begin_session(1));
        let reopened =
            TerminationEvidenceStore::new(root.path().join("evidence"), "0.1.0", platform());
        assert!(reopened.begin_session(2));
        assert_eq!(
            reopened.records()[0].category,
            TerminationCategory::UnknownTermination
        );
        reopened.clear_session();
        assert!(
            !TerminationEvidenceStore::new(root.path().join("evidence"), "0.1.0", platform())
                .begin_session(3)
        );

        for index in 0..(TERMINATION_EVIDENCE_MAX_RECORDS + 8) {
            reopened.record(TerminationEvidenceRecord::new(
                10 + index as u64,
                TerminationComponent::ManagedCore,
                TerminationCategory::ManagedCoreExit,
                super::SafeTerminationErrorCode::ManagedCoreUnavailable,
                super::RecoveryResult::NotApplicable,
            ));
        }
        assert_eq!(reopened.records().len(), TERMINATION_EVIDENCE_MAX_RECORDS);
        reopened.record(TerminationEvidenceRecord::new(
            10 + TERMINATION_EVIDENCE_MAX_AGE_MILLISECONDS + 100,
            TerminationComponent::Application,
            TerminationCategory::StartupFailure,
            super::SafeTerminationErrorCode::StartupRecoveryFailed,
            super::RecoveryResult::Failed,
        ));
        assert_eq!(reopened.records().len(), 1);
        std::fs::write(
            root.path().join("evidence/termination-evidence.json"),
            b"{bad",
        )
        .unwrap();
        assert!(reopened.records().is_empty());
    }

    #[test]
    fn manifest_enforces_event_and_size_bounds() {
        let core = core_status();
        let status = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        let events = malicious_events(SUPPORT_BUNDLE_EVENT_LIMIT + 40);
        let activation = ManagedActivationState::default();
        let platform = platform();
        let updater = updater();
        let bundle = build_support_bundle(
            "preview-2".into(),
            SupportBundleInput {
                activation: &activation,
                application_version: "0.1.0",
                core: &core,
                events: &events,
                generated_at: 1,
                platform: &platform,
                status: &status,
                termination_evidence: &[],
                updater: &updater,
            },
        )
        .unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&bundle.bytes).unwrap();
        assert_eq!(
            manifest["events"]["includedCount"],
            SUPPORT_BUNDLE_EVENT_LIMIT
        );
        assert_eq!(manifest["events"]["truncatedCount"], 40);
        assert!(manifest.get("diagnostics").is_none());
        assert!(bundle.preview.content_bytes <= bundle.preview.max_bytes);
    }

    #[test]
    fn building_a_manifest_does_not_mutate_source_history() {
        let core = core_status();
        let status = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        let events = malicious_events(3);
        let activation = ManagedActivationState::default();
        let platform = platform();
        let updater = updater();
        let before_events = serde_json::to_vec(&events).unwrap();
        build_support_bundle(
            "preview-3".into(),
            SupportBundleInput {
                activation: &activation,
                application_version: "0.1.0",
                core: &core,
                events: &events,
                generated_at: 1,
                platform: &platform,
                status: &status,
                termination_evidence: &[],
                updater: &updater,
            },
        )
        .unwrap();
        assert_eq!(serde_json::to_vec(&events).unwrap(), before_events);
    }

    #[test]
    fn manifest_aggregates_direct_probe_failure_stages_without_targets() {
        let core = core_status();
        let mut status = StatusSnapshot::lifecycle_only(&core, StatusAdapterKind::Rpc);
        status.probe_results = vec![ServiceProbeResult {
            failure_stage: Some(ServiceProbeFailureStage::DnsResolution),
            latency_milliseconds: None,
            monitor_id: "private-monitor-id".into(),
            observed_at: "2026-07-24T12:00:00Z".into(),
            route_target: "direct".into(),
            status: ProbeStatus::Error,
        }];
        let events = malicious_events(0);
        let activation = ManagedActivationState::default();
        let platform = platform();
        let updater = updater();

        let bundle = build_support_bundle(
            "preview-probes".into(),
            SupportBundleInput {
                activation: &activation,
                application_version: "0.1.0",
                core: &core,
                events: &events,
                generated_at: 1,
                platform: &platform,
                status: &status,
                termination_evidence: &[],
                updater: &updater,
            },
        )
        .unwrap();
        let manifest: serde_json::Value = serde_json::from_slice(&bundle.bytes).unwrap();
        let preview = serde_json::to_value(&bundle.preview).unwrap();

        assert_eq!(manifest["serviceProbes"]["error"], 1);
        assert_eq!(manifest["serviceProbes"]["dnsResolutionFailures"], 1);
        assert!(
            preview["categories"]
                .as_array()
                .unwrap()
                .iter()
                .any(|category| category
                    == &serde_json::json!({
                        "category": "activation",
                        "itemCount": 1,
                    }))
        );
        assert!(
            preview["categories"]
                .as_array()
                .unwrap()
                .iter()
                .any(|category| category
                    == &serde_json::json!({
                        "category": "service-probes",
                        "itemCount": 1,
                    }))
        );
        assert!(
            !String::from_utf8(bundle.bytes)
                .unwrap()
                .contains("private-monitor-id")
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

    fn updater() -> UpdaterDiagnosticSnapshot {
        UpdaterDiagnosticSnapshot {
            configured: false,
            phase: UpdatePhase::Idle,
            revision: 0,
            operation_present: false,
            maintenance: None,
        }
    }

    fn malicious_events(count: usize) -> EventsSnapshot {
        let mut snapshot = EventsSnapshot::unavailable(StatusAdapterKind::Rpc);
        snapshot.events = (0..count)
            .map(|sequence| EventRecord {
                application: None,
                evidence: Some(mish_runtime::EventEvidence {
                    detail: Some("Controller payload token=secret-token-value Status bar label raw-profile-yaml /synthetic/private/process-bin".into()),
                    message: "Sensitive Node Label connected to connection-destination.invalid at 198.51.100.23 from raw-hostname.invalid /synthetic/private/profile.yaml and https://subscription.example.invalid/?token=secret-token-value".into(),
                }),
                id: format!("event-{sequence}"),
                level: EventLevel::Error,
                observed_at: 1_000 + sequence as u64,
                sequence: sequence as u64,
                source: EventSource::Core,
            })
            .collect();
        snapshot
    }
}
