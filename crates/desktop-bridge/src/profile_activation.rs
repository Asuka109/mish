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
    ProfileRefreshPolicy, ProfileRefreshTrigger, ProfileSelectionSnapshot, ProfileServiceError,
    ProfileSnapshot, Timestamp,
};
use mish_runtime::{
    ApplicationActionId, ApplicationDiagnosticEvent, ApplicationNotification,
    ApplicationNotificationContent, CapabilityAvailability, CaptureFailureKind, CaptureRequest,
    CaptureSelection, CaptureTransitionError, MishRuntime, NotificationPublication,
    NotificationSeverity, ProfileActivationAsnFailedApplicationNotificationData,
    ProfileActivationFailedApplicationNotificationData,
    ProfileActivationGeoipFailedApplicationNotificationData,
    ProfileActivationGeositeFailedApplicationNotificationData,
    ProfileActivationListenerConflictApplicationNotificationData,
    ProfileActivationMmdbFailedApplicationNotificationData, ProviderSnapshot,
    ProxyLaunchTimingApplicationEventData, StatusAdapterKind,
};
use mish_state_authority::{StateMutationAuthority, StateMutationPermit};
use serde::Serialize;
use serde_json::Value;
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
    pub application_order: mish_runtime::ApplicationSnapshotOrder,
    pub capabilities: ProfileCapabilities,
    pub profiles: Vec<ProfileListItem>,
    pub providers: ProviderSnapshot,
    pub selection: ProfileSelectionSnapshot,
}

impl ManagedProfileSnapshot {
    pub fn unavailable(mut snapshot: ProfileSnapshot) -> Self {
        snapshot.capabilities.scheduling = mish_profile::ProfileCapabilityAvailability::Unavailable;
        Self {
            activation: ProfileActivationSnapshot::unavailable(),
            adapter_kind: snapshot.adapter_kind,
            application_order: mish_runtime::ApplicationSnapshotOrder::detached(),
            capabilities: snapshot.capabilities,
            profiles: snapshot.profiles,
            providers: ProviderSnapshot::unavailable(),
            selection: snapshot.selection,
        }
    }
}

impl ProfileActivationSnapshot {
    pub fn unavailable() -> Self {
        ProfileActivationState::Shutdown {
            scope: ProfileActivationScope::new(),
        }
        .to_snapshot(ProfileActivationAvailability::Unavailable)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProfileActivationScope {
    authority_id: Uuid,
    revision: u64,
}

impl ProfileActivationScope {
    fn new() -> Self {
        Self {
            authority_id: Uuid::new_v4(),
            revision: 0,
        }
    }

    fn next(&self) -> Self {
        Self {
            authority_id: self.authority_id,
            revision: self
                .revision
                .checked_add(1)
                .expect("Profile activation revision exhausted"),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ProfileActivationRuntime {
    SafeStopped,
    Active {
        fingerprint: String,
        profile_id: String,
    },
}

impl ProfileActivationRuntime {
    fn active_profile_id(&self) -> Option<&str> {
        match self {
            Self::SafeStopped => None,
            Self::Active { profile_id, .. } => Some(profile_id),
        }
    }

    fn fingerprint(&self) -> Option<&str> {
        match self {
            Self::SafeStopped => None,
            Self::Active { fingerprint, .. } => Some(fingerprint),
        }
    }

    fn is_safe_stopped(&self) -> bool {
        matches!(self, Self::SafeStopped)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct ProfileActivationCommand {
    attempted_at: u64,
    command_id: String,
    operation: ProfileActivationOperation,
    scope: ProfileActivationScope,
    target_profile_id: String,
}

#[derive(Clone, Debug)]
struct ProfileActivationPending {
    cancellation: CancellationToken,
    command: ProfileActivationCommand,
    evidence: Option<ProfileActivationEvidence>,
    runtime: ProfileActivationRuntime,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ProfileActivationFailureEvidence {
    InvalidProfile,
    MissingBinary,
    UnsafeRuntime,
    Staging,
    Validation,
    GeodataFailed(crate::GeodataAsset),
    GeodataTimeout(crate::GeodataAsset),
    Start,
    EarlyExit,
    ManagedListenerConflict(String),
    VersionMismatch,
    Controller,
    Timeout,
    Capture,
    PriorStop,
    StateCommit,
}

impl ProfileActivationFailureEvidence {
    fn failure(&self) -> ProfileActivationFailure {
        match self {
            Self::InvalidProfile => ProfileActivationFailure::InvalidProfile,
            Self::MissingBinary => ProfileActivationFailure::MissingBinary,
            Self::UnsafeRuntime => ProfileActivationFailure::UnsafeRuntime,
            Self::Staging => ProfileActivationFailure::Staging,
            Self::Validation => ProfileActivationFailure::Validation,
            Self::GeodataFailed(_) => ProfileActivationFailure::GeodataFailed,
            Self::GeodataTimeout(_) => ProfileActivationFailure::GeodataTimeout,
            Self::Start => ProfileActivationFailure::Start,
            Self::EarlyExit => ProfileActivationFailure::EarlyExit,
            Self::ManagedListenerConflict(_) => ProfileActivationFailure::ManagedListenerConflict,
            Self::VersionMismatch => ProfileActivationFailure::VersionMismatch,
            Self::Controller => ProfileActivationFailure::Controller,
            Self::Timeout => ProfileActivationFailure::Timeout,
            Self::Capture => ProfileActivationFailure::Capture,
            Self::PriorStop => ProfileActivationFailure::PriorStop,
            Self::StateCommit => ProfileActivationFailure::StateCommit,
        }
    }

    fn evidence(&self) -> Option<ProfileActivationEvidence> {
        match self {
            Self::GeodataFailed(asset) => Some(ProfileActivationEvidence {
                asset: *asset,
                kind: ProfileActivationEvidenceKind::GeodataFailed,
            }),
            Self::GeodataTimeout(asset) => Some(ProfileActivationEvidence {
                asset: *asset,
                kind: ProfileActivationEvidenceKind::GeodataTimeout,
            }),
            _ => None,
        }
    }

    fn failure_endpoint(&self) -> Option<&str> {
        match self {
            Self::ManagedListenerConflict(endpoint) => Some(endpoint),
            _ => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ProfileActivationRetryEvidence {
    Failure(ProfileActivationFailureEvidence),
    Cancelled,
    RollbackSucceeded,
    RollbackFailed,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProfileActivationStateKind {
    Idle,
    Pending,
    Succeeded,
    Failed,
    Cancelled,
    RollbackSucceeded,
    RollbackFailed,
    Retrying,
    ShuttingDown,
    Shutdown,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProfileActivationTransition {
    Begin,
    Retry,
    Succeed,
    Fail,
    Cancel,
    RollbackSucceed,
    RollbackFail,
    Shutdown,
    ShutdownComplete,
    ShutdownFail,
}

#[derive(Clone, Debug)]
enum ProfileActivationState {
    Idle {
        scope: ProfileActivationScope,
    },
    Pending(ProfileActivationPending),
    Succeeded {
        command: ProfileActivationCommand,
        runtime: ProfileActivationRuntime,
    },
    Failed {
        command: ProfileActivationCommand,
        evidence: ProfileActivationFailureEvidence,
        runtime: ProfileActivationRuntime,
    },
    Cancelled {
        command: ProfileActivationCommand,
        runtime: ProfileActivationRuntime,
    },
    RollbackSucceeded {
        command: ProfileActivationCommand,
    },
    RollbackFailed {
        command: ProfileActivationCommand,
        runtime: ProfileActivationRuntime,
    },
    Retrying {
        pending: ProfileActivationPending,
        previous: ProfileActivationRetryEvidence,
    },
    ShuttingDown {
        command: ProfileActivationCommand,
        runtime: ProfileActivationRuntime,
        terminal: bool,
    },
    ShuttingDownIdle {
        scope: ProfileActivationScope,
        terminal: bool,
    },
    Shutdown {
        scope: ProfileActivationScope,
    },
}

impl ProfileActivationState {
    fn idle() -> Self {
        Self::Idle {
            scope: ProfileActivationScope::new(),
        }
    }

    fn kind(&self) -> ProfileActivationStateKind {
        match self {
            Self::Idle { .. } => ProfileActivationStateKind::Idle,
            Self::Pending(_) => ProfileActivationStateKind::Pending,
            Self::Succeeded { .. } => ProfileActivationStateKind::Succeeded,
            Self::Failed { .. } => ProfileActivationStateKind::Failed,
            Self::Cancelled { .. } => ProfileActivationStateKind::Cancelled,
            Self::RollbackSucceeded { .. } => ProfileActivationStateKind::RollbackSucceeded,
            Self::RollbackFailed { .. } => ProfileActivationStateKind::RollbackFailed,
            Self::Retrying { .. } => ProfileActivationStateKind::Retrying,
            Self::ShuttingDown { .. } | Self::ShuttingDownIdle { .. } => {
                ProfileActivationStateKind::ShuttingDown
            }
            Self::Shutdown { .. } => ProfileActivationStateKind::Shutdown,
        }
    }

    fn allows(&self, transition: ProfileActivationTransition) -> bool {
        use ProfileActivationStateKind as State;
        use ProfileActivationTransition as Transition;

        matches!(
            (self.kind(), transition),
            (
                State::Idle | State::Succeeded,
                Transition::Begin | Transition::Shutdown
            ) | (
                State::Failed | State::Cancelled | State::RollbackSucceeded | State::RollbackFailed,
                Transition::Begin | Transition::Retry | Transition::Shutdown
            ) | (
                State::Pending | State::Retrying,
                Transition::Succeed | Transition::Fail | Transition::Cancel
            ) | (
                State::Succeeded,
                Transition::RollbackSucceed | Transition::RollbackFail
            ) | (
                State::ShuttingDown,
                Transition::ShutdownComplete | Transition::ShutdownFail
            )
        )
    }

    fn scope(&self) -> &ProfileActivationScope {
        match self {
            Self::Idle { scope }
            | Self::ShuttingDownIdle { scope, .. }
            | Self::Shutdown { scope } => scope,
            Self::Pending(pending) => &pending.command.scope,
            Self::Succeeded { command, .. }
            | Self::Failed { command, .. }
            | Self::Cancelled { command, .. }
            | Self::RollbackSucceeded { command }
            | Self::RollbackFailed { command, .. }
            | Self::ShuttingDown { command, .. } => &command.scope,
            Self::Retrying { pending, .. } => &pending.command.scope,
        }
    }

    fn runtime(&self) -> ProfileActivationRuntime {
        match self {
            Self::Idle { .. }
            | Self::RollbackSucceeded { .. }
            | Self::ShuttingDownIdle { .. }
            | Self::Shutdown { .. } => ProfileActivationRuntime::SafeStopped,
            Self::Pending(pending) | Self::Retrying { pending, .. } => pending.runtime.clone(),
            Self::Succeeded { runtime, .. }
            | Self::Failed { runtime, .. }
            | Self::Cancelled { runtime, .. }
            | Self::RollbackFailed { runtime, .. }
            | Self::ShuttingDown { runtime, .. } => runtime.clone(),
        }
    }

    fn pending(&self) -> Option<&ProfileActivationPending> {
        match self {
            Self::Pending(pending) | Self::Retrying { pending, .. } => Some(pending),
            _ => None,
        }
    }

    fn is_pending(&self) -> bool {
        self.pending().is_some()
    }

    fn retry_evidence(
        &self,
        operation: ProfileActivationOperation,
        target_profile_id: &str,
    ) -> Option<ProfileActivationRetryEvidence> {
        let matches_target = |command: &ProfileActivationCommand| {
            command.operation == operation && command.target_profile_id == target_profile_id
        };
        match self {
            Self::Failed {
                command, evidence, ..
            } if matches_target(command) => {
                Some(ProfileActivationRetryEvidence::Failure(evidence.clone()))
            }
            Self::Cancelled { command, .. } if matches_target(command) => {
                Some(ProfileActivationRetryEvidence::Cancelled)
            }
            Self::RollbackSucceeded { command } if matches_target(command) => {
                Some(ProfileActivationRetryEvidence::RollbackSucceeded)
            }
            Self::RollbackFailed { command, .. } if matches_target(command) => {
                Some(ProfileActivationRetryEvidence::RollbackFailed)
            }
            _ => None,
        }
    }

    fn begin(
        &mut self,
        command_id: &str,
        operation: ProfileActivationOperation,
        target_profile_id: &str,
        attempted_at: u64,
        cancellation: CancellationToken,
    ) -> Result<ProfileActivationCommand, ()> {
        let retry = self.retry_evidence(operation, target_profile_id);
        let transition = if retry.is_some() {
            ProfileActivationTransition::Retry
        } else {
            ProfileActivationTransition::Begin
        };
        if !self.allows(transition) {
            return Err(());
        }
        let command = ProfileActivationCommand {
            attempted_at,
            command_id: command_id.to_owned(),
            operation,
            scope: self.scope().next(),
            target_profile_id: target_profile_id.to_owned(),
        };
        let pending = ProfileActivationPending {
            cancellation,
            command: command.clone(),
            evidence: None,
            runtime: self.runtime(),
        };
        *self = match retry {
            Some(previous) => Self::Retrying { pending, previous },
            None => Self::Pending(pending),
        };
        Ok(command)
    }

    fn complete(
        &mut self,
        expected: &ProfileActivationCommand,
        completion: ProfileActivationCompletion,
    ) -> bool {
        let Some(pending) = self.pending() else {
            return false;
        };
        if pending.command != *expected {
            return false;
        }
        let transition = completion.transition();
        if !self.allows(transition) {
            return false;
        }
        let command = pending.command.clone();
        *self = match completion {
            ProfileActivationCompletion::Succeeded(runtime) => {
                if !success_matches_command(&command, &runtime) {
                    return false;
                }
                Self::Succeeded { command, runtime }
            }
            ProfileActivationCompletion::Failed { evidence, runtime } => Self::Failed {
                command,
                evidence,
                runtime,
            },
            ProfileActivationCompletion::Cancelled(runtime) => Self::Cancelled { command, runtime },
        };
        true
    }

    fn complete_rollback(
        &mut self,
        command_id: &str,
        runtime: Option<ProfileActivationRuntime>,
    ) -> bool {
        let Self::Succeeded {
            command,
            runtime: _,
        } = self
        else {
            return false;
        };
        if command.command_id != command_id
            || command.operation != ProfileActivationOperation::Activate
        {
            return false;
        }
        let command = command.clone();
        let transition = if runtime.is_some() {
            ProfileActivationTransition::RollbackFail
        } else {
            ProfileActivationTransition::RollbackSucceed
        };
        if !self.allows(transition) {
            return false;
        }
        *self = match runtime {
            Some(runtime) => Self::RollbackFailed { command, runtime },
            None => Self::RollbackSucceeded { command },
        };
        true
    }

    fn begin_shutdown(
        &mut self,
        terminal: bool,
        attempted_at: u64,
    ) -> Result<ProfileActivationState, ()> {
        if !self.allows(ProfileActivationTransition::Shutdown) {
            return Err(());
        }
        let previous = self.clone();
        let scope = self.scope().next();
        *self = match self.runtime() {
            ProfileActivationRuntime::SafeStopped => Self::ShuttingDownIdle { scope, terminal },
            ProfileActivationRuntime::Active {
                fingerprint,
                profile_id,
            } => Self::ShuttingDown {
                command: ProfileActivationCommand {
                    attempted_at,
                    command_id: Uuid::new_v4().to_string(),
                    operation: ProfileActivationOperation::Stop,
                    scope,
                    target_profile_id: profile_id.clone(),
                },
                runtime: ProfileActivationRuntime::Active {
                    fingerprint,
                    profile_id,
                },
                terminal,
            },
        };
        Ok(previous)
    }

    fn complete_shutdown(&mut self) -> bool {
        if !self.allows(ProfileActivationTransition::ShutdownComplete) {
            return false;
        }
        let (scope, terminal) = match self {
            Self::ShuttingDown {
                command, terminal, ..
            } => (command.scope.clone(), *terminal),
            Self::ShuttingDownIdle { scope, terminal } => (scope.clone(), *terminal),
            _ => return false,
        };
        if !matches!(
            self,
            Self::ShuttingDown { .. } | Self::ShuttingDownIdle { .. }
        ) {
            return false;
        }
        *self = if terminal {
            Self::Shutdown { scope }
        } else {
            Self::Idle { scope }
        };
        true
    }

    fn fail_shutdown(
        &mut self,
        previous: ProfileActivationState,
        evidence: ProfileActivationFailureEvidence,
        runtime: ProfileActivationRuntime,
    ) -> bool {
        if !self.allows(ProfileActivationTransition::ShutdownFail) {
            return false;
        }
        *self = match self {
            Self::ShuttingDown { command, .. } => Self::Failed {
                command: command.clone(),
                evidence,
                runtime,
            },
            Self::ShuttingDownIdle { .. } => previous,
            _ => return false,
        };
        true
    }

    fn to_snapshot(
        &self,
        availability: ProfileActivationAvailability,
    ) -> ProfileActivationSnapshot {
        let runtime = self.runtime();
        let mut snapshot = ProfileActivationSnapshot {
            active_fingerprint: runtime.fingerprint().map(str::to_owned),
            active_profile_id: runtime.active_profile_id().map(str::to_owned),
            attempted_at: None,
            availability,
            command_id: None,
            evidence: None,
            failure: None,
            failure_endpoint: None,
            operation: None,
            phase: ProfileActivationPhase::Idle,
            safe_stopped: runtime.is_safe_stopped(),
            startup_policy: ProfileStartupPolicy::SafeStopped,
            target_profile_id: None,
        };
        match self {
            Self::Idle { .. } => {}
            Self::Pending(pending) => {
                project_command(&mut snapshot, &pending.command);
                snapshot.evidence = pending.evidence;
                snapshot.phase = ProfileActivationPhase::Pending;
            }
            Self::Retrying { pending, previous } => {
                let _retry_boundary = previous;
                project_command(&mut snapshot, &pending.command);
                snapshot.evidence = pending.evidence;
                snapshot.phase = ProfileActivationPhase::Pending;
            }
            Self::Succeeded { command, .. } => {
                project_command(&mut snapshot, command);
                snapshot.phase = ProfileActivationPhase::Success;
            }
            Self::Failed {
                command, evidence, ..
            } => {
                project_command(&mut snapshot, command);
                snapshot.evidence = evidence.evidence();
                snapshot.failure = Some(evidence.failure());
                snapshot.failure_endpoint = evidence.failure_endpoint().map(str::to_owned);
                snapshot.phase = ProfileActivationPhase::Failure;
            }
            Self::Cancelled { command, .. } => {
                project_command(&mut snapshot, command);
                snapshot.failure = Some(ProfileActivationFailure::Cancelled);
                snapshot.phase = ProfileActivationPhase::Failure;
            }
            Self::RollbackSucceeded { command } | Self::RollbackFailed { command, .. } => {
                project_command(&mut snapshot, command);
                snapshot.failure = Some(ProfileActivationFailure::Capture);
                snapshot.phase = ProfileActivationPhase::Failure;
            }
            Self::ShuttingDown { command, .. } => {
                project_command(&mut snapshot, command);
                snapshot.availability = ProfileActivationAvailability::Unavailable;
                snapshot.phase = ProfileActivationPhase::Pending;
            }
            Self::ShuttingDownIdle { .. } | Self::Shutdown { .. } => {
                snapshot.availability = ProfileActivationAvailability::Unavailable;
            }
        }
        snapshot
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum ProfileActivationCompletion {
    Succeeded(ProfileActivationRuntime),
    Failed {
        evidence: ProfileActivationFailureEvidence,
        runtime: ProfileActivationRuntime,
    },
    Cancelled(ProfileActivationRuntime),
}

impl ProfileActivationCompletion {
    fn transition(&self) -> ProfileActivationTransition {
        match self {
            Self::Succeeded(_) => ProfileActivationTransition::Succeed,
            Self::Failed { .. } => ProfileActivationTransition::Fail,
            Self::Cancelled(_) => ProfileActivationTransition::Cancel,
        }
    }
}

fn success_matches_command(
    command: &ProfileActivationCommand,
    runtime: &ProfileActivationRuntime,
) -> bool {
    match (command.operation, runtime) {
        (
            ProfileActivationOperation::Activate,
            ProfileActivationRuntime::Active { profile_id, .. },
        ) => command.target_profile_id == *profile_id,
        (ProfileActivationOperation::Stop, ProfileActivationRuntime::SafeStopped) => true,
        _ => false,
    }
}

fn project_command(snapshot: &mut ProfileActivationSnapshot, command: &ProfileActivationCommand) {
    snapshot.attempted_at = Some(command.attempted_at);
    snapshot.command_id = Some(command.command_id.clone());
    snapshot.operation = Some(command.operation);
    snapshot.target_profile_id = Some(command.target_profile_id.clone());
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
    activation: ProfileActivationState,
}

struct ProxyPreparationCancellation {
    id: Uuid,
    slot: Arc<std::sync::Mutex<Option<(Uuid, CancellationToken)>>>,
    token: CancellationToken,
}

impl Drop for ProxyPreparationCancellation {
    fn drop(&mut self) {
        let mut slot = self
            .slot
            .lock()
            .expect("proxy preparation cancellation lock poisoned");
        if slot.as_ref().is_some_and(|(id, _)| *id == self.id) {
            slot.take();
        }
    }
}

type PolicyFactory =
    dyn Fn() -> Result<ManagedRuntimePolicy, RuntimeConfigGenerationError> + Send + Sync;

pub struct ProfileActivationCoordinator {
    availability: ProfileActivationAvailability,
    authority: StateMutationAuthority,
    host: DesktopRuntimeHost,
    manager: Arc<MihomoActivationManager>,
    policy_factory: Arc<PolicyFactory>,
    profiles: Arc<DesktopProfileService>,
    proxy_cancellation: Arc<std::sync::Mutex<Option<(Uuid, CancellationToken)>>>,
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
            availability,
            authority: profiles.mutation_authority(),
            host,
            manager,
            policy_factory: Arc::new(policy_factory),
            profiles,
            proxy_cancellation: Arc::new(std::sync::Mutex::new(None)),
            proxy_operation: Arc::new(Mutex::new(())),
            safe_runtime,
            directory_task: Mutex::new(None),
            scheduler_cancellation: CancellationToken::new(),
            scheduler_task: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            state: Mutex::new(CoordinatorState {
                busy_profiles: HashSet::new(),
                activation: ProfileActivationState::idle(),
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
        let state = self.state.lock().await;
        let snapshot = state.activation.to_snapshot(self.availability);
        if snapshot.command_id.as_deref() == Some(command_id)
            || (snapshot.phase == ProfileActivationPhase::Pending
                && snapshot.target_profile_id.as_deref() == Some(profile_id))
        {
            return Ok(snapshot);
        }
        if snapshot.phase == ProfileActivationPhase::Pending {
            return Err(ProfileActivationCoordinatorError::Conflict);
        }
        drop(state);
        let permit = self.acquire_mutation()?;
        self.authority
            .validate(&permit)
            .map_err(|_| ProfileActivationCoordinatorError::Busy)?;
        self.activate_inner(command_id, profile_id, Some(permit))
            .await
    }

    async fn activate_inner(
        self: &Arc<Self>,
        command_id: &str,
        profile_id: &str,
        permit: Option<StateMutationPermit>,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        validate_command_id(command_id)?;
        let availability = self.availability;
        if availability != ProfileActivationAvailability::Available {
            self.reject_unavailable_activation(command_id, profile_id, availability)
                .await;
            return Err(ProfileActivationCoordinatorError::Unavailable);
        }
        {
            let state = self.state.lock().await;
            let snapshot = state.activation.to_snapshot(self.availability);
            if snapshot.command_id.as_deref() == Some(command_id)
                || (snapshot.phase == ProfileActivationPhase::Pending
                    && snapshot.target_profile_id.as_deref() == Some(profile_id))
            {
                return Ok(snapshot);
            }
            if snapshot.phase == ProfileActivationPhase::Pending {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
        }
        let cancellation = CancellationToken::new();
        let (command, pending, previous_command_id) = {
            let mut state = self.state.lock().await;
            let snapshot = state.activation.to_snapshot(self.availability);
            if snapshot.command_id.as_deref() == Some(command_id) {
                return Ok(snapshot);
            }
            if snapshot.phase == ProfileActivationPhase::Pending {
                if snapshot.target_profile_id.as_deref() == Some(profile_id) {
                    return Ok(snapshot);
                }
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
            if !state.busy_profiles.insert(profile_id.to_owned()) {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
            let command = state
                .activation
                .begin(
                    command_id,
                    ProfileActivationOperation::Activate,
                    profile_id,
                    now_unix_milliseconds(),
                    cancellation.clone(),
                )
                .map_err(|()| ProfileActivationCoordinatorError::Conflict)?;
            let pending = state.activation.to_snapshot(self.availability);
            let previous_command_id = (snapshot.phase == ProfileActivationPhase::Failure)
                .then_some(snapshot.command_id)
                .flatten();
            (command, pending, previous_command_id)
        };
        if let Some(previous_command_id) = previous_command_id {
            self.host
                .resolve_notification(&format!("profile.activation-failure:{previous_command_id}"));
        }
        let _ = self.updates.send(pending.clone());
        let record = match self.profiles.activation_record(profile_id) {
            Ok(record) => record,
            Err(error) => {
                self.finish_preflight_activation(
                    &command,
                    ProfileActivationFailureEvidence::InvalidProfile,
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
                self.finish_preflight_activation(
                    &command,
                    ProfileActivationFailureEvidence::StateCommit,
                )
                .await;
                return Err(error);
            }
        };
        let coordinator = self.clone();
        tokio::spawn(async move {
            let result = coordinator
                .manager
                .activate_cancellable(&record, &policy, cancellation)
                .await;
            coordinator.finish_activation(&command, result).await;
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
        let evidence = match availability {
            ProfileActivationAvailability::MissingBinary => {
                ProfileActivationFailureEvidence::MissingBinary
            }
            ProfileActivationAvailability::Unavailable => {
                ProfileActivationFailureEvidence::UnsafeRuntime
            }
            ProfileActivationAvailability::Available => return,
        };
        let failure = evidence.failure();
        let mut state = self.state.lock().await;
        if state.activation.is_pending() {
            return;
        }
        let previous = state.activation.to_snapshot(self.availability);
        let runtime = state.activation.runtime();
        let Ok(command) = state.activation.begin(
            command_id,
            ProfileActivationOperation::Activate,
            profile_id,
            now_unix_milliseconds(),
            CancellationToken::new(),
        ) else {
            return;
        };
        let completed = state.activation.complete(
            &command,
            ProfileActivationCompletion::Failed { evidence, runtime },
        );
        debug_assert!(completed);
        let snapshot = state.activation.to_snapshot(self.availability);
        let _ = self.updates.send(snapshot);
        drop(state);
        if previous.phase == ProfileActivationPhase::Failure {
            if let Some(previous_command_id) = previous.command_id {
                self.host.resolve_notification(&format!(
                    "profile.activation-failure:{previous_command_id}"
                ));
            }
        }
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
        let snapshot = state.activation.to_snapshot(self.availability);
        let Some(pending) = state.activation.pending() else {
            return Ok(snapshot);
        };
        if pending.command.command_id != command_id {
            return Ok(snapshot);
        }
        pending.cancellation.cancel();
        Ok(snapshot)
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

    async fn reactivate_active_authorized(
        self: &Arc<Self>,
        permit: &StateMutationPermit,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        self.authority
            .validate(permit)
            .map_err(|_| ProfileActivationCoordinatorError::Busy)?;
        let profile_id = self
            .activation_snapshot()
            .await
            .active_profile_id
            .ok_or(ProfileActivationCoordinatorError::Unavailable)?;
        let command_id = Uuid::new_v4().to_string();
        let mut updates = self.subscribe();
        let pending = self.activate_inner(&command_id, &profile_id, None).await?;
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
    /// Every caller uses the confirmed Rust-selected Profile. Profile activation and the single
    /// Capture mutation deliberately share this lifecycle so no transport can become a second
    /// authority.
    pub async fn launch_proxy(
        self: &Arc<Self>,
        command_id: &str,
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
                    None,
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
        let preparation_cancellation = self.begin_proxy_preparation();
        let permit = self
            .acquire_mutation_queued()
            .await
            .map_err(profile_launch_error)?;
        let selected = self
            .profiles
            .confirmed_selection_authorized(&permit)
            .map_err(|_| profile_launch_error(ProfileActivationCoordinatorError::Unavailable))?;
        let profile_id = selected
            .profile_id
            .ok_or_else(|| profile_launch_error(ProfileActivationCoordinatorError::Unavailable))?;
        let request = CaptureRequest {
            active: true,
            selection,
        };
        let requires_tun_reactivation =
            before.runtime.tun_enabled != (request.active && request.selection.tun);
        let capture_operation = self
            .host
            .current()
            .publish_capture_pending(&request)
            .await?;
        let activation_started = Instant::now();
        let mut activation_started_for_launch = false;
        let current = self.activation_snapshot().await;
        let activation = if current.phase == ProfileActivationPhase::Success
            && current.active_profile_id.as_deref() == Some(profile_id.as_str())
        {
            Ok(current)
        } else {
            let activation = self
                .activate_inner(command_id, &profile_id, None)
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
                self.host
                    .current()
                    .finish_capture_operation_failure(&capture_operation, &error)
                    .await;
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
        let preflight_cancellation = preparation_cancellation.token.clone();
        let preflight = async {
            let result = self
                .host
                .preflight_capture_cancellable(&preflight_request, preflight_cancellation)
                .await;
            (result, preflight_started.elapsed())
        };
        tokio::pin!(activation);
        tokio::pin!(preflight);
        let prepared = tokio::select! {
            _ = preparation_cancellation.token.cancelled() => {
                let _ = preflight.await;
                if activation_pending {
                    let _ = self.cancel(command_id).await;
                    let _ = activation.await;
                }
                Err(CaptureTransitionError::new(
                    CaptureFailureKind::RuntimeTransition,
                    "Aggregate proxy launch preparation was cancelled",
                ))
            }
            (completed, activation_elapsed) = &mut activation => {
                match completed {
                    Ok(completed) if completed.phase == ProfileActivationPhase::Success => {
                        tokio::select! {
                            (preflight, preflight_elapsed) = &mut preflight => {
                                preflight.map(|preflight| (
                                    preflight,
                                    activation_elapsed,
                                    preflight_elapsed,
                                ))
                            }
                            _ = preparation_cancellation.token.cancelled() => {
                                let _ = preflight.await;
                                Err(CaptureTransitionError::new(
                                    CaptureFailureKind::RuntimeTransition,
                                    "Aggregate proxy launch preparation was cancelled",
                                ))
                            }
                        }
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
                    let result = if requires_tun_reactivation && !activation_started_for_launch {
                        match self.reactivate_active_authorized(&permit).await {
                            Ok(snapshot) if snapshot.phase == ProfileActivationPhase::Success => {
                                self.host
                                    .set_capture_with_admitted_preflight(
                                        request,
                                        adapter_kind,
                                        preflight,
                                        &capture_operation,
                                    )
                                    .await
                            }
                            Ok(_) | Err(_) => Err(CaptureTransitionError::new(
                                CaptureFailureKind::RuntimeTransition,
                                "Mihomo could not be reactivated with the requested TUN policy",
                            )),
                        }
                    } else {
                        self.host
                            .set_capture_with_admitted_preflight(
                                request,
                                adapter_kind,
                                preflight,
                                &capture_operation,
                            )
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
        if result.is_err() && activation_started_for_launch {
            let activation = self.activation_snapshot().await;
            if activation.command_id.as_deref() == Some(command_id)
                && activation.phase == ProfileActivationPhase::Success
                && !activation.safe_stopped
            {
                match self.rollback_failed_aggregate_activation(command_id).await {
                    Ok(()) => {
                        if let Some(error) = result.as_ref().err() {
                            self.host.record_application_event(
                                ApplicationDiagnosticEvent::capture_transition_failure(error),
                            );
                        }
                    }
                    Err(rollback_error) => {
                        result = Err(rollback_error);
                        outcome = "rollback-failed";
                    }
                }
            }
        }
        if let Err(error) = &result {
            self.host
                .current()
                .finish_capture_operation_failure(&capture_operation, error)
                .await;
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

    fn begin_proxy_preparation(&self) -> ProxyPreparationCancellation {
        let id = Uuid::new_v4();
        let token = CancellationToken::new();
        *self
            .proxy_cancellation
            .lock()
            .expect("proxy preparation cancellation lock poisoned") = Some((id, token.clone()));
        ProxyPreparationCancellation {
            id,
            slot: self.proxy_cancellation.clone(),
            token,
        }
    }

    fn cancel_proxy_preparation(&self) {
        if let Some(cancellation) = self
            .proxy_cancellation
            .lock()
            .expect("proxy preparation cancellation lock poisoned")
            .as_ref()
        {
            cancellation.1.cancel();
        }
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

    async fn rollback_failed_aggregate_activation(
        &self,
        command_id: &str,
    ) -> Result<(), CaptureTransitionError> {
        let shutdown = self.manager.shutdown().await;
        let managed = self.manager.managed_state().await;
        let active_runtime = self.manager.active_runtime().await;
        let mut state = self.state.lock().await;
        state.busy_profiles.clear();
        match shutdown {
            Ok(()) => {
                self.host.replace(self.safe_runtime.clone());
                if !state.activation.complete_rollback(command_id, None) {
                    return Ok(());
                }
            }
            Err(_) => {
                if managed.is_safe_stopped() {
                    self.host.replace(self.safe_runtime.clone());
                } else if let Some(runtime) = active_runtime {
                    self.host.replace(runtime);
                }
                let runtime = activation_runtime(
                    managed.is_safe_stopped(),
                    managed.active_profile_id(),
                    managed.active_fingerprint(),
                );
                if !state
                    .activation
                    .complete_rollback(command_id, Some(runtime))
                {
                    return Ok(());
                }
                let snapshot = state.activation.to_snapshot(self.availability);
                let _ = self.updates.send(snapshot);
                return Err(CaptureTransitionError::new(
                    CaptureFailureKind::RollbackFailed,
                    "Capture failed and the newly started Mihomo core could not be stopped safely",
                ));
            }
        }
        let snapshot = state.activation.to_snapshot(self.availability);
        let _ = self.updates.send(snapshot);
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
            self.cancel_proxy_preparation();
            let pending_command = {
                let state = self.state.lock().await;
                state
                    .activation
                    .pending()
                    .map(|pending| pending.command.command_id.clone())
            };
            if let Some(command_id) = pending_command {
                let _ = self.cancel(&command_id).await;
            }
            let _operation = self.proxy_operation.lock().await;
            return self.set_capture_inner(request, adapter_kind, None).await;
        }
        let _operation = self.proxy_operation.try_lock().map_err(|_| {
            CaptureTransitionError::new(
                CaptureFailureKind::RuntimeTransition,
                "Another aggregate proxy operation is already in progress",
            )
        })?;
        self.set_capture_inner(request, adapter_kind, None).await
    }

    async fn set_capture_inner(
        self: &Arc<Self>,
        request: CaptureRequest,
        adapter_kind: StatusAdapterKind,
        permit: Option<&StateMutationPermit>,
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
        let activation_result = match permit {
            Some(permit) => self.reactivate_active_authorized(permit).await,
            None => self.reactivate_active().await,
        };
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
            let snapshot = state.activation.to_snapshot(self.availability);
            if snapshot.command_id.as_deref() == Some(command_id) {
                return Ok(snapshot);
            }
            if snapshot.phase == ProfileActivationPhase::Pending {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
        }
        let permit = self.acquire_mutation()?;
        let (command, pending) = {
            let mut state = self.state.lock().await;
            let snapshot = state.activation.to_snapshot(self.availability);
            if snapshot.command_id.as_deref() == Some(command_id) {
                return Ok(snapshot);
            }
            if snapshot.phase == ProfileActivationPhase::Pending {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
            let Some(active_profile_id) = state
                .activation
                .runtime()
                .active_profile_id()
                .map(str::to_owned)
            else {
                return Ok(snapshot);
            };
            if !state.busy_profiles.insert(active_profile_id.clone()) {
                return Err(ProfileActivationCoordinatorError::Conflict);
            }
            let command = state
                .activation
                .begin(
                    command_id,
                    ProfileActivationOperation::Stop,
                    &active_profile_id,
                    now_unix_milliseconds(),
                    CancellationToken::new(),
                )
                .map_err(|()| ProfileActivationCoordinatorError::Conflict)?;
            let pending = state.activation.to_snapshot(self.availability);
            (command, pending)
        };
        let _ = self.updates.send(pending.clone());
        let coordinator = self.clone();
        tokio::spawn(async move {
            let result = coordinator.manager.shutdown().await;
            coordinator.finish_stop(&command, result).await;
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
        let snapshot = state.activation.to_snapshot(self.availability);
        if snapshot.phase == ProfileActivationPhase::Pending
            || snapshot.active_profile_id.as_deref() == Some(profile_id)
        {
            return Err(ProfileActivationCoordinatorError::Conflict);
        }
        let active_profile_id = snapshot.active_profile_id;
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
        self.state
            .lock()
            .await
            .activation
            .to_snapshot(self.availability)
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
            application_order: mish_runtime::ApplicationSnapshotOrder::detached(),
            capabilities: snapshot.capabilities,
            profiles: snapshot.profiles,
            providers: self.host.provider_snapshot(),
            selection: snapshot.selection,
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
        Ok(self
            .state
            .lock()
            .await
            .activation
            .runtime()
            .active_profile_id()
            .map(str::to_owned))
    }

    fn acquire_mutation(&self) -> Result<StateMutationPermit, ProfileActivationCoordinatorError> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(ProfileActivationCoordinatorError::Busy);
        }
        self.authority
            .try_acquire()
            .map_err(|_| ProfileActivationCoordinatorError::Busy)
    }

    async fn acquire_mutation_queued(
        &self,
    ) -> Result<StateMutationPermit, ProfileActivationCoordinatorError> {
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(ProfileActivationCoordinatorError::Busy);
        }
        let permit = self
            .authority
            .acquire()
            .await
            .map_err(|_| ProfileActivationCoordinatorError::Busy)?;
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(ProfileActivationCoordinatorError::Busy);
        }
        Ok(permit)
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
        self.cancel_proxy_preparation();
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
        if let Some(pending) = self.state.lock().await.activation.pending() {
            pending.cancellation.cancel();
        }
        let _proxy_operation = self.proxy_operation.lock().await;
        let permit = match self.authority.try_acquire() {
            Ok(permit) => permit,
            Err(_) => {
                self.shutting_down.store(false, Ordering::Release);
                return Err(ProfileActivationShutdownFailure::MutationBusy);
            }
        };
        let previous = {
            let mut state = self.state.lock().await;
            match state
                .activation
                .begin_shutdown(terminal, now_unix_milliseconds())
            {
                Ok(previous) => previous,
                Err(()) => {
                    self.shutting_down.store(false, Ordering::Release);
                    return Err(ProfileActivationShutdownFailure::MutationBusy);
                }
            }
        };
        if let Err(error) = self.manager.shutdown().await {
            let managed = self.manager.managed_state().await;
            let active_runtime = self.manager.active_runtime().await;
            if managed.is_safe_stopped() {
                self.host.replace(self.safe_runtime.clone());
            } else if let Some(runtime) = active_runtime {
                self.host.replace(runtime);
            }
            let runtime = activation_runtime(
                managed.is_safe_stopped(),
                managed.active_profile_id(),
                managed.active_fingerprint(),
            );
            let mut state = self.state.lock().await;
            let failed = state.activation.fail_shutdown(
                previous,
                activation_failure_evidence(error),
                runtime,
            );
            debug_assert!(failed);
            let snapshot = state.activation.to_snapshot(self.availability);
            let _ = self.updates.send(snapshot);
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
        state.busy_profiles.clear();
        let completed = state.activation.complete_shutdown();
        debug_assert!(completed);
        let snapshot = state.activation.to_snapshot(self.availability);
        let _ = self.updates.send(snapshot);
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

    async fn finish_preflight_activation(
        &self,
        command: &ProfileActivationCommand,
        evidence: ProfileActivationFailureEvidence,
    ) {
        let mut state = self.state.lock().await;
        let Some(pending) = state.activation.pending() else {
            return;
        };
        if pending.command != *command {
            return;
        }
        state.busy_profiles.remove(&command.target_profile_id);
        let runtime = state.activation.runtime();
        let failure = evidence.failure();
        let completed = state.activation.complete(
            command,
            ProfileActivationCompletion::Failed { evidence, runtime },
        );
        debug_assert!(completed);
        let snapshot = state.activation.to_snapshot(self.availability);
        let _ = self.updates.send(snapshot);
        drop(state);
        resolve_geodata_notifications(&self.host, &command.command_id, None);
        self.host
            .record_application_event(ApplicationDiagnosticEvent::profile_activation_failure(
                profile_activation_failure_id(failure),
            ));
        let _ = self.host.publish_notification(NotificationPublication {
            dedupe_key: format!("profile.activation-failure:{}", command.command_id),
            pinned: false,
            presentation: profile_activation_failure_notification(failure),
            replaces: Vec::new(),
            resolved: false,
            severity: NotificationSeverity::Error,
        });
    }

    async fn finish_activation(
        &self,
        command: &ProfileActivationCommand,
        result: Result<crate::ActivationCommit, MihomoActivationError>,
    ) {
        let managed = self.manager.managed_state().await;
        let active_runtime = self.manager.active_runtime().await;
        let mut state = self.state.lock().await;
        let Some(pending) = state.activation.pending() else {
            return;
        };
        if pending.command != *command {
            return;
        }
        state.busy_profiles.remove(&command.target_profile_id);
        match result {
            Ok(commit) => {
                let Some(runtime) = active_runtime else {
                    self.manager.complete_runtime_handoff().await;
                    let runtime = activation_runtime(
                        managed.is_safe_stopped(),
                        managed.active_profile_id(),
                        managed.active_fingerprint(),
                    );
                    let completed = state.activation.complete(
                        command,
                        ProfileActivationCompletion::Failed {
                            evidence: ProfileActivationFailureEvidence::StateCommit,
                            runtime,
                        },
                    );
                    debug_assert!(completed);
                    let snapshot = state.activation.to_snapshot(self.availability);
                    let _ = self.updates.send(snapshot);
                    drop(state);
                    self.host.record_application_event(activation_failure_event(
                        MihomoActivationError::StateCommitFailed,
                    ));
                    publish_activation_failure_notification(
                        &self.host,
                        &command.command_id,
                        MihomoActivationError::StateCommitFailed,
                    );
                    return;
                };
                self.host.replace(runtime);
                self.manager.complete_runtime_handoff().await;
                let completed = state.activation.complete(
                    command,
                    ProfileActivationCompletion::Succeeded(ProfileActivationRuntime::Active {
                        fingerprint: commit.fingerprint().to_owned(),
                        profile_id: commit.profile_id().to_owned(),
                    }),
                );
                debug_assert!(completed);
            }
            Err(error) => {
                if managed.is_safe_stopped() {
                    self.host.replace(self.safe_runtime.clone());
                } else if let Some(runtime) = active_runtime {
                    self.host.replace(runtime);
                }
                self.manager.complete_runtime_handoff().await;
                let runtime = activation_runtime(
                    managed.is_safe_stopped(),
                    managed.active_profile_id(),
                    managed.active_fingerprint(),
                );
                let completion = if error == MihomoActivationError::Cancelled {
                    ProfileActivationCompletion::Cancelled(runtime)
                } else {
                    ProfileActivationCompletion::Failed {
                        evidence: activation_failure_evidence(error),
                        runtime,
                    }
                };
                let completed = state.activation.complete(command, completion);
                debug_assert!(completed);
                let diagnostic = activation_failure_event(error);
                let snapshot = state.activation.to_snapshot(self.availability);
                let _ = self.updates.send(snapshot);
                drop(state);
                self.host.record_application_event(diagnostic);
                publish_activation_failure_notification(&self.host, &command.command_id, error);
                return;
            }
        }
        let snapshot = state.activation.to_snapshot(self.availability);
        let _ = self.updates.send(snapshot);
        drop(state);
        resolve_geodata_notifications(&self.host, &command.command_id, None);
    }

    async fn finish_stop(
        &self,
        command: &ProfileActivationCommand,
        result: Result<(), MihomoActivationError>,
    ) {
        let managed = self.manager.managed_state().await;
        let active_runtime = self.manager.active_runtime().await;
        let mut state = self.state.lock().await;
        let Some(pending) = state.activation.pending() else {
            return;
        };
        if pending.command != *command {
            return;
        }
        state.busy_profiles.remove(&command.target_profile_id);
        match result {
            Ok(()) => {
                self.host.replace(self.safe_runtime.clone());
                let completed = state.activation.complete(
                    command,
                    ProfileActivationCompletion::Succeeded(ProfileActivationRuntime::SafeStopped),
                );
                debug_assert!(completed);
            }
            Err(error) => {
                if managed.is_safe_stopped() {
                    self.host.replace(self.safe_runtime.clone());
                } else if let Some(runtime) = active_runtime {
                    self.host.replace(runtime);
                }
                let runtime = activation_runtime(
                    managed.is_safe_stopped(),
                    managed.active_profile_id(),
                    managed.active_fingerprint(),
                );
                let completion = if error == MihomoActivationError::Cancelled {
                    ProfileActivationCompletion::Cancelled(runtime)
                } else {
                    ProfileActivationCompletion::Failed {
                        evidence: activation_failure_evidence(error),
                        runtime,
                    }
                };
                let completed = state.activation.complete(command, completion);
                debug_assert!(completed);
            }
        }
        let snapshot = state.activation.to_snapshot(self.availability);
        let _ = self.updates.send(snapshot);
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

    use super::{
        ProfileActivationFailure, launch_duration_milliseconds,
        profile_activation_failure_notification, usable_capture_selection,
    };
    use mish_runtime::{
        ApplicationActionId, CapabilityAvailability, CaptureSelection, PlatformCapabilities,
        StatusAdapterKind,
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

    #[test]
    fn activation_failure_notification_exposes_only_valid_typed_retries() {
        for failure in [
            ProfileActivationFailure::Staging,
            ProfileActivationFailure::Start,
            ProfileActivationFailure::EarlyExit,
            ProfileActivationFailure::Controller,
            ProfileActivationFailure::Timeout,
            ProfileActivationFailure::PriorStop,
        ] {
            let notification = profile_activation_failure_notification(failure);
            assert_eq!(
                notification.action_ids,
                vec![ApplicationActionId::RetryProfileActivation]
            );
            assert!(notification.actions_valid());
        }

        for failure in [
            ProfileActivationFailure::InvalidProfile,
            ProfileActivationFailure::MissingBinary,
            ProfileActivationFailure::UnsafeRuntime,
            ProfileActivationFailure::Validation,
            ProfileActivationFailure::GeodataFailed,
            ProfileActivationFailure::GeodataTimeout,
            ProfileActivationFailure::ManagedListenerConflict,
            ProfileActivationFailure::VersionMismatch,
            ProfileActivationFailure::Cancelled,
            ProfileActivationFailure::Capture,
            ProfileActivationFailure::StateCommit,
        ] {
            let notification = profile_activation_failure_notification(failure);
            assert!(notification.action_ids.is_empty());
            assert!(notification.actions_valid());
        }
    }
}

#[cfg(test)]
mod activation_snapshot_golden_tests {
    use serde_json::{Value, json};
    use tokio_util::sync::CancellationToken;

    use super::{
        ProfileActivationAvailability, ProfileActivationCompletion, ProfileActivationEvidence,
        ProfileActivationEvidenceKind, ProfileActivationFailureEvidence,
        ProfileActivationOperation, ProfileActivationRuntime, ProfileActivationScope,
        ProfileActivationState, ProfileActivationStateKind, ProfileActivationTransition,
    };

    const ACTIVE_FINGERPRINT: &str =
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const COMMAND_ID: &str = "11111111-1111-4111-8111-111111111111";
    const NEXT_COMMAND_ID: &str = "22222222-2222-4222-8222-222222222222";
    const PROFILE_ID: &str = "33333333-3333-4333-8333-333333333333";

    fn serialized(
        state: &ProfileActivationState,
        availability: ProfileActivationAvailability,
    ) -> Value {
        serde_json::to_value(state.to_snapshot(availability))
            .expect("activation snapshot should serialize")
    }

    #[test]
    fn public_activation_dto_legal_variants_have_stable_golden_snapshots() {
        let idle = ProfileActivationState::idle();

        let mut pending = idle.clone();
        let pending_command = pending
            .begin(
                COMMAND_ID,
                ProfileActivationOperation::Activate,
                PROFILE_ID,
                1_721_296_000_000,
                CancellationToken::new(),
            )
            .unwrap();

        let mut preparing = pending.clone();
        let ProfileActivationState::Pending(preparation) = &mut preparing else {
            panic!("activation should be pending");
        };
        preparation.evidence = Some(ProfileActivationEvidence {
            asset: crate::GeodataAsset::GeoSite,
            kind: ProfileActivationEvidenceKind::GeodataPreparing,
        });

        let active_runtime = ProfileActivationRuntime::Active {
            fingerprint: ACTIVE_FINGERPRINT.into(),
            profile_id: PROFILE_ID.into(),
        };
        let mut succeeded = pending.clone();
        assert!(succeeded.complete(
            &pending_command,
            ProfileActivationCompletion::Succeeded(active_runtime.clone()),
        ));

        let mut failed = pending.clone();
        assert!(failed.complete(
            &pending_command,
            ProfileActivationCompletion::Failed {
                evidence: ProfileActivationFailureEvidence::Validation,
                runtime: ProfileActivationRuntime::SafeStopped,
            },
        ));

        let mut cancelled = pending.clone();
        assert!(cancelled.complete(
            &pending_command,
            ProfileActivationCompletion::Cancelled(ProfileActivationRuntime::SafeStopped),
        ));

        let mut rollback_succeeded = succeeded.clone();
        assert!(rollback_succeeded.complete_rollback(COMMAND_ID, None));

        let mut rollback_failed = succeeded.clone();
        assert!(rollback_failed.complete_rollback(COMMAND_ID, Some(active_runtime.clone())));

        let mut retrying = failed.clone();
        retrying
            .begin(
                NEXT_COMMAND_ID,
                ProfileActivationOperation::Activate,
                PROFILE_ID,
                1_721_296_001_000,
                CancellationToken::new(),
            )
            .unwrap();

        let mut stop_pending = succeeded.clone();
        let stop_command = stop_pending
            .begin(
                COMMAND_ID,
                ProfileActivationOperation::Stop,
                PROFILE_ID,
                1_721_296_000_000,
                CancellationToken::new(),
            )
            .unwrap();

        let mut stop_succeeded = stop_pending.clone();
        assert!(stop_succeeded.complete(
            &stop_command,
            ProfileActivationCompletion::Succeeded(ProfileActivationRuntime::SafeStopped),
        ));

        let mut stop_failed = stop_pending.clone();
        assert!(stop_failed.complete(
            &stop_command,
            ProfileActivationCompletion::Failed {
                evidence: ProfileActivationFailureEvidence::PriorStop,
                runtime: active_runtime,
            },
        ));

        let shutdown = ProfileActivationState::Shutdown {
            scope: ProfileActivationScope::new(),
        };

        assert_eq!(
            [
                (
                    "idle",
                    serialized(&idle, ProfileActivationAvailability::Available),
                ),
                (
                    "pending",
                    serialized(&pending, ProfileActivationAvailability::Available),
                ),
                (
                    "preparing",
                    serialized(&preparing, ProfileActivationAvailability::Available),
                ),
                (
                    "succeeded",
                    serialized(&succeeded, ProfileActivationAvailability::Available),
                ),
                (
                    "failed",
                    serialized(&failed, ProfileActivationAvailability::Available),
                ),
                (
                    "cancelled",
                    serialized(&cancelled, ProfileActivationAvailability::Available),
                ),
                (
                    "rollback-succeeded",
                    serialized(
                        &rollback_succeeded,
                        ProfileActivationAvailability::Available,
                    ),
                ),
                (
                    "rollback-failed",
                    serialized(&rollback_failed, ProfileActivationAvailability::Available),
                ),
                (
                    "retrying",
                    serialized(&retrying, ProfileActivationAvailability::Available),
                ),
                (
                    "stop-pending",
                    serialized(&stop_pending, ProfileActivationAvailability::Available),
                ),
                (
                    "stop-succeeded",
                    serialized(&stop_succeeded, ProfileActivationAvailability::Available),
                ),
                (
                    "stop-failed",
                    serialized(&stop_failed, ProfileActivationAvailability::Available),
                ),
                (
                    "shutdown",
                    serialized(&shutdown, ProfileActivationAvailability::Unavailable),
                ),
            ],
            [
                (
                    "idle",
                    json!({
                        "activeFingerprint": null,
                        "activeProfileId": null,
                        "attemptedAt": null,
                        "availability": "available",
                        "commandId": null,
                        "evidence": null,
                        "failure": null,
                        "failureEndpoint": null,
                        "operation": null,
                        "phase": "idle",
                        "safeStopped": true,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": null,
                    }),
                ),
                (
                    "pending",
                    json!({
                        "activeFingerprint": null,
                        "activeProfileId": null,
                        "attemptedAt": 1_721_296_000_000_u64,
                        "availability": "available",
                        "commandId": COMMAND_ID,
                        "evidence": null,
                        "failure": null,
                        "failureEndpoint": null,
                        "operation": "activate",
                        "phase": "pending",
                        "safeStopped": true,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": PROFILE_ID,
                    }),
                ),
                (
                    "preparing",
                    json!({
                        "activeFingerprint": null,
                        "activeProfileId": null,
                        "attemptedAt": 1_721_296_000_000_u64,
                        "availability": "available",
                        "commandId": COMMAND_ID,
                        "evidence": { "asset": "geo-site", "kind": "geodata-preparing" },
                        "failure": null,
                        "failureEndpoint": null,
                        "operation": "activate",
                        "phase": "pending",
                        "safeStopped": true,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": PROFILE_ID,
                    }),
                ),
                (
                    "succeeded",
                    json!({
                        "activeFingerprint": ACTIVE_FINGERPRINT,
                        "activeProfileId": PROFILE_ID,
                        "attemptedAt": 1_721_296_000_000_u64,
                        "availability": "available",
                        "commandId": COMMAND_ID,
                        "evidence": null,
                        "failure": null,
                        "failureEndpoint": null,
                        "operation": "activate",
                        "phase": "success",
                        "safeStopped": false,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": PROFILE_ID,
                    }),
                ),
                (
                    "failed",
                    json!({
                        "activeFingerprint": null,
                        "activeProfileId": null,
                        "attemptedAt": 1_721_296_000_000_u64,
                        "availability": "available",
                        "commandId": COMMAND_ID,
                        "evidence": null,
                        "failure": "validation",
                        "failureEndpoint": null,
                        "operation": "activate",
                        "phase": "failure",
                        "safeStopped": true,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": PROFILE_ID,
                    }),
                ),
                (
                    "cancelled",
                    json!({
                        "activeFingerprint": null,
                        "activeProfileId": null,
                        "attemptedAt": 1_721_296_000_000_u64,
                        "availability": "available",
                        "commandId": COMMAND_ID,
                        "evidence": null,
                        "failure": "cancelled",
                        "failureEndpoint": null,
                        "operation": "activate",
                        "phase": "failure",
                        "safeStopped": true,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": PROFILE_ID,
                    }),
                ),
                (
                    "rollback-succeeded",
                    json!({
                        "activeFingerprint": null,
                        "activeProfileId": null,
                        "attemptedAt": 1_721_296_000_000_u64,
                        "availability": "available",
                        "commandId": COMMAND_ID,
                        "evidence": null,
                        "failure": "capture",
                        "failureEndpoint": null,
                        "operation": "activate",
                        "phase": "failure",
                        "safeStopped": true,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": PROFILE_ID,
                    }),
                ),
                (
                    "rollback-failed",
                    json!({
                        "activeFingerprint": ACTIVE_FINGERPRINT,
                        "activeProfileId": PROFILE_ID,
                        "attemptedAt": 1_721_296_000_000_u64,
                        "availability": "available",
                        "commandId": COMMAND_ID,
                        "evidence": null,
                        "failure": "capture",
                        "failureEndpoint": null,
                        "operation": "activate",
                        "phase": "failure",
                        "safeStopped": false,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": PROFILE_ID,
                    }),
                ),
                (
                    "retrying",
                    json!({
                        "activeFingerprint": null,
                        "activeProfileId": null,
                        "attemptedAt": 1_721_296_001_000_u64,
                        "availability": "available",
                        "commandId": NEXT_COMMAND_ID,
                        "evidence": null,
                        "failure": null,
                        "failureEndpoint": null,
                        "operation": "activate",
                        "phase": "pending",
                        "safeStopped": true,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": PROFILE_ID,
                    }),
                ),
                (
                    "stop-pending",
                    json!({
                        "activeFingerprint": ACTIVE_FINGERPRINT,
                        "activeProfileId": PROFILE_ID,
                        "attemptedAt": 1_721_296_000_000_u64,
                        "availability": "available",
                        "commandId": COMMAND_ID,
                        "evidence": null,
                        "failure": null,
                        "failureEndpoint": null,
                        "operation": "stop",
                        "phase": "pending",
                        "safeStopped": false,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": PROFILE_ID,
                    }),
                ),
                (
                    "stop-succeeded",
                    json!({
                        "activeFingerprint": null,
                        "activeProfileId": null,
                        "attemptedAt": 1_721_296_000_000_u64,
                        "availability": "available",
                        "commandId": COMMAND_ID,
                        "evidence": null,
                        "failure": null,
                        "failureEndpoint": null,
                        "operation": "stop",
                        "phase": "success",
                        "safeStopped": true,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": PROFILE_ID,
                    }),
                ),
                (
                    "stop-failed",
                    json!({
                        "activeFingerprint": ACTIVE_FINGERPRINT,
                        "activeProfileId": PROFILE_ID,
                        "attemptedAt": 1_721_296_000_000_u64,
                        "availability": "available",
                        "commandId": COMMAND_ID,
                        "evidence": null,
                        "failure": "prior-stop",
                        "failureEndpoint": null,
                        "operation": "stop",
                        "phase": "failure",
                        "safeStopped": false,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": PROFILE_ID,
                    }),
                ),
                (
                    "shutdown",
                    json!({
                        "activeFingerprint": null,
                        "activeProfileId": null,
                        "attemptedAt": null,
                        "availability": "unavailable",
                        "commandId": null,
                        "evidence": null,
                        "failure": null,
                        "failureEndpoint": null,
                        "operation": null,
                        "phase": "idle",
                        "safeStopped": true,
                        "startupPolicy": "safe-stopped",
                        "targetProfileId": null,
                    }),
                ),
            ],
        );
    }

    #[test]
    fn activation_state_transition_table_is_complete() {
        use ProfileActivationStateKind as State;
        use ProfileActivationTransition as Transition;

        let states = [
            State::Idle,
            State::Pending,
            State::Succeeded,
            State::Failed,
            State::Cancelled,
            State::RollbackSucceeded,
            State::RollbackFailed,
            State::Retrying,
            State::ShuttingDown,
            State::Shutdown,
        ];
        let transitions = [
            Transition::Begin,
            Transition::Retry,
            Transition::Succeed,
            Transition::Fail,
            Transition::Cancel,
            Transition::RollbackSucceed,
            Transition::RollbackFail,
            Transition::Shutdown,
            Transition::ShutdownComplete,
            Transition::ShutdownFail,
        ];

        for state in states {
            let activation = state_fixture(state);
            for transition in transitions {
                let expected = matches!(
                    (state, transition),
                    (
                        State::Idle | State::Succeeded,
                        Transition::Begin | Transition::Shutdown
                    ) | (
                        State::Failed
                            | State::Cancelled
                            | State::RollbackSucceeded
                            | State::RollbackFailed,
                        Transition::Begin | Transition::Retry | Transition::Shutdown
                    ) | (
                        State::Pending | State::Retrying,
                        Transition::Succeed | Transition::Fail | Transition::Cancel
                    ) | (
                        State::Succeeded,
                        Transition::RollbackSucceed | Transition::RollbackFail
                    ) | (
                        State::ShuttingDown,
                        Transition::ShutdownComplete | Transition::ShutdownFail
                    )
                );
                assert_eq!(
                    activation.allows(transition),
                    expected,
                    "{state:?} -> {transition:?}"
                );
            }
        }
    }

    #[test]
    fn stale_terminal_completion_cannot_replace_a_newer_retry_scope() {
        let mut state = ProfileActivationState::idle();
        let first = state
            .begin(
                COMMAND_ID,
                ProfileActivationOperation::Activate,
                PROFILE_ID,
                1,
                CancellationToken::new(),
            )
            .unwrap();
        assert!(state.complete(
            &first,
            ProfileActivationCompletion::Failed {
                evidence: ProfileActivationFailureEvidence::Validation,
                runtime: ProfileActivationRuntime::SafeStopped,
            },
        ));
        let retry = state
            .begin(
                COMMAND_ID,
                ProfileActivationOperation::Activate,
                PROFILE_ID,
                2,
                CancellationToken::new(),
            )
            .unwrap();
        assert!(retry.scope.revision > first.scope.revision);

        assert!(!state.complete(
            &first,
            ProfileActivationCompletion::Succeeded(ProfileActivationRuntime::Active {
                fingerprint: ACTIVE_FINGERPRINT.into(),
                profile_id: PROFILE_ID.into(),
            }),
        ));
        assert_eq!(
            state
                .to_snapshot(ProfileActivationAvailability::Available)
                .attempted_at,
            Some(2)
        );
        assert!(state.complete(
            &retry,
            ProfileActivationCompletion::Succeeded(ProfileActivationRuntime::Active {
                fingerprint: ACTIVE_FINGERPRINT.into(),
                profile_id: PROFILE_ID.into(),
            }),
        ));
    }

    #[test]
    fn shutdown_failure_is_typed_and_idle_shutdown_can_restore() {
        let mut state = state_fixture(ProfileActivationStateKind::Succeeded);
        let previous = state.begin_shutdown(false, 2).unwrap();
        assert_eq!(state.kind(), ProfileActivationStateKind::ShuttingDown);
        let active = ProfileActivationRuntime::Active {
            fingerprint: ACTIVE_FINGERPRINT.into(),
            profile_id: PROFILE_ID.into(),
        };
        assert!(state.fail_shutdown(
            previous,
            ProfileActivationFailureEvidence::StateCommit,
            active,
        ));
        let failed = state.to_snapshot(ProfileActivationAvailability::Available);
        assert_eq!(failed.phase, super::ProfileActivationPhase::Failure);
        assert_eq!(
            failed.failure,
            Some(super::ProfileActivationFailure::StateCommit)
        );

        let mut idle = ProfileActivationState::idle();
        let prior = idle.clone();
        let previous = idle.begin_shutdown(false, 2).unwrap();
        assert!(idle.fail_shutdown(
            previous,
            ProfileActivationFailureEvidence::StateCommit,
            ProfileActivationRuntime::SafeStopped,
        ));
        assert_eq!(
            idle.to_snapshot(ProfileActivationAvailability::Available),
            prior.to_snapshot(ProfileActivationAvailability::Available)
        );

        let previous = state.begin_shutdown(true, 3).unwrap();
        assert!(state.complete_shutdown());
        assert_eq!(state.kind(), ProfileActivationStateKind::Shutdown);
        assert!(!state.fail_shutdown(
            previous,
            ProfileActivationFailureEvidence::StateCommit,
            ProfileActivationRuntime::SafeStopped,
        ));
    }

    fn state_fixture(kind: ProfileActivationStateKind) -> ProfileActivationState {
        let mut pending = ProfileActivationState::idle();
        let command = pending
            .begin(
                COMMAND_ID,
                ProfileActivationOperation::Activate,
                PROFILE_ID,
                1,
                CancellationToken::new(),
            )
            .unwrap();
        let active = ProfileActivationRuntime::Active {
            fingerprint: ACTIVE_FINGERPRINT.into(),
            profile_id: PROFILE_ID.into(),
        };
        match kind {
            ProfileActivationStateKind::Idle => ProfileActivationState::idle(),
            ProfileActivationStateKind::Pending => pending,
            ProfileActivationStateKind::Succeeded => {
                assert!(
                    pending.complete(&command, ProfileActivationCompletion::Succeeded(active),)
                );
                pending
            }
            ProfileActivationStateKind::Failed => {
                assert!(pending.complete(
                    &command,
                    ProfileActivationCompletion::Failed {
                        evidence: ProfileActivationFailureEvidence::Validation,
                        runtime: ProfileActivationRuntime::SafeStopped,
                    },
                ));
                pending
            }
            ProfileActivationStateKind::Cancelled => {
                assert!(pending.complete(
                    &command,
                    ProfileActivationCompletion::Cancelled(ProfileActivationRuntime::SafeStopped,),
                ));
                pending
            }
            ProfileActivationStateKind::RollbackSucceeded => {
                assert!(
                    pending.complete(&command, ProfileActivationCompletion::Succeeded(active),)
                );
                assert!(pending.complete_rollback(COMMAND_ID, None));
                pending
            }
            ProfileActivationStateKind::RollbackFailed => {
                assert!(pending.complete(
                    &command,
                    ProfileActivationCompletion::Succeeded(active.clone()),
                ));
                assert!(pending.complete_rollback(COMMAND_ID, Some(active)));
                pending
            }
            ProfileActivationStateKind::Retrying => {
                assert!(pending.complete(
                    &command,
                    ProfileActivationCompletion::Failed {
                        evidence: ProfileActivationFailureEvidence::Validation,
                        runtime: ProfileActivationRuntime::SafeStopped,
                    },
                ));
                pending
                    .begin(
                        NEXT_COMMAND_ID,
                        ProfileActivationOperation::Activate,
                        PROFILE_ID,
                        2,
                        CancellationToken::new(),
                    )
                    .unwrap();
                pending
            }
            ProfileActivationStateKind::ShuttingDown => {
                assert!(
                    pending.complete(&command, ProfileActivationCompletion::Succeeded(active),)
                );
                pending.begin_shutdown(false, 2).unwrap();
                pending
            }
            ProfileActivationStateKind::Shutdown => ProfileActivationState::Shutdown {
                scope: ProfileActivationScope::new(),
            },
        }
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

fn activation_runtime(
    safe_stopped: bool,
    active_profile_id: Option<&str>,
    active_fingerprint: Option<&str>,
) -> ProfileActivationRuntime {
    if safe_stopped {
        return ProfileActivationRuntime::SafeStopped;
    }
    match (active_profile_id, active_fingerprint) {
        (Some(profile_id), Some(fingerprint)) => ProfileActivationRuntime::Active {
            fingerprint: fingerprint.to_owned(),
            profile_id: profile_id.to_owned(),
        },
        _ => ProfileActivationRuntime::SafeStopped,
    }
}

fn activation_failure_evidence(error: MihomoActivationError) -> ProfileActivationFailureEvidence {
    match error {
        MihomoActivationError::InvalidArtifact | MihomoActivationError::InvalidTiming => {
            ProfileActivationFailureEvidence::InvalidProfile
        }
        MihomoActivationError::Resolve(MihomoResolveError::BinaryMissing) => {
            ProfileActivationFailureEvidence::MissingBinary
        }
        MihomoActivationError::Resolve(_) => ProfileActivationFailureEvidence::UnsafeRuntime,
        MihomoActivationError::StagingFailed => ProfileActivationFailureEvidence::Staging,
        MihomoActivationError::ValidationFailed => ProfileActivationFailureEvidence::Validation,
        MihomoActivationError::GeodataFailed(asset) => {
            ProfileActivationFailureEvidence::GeodataFailed(asset)
        }
        MihomoActivationError::GeodataTimeout(asset) => {
            ProfileActivationFailureEvidence::GeodataTimeout(asset)
        }
        MihomoActivationError::StartFailed => ProfileActivationFailureEvidence::Start,
        MihomoActivationError::EarlyExit => ProfileActivationFailureEvidence::EarlyExit,
        MihomoActivationError::ManagedListenerConflict(endpoint) => {
            ProfileActivationFailureEvidence::ManagedListenerConflict(endpoint.to_string())
        }
        MihomoActivationError::VersionMismatch => ProfileActivationFailureEvidence::VersionMismatch,
        MihomoActivationError::ControllerFailure => ProfileActivationFailureEvidence::Controller,
        MihomoActivationError::ReadinessTimeout => ProfileActivationFailureEvidence::Timeout,
        MihomoActivationError::CaptureFailed => ProfileActivationFailureEvidence::Capture,
        MihomoActivationError::PriorStopFailed => ProfileActivationFailureEvidence::PriorStop,
        MihomoActivationError::Cancelled
        | MihomoActivationError::StateCommitFailed
        | MihomoActivationError::RollbackFailedSafeStopped
        | MihomoActivationError::ShutdownFailed
        | MihomoActivationError::OwnershipFailed => ProfileActivationFailureEvidence::StateCommit,
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
    let actions = if profile_activation_failure_is_retryable(failure) {
        vec![ApplicationActionId::RetryProfileActivation]
    } else {
        Vec::new()
    };
    ApplicationNotification::new(
        ApplicationNotificationContent::ProfileActivationFailed(
            ProfileActivationFailedApplicationNotificationData {
                failure: profile_activation_failure_id(failure).into(),
            },
        ),
        actions,
    )
}

fn profile_activation_failure_is_retryable(failure: ProfileActivationFailure) -> bool {
    matches!(
        failure,
        ProfileActivationFailure::Staging
            | ProfileActivationFailure::Start
            | ProfileActivationFailure::EarlyExit
            | ProfileActivationFailure::Controller
            | ProfileActivationFailure::Timeout
            | ProfileActivationFailure::PriorStop
    )
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
