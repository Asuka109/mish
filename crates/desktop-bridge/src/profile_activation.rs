use std::{
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};

use mish_profile::{
    ProfileAdapterKind, ProfileCapabilities, ProfileListItem, ProfileServiceError, ProfileSnapshot,
};
use mish_runtime::MishRuntime;
use serde::Serialize;
use tokio::sync::{Mutex, broadcast};
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
}

impl ManagedProfileSnapshot {
    pub fn unavailable(snapshot: ProfileSnapshot) -> Self {
        Self {
            activation: ProfileActivationSnapshot::unavailable(),
            adapter_kind: snapshot.adapter_kind,
            capabilities: snapshot.capabilities,
            profiles: snapshot.profiles,
        }
    }
}

impl ProfileActivationSnapshot {
    pub fn unavailable() -> Self {
        Self {
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
    cancellation: Option<CancellationToken>,
    snapshot: ProfileActivationSnapshot,
}

type PolicyFactory =
    dyn Fn() -> Result<ManagedRuntimePolicy, RuntimeConfigGenerationError> + Send + Sync;

pub struct ProfileActivationCoordinator {
    host: DesktopRuntimeHost,
    manager: Arc<MihomoActivationManager>,
    policy_factory: Arc<PolicyFactory>,
    profiles: Arc<DesktopProfileService>,
    safe_runtime: MishRuntime,
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
            host,
            manager,
            policy_factory: Arc::new(policy_factory),
            profiles,
            safe_runtime,
            state: Mutex::new(CoordinatorState {
                cancellation: None,
                snapshot: ProfileActivationSnapshot {
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
        let record = self.profiles.activation_record(profile_id)?;
        let policy = (self.policy_factory)()
            .map_err(|_| ProfileActivationCoordinatorError::PolicyUnavailable)?;
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
        let pending = {
            let mut state = self.state.lock().await;
            if state.snapshot.command_id.as_deref() == Some(command_id) {
                return Ok(state.snapshot.clone());
            }
            if state.snapshot.phase == ProfileActivationPhase::Pending {
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
        });
        Ok(pending)
    }

    pub async fn delete_profile(
        &self,
        profile_id: &str,
    ) -> Result<ProfileSnapshot, ProfileActivationCoordinatorError> {
        let state = self.state.lock().await;
        if state.snapshot.phase == ProfileActivationPhase::Pending
            || state.snapshot.active_profile_id.as_deref() == Some(profile_id)
        {
            return Err(ProfileActivationCoordinatorError::Conflict);
        }
        let active_profile_id = state.snapshot.active_profile_id.clone();
        drop(state);
        Ok(self
            .profiles
            .delete_authorized(profile_id, active_profile_id.as_deref())?)
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
        })
    }

    pub async fn publish(&self) {
        let _ = self.updates.send(self.activation_snapshot().await);
    }

    pub async fn shutdown(&self) -> Result<(), ProfileActivationCoordinatorError> {
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
        state.snapshot.safe_stopped = true;
        Ok(())
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
        match result {
            Ok(()) => {
                self.host.replace(self.safe_runtime.clone());
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
