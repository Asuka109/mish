use std::{
    collections::HashSet,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use mish_profile::{
    ProfileAdapterKind, ProfileCapabilities, ProfileListItem, ProfilePatch, ProfilePatchEditor,
    ProfileRefreshPolicy, ProfileRefreshTrigger, ProfileServiceError, ProfileSnapshot, Timestamp,
};
use mish_runtime::{MishRuntime, ProviderSnapshot};
use mish_state_authority::{StateMutationAuthority, StateMutationPermit};
use serde::Serialize;
use tokio::{
    sync::{Mutex, broadcast},
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
    Start,
    EarlyExit,
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
    pub failure: Option<ProfileActivationFailure>,
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
            failure: None,
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
    safe_runtime: MishRuntime,
    scheduler_cancellation: CancellationToken,
    scheduler_task: Mutex<Option<JoinHandle<()>>>,
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
            safe_runtime,
            scheduler_cancellation: CancellationToken::new(),
            scheduler_task: Mutex::new(None),
            state: Mutex::new(CoordinatorState {
                busy_profiles: HashSet::new(),
                cancellation: None,
                snapshot: ProfileActivationSnapshot {
                    active_fingerprint: None,
                    active_profile_id: None,
                    attempted_at: None,
                    availability,
                    command_id: None,
                    failure: None,
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
        if self.activation_snapshot().await.availability != ProfileActivationAvailability::Available
        {
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
        {
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
        }
        let record = match self.profiles.activation_record(profile_id) {
            Ok(record) => record,
            Err(error) => {
                self.release_profile(profile_id).await;
                return Err(error.into());
            }
        };
        let policy = (self.policy_factory)()
            .map_err(|_| ProfileActivationCoordinatorError::PolicyUnavailable);
        let policy = match policy {
            Ok(policy) => policy,
            Err(error) => {
                self.release_profile(profile_id).await;
                return Err(error);
            }
        };
        let cancellation = CancellationToken::new();
        let pending = {
            let mut state = self.state.lock().await;
            if state.snapshot.phase == ProfileActivationPhase::Pending {
                state.busy_profiles.remove(profile_id);
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
            state.cancellation = Some(cancellation.clone());
            state.snapshot.command_id = Some(command_id.to_owned());
            state.snapshot.attempted_at = Some(now_unix_milliseconds());
            state.snapshot.failure = None;
            state.snapshot.operation = Some(ProfileActivationOperation::Activate);
            state.snapshot.phase = ProfileActivationPhase::Pending;
            state.snapshot.target_profile_id = Some(profile_id.to_owned());
            state.snapshot.clone()
        };
        let _ = self.updates.send(pending.clone());
        let coordinator = self.clone();
        let command_id = command_id.to_owned();
        tokio::spawn(async move {
            let result = coordinator
                .manager
                .activate_cancellable(&record, &policy, cancellation)
                .await;
            coordinator.finish_activation(&command_id, result).await;
            drop(permit);
        });
        Ok(pending)
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
        self.publish().await;
        Ok(snapshot)
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
            let mut interval = tokio::time::interval(Duration::from_secs(60));
            interval.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
            loop {
                tokio::select! {
                    _ = coordinator.scheduler_cancellation.cancelled() => return,
                    _ = interval.tick() => coordinator.run_due_refreshes().await,
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
        self.authority
            .try_acquire()
            .map_err(|_| ProfileActivationCoordinatorError::Busy)
    }

    pub async fn shutdown(&self) -> Result<(), ProfileActivationCoordinatorError> {
        self.scheduler_cancellation.cancel();
        if let Some(task) = self.scheduler_task.lock().await.take() {
            let _ = task.await;
        }
        if let Some(cancellation) = &self.state.lock().await.cancellation {
            cancellation.cancel();
        }
        self.manager
            .shutdown()
            .await
            .map_err(|_| ProfileActivationCoordinatorError::ShutdownFailed)?;
        self.host.replace(self.safe_runtime.clone());
        let mut state = self.state.lock().await;
        state.cancellation = None;
        state.snapshot.active_profile_id = None;
        state.snapshot.active_fingerprint = None;
        state.snapshot.safe_stopped = true;
        state.busy_profiles.clear();
        Ok(())
    }

    async fn release_profile(&self, profile_id: &str) {
        self.state.lock().await.busy_profiles.remove(profile_id);
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
                    return;
                };
                self.host.replace(runtime);
                self.manager.complete_runtime_handoff().await;
                state.snapshot.active_fingerprint = Some(commit.fingerprint().to_owned());
                state.snapshot.active_profile_id = Some(commit.profile_id().to_owned());
                state.snapshot.failure = None;
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
                state.snapshot.phase = ProfileActivationPhase::Failure;
                state.snapshot.safe_stopped = managed.is_safe_stopped();
            }
        }
        let _ = self.updates.send(state.snapshot.clone());
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
                state.snapshot.phase = ProfileActivationPhase::Failure;
                state.snapshot.safe_stopped = managed.is_safe_stopped();
            }
        }
        let _ = self.updates.send(state.snapshot.clone());
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
        MihomoActivationError::StartFailed => ProfileActivationFailure::Start,
        MihomoActivationError::EarlyExit => ProfileActivationFailure::EarlyExit,
        MihomoActivationError::VersionMismatch => ProfileActivationFailure::VersionMismatch,
        MihomoActivationError::ControllerFailure => ProfileActivationFailure::Controller,
        MihomoActivationError::ReadinessTimeout => ProfileActivationFailure::Timeout,
        MihomoActivationError::Cancelled => ProfileActivationFailure::Cancelled,
        MihomoActivationError::CaptureFailed => ProfileActivationFailure::Capture,
        MihomoActivationError::PriorStopFailed => ProfileActivationFailure::PriorStop,
        MihomoActivationError::StateCommitFailed
        | MihomoActivationError::RollbackFailedSafeStopped
        | MihomoActivationError::ShutdownFailed => ProfileActivationFailure::StateCommit,
    }
}
