use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex, Weak},
    time::Duration,
};

use futures_util::future::{BoxFuture, ready};
use mish_bridge::{
    ActivationTiming, DesktopRuntimeHost, ManagedListenerCheckPhase, ManagedListenerHost,
    ManagedListenerOwnership, ManagedMihomoResolver, ManagedRuntimePolicy, MihomoActivationError,
    MihomoActivationManager, ProfileActivationCoordinator, ReqwestHttpsSourceReader,
};
use mish_runtime::{
    CapabilityAvailability, CaptureConfirmationWindow, CaptureJournal, CaptureJournalStore,
    CapturePlatform, CaptureReconciler, CaptureTransitionError, CoreError, CoreLifecycleCommand,
    CoreLifecycleMutation, CorePhase, CoreRuntime, CoreStatus, LocalProxyOwnership,
    LoopbackProxyEndpoint, ManualProxyState, MishRuntime, NetworkServiceProxyState,
};
use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use thiserror::Error;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

mod internal_tun;

pub use internal_tun::{
    MaintenanceCompletionInjection, MaintenanceEngine, MaintenanceFault, MaintenanceFaultKind,
    MaintenanceHarnessError, MaintenanceObservation, MaintenanceScenario,
    MaintenanceScenarioRuntime, SyntheticMaintenanceInitial, SyntheticOwnership,
    SyntheticPackageVersion,
};

pub const TRANSCRIPT_SCHEMA_VERSION: u16 = 1;
pub const DEFAULT_TRANSCRIPT_LIMIT: usize = 96;
pub const MAX_TRANSCRIPT_LIMIT: usize = 128;
pub const TEST_AUTH_TOKEN: &str = "mish-simulated-host-auth-token";
pub const TEST_CONTROL_KEY: &str = "mish-simulated-host-control-key";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticAuthorityId {
    CaptureOne,
    CaptureTwo,
    InternalTunMaintenance,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticRuntimeId {
    RuntimeOne,
    RuntimeTwo,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ManagedEndpointOwner {
    Free,
    Foreign,
    Mish,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreparationPhase {
    Idle,
    Running,
    Cancelling,
    Finalizing,
    Complete,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SimulatedCorePhase {
    #[default]
    Stopped,
    Starting,
    Running,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EffectKind {
    CaptureApply,
    CaptureConfirmListener,
    CaptureObserve,
    CaptureWriteAutoDiscovery,
    CaptureWriteBypass,
    CaptureWriteHttp,
    CaptureWriteHttps,
    CaptureWritePac,
    CaptureWriteSocks,
    CleanupCandidate,
    CoreObserve,
    CoreOwnsListener,
    CoreStart,
    CoreStop,
    FinalizeOperation,
    JournalClear,
    JournalLoad,
    JournalSave,
    MaintenanceAuthorize,
    MaintenanceBackupArtifacts,
    MaintenanceCaptureReconcile,
    MaintenanceCommitEnrollment,
    MaintenanceCommitReceipt,
    MaintenanceCommitService,
    MaintenanceFinalizeUninstall,
    MaintenanceJournalPersist,
    MaintenanceObserve,
    MaintenanceRestore,
    MaintenanceSetTun,
    MaintenanceStageArtifacts,
    MaintenanceStartService,
    MaintenanceVerify,
    ManagedEndpointOwnershipCheckCommit,
    ManagedEndpointOwnershipCheckEarly,
    ProfilePreparation,
    ReapOwnedChild,
    ReconcileAuthority,
    RequestCancellation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum EffectResultKind {
    Applied,
    Authorized,
    Cancelled,
    Completed,
    FailedClosed,
    ForeignOwned,
    Free,
    InjectedFailure,
    MishOwned,
    Observed,
    Rejected,
    Restored,
    RolledBack,
    Started,
    Stopped,
    Verified,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum InjectedFailureKind {
    Observation,
    Operation,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InjectedFailure {
    /// Counts this effect only after the most recent occurrence of the prerequisite effect.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub after_effect: Option<EffectKind>,
    pub effect: EffectKind,
    pub kind: InjectedFailureKind,
    pub occurrence: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum ScheduledChange {
    ActiveService {
        at: u64,
        service: SyntheticService,
    },
    ManagedEndpointOwner {
        at: u64,
        owner: ManagedEndpointOwner,
    },
    CorePhase {
        at: u64,
        phase: SimulatedCorePhase,
    },
    ProxyState {
        at: u64,
        state: SyntheticProxyState,
    },
}

impl ScheduledChange {
    const fn at(self) -> u64 {
        match self {
            Self::ActiveService { at, .. }
            | Self::ManagedEndpointOwner { at, .. }
            | Self::CorePhase { at, .. }
            | Self::ProxyState { at, .. } => at,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticService {
    Primary,
    Secondary,
}

impl SyntheticService {
    const fn id(self) -> &'static str {
        match self {
            Self::Primary => SYNTHETIC_SERVICE_ID,
            Self::Secondary => "synthetic-secondary-service",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticProxyState {
    Authenticated,
    AutoDiscovery,
    DisabledPopulated,
    #[default]
    Disabled,
    Manual,
    Pac,
    UnsafeIncomplete,
}

impl SyntheticProxyState {
    fn materialize(self) -> NetworkServiceProxyState {
        let populated = |enabled: bool, authenticated: bool, suffix: &str, port| ManualProxyState {
            authenticated,
            enabled,
            host: format!("{suffix}.proxy.invalid"),
            port,
        };
        match self {
            Self::Disabled => disabled_proxy_state(),
            Self::Manual => NetworkServiceProxyState {
                auto_discovery_enabled: false,
                bypass_domains: vec!["internal.invalid".into(), "*.test".into()],
                http: populated(true, false, "http", 8_080),
                https: populated(true, false, "https", 8_443),
                pac_enabled: false,
                pac_url: "https://pac.invalid/manual.pac".into(),
                service_id: SYNTHETIC_SERVICE_ID.into(),
                socks: populated(true, false, "socks", 1_080),
            },
            Self::DisabledPopulated => NetworkServiceProxyState {
                auto_discovery_enabled: false,
                bypass_domains: vec!["internal.invalid".into(), "*.test".into()],
                http: populated(false, false, "http", 8_080),
                https: populated(false, false, "https", 8_443),
                pac_enabled: false,
                pac_url: "https://pac.invalid/disabled.pac".into(),
                service_id: SYNTHETIC_SERVICE_ID.into(),
                socks: populated(false, false, "socks", 1_080),
            },
            Self::Pac => NetworkServiceProxyState {
                pac_enabled: true,
                pac_url: "https://pac.invalid/config.pac".into(),
                bypass_domains: vec!["internal.invalid".into()],
                ..disabled_proxy_state()
            },
            Self::AutoDiscovery => NetworkServiceProxyState {
                auto_discovery_enabled: true,
                bypass_domains: vec!["*.test".into()],
                ..disabled_proxy_state()
            },
            Self::Authenticated => NetworkServiceProxyState {
                http: populated(true, true, "authenticated", 8_080),
                ..disabled_proxy_state()
            },
            Self::UnsafeIncomplete => NetworkServiceProxyState {
                https: ManualProxyState {
                    authenticated: false,
                    enabled: true,
                    host: String::new(),
                    port: 0,
                },
                ..disabled_proxy_state()
            },
        }
    }
}

const SYNTHETIC_SERVICE_ID: &str = "synthetic-primary-service";

const fn default_cleanup_completes_at() -> u64 {
    20
}

const fn default_second_check_at() -> u64 {
    10
}

const fn default_transcript_limit() -> usize {
    DEFAULT_TRANSCRIPT_LIMIT
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SimulatedHostScenario {
    #[serde(default = "default_cleanup_completes_at")]
    pub cleanup_completes_at: u64,
    #[serde(default)]
    pub declared_effects: Vec<EffectKind>,
    #[serde(default)]
    pub failures: Vec<InjectedFailure>,
    #[serde(default)]
    pub initial_core_phase: SimulatedCorePhase,
    pub initial_endpoint_owner: ManagedEndpointOwner,
    #[serde(default)]
    pub initial_proxy_state: SyntheticProxyState,
    #[serde(default)]
    pub propagation_delay: u64,
    #[serde(default)]
    pub scheduled_changes: Vec<ScheduledChange>,
    #[serde(default = "default_second_check_at")]
    pub second_check_at: u64,
    #[serde(default = "default_transcript_limit")]
    pub transcript_limit: usize,
}

impl SimulatedHostScenario {
    pub fn initial_foreign_listener() -> Self {
        Self {
            cleanup_completes_at: 20,
            declared_effects: initial_conflict_effect_contract(),
            failures: Vec::new(),
            initial_core_phase: SimulatedCorePhase::Stopped,
            initial_endpoint_owner: ManagedEndpointOwner::Foreign,
            initial_proxy_state: SyntheticProxyState::Disabled,
            propagation_delay: 0,
            scheduled_changes: Vec::new(),
            second_check_at: 10,
            transcript_limit: DEFAULT_TRANSCRIPT_LIMIT,
        }
    }

    pub fn ownership_changes_before_commit() -> Self {
        Self {
            cleanup_completes_at: 20,
            declared_effects: commit_conflict_effect_contract(),
            failures: Vec::new(),
            initial_core_phase: SimulatedCorePhase::Stopped,
            initial_endpoint_owner: ManagedEndpointOwner::Free,
            initial_proxy_state: SyntheticProxyState::Disabled,
            propagation_delay: 0,
            scheduled_changes: vec![ScheduledChange::ManagedEndpointOwner {
                at: 5,
                owner: ManagedEndpointOwner::Foreign,
            }],
            second_check_at: 10,
            transcript_limit: DEFAULT_TRANSCRIPT_LIMIT,
        }
    }

    pub fn system_proxy_transaction(initial_proxy_state: SyntheticProxyState) -> Self {
        Self {
            cleanup_completes_at: 20,
            declared_effects: system_proxy_effect_contract(),
            failures: Vec::new(),
            initial_core_phase: SimulatedCorePhase::Running,
            initial_endpoint_owner: ManagedEndpointOwner::Mish,
            initial_proxy_state,
            propagation_delay: 0,
            scheduled_changes: Vec::new(),
            second_check_at: 10,
            transcript_limit: DEFAULT_TRANSCRIPT_LIMIT,
        }
    }

    /// Closed Internal TUN maintenance input. The package, Helper/Core, Capture, and
    /// application adapters all observe one synthetic host model; this is not a fixture
    /// for a privileged host command sequence.
    pub fn internal_tun_maintenance() -> Self {
        let mut declared_effects = system_proxy_effect_contract();
        // The authenticated application command path uses the same profile-preparation and
        // listener-ownership effects as the desktop activation coordinator.
        declared_effects.extend(initial_conflict_effect_contract());
        declared_effects.extend(maintenance_effect_contract());
        declared_effects.sort_by_key(|effect| *effect as u8);
        declared_effects.dedup();
        Self {
            cleanup_completes_at: 20,
            declared_effects,
            failures: Vec::new(),
            initial_core_phase: SimulatedCorePhase::Running,
            initial_endpoint_owner: ManagedEndpointOwner::Mish,
            initial_proxy_state: SyntheticProxyState::Disabled,
            propagation_delay: 0,
            scheduled_changes: Vec::new(),
            second_check_at: 10,
            transcript_limit: MAX_TRANSCRIPT_LIMIT,
        }
    }

    pub fn browser_journey() -> Self {
        let mut scenario = Self::initial_foreign_listener();
        scenario
            .declared_effects
            .extend(system_proxy_effect_contract());
        scenario
            .declared_effects
            .sort_by_key(|effect| *effect as u8);
        scenario.declared_effects.dedup();
        scenario.propagation_delay = 5;
        scenario.scheduled_changes = vec![
            ScheduledChange::ManagedEndpointOwner {
                at: 21,
                owner: ManagedEndpointOwner::Mish,
            },
            ScheduledChange::CorePhase {
                at: 21,
                phase: SimulatedCorePhase::Running,
            },
            ScheduledChange::ProxyState {
                at: 40,
                state: SyntheticProxyState::Manual,
            },
        ];
        scenario
    }

    fn validate(&self) -> Result<(), SimulatedHostFailure> {
        if self.transcript_limit == 0 || self.transcript_limit > MAX_TRANSCRIPT_LIMIT {
            return Err(SimulatedHostFailure::InvalidScenario);
        }
        if self.second_check_at > self.cleanup_completes_at {
            return Err(SimulatedHostFailure::InvalidScenario);
        }
        if self.failures.len() > 16
            || self.declared_effects.len() > 64
            || self.scheduled_changes.len() > 32
            || self.failures.iter().any(|failure| failure.occurrence == 0)
        {
            return Err(SimulatedHostFailure::InvalidScenario);
        }
        if self
            .scheduled_changes
            .windows(2)
            .any(|window| window[0].at() > window[1].at())
        {
            return Err(SimulatedHostFailure::InvalidScenario);
        }
        Ok(())
    }
}

fn initial_conflict_effect_contract() -> Vec<EffectKind> {
    vec![
        EffectKind::CaptureObserve,
        EffectKind::CleanupCandidate,
        EffectKind::CoreObserve,
        EffectKind::CoreStop,
        EffectKind::FinalizeOperation,
        EffectKind::JournalLoad,
        EffectKind::ManagedEndpointOwnershipCheckEarly,
        EffectKind::ProfilePreparation,
        EffectKind::ReapOwnedChild,
        EffectKind::ReconcileAuthority,
        EffectKind::RequestCancellation,
    ]
}

fn commit_conflict_effect_contract() -> Vec<EffectKind> {
    let mut effects = initial_conflict_effect_contract();
    effects.push(EffectKind::ManagedEndpointOwnershipCheckCommit);
    effects
}

fn system_proxy_effect_contract() -> Vec<EffectKind> {
    vec![
        EffectKind::CaptureApply,
        EffectKind::CaptureConfirmListener,
        EffectKind::CaptureObserve,
        EffectKind::CaptureWriteAutoDiscovery,
        EffectKind::CaptureWriteBypass,
        EffectKind::CaptureWriteHttp,
        EffectKind::CaptureWriteHttps,
        EffectKind::CaptureWritePac,
        EffectKind::CaptureWriteSocks,
        EffectKind::CoreObserve,
        EffectKind::CoreStop,
        EffectKind::JournalClear,
        EffectKind::JournalLoad,
        EffectKind::JournalSave,
    ]
}

fn maintenance_effect_contract() -> Vec<EffectKind> {
    vec![
        EffectKind::CaptureObserve,
        EffectKind::CaptureWriteAutoDiscovery,
        EffectKind::CaptureWriteBypass,
        EffectKind::CaptureWriteHttp,
        EffectKind::CaptureWriteHttps,
        EffectKind::CaptureWritePac,
        EffectKind::CaptureWriteSocks,
        EffectKind::CoreObserve,
        EffectKind::CoreStart,
        EffectKind::CoreStop,
        EffectKind::MaintenanceAuthorize,
        EffectKind::MaintenanceBackupArtifacts,
        EffectKind::MaintenanceCaptureReconcile,
        EffectKind::MaintenanceCommitEnrollment,
        EffectKind::MaintenanceCommitReceipt,
        EffectKind::MaintenanceCommitService,
        EffectKind::MaintenanceFinalizeUninstall,
        EffectKind::MaintenanceJournalPersist,
        EffectKind::MaintenanceObserve,
        EffectKind::MaintenanceRestore,
        EffectKind::MaintenanceSetTun,
        EffectKind::MaintenanceStageArtifacts,
        EffectKind::MaintenanceStartService,
        EffectKind::MaintenanceVerify,
    ]
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TranscriptEvent {
    pub admitted_revision: u64,
    pub authority_id: SyntheticAuthorityId,
    pub effect_id: u64,
    pub effect_kind: EffectKind,
    pub logical_time: u64,
    pub operation_id: Option<u64>,
    pub result_kind: EffectResultKind,
    pub runtime_id: SyntheticRuntimeId,
    pub scope_epoch: u64,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SemanticTranscript {
    pub events: Vec<TranscriptEvent>,
    pub schema_version: u16,
}

impl<'de> Deserialize<'de> for SemanticTranscript {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct WireTranscript {
            events: Vec<TranscriptEvent>,
            schema_version: u16,
        }

        let transcript = WireTranscript::deserialize(deserializer)?;
        if transcript.schema_version != TRANSCRIPT_SCHEMA_VERSION {
            return Err(serde::de::Error::custom(
                "unsupported semantic transcript schema",
            ));
        }
        if transcript.events.len() > MAX_TRANSCRIPT_LIMIT {
            return Err(serde::de::Error::custom(
                "semantic transcript exceeds its event bound",
            ));
        }
        Ok(Self {
            events: transcript.events,
            schema_version: transcript.schema_version,
        })
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScenarioObservation {
    pub core_phase: SimulatedCorePhase,
    pub endpoint_owner: ManagedEndpointOwner,
    pub journal_present: bool,
    pub logical_time: u64,
    pub maintenance: Option<MaintenanceObservation>,
    pub pending_proxy_propagation: bool,
    pub preparation_phase: PreparationPhase,
    pub proxy_actual_revision: u64,
    pub proxy_observed_revision: u64,
    pub transcript: SemanticTranscript,
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum SimulatedHostFailure {
    #[error("the scenario is invalid")]
    InvalidScenario,
    #[error("logical time cannot move backwards")]
    LogicalTimeRegression,
    #[error("the injected effect failed")]
    InjectedFailure(EffectKind, InjectedFailureKind),
    #[error("the transcript bound was exceeded")]
    TranscriptOverflow,
    #[error("the scenario did not declare this effect")]
    UndeclaredEffect(EffectKind),
}

struct PendingProxyObservation {
    state: NetworkServiceProxyState,
    visible_at: u64,
    stale_observation_returned: bool,
}

type EffectCorrelation = (
    SyntheticAuthorityId,
    u64,
    Option<u64>,
    u64,
    SyntheticRuntimeId,
);

struct Model {
    active_runtime: Option<MishRuntime>,
    authority_scopes: Vec<u64>,
    core_phase: SimulatedCorePhase,
    endpoint_owner: ManagedEndpointOwner,
    effect_occurrences: HashMap<EffectKind, u8>,
    journal: Option<CaptureJournal>,
    logical_time: u64,
    maintenance: Option<internal_tun::MaintenanceModel>,
    pending_proxy_observation: Option<PendingProxyObservation>,
    preparation_phase: PreparationPhase,
    proxy_state: NetworkServiceProxyState,
    proxy_actual_revision: u64,
    proxy_observed_revision: u64,
    proxy_observation: NetworkServiceProxyState,
    scheduled_cursor: usize,
    runtime_id: SyntheticRuntimeId,
    transcript: VecDeque<TranscriptEvent>,
}

pub struct SimulatedHost {
    capture: Mutex<Option<Weak<CaptureReconciler>>>,
    clock_changed: Notify,
    declared_effects: HashSet<EffectKind>,
    failures: Vec<InjectedFailure>,
    maintenance_engine: Mutex<Option<Weak<internal_tun::MaintenanceEngine>>>,
    model: Mutex<Model>,
    preparation_task: Mutex<Option<(CancellationToken, tokio::task::JoinHandle<()>)>>,
    scenario: SimulatedHostScenario,
}

impl SimulatedHost {
    pub fn new(scenario: SimulatedHostScenario) -> Result<Self, SimulatedHostFailure> {
        scenario.validate()?;
        Ok(Self {
            capture: Mutex::new(None),
            clock_changed: Notify::new(),
            declared_effects: scenario.declared_effects.iter().copied().collect(),
            failures: scenario.failures.clone(),
            maintenance_engine: Mutex::new(None),
            model: Mutex::new(Model {
                active_runtime: None,
                authority_scopes: Vec::new(),
                core_phase: scenario.initial_core_phase,
                endpoint_owner: scenario.initial_endpoint_owner,
                effect_occurrences: HashMap::new(),
                journal: None,
                logical_time: 0,
                maintenance: None,
                pending_proxy_observation: None,
                preparation_phase: PreparationPhase::Idle,
                proxy_state: scenario.initial_proxy_state.materialize(),
                proxy_actual_revision: 0,
                proxy_observed_revision: 0,
                proxy_observation: scenario.initial_proxy_state.materialize(),
                scheduled_cursor: 0,
                runtime_id: SyntheticRuntimeId::RuntimeOne,
                transcript: VecDeque::new(),
            }),
            preparation_task: Mutex::new(None),
            scenario,
        })
    }

    pub fn attach_capture(&self, capture: &Arc<CaptureReconciler>) {
        *self
            .capture
            .lock()
            .expect("simulated capture lock poisoned") = Some(Arc::downgrade(capture));
    }

    pub fn attach_runtime(&self, runtime: MishRuntime) {
        let mut model = self.model.lock().expect("simulated host lock poisoned");
        if model
            .active_runtime
            .as_ref()
            .is_some_and(|active| !active.is_same_instance(&runtime))
        {
            model.runtime_id = SyntheticRuntimeId::RuntimeTwo;
        }
        model.active_runtime = Some(runtime);
    }

    pub(crate) fn attach_maintenance_engine(&self, engine: &Arc<internal_tun::MaintenanceEngine>) {
        *self
            .maintenance_engine
            .lock()
            .expect("simulated maintenance engine lock poisoned") = Some(Arc::downgrade(engine));
    }

    pub(crate) fn maintenance_engine(&self) -> Option<Arc<internal_tun::MaintenanceEngine>> {
        self.maintenance_engine
            .lock()
            .expect("simulated maintenance engine lock poisoned")
            .as_ref()
            .and_then(Weak::upgrade)
    }

    pub fn maintenance_observation(&self) -> Option<MaintenanceObservation> {
        self.model
            .lock()
            .expect("simulated host lock poisoned")
            .maintenance
            .as_ref()
            .map(internal_tun::MaintenanceModel::observation)
    }

    pub(crate) fn emit_maintenance(
        &self,
        effect_kind: EffectKind,
        result_kind: EffectResultKind,
        operation_id: u64,
        admitted_revision: u64,
    ) -> Result<(), SimulatedHostFailure> {
        let runtime_id = self
            .model
            .lock()
            .expect("simulated host lock poisoned")
            .runtime_id;
        self.emit_with_correlation(
            effect_kind,
            result_kind,
            Some((
                SyntheticAuthorityId::InternalTunMaintenance,
                1,
                Some(operation_id),
                admitted_revision,
                runtime_id,
            )),
        )
    }

    fn detach_process(&self) {
        let mut model = self.model.lock().expect("simulated host lock poisoned");
        *self
            .capture
            .lock()
            .expect("simulated capture lock poisoned") = None;
        if model.active_runtime.take().is_some() {
            model.runtime_id = SyntheticRuntimeId::RuntimeTwo;
        }
    }

    pub fn advance_to(&self, logical_time: u64) -> Result<(), SimulatedHostFailure> {
        let mut model = self.model.lock().expect("simulated host lock poisoned");
        if logical_time < model.logical_time {
            return Err(SimulatedHostFailure::LogicalTimeRegression);
        }
        model.logical_time = logical_time;
        while let Some(change) = self
            .scenario
            .scheduled_changes
            .get(model.scheduled_cursor)
            .copied()
        {
            if change.at() > logical_time {
                break;
            }
            match change {
                ScheduledChange::ActiveService { service, .. } => {
                    model.proxy_state.service_id = service.id().into();
                    model.proxy_observation.service_id = service.id().into();
                    model.proxy_actual_revision = model.proxy_actual_revision.saturating_add(1);
                    model.proxy_observed_revision = model.proxy_actual_revision;
                    model.pending_proxy_observation = None;
                }
                ScheduledChange::ManagedEndpointOwner { owner, .. } => {
                    model.endpoint_owner = owner;
                }
                ScheduledChange::CorePhase { phase, .. } => {
                    model.core_phase = phase;
                }
                ScheduledChange::ProxyState { state, .. } => {
                    let state = state.materialize();
                    model.proxy_state = state.clone();
                    model.proxy_observation = state;
                    model.proxy_actual_revision = model.proxy_actual_revision.saturating_add(1);
                    model.proxy_observed_revision = model.proxy_actual_revision;
                    model.pending_proxy_observation = None;
                }
            }
            model.scheduled_cursor += 1;
        }
        if model
            .pending_proxy_observation
            .as_ref()
            .is_some_and(|pending| pending.visible_at <= logical_time)
        {
            let pending = model
                .pending_proxy_observation
                .take()
                .expect("checked pending proxy observation");
            model.proxy_observation = pending.state;
            model.proxy_observed_revision = model.proxy_actual_revision;
        }
        drop(model);
        self.clock_changed.notify_waiters();
        Ok(())
    }

    pub fn observation(&self) -> ScenarioObservation {
        let model = self.model.lock().expect("simulated host lock poisoned");
        ScenarioObservation {
            core_phase: model.core_phase,
            endpoint_owner: model.endpoint_owner,
            journal_present: model.journal.is_some(),
            logical_time: model.logical_time,
            maintenance: model
                .maintenance
                .as_ref()
                .map(internal_tun::MaintenanceModel::observation),
            pending_proxy_propagation: model.pending_proxy_observation.is_some(),
            preparation_phase: model.preparation_phase,
            proxy_actual_revision: model.proxy_actual_revision,
            proxy_observed_revision: model.proxy_observed_revision,
            transcript: SemanticTranscript {
                events: model.transcript.iter().copied().collect(),
                schema_version: TRANSCRIPT_SCHEMA_VERSION,
            },
        }
    }

    pub fn actual_proxy_state(&self) -> NetworkServiceProxyState {
        self.model
            .lock()
            .expect("simulated host lock poisoned")
            .proxy_state
            .clone()
    }

    pub fn observed_proxy_state(&self) -> NetworkServiceProxyState {
        self.model
            .lock()
            .expect("simulated host lock poisoned")
            .proxy_observation
            .clone()
    }

    pub fn journal_snapshot(&self) -> Option<CaptureJournal> {
        self.model
            .lock()
            .expect("simulated host lock poisoned")
            .journal
            .clone()
    }

    pub fn exercise_effect(&self, effect: EffectKind) -> Result<(), SimulatedHostFailure> {
        self.emit(effect, EffectResultKind::Completed)
    }

    async fn wait_until(&self, logical_time: u64) {
        loop {
            let changed = self.clock_changed.notified();
            if self
                .model
                .lock()
                .expect("simulated host lock poisoned")
                .logical_time
                >= logical_time
            {
                return;
            }
            changed.await;
        }
    }

    fn correlation(&self, model: &mut Model) -> EffectCorrelation {
        let capture = self
            .capture
            .lock()
            .expect("simulated capture lock poisoned")
            .as_ref()
            .and_then(Weak::upgrade);
        let correlation = capture.map(|capture| capture.correlation_snapshot());
        let operation_id = correlation
            .as_ref()
            .and_then(|correlation| correlation.operation_id.as_ref())
            .and_then(|operation| operation.parse::<u64>().ok());
        let machine_scope_epoch = correlation.as_ref().map_or(0, |value| value.scope_epoch);
        let admitted_revision = correlation
            .as_ref()
            .map_or(0, |value| value.admitted_revision);
        let authority_index = model
            .authority_scopes
            .iter()
            .position(|scope| *scope == machine_scope_epoch)
            .unwrap_or_else(|| {
                model.authority_scopes.push(machine_scope_epoch);
                model.authority_scopes.len() - 1
            });
        let authority_id = if authority_index == 0 {
            SyntheticAuthorityId::CaptureOne
        } else {
            SyntheticAuthorityId::CaptureTwo
        };
        (
            authority_id,
            (authority_index + 1) as u64,
            operation_id,
            admitted_revision,
            model.runtime_id,
        )
    }

    fn effect_correlation(&self) -> EffectCorrelation {
        let mut model = self.model.lock().expect("simulated host lock poisoned");
        self.correlation(&mut model)
    }

    fn emit(
        &self,
        effect_kind: EffectKind,
        result_kind: EffectResultKind,
    ) -> Result<(), SimulatedHostFailure> {
        self.emit_with_correlation(effect_kind, result_kind, None)
    }

    fn emit_with_correlation(
        &self,
        effect_kind: EffectKind,
        result_kind: EffectResultKind,
        correlation: Option<EffectCorrelation>,
    ) -> Result<(), SimulatedHostFailure> {
        let mut model = self.model.lock().expect("simulated host lock poisoned");
        let (authority_id, scope_epoch, operation_id, admitted_revision, runtime_id) =
            correlation.unwrap_or_else(|| self.correlation(&mut model));
        let occurrence = {
            let entry = model.effect_occurrences.entry(effect_kind).or_insert(0);
            *entry = entry.saturating_add(1);
            *entry
        };
        let effect_id = model
            .transcript
            .back()
            .map_or(1, |event| event.effect_id.saturating_add(1));
        let failure = if !self.declared_effects.contains(&effect_kind) {
            Some(SimulatedHostFailure::UndeclaredEffect(effect_kind))
        } else {
            self.failures
                .iter()
                .find(|failure| {
                    failure_matches(failure, effect_kind, occurrence, &model.transcript)
                })
                .map(|failure| SimulatedHostFailure::InjectedFailure(effect_kind, failure.kind))
        };
        if model.transcript.len() == self.scenario.transcript_limit {
            return Err(SimulatedHostFailure::TranscriptOverflow);
        }
        let logical_time = model.logical_time;
        model.transcript.push_back(TranscriptEvent {
            admitted_revision,
            authority_id,
            effect_id,
            effect_kind,
            logical_time,
            operation_id,
            result_kind: match failure {
                Some(SimulatedHostFailure::UndeclaredEffect(_)) => EffectResultKind::FailedClosed,
                Some(SimulatedHostFailure::InjectedFailure(_, _)) => {
                    EffectResultKind::InjectedFailure
                }
                _ => result_kind,
            },
            runtime_id,
            scope_epoch,
        });
        failure.map_or(Ok(()), Err)
    }

    fn endpoint_result(owner: ManagedEndpointOwner) -> EffectResultKind {
        match owner {
            ManagedEndpointOwner::Free => EffectResultKind::Free,
            ManagedEndpointOwner::Foreign => EffectResultKind::ForeignOwned,
            ManagedEndpointOwner::Mish => EffectResultKind::MishOwned,
        }
    }

    fn endpoint_owner(&self) -> ManagedEndpointOwner {
        self.model
            .lock()
            .expect("simulated host lock poisoned")
            .endpoint_owner
    }

    fn set_preparation_phase(&self, phase: PreparationPhase) {
        self.model
            .lock()
            .expect("simulated host lock poisoned")
            .preparation_phase = phase;
    }

    async fn observe_proxy_state(
        &self,
    ) -> Result<NetworkServiceProxyState, CaptureTransitionError> {
        // Freeze the initiating machine identity before propagation can outlive a Runtime.
        let correlation = self.effect_correlation();
        loop {
            let changed = self.clock_changed.notified();
            let state = {
                let mut model = self.model.lock().expect("simulated host lock poisoned");
                if model
                    .pending_proxy_observation
                    .as_ref()
                    .is_some_and(|pending| pending.visible_at <= model.logical_time)
                {
                    let pending = model
                        .pending_proxy_observation
                        .take()
                        .expect("checked pending proxy observation");
                    model.proxy_observation = pending.state;
                    model.proxy_observed_revision = model.proxy_actual_revision;
                }
                match model.pending_proxy_observation.as_mut() {
                    Some(pending) if pending.stale_observation_returned => None,
                    Some(pending) => {
                        pending.stale_observation_returned = true;
                        Some(model.proxy_observation.clone())
                    }
                    None => Some(model.proxy_observation.clone()),
                }
            };
            if let Some(state) = state {
                self.emit_with_correlation(
                    EffectKind::CaptureObserve,
                    EffectResultKind::Observed,
                    Some(correlation),
                )
                .map_err(Self::capture_error)?;
                return Ok(state);
            }
            changed.await;
        }
    }

    fn expose_partial_proxy_write(&self) {
        let mut model = self.model.lock().expect("simulated host lock poisoned");
        model.proxy_observation = model.proxy_state.clone();
        model.proxy_observed_revision = model.proxy_actual_revision;
        model.pending_proxy_observation = None;
    }

    async fn finalize_model_preparation(&self) -> Result<(), SimulatedHostFailure> {
        self.set_preparation_phase(PreparationPhase::Cancelling);
        let mut first_failure = self
            .emit(EffectKind::RequestCancellation, EffectResultKind::Cancelled)
            .err();
        let preparation = self
            .preparation_task
            .lock()
            .expect("simulated preparation task lock poisoned")
            .take();
        if let Some((cancellation, task)) = preparation {
            cancellation.cancel();
            if task.await.is_err() && first_failure.is_none() {
                first_failure = Some(SimulatedHostFailure::InvalidScenario);
            }
        } else if first_failure.is_none() {
            first_failure = Some(SimulatedHostFailure::InvalidScenario);
        }
        self.set_preparation_phase(PreparationPhase::Finalizing);
        self.wait_until(self.scenario.cleanup_completes_at).await;
        for effect in [
            EffectKind::ReapOwnedChild,
            EffectKind::CleanupCandidate,
            EffectKind::ReconcileAuthority,
            EffectKind::FinalizeOperation,
        ] {
            if let Err(error) = self.emit(effect, EffectResultKind::Completed)
                && first_failure.is_none()
            {
                first_failure = Some(error);
            }
        }
        let mut model = self.model.lock().expect("simulated host lock poisoned");
        model.core_phase = SimulatedCorePhase::Stopped;
        model.preparation_phase = PreparationPhase::Complete;
        drop(model);
        first_failure.map_or(Ok(()), Err)
    }

    fn capture_error(error: SimulatedHostFailure) -> CaptureTransitionError {
        let kind = match error {
            SimulatedHostFailure::InjectedFailure(_, InjectedFailureKind::Observation) => {
                mish_runtime::CaptureFailureKind::ObservationFailed
            }
            SimulatedHostFailure::InjectedFailure(_, InjectedFailureKind::Operation)
            | SimulatedHostFailure::TranscriptOverflow
            | SimulatedHostFailure::UndeclaredEffect(_)
            | SimulatedHostFailure::InvalidScenario
            | SimulatedHostFailure::LogicalTimeRegression => {
                mish_runtime::CaptureFailureKind::ApplyFailed
            }
        };
        CaptureTransitionError::new(kind, "The simulated host rejected an undeclared effect")
    }
}

fn failure_matches(
    failure: &InjectedFailure,
    effect_kind: EffectKind,
    occurrence: u8,
    transcript: &VecDeque<TranscriptEvent>,
) -> bool {
    if failure.effect != effect_kind {
        return false;
    }
    let scoped_occurrence = if let Some(after_effect) = failure.after_effect {
        let Some(after_index) = transcript
            .iter()
            .rposition(|event| event.effect_kind == after_effect)
        else {
            return false;
        };
        transcript
            .iter()
            .skip(after_index.saturating_add(1))
            .filter(|event| event.effect_kind == effect_kind)
            .count()
            .saturating_add(1)
    } else {
        usize::from(occurrence)
    };
    usize::from(failure.occurrence) == scoped_occurrence
}

impl ManagedListenerHost for SimulatedHost {
    fn begin_preparation(&self) -> Result<(), MihomoActivationError> {
        self.emit(EffectKind::ProfilePreparation, EffectResultKind::Started)
            .map_err(|_| MihomoActivationError::StateCommitFailed)?;
        self.set_preparation_phase(PreparationPhase::Running);
        self.model
            .lock()
            .expect("simulated host lock poisoned")
            .core_phase = SimulatedCorePhase::Starting;
        let cancellation = CancellationToken::new();
        let child_cancellation = cancellation.clone();
        let task = tokio::spawn(async move {
            child_cancellation.cancelled().await;
        });
        let mut slot = self
            .preparation_task
            .lock()
            .expect("simulated preparation task lock poisoned");
        if slot.is_some() {
            cancellation.cancel();
            task.abort();
            return Err(MihomoActivationError::StateCommitFailed);
        }
        *slot = Some((cancellation, task));
        Ok(())
    }

    fn check<'a>(
        &'a self,
        phase: ManagedListenerCheckPhase,
        _endpoint: SocketAddr,
    ) -> BoxFuture<'a, Result<ManagedListenerOwnership, MihomoActivationError>> {
        Box::pin(async move {
            let effect = match phase {
                ManagedListenerCheckPhase::Early => EffectKind::ManagedEndpointOwnershipCheckEarly,
                ManagedListenerCheckPhase::Commit => {
                    self.wait_until(self.scenario.second_check_at).await;
                    EffectKind::ManagedEndpointOwnershipCheckCommit
                }
            };
            let owner = self.endpoint_owner();
            self.emit(effect, Self::endpoint_result(owner))
                .map_err(|_| MihomoActivationError::StateCommitFailed)?;
            Ok(match owner {
                ManagedEndpointOwner::Free => ManagedListenerOwnership::Free,
                ManagedEndpointOwner::Foreign => ManagedListenerOwnership::Foreign,
                ManagedEndpointOwner::Mish => ManagedListenerOwnership::Mish,
            })
        })
    }

    fn finalize_failed_preparation(&self) -> BoxFuture<'_, Result<(), MihomoActivationError>> {
        Box::pin(async move {
            self.finalize_model_preparation()
                .await
                .map_err(|_| MihomoActivationError::StateCommitFailed)
        })
    }
}

impl CapturePlatform for SimulatedHost {
    fn availability(&self) -> CapabilityAvailability {
        CapabilityAvailability::Supported
    }

    fn preflight_observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        self.observe_active()
    }

    fn observe_active(
        &self,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        Box::pin(self.observe_proxy_state())
    }

    fn observe_service(
        &self,
        _service_id: &str,
    ) -> BoxFuture<'_, Result<NetworkServiceProxyState, CaptureTransitionError>> {
        self.observe_active()
    }

    fn apply_service(
        &self,
        target: NetworkServiceProxyState,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        Box::pin(async move {
            self.emit(EffectKind::CaptureApply, EffectResultKind::Applied)
                .map_err(Self::capture_error)?;
            let writes = [
                EffectKind::CaptureWriteAutoDiscovery,
                EffectKind::CaptureWritePac,
                EffectKind::CaptureWriteHttp,
                EffectKind::CaptureWriteHttps,
                EffectKind::CaptureWriteSocks,
                EffectKind::CaptureWriteBypass,
            ];
            for effect in writes {
                {
                    let mut model = self.model.lock().expect("simulated host lock poisoned");
                    match effect {
                        EffectKind::CaptureWriteAutoDiscovery => {
                            model.proxy_state.auto_discovery_enabled =
                                target.auto_discovery_enabled;
                        }
                        EffectKind::CaptureWritePac => {
                            model.proxy_state.pac_enabled = target.pac_enabled;
                            model.proxy_state.pac_url.clone_from(&target.pac_url);
                        }
                        EffectKind::CaptureWriteHttp => {
                            model.proxy_state.http.clone_from(&target.http);
                        }
                        EffectKind::CaptureWriteHttps => {
                            model.proxy_state.https.clone_from(&target.https);
                        }
                        EffectKind::CaptureWriteSocks => {
                            model.proxy_state.socks.clone_from(&target.socks);
                        }
                        EffectKind::CaptureWriteBypass => {
                            model
                                .proxy_state
                                .bypass_domains
                                .clone_from(&target.bypass_domains);
                        }
                        _ => unreachable!("ordered proxy write vocabulary is closed"),
                    }
                    model.proxy_actual_revision = model.proxy_actual_revision.saturating_add(1);
                }
                if let Err(error) = self.emit(effect, EffectResultKind::Applied) {
                    self.expose_partial_proxy_write();
                    return Err(Self::capture_error(error));
                }
            }
            let mut model = self.model.lock().expect("simulated host lock poisoned");
            if self.scenario.propagation_delay == 0 {
                model.proxy_observation = model.proxy_state.clone();
                model.proxy_observed_revision = model.proxy_actual_revision;
                model.pending_proxy_observation = None;
            } else {
                model.pending_proxy_observation = Some(PendingProxyObservation {
                    state: model.proxy_state.clone(),
                    visible_at: model
                        .logical_time
                        .saturating_add(self.scenario.propagation_delay),
                    stale_observation_returned: false,
                });
            }
            Ok(())
        })
    }

    fn confirmation_window(&self) -> CaptureConfirmationWindow {
        if self.scenario.propagation_delay == 0 {
            CaptureConfirmationWindow::immediate()
        } else {
            CaptureConfirmationWindow::bounded(3, Duration::ZERO, Duration::ZERO)
        }
    }

    fn confirm_proxy_listener(
        &self,
        _endpoint: &LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, Result<(), CaptureTransitionError>> {
        Box::pin(ready(
            self.emit(
                EffectKind::CaptureConfirmListener,
                EffectResultKind::Observed,
            )
            .map_err(Self::capture_error),
        ))
    }
}

impl CaptureJournalStore for SimulatedHost {
    fn load(&self) -> Result<Option<CaptureJournal>, CaptureTransitionError> {
        self.emit(EffectKind::JournalLoad, EffectResultKind::Observed)
            .map_err(Self::capture_error)?;
        Ok(self
            .model
            .lock()
            .expect("simulated host lock poisoned")
            .journal
            .clone())
    }

    fn save(&self, journal: &CaptureJournal) -> Result<(), CaptureTransitionError> {
        self.emit(EffectKind::JournalSave, EffectResultKind::Applied)
            .map_err(Self::capture_error)?;
        self.model
            .lock()
            .expect("simulated host lock poisoned")
            .journal = Some(journal.clone());
        Ok(())
    }

    fn clear(&self) -> Result<(), CaptureTransitionError> {
        self.emit(EffectKind::JournalClear, EffectResultKind::Applied)
            .map_err(Self::capture_error)?;
        self.model
            .lock()
            .expect("simulated host lock poisoned")
            .journal = None;
        Ok(())
    }
}

impl CoreRuntime for SimulatedHost {
    fn configured(&self) -> bool {
        true
    }

    fn local_proxy_ownership(
        &self,
        _endpoint: &LoopbackProxyEndpoint,
    ) -> BoxFuture<'_, LocalProxyOwnership> {
        let owner = self.endpoint_owner();
        let result = self.emit(EffectKind::CoreOwnsListener, Self::endpoint_result(owner));
        Box::pin(ready(match (result, owner) {
            (Ok(()), ManagedEndpointOwner::Mish) => LocalProxyOwnership::Owned,
            (Ok(()), _) => LocalProxyOwnership::Unowned,
            (Err(_), _) => LocalProxyOwnership::Unknown,
        }))
    }

    fn status(&self) -> BoxFuture<'_, CoreStatus> {
        let emitted = self.emit(EffectKind::CoreObserve, EffectResultKind::Observed);
        let phase = if emitted.is_err() {
            CorePhase::Failed
        } else {
            match self
                .model
                .lock()
                .expect("simulated host lock poisoned")
                .core_phase
            {
                SimulatedCorePhase::Stopped => CorePhase::Stopped,
                SimulatedCorePhase::Starting => CorePhase::Starting,
                SimulatedCorePhase::Running => CorePhase::Running,
            }
        };
        Box::pin(ready(CoreStatus {
            error: emitted
                .err()
                .map(|_| "Simulated host rejected an effect".into()),
            phase,
            pid: None,
            version: Some("simulated-core".into()),
        }))
    }

    fn execute_lifecycle(
        &self,
        command: CoreLifecycleCommand,
    ) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async move {
            match command.mutation() {
                CoreLifecycleMutation::Start => {
                    self.emit(EffectKind::CoreStart, EffectResultKind::Started)
                        .map_err(|_| CoreError::start_failed("Simulated Core start failed"))?;
                    self.model
                        .lock()
                        .expect("simulated host lock poisoned")
                        .core_phase = SimulatedCorePhase::Running;
                }
                CoreLifecycleMutation::Stop => {
                    self.emit(EffectKind::CoreStop, EffectResultKind::Stopped)
                        .map_err(|_| CoreError::stop_failed("Simulated Core stop failed"))?;
                    self.model
                        .lock()
                        .expect("simulated host lock poisoned")
                        .core_phase = SimulatedCorePhase::Stopped;
                }
            }
            Ok(self.status().await)
        })
    }
}

pub struct ScenarioRuntime {
    _root: TempDir,
    pub activation: Arc<ProfileActivationCoordinator>,
    pub capture: Arc<CaptureReconciler>,
    pub host: Arc<SimulatedHost>,
    pub profile_service: Arc<mish_bridge::DesktopProfileService>,
    pub runtime_host: DesktopRuntimeHost,
}

impl ScenarioRuntime {
    pub async fn build(
        scenario: SimulatedHostScenario,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        let root = tempfile::tempdir()?;
        let profiles = root.path().join("profiles");
        fs::create_dir_all(&profiles)?;
        fs::write(
            profiles.join("simulated.yaml"),
            "mode: rule\nproxies: []\nproxy-groups: []\nrules:\n  - MATCH,DIRECT\n",
        )?;
        let profile_service = Arc::new(ReqwestHttpsSourceReader::profile_service(
            root.path().to_path_buf(),
        )?);
        profile_service.reconcile_profile_directory().await?;

        let host = Arc::new(SimulatedHost::new(scenario)?);
        let platform: Arc<dyn CapturePlatform> = host.clone();
        let journal: Arc<dyn CaptureJournalStore> = host.clone();
        let capture = Arc::new(CaptureReconciler::new(
            platform,
            journal,
            LoopbackProxyEndpoint::managed(),
        ));
        host.attach_capture(&capture);
        let core: Arc<dyn CoreRuntime> = host.clone();
        let safe_runtime = MishRuntime::with_capture(core, capture.clone());
        host.attach_runtime(safe_runtime.clone());
        let runtime_host = DesktopRuntimeHost::with_mutation_authority(
            safe_runtime.clone(),
            profile_service.mutation_authority(),
        );
        let binary = root.path().join("managed-core-fixture");
        fs::write(
            &binary,
            b"test fixture; execution is blocked by ownership checks",
        )?;
        let manager = Arc::new(
            MihomoActivationManager::new_with_capture(
                ManagedMihomoResolver::development(binary, root.path().join("runtime")),
                ActivationTiming::default(),
                Some(capture.clone()),
            )
            .with_test_listener_host(host.clone()),
        );
        let activation = Arc::new(ProfileActivationCoordinator::new(
            profile_service.clone(),
            manager,
            runtime_host.clone(),
            safe_runtime,
            || {
                ManagedRuntimePolicy::new(
                    SocketAddr::from((Ipv4Addr::LOCALHOST, 19090)),
                    "simulated-controller-secret",
                )
            },
        ));
        Ok(Self {
            _root: root,
            activation,
            capture,
            host,
            profile_service,
            runtime_host,
        })
    }

    pub fn replace_runtime(&self) -> Arc<CaptureReconciler> {
        let platform: Arc<dyn CapturePlatform> = self.host.clone();
        let journal: Arc<dyn CaptureJournalStore> = self.host.clone();
        let capture = Arc::new(CaptureReconciler::new(
            platform,
            journal,
            LoopbackProxyEndpoint::managed(),
        ));
        self.host.attach_capture(&capture);
        let core: Arc<dyn CoreRuntime> = self.host.clone();
        let runtime = MishRuntime::with_capture(core, capture.clone());
        self.host.attach_runtime(runtime.clone());
        self.runtime_host.replace(runtime);
        capture
    }

    pub async fn terminate_and_restart(self) -> Self {
        let Self {
            _root,
            activation,
            capture,
            host,
            profile_service,
            runtime_host,
        } = self;
        activation.abort_for_process_termination();
        capture.abort_for_process_termination();
        drop(activation);
        drop(capture);
        drop(runtime_host);
        host.detach_process();
        // Abrupt process termination is distinct from last-owner retirement: explicitly abort
        // both actors, then yield once so their executors release prior-process authority before
        // the replacement process is composed.
        tokio::task::yield_now().await;

        let platform: Arc<dyn CapturePlatform> = host.clone();
        let journal: Arc<dyn CaptureJournalStore> = host.clone();
        let capture = Arc::new(CaptureReconciler::new(
            platform,
            journal,
            LoopbackProxyEndpoint::managed(),
        ));
        host.attach_capture(&capture);
        let core: Arc<dyn CoreRuntime> = host.clone();
        let safe_runtime = MishRuntime::with_capture(core, capture.clone());
        host.attach_runtime(safe_runtime.clone());
        let runtime_host = DesktopRuntimeHost::with_mutation_authority(
            safe_runtime.clone(),
            profile_service.mutation_authority(),
        );
        let manager = Arc::new(
            MihomoActivationManager::new_with_capture(
                ManagedMihomoResolver::development(
                    _root.path().join("managed-core-fixture"),
                    _root.path().join("runtime"),
                ),
                ActivationTiming::default(),
                Some(capture.clone()),
            )
            .with_test_listener_host(host.clone()),
        );
        let activation = Arc::new(ProfileActivationCoordinator::new(
            profile_service.clone(),
            manager,
            runtime_host.clone(),
            safe_runtime,
            || {
                ManagedRuntimePolicy::new(
                    SocketAddr::from((Ipv4Addr::LOCALHOST, 19090)),
                    "simulated-controller-secret",
                )
            },
        ));

        Self {
            _root,
            activation,
            capture,
            host,
            profile_service,
            runtime_host,
        }
    }
}

fn disabled_proxy_state() -> NetworkServiceProxyState {
    NetworkServiceProxyState {
        auto_discovery_enabled: false,
        bypass_domains: Vec::new(),
        http: ManualProxyState::disabled(),
        https: ManualProxyState::disabled(),
        pac_enabled: false,
        pac_url: "(null)".into(),
        service_id: SYNTHETIC_SERVICE_ID.into(),
        socks: ManualProxyState::disabled(),
    }
}

#[cfg(test)]
mod tests {
    use mish_bridge::ProfileActivationPhase;
    use mish_runtime::{
        CaptureFailureKind, CaptureOperationPhase, CaptureSelection, StatusAdapterKind,
    };
    use serde_json::json;

    use super::*;

    async fn settle_until(mut predicate: impl FnMut() -> bool) {
        for _ in 0..256 {
            if predicate() {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("deterministic scenario did not settle within the scheduler budget");
    }

    async fn settle_capture_phase(
        runtime_host: &DesktopRuntimeHost,
        expected: CaptureOperationPhase,
    ) {
        for _ in 0..256 {
            let snapshot = runtime_host
                .current()
                .status_snapshot_typed(StatusAdapterKind::Rpc)
                .await;
            if snapshot.runtime.capture_operation.phase == expected {
                return;
            }
            tokio::task::yield_now().await;
        }
        panic!("Capture did not reach {expected:?} within the scheduler budget");
    }

    fn system_proxy_selection() -> CaptureSelection {
        CaptureSelection {
            system_proxy: true,
            tun: false,
        }
    }

    #[tokio::test]
    async fn early_conflict_notification_precedes_cleanup_and_projects_finalization() {
        let scenario = ScenarioRuntime::build(SimulatedHostScenario::initial_foreign_listener())
            .await
            .unwrap();
        let activation = scenario.activation.clone();
        let launch = tokio::spawn(async move {
            activation
                .launch_proxy(
                    "11111111-1111-4111-8111-111111111111",
                    system_proxy_selection(),
                    StatusAdapterKind::Rpc,
                )
                .await
        });

        settle_until(|| {
            scenario
                .host
                .observation()
                .transcript
                .events
                .iter()
                .any(|event| {
                    event.effect_kind == EffectKind::ManagedEndpointOwnershipCheckEarly
                        && event.result_kind == EffectResultKind::ForeignOwned
                })
        })
        .await;
        let early = scenario
            .host
            .observation()
            .transcript
            .events
            .into_iter()
            .find(|event| event.effect_kind == EffectKind::ManagedEndpointOwnershipCheckEarly)
            .unwrap();
        assert_eq!(early.authority_id, SyntheticAuthorityId::CaptureOne);
        assert_eq!(early.runtime_id, SyntheticRuntimeId::RuntimeOne);
        assert_eq!(early.scope_epoch, 1);
        assert_eq!(early.operation_id, Some(1));
        assert_eq!(early.admitted_revision, 1);
        settle_until(|| {
            serde_json::to_string(&scenario.runtime_host.notification_snapshot())
                .unwrap()
                .contains("profile.activation-listener-conflict")
        })
        .await;
        settle_capture_phase(&scenario.runtime_host, CaptureOperationPhase::Finalizing).await;

        let pending = scenario
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        assert_eq!(
            pending.runtime.capture_operation.phase,
            CaptureOperationPhase::Finalizing
        );
        assert_eq!(
            pending.runtime.capture_operation.failure,
            Some(CaptureFailureKind::ListenerUnavailable)
        );
        assert_eq!(
            scenario.activation.activation_snapshot().await.phase,
            ProfileActivationPhase::Pending
        );
        assert_eq!(
            scenario.host.observation().preparation_phase,
            PreparationPhase::Finalizing
        );
        assert!(!launch.is_finished());
        assert!(
            !scenario
                .host
                .observation()
                .transcript
                .events
                .iter()
                .any(|event| event.effect_kind == EffectKind::CleanupCandidate)
        );

        let duplicate = scenario
            .activation
            .launch_proxy(
                "22222222-2222-4222-8222-222222222222",
                system_proxy_selection(),
                StatusAdapterKind::Rpc,
            )
            .await
            .unwrap_err();
        assert_eq!(duplicate.kind, CaptureFailureKind::RuntimeTransition);

        scenario.host.advance_to(20).unwrap();
        assert!(launch.await.unwrap().is_err());
        let terminal = scenario
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        assert_eq!(
            terminal.runtime.capture_operation.phase,
            CaptureOperationPhase::Failed
        );
        assert!(!terminal.runtime.system_proxy_enabled);
        assert_eq!(
            scenario.host.observation().preparation_phase,
            PreparationPhase::Complete
        );
        let effects = scenario
            .host
            .observation()
            .transcript
            .events
            .into_iter()
            .map(|event| event.effect_kind)
            .collect::<Vec<_>>();
        let cleanup = effects
            .iter()
            .position(|effect| *effect == EffectKind::CleanupCandidate)
            .unwrap();
        let finalizer = effects
            .iter()
            .position(|effect| *effect == EffectKind::FinalizeOperation)
            .unwrap();
        assert!(cleanup < finalizer);
        assert!(!effects.contains(&EffectKind::CaptureApply));
    }

    #[tokio::test]
    async fn second_check_closes_the_scheduled_ownership_toctou_window() {
        let scenario =
            ScenarioRuntime::build(SimulatedHostScenario::ownership_changes_before_commit())
                .await
                .unwrap();
        let activation = scenario.activation.clone();
        let launch = tokio::spawn(async move {
            activation
                .launch_proxy(
                    "33333333-3333-4333-8333-333333333333",
                    system_proxy_selection(),
                    StatusAdapterKind::Rpc,
                )
                .await
        });
        settle_until(|| {
            scenario
                .host
                .observation()
                .transcript
                .events
                .iter()
                .any(|event| {
                    event.effect_kind == EffectKind::ManagedEndpointOwnershipCheckEarly
                        && event.result_kind == EffectResultKind::Free
                })
        })
        .await;
        assert!(
            !serde_json::to_string(&scenario.runtime_host.notification_snapshot())
                .unwrap()
                .contains("profile.activation-listener-conflict")
        );

        scenario.host.advance_to(5).unwrap();
        scenario.host.advance_to(10).unwrap();
        settle_until(|| {
            scenario
                .host
                .observation()
                .transcript
                .events
                .iter()
                .any(|event| {
                    event.effect_kind == EffectKind::ManagedEndpointOwnershipCheckCommit
                        && event.result_kind == EffectResultKind::ForeignOwned
                })
        })
        .await;
        settle_until(|| {
            serde_json::to_string(&scenario.runtime_host.notification_snapshot())
                .unwrap()
                .contains("profile.activation-listener-conflict")
        })
        .await;
        settle_capture_phase(&scenario.runtime_host, CaptureOperationPhase::Finalizing).await;
        assert!(!launch.is_finished());
        assert_eq!(
            scenario
                .runtime_host
                .current()
                .status_snapshot_typed(StatusAdapterKind::Rpc)
                .await
                .runtime
                .capture_operation
                .phase,
            CaptureOperationPhase::Finalizing
        );

        scenario.host.advance_to(20).unwrap();
        assert!(launch.await.unwrap().is_err());
        let observation = scenario.host.observation();
        assert_eq!(observation.endpoint_owner, ManagedEndpointOwner::Foreign);
        assert!(
            !observation
                .transcript
                .events
                .iter()
                .any(|event| event.effect_kind == EffectKind::CaptureApply)
        );
    }

    #[tokio::test]
    async fn cancellation_and_duplicate_commands_share_one_owned_finalizer() {
        let scenario =
            ScenarioRuntime::build(SimulatedHostScenario::ownership_changes_before_commit())
                .await
                .unwrap();
        let command_id = "44444444-4444-4444-8444-444444444444";
        let activation = scenario.activation.clone();
        let launch = tokio::spawn(async move {
            activation
                .launch_proxy(command_id, system_proxy_selection(), StatusAdapterKind::Rpc)
                .await
        });
        settle_until(|| {
            scenario
                .host
                .observation()
                .transcript
                .events
                .iter()
                .any(|event| event.effect_kind == EffectKind::ProfilePreparation)
        })
        .await;
        let duplicate = scenario
            .activation
            .launch_proxy(command_id, system_proxy_selection(), StatusAdapterKind::Rpc)
            .await
            .unwrap_err();
        let equal_target = scenario
            .activation
            .launch_proxy(
                "55555555-5555-4555-8555-555555555555",
                system_proxy_selection(),
                StatusAdapterKind::Rpc,
            )
            .await
            .unwrap_err();
        assert_eq!(duplicate.kind, CaptureFailureKind::RuntimeTransition);
        assert_eq!(equal_target.kind, CaptureFailureKind::RuntimeTransition);
        let stale_cancel = scenario
            .activation
            .cancel("66666666-6666-4666-8666-666666666666")
            .await
            .unwrap();
        assert_eq!(stale_cancel.phase, ProfileActivationPhase::Pending);
        scenario.activation.cancel(command_id).await.unwrap();
        settle_capture_phase(&scenario.runtime_host, CaptureOperationPhase::Finalizing).await;
        let finalizing = scenario
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        assert_eq!(
            finalizing.runtime.capture_operation.failure,
            Some(CaptureFailureKind::RuntimeTransition)
        );
        assert_eq!(
            scenario.activation.activation_snapshot().await.phase,
            ProfileActivationPhase::Pending
        );
        let finalizing_duplicate = scenario
            .activation
            .launch_proxy(
                "99999999-9999-4999-8999-999999999999",
                system_proxy_selection(),
                StatusAdapterKind::Rpc,
            )
            .await
            .unwrap_err();
        assert_eq!(
            finalizing_duplicate.kind,
            CaptureFailureKind::RuntimeTransition
        );
        scenario.host.advance_to(20).unwrap();
        assert!(launch.await.unwrap().is_err());
        let terminal = scenario.activation.activation_snapshot().await;
        assert_eq!(terminal.phase, ProfileActivationPhase::Failure);
        let preparation_count = scenario
            .host
            .observation()
            .transcript
            .events
            .iter()
            .filter(|event| event.effect_kind == EffectKind::ProfilePreparation)
            .count();
        assert_eq!(preparation_count, 1);
        let finalizer_count = scenario
            .host
            .observation()
            .transcript
            .events
            .iter()
            .filter(|event| event.effect_kind == EffectKind::FinalizeOperation)
            .count();
        assert_eq!(finalizer_count, 1);
    }

    #[tokio::test]
    async fn bounded_injected_cleanup_failure_still_runs_authority_and_finalizer() {
        let mut definition = SimulatedHostScenario::initial_foreign_listener();
        definition.failures.push(InjectedFailure {
            after_effect: None,
            effect: EffectKind::CleanupCandidate,
            kind: InjectedFailureKind::Operation,
            occurrence: 1,
        });
        let scenario = ScenarioRuntime::build(definition).await.unwrap();
        let activation = scenario.activation.clone();
        let launch = tokio::spawn(async move {
            activation
                .launch_proxy(
                    "77777777-7777-4777-8777-777777777777",
                    system_proxy_selection(),
                    StatusAdapterKind::Rpc,
                )
                .await
        });
        settle_until(|| {
            scenario.host.observation().preparation_phase == PreparationPhase::Finalizing
        })
        .await;
        settle_capture_phase(&scenario.runtime_host, CaptureOperationPhase::Finalizing).await;
        let finalizing = scenario
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        assert_eq!(
            finalizing.runtime.capture_operation.failure,
            Some(CaptureFailureKind::ListenerUnavailable)
        );
        scenario.host.advance_to(20).unwrap();
        assert!(launch.await.unwrap().is_err());
        let transcript = scenario.host.observation().transcript;
        assert!(transcript.events.iter().any(|event| {
            event.effect_kind == EffectKind::CleanupCandidate
                && event.result_kind == EffectResultKind::InjectedFailure
        }));
        assert!(transcript.events.iter().any(|event| {
            event.effect_kind == EffectKind::ReconcileAuthority
                && event.result_kind == EffectResultKind::Completed
        }));
        assert!(transcript.events.iter().any(|event| {
            event.effect_kind == EffectKind::FinalizeOperation
                && event.result_kind == EffectResultKind::Completed
        }));
    }

    #[tokio::test]
    async fn injected_ownership_failure_fails_closed_and_still_finalizes() {
        let mut definition = SimulatedHostScenario::initial_foreign_listener();
        definition.failures.push(InjectedFailure {
            after_effect: None,
            effect: EffectKind::ManagedEndpointOwnershipCheckEarly,
            kind: InjectedFailureKind::Observation,
            occurrence: 1,
        });
        let scenario = ScenarioRuntime::build(definition).await.unwrap();
        let activation = scenario.activation.clone();
        let launch = tokio::spawn(async move {
            activation
                .launch_proxy(
                    "88888888-8888-4888-8888-888888888888",
                    system_proxy_selection(),
                    StatusAdapterKind::Rpc,
                )
                .await
        });
        settle_until(|| {
            scenario.host.observation().preparation_phase == PreparationPhase::Finalizing
        })
        .await;
        assert!(!launch.is_finished());
        scenario.host.advance_to(20).unwrap();
        assert!(launch.await.unwrap().is_err());
        let transcript = scenario.host.observation().transcript;
        assert!(transcript.events.iter().any(|event| {
            event.effect_kind == EffectKind::ManagedEndpointOwnershipCheckEarly
                && event.result_kind == EffectResultKind::InjectedFailure
        }));
        assert!(transcript.events.iter().any(|event| {
            event.effect_kind == EffectKind::FinalizeOperation
                && event.result_kind == EffectResultKind::Completed
        }));
    }

    #[test]
    fn transcript_is_deterministic_bounded_and_structurally_private() {
        fn run() -> SemanticTranscript {
            let host =
                SimulatedHost::new(SimulatedHostScenario::initial_foreign_listener()).unwrap();
            host.exercise_effect(EffectKind::CaptureObserve).unwrap();
            host.advance_to(7).unwrap();
            host.exercise_effect(EffectKind::CoreObserve).unwrap();
            host.observation().transcript
        }
        let first = run();
        let second = run();
        assert_eq!(first, second);
        assert_eq!(first.schema_version, TRANSCRIPT_SCHEMA_VERSION);
        assert!(first.events.len() <= DEFAULT_TRANSCRIPT_LIMIT);
        let encoded = serde_json::to_string(&first).unwrap();
        assert!(encoded.len() < 16_384);
        for forbidden in [
            "configBytes",
            "credential",
            "privateKey",
            "subscription",
            "token",
            "userPath",
            "rawOutput",
            "route",
            "dns",
            "traffic",
            "/Users/",
        ] {
            assert!(
                !encoded.contains(forbidden),
                "{forbidden} entered transcript"
            );
        }
        assert!(
            serde_json::from_value::<SemanticTranscript>(json!({
                "schemaVersion": 1,
                "events": [],
                "configBytes": "private"
            }))
            .is_err()
        );
        assert!(
            serde_json::from_value::<SemanticTranscript>(json!({
                "schemaVersion": 2,
                "events": []
            }))
            .is_err()
        );
        let event = serde_json::to_value(first.events[0]).unwrap();
        assert!(
            serde_json::from_value::<SemanticTranscript>(json!({
                "schemaVersion": 1,
                "events": vec![event; MAX_TRANSCRIPT_LIMIT + 1]
            }))
            .is_err()
        );
        for forbidden_field in [
            "profileBytes",
            "configBytes",
            "subscription",
            "node",
            "credential",
            "token",
            "privateKey",
            "userPath",
            "rawProcessOutput",
            "rawPlatformObservation",
            "route",
            "dns",
            "traffic",
            "hostInventory",
            "processInventory",
            "arbitraryString",
        ] {
            let mut transcript = json!({
                "schemaVersion": 1,
                "events": []
            });
            transcript[forbidden_field] = json!("private");
            assert!(
                serde_json::from_value::<SemanticTranscript>(transcript).is_err(),
                "{forbidden_field} entered the transcript schema"
            );
            let mut scenario = json!({
                "cleanupCompletesAt": 20,
                "declaredEffects": [],
                "failures": [],
                "initialEndpointOwner": "foreign",
                "scheduledChanges": [],
                "secondCheckAt": 10,
                "transcriptLimit": 8
            });
            scenario[forbidden_field] = json!("private");
            assert!(
                serde_json::from_value::<SimulatedHostScenario>(scenario).is_err(),
                "{forbidden_field} entered the scenario schema"
            );
        }
    }

    #[test]
    fn undeclared_effects_and_overflow_fail_closed_without_default_success() {
        let mut undeclared = SimulatedHostScenario::initial_foreign_listener();
        undeclared.declared_effects.clear();
        let host = SimulatedHost::new(undeclared).unwrap();
        assert_eq!(
            host.exercise_effect(EffectKind::CaptureApply),
            Err(SimulatedHostFailure::UndeclaredEffect(
                EffectKind::CaptureApply
            ))
        );
        assert_eq!(
            host.observation().transcript.events[0].result_kind,
            EffectResultKind::FailedClosed
        );

        let mut bounded = SimulatedHostScenario::initial_foreign_listener();
        bounded.transcript_limit = 1;
        let host = SimulatedHost::new(bounded).unwrap();
        host.exercise_effect(EffectKind::CaptureObserve).unwrap();
        assert_eq!(
            host.exercise_effect(EffectKind::CoreObserve),
            Err(SimulatedHostFailure::TranscriptOverflow)
        );
        assert_eq!(host.observation().transcript.events.len(), 1);
    }

    #[test]
    fn built_in_scenarios_reject_unnecessary_mutating_effects() {
        for effect in [
            EffectKind::CaptureApply,
            EffectKind::CaptureConfirmListener,
            EffectKind::CoreStart,
            EffectKind::JournalSave,
        ] {
            let host =
                SimulatedHost::new(SimulatedHostScenario::initial_foreign_listener()).unwrap();
            assert_eq!(
                host.exercise_effect(effect),
                Err(SimulatedHostFailure::UndeclaredEffect(effect))
            );
        }
    }

    #[tokio::test]
    async fn transcript_maps_real_authority_and_runtime_replacement_to_closed_identities() {
        let host = Arc::new(
            SimulatedHost::new(SimulatedHostScenario::initial_foreign_listener()).unwrap(),
        );
        let platform: Arc<dyn CapturePlatform> = host.clone();
        let journal: Arc<dyn CaptureJournalStore> = host.clone();
        let first_capture = Arc::new(CaptureReconciler::new(
            platform.clone(),
            journal.clone(),
            LoopbackProxyEndpoint::managed(),
        ));
        host.attach_capture(&first_capture);
        let core: Arc<dyn CoreRuntime> = host.clone();
        let first_runtime = MishRuntime::with_capture(core.clone(), first_capture);
        host.attach_runtime(first_runtime);
        host.exercise_effect(EffectKind::CoreObserve).unwrap();

        let second_capture = Arc::new(CaptureReconciler::new(
            platform,
            journal,
            LoopbackProxyEndpoint::managed(),
        ));
        host.attach_capture(&second_capture);
        let second_runtime = MishRuntime::with_capture(core, second_capture);
        host.attach_runtime(second_runtime);
        host.exercise_effect(EffectKind::CoreObserve).unwrap();

        let events = host.observation().transcript.events;
        assert_eq!(events[0].authority_id, SyntheticAuthorityId::CaptureOne);
        assert_eq!(events[0].runtime_id, SyntheticRuntimeId::RuntimeOne);
        assert_eq!(events[0].scope_epoch, 1);
        assert_eq!(events[1].authority_id, SyntheticAuthorityId::CaptureTwo);
        assert_eq!(events[1].runtime_id, SyntheticRuntimeId::RuntimeTwo);
        assert_eq!(events[1].scope_epoch, 2);
    }

    #[test]
    fn bounded_failure_injection_is_typed_and_occurrence_scoped() {
        let mut definition = SimulatedHostScenario::initial_foreign_listener();
        definition.failures.push(InjectedFailure {
            after_effect: None,
            effect: EffectKind::CaptureObserve,
            kind: InjectedFailureKind::Observation,
            occurrence: 2,
        });
        let host = SimulatedHost::new(definition).unwrap();
        host.exercise_effect(EffectKind::CaptureObserve).unwrap();
        assert_eq!(
            host.exercise_effect(EffectKind::CaptureObserve),
            Err(SimulatedHostFailure::InjectedFailure(
                EffectKind::CaptureObserve,
                InjectedFailureKind::Observation
            ))
        );
        host.exercise_effect(EffectKind::CaptureObserve).unwrap();
        let results = host
            .observation()
            .transcript
            .events
            .into_iter()
            .map(|event| event.result_kind)
            .collect::<Vec<_>>();
        assert_eq!(
            results,
            vec![
                EffectResultKind::Completed,
                EffectResultKind::InjectedFailure,
                EffectResultKind::Completed
            ]
        );
    }

    #[test]
    fn failure_injection_can_begin_after_a_prerequisite_effect() {
        let mut definition = SimulatedHostScenario::initial_foreign_listener();
        definition.declared_effects =
            vec![EffectKind::CaptureObserve, EffectKind::CaptureWriteHttps];
        definition.failures.push(InjectedFailure {
            after_effect: Some(EffectKind::CaptureWriteHttps),
            effect: EffectKind::CaptureObserve,
            kind: InjectedFailureKind::Observation,
            occurrence: 1,
        });
        let host = SimulatedHost::new(definition).unwrap();
        host.exercise_effect(EffectKind::CaptureObserve).unwrap();
        host.exercise_effect(EffectKind::CaptureWriteHttps).unwrap();
        assert_eq!(
            host.exercise_effect(EffectKind::CaptureObserve),
            Err(SimulatedHostFailure::InjectedFailure(
                EffectKind::CaptureObserve,
                InjectedFailureKind::Observation
            ))
        );
    }

    #[tokio::test]
    async fn adapter_mutations_are_shared_state_not_canned_responses() {
        let mut definition = SimulatedHostScenario::initial_foreign_listener();
        definition.declared_effects = system_proxy_effect_contract();
        let host = SimulatedHost::new(definition).unwrap();
        let mut target = disabled_proxy_state();
        target.pac_enabled = true;
        CapturePlatform::apply_service(&host, target.clone())
            .await
            .unwrap();
        assert_eq!(
            CapturePlatform::observe_active(&host).await.unwrap(),
            target
        );
    }
}
