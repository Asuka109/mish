use std::{
    collections::{HashMap, HashSet, VecDeque},
    fs,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex, Weak},
};

use futures_util::future::{BoxFuture, ready};
use mish_bridge::{
    ActivationCommit, DesktopRuntimeHost, ManagedActivationState, ManagedRuntimePolicy,
    MihomoActivationError, MihomoResolveError, ProfileActivationCoordinator,
    ProfileActivationEffects, ProfileActivationProgress, ProfileActivationProgressObserver,
    ReqwestHttpsSourceReader,
};
use mish_profile::ProfileRecord;
use mish_runtime::{
    CapabilityAvailability, CaptureJournal, CaptureJournalStore, CapturePlatform,
    CaptureReconciler, CaptureTransitionError, CoreError, CorePhase, CoreRuntime, CoreStatus,
    LoopbackProxyEndpoint, ManualProxyState, MishRuntime, NetworkServiceProxyState,
};
use serde::{Deserialize, Serialize};
use tempfile::TempDir;
use thiserror::Error;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

pub const TRANSCRIPT_SCHEMA_VERSION: u16 = 1;
pub const DEFAULT_TRANSCRIPT_LIMIT: usize = 96;
pub const MAX_TRANSCRIPT_LIMIT: usize = 128;
pub const TEST_AUTH_TOKEN: &str = "mish-simulated-host-auth-token";
pub const TEST_CONTROL_KEY: &str = "mish-simulated-host-control-key";

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticAuthorityId {
    CaptureOne,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticRuntimeId {
    RuntimeOne,
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

#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SimulatedCorePhase {
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
    CleanupCandidate,
    CoreObserve,
    CoreOwnsListener,
    CoreStart,
    CoreStop,
    FinalizeOperation,
    JournalClear,
    JournalLoad,
    JournalSave,
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
    Cancelled,
    Completed,
    FailedClosed,
    ForeignOwned,
    Free,
    InjectedFailure,
    MishOwned,
    Observed,
    Started,
    Stopped,
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
    pub effect: EffectKind,
    pub kind: InjectedFailureKind,
    pub occurrence: u8,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub enum ScheduledChange {
    ManagedEndpointOwner {
        at: u64,
        owner: ManagedEndpointOwner,
    },
}

impl ScheduledChange {
    const fn at(self) -> u64 {
        match self {
            Self::ManagedEndpointOwner { at, .. } => at,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SimulatedHostScenario {
    pub cleanup_completes_at: u64,
    pub declared_effects: Vec<EffectKind>,
    pub failures: Vec<InjectedFailure>,
    pub initial_endpoint_owner: ManagedEndpointOwner,
    pub scheduled_changes: Vec<ScheduledChange>,
    pub second_check_at: u64,
    pub transcript_limit: usize,
}

impl SimulatedHostScenario {
    pub fn initial_foreign_listener() -> Self {
        Self {
            cleanup_completes_at: 20,
            declared_effects: complete_effect_contract(),
            failures: Vec::new(),
            initial_endpoint_owner: ManagedEndpointOwner::Foreign,
            scheduled_changes: Vec::new(),
            second_check_at: 10,
            transcript_limit: DEFAULT_TRANSCRIPT_LIMIT,
        }
    }

    pub fn ownership_changes_before_commit() -> Self {
        Self {
            cleanup_completes_at: 20,
            declared_effects: complete_effect_contract(),
            failures: Vec::new(),
            initial_endpoint_owner: ManagedEndpointOwner::Free,
            scheduled_changes: vec![ScheduledChange::ManagedEndpointOwner {
                at: 5,
                owner: ManagedEndpointOwner::Foreign,
            }],
            second_check_at: 10,
            transcript_limit: DEFAULT_TRANSCRIPT_LIMIT,
        }
    }

    fn validate(&self) -> Result<(), SimulatedHostFailure> {
        if self.transcript_limit == 0 || self.transcript_limit > MAX_TRANSCRIPT_LIMIT {
            return Err(SimulatedHostFailure::InvalidScenario);
        }
        if self.second_check_at > self.cleanup_completes_at {
            return Err(SimulatedHostFailure::InvalidScenario);
        }
        if self.failures.len() > 16
            || self.declared_effects.len() > 32
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

fn complete_effect_contract() -> Vec<EffectKind> {
    vec![
        EffectKind::CaptureApply,
        EffectKind::CaptureConfirmListener,
        EffectKind::CaptureObserve,
        EffectKind::CleanupCandidate,
        EffectKind::CoreObserve,
        EffectKind::CoreOwnsListener,
        EffectKind::CoreStart,
        EffectKind::CoreStop,
        EffectKind::FinalizeOperation,
        EffectKind::JournalClear,
        EffectKind::JournalLoad,
        EffectKind::JournalSave,
        EffectKind::ManagedEndpointOwnershipCheckCommit,
        EffectKind::ManagedEndpointOwnershipCheckEarly,
        EffectKind::ProfilePreparation,
        EffectKind::ReapOwnedChild,
        EffectKind::ReconcileAuthority,
        EffectKind::RequestCancellation,
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
    pub logical_time: u64,
    pub preparation_phase: PreparationPhase,
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

struct Model {
    active_runtime: Option<MishRuntime>,
    core_phase: SimulatedCorePhase,
    endpoint_owner: ManagedEndpointOwner,
    effect_occurrences: HashMap<EffectKind, u8>,
    journal: Option<CaptureJournal>,
    logical_time: u64,
    preparation_phase: PreparationPhase,
    proxy_state: NetworkServiceProxyState,
    scheduled_cursor: usize,
    transcript: VecDeque<TranscriptEvent>,
}

pub struct SimulatedHost {
    capture: Mutex<Option<Weak<CaptureReconciler>>>,
    clock_changed: Notify,
    declared_effects: HashSet<EffectKind>,
    failures: Vec<InjectedFailure>,
    model: Mutex<Model>,
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
            model: Mutex::new(Model {
                active_runtime: None,
                core_phase: SimulatedCorePhase::Stopped,
                endpoint_owner: scenario.initial_endpoint_owner,
                effect_occurrences: HashMap::new(),
                journal: None,
                logical_time: 0,
                preparation_phase: PreparationPhase::Idle,
                proxy_state: disabled_proxy_state(),
                scheduled_cursor: 0,
                transcript: VecDeque::new(),
            }),
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
        self.model
            .lock()
            .expect("simulated host lock poisoned")
            .active_runtime = Some(runtime);
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
                ScheduledChange::ManagedEndpointOwner { owner, .. } => {
                    model.endpoint_owner = owner;
                }
            }
            model.scheduled_cursor += 1;
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
            logical_time: model.logical_time,
            preparation_phase: model.preparation_phase,
            transcript: SemanticTranscript {
                events: model.transcript.iter().copied().collect(),
                schema_version: TRANSCRIPT_SCHEMA_VERSION,
            },
        }
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

    fn correlation(&self) -> (u64, Option<u64>, u64) {
        let capture = self
            .capture
            .lock()
            .expect("simulated capture lock poisoned")
            .as_ref()
            .and_then(Weak::upgrade);
        let operation_id = capture
            .as_ref()
            .and_then(|capture| capture.status().capture_operation.operation_id)
            .and_then(|operation| operation.parse::<u64>().ok());
        let admitted_revision = operation_id.unwrap_or(0);
        (1, operation_id, admitted_revision)
    }

    fn emit(
        &self,
        effect_kind: EffectKind,
        result_kind: EffectResultKind,
    ) -> Result<(), SimulatedHostFailure> {
        let (scope_epoch, operation_id, admitted_revision) = self.correlation();
        let mut model = self.model.lock().expect("simulated host lock poisoned");
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
                .find(|failure| failure.effect == effect_kind && failure.occurrence == occurrence)
                .map(|failure| SimulatedHostFailure::InjectedFailure(effect_kind, failure.kind))
        };
        if model.transcript.len() == self.scenario.transcript_limit {
            return Err(SimulatedHostFailure::TranscriptOverflow);
        }
        let logical_time = model.logical_time;
        model.transcript.push_back(TranscriptEvent {
            admitted_revision,
            authority_id: SyntheticAuthorityId::CaptureOne,
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
            runtime_id: SyntheticRuntimeId::RuntimeOne,
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

    async fn finalize_failed_preparation(&self) -> Result<(), SimulatedHostFailure> {
        self.set_preparation_phase(PreparationPhase::Cancelling);
        let mut first_failure = self
            .emit(EffectKind::RequestCancellation, EffectResultKind::Cancelled)
            .err();
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

impl ProfileActivationEffects for SimulatedHost {
    fn availability(&self) -> Result<(), MihomoResolveError> {
        Ok(())
    }

    fn activate_cancellable<'a>(
        &'a self,
        record: &'a ProfileRecord,
        _policy: &'a ManagedRuntimePolicy,
        cancellation: CancellationToken,
        progress: ProfileActivationProgressObserver,
    ) -> BoxFuture<'a, Result<ActivationCommit, MihomoActivationError>> {
        Box::pin(async move {
            self.set_preparation_phase(PreparationPhase::Running);
            {
                self.model
                    .lock()
                    .expect("simulated host lock poisoned")
                    .core_phase = SimulatedCorePhase::Starting;
            }
            self.emit(EffectKind::ProfilePreparation, EffectResultKind::Started)
                .map_err(|_| MihomoActivationError::StateCommitFailed)?;

            let owner = self.endpoint_owner();
            self.emit(
                EffectKind::ManagedEndpointOwnershipCheckEarly,
                Self::endpoint_result(owner),
            )
            .map_err(|_| MihomoActivationError::StateCommitFailed)?;
            if owner == ManagedEndpointOwner::Foreign {
                progress(ProfileActivationProgress::ManagedListenerConflict(
                    SocketAddr::from((Ipv4Addr::LOCALHOST, 7890)),
                ));
                self.finalize_failed_preparation()
                    .await
                    .map_err(|_| MihomoActivationError::StateCommitFailed)?;
                return Err(MihomoActivationError::ManagedListenerConflict(
                    SocketAddr::from((Ipv4Addr::LOCALHOST, 7890)),
                ));
            }

            tokio::select! {
                _ = cancellation.cancelled() => {
                    self.finalize_failed_preparation()
                        .await
                        .map_err(|_| MihomoActivationError::StateCommitFailed)?;
                    return Err(MihomoActivationError::Cancelled);
                }
                _ = self.wait_until(self.scenario.second_check_at) => {}
            }
            let owner = self.endpoint_owner();
            self.emit(
                EffectKind::ManagedEndpointOwnershipCheckCommit,
                Self::endpoint_result(owner),
            )
            .map_err(|_| MihomoActivationError::StateCommitFailed)?;
            if owner != ManagedEndpointOwner::Free {
                progress(ProfileActivationProgress::ManagedListenerConflict(
                    SocketAddr::from((Ipv4Addr::LOCALHOST, 7890)),
                ));
                self.finalize_failed_preparation()
                    .await
                    .map_err(|_| MihomoActivationError::StateCommitFailed)?;
                return Err(MihomoActivationError::ManagedListenerConflict(
                    SocketAddr::from((Ipv4Addr::LOCALHOST, 7890)),
                ));
            }

            self.emit(EffectKind::CoreStart, EffectResultKind::Started)
                .map_err(|_| MihomoActivationError::StartFailed)?;
            {
                let mut model = self.model.lock().expect("simulated host lock poisoned");
                model.core_phase = SimulatedCorePhase::Running;
                model.endpoint_owner = ManagedEndpointOwner::Mish;
            }
            Ok(ActivationCommit::new(
                record.effective_fingerprint().as_str(),
                record.metadata.id.as_str(),
                record.metadata.revision.id.as_str(),
            ))
        })
    }

    fn active_runtime(&self) -> BoxFuture<'_, Option<MishRuntime>> {
        Box::pin(ready(
            self.model
                .lock()
                .expect("simulated host lock poisoned")
                .active_runtime
                .clone(),
        ))
    }

    fn managed_state(&self) -> BoxFuture<'_, ManagedActivationState> {
        Box::pin(ready(ManagedActivationState::default()))
    }

    fn complete_runtime_handoff(&self) -> BoxFuture<'_, ()> {
        Box::pin(ready(()))
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), MihomoActivationError>> {
        Box::pin(async move {
            self.emit(EffectKind::CoreStop, EffectResultKind::Stopped)
                .map_err(|_| MihomoActivationError::ShutdownFailed)?;
            self.model
                .lock()
                .expect("simulated host lock poisoned")
                .core_phase = SimulatedCorePhase::Stopped;
            Ok(())
        })
    }

    fn route_selections(&self, _record: &ProfileRecord) -> HashMap<String, String> {
        HashMap::new()
    }

    fn delete_route_selections(&self, _profile_id: &str) {}
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
        let result = self
            .emit(EffectKind::CaptureObserve, EffectResultKind::Observed)
            .map_err(Self::capture_error);
        let state = self
            .model
            .lock()
            .expect("simulated host lock poisoned")
            .proxy_state
            .clone();
        Box::pin(ready(result.map(|_| state)))
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
        let result = self
            .emit(EffectKind::CaptureApply, EffectResultKind::Applied)
            .map_err(Self::capture_error);
        if result.is_ok() {
            self.model
                .lock()
                .expect("simulated host lock poisoned")
                .proxy_state = target;
        }
        Box::pin(ready(result))
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

    fn owns_local_proxy(&self, _endpoint: &LoopbackProxyEndpoint) -> BoxFuture<'_, bool> {
        let owner = self.endpoint_owner();
        let result = self.emit(EffectKind::CoreOwnsListener, Self::endpoint_result(owner));
        Box::pin(ready(result.is_ok() && owner == ManagedEndpointOwner::Mish))
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

    fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async move {
            self.emit(EffectKind::CoreStart, EffectResultKind::Started)
                .map_err(|_| CoreError::start_failed("Simulated Core start failed"))?;
            self.model
                .lock()
                .expect("simulated host lock poisoned")
                .core_phase = SimulatedCorePhase::Running;
            Ok(self.status().await)
        })
    }

    fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
        Box::pin(async move {
            self.emit(EffectKind::CoreStop, EffectResultKind::Stopped)
                .map_err(|_| CoreError::stop_failed("Simulated Core stop failed"))?;
            self.model
                .lock()
                .expect("simulated host lock poisoned")
                .core_phase = SimulatedCorePhase::Stopped;
            Ok(self.status().await)
        })
    }
}

pub struct ScenarioRuntime {
    _root: TempDir,
    pub activation: Arc<ProfileActivationCoordinator>,
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
        let safe_runtime = MishRuntime::with_capture(core, capture);
        host.attach_runtime(safe_runtime.clone());
        let runtime_host = DesktopRuntimeHost::with_mutation_authority(
            safe_runtime.clone(),
            profile_service.mutation_authority(),
        );
        let effects: Arc<dyn ProfileActivationEffects> = host.clone();
        let activation = Arc::new(ProfileActivationCoordinator::new(
            profile_service.clone(),
            effects,
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
            host,
            profile_service,
            runtime_host,
        })
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
        service_id: "simulated-service".into(),
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

    fn system_proxy_selection() -> CaptureSelection {
        CaptureSelection {
            system_proxy: true,
            tun: false,
        }
    }

    #[tokio::test]
    async fn early_conflict_notification_precedes_cleanup_and_pending_survives_finalization() {
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
        settle_until(|| {
            serde_json::to_string(&scenario.runtime_host.notification_snapshot())
                .unwrap()
                .contains("profile.activation-listener-conflict")
        })
        .await;

        let pending = scenario
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        assert_eq!(
            pending.runtime.capture_operation.phase,
            CaptureOperationPhase::Pending
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
            CaptureOperationPhase::Pending
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
        let profile_id = scenario
            .profile_service
            .snapshot()
            .unwrap()
            .selection
            .profile_id
            .unwrap();
        let command_id = "44444444-4444-4444-8444-444444444444";
        let pending = scenario
            .activation
            .activate(command_id, &profile_id)
            .await
            .unwrap();
        assert_eq!(pending.phase, ProfileActivationPhase::Pending);
        let duplicate = scenario
            .activation
            .activate(command_id, &profile_id)
            .await
            .unwrap();
        let equal_target = scenario
            .activation
            .activate("55555555-5555-4555-8555-555555555555", &profile_id)
            .await
            .unwrap();
        assert_eq!(duplicate.command_id, pending.command_id);
        assert_eq!(equal_target.command_id, pending.command_id);
        let stale_cancel = scenario
            .activation
            .cancel("66666666-6666-4666-8666-666666666666")
            .await
            .unwrap();
        assert_eq!(stale_cancel.phase, ProfileActivationPhase::Pending);
        scenario.activation.cancel(command_id).await.unwrap();
        settle_until(|| {
            scenario.host.observation().preparation_phase == PreparationPhase::Finalizing
        })
        .await;
        scenario.host.advance_to(20).unwrap();
        let mut settled = false;
        for _ in 0..256 {
            if scenario.activation.activation_snapshot().await.phase
                != ProfileActivationPhase::Pending
            {
                settled = true;
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(settled, "activation did not publish its terminal snapshot");
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
    async fn unchanged_ownership_can_commit_through_real_capture_machine() {
        let mut definition = SimulatedHostScenario::ownership_changes_before_commit();
        definition.scheduled_changes.clear();
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
            scenario
                .host
                .observation()
                .transcript
                .events
                .iter()
                .any(|event| event.effect_kind == EffectKind::ManagedEndpointOwnershipCheckEarly)
        })
        .await;
        scenario.host.advance_to(10).unwrap();
        assert!(launch.await.unwrap().is_ok());
        let snapshot = scenario
            .runtime_host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        assert_eq!(
            snapshot.runtime.capture_operation.phase,
            CaptureOperationPhase::Applied
        );
        assert!(snapshot.runtime.system_proxy_enabled);
        let observation = scenario.host.observation();
        assert_eq!(observation.endpoint_owner, ManagedEndpointOwner::Mish);
        assert!(
            observation
                .transcript
                .events
                .iter()
                .any(|event| event.effect_kind == EffectKind::CaptureApply)
        );
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
    fn bounded_failure_injection_is_typed_and_occurrence_scoped() {
        let mut definition = SimulatedHostScenario::initial_foreign_listener();
        definition.failures.push(InjectedFailure {
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

    #[tokio::test]
    async fn adapter_mutations_are_shared_state_not_canned_responses() {
        let host = SimulatedHost::new(SimulatedHostScenario::initial_foreign_listener()).unwrap();
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
