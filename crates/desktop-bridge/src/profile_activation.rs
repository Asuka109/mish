use std::{
    collections::HashSet,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use mish_profile::{
    ProfileAdapterKind, ProfileCapabilities, ProfileListItem, ProfilePatch, ProfilePatchEditor,
    ProfileRefreshPolicy, ProfileRefreshTrigger, ProfileServiceError, ProfileSnapshot, Timestamp,
};
use mish_runtime::{
    ApplicationActionId, ApplicationDiagnosticEvent, ApplicationNotification,
    ApplicationNotificationContent, CapabilityAvailability, CaptureFailureKind, CaptureRequest,
    CaptureSelection, CaptureTransitionError, MishRuntime, NotificationPublication,
    NotificationSeverity, ProfileActivationAsnFailedApplicationNotificationData,
    ProfileActivationAsnProgressApplicationNotificationData,
    ProfileActivationFailedApplicationNotificationData,
    ProfileActivationGeoipFailedApplicationNotificationData,
    ProfileActivationGeoipProgressApplicationNotificationData,
    ProfileActivationGeositeFailedApplicationNotificationData,
    ProfileActivationGeositeProgressApplicationNotificationData,
    ProfileActivationListenerConflictApplicationNotificationData,
    ProfileActivationMmdbFailedApplicationNotificationData,
    ProfileActivationMmdbProgressApplicationNotificationData, ProviderSnapshot,
    ProxyLaunchTimingApplicationEventData, StatusAdapterKind,
};
use mish_state_authority::{StateMutationAuthority, StateMutationPermit};
use serde::Serialize;
use serde_json::Value;
use tokio::{
    sync::{Mutex, broadcast, mpsc},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::{
    DesktopProfileService, DesktopRuntimeHost, ManagedRuntimePolicy, MihomoActivationError,
    MihomoActivationManager, MihomoResolveError, RuntimeConfigGenerationError,
};

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileActivationPhase {
    Idle,
    Pending,
    Success,
    Failure,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileActivationOperation {
    Activate,
    Stop,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileActivationAvailability {
    Available,
    MissingBinary,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileActivationFailure {
    InvalidProfile,
    MissingBinary,
    UnsafeRuntime,
    Staging,
    Validation,
    GeodataFailed,
    GeodataTimeout,
    Start,
    EarlyExit,
    ManagedListenerConflict,
    VersionMismatch,
    Controller,
    Timeout,
    Cancelled,
    Capture,
    PriorStop,
    StateCommit,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileActivationEvidenceKind {
    GeodataPreparing,
    GeodataFailed,
    GeodataTimeout,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileActivationEvidence {
    pub asset: crate::GeodataAsset,
    pub kind: ProfileActivationEvidenceKind,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProfileStartupPolicy {
    SafeStopped,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileActivationSnapshot {
    pub active_fingerprint: Option<String>,
    pub active_profile_id: Option<String>,
    pub attempted_at: Option<u64>,
    pub availability: ProfileActivationAvailability,
    pub command_id: Option<String>,
    pub evidence: Option<ProfileActivationEvidence>,
    pub failure: Option<ProfileActivationFailure>,
    pub failure_endpoint: Option<String>,
    pub operation: Option<ProfileActivationOperation>,
    pub phase: ProfileActivationPhase,
    pub safe_stopped: bool,
    pub startup_policy: ProfileStartupPolicy,
    pub target_profile_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedProfileSnapshot {
    pub activation: ProfileActivationSnapshot,
    pub adapter_kind: ProfileAdapterKind,
    pub capabilities: ProfileCapabilities,
    pub profiles: Vec<ProfileListItem>,
    pub providers: ProviderSnapshot,
}

impl ManagedProfileSnapshot {
    pub fn unavailable(mut snapshot: ProfileSnapshot) -> Self {
        snapshot.capabilities.scheduling = mish_profile::ProfileCapabilityAvailability::Unavailable;
        Self {
            activation: ProfileActivationSnapshot::unavailable(),
            adapter_kind: snapshot.adapter_kind,
            capabilities: snapshot.capabilities,
            profiles: snapshot.profiles,
            providers: ProviderSnapshot::unavailable(),
        }
    }
}

impl ProfileActivationSnapshot {
    pub fn unavailable() -> Self {
        Self {
            active_fingerprint: None,
            active_profile_id: None,
            attempted_at: None,
            availability: ProfileActivationAvailability::Unavailable,
            command_id: None,
            evidence: None,
            failure: None,
            failure_endpoint: None,
            operation: None,
            phase: ProfileActivationPhase::Idle,
            safe_stopped: true,
            startup_policy: ProfileStartupPolicy::SafeStopped,
            target_profile_id: None,
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum ProfileActivationCoordinatorError {
    #[error("profile activation command is invalid")]
    InvalidCommand,
    #[error("another profile activation command is pending")]
    Conflict,
    #[error("another Profile or Settings mutation is in progress")]
    Busy,
    #[error("profile activation is unavailable")]
    Unavailable,
    #[error("profile activation policy could not be prepared")]
    PolicyUnavailable,
    #[error(transparent)]
    Profile(#[from] ProfileServiceError),
    #[error("managed profile shutdown failed")]
    ShutdownFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileActivationShutdownFailure {
    BackgroundTask,
    MutationBusy,
    CaptureRestoration,
    CoreStop,
    StateCommit,
}

struct CoordinatorState {
    busy_profiles: HashSet<String>,
    cancellation: Option<CancellationToken>,
    snapshot: ProfileActivationSnapshot,
}

type PolicyFactory =
    dyn Fn() -> Result<ManagedRuntimePolicy, RuntimeConfigGenerationError> + Send + Sync;

pub struct ProfileActivationCoordinator {
    authority: StateMutationAuthority,
    host: DesktopRuntimeHost,
    manager: Arc<MihomoActivationManager>,
    policy_factory: Arc<PolicyFactory>,
    profiles: Arc<DesktopProfileService>,
    proxy_operation: Arc<Mutex<()>>,
    safe_runtime: MishRuntime,
    directory_task: Mutex<Option<JoinHandle<()>>>,
    scheduler_cancellation: CancellationToken,
    scheduler_task: Mutex<Option<JoinHandle<()>>>,
    shutting_down: AtomicBool,
    state: Mutex<CoordinatorState>,
    updates: broadcast::Sender<ProfileActivationSnapshot>,
}

impl ProfileActivationCoordinator {
    pub fn new<F>(
        profiles: Arc<DesktopProfileService>,
        manager: Arc<MihomoActivationManager>,
        host: DesktopRuntimeHost,
        safe_runtime: MishRuntime,
        policy_factory: F,
    ) -> Self
    where
        F: Fn() -> Result<ManagedRuntimePolicy, RuntimeConfigGenerationError>
            + Send
            + Sync
            + 'static,
    {
        let availability = map_availability(manager.availability());
        let (updates, _) = broadcast::channel(32);
        Self {
            authority: profiles.mutation_authority(),
            host,
            manager,
            policy_factory: Arc::new(policy_factory),
            profiles,
            proxy_operation: Arc::new(Mutex::new(())),
            safe_runtime,
            directory_task: Mutex::new(None),
            scheduler_cancellation: CancellationToken::new(),
            scheduler_task: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            state: Mutex::new(CoordinatorState {
                busy_profiles: HashSet::new(),
                cancellation: None,
                snapshot: ProfileActivationSnapshot {
                    active_fingerprint: None,
                    active_profile_id: None,
                    attempted_at: None,
                    availability,
                    command_id: None,
                    evidence: None,
                    failure: None,
                    failure_endpoint: None,
                    operation: None,
                    phase: ProfileActivationPhase::Idle,
                    safe_stopped: true,
                    startup_policy: ProfileStartupPolicy::SafeStopped,
                    target_profile_id: None,
                },
            }),
            updates,
        }
    }

    pub async fn activate(
        self: &Arc<Self>,
        command_id: &str,
        profile_id: &str,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        validate_command_id(command_id)?;
        let availability = self.activation_snapshot().await.availability;
        if availability != ProfileActivationAvailability::Available {
            self.reject_unavailable_activation(command_id, profile_id, availability)
                .await;
            return Err(ProfileActivationCoordinatorError::Unavailable);
        }
        {
            let state = self.state.lock().await;
            if state.snapshot.command_id.as_deref() == Some(command_id)
                || (state.snapshot.phase == ProfileActivationPhase::Pending
                    && state.snapshot.target_profile_id.as_deref() == Some(profile_id))
            {
                return Ok(state.snapshot.clone());
            }
            if state.snapshot.phase == ProfileActivationPhase::Pending {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
        }
        let permit = self.acquire_mutation()?;
        let cancellation = CancellationToken::new();
        let pending = {
            let mut state = self.state.lock().await;
            if state.snapshot.command_id.as_deref() == Some(command_id) {
                return Ok(state.snapshot.clone());
            }
            if state.snapshot.phase == ProfileActivationPhase::Pending {
                if state.snapshot.target_profile_id.as_deref() == Some(profile_id) {
                    return Ok(state.snapshot.clone());
                }
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
            if !state.busy_profiles.insert(profile_id.to_owned()) {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
            state.cancellation = Some(cancellation.clone());
            state.snapshot.command_id = Some(command_id.to_owned());
            state.snapshot.attempted_at = Some(now_unix_milliseconds());
            state.snapshot.failure = None;
            state.snapshot.evidence = None;
            state.snapshot.failure_endpoint = None;
            state.snapshot.operation = Some(ProfileActivationOperation::Activate);
            state.snapshot.phase = ProfileActivationPhase::Pending;
            state.snapshot.target_profile_id = Some(profile_id.to_owned());
            state.snapshot.clone()
        };
        let _ = self.updates.send(pending.clone());
        let record = match self.profiles.activation_record(profile_id) {
            Ok(record) => record,
            Err(error) => {
                self.finish_preflight_activation(
                    command_id,
                    ProfileActivationFailure::InvalidProfile,
                )
                .await;
                return Err(error.into());
            }
        };
        let policy = (self.policy_factory)()
            .map_err(|_| ProfileActivationCoordinatorError::PolicyUnavailable);
        let policy = match policy {
            Ok(policy) => policy,
            Err(error) => {
                self.finish_preflight_activation(command_id, ProfileActivationFailure::StateCommit)
                    .await;
                return Err(error);
            }
        };
        let coordinator = self.clone();
        let command_id = command_id.to_owned();
        tokio::spawn(async move {
            let (geodata_tx, mut geodata_rx) = mpsc::channel(8);
            let observer: crate::GeodataValidationObserver = Arc::new(move |event| {
                let _ = geodata_tx.try_send(event);
            });
            let evidence_coordinator = coordinator.clone();
            let evidence_command_id = command_id.clone();
            let evidence_task = tokio::spawn(async move {
                while let Some(event) = geodata_rx.recv().await {
                    evidence_coordinator
                        .record_geodata_evidence(&evidence_command_id, event)
                        .await;
                }
            });
            let result = coordinator
                .manager
                .activate_cancellable_observed(&record, &policy, cancellation, Some(observer))
                .await;
            let _ = evidence_task.await;
            coordinator.finish_activation(&command_id, result).await;
            drop(permit);
        });
        Ok(pending)
    }

    async fn reject_unavailable_activation(
        &self,
        command_id: &str,
        profile_id: &str,
        availability: ProfileActivationAvailability,
    ) {
        let failure = match availability {
            ProfileActivationAvailability::MissingBinary => ProfileActivationFailure::MissingBinary,
            ProfileActivationAvailability::Unavailable => ProfileActivationFailure::UnsafeRuntime,
            ProfileActivationAvailability::Available => return,
        };
        let mut state = self.state.lock().await;
        if state.snapshot.phase == ProfileActivationPhase::Pending {
            return;
        }
        state.snapshot.command_id = Some(command_id.to_owned());
        state.snapshot.attempted_at = Some(now_unix_milliseconds());
        state.snapshot.evidence = None;
        state.snapshot.failure = Some(failure);
        state.snapshot.failure_endpoint = None;
        state.snapshot.operation = Some(ProfileActivationOperation::Activate);
        state.snapshot.phase = ProfileActivationPhase::Failure;
        state.snapshot.target_profile_id = Some(profile_id.to_owned());
        let _ = self.updates.send(state.snapshot.clone());
        drop(state);
        self.host
            .record_application_event(ApplicationDiagnosticEvent::profile_activation_failure(
                profile_activation_failure_id(failure),
            ));
        let _ = self.host.publish_notification(NotificationPublication {
            dedupe_key: format!("profile.activation-failure:{command_id}"),
            pinned: false,
            presentation: profile_activation_failure_notification(failure),
            replaces: vec!["status.operation-failed".into()],
            resolved: false,
            severity: NotificationSeverity::Error,
        });
    }

    pub async fn cancel(
        &self,
        command_id: &str,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        validate_command_id(command_id)?;
        let state = self.state.lock().await;
        if state.snapshot.phase != ProfileActivationPhase::Pending
            || state.snapshot.command_id.as_deref() != Some(command_id)
        {
            return Ok(state.snapshot.clone());
        }
        if let Some(cancellation) = &state.cancellation {
            cancellation.cancel();
        }
        Ok(state.snapshot.clone())
    }

    pub async fn reactivate_active(
        self: &Arc<Self>,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        let profile_id = self
            .activation_snapshot()
            .await
            .active_profile_id
            .ok_or(ProfileActivationCoordinatorError::Unavailable)?;
        let command_id = Uuid::new_v4().to_string();
        let mut updates = self.subscribe();
        let pending = self.activate(&command_id, &profile_id).await?;
        if pending.phase != ProfileActivationPhase::Pending {
            return Ok(pending);
        }
        loop {
            let snapshot = updates
                .recv()
                .await
                .map_err(|_| ProfileActivationCoordinatorError::Unavailable)?;
            if snapshot.command_id.as_deref() == Some(command_id.as_str())
                && snapshot.phase != ProfileActivationPhase::Pending
            {
                return Ok(snapshot);
            }
        }
    }

    /// Starts the most recently successful Profile after an intentional application restart.
    ///
    /// The activation manager deliberately clears the live runtime identity during shutdown,
    /// but retains the last attempt so a separately persisted startup preference can resume the
    /// user's existing Profile without inventing a new selection.
    pub async fn activate_last_successful_profile(
        self: &Arc<Self>,
        command_id: &str,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        let managed = self.manager.managed_state().await;
        let profile_id = managed
            .last_successful_profile_id()
            .or_else(|| managed.active_profile_id())
            .or_else(|| {
                managed
                    .last_attempt()
                    .filter(|attempt| attempt.outcome() == crate::ActivationOutcome::Succeeded)
                    .map(|attempt| attempt.profile_id())
            })
            .map(str::to_owned)
            .or_else(|| {
                self.profiles
                    .snapshot()
                    .ok()?
                    .profiles
                    .into_iter()
                    .filter(|profile| profile.last_known_valid)
                    .max_by(|left, right| {
                        left.last_success_at
                            .cmp(&right.last_success_at)
                            .then_with(|| left.id.cmp(&right.id))
                    })
                    .map(|profile| profile.id)
            })
            .ok_or(ProfileActivationCoordinatorError::Unavailable)?;
        self.activate(command_id, &profile_id).await
    }

    /// Transport-neutral aggregate proxy launch authority.
    ///
    /// Interactive callers may supply a selected Profile; startup and future native callers pass
    /// `None` to resume the last successful Profile.  Profile activation and the single Capture
    /// mutation deliberately share this lifecycle so no transport can become a second authority.
    pub async fn launch_proxy(
        self: &Arc<Self>,
        command_id: &str,
        profile_id: Option<&str>,
        selection: CaptureSelection,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, CaptureTransitionError> {
        let _operation = self.proxy_operation.try_lock().map_err(|_| {
            CaptureTransitionError::new(
                CaptureFailureKind::RuntimeTransition,
                "Another aggregate proxy operation is already in progress",
            )
        })?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::RuntimeTransition,
                "Mish is shutting down and cannot accept a new proxy launch",
            ));
        }
        let launch_started = Instant::now();
        let before = self
            .host
            .current()
            .status_snapshot_typed(adapter_kind)
            .await;
        let selection =
            usable_capture_selection(before.adapter_kind, &before.capabilities, selection)?;
        if before.runtime.system_proxy_enabled || before.runtime.tun_enabled {
            let capture_started = Instant::now();
            let result = self
                .set_capture_inner(
                    CaptureRequest {
                        active: true,
                        selection,
                    },
                    adapter_kind,
                )
                .await;
            self.record_launch_timing(
                launch_started,
                Duration::ZERO,
                Duration::ZERO,
                Duration::ZERO,
                capture_started.elapsed(),
                if result.is_ok() {
                    "already-running"
                } else {
                    "capture-failed"
                },
            );
            return result;
        }
        let request = CaptureRequest {
            active: true,
            selection,
        };
        let prior_capture = self.host.current().publish_capture_pending(&request);
        let activation_started = Instant::now();
        let mut activation_started_for_launch = false;
        let current = self.activation_snapshot().await;
        let activation = if current.phase == ProfileActivationPhase::Success
            && profile_id
                .is_none_or(|profile_id| current.active_profile_id.as_deref() == Some(profile_id))
        {
            Ok(current)
        } else if let Some(profile_id) = profile_id {
            let activation = self
                .activate(command_id, profile_id)
                .await
                .map_err(profile_launch_error);
            if let Ok(activation) = &activation {
                activation_started_for_launch =
                    activation.command_id.as_deref() == Some(command_id);
            }
            activation
        } else {
            let activation = self
                .activate_last_successful_profile(command_id)
                .await
                .map_err(profile_launch_error);
            if let Ok(activation) = &activation {
                activation_started_for_launch =
                    activation.command_id.as_deref() == Some(command_id);
            }
            activation
        };
        let activation = match activation {
            Ok(activation) => activation,
            Err(error) => {
                self.record_launch_timing(
                    launch_started,
                    activation_started.elapsed(),
                    Duration::ZERO,
                    activation_started.elapsed(),
                    Duration::ZERO,
                    "profile-failed",
                );
                if let Some(prior_capture) = prior_capture {
                    self.host.current().restore_capture_status(prior_capture);
                }
                return Err(error);
            }
        };
        let activation_pending = activation.phase == ProfileActivationPhase::Pending;
        let activation = async {
            let result = if activation_pending {
                self.wait_for_terminal_activation(command_id).await
            } else {
                Ok(activation)
            };
            (result, activation_started.elapsed())
        };
        let preflight_request = request.clone();
        let preflight_started = Instant::now();
        let preflight = async {
            let result = self.host.preflight_capture(&preflight_request).await;
            (result, preflight_started.elapsed())
        };
        tokio::pin!(activation);
        tokio::pin!(preflight);
        let prepared = tokio::select! {
            (completed, activation_elapsed) = &mut activation => {
                match completed {
                    Ok(completed) if completed.phase == ProfileActivationPhase::Success => {
                        let (preflight, preflight_elapsed) = preflight.await;
                        preflight.map(|preflight| (preflight, activation_elapsed, preflight_elapsed))
                    }
                    Ok(_) | Err(_) => Err(CaptureTransitionError::new(
                        CaptureFailureKind::RuntimeTransition,
                        "Profile activation failed before Capture could be applied",
                    )),
                }
            }
            (preflight, preflight_elapsed) = &mut preflight => {
                match preflight {
                    Ok(preflight) => {
                        let (completed, activation_elapsed) = activation.await;
                        match completed {
                            Ok(completed) if completed.phase == ProfileActivationPhase::Success => {
                                Ok((preflight, activation_elapsed, preflight_elapsed))
                            }
                            Ok(_) | Err(_) => Err(CaptureTransitionError::new(
                                CaptureFailureKind::RuntimeTransition,
                                "Profile activation failed before Capture could be applied",
                            )),
                        }
                    }
                    Err(error) => {
                        if activation_pending {
                            let _ = self.cancel(command_id).await;
                            let _ = activation.await;
                        }
                        Err(error)
                    }
                }
            }
        };
        let preparation_wall = activation_started.elapsed();
        let (mut result, activation_elapsed, preflight_elapsed, capture_elapsed, mut outcome) =
            match prepared {
                Err(error) => {
                    let outcome = if error.kind == CaptureFailureKind::RuntimeTransition {
                        "profile-failed"
                    } else {
                        "preflight-failed"
                    };
                    (
                        Err(error),
                        preparation_wall,
                        preflight_started.elapsed(),
                        Duration::ZERO,
                        outcome,
                    )
                }
                Ok((_, activation_elapsed, preflight_elapsed))
                    if self.shutting_down.load(Ordering::Acquire) =>
                {
                    (
                        Err(CaptureTransitionError::new(
                            CaptureFailureKind::RuntimeTransition,
                            "Mish is shutting down and cannot apply a prepared proxy launch",
                        )),
                        activation_elapsed,
                        preflight_elapsed,
                        Duration::ZERO,
                        "cancelled",
                    )
                }
                Ok((preflight, activation_elapsed, preflight_elapsed)) => {
                    let capture_started = Instant::now();
                    let result = if !activation_started_for_launch
                        && before.runtime.tun_enabled != request.selection.tun
                    {
                        self.set_capture_inner(request, adapter_kind).await
                    } else {
                        self.host
                            .set_capture_with_preflight(request, adapter_kind, preflight)
                            .await
                    };
                    let outcome = if result.is_ok() {
                        "success"
                    } else {
                        "capture-failed"
                    };
                    (
                        result,
                        activation_elapsed,
                        preflight_elapsed,
                        capture_started.elapsed(),
                        outcome,
                    )
                }
            };
        let mut restore_prior_capture = true;
        if result.is_err() && activation_started_for_launch {
            let activation = self.activation_snapshot().await;
            if activation.command_id.as_deref() == Some(command_id)
                && activation.phase == ProfileActivationPhase::Success
                && !activation.safe_stopped
            {
                match self.rollback_failed_aggregate_activation().await {
                    Ok(()) => {
                        if let Some(error) = result.as_ref().err() {
                            self.host.record_application_event(
                                ApplicationDiagnosticEvent::capture_transition_failure(error),
                            );
                        }
                    }
                    Err(rollback_error) => {
                        result = Err(rollback_error);
                        restore_prior_capture = false;
                        outcome = "rollback-failed";
                    }
                }
            }
        }
        if result.is_err()
            && restore_prior_capture
            && let Some(prior_capture) = prior_capture
        {
            self.host.current().restore_capture_status(prior_capture);
        }
        self.record_launch_timing(
            launch_started,
            activation_elapsed,
            preflight_elapsed,
            preparation_wall,
            capture_elapsed,
            outcome,
        );
        result
    }

    fn record_launch_timing(
        &self,
        launch_started: Instant,
        profile_core: Duration,
        system_proxy_preflight: Duration,
        preparation_wall: Duration,
        listener_journal_mutation_confirmation: Duration,
        outcome: &'static str,
    ) {
        let overlap = profile_core
            .saturating_add(system_proxy_preflight)
            .saturating_sub(preparation_wall);
        let data = ProxyLaunchTimingApplicationEventData {
            listener_journal_mutation_confirmation_ms: launch_duration_milliseconds(
                listener_journal_mutation_confirmation,
            ),
            outcome: outcome.into(),
            overlap_ms: launch_duration_milliseconds(overlap),
            preparation_wall_ms: launch_duration_milliseconds(preparation_wall),
            profile_core_ms: launch_duration_milliseconds(profile_core),
            schema_version: 1,
            system_proxy_preflight_ms: launch_duration_milliseconds(system_proxy_preflight),
            total_ms: launch_duration_milliseconds(launch_started.elapsed()),
        };
        self.host
            .record_application_event(ApplicationDiagnosticEvent::proxy_launch_timing(data));
    }

    async fn rollback_failed_aggregate_activation(&self) -> Result<(), CaptureTransitionError> {
        let shutdown = self.manager.shutdown().await;
        let managed = self.manager.managed_state().await;
        let active_runtime = self.manager.active_runtime().await;
        let mut state = self.state.lock().await;
        state.cancellation = None;
        state.busy_profiles.clear();
        state.snapshot.evidence = None;
        state.snapshot.failure = Some(ProfileActivationFailure::Capture);
        state.snapshot.failure_endpoint = None;
        state.snapshot.phase = ProfileActivationPhase::Failure;
        match shutdown {
            Ok(()) => {
                self.host.replace(self.safe_runtime.clone());
                state.snapshot.active_fingerprint = None;
                state.snapshot.active_profile_id = None;
                state.snapshot.safe_stopped = true;
            }
            Err(_) => {
                if managed.is_safe_stopped() {
                    self.host.replace(self.safe_runtime.clone());
                } else if let Some(runtime) = active_runtime {
                    self.host.replace(runtime);
                }
                state.snapshot.active_fingerprint = managed.active_fingerprint().map(str::to_owned);
                state.snapshot.active_profile_id = managed.active_profile_id().map(str::to_owned);
                state.snapshot.safe_stopped = managed.is_safe_stopped();
                let _ = self.updates.send(state.snapshot.clone());
                return Err(CaptureTransitionError::new(
                    CaptureFailureKind::RollbackFailed,
                    "Capture failed and the newly started Mihomo core could not be stopped safely",
                ));
            }
        }
        let _ = self.updates.send(state.snapshot.clone());
        Ok(())
    }

    async fn wait_for_terminal_activation(
        &self,
        command_id: &str,
    ) -> Result<ProfileActivationSnapshot, CaptureTransitionError> {
        let current = self.activation_snapshot().await;
        if current.command_id.as_deref() == Some(command_id)
            && current.phase != ProfileActivationPhase::Pending
        {
            return Ok(current);
        }
        let mut updates = self.subscribe();
        loop {
            let snapshot = updates.recv().await.map_err(|_| {
                CaptureTransitionError::new(
                    CaptureFailureKind::RuntimeTransition,
                    "Profile activation updates became unavailable",
                )
            })?;
            if snapshot.command_id.as_deref() == Some(command_id)
                && snapshot.phase != ProfileActivationPhase::Pending
            {
                return Ok(snapshot);
            }
        }
    }

    pub async fn set_capture(
        self: &Arc<Self>,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, CaptureTransitionError> {
        if !request.active {
            let pending_command = {
                let state = self.state.lock().await;
                (state.snapshot.phase == ProfileActivationPhase::Pending)
                    .then(|| state.snapshot.command_id.clone())
                    .flatten()
            };
            if let Some(command_id) = pending_command {
                let _ = self.cancel(&command_id).await;
            }
            let _operation = self.proxy_operation.lock().await;
            return self.set_capture_inner(request, adapter_kind).await;
        }
        let _operation = self.proxy_operation.try_lock().map_err(|_| {
            CaptureTransitionError::new(
                CaptureFailureKind::RuntimeTransition,
                "Another aggregate proxy operation is already in progress",
            )
        })?;
        self.set_capture_inner(request, adapter_kind).await
    }

    async fn set_capture_inner(
        self: &Arc<Self>,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
    ) -> Result<Value, CaptureTransitionError> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::RuntimeTransition,
                "Mish is shutting down and cannot accept a new capture mutation",
            ));
        }
        let before = self
            .host
            .current()
            .status_snapshot_typed(adapter_kind)
            .await;
        let desired_tun = request.active && request.selection.tun;
        if before.runtime.tun_enabled == desired_tun {
            if self.shutting_down.load(Ordering::Acquire) {
                return Err(CaptureTransitionError::new(
                    CaptureFailureKind::RuntimeTransition,
                    "Mish is shutting down and cannot accept a new capture mutation",
                ));
            }
            return self.host.set_capture(request, adapter_kind).await;
        }
        let original_active = before.runtime.system_proxy.desired || before.runtime.tun.desired;
        let original_selection = before.runtime.capture_selection.clone();
        let mut policy_selection = request.selection.clone();
        policy_selection.tun = desired_tun;
        if desired_tun {
            policy_selection.system_proxy = false;
        }
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::RuntimeTransition,
                "Mish is shutting down and cannot accept a new capture mutation",
            ));
        }
        self.host
            .set_capture(
                CaptureRequest {
                    active: false,
                    selection: policy_selection,
                },
                adapter_kind,
            )
            .await?;
        let activation_result = self.reactivate_active().await;
        let reactivated = matches!(
            activation_result,
            Ok(ref snapshot) if snapshot.phase == ProfileActivationPhase::Success
        );
        if !reactivated {
            let _ = self
                .host
                .set_capture(
                    CaptureRequest {
                        active: original_active,
                        selection: original_selection,
                    },
                    adapter_kind,
                )
                .await;
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::RuntimeTransition,
                "Mihomo could not be reactivated with the requested TUN policy",
            ));
        }
        self.host.set_capture(request, adapter_kind).await
    }

    pub async fn stop(
        self: &Arc<Self>,
        command_id: &str,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        validate_command_id(command_id)?;
        {
            let state = self.state.lock().await;
            if state.snapshot.command_id.as_deref() == Some(command_id) {
                return Ok(state.snapshot.clone());
            }
            if state.snapshot.phase == ProfileActivationPhase::Pending {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
        }
        let permit = self.acquire_mutation()?;
        let pending = {
            let mut state = self.state.lock().await;
            if state.snapshot.command_id.as_deref() == Some(command_id) {
                return Ok(state.snapshot.clone());
            }
            if state.snapshot.phase == ProfileActivationPhase::Pending {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
            let active_profile_id = state.snapshot.active_profile_id.clone();
            if active_profile_id.is_some_and(|profile_id| !state.busy_profiles.insert(profile_id)) {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
            state.snapshot.command_id = Some(command_id.to_owned());
            state.snapshot.attempted_at = Some(now_unix_milliseconds());
            state.snapshot.failure = None;
            state.snapshot.evidence = None;
            state.snapshot.operation = Some(ProfileActivationOperation::Stop);
            state.snapshot.phase = ProfileActivationPhase::Pending;
            state.snapshot.target_profile_id = state.snapshot.active_profile_id.clone();
            state.snapshot.clone()
        };
        let _ = self.updates.send(pending.clone());
        let coordinator = self.clone();
        let command_id = command_id.to_owned();
        tokio::spawn(async move {
            let result = coordinator.manager.shutdown().await;
            coordinator.finish_stop(&command_id, result).await;
            drop(permit);
        });
        Ok(pending)
    }

    pub async fn delete_profile(
        &self,
        profile_id: &str,
    ) -> Result<ProfileSnapshot, ProfileActivationCoordinatorError> {
        let permit = self.acquire_mutation()?;
        let state = self.state.lock().await;
        if state.snapshot.phase == ProfileActivationPhase::Pending
            || state.snapshot.active_profile_id.as_deref() == Some(profile_id)
        {
            return Err(ProfileActivationCoordinatorError::Conflict);
        }
        let active_profile_id = state.snapshot.active_profile_id.clone();
        drop(state);
        let snapshot =
            self.profiles
                .delete_authorized(&permit, profile_id, active_profile_id.as_deref())?;
        self.manager.delete_route_selections(profile_id);
        self.publish().await;
        Ok(snapshot)
    }

    pub fn route_catalog(
        &self,
        profile_id: &str,
    ) -> Result<mish_profile::ProfileRouteCatalog, ProfileServiceError> {
        let record = self.profiles.activation_record(profile_id)?;
        let selections = self.manager.route_selections(&record);
        Ok(mish_profile::profile_route_catalog_with_selections(
            &record,
            &selections,
        )?)
    }

    pub async fn save_profile(
        &self,
        preview_id: &str,
    ) -> Result<ProfileSnapshot, ProfileActivationCoordinatorError> {
        let permit = self.acquire_mutation()?;
        let snapshot = self
            .profiles
            .save_preview_authorized(&permit, preview_id)
            .await?;
        self.publish().await;
        Ok(snapshot)
    }

    pub async fn activation_snapshot(&self) -> ProfileActivationSnapshot {
        self.state.lock().await.snapshot.clone()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<ProfileActivationSnapshot> {
        self.updates.subscribe()
    }

    pub async fn profile_snapshot(&self) -> Result<ProfileSnapshot, ProfileServiceError> {
        let mut snapshot = self.profiles.snapshot()?;
        let activation = self.activation_snapshot().await;
        snapshot.capabilities.activation = match activation.availability {
            ProfileActivationAvailability::Available => {
                mish_profile::ProfileCapabilityAvailability::Supported
            }
            ProfileActivationAvailability::MissingBinary
            | ProfileActivationAvailability::Unavailable => {
                mish_profile::ProfileCapabilityAvailability::Unavailable
            }
        };
        for profile in &mut snapshot.profiles {
            profile.status.active = activation.active_profile_id.as_deref() == Some(&profile.id);
            if profile.status.active {
                profile.status.stale |= activation.active_fingerprint.as_deref()
                    != Some(profile.effective_fingerprint.as_str());
            }
        }
        Ok(snapshot)
    }

    pub async fn managed_profile_snapshot(
        &self,
    ) -> Result<ManagedProfileSnapshot, ProfileServiceError> {
        let activation = self.activation_snapshot().await;
        let snapshot = self.profile_snapshot().await?;
        Ok(ManagedProfileSnapshot {
            activation,
            adapter_kind: snapshot.adapter_kind,
            capabilities: snapshot.capabilities,
            profiles: snapshot.profiles,
            providers: self.host.provider_snapshot(),
        })
    }

    pub async fn refresh_profile(
        &self,
        profile_id: &str,
        trigger: ProfileRefreshTrigger,
    ) -> Result<ProfileSnapshot, ProfileActivationCoordinatorError> {
        let permit = self.acquire_mutation()?;
        {
            let mut state = self.state.lock().await;
            if !state.busy_profiles.insert(profile_id.to_owned()) {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
        }
        if let Err(error) = self
            .profiles
            .mark_refresh_pending_authorized(&permit, profile_id)
        {
            self.release_profile(profile_id).await;
            return Err(error.into());
        }
        self.publish().await;
        let result = self
            .profiles
            .refresh_authorized(&permit, profile_id, trigger)
            .await;
        self.release_profile(profile_id).await;
        self.publish().await;
        result.map_err(Into::into)
    }

    pub async fn set_refresh_policy(
        &self,
        profile_id: &str,
        policy: ProfileRefreshPolicy,
    ) -> Result<ProfileSnapshot, ProfileActivationCoordinatorError> {
        let permit = self.acquire_mutation()?;
        {
            let mut state = self.state.lock().await;
            if !state.busy_profiles.insert(profile_id.to_owned()) {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
        }
        let result = self
            .profiles
            .set_refresh_policy_authorized(&permit, profile_id, policy);
        self.release_profile(profile_id).await;
        self.publish().await;
        result.map_err(Into::into)
    }

    pub async fn replace_patches(
        &self,
        profile_id: &str,
        source_revision: &str,
        artifact_fingerprint: &str,
        patches: Vec<ProfilePatch>,
    ) -> Result<ProfilePatchEditor, ProfileActivationCoordinatorError> {
        let permit = self.acquire_mutation()?;
        {
            let mut state = self.state.lock().await;
            if !state.busy_profiles.insert(profile_id.to_owned()) {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
        }
        let result = self.profiles.replace_patches_authorized(
            &permit,
            profile_id,
            source_revision,
            artifact_fingerprint,
            patches,
        );
        self.release_profile(profile_id).await;
        self.publish().await;
        result.map_err(Into::into)
    }

    pub async fn start_scheduler(self: &Arc<Self>) {
        let mut task = self.scheduler_task.lock().await;
        if task.is_some() {
            return;
        }
        let coordinator = self.clone();
        *task = Some(tokio::spawn(async move {
            let mut refresh_interval = tokio::time::interval(Duration::from_secs(60));
            refresh_interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = coordinator.scheduler_cancellation.cancelled() => return,
                    _ = refresh_interval.tick() => coordinator.run_due_refreshes().await,
                }
            }
        }));
    }

    pub async fn start_directory_reconciler(self: &Arc<Self>) {
        let mut task = self.directory_task.lock().await;
        if task.is_some() {
            return;
        }
        let coordinator = self.clone();
        *task = Some(tokio::spawn(async move {
            let mut interval = tokio::time::interval(Duration::from_secs(1));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = coordinator.scheduler_cancellation.cancelled() => return,
                    _ = interval.tick() => {
                        if matches!(
                            coordinator.profiles.reconcile_profile_directory().await,
                            Ok(true)
                        ) {
                            coordinator.publish().await;
                        }
                    },
                }
            }
        }));
    }

    async fn run_due_refreshes(&self) {
        let Ok(profile_ids) = self.profiles.due_scheduled_profile_ids(Timestamp::now()) else {
            return;
        };
        for profile_id in profile_ids {
            if self.scheduler_cancellation.is_cancelled() {
                return;
            }
            let _ = self
                .refresh_profile(&profile_id, ProfileRefreshTrigger::Scheduled)
                .await;
        }
    }

    pub async fn publish(&self) {
        let _ = self.updates.send(self.activation_snapshot().await);
    }

    pub fn mutation_authority(&self) -> StateMutationAuthority {
        self.authority.clone()
    }

    pub async fn active_profile_id_authorized(
        &self,
        permit: &StateMutationPermit,
    ) -> Result<Option<String>, ProfileActivationCoordinatorError> {
        self.authority
            .validate(permit)
            .map_err(|_| ProfileActivationCoordinatorError::Busy)?;
        Ok(self.state.lock().await.snapshot.active_profile_id.clone())
    }

    fn acquire_mutation(&self) -> Result<StateMutationPermit, ProfileActivationCoordinatorError> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(ProfileActivationCoordinatorError::Busy);
        }
        self.authority
            .try_acquire()
            .map_err(|_| ProfileActivationCoordinatorError::Busy)
    }

    pub async fn shutdown(&self) -> Result<(), ProfileActivationShutdownFailure> {
        self.shutdown_inner(false).await
    }

    pub async fn shutdown_for_exit(&self) -> Result<(), ProfileActivationShutdownFailure> {
        self.shutdown_inner(true).await
    }

    async fn shutdown_inner(&self, terminal: bool) -> Result<(), ProfileActivationShutdownFailure> {
        if self.shutting_down.swap(true, Ordering::AcqRel) {
            return Err(ProfileActivationShutdownFailure::MutationBusy);
        }
        self.scheduler_cancellation.cancel();
        if let Some(task) = self.scheduler_task.lock().await.take()
            && task.await.is_err()
        {
            self.shutting_down.store(false, Ordering::Release);
            return Err(ProfileActivationShutdownFailure::BackgroundTask);
        }
        if let Some(task) = self.directory_task.lock().await.take()
            && task.await.is_err()
        {
            self.shutting_down.store(false, Ordering::Release);
            return Err(ProfileActivationShutdownFailure::BackgroundTask);
        }
        if let Some(cancellation) = &self.state.lock().await.cancellation {
            cancellation.cancel();
        }
        let _proxy_operation = self.proxy_operation.lock().await;
        let permit = match self.authority.try_acquire() {
            Ok(permit) => permit,
            Err(_) => {
                self.shutting_down.store(false, Ordering::Release);
                return Err(ProfileActivationShutdownFailure::MutationBusy);
            }
        };
        if let Err(error) = self.manager.shutdown().await {
            self.shutting_down.store(false, Ordering::Release);
            return Err(match error {
                MihomoActivationError::CaptureFailed => {
                    ProfileActivationShutdownFailure::CaptureRestoration
                }
                MihomoActivationError::ShutdownFailed => ProfileActivationShutdownFailure::CoreStop,
                _ => ProfileActivationShutdownFailure::StateCommit,
            });
        }
        self.host.replace(self.safe_runtime.clone());
        let mut state = self.state.lock().await;
        state.cancellation = None;
        state.snapshot.evidence = None;
        state.snapshot.active_profile_id = None;
        state.snapshot.active_fingerprint = None;
        state.snapshot.safe_stopped = true;
        state.busy_profiles.clear();
        if terminal {
            self.authority.make_unavailable_until_restart();
        } else {
            self.shutting_down.store(false, Ordering::Release);
        }
        drop(permit);
        Ok(())
    }

    async fn release_profile(&self, profile_id: &str) {
        self.state.lock().await.busy_profiles.remove(profile_id);
    }

    async fn record_geodata_evidence(
        &self,
        command_id: &str,
        event: crate::GeodataValidationEvent,
    ) {
        let (kind, asset) = match event {
            crate::GeodataValidationEvent::Preparing(asset) => {
                (ProfileActivationEvidenceKind::GeodataPreparing, asset)
            }
            crate::GeodataValidationEvent::Failed(asset) => {
                (ProfileActivationEvidenceKind::GeodataFailed, asset)
            }
        };
        let evidence = ProfileActivationEvidence { asset, kind };
        let mut state = self.state.lock().await;
        if state.snapshot.command_id.as_deref() != Some(command_id)
            || state.snapshot.phase != ProfileActivationPhase::Pending
            || state.snapshot.evidence == Some(evidence)
        {
            return;
        }
        state.snapshot.evidence = Some(evidence);
        let _ = self.updates.send(state.snapshot.clone());
        drop(state);
        if kind == ProfileActivationEvidenceKind::GeodataPreparing {
            let _ = self.host.publish_notification(NotificationPublication {
                dedupe_key: geodata_notification_key(command_id, asset),
                pinned: true,
                presentation: geodata_progress_notification(asset),
                replaces: Vec::new(),
                resolved: false,
                severity: NotificationSeverity::Info,
            });
        }
    }

    async fn finish_preflight_activation(
        &self,
        command_id: &str,
        failure: ProfileActivationFailure,
    ) {
        let mut state = self.state.lock().await;
        if state.snapshot.command_id.as_deref() != Some(command_id) {
            return;
        }
        if let Some(profile_id) = state.snapshot.target_profile_id.clone() {
            state.busy_profiles.remove(&profile_id);
        }
        state.cancellation = None;
        state.snapshot.failure = Some(failure);
        state.snapshot.phase = ProfileActivationPhase::Failure;
        let _ = self.updates.send(state.snapshot.clone());
        drop(state);
        resolve_geodata_notifications(&self.host, command_id, None);
        self.host
            .record_application_event(ApplicationDiagnosticEvent::profile_activation_failure(
                profile_activation_failure_id(failure),
            ));
        let _ = self.host.publish_notification(NotificationPublication {
            dedupe_key: format!("profile.activation-failure:{command_id}"),
            pinned: false,
            presentation: profile_activation_failure_notification(failure),
            replaces: Vec::new(),
            resolved: false,
            severity: NotificationSeverity::Error,
        });
    }

    async fn finish_activation(
        &self,
        command_id: &str,
        result: Result<crate::ActivationCommit, MihomoActivationError>,
    ) {
        let managed = self.manager.managed_state().await;
        let active_runtime = self.manager.active_runtime().await;
        let mut state = self.state.lock().await;
        if state.snapshot.command_id.as_deref() != Some(command_id) {
            return;
        }
        if let Some(profile_id) = state.snapshot.target_profile_id.clone() {
            state.busy_profiles.remove(&profile_id);
        }
        state.cancellation = None;
        match result {
            Ok(commit) => {
                let Some(runtime) = active_runtime else {
                    state.snapshot.failure = Some(ProfileActivationFailure::StateCommit);
                    state.snapshot.phase = ProfileActivationPhase::Failure;
                    let _ = self.updates.send(state.snapshot.clone());
                    drop(state);
                    self.host.record_application_event(activation_failure_event(
                        MihomoActivationError::StateCommitFailed,
                    ));
                    publish_activation_failure_notification(
                        &self.host,
                        command_id,
                        MihomoActivationError::StateCommitFailed,
                    );
                    return;
                };
                self.host.replace(runtime);
                self.manager.complete_runtime_handoff().await;
                state.snapshot.active_fingerprint = Some(commit.fingerprint().to_owned());
                state.snapshot.active_profile_id = Some(commit.profile_id().to_owned());
                state.snapshot.failure = None;
                state.snapshot.evidence = None;
                state.snapshot.failure_endpoint = None;
                state.snapshot.phase = ProfileActivationPhase::Success;
                state.snapshot.safe_stopped = false;
            }
            Err(error) => {
                if managed.is_safe_stopped() {
                    self.host.replace(self.safe_runtime.clone());
                } else if let Some(runtime) = active_runtime {
                    self.host.replace(runtime);
                }
                self.manager.complete_runtime_handoff().await;
                state.snapshot.active_fingerprint = managed.active_fingerprint().map(str::to_owned);
                state.snapshot.active_profile_id = managed.active_profile_id().map(str::to_owned);
                state.snapshot.failure = Some(map_failure(error));
                state.snapshot.evidence = terminal_geodata_evidence(error);
                state.snapshot.failure_endpoint = managed_listener_endpoint(error);
                state.snapshot.phase = ProfileActivationPhase::Failure;
                state.snapshot.safe_stopped = managed.is_safe_stopped();
                let diagnostic = activation_failure_event(error);
                let snapshot = state.snapshot.clone();
                let _ = self.updates.send(snapshot);
                drop(state);
                self.host.record_application_event(diagnostic);
                publish_activation_failure_notification(&self.host, command_id, error);
                return;
            }
        }
        let _ = self.updates.send(state.snapshot.clone());
        drop(state);
        resolve_geodata_notifications(&self.host, command_id, None);
    }

    async fn finish_stop(&self, command_id: &str, result: Result<(), MihomoActivationError>) {
        let managed = self.manager.managed_state().await;
        let active_runtime = self.manager.active_runtime().await;
        let mut state = self.state.lock().await;
        if state.snapshot.command_id.as_deref() != Some(command_id) {
            return;
        }
        if let Some(profile_id) = state.snapshot.target_profile_id.clone() {
            state.busy_profiles.remove(&profile_id);
        }
        match result {
            Ok(()) => {
                self.host.replace(self.safe_runtime.clone());
                state.snapshot.active_fingerprint = None;
                state.snapshot.active_profile_id = None;
                state.snapshot.failure = None;
                state.snapshot.evidence = None;
                state.snapshot.phase = ProfileActivationPhase::Success;
                state.snapshot.safe_stopped = true;
            }
            Err(error) => {
                if managed.is_safe_stopped() {
                    self.host.replace(self.safe_runtime.clone());
                } else if let Some(runtime) = active_runtime {
                    self.host.replace(runtime);
                }
                state.snapshot.active_fingerprint = managed.active_fingerprint().map(str::to_owned);
                state.snapshot.active_profile_id = managed.active_profile_id().map(str::to_owned);
                state.snapshot.failure = Some(map_failure(error));
                state.snapshot.evidence = terminal_geodata_evidence(error);
                state.snapshot.phase = ProfileActivationPhase::Failure;
                state.snapshot.safe_stopped = managed.is_safe_stopped();
            }
        }
        let _ = self.updates.send(state.snapshot.clone());
    }
}

fn launch_duration_milliseconds(duration: Duration) -> u64 {
    if duration.is_zero() {
        return 0;
    }
    u64::try_from(duration.as_millis())
        .unwrap_or(u64::MAX)
        .max(1)
}

fn profile_launch_error(error: ProfileActivationCoordinatorError) -> CaptureTransitionError {
    CaptureTransitionError::new(
        CaptureFailureKind::RuntimeTransition,
        match error {
            ProfileActivationCoordinatorError::Conflict
            | ProfileActivationCoordinatorError::Busy => {
                "Another proxy launch is already in progress"
            }
            ProfileActivationCoordinatorError::Unavailable => "Profile activation is unavailable",
            _ => "Profile activation could not be prepared",
        },
    )
}

fn usable_capture_selection(
    adapter_kind: StatusAdapterKind,
    capabilities: &mish_runtime::PlatformCapabilities,
    mut selection: CaptureSelection,
) -> Result<CaptureSelection, CaptureTransitionError> {
    let available = |availability| {
        matches!(
            (adapter_kind, availability),
            (
                StatusAdapterKind::Native,
                CapabilityAvailability::FixtureOnly
            ) | (_, CapabilityAvailability::Supported)
        )
    };
    selection.system_proxy &= available(capabilities.system_proxy);
    selection.tun &= available(capabilities.tun);
    if !selection.system_proxy && !selection.tun {
        selection.system_proxy = available(capabilities.system_proxy);
        selection.tun = !selection.system_proxy && available(capabilities.tun);
    }
    if selection.system_proxy || selection.tun {
        Ok(selection)
    } else {
        Err(CaptureTransitionError::new(
            CaptureFailureKind::UnsupportedSelection,
            "No available Capture mode can be launched on this system",
        ))
    }
}

fn validate_command_id(command_id: &str) -> Result<(), ProfileActivationCoordinatorError> {
    Uuid::parse_str(command_id)
        .map(|_| ())
        .map_err(|_| ProfileActivationCoordinatorError::InvalidCommand)
}

fn now_unix_milliseconds() -> u64 {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(milliseconds).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod capture_selection_tests {
    use std::time::Duration;

    use super::{launch_duration_milliseconds, usable_capture_selection};
    use mish_runtime::{
        CapabilityAvailability, CaptureSelection, PlatformCapabilities, StatusAdapterKind,
    };

    fn capabilities(
        system_proxy: CapabilityAvailability,
        tun: CapabilityAvailability,
    ) -> PlatformCapabilities {
        PlatformCapabilities { system_proxy, tun }
    }

    #[test]
    fn native_launch_selection_preserves_remembered_modes_and_falls_back_deterministically() {
        let supported = capabilities(
            CapabilityAvailability::Supported,
            CapabilityAvailability::Supported,
        );
        assert_eq!(
            usable_capture_selection(
                StatusAdapterKind::Native,
                &supported,
                CaptureSelection {
                    system_proxy: false,
                    tun: true
                },
            )
            .unwrap(),
            CaptureSelection {
                system_proxy: false,
                tun: true
            }
        );
        assert_eq!(
            usable_capture_selection(
                StatusAdapterKind::Native,
                &supported,
                CaptureSelection {
                    system_proxy: false,
                    tun: false
                },
            )
            .unwrap(),
            CaptureSelection {
                system_proxy: true,
                tun: false
            }
        );
        assert_eq!(
            usable_capture_selection(
                StatusAdapterKind::Native,
                &capabilities(
                    CapabilityAvailability::Unavailable,
                    CapabilityAvailability::Supported
                ),
                CaptureSelection {
                    system_proxy: true,
                    tun: false
                },
            )
            .unwrap(),
            CaptureSelection {
                system_proxy: false,
                tun: true
            }
        );
        assert!(
            usable_capture_selection(
                StatusAdapterKind::Native,
                &capabilities(
                    CapabilityAvailability::Unavailable,
                    CapabilityAvailability::Unavailable
                ),
                CaptureSelection {
                    system_proxy: false,
                    tun: false
                },
            )
            .is_err()
        );
    }

    #[test]
    fn launch_timing_preserves_sub_millisecond_work_without_inventing_zero_duration() {
        assert_eq!(launch_duration_milliseconds(Duration::ZERO), 0);
        assert_eq!(launch_duration_milliseconds(Duration::from_nanos(1)), 1);
        assert_eq!(launch_duration_milliseconds(Duration::from_millis(12)), 12);
    }
}

fn map_availability(availability: Result<(), MihomoResolveError>) -> ProfileActivationAvailability {
    match availability {
        Ok(()) => ProfileActivationAvailability::Available,
        Err(MihomoResolveError::BinaryMissing) => ProfileActivationAvailability::MissingBinary,
        Err(MihomoResolveError::UnsafeManagedPath | MihomoResolveError::RuntimeRootUnavailable) => {
            ProfileActivationAvailability::Unavailable
        }
    }
}

fn map_failure(error: MihomoActivationError) -> ProfileActivationFailure {
    match error {
        MihomoActivationError::InvalidArtifact | MihomoActivationError::InvalidTiming => {
            ProfileActivationFailure::InvalidProfile
        }
        MihomoActivationError::Resolve(MihomoResolveError::BinaryMissing) => {
            ProfileActivationFailure::MissingBinary
        }
        MihomoActivationError::Resolve(_) => ProfileActivationFailure::UnsafeRuntime,
        MihomoActivationError::StagingFailed => ProfileActivationFailure::Staging,
        MihomoActivationError::ValidationFailed => ProfileActivationFailure::Validation,
        MihomoActivationError::GeodataFailed(_) => ProfileActivationFailure::GeodataFailed,
        MihomoActivationError::GeodataTimeout(_) => ProfileActivationFailure::GeodataTimeout,
        MihomoActivationError::StartFailed => ProfileActivationFailure::Start,
        MihomoActivationError::EarlyExit => ProfileActivationFailure::EarlyExit,
        MihomoActivationError::ManagedListenerConflict(_) => {
            ProfileActivationFailure::ManagedListenerConflict
        }
        MihomoActivationError::VersionMismatch => ProfileActivationFailure::VersionMismatch,
        MihomoActivationError::ControllerFailure => ProfileActivationFailure::Controller,
        MihomoActivationError::ReadinessTimeout => ProfileActivationFailure::Timeout,
        MihomoActivationError::Cancelled => ProfileActivationFailure::Cancelled,
        MihomoActivationError::CaptureFailed => ProfileActivationFailure::Capture,
        MihomoActivationError::PriorStopFailed => ProfileActivationFailure::PriorStop,
        MihomoActivationError::StateCommitFailed
        | MihomoActivationError::RollbackFailedSafeStopped
        | MihomoActivationError::ShutdownFailed
        | MihomoActivationError::OwnershipFailed => ProfileActivationFailure::StateCommit,
    }
}

fn managed_listener_endpoint(error: MihomoActivationError) -> Option<String> {
    match error {
        MihomoActivationError::ManagedListenerConflict(endpoint) => Some(endpoint.to_string()),
        _ => None,
    }
}

fn terminal_geodata_evidence(error: MihomoActivationError) -> Option<ProfileActivationEvidence> {
    match error {
        MihomoActivationError::GeodataFailed(asset) => Some(ProfileActivationEvidence {
            asset,
            kind: ProfileActivationEvidenceKind::GeodataFailed,
        }),
        MihomoActivationError::GeodataTimeout(asset) => Some(ProfileActivationEvidence {
            asset,
            kind: ProfileActivationEvidenceKind::GeodataTimeout,
        }),
        _ => None,
    }
}

fn geodata_notification_key(command_id: &str, asset: crate::GeodataAsset) -> String {
    format!(
        "profile.activation-geodata:{command_id}:{}",
        geodata_asset_slug(asset)
    )
}

fn geodata_asset_slug(asset: crate::GeodataAsset) -> &'static str {
    match asset {
        crate::GeodataAsset::GeoIp => "geoip",
        crate::GeodataAsset::GeoSite => "geosite",
        crate::GeodataAsset::Mmdb => "mmdb",
        crate::GeodataAsset::Asn => "asn",
    }
}

fn profile_activation_failure_id(failure: ProfileActivationFailure) -> &'static str {
    match failure {
        ProfileActivationFailure::InvalidProfile => "invalid-profile",
        ProfileActivationFailure::MissingBinary => "missing-binary",
        ProfileActivationFailure::UnsafeRuntime => "unsafe-runtime",
        ProfileActivationFailure::Staging => "staging",
        ProfileActivationFailure::Validation => "validation",
        ProfileActivationFailure::GeodataFailed => "geodata-failed",
        ProfileActivationFailure::GeodataTimeout => "geodata-timeout",
        ProfileActivationFailure::Start => "start",
        ProfileActivationFailure::EarlyExit => "early-exit",
        ProfileActivationFailure::ManagedListenerConflict => "managed-listener-conflict",
        ProfileActivationFailure::VersionMismatch => "version-mismatch",
        ProfileActivationFailure::Controller => "controller",
        ProfileActivationFailure::Timeout => "timeout",
        ProfileActivationFailure::Cancelled => "cancelled",
        ProfileActivationFailure::Capture => "capture",
        ProfileActivationFailure::PriorStop => "prior-stop",
        ProfileActivationFailure::StateCommit => "state-commit",
    }
}

fn profile_activation_failure_notification(
    failure: ProfileActivationFailure,
) -> ApplicationNotification {
    ApplicationNotification::new(
        ApplicationNotificationContent::ProfileActivationFailed(
            ProfileActivationFailedApplicationNotificationData {
                failure: profile_activation_failure_id(failure).into(),
            },
        ),
        vec![ApplicationActionId::OpenDiagnostics],
    )
}

fn geodata_progress_notification(asset: crate::GeodataAsset) -> ApplicationNotification {
    let asset_id = geodata_asset_slug(asset).to_owned();
    let content = match asset {
        crate::GeodataAsset::GeoIp => {
            ApplicationNotificationContent::ProfileActivationGeoipProgress(
                ProfileActivationGeoipProgressApplicationNotificationData { asset: asset_id },
            )
        }
        crate::GeodataAsset::GeoSite => {
            ApplicationNotificationContent::ProfileActivationGeositeProgress(
                ProfileActivationGeositeProgressApplicationNotificationData { asset: asset_id },
            )
        }
        crate::GeodataAsset::Mmdb => ApplicationNotificationContent::ProfileActivationMmdbProgress(
            ProfileActivationMmdbProgressApplicationNotificationData { asset: asset_id },
        ),
        crate::GeodataAsset::Asn => ApplicationNotificationContent::ProfileActivationAsnProgress(
            ProfileActivationAsnProgressApplicationNotificationData { asset: asset_id },
        ),
    };
    ApplicationNotification::new(content, Vec::new())
}

fn geodata_failure_notification(
    asset: crate::GeodataAsset,
    outcome: &str,
) -> ApplicationNotification {
    let asset_id = geodata_asset_slug(asset).to_owned();
    let outcome = outcome.to_owned();
    let content = match asset {
        crate::GeodataAsset::GeoIp => ApplicationNotificationContent::ProfileActivationGeoipFailed(
            ProfileActivationGeoipFailedApplicationNotificationData {
                asset: asset_id,
                outcome,
            },
        ),
        crate::GeodataAsset::GeoSite => {
            ApplicationNotificationContent::ProfileActivationGeositeFailed(
                ProfileActivationGeositeFailedApplicationNotificationData {
                    asset: asset_id,
                    outcome,
                },
            )
        }
        crate::GeodataAsset::Mmdb => ApplicationNotificationContent::ProfileActivationMmdbFailed(
            ProfileActivationMmdbFailedApplicationNotificationData {
                asset: asset_id,
                outcome,
            },
        ),
        crate::GeodataAsset::Asn => ApplicationNotificationContent::ProfileActivationAsnFailed(
            ProfileActivationAsnFailedApplicationNotificationData {
                asset: asset_id,
                outcome,
            },
        ),
    };
    ApplicationNotification::new(content, Vec::new())
}

fn resolve_geodata_notifications(
    host: &DesktopRuntimeHost,
    command_id: &str,
    except: Option<crate::GeodataAsset>,
) {
    for asset in [
        crate::GeodataAsset::GeoIp,
        crate::GeodataAsset::GeoSite,
        crate::GeodataAsset::Mmdb,
        crate::GeodataAsset::Asn,
    ] {
        if Some(asset) != except {
            host.resolve_notification(&geodata_notification_key(command_id, asset));
        }
    }
}

fn activation_failure_event(error: MihomoActivationError) -> ApplicationDiagnosticEvent {
    ApplicationDiagnosticEvent::profile_activation_failure(profile_activation_failure_id(
        map_failure(error),
    ))
}

fn publish_activation_failure_notification(
    host: &DesktopRuntimeHost,
    command_id: &str,
    error: MihomoActivationError,
) {
    let failing_geodata = match error {
        MihomoActivationError::GeodataFailed(asset)
        | MihomoActivationError::GeodataTimeout(asset) => Some(asset),
        _ => None,
    };
    resolve_geodata_notifications(host, command_id, failing_geodata);
    let (dedupe_key, presentation) = match error {
        MihomoActivationError::GeodataFailed(asset) => (
            geodata_notification_key(command_id, asset),
            geodata_failure_notification(asset, "failed"),
        ),
        MihomoActivationError::GeodataTimeout(asset) => (
            geodata_notification_key(command_id, asset),
            geodata_failure_notification(asset, "timeout"),
        ),
        MihomoActivationError::ManagedListenerConflict(endpoint) => (
            format!("profile.activation-failure:{command_id}"),
            ApplicationNotification::new(
                ApplicationNotificationContent::ProfileActivationListenerConflict(
                    ProfileActivationListenerConflictApplicationNotificationData {
                        endpoint: endpoint.to_string(),
                    },
                ),
                vec![ApplicationActionId::FindPortsAndRetry],
            ),
        ),
        _ => (
            format!("profile.activation-failure:{command_id}"),
            profile_activation_failure_notification(map_failure(error)),
        ),
    };
    let _ = host.publish_notification(NotificationPublication {
        dedupe_key,
        pinned: false,
        presentation,
        replaces: vec!["status.operation-failed".into()],
        resolved: false,
        severity: NotificationSeverity::Error,
    });
}
