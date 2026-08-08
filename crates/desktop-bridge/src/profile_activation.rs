use std::{
    collections::{HashMap, HashSet},
    net::SocketAddr,
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use futures_util::future::BoxFuture;
use mish_profile::{
    ProfileAdapterKind, ProfileCapabilities, ProfileListItem, ProfilePatch, ProfilePatchEditor,
    ProfileRecord, ProfileRefreshPolicy, ProfileRefreshTrigger, ProfileSelectionSnapshot,
    ProfileServiceError, ProfileSnapshot, Timestamp,
};
use mish_runtime::{
    ApplicationActionId, ApplicationDiagnosticEvent, ApplicationNotification,
    ApplicationNotificationContent, CapabilityAvailability, CaptureFailureKind,
    CaptureOperationPhase, CaptureRequest, CaptureSelection, CaptureTransitionError, MishRuntime,
    NotificationPublication, NotificationSeverity,
    ProfileActivationAsnFailedApplicationNotificationData,
    ProfileActivationFailedApplicationNotificationData,
    ProfileActivationGeoipFailedApplicationNotificationData,
    ProfileActivationGeositeFailedApplicationNotificationData,
    ProfileActivationListenerConflictApplicationNotificationData,
    ProfileActivationMmdbFailedApplicationNotificationData, ProviderSnapshot,
    ProxyLaunchTimingApplicationEventData, StatusAdapterKind, SystemProxyPhase, TunPhase,
};
use mish_state_authority::{StateMutationAuthority, StateMutationPermit};
use mish_state_machine::{
    CorrelatedEffect, Correlation, Disposition, EffectBatch, EffectExecutor, EffectMode, Machine,
    RunnerConfig, RunnerHandle, TaskFailure, Transition, TransitionObserver, spawn_runner,
};
use serde::Serialize;
use serde_json::Value;
use tokio::{
    sync::{Mutex, broadcast},
    task::JoinHandle,
};
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

static NEXT_PROFILE_ACTIVATION_SCOPE: AtomicU64 = AtomicU64::new(1);

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
    TunHelperUnavailable,
    TunNetworkOwnershipConflict,
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
    #[serde(skip)]
    capture_failure_kind: Option<CaptureFailureKind>,
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
    epoch: u64,
    revision: u64,
}

impl ProfileActivationScope {
    fn new() -> Self {
        Self {
            authority_id: Uuid::new_v4(),
            epoch: NEXT_PROFILE_ACTIVATION_SCOPE.fetch_add(1, Ordering::Relaxed),
            revision: 0,
        }
    }

    fn next(&self) -> Self {
        Self {
            authority_id: self.authority_id,
            epoch: self.epoch,
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
        revision: Option<String>,
        runtime_id: Option<String>,
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
    target_fingerprint: Option<String>,
    target_profile_id: String,
    target_revision: Option<String>,
}

impl ProfileActivationCommand {
    fn correlation(&self, effect_id: u64) -> Correlation {
        Correlation {
            machine_authority: self.scope.authority_id.to_string(),
            scope_epoch: self.scope.epoch,
            operation_id: self.command_id.clone(),
            admitted_revision: self.scope.revision,
            effect_id,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProfileActivationStage {
    Effect,
    Finalizing,
    Recovering,
}

#[derive(Clone, Debug)]
struct ProfileActivationPending {
    command: ProfileActivationCommand,
    evidence: Option<ProfileActivationEvidence>,
    runtime: ProfileActivationRuntime,
    stage: ProfileActivationStage,
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
    TunHelperUnavailable,
    TunNetworkOwnershipConflict,
    EarlyExit,
    ManagedListenerConflict(String),
    VersionMismatch,
    Controller,
    Timeout,
    Capture(CaptureFailureKind),
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
            Self::TunHelperUnavailable => ProfileActivationFailure::TunHelperUnavailable,
            Self::TunNetworkOwnershipConflict => {
                ProfileActivationFailure::TunNetworkOwnershipConflict
            }
            Self::EarlyExit => ProfileActivationFailure::EarlyExit,
            Self::ManagedListenerConflict(_) => ProfileActivationFailure::ManagedListenerConflict,
            Self::VersionMismatch => ProfileActivationFailure::VersionMismatch,
            Self::Controller => ProfileActivationFailure::Controller,
            Self::Timeout => ProfileActivationFailure::Timeout,
            Self::Capture(_) => ProfileActivationFailure::Capture,
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
    RecoveryRequired,
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
    RecoveryRequired,
    Compensating,
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
    RecoveryRequire,
    Compensate,
}

#[derive(Clone, Debug)]
enum ProfileActivationState {
    Idle {
        scope: ProfileActivationScope,
    },
    Pending(ProfileActivationPending),
    Succeeded {
        capture_failure_kind: Option<CaptureFailureKind>,
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
    RecoveryRequired {
        command: ProfileActivationCommand,
        evidence: ProfileActivationFailureEvidence,
        runtime: ProfileActivationRuntime,
    },
    Compensating {
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
            Self::RecoveryRequired { .. } => ProfileActivationStateKind::RecoveryRequired,
            Self::Compensating { .. } => ProfileActivationStateKind::Compensating,
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
                State::Failed
                    | State::Cancelled
                    | State::RollbackSucceeded
                    | State::RollbackFailed
                    | State::RecoveryRequired,
                Transition::Begin | Transition::Retry | Transition::Shutdown
            ) | (
                State::Pending | State::Retrying,
                Transition::Succeed
                    | Transition::Fail
                    | Transition::Cancel
                    | Transition::RecoveryRequire
            ) | (
                State::Succeeded,
                Transition::Compensate | Transition::RollbackSucceed | Transition::RollbackFail
            ) | (
                State::Compensating,
                Transition::RollbackSucceed | Transition::RollbackFail
            ) | (State::ShuttingDown, Transition::ShutdownComplete)
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
            | Self::RecoveryRequired { command, .. }
            | Self::Compensating { command, .. }
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
            | Self::RecoveryRequired { runtime, .. }
            | Self::Compensating { runtime, .. }
            | Self::ShuttingDown { runtime, .. } => runtime.clone(),
        }
    }

    fn pending(&self) -> Option<&ProfileActivationPending> {
        match self {
            Self::Pending(pending) | Self::Retrying { pending, .. } => Some(pending),
            _ => None,
        }
    }

    fn pending_mut(&mut self) -> Option<&mut ProfileActivationPending> {
        match self {
            Self::Pending(pending) | Self::Retrying { pending, .. } => Some(pending),
            _ => None,
        }
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
            Self::RecoveryRequired { command, .. } if matches_target(command) => {
                Some(ProfileActivationRetryEvidence::RecoveryRequired)
            }
            _ => None,
        }
    }

    fn begin(
        &mut self,
        command_id: &str,
        operation: ProfileActivationOperation,
        target_profile_id: &str,
        target_revision: Option<String>,
        target_fingerprint: Option<String>,
        attempted_at: u64,
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
            target_fingerprint,
            target_profile_id: target_profile_id.to_owned(),
            target_revision,
        };
        let pending = ProfileActivationPending {
            command: command.clone(),
            evidence: None,
            runtime: self.runtime(),
            stage: ProfileActivationStage::Effect,
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
                Self::Succeeded {
                    capture_failure_kind: None,
                    command,
                    runtime,
                }
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

    fn complete_capture_failure(
        &mut self,
        expected: &ProfileActivationCommand,
        kind: CaptureFailureKind,
        runtime: ProfileActivationRuntime,
    ) -> bool {
        let Some(pending) = self.pending() else {
            return false;
        };
        if pending.command != *expected || !success_matches_command(expected, &runtime) {
            return false;
        }
        *self = Self::Succeeded {
            capture_failure_kind: Some(kind),
            command: expected.clone(),
            runtime,
        };
        true
    }

    fn complete_recovery_required(
        &mut self,
        expected: &ProfileActivationCommand,
        evidence: ProfileActivationFailureEvidence,
        runtime: ProfileActivationRuntime,
    ) -> bool {
        let Some(pending) = self.pending() else {
            return false;
        };
        if pending.command != *expected
            || !self.allows(ProfileActivationTransition::RecoveryRequire)
        {
            return false;
        }
        *self = Self::RecoveryRequired {
            command: expected.clone(),
            evidence,
            runtime,
        };
        true
    }

    fn complete_rollback(
        &mut self,
        command_id: &str,
        runtime: Option<ProfileActivationRuntime>,
    ) -> bool {
        let command = match self {
            Self::Succeeded { command, .. } | Self::Compensating { command, .. } => command,
            _ => return false,
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

    fn begin_compensation(&mut self, command_id: &str) -> Option<ProfileActivationCommand> {
        if !self.allows(ProfileActivationTransition::Compensate) {
            return None;
        }
        let Self::Succeeded {
            command, runtime, ..
        } = self
        else {
            return None;
        };
        if command.command_id != command_id
            || command.operation != ProfileActivationOperation::Activate
        {
            return None;
        }
        let command = command.clone();
        *self = Self::Compensating {
            command: command.clone(),
            runtime: runtime.clone(),
        };
        Some(command)
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
                revision,
                runtime_id,
            } => Self::ShuttingDown {
                command: ProfileActivationCommand {
                    attempted_at,
                    command_id: Uuid::new_v4().to_string(),
                    operation: ProfileActivationOperation::Stop,
                    scope,
                    target_fingerprint: Some(fingerprint.clone()),
                    target_profile_id: profile_id.clone(),
                    target_revision: revision.clone(),
                },
                runtime: ProfileActivationRuntime::Active {
                    fingerprint,
                    profile_id,
                    revision,
                    runtime_id,
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
            capture_failure_kind: None,
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
            Self::Succeeded {
                capture_failure_kind,
                command,
                ..
            } => {
                project_command(&mut snapshot, command);
                snapshot.capture_failure_kind = *capture_failure_kind;
                snapshot.phase = ProfileActivationPhase::Success;
            }
            Self::Failed {
                command, evidence, ..
            } => {
                project_command(&mut snapshot, command);
                snapshot.evidence = evidence.evidence();
                snapshot.capture_failure_kind = match evidence {
                    ProfileActivationFailureEvidence::Capture(kind) => Some(*kind),
                    _ => None,
                };
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
            Self::RecoveryRequired {
                command, evidence, ..
            } => {
                project_command(&mut snapshot, command);
                snapshot.evidence = evidence.evidence();
                snapshot.capture_failure_kind = match evidence {
                    ProfileActivationFailureEvidence::Capture(kind) => Some(*kind),
                    _ => None,
                };
                snapshot.failure = Some(evidence.failure());
                snapshot.failure_endpoint = evidence.failure_endpoint().map(str::to_owned);
                snapshot.phase = ProfileActivationPhase::Failure;
            }
            Self::Compensating { command, .. } => {
                project_command(&mut snapshot, command);
                snapshot.phase = ProfileActivationPhase::Pending;
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
            ProfileActivationRuntime::Active {
                fingerprint,
                profile_id,
                revision,
                ..
            },
        ) => {
            command.target_profile_id == *profile_id
                && command
                    .target_fingerprint
                    .as_ref()
                    .is_none_or(|expected| expected == fingerprint)
                && command
                    .target_revision
                    .as_ref()
                    .is_none_or(|expected| revision.as_ref() == Some(expected))
        }
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

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProfileActivationProgress {
    ManagedListenerConflict(SocketAddr),
}

pub type ProfileActivationProgressObserver =
    Arc<dyn Fn(ProfileActivationProgress) + Send + Sync + 'static>;

/// Product-specific effect boundary below the Profile activation coordinator.
///
/// The production implementation remains `MihomoActivationManager`. Tests can replace only the
/// Core/platform effects while retaining admission, cancellation, finalization, notifications,
/// runtime replacement, and RPC projection in this coordinator.
pub trait ProfileActivationEffects: Send + Sync {
    fn availability(&self) -> Result<(), MihomoResolveError>;

    fn activate_cancellable<'a>(
        &'a self,
        operation_id: &'a str,
        record: &'a ProfileRecord,
        policy: &'a ManagedRuntimePolicy,
        cancellation: CancellationToken,
        progress: ProfileActivationProgressObserver,
        final_capture: Option<(CaptureRequest, StatusAdapterKind)>,
    ) -> BoxFuture<'a, Result<crate::ActivationCommit, MihomoActivationError>>;

    fn active_runtime(&self) -> BoxFuture<'_, Option<MishRuntime>>;

    fn active_backend_matches(&self, tun_enabled: bool) -> BoxFuture<'_, Option<bool>>;

    fn managed_state(&self) -> BoxFuture<'_, crate::ManagedActivationState>;

    fn complete_runtime_handoff(&self) -> BoxFuture<'_, ()>;

    fn shutdown(&self) -> BoxFuture<'_, Result<(), MihomoActivationError>>;

    fn route_selections(&self, record: &ProfileRecord) -> HashMap<String, String>;

    fn delete_route_selections(&self, profile_id: &str);
}

impl ProfileActivationEffects for MihomoActivationManager {
    fn availability(&self) -> Result<(), MihomoResolveError> {
        MihomoActivationManager::availability(self)
    }

    fn activate_cancellable<'a>(
        &'a self,
        operation_id: &'a str,
        record: &'a ProfileRecord,
        policy: &'a ManagedRuntimePolicy,
        cancellation: CancellationToken,
        progress: ProfileActivationProgressObserver,
        final_capture: Option<(CaptureRequest, StatusAdapterKind)>,
    ) -> BoxFuture<'a, Result<crate::ActivationCommit, MihomoActivationError>> {
        Box::pin(async move {
            self.activate_cancellable_observed_for_operation(
                record,
                policy,
                cancellation,
                Some(&progress),
                final_capture,
                Some(operation_id),
            )
            .await
        })
    }

    fn active_runtime(&self) -> BoxFuture<'_, Option<MishRuntime>> {
        Box::pin(MihomoActivationManager::active_runtime(self))
    }

    fn active_backend_matches(&self, tun_enabled: bool) -> BoxFuture<'_, Option<bool>> {
        Box::pin(MihomoActivationManager::active_backend_matches(
            self,
            tun_enabled,
        ))
    }

    fn managed_state(&self) -> BoxFuture<'_, crate::ManagedActivationState> {
        Box::pin(MihomoActivationManager::managed_state(self))
    }

    fn complete_runtime_handoff(&self) -> BoxFuture<'_, ()> {
        Box::pin(MihomoActivationManager::complete_runtime_handoff(self))
    }

    fn shutdown(&self) -> BoxFuture<'_, Result<(), MihomoActivationError>> {
        Box::pin(MihomoActivationManager::shutdown(self))
    }

    fn route_selections(&self, record: &ProfileRecord) -> HashMap<String, String> {
        MihomoActivationManager::route_selections(self, record)
    }

    fn delete_route_selections(&self, profile_id: &str) {
        MihomoActivationManager::delete_route_selections(self, profile_id);
    }
}

const PROFILE_ACTIVATION_EFFECT_ID: u64 = 1;
const PROFILE_ACTIVATION_FINALIZER_EFFECT_ID: u64 = 2;
const PROFILE_ACTIVATION_RECOVERY_EFFECT_ID: u64 = 3;
const PROFILE_ACTIVATION_COMPENSATION_EFFECT_ID: u64 = 4;

#[derive(Clone, Debug)]
struct ProfileActivationCaptureContract {
    active: bool,
    adapter_kind: StatusAdapterKind,
    pending_operation_id: Option<String>,
    selection: CaptureSelection,
}

struct ProfileActivationOperationResources {
    _permit: Option<StateMutationPermit>,
    final_capture: Option<ProfileActivationCaptureContract>,
    owns_final_capture: bool,
    previous_capture: ProfileActivationCaptureContract,
    previous_host: MishRuntime,
    previous_runtime: ProfileActivationRuntime,
    suppress_capture_failure_notification: bool,
}

#[derive(Clone)]
enum ProfileActivationWork {
    Activate {
        final_capture: Option<(CaptureRequest, StatusAdapterKind)>,
        policy: Arc<ManagedRuntimePolicy>,
        record: Arc<ProfileRecord>,
    },
    Stop,
}

enum ProfileActivationMachineInput {
    Begin {
        attempted_at: u64,
        command_id: String,
        operation: ProfileActivationOperation,
        resources: Arc<ProfileActivationOperationResources>,
        target_fingerprint: Option<String>,
        target_profile_id: String,
        target_revision: Option<String>,
        work: ProfileActivationWork,
    },
    Reject {
        attempted_at: u64,
        command_id: String,
        evidence: ProfileActivationFailureEvidence,
        target_fingerprint: Option<String>,
        target_profile_id: String,
        target_revision: Option<String>,
    },
    Compensate {
        command_id: String,
        resources: Arc<ProfileActivationOperationResources>,
    },
    CompensationFinished {
        correlation: Correlation,
        finalization: ProfileActivationCompensation,
        _resources: Arc<ProfileActivationOperationResources>,
    },
    Retire {
        attempted_at: u64,
        terminal: bool,
    },
    Cancel {
        command_id: String,
    },
    TaskFinished {
        correlation: Correlation,
        outcome: ProfileActivationTaskOutcome,
    },
    Finalized {
        correlation: Correlation,
        finalization: ProfileActivationFinalization,
        _resources: Arc<ProfileActivationOperationResources>,
    },
    TaskFailed {
        correlation: Correlation,
        failure: TaskFailure,
    },
    Shutdown,
}

#[derive(Clone)]
enum ProfileActivationTaskOutcome {
    Activate(Result<crate::ActivationCommit, MihomoActivationError>),
    Stop(Result<(), MihomoActivationError>),
    Failed(TaskFailure),
}

#[derive(Clone)]
enum ProfileActivationFinalization {
    Completed(ProfileActivationCompletion),
    CaptureFailure {
        kind: CaptureFailureKind,
        runtime: ProfileActivationRuntime,
    },
    RecoveryRequired {
        evidence: ProfileActivationFailureEvidence,
        runtime: ProfileActivationRuntime,
    },
}

#[derive(Clone)]
enum ProfileActivationCompensation {
    RestoredSafe,
    RecoveryRequired {
        evidence: ProfileActivationFailureEvidence,
        runtime: ProfileActivationRuntime,
    },
}

enum ProfileActivationMachineEffect {
    Activate {
        command: ProfileActivationCommand,
        correlation: Correlation,
        final_capture: Option<(CaptureRequest, StatusAdapterKind)>,
        policy: Arc<ManagedRuntimePolicy>,
        record: Arc<ProfileRecord>,
        resources: Arc<ProfileActivationOperationResources>,
    },
    Stop {
        command: ProfileActivationCommand,
        correlation: Correlation,
        resources: Arc<ProfileActivationOperationResources>,
    },
    Finalize {
        command: ProfileActivationCommand,
        correlation: Correlation,
        outcome: ProfileActivationTaskOutcome,
    },
    Compensate {
        correlation: Correlation,
        resources: Arc<ProfileActivationOperationResources>,
    },
    Cancel(Correlation),
}

impl CorrelatedEffect for ProfileActivationMachineEffect {
    fn correlation(&self) -> &Correlation {
        match self {
            Self::Activate { correlation, .. }
            | Self::Stop { correlation, .. }
            | Self::Finalize { correlation, .. }
            | Self::Compensate { correlation, .. }
            | Self::Cancel(correlation) => correlation,
        }
    }

    fn mode(&self) -> EffectMode {
        if matches!(self, Self::Cancel(_)) {
            EffectMode::Cancel
        } else {
            EffectMode::Spawn
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProfileActivationMachineError {
    Conflict,
    Unavailable,
}

struct ProfileActivationMachine;

impl ProfileActivationMachine {
    fn matching_pending<'a>(
        state: &'a ProfileActivationState,
        correlation: &Correlation,
    ) -> Option<&'a ProfileActivationPending> {
        state.pending().filter(|pending| {
            pending
                .command
                .correlation(correlation.effect_id)
                .same_operation(correlation)
        })
    }
}

impl Machine for ProfileActivationMachine {
    type State = ProfileActivationState;
    type Input = ProfileActivationMachineInput;
    type Effect = ProfileActivationMachineEffect;
    type Error = ProfileActivationMachineError;

    fn reduce(
        &self,
        state: &Self::State,
        input: &Self::Input,
    ) -> Transition<Self::State, Self::Effect, Self::Error> {
        match input {
            ProfileActivationMachineInput::Begin {
                attempted_at,
                command_id,
                operation,
                resources,
                target_fingerprint,
                target_profile_id,
                target_revision,
                work,
            } => {
                let mut next = state.clone();
                let Ok(command) = next.begin(
                    command_id,
                    *operation,
                    target_profile_id,
                    target_revision.clone(),
                    target_fingerprint.clone(),
                    *attempted_at,
                ) else {
                    return Transition::Rejected(ProfileActivationMachineError::Conflict);
                };
                let correlation = command.correlation(PROFILE_ACTIVATION_EFFECT_ID);
                let effect = match work {
                    ProfileActivationWork::Activate {
                        final_capture,
                        policy,
                        record,
                    } => ProfileActivationMachineEffect::Activate {
                        command,
                        correlation,
                        final_capture: final_capture.clone(),
                        policy: policy.clone(),
                        record: record.clone(),
                        resources: resources.clone(),
                    },
                    ProfileActivationWork::Stop => ProfileActivationMachineEffect::Stop {
                        command,
                        correlation,
                        resources: resources.clone(),
                    },
                };
                Transition::EffectEmitting {
                    state: next,
                    effects: EffectBatch::one(effect),
                }
            }
            ProfileActivationMachineInput::Cancel { command_id } => {
                let Some(pending) = state.pending() else {
                    return Transition::Unchanged;
                };
                if pending.command.command_id != *command_id
                    || pending.stage != ProfileActivationStage::Effect
                {
                    return Transition::Unchanged;
                }
                Transition::EffectEmitting {
                    state: state.clone(),
                    effects: EffectBatch::one(ProfileActivationMachineEffect::Cancel(
                        pending.command.correlation(PROFILE_ACTIVATION_EFFECT_ID),
                    )),
                }
            }
            ProfileActivationMachineInput::Reject {
                attempted_at,
                command_id,
                evidence,
                target_fingerprint,
                target_profile_id,
                target_revision,
            } => {
                let runtime = state.runtime();
                let mut next = state.clone();
                let Ok(command) = next.begin(
                    command_id,
                    ProfileActivationOperation::Activate,
                    target_profile_id,
                    target_revision.clone(),
                    target_fingerprint.clone(),
                    *attempted_at,
                ) else {
                    return Transition::Rejected(ProfileActivationMachineError::Conflict);
                };
                if !next.complete(
                    &command,
                    ProfileActivationCompletion::Failed {
                        evidence: evidence.clone(),
                        runtime,
                    },
                ) {
                    return Transition::Retired;
                }
                Transition::Failed(next)
            }
            ProfileActivationMachineInput::Compensate {
                command_id,
                resources,
            } => {
                let mut next = state.clone();
                let Some(command) = next.begin_compensation(command_id) else {
                    return Transition::Rejected(ProfileActivationMachineError::Conflict);
                };
                Transition::EffectEmitting {
                    state: next,
                    effects: EffectBatch::one(ProfileActivationMachineEffect::Compensate {
                        correlation: command.correlation(PROFILE_ACTIVATION_COMPENSATION_EFFECT_ID),
                        resources: resources.clone(),
                    }),
                }
            }
            ProfileActivationMachineInput::CompensationFinished {
                correlation,
                finalization,
                ..
            } => {
                let ProfileActivationState::Compensating { command, .. } = state else {
                    return Transition::Retired;
                };
                if correlation.effect_id != PROFILE_ACTIVATION_COMPENSATION_EFFECT_ID
                    || !command
                        .correlation(correlation.effect_id)
                        .same_operation(correlation)
                {
                    return Transition::Retired;
                }
                let mut next = state.clone();
                match finalization {
                    ProfileActivationCompensation::RestoredSafe => {
                        if !next.complete_rollback(&command.command_id, None) {
                            return Transition::Retired;
                        }
                        Transition::Failed(next)
                    }
                    ProfileActivationCompensation::RecoveryRequired { evidence, runtime } => {
                        next = ProfileActivationState::RecoveryRequired {
                            command: command.clone(),
                            evidence: evidence.clone(),
                            runtime: runtime.clone(),
                        };
                        Transition::RecoveryRequired(next)
                    }
                }
            }
            ProfileActivationMachineInput::Retire {
                attempted_at,
                terminal,
            } => {
                let mut next = state.clone();
                if next.begin_shutdown(*terminal, *attempted_at).is_err()
                    || !next.complete_shutdown()
                {
                    return Transition::Rejected(ProfileActivationMachineError::Conflict);
                }
                Transition::Committed(next)
            }
            ProfileActivationMachineInput::TaskFinished {
                correlation,
                outcome,
            } => {
                let Some(pending) = Self::matching_pending(state, correlation) else {
                    return Transition::Retired;
                };
                if correlation.effect_id != PROFILE_ACTIVATION_EFFECT_ID
                    || pending.stage != ProfileActivationStage::Effect
                {
                    return Transition::Retired;
                }
                let mut next = state.clone();
                let next_pending = next
                    .pending_mut()
                    .expect("matching pending activation must remain pending");
                next_pending.stage = ProfileActivationStage::Finalizing;
                Transition::EffectEmitting {
                    state: next,
                    effects: EffectBatch::one(ProfileActivationMachineEffect::Finalize {
                        command: pending.command.clone(),
                        correlation: pending
                            .command
                            .correlation(PROFILE_ACTIVATION_FINALIZER_EFFECT_ID),
                        outcome: outcome.clone(),
                    }),
                }
            }
            ProfileActivationMachineInput::Finalized {
                correlation,
                finalization,
                ..
            } => {
                let Some(pending) = Self::matching_pending(state, correlation) else {
                    return Transition::Retired;
                };
                let matching_stage = (correlation.effect_id
                    == PROFILE_ACTIVATION_FINALIZER_EFFECT_ID
                    && pending.stage == ProfileActivationStage::Finalizing)
                    || (correlation.effect_id == PROFILE_ACTIVATION_RECOVERY_EFFECT_ID
                        && pending.stage == ProfileActivationStage::Recovering);
                if !matching_stage {
                    return Transition::Retired;
                }
                let command = pending.command.clone();
                let mut next = state.clone();
                let disposition = match finalization {
                    ProfileActivationFinalization::Completed(completion) => {
                        if !next.complete(&command, completion.clone()) {
                            return Transition::Retired;
                        }
                        match completion {
                            ProfileActivationCompletion::Succeeded(_) => Disposition::Committed,
                            ProfileActivationCompletion::Cancelled(_) => Disposition::Cancelled,
                            ProfileActivationCompletion::Failed { .. } => Disposition::Failed,
                        }
                    }
                    ProfileActivationFinalization::CaptureFailure { kind, runtime } => {
                        if !next.complete_capture_failure(&command, *kind, runtime.clone()) {
                            return Transition::Retired;
                        }
                        Disposition::Failed
                    }
                    ProfileActivationFinalization::RecoveryRequired { evidence, runtime } => {
                        if !next.complete_recovery_required(
                            &command,
                            evidence.clone(),
                            runtime.clone(),
                        ) {
                            return Transition::Retired;
                        }
                        Disposition::RecoveryRequired
                    }
                };
                match disposition {
                    Disposition::Committed => Transition::Committed(next),
                    Disposition::Cancelled => Transition::Cancelled(next),
                    Disposition::Failed => Transition::Failed(next),
                    Disposition::RecoveryRequired => Transition::RecoveryRequired(next),
                    _ => unreachable!("terminal activation disposition must be closed"),
                }
            }
            ProfileActivationMachineInput::TaskFailed {
                correlation,
                failure,
            } => {
                if let ProfileActivationState::Compensating { command, runtime } = state
                    && correlation.effect_id == PROFILE_ACTIVATION_COMPENSATION_EFFECT_ID
                    && command
                        .correlation(correlation.effect_id)
                        .same_operation(correlation)
                {
                    return Transition::RecoveryRequired(
                        ProfileActivationState::RecoveryRequired {
                            command: command.clone(),
                            evidence: ProfileActivationFailureEvidence::StateCommit,
                            runtime: runtime.clone(),
                        },
                    );
                }
                let Some(pending) = Self::matching_pending(state, correlation) else {
                    return Transition::Retired;
                };
                if correlation.effect_id == PROFILE_ACTIVATION_EFFECT_ID
                    && pending.stage == ProfileActivationStage::Effect
                {
                    let mut next = state.clone();
                    next.pending_mut()
                        .expect("matching pending activation must remain pending")
                        .stage = ProfileActivationStage::Finalizing;
                    return Transition::EffectEmitting {
                        state: next,
                        effects: EffectBatch::one(ProfileActivationMachineEffect::Finalize {
                            command: pending.command.clone(),
                            correlation: pending
                                .command
                                .correlation(PROFILE_ACTIVATION_FINALIZER_EFFECT_ID),
                            outcome: ProfileActivationTaskOutcome::Failed(*failure),
                        }),
                    };
                }
                if correlation.effect_id == PROFILE_ACTIVATION_FINALIZER_EFFECT_ID
                    && pending.stage == ProfileActivationStage::Finalizing
                {
                    let mut next = state.clone();
                    next.pending_mut()
                        .expect("matching pending activation must remain pending")
                        .stage = ProfileActivationStage::Recovering;
                    return Transition::EffectEmitting {
                        state: next,
                        effects: EffectBatch::one(ProfileActivationMachineEffect::Finalize {
                            command: pending.command.clone(),
                            correlation: pending
                                .command
                                .correlation(PROFILE_ACTIVATION_RECOVERY_EFFECT_ID),
                            outcome: ProfileActivationTaskOutcome::Failed(*failure),
                        }),
                    };
                }
                if correlation.effect_id == PROFILE_ACTIVATION_RECOVERY_EFFECT_ID
                    && pending.stage == ProfileActivationStage::Recovering
                {
                    let command = pending.command.clone();
                    let runtime = pending.runtime.clone();
                    let mut next = state.clone();
                    if next.complete_recovery_required(
                        &command,
                        ProfileActivationFailureEvidence::StateCommit,
                        runtime,
                    ) {
                        return Transition::RecoveryRequired(next);
                    }
                }
                Transition::Retired
            }
            ProfileActivationMachineInput::Shutdown => {
                let Some(pending) = state.pending() else {
                    return Transition::Retired;
                };
                Transition::EffectEmitting {
                    state: state.clone(),
                    effects: EffectBatch::one(ProfileActivationMachineEffect::Cancel(
                        pending.command.correlation(PROFILE_ACTIVATION_EFFECT_ID),
                    )),
                }
            }
        }
    }

    fn state_label(&self, state: &Self::State) -> &'static str {
        match state.kind() {
            ProfileActivationStateKind::Idle => "idle",
            ProfileActivationStateKind::Pending => "pending-effect",
            ProfileActivationStateKind::Retrying => "retrying-effect",
            ProfileActivationStateKind::Succeeded => "succeeded",
            ProfileActivationStateKind::Failed => "failed",
            ProfileActivationStateKind::Cancelled => "cancelled",
            ProfileActivationStateKind::RollbackSucceeded => "rollback-succeeded",
            ProfileActivationStateKind::RollbackFailed => "rollback-failed",
            ProfileActivationStateKind::RecoveryRequired => "recovery-required",
            ProfileActivationStateKind::Compensating => "compensating",
            ProfileActivationStateKind::ShuttingDown => "shutting-down",
            ProfileActivationStateKind::Shutdown => "shutdown",
        }
    }

    fn input_label(&self, input: &Self::Input) -> &'static str {
        match input {
            ProfileActivationMachineInput::Begin { operation, .. } => match operation {
                ProfileActivationOperation::Activate => "begin-activate",
                ProfileActivationOperation::Stop => "begin-stop",
            },
            ProfileActivationMachineInput::Reject { .. } => "reject-activation",
            ProfileActivationMachineInput::Compensate { .. } => "begin-compensation",
            ProfileActivationMachineInput::CompensationFinished { finalization, .. } => {
                match finalization {
                    ProfileActivationCompensation::RestoredSafe => "compensation-restored-safe",
                    ProfileActivationCompensation::RecoveryRequired { .. } => {
                        "compensation-recovery-required"
                    }
                }
            }
            ProfileActivationMachineInput::Retire { .. } => "retire",
            ProfileActivationMachineInput::Cancel { .. } => "cancel",
            ProfileActivationMachineInput::TaskFinished { outcome, .. } => match outcome {
                ProfileActivationTaskOutcome::Activate(Ok(_)) => "activation-effect-succeeded",
                ProfileActivationTaskOutcome::Activate(Err(_)) => "activation-effect-failed",
                ProfileActivationTaskOutcome::Stop(Ok(())) => "stop-effect-succeeded",
                ProfileActivationTaskOutcome::Stop(Err(_)) => "stop-effect-failed",
                ProfileActivationTaskOutcome::Failed(TaskFailure::Aborted) => "task-aborted",
                ProfileActivationTaskOutcome::Failed(TaskFailure::CompletionConflict) => {
                    "task-completion-conflict"
                }
                ProfileActivationTaskOutcome::Failed(TaskFailure::Panicked) => "task-panicked",
            },
            ProfileActivationMachineInput::Finalized { finalization, .. } => match finalization {
                ProfileActivationFinalization::Completed(
                    ProfileActivationCompletion::Succeeded(_),
                ) => "finalized-success",
                ProfileActivationFinalization::Completed(
                    ProfileActivationCompletion::Cancelled(_),
                ) => "finalized-cancelled",
                ProfileActivationFinalization::Completed(ProfileActivationCompletion::Failed {
                    ..
                })
                | ProfileActivationFinalization::CaptureFailure { .. } => "finalized-failure",
                ProfileActivationFinalization::RecoveryRequired { .. } => {
                    "finalized-recovery-required"
                }
            },
            ProfileActivationMachineInput::TaskFailed { failure, .. } => match failure {
                TaskFailure::Aborted => "task-aborted",
                TaskFailure::CompletionConflict => "task-completion-conflict",
                TaskFailure::Panicked => "task-panicked",
            },
            ProfileActivationMachineInput::Shutdown => "shutdown",
        }
    }

    fn input_correlation(&self, _state: &Self::State, input: &Self::Input) -> Option<Correlation> {
        match input {
            ProfileActivationMachineInput::TaskFinished { correlation, .. }
            | ProfileActivationMachineInput::Finalized { correlation, .. }
            | ProfileActivationMachineInput::CompensationFinished { correlation, .. }
            | ProfileActivationMachineInput::TaskFailed { correlation, .. } => {
                Some(correlation.clone())
            }
            ProfileActivationMachineInput::Begin { .. }
            | ProfileActivationMachineInput::Reject { .. }
            | ProfileActivationMachineInput::Compensate { .. }
            | ProfileActivationMachineInput::Retire { .. }
            | ProfileActivationMachineInput::Cancel { .. }
            | ProfileActivationMachineInput::Shutdown => None,
        }
    }

    fn task_failed(&self, correlation: Correlation, failure: TaskFailure) -> Self::Input {
        ProfileActivationMachineInput::TaskFailed {
            correlation,
            failure,
        }
    }

    fn shutdown(&self) -> Self::Input {
        ProfileActivationMachineInput::Shutdown
    }

    fn unavailable(&self) -> Self::Error {
        ProfileActivationMachineError::Unavailable
    }
}

struct ProfileActivationMachineExecutor {
    host: DesktopRuntimeHost,
    manager: Arc<dyn ProfileActivationEffects>,
    operations: Arc<std::sync::Mutex<HashMap<String, Arc<ProfileActivationOperationResources>>>>,
    safe_runtime: MishRuntime,
}

impl EffectExecutor<ProfileActivationMachine> for ProfileActivationMachineExecutor {
    fn execute(
        &self,
        effect: ProfileActivationMachineEffect,
        cancellation: CancellationToken,
    ) -> std::pin::Pin<Box<dyn std::future::Future<Output = ProfileActivationMachineInput> + Send>>
    {
        let host = self.host.clone();
        let manager = self.manager.clone();
        let operations = self.operations.clone();
        let safe_runtime = self.safe_runtime.clone();
        Box::pin(async move {
            match effect {
                ProfileActivationMachineEffect::Activate {
                    command,
                    correlation,
                    final_capture,
                    policy,
                    record,
                    resources,
                } => {
                    operations
                        .lock()
                        .expect("Profile activation operation lock poisoned")
                        .insert(command.command_id.clone(), resources);
                    let progress_host = host.clone();
                    let progress_command_id = command.command_id.clone();
                    let progress: ProfileActivationProgressObserver =
                        Arc::new(move |event| match event {
                            ProfileActivationProgress::ManagedListenerConflict(endpoint) => {
                                publish_activation_failure_notification(
                                    &progress_host,
                                    &progress_command_id,
                                    MihomoActivationError::ManagedListenerConflict(endpoint),
                                );
                            }
                        });
                    let result = manager
                        .activate_cancellable(
                            &command.command_id,
                            &record,
                            &policy,
                            cancellation,
                            progress,
                            final_capture,
                        )
                        .await;
                    ProfileActivationMachineInput::TaskFinished {
                        correlation,
                        outcome: ProfileActivationTaskOutcome::Activate(result),
                    }
                }
                ProfileActivationMachineEffect::Stop {
                    command,
                    correlation,
                    resources,
                } => {
                    operations
                        .lock()
                        .expect("Profile activation operation lock poisoned")
                        .insert(command.command_id, resources);
                    let result = manager.shutdown().await;
                    ProfileActivationMachineInput::TaskFinished {
                        correlation,
                        outcome: ProfileActivationTaskOutcome::Stop(result),
                    }
                }
                ProfileActivationMachineEffect::Finalize {
                    command,
                    correlation,
                    outcome,
                } => {
                    // The first finalizer retains operation ownership across a panic so the
                    // recovery finalizer can re-observe the authoritative state. The recovery
                    // finalizer removes ownership before awaiting; a second panic therefore
                    // releases the mutation permit instead of stranding the coordinator.
                    let recovering = correlation.effect_id == PROFILE_ACTIVATION_RECOVERY_EFFECT_ID;
                    let resources = {
                        let mut operations = operations
                            .lock()
                            .expect("Profile activation operation lock poisoned");
                        if recovering {
                            operations.remove(&command.command_id)
                        } else {
                            operations.get(&command.command_id).cloned()
                        }
                    };
                    if recovering {
                        // A recovery finalizer can only publish failure or RecoveryRequired.
                        // Release the committed Capture reservation before any fallible
                        // observation so a second finalizer failure cannot block the retry that
                        // the terminal Profile state explicitly permits. Operation resources
                        // retain the mutation permit until this finalizer exits.
                        manager.complete_runtime_handoff().await;
                    }
                    let finalization = match resources.as_ref() {
                        Some(resources) => {
                            finalize_profile_activation(
                                manager.as_ref(),
                                &host,
                                &safe_runtime,
                                &command,
                                &outcome,
                                resources,
                            )
                            .await
                        }
                        None => ProfileActivationFinalization::RecoveryRequired {
                            evidence: ProfileActivationFailureEvidence::StateCommit,
                            runtime: command_runtime_fallback(&command),
                        },
                    };
                    if !recovering
                        && matches!(
                            &finalization,
                            ProfileActivationFinalization::RecoveryRequired { .. }
                        )
                    {
                        // RecoveryRequired is terminal for this attempt but retryable by the
                        // Profile machine. The reservation cannot remain owned by a completed
                        // operation after all authoritative observations have finished.
                        manager.complete_runtime_handoff().await;
                    }
                    let resources = if recovering {
                        resources
                    } else {
                        operations
                            .lock()
                            .expect("Profile activation operation lock poisoned")
                            .remove(&command.command_id)
                    }
                    .unwrap_or_else(|| fallback_operation_resources(&safe_runtime));
                    ProfileActivationMachineInput::Finalized {
                        correlation,
                        finalization,
                        _resources: resources,
                    }
                }
                ProfileActivationMachineEffect::Compensate {
                    correlation,
                    resources,
                } => {
                    let result = manager.shutdown().await;
                    let managed = manager.managed_state().await;
                    let active_runtime = manager.active_runtime().await;
                    let runtime = activation_runtime_from_managed(&managed);
                    let safe_contract = ProfileActivationCaptureContract {
                        active: false,
                        adapter_kind: resources.previous_capture.adapter_kind,
                        pending_operation_id: resources
                            .previous_capture
                            .pending_operation_id
                            .clone(),
                        selection: resources.previous_capture.selection.clone(),
                    };
                    let capture_confirmed =
                        capture_contract_matches(&safe_runtime, &safe_contract).await;
                    let finalization = if result.is_ok()
                        && managed.is_safe_stopped()
                        && active_runtime.is_none()
                        && capture_confirmed
                    {
                        host.replace(safe_runtime.clone());
                        manager.complete_runtime_handoff().await;
                        ProfileActivationCompensation::RestoredSafe
                    } else {
                        ProfileActivationCompensation::RecoveryRequired {
                            evidence: result.err().map_or(
                                ProfileActivationFailureEvidence::StateCommit,
                                activation_failure_evidence,
                            ),
                            runtime,
                        }
                    };
                    ProfileActivationMachineInput::CompensationFinished {
                        correlation,
                        finalization,
                        _resources: resources,
                    }
                }
                ProfileActivationMachineEffect::Cancel(correlation) => {
                    ProfileActivationMachineInput::TaskFailed {
                        correlation,
                        failure: TaskFailure::Aborted,
                    }
                }
            }
        })
    }
}

fn fallback_operation_resources(
    safe_runtime: &MishRuntime,
) -> Arc<ProfileActivationOperationResources> {
    Arc::new(ProfileActivationOperationResources {
        _permit: None,
        final_capture: None,
        owns_final_capture: false,
        previous_capture: ProfileActivationCaptureContract {
            active: false,
            adapter_kind: StatusAdapterKind::Rpc,
            pending_operation_id: None,
            selection: CaptureSelection {
                system_proxy: false,
                tun: false,
            },
        },
        previous_host: safe_runtime.clone(),
        previous_runtime: ProfileActivationRuntime::SafeStopped,
        suppress_capture_failure_notification: false,
    })
}

struct ProfileActivationProjectionObserver {
    availability: ProfileActivationAvailability,
    updates: broadcast::Sender<ProfileActivationSnapshot>,
}

impl TransitionObserver<ProfileActivationMachine> for ProfileActivationProjectionObserver {
    fn transitioned(
        &self,
        _previous: &ProfileActivationState,
        _input: &ProfileActivationMachineInput,
        current: &ProfileActivationState,
        _disposition: Disposition,
    ) {
        let _ = self.updates.send(current.to_snapshot(self.availability));
    }
}

fn command_runtime_fallback(command: &ProfileActivationCommand) -> ProfileActivationRuntime {
    match command.operation {
        ProfileActivationOperation::Activate => ProfileActivationRuntime::Active {
            fingerprint: command.target_fingerprint.clone().unwrap_or_default(),
            profile_id: command.target_profile_id.clone(),
            revision: command.target_revision.clone(),
            runtime_id: None,
        },
        ProfileActivationOperation::Stop => ProfileActivationRuntime::SafeStopped,
    }
}

fn activation_runtime_from_managed(
    managed: &crate::ManagedActivationState,
) -> ProfileActivationRuntime {
    if managed.is_safe_stopped() {
        return ProfileActivationRuntime::SafeStopped;
    }
    match (managed.active_profile_id(), managed.active_fingerprint()) {
        (Some(profile_id), Some(fingerprint)) => ProfileActivationRuntime::Active {
            fingerprint: fingerprint.to_owned(),
            profile_id: profile_id.to_owned(),
            revision: managed.active_revision().map(str::to_owned),
            runtime_id: managed.active_runtime_id().map(str::to_owned),
        },
        _ => ProfileActivationRuntime::SafeStopped,
    }
}

fn managed_matches_runtime(
    managed: &crate::ManagedActivationState,
    expected: &ProfileActivationRuntime,
) -> bool {
    match expected {
        ProfileActivationRuntime::SafeStopped => managed.is_safe_stopped(),
        ProfileActivationRuntime::Active {
            fingerprint,
            profile_id,
            revision,
            runtime_id,
        } => {
            managed.active_profile_id() == Some(profile_id)
                && managed.active_fingerprint() == Some(fingerprint)
                && revision
                    .as_deref()
                    .is_none_or(|value| managed.active_revision() == Some(value))
                && runtime_id
                    .as_deref()
                    .is_none_or(|value| managed.active_runtime_id() == Some(value))
        }
    }
}

fn report_profile_activation_recovery_required(
    host: &DesktopRuntimeHost,
    command: &ProfileActivationCommand,
    evidence: &ProfileActivationFailureEvidence,
    resources: &ProfileActivationOperationResources,
    source_error: Option<MihomoActivationError>,
) {
    if let ProfileActivationFailureEvidence::Capture(kind) = evidence {
        let selection = resources
            .final_capture
            .as_ref()
            .unwrap_or(&resources.previous_capture)
            .selection
            .clone();
        host.record_capture_failure_for_selection(
            &CaptureTransitionError::new(
                *kind,
                "Capture authority could not be confirmed after the Profile runtime switch",
            ),
            &selection,
        );
    }
    let error = source_error.unwrap_or(match evidence {
        ProfileActivationFailureEvidence::Capture(kind) => {
            MihomoActivationError::CaptureFailed(*kind)
        }
        _ => MihomoActivationError::StateCommitFailed,
    });
    host.record_application_event(activation_failure_event(error));
    if should_publish_activation_failure_notification(
        error,
        resources.suppress_capture_failure_notification,
    ) {
        publish_activation_failure_notification(host, &command.command_id, error);
    }
}

async fn capture_contract_matches(
    runtime: &MishRuntime,
    contract: &ProfileActivationCaptureContract,
) -> bool {
    let snapshot = runtime.status_snapshot_typed(contract.adapter_kind).await;
    let current = snapshot.runtime;
    let system_proxy_expected = contract.active && contract.selection.system_proxy;
    let tun_expected = contract.active && contract.selection.tun;
    let owned_pending = contract
        .pending_operation_id
        .as_deref()
        .is_some_and(|operation_id| {
            current.capture_operation.phase == CaptureOperationPhase::Pending
                && current.capture_operation.operation_id.as_deref() == Some(operation_id)
        });
    let operation_confirmed = if contract.active {
        current.capture_operation.phase == CaptureOperationPhase::Applied
    } else if let Some(operation_id) = contract.pending_operation_id.as_deref() {
        (current.capture_operation.phase == CaptureOperationPhase::Pending
            && current.capture_operation.operation_id.as_deref() == Some(operation_id))
            || matches!(
                current.capture_operation.phase,
                CaptureOperationPhase::Idle
                    | CaptureOperationPhase::Applied
                    | CaptureOperationPhase::Failed
            )
    } else {
        matches!(
            current.capture_operation.phase,
            CaptureOperationPhase::Idle
                | CaptureOperationPhase::Applied
                | CaptureOperationPhase::Failed
        )
    };
    operation_confirmed
        && current.capture_selection == contract.selection
        && current.system_proxy_enabled == system_proxy_expected
        && current.tun_enabled == tun_expected
        && current.system_proxy.phase
            == if system_proxy_expected {
                SystemProxyPhase::Applied
            } else if owned_pending && contract.selection.system_proxy {
                SystemProxyPhase::Pending
            } else {
                SystemProxyPhase::Off
            }
        && current.tun.phase
            == if tun_expected {
                TunPhase::Applied
            } else if owned_pending && contract.selection.tun {
                TunPhase::Pending
            } else {
                TunPhase::Off
            }
}

async fn prior_runtime_and_capture_restored(
    managed: &crate::ManagedActivationState,
    active_runtime: Option<&MishRuntime>,
    safe_runtime: &MishRuntime,
    resources: &ProfileActivationOperationResources,
) -> bool {
    match (&resources.previous_runtime, active_runtime) {
        (ProfileActivationRuntime::Active { .. }, Some(runtime)) => {
            managed_matches_runtime(managed, &resources.previous_runtime)
                && runtime.is_same_instance(&resources.previous_host)
                && capture_contract_matches(runtime, &resources.previous_capture).await
        }
        (ProfileActivationRuntime::SafeStopped, None) => {
            managed.is_safe_stopped()
                && capture_contract_matches(safe_runtime, &resources.previous_capture).await
        }
        _ => false,
    }
}

async fn finalize_profile_activation(
    manager: &dyn ProfileActivationEffects,
    host: &DesktopRuntimeHost,
    safe_runtime: &MishRuntime,
    command: &ProfileActivationCommand,
    outcome: &ProfileActivationTaskOutcome,
    resources: &ProfileActivationOperationResources,
) -> ProfileActivationFinalization {
    let managed = manager.managed_state().await;
    let active_runtime = manager.active_runtime().await;
    let observed_runtime = activation_runtime_from_managed(&managed);

    match outcome {
        ProfileActivationTaskOutcome::Activate(Ok(commit)) => {
            let committed = ProfileActivationRuntime::Active {
                fingerprint: commit.fingerprint().to_owned(),
                profile_id: commit.profile_id().to_owned(),
                revision: Some(commit.revision().to_owned()),
                runtime_id: Some(commit.runtime_id().to_owned()),
            };
            let expected_capture = resources
                .final_capture
                .clone()
                .unwrap_or_else(|| resources.previous_capture.clone());
            let authoritative = managed_matches_runtime(&managed, &committed)
                && success_matches_command(command, &committed)
                && active_runtime.as_ref().is_some_and(|runtime| {
                    runtime.active_profile_identity().as_deref() == Some(commit.profile_id())
                });
            let capture_confirmed = match active_runtime.as_ref() {
                Some(runtime) => capture_contract_matches(runtime, &expected_capture).await,
                None => false,
            };
            if authoritative {
                // The manager commits and retires the previous runtime before final Capture
                // observation. Keep every host consumer on that exact committed instance even
                // when Capture cannot be confirmed and the Profile projection must expose
                // RecoveryRequired; otherwise status and retry baselines keep targeting the
                // retired runtime while the manager owns the candidate.
                host.replace(active_runtime.expect("authoritative runtime was checked above"));
                if capture_confirmed {
                    manager.complete_runtime_handoff().await;
                    resolve_geodata_notifications(host, &command.command_id, None);
                    return ProfileActivationFinalization::Completed(
                        ProfileActivationCompletion::Succeeded(committed),
                    );
                }
            }
            let evidence = if authoritative {
                ProfileActivationFailureEvidence::Capture(CaptureFailureKind::ObservationFailed)
            } else {
                ProfileActivationFailureEvidence::StateCommit
            };
            report_profile_activation_recovery_required(host, command, &evidence, resources, None);
            ProfileActivationFinalization::RecoveryRequired {
                evidence,
                runtime: observed_runtime,
            }
        }
        ProfileActivationTaskOutcome::Activate(Err(error)) => {
            let prior_restored = prior_runtime_and_capture_restored(
                &managed,
                active_runtime.as_ref(),
                safe_runtime,
                resources,
            )
            .await;
            let safe_stopped = managed.is_safe_stopped()
                && active_runtime.is_none()
                && capture_contract_matches(
                    safe_runtime,
                    &ProfileActivationCaptureContract {
                        active: false,
                        adapter_kind: resources.previous_capture.adapter_kind,
                        pending_operation_id: resources
                            .previous_capture
                            .pending_operation_id
                            .clone(),
                        selection: resources.previous_capture.selection.clone(),
                    },
                )
                .await;
            if prior_restored || safe_stopped {
                if let Some(runtime) = active_runtime {
                    host.replace(runtime);
                } else {
                    host.replace(safe_runtime.clone());
                }
                manager.complete_runtime_handoff().await;
                if resources.owns_final_capture
                    && let MihomoActivationError::CaptureFailed(kind) = error
                    && !observed_runtime.is_safe_stopped()
                {
                    if let Some(final_capture) = resources.final_capture.as_ref() {
                        host.record_capture_failure_for_selection(
                            &CaptureTransitionError::new(
                                *kind,
                                "Capture could not be reconciled during the Profile runtime switch",
                            ),
                            &final_capture.selection,
                        );
                    }
                    host.record_application_event(activation_failure_event(*error));
                    return ProfileActivationFinalization::CaptureFailure {
                        kind: *kind,
                        runtime: observed_runtime,
                    };
                }
                let completion = if *error == MihomoActivationError::Cancelled {
                    ProfileActivationCompletion::Cancelled(observed_runtime)
                } else {
                    ProfileActivationCompletion::Failed {
                        evidence: activation_failure_evidence(*error),
                        runtime: observed_runtime,
                    }
                };
                host.record_application_event(activation_failure_event(*error));
                if should_publish_activation_failure_notification(
                    *error,
                    resources.suppress_capture_failure_notification,
                ) {
                    publish_activation_failure_notification(host, &command.command_id, *error);
                }
                return ProfileActivationFinalization::Completed(completion);
            }
            let evidence = activation_failure_evidence(*error);
            report_profile_activation_recovery_required(
                host,
                command,
                &evidence,
                resources,
                Some(*error),
            );
            ProfileActivationFinalization::RecoveryRequired {
                evidence,
                runtime: observed_runtime,
            }
        }
        ProfileActivationTaskOutcome::Stop(Ok(())) => {
            let stopped = managed.is_safe_stopped()
                && active_runtime.is_none()
                && capture_contract_matches(
                    safe_runtime,
                    &ProfileActivationCaptureContract {
                        active: false,
                        adapter_kind: resources.previous_capture.adapter_kind,
                        pending_operation_id: resources
                            .previous_capture
                            .pending_operation_id
                            .clone(),
                        selection: resources.previous_capture.selection.clone(),
                    },
                )
                .await;
            if stopped {
                host.replace(safe_runtime.clone());
                manager.complete_runtime_handoff().await;
                ProfileActivationFinalization::Completed(ProfileActivationCompletion::Succeeded(
                    ProfileActivationRuntime::SafeStopped,
                ))
            } else {
                report_profile_activation_recovery_required(
                    host,
                    command,
                    &ProfileActivationFailureEvidence::StateCommit,
                    resources,
                    None,
                );
                ProfileActivationFinalization::RecoveryRequired {
                    evidence: ProfileActivationFailureEvidence::StateCommit,
                    runtime: observed_runtime,
                }
            }
        }
        ProfileActivationTaskOutcome::Stop(Err(error)) => {
            let restored = active_runtime.as_ref().is_some_and(|runtime| {
                runtime.is_same_instance(&resources.previous_host)
                    && managed_matches_runtime(&managed, &resources.previous_runtime)
            });
            if restored
                && capture_contract_matches(
                    active_runtime
                        .as_ref()
                        .expect("restored runtime was checked"),
                    &resources.previous_capture,
                )
                .await
            {
                host.replace(active_runtime.expect("restored runtime was checked"));
                ProfileActivationFinalization::Completed(ProfileActivationCompletion::Failed {
                    evidence: activation_failure_evidence(*error),
                    runtime: observed_runtime,
                })
            } else {
                let evidence = activation_failure_evidence(*error);
                report_profile_activation_recovery_required(
                    host,
                    command,
                    &evidence,
                    resources,
                    Some(*error),
                );
                ProfileActivationFinalization::RecoveryRequired {
                    evidence,
                    runtime: observed_runtime,
                }
            }
        }
        ProfileActivationTaskOutcome::Failed(_) => {
            if prior_runtime_and_capture_restored(
                &managed,
                active_runtime.as_ref(),
                safe_runtime,
                resources,
            )
            .await
            {
                host.replace(active_runtime.unwrap_or_else(|| safe_runtime.clone()));
                manager.complete_runtime_handoff().await;
                ProfileActivationFinalization::Completed(ProfileActivationCompletion::Failed {
                    evidence: ProfileActivationFailureEvidence::StateCommit,
                    runtime: observed_runtime,
                })
            } else {
                report_profile_activation_recovery_required(
                    host,
                    command,
                    &ProfileActivationFailureEvidence::StateCommit,
                    resources,
                    None,
                );
                ProfileActivationFinalization::RecoveryRequired {
                    evidence: ProfileActivationFailureEvidence::StateCommit,
                    runtime: observed_runtime,
                }
            }
        }
    }
}

pub struct ProfileActivationCoordinator {
    activation: RunnerHandle<ProfileActivationMachine>,
    availability: ProfileActivationAvailability,
    authority: StateMutationAuthority,
    host: DesktopRuntimeHost,
    manager: Arc<dyn ProfileActivationEffects>,
    policy_factory: Arc<PolicyFactory>,
    profiles: Arc<DesktopProfileService>,
    proxy_cancellation: Arc<std::sync::Mutex<Option<(Uuid, CancellationToken)>>>,
    proxy_operation: Arc<Mutex<()>>,
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
        manager: Arc<dyn ProfileActivationEffects>,
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
        let activation = spawn_runner(
            Arc::new(ProfileActivationMachine),
            ProfileActivationState::idle(),
            Arc::new(ProfileActivationMachineExecutor {
                host: host.clone(),
                manager: manager.clone(),
                operations: Arc::new(std::sync::Mutex::new(HashMap::new())),
                safe_runtime: safe_runtime.clone(),
            }),
            Arc::new(ProfileActivationProjectionObserver {
                availability,
                updates: updates.clone(),
            }),
            RunnerConfig::default(),
        );
        Self {
            activation,
            availability,
            authority: profiles.mutation_authority(),
            host,
            manager,
            policy_factory: Arc::new(policy_factory),
            profiles,
            proxy_cancellation: Arc::new(std::sync::Mutex::new(None)),
            proxy_operation: Arc::new(Mutex::new(())),
            directory_task: Mutex::new(None),
            scheduler_cancellation: CancellationToken::new(),
            scheduler_task: Mutex::new(None),
            shutting_down: AtomicBool::new(false),
            state: Mutex::new(CoordinatorState {
                busy_profiles: HashSet::new(),
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
        let snapshot = self.activation_snapshot().await;
        if snapshot.command_id.as_deref() == Some(command_id)
            || (snapshot.phase == ProfileActivationPhase::Pending
                && snapshot.target_profile_id.as_deref() == Some(profile_id))
        {
            return Ok(snapshot);
        }
        if snapshot.phase == ProfileActivationPhase::Pending {
            return Err(ProfileActivationCoordinatorError::Conflict);
        }
        let permit = self.acquire_mutation()?;
        self.authority
            .validate(&permit)
            .map_err(|_| ProfileActivationCoordinatorError::Busy)?;
        self.activate_inner(command_id, profile_id, Some(permit), None, false, None)
            .await
    }

    async fn activate_inner(
        self: &Arc<Self>,
        command_id: &str,
        profile_id: &str,
        permit: Option<StateMutationPermit>,
        admitted_tun_selection: Option<bool>,
        suppress_capture_failure_notification: bool,
        final_capture: Option<(CaptureRequest, StatusAdapterKind)>,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        validate_command_id(command_id)?;
        let availability = self.availability;
        if availability != ProfileActivationAvailability::Available {
            self.reject_unavailable_activation(command_id, profile_id, availability)
                .await;
            return Err(ProfileActivationCoordinatorError::Unavailable);
        }
        let snapshot = self.activation_snapshot().await;
        if snapshot.command_id.as_deref() == Some(command_id)
            || (snapshot.phase == ProfileActivationPhase::Pending
                && snapshot.target_profile_id.as_deref() == Some(profile_id))
        {
            return Ok(snapshot);
        }
        if snapshot.phase == ProfileActivationPhase::Pending {
            return Err(ProfileActivationCoordinatorError::Conflict);
        }
        let record = match self.profiles.activation_record(profile_id) {
            Ok(record) => record,
            Err(error) => {
                let evidence = ProfileActivationFailureEvidence::InvalidProfile;
                if self
                    .activation
                    .admit(ProfileActivationMachineInput::Reject {
                        attempted_at: now_unix_milliseconds(),
                        command_id: command_id.to_owned(),
                        evidence: evidence.clone(),
                        target_fingerprint: None,
                        target_profile_id: profile_id.to_owned(),
                        target_revision: None,
                    })
                    .await
                    .is_ok()
                {
                    self.record_rejected_activation(&snapshot, command_id, &evidence);
                }
                return Err(error.into());
            }
        };
        let policy = (self.policy_factory)().and_then(|policy| match admitted_tun_selection {
            Some(enabled) => policy.with_admitted_tun_selection(enabled),
            None => Ok(policy),
        });
        let policy = match policy {
            Ok(policy) => policy,
            Err(error) => {
                let evidence = match error {
                    crate::RuntimeConfigGenerationError::TunHelperUnavailable => {
                        ProfileActivationFailureEvidence::TunHelperUnavailable
                    }
                    _ => ProfileActivationFailureEvidence::StateCommit,
                };
                if self
                    .activation
                    .admit(ProfileActivationMachineInput::Reject {
                        attempted_at: now_unix_milliseconds(),
                        command_id: command_id.to_owned(),
                        evidence: evidence.clone(),
                        target_fingerprint: Some(
                            record.effective_fingerprint().as_str().to_owned(),
                        ),
                        target_profile_id: profile_id.to_owned(),
                        target_revision: Some(record.metadata.revision.id.as_str().to_owned()),
                    })
                    .await
                    .is_ok()
                {
                    self.record_rejected_activation(&snapshot, command_id, &evidence);
                }
                return Err(ProfileActivationCoordinatorError::PolicyUnavailable);
            }
        };
        let before = self
            .host
            .current()
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        let previous_host = self.host.current();
        let previous_runtime = self.activation.snapshot().runtime();
        let previous_capture = ProfileActivationCaptureContract {
            active: before.runtime.system_proxy_enabled || before.runtime.tun_enabled,
            adapter_kind: StatusAdapterKind::Rpc,
            pending_operation_id: (before.runtime.capture_operation.phase
                == CaptureOperationPhase::Pending)
                .then(|| before.runtime.capture_operation.operation_id.clone())
                .flatten(),
            selection: before.runtime.capture_selection,
        };
        let final_capture_contract = final_capture.as_ref().map(|(request, adapter_kind)| {
            ProfileActivationCaptureContract {
                active: request.active,
                adapter_kind: *adapter_kind,
                pending_operation_id: None,
                selection: request.selection.clone(),
            }
        });
        let previous_command_id = (snapshot.phase == ProfileActivationPhase::Failure)
            .then_some(snapshot.command_id)
            .flatten();
        let admission = self
            .activation
            .admit(ProfileActivationMachineInput::Begin {
                attempted_at: now_unix_milliseconds(),
                command_id: command_id.to_owned(),
                operation: ProfileActivationOperation::Activate,
                resources: Arc::new(ProfileActivationOperationResources {
                    _permit: permit,
                    final_capture: final_capture_contract,
                    owns_final_capture: final_capture.is_some(),
                    previous_capture,
                    previous_host,
                    previous_runtime,
                    suppress_capture_failure_notification,
                }),
                target_fingerprint: Some(record.effective_fingerprint().as_str().to_owned()),
                target_profile_id: profile_id.to_owned(),
                target_revision: Some(record.metadata.revision.id.as_str().to_owned()),
                work: ProfileActivationWork::Activate {
                    final_capture,
                    policy: Arc::new(policy),
                    record: Arc::new(record),
                },
            })
            .await
            .map_err(|error| match error {
                ProfileActivationMachineError::Conflict => {
                    ProfileActivationCoordinatorError::Conflict
                }
                ProfileActivationMachineError::Unavailable => {
                    ProfileActivationCoordinatorError::Unavailable
                }
            })?;
        if let Some(previous_command_id) = previous_command_id {
            self.host
                .resolve_notification(&format!("profile.activation-failure:{previous_command_id}"));
        }
        Ok(admission.state.to_snapshot(self.availability))
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
        let previous = self.activation_snapshot().await;
        if previous.phase == ProfileActivationPhase::Pending {
            return;
        }
        if self
            .activation
            .admit(ProfileActivationMachineInput::Reject {
                attempted_at: now_unix_milliseconds(),
                command_id: command_id.to_owned(),
                evidence,
                target_fingerprint: None,
                target_profile_id: profile_id.to_owned(),
                target_revision: None,
            })
            .await
            .is_err()
        {
            return;
        }
        if previous.phase == ProfileActivationPhase::Failure
            && let Some(previous_command_id) = previous.command_id
        {
            self.host
                .resolve_notification(&format!("profile.activation-failure:{previous_command_id}"));
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

    fn record_rejected_activation(
        &self,
        previous: &ProfileActivationSnapshot,
        command_id: &str,
        evidence: &ProfileActivationFailureEvidence,
    ) {
        if previous.phase == ProfileActivationPhase::Failure
            && let Some(previous_command_id) = previous.command_id.as_deref()
        {
            self.host
                .resolve_notification(&format!("profile.activation-failure:{previous_command_id}"));
        }
        resolve_geodata_notifications(&self.host, command_id, None);
        let failure = evidence.failure();
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

    pub async fn cancel(
        &self,
        command_id: &str,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        validate_command_id(command_id)?;
        let snapshot = self.activation_snapshot().await;
        if snapshot.phase != ProfileActivationPhase::Pending {
            return Ok(snapshot);
        }
        if snapshot.command_id.as_deref() != Some(command_id) {
            return Ok(snapshot);
        }
        let admission = self
            .activation
            .admit(ProfileActivationMachineInput::Cancel {
                command_id: command_id.to_owned(),
            })
            .await
            .map_err(|_| ProfileActivationCoordinatorError::Unavailable)?;
        Ok(admission.state.to_snapshot(self.availability))
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

    async fn reactivate_active_with_admitted_tun_selection(
        self: &Arc<Self>,
        admitted_tun_selection: bool,
        final_capture: Option<(CaptureRequest, StatusAdapterKind)>,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        let permit = self.acquire_mutation_queued().await?;
        self.authority
            .validate(&permit)
            .map_err(|_| ProfileActivationCoordinatorError::Busy)?;
        let profile_id = self
            .activation_snapshot()
            .await
            .active_profile_id
            .ok_or(ProfileActivationCoordinatorError::Unavailable)?;
        let command_id = Uuid::new_v4().to_string();
        let mut updates = self.subscribe();
        let pending = self
            .activate_inner(
                &command_id,
                &profile_id,
                Some(permit),
                Some(admitted_tun_selection),
                true,
                final_capture,
            )
            .await?;
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
        admitted_tun_selection: Option<bool>,
        final_capture: Option<(CaptureRequest, StatusAdapterKind)>,
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
        let pending = self
            .activate_inner(
                &command_id,
                &profile_id,
                None,
                admitted_tun_selection,
                true,
                final_capture,
            )
            .await?;
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
        let original_active = before.runtime.system_proxy.desired || before.runtime.tun.desired;
        let original_selection = before.runtime.capture_selection.clone();
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
        let request = CaptureRequest {
            active: true,
            selection,
        };
        let requires_tun_reactivation = self
            .manager
            .active_backend_matches(request.active && request.selection.tun)
            .await
            != Some(true);
        let profile_id = self
            .profiles
            .confirmed_selection_authorized(&permit)
            .ok()
            .and_then(|selected| selected.profile_id);
        let Some(profile_id) = profile_id else {
            let capture_operation = self
                .host
                .current()
                .publish_capture_pending(&request)
                .await?;
            let error = CaptureTransitionError::new(
                CaptureFailureKind::ConfigurationRequired,
                "A selected Profile configuration is required to launch Capture",
            );
            self.host
                .current()
                .reject_capture_operation(&capture_operation, &error)
                .await;
            self.record_launch_timing(
                launch_started,
                Duration::ZERO,
                Duration::ZERO,
                launch_started.elapsed(),
                Duration::ZERO,
                "configuration-required",
            );
            return Err(error);
        };
        let current = self.activation_snapshot().await;
        if requires_tun_reactivation
            && current.phase == ProfileActivationPhase::Success
            && current.active_profile_id.as_deref() == Some(profile_id.as_str())
        {
            let capture_started = Instant::now();
            let result = self
                .set_capture_inner(request, adapter_kind, Some(&permit))
                .await;
            let elapsed = capture_started.elapsed();
            self.record_launch_timing(
                launch_started,
                elapsed,
                Duration::ZERO,
                elapsed,
                elapsed,
                if result.is_ok() {
                    "success"
                } else {
                    "capture-failed"
                },
            );
            return result;
        }
        let capture_operation = self
            .host
            .current()
            .publish_capture_pending(&request)
            .await?;
        let preflight_request = request.clone();
        let preflight_started = Instant::now();
        let preflight_cancellation = preparation_cancellation.token.clone();
        let preflight_operation = self
            .host
            .preflight_capture_cancellable(&preflight_request, preflight_cancellation);
        tokio::pin!(preflight_operation);
        let mut preflight_result = None;
        // Poll the read-only preflight before admitting runtime replacement. This establishes
        // its snapshot barrier deterministically while still allowing the expensive Profile
        // preparation and Capture preflight to overlap.
        tokio::select! {
            biased;
            result = preflight_operation.as_mut() => {
                preflight_result = Some(result);
            }
            _ = tokio::task::yield_now() => {}
        }
        let activation_started = Instant::now();
        let mut activation_started_for_launch = false;
        let activation_command_before = current.command_id.clone();
        let activation = if current.phase == ProfileActivationPhase::Success
            && current.active_profile_id.as_deref() == Some(profile_id.as_str())
        {
            Ok(current)
        } else {
            let activation = self
                .activate_inner(
                    command_id,
                    &profile_id,
                    None,
                    Some(request.active && request.selection.tun),
                    true,
                    None,
                )
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
                preparation_cancellation.token.cancel();
                if preflight_result.is_none() {
                    let _ = preflight_operation.as_mut().await;
                }
                self.record_launch_timing(
                    launch_started,
                    activation_started.elapsed(),
                    preflight_started.elapsed(),
                    activation_started.elapsed(),
                    Duration::ZERO,
                    "profile-failed",
                );
                self.host
                    .current()
                    .finish_capture_operation_failure(&capture_operation, &error)
                    .await;
                if self
                    .aggregate_activation_capture_failed_since(activation_command_before.as_deref())
                    .await
                {
                    self.host.record_capture_failure(&error);
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
        let preflight = async {
            let result = match preflight_result {
                Some(result) => result,
                None => preflight_operation.as_mut().await,
            };
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
        let (
            mut result,
            activation_elapsed,
            preflight_elapsed,
            capture_elapsed,
            mut outcome,
            switched_tun_backend,
        ) = match prepared {
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
                    false,
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
                    false,
                )
            }
            Ok((preflight, activation_elapsed, preflight_elapsed)) => {
                let capture_started = Instant::now();
                let (result, switched_tun_backend) =
                    if requires_tun_reactivation && !activation_started_for_launch {
                        drop(preflight);
                        // A backend change is a Profile/Capture saga, not a Profile commit
                        // followed by a second Capture mutation. `set_capture_inner` admits the
                        // requested Capture contract into activation and performs compensation.
                        (
                            self.set_capture_inner(request.clone(), adapter_kind, Some(&permit))
                                .await,
                            false,
                        )
                    } else {
                        (
                            self.host
                                .set_capture_with_admitted_preflight(
                                    request.clone(),
                                    adapter_kind,
                                    preflight,
                                    &capture_operation,
                                )
                                .await,
                            false,
                        )
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
                    switched_tun_backend,
                )
            }
        };
        if switched_tun_backend && result.is_ok() {
            self.host.resolve_notification("capture.failure");
        }
        if switched_tun_backend && let Err(error) = &result {
            let original_error = error.clone();
            let final_error = self
                .rollback_failed_tun_backend_switch(
                    &request,
                    original_active,
                    &original_selection,
                    adapter_kind,
                    Some(&permit),
                    &original_error,
                )
                .await;
            if final_error.kind == CaptureFailureKind::RollbackFailed {
                outcome = "rollback-failed";
            }
            result = Err(final_error);
        }
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
            if self
                .aggregate_activation_capture_failed_since(activation_command_before.as_deref())
                .await
            {
                self.host.record_capture_failure(error);
            }
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

    async fn aggregate_activation_capture_failed_since(
        &self,
        previous_command_id: Option<&str>,
    ) -> bool {
        let activation = self.activation_snapshot().await;
        activation.phase == ProfileActivationPhase::Failure
            && activation.failure == Some(ProfileActivationFailure::Capture)
            && activation.command_id.as_deref() != previous_command_id
    }

    /// Confirms that the shared Capture projection, not only the platform effects, reached the
    /// requested terminal state.
    ///
    /// Maintenance recovery uses this after independently observing Helper-owned network state.
    /// A Helper/Core that is really active while the application projection says
    /// Recovery Required must remain recoverable evidence, never a completed replay.
    pub async fn capture_projection_matches(
        &self,
        active: bool,
        selection: &CaptureSelection,
        adapter_kind: StatusAdapterKind,
    ) -> bool {
        let snapshot = self
            .host
            .current()
            .status_snapshot_typed(adapter_kind)
            .await;
        let runtime = snapshot.runtime;
        runtime.capture_operation.phase == CaptureOperationPhase::Applied
            && runtime.capture_selection == *selection
            && runtime.system_proxy_enabled == (active && selection.system_proxy)
            && runtime.tun_enabled == (active && selection.tun)
            && runtime.system_proxy.phase
                == if active && selection.system_proxy {
                    SystemProxyPhase::Applied
                } else {
                    SystemProxyPhase::Off
                }
            && runtime.tun.phase
                == if active && selection.tun {
                    TunPhase::Applied
                } else {
                    TunPhase::Off
                }
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
        let previous_host = self.host.current();
        let before = previous_host
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        let previous_runtime = self.activation.snapshot().runtime();
        self.activation
            .admit(ProfileActivationMachineInput::Compensate {
                command_id: command_id.to_owned(),
                resources: Arc::new(ProfileActivationOperationResources {
                    _permit: None,
                    final_capture: None,
                    owns_final_capture: false,
                    previous_capture: ProfileActivationCaptureContract {
                        active: before.runtime.system_proxy_enabled || before.runtime.tun_enabled,
                        adapter_kind: StatusAdapterKind::Rpc,
                        pending_operation_id: (before.runtime.capture_operation.phase
                            == CaptureOperationPhase::Pending)
                            .then(|| before.runtime.capture_operation.operation_id.clone())
                            .flatten(),
                        selection: before.runtime.capture_selection,
                    },
                    previous_host,
                    previous_runtime,
                    suppress_capture_failure_notification: true,
                }),
            })
            .await
            .map_err(|_| {
                CaptureTransitionError::new(
                    CaptureFailureKind::RollbackFailed,
                    "Capture compensation could not be admitted",
                )
            })?;
        let terminal = self.wait_for_terminal_activation(command_id).await?;
        if terminal.safe_stopped && terminal.phase == ProfileActivationPhase::Failure {
            Ok(())
        } else {
            Err(CaptureTransitionError::new(
                CaptureFailureKind::RollbackFailed,
                "Capture failed and the newly started Mihomo runtime could not be restored safely",
            ))
        }
    }

    async fn wait_for_terminal_activation(
        &self,
        command_id: &str,
    ) -> Result<ProfileActivationSnapshot, CaptureTransitionError> {
        let mut updates = self.subscribe();
        let current = self.activation_snapshot().await;
        if current.command_id.as_deref() == Some(command_id)
            && current.phase != ProfileActivationPhase::Pending
        {
            return Ok(current);
        }
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
            let pending = self.activation_snapshot().await;
            let pending_command = (pending.phase == ProfileActivationPhase::Pending)
                .then_some(pending.command_id)
                .flatten();
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
        let active_backend_matches = self.manager.active_backend_matches(desired_tun).await;
        if active_backend_matches == Some(true)
            || (!request.active && active_backend_matches.is_none())
        {
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
        if self.shutting_down.load(Ordering::Acquire) {
            return Err(CaptureTransitionError::new(
                CaptureFailureKind::RuntimeTransition,
                "Mish is shutting down and cannot accept a new capture mutation",
            ));
        }
        let activation_result = match permit {
            Some(permit) => {
                self.reactivate_active_authorized(
                    permit,
                    Some(desired_tun),
                    Some((request.clone(), adapter_kind)),
                )
                .await
            }
            None => {
                self.reactivate_active_with_admitted_tun_selection(
                    desired_tun,
                    Some((request.clone(), adapter_kind)),
                )
                .await
            }
        };
        let activation_error = match &activation_result {
            Ok(snapshot) if snapshot.capture_failure_kind.is_some() => {
                Some(capture_error_from_activation_snapshot(snapshot))
            }
            Ok(snapshot) if snapshot.phase == ProfileActivationPhase::Success => None,
            Ok(snapshot) => Some(capture_error_from_activation_snapshot(snapshot)),
            Err(error) => Some(profile_launch_error_ref(error)),
        };
        if let Some(error) = activation_error {
            if self.shutting_down.load(Ordering::Acquire) {
                return Err(error);
            }
            if matches!(
                &activation_result,
                Ok(snapshot) if !snapshot.safe_stopped
            ) {
                if matches!(
                    &activation_result,
                    Ok(snapshot) if snapshot.capture_failure_kind.is_some()
                ) {
                    self.project_failed_capture_after_confirmed_saga_restore(
                        &request,
                        original_active,
                        &original_selection,
                        adapter_kind,
                        &error,
                    )
                    .await?;
                }
                return Err(error);
            }
            return Err(self
                .rollback_failed_tun_backend_switch(
                    &request,
                    original_active,
                    &original_selection,
                    adapter_kind,
                    permit,
                    &error,
                )
                .await);
        }
        self.host.resolve_notification("capture.failure");
        Ok(self.host.status_snapshot(adapter_kind).await)
    }

    async fn project_failed_capture_after_confirmed_saga_restore(
        &self,
        failed_request: &CaptureRequest,
        original_active: bool,
        original_selection: &CaptureSelection,
        adapter_kind: StatusAdapterKind,
        original_error: &CaptureTransitionError,
    ) -> Result<(), CaptureTransitionError> {
        let rollback_error = || {
            CaptureTransitionError::new(
                CaptureFailureKind::RollbackFailed,
                "The Profile saga restored a runtime whose Capture authority could not be confirmed",
            )
        };
        if self
            .manager
            .active_backend_matches(original_active && original_selection.tun)
            .await
            != Some(true)
        {
            return Err(rollback_error());
        }
        self.host
            .set_capture_deferred(
                CaptureRequest {
                    active: original_active,
                    selection: original_selection.clone(),
                },
                adapter_kind,
            )
            .await
            .map_err(|_| rollback_error())?;
        let runtime = self.host.current();
        let operation = runtime
            .publish_capture_pending(failed_request)
            .await
            .map_err(|_| rollback_error())?;
        runtime
            .finish_capture_operation_failure(&operation, original_error)
            .await;
        self.host
            .record_capture_failure_for_selection(original_error, &failed_request.selection);
        Ok(())
    }

    async fn rollback_failed_tun_backend_switch(
        self: &Arc<Self>,
        failed_request: &CaptureRequest,
        original_active: bool,
        original_selection: &CaptureSelection,
        adapter_kind: StatusAdapterKind,
        permit: Option<&StateMutationPermit>,
        original_error: &CaptureTransitionError,
    ) -> CaptureTransitionError {
        match self
            .restore_after_failed_tun_backend_switch(
                failed_request,
                original_active,
                original_selection,
                adapter_kind,
                permit,
                original_error,
            )
            .await
        {
            Ok(()) => original_error.clone(),
            Err(rollback_error) => {
                self.host.record_capture_failure_for_selection(
                    &rollback_error,
                    &failed_request.selection,
                );
                rollback_error
            }
        }
    }

    async fn restore_after_failed_tun_backend_switch(
        self: &Arc<Self>,
        failed_request: &CaptureRequest,
        original_active: bool,
        original_selection: &CaptureSelection,
        adapter_kind: StatusAdapterKind,
        permit: Option<&StateMutationPermit>,
        original_error: &CaptureTransitionError,
    ) -> Result<(), CaptureTransitionError> {
        let rollback_error =
            |message| CaptureTransitionError::new(CaptureFailureKind::RollbackFailed, message);
        self.host
            .set_capture_deferred(
                CaptureRequest {
                    active: false,
                    selection: original_selection.clone(),
                },
                adapter_kind,
            )
            .await
            .map_err(|_| rollback_error("The failed TUN transition could not be disabled"))?;
        let reactivation = match permit {
            Some(permit) => {
                self.reactivate_active_authorized(permit, Some(original_selection.tun), None)
                    .await
            }
            None => {
                self.reactivate_active_with_admitted_tun_selection(original_selection.tun, None)
                    .await
            }
        };
        if !matches!(
            reactivation,
            Ok(ref snapshot) if snapshot.phase == ProfileActivationPhase::Success
        ) {
            return Err(rollback_error(
                "The prior Core backend could not be restored after a TUN transition",
            ));
        }
        self.host
            .set_capture_deferred(
                CaptureRequest {
                    active: original_active,
                    selection: original_selection.clone(),
                },
                adapter_kind,
            )
            .await
            .map_err(|_| {
                rollback_error(
                    "The prior Capture state could not be restored after a TUN transition",
                )
            })?;

        // Rollback uses ordinary Capture operations to restore the confirmed platform state.
        // Re-project the user's failed request only after that state is stable, so clients see
        // one terminal failure without mistaking the compensating operation for success.
        let runtime = self.host.current();
        let operation = runtime
            .publish_capture_pending(failed_request)
            .await
            .map_err(|_| {
                rollback_error("The failed TUN transition could not be projected after rollback")
            })?;
        runtime
            .finish_capture_operation_failure(&operation, original_error)
            .await;
        self.host
            .record_capture_failure_for_selection(original_error, &failed_request.selection);
        Ok(())
    }

    pub async fn stop(
        self: &Arc<Self>,
        command_id: &str,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        validate_command_id(command_id)?;
        let snapshot = self.activation_snapshot().await;
        if snapshot.command_id.as_deref() == Some(command_id) {
            return Ok(snapshot);
        }
        if snapshot.phase == ProfileActivationPhase::Pending {
            return Err(ProfileActivationCoordinatorError::Conflict);
        }
        let permit = self.acquire_mutation()?;
        self.stop_with_permit(command_id, permit).await
    }

    async fn stop_with_permit(
        &self,
        command_id: &str,
        permit: StateMutationPermit,
    ) -> Result<ProfileActivationSnapshot, ProfileActivationCoordinatorError> {
        let snapshot = self.activation_snapshot().await;
        let previous_runtime = self.activation.snapshot().runtime();
        let Some(active_profile_id) = previous_runtime.active_profile_id().map(str::to_owned)
        else {
            return Ok(snapshot);
        };
        let previous_host = self.host.current();
        let before = previous_host
            .status_snapshot_typed(StatusAdapterKind::Rpc)
            .await;
        let (target_fingerprint, target_revision) = match &previous_runtime {
            ProfileActivationRuntime::Active {
                fingerprint,
                revision,
                ..
            } => (Some(fingerprint.clone()), revision.clone()),
            ProfileActivationRuntime::SafeStopped => (None, None),
        };
        let admission = self
            .activation
            .admit(ProfileActivationMachineInput::Begin {
                attempted_at: now_unix_milliseconds(),
                command_id: command_id.to_owned(),
                operation: ProfileActivationOperation::Stop,
                resources: Arc::new(ProfileActivationOperationResources {
                    _permit: Some(permit),
                    final_capture: None,
                    owns_final_capture: false,
                    previous_capture: ProfileActivationCaptureContract {
                        active: before.runtime.system_proxy_enabled || before.runtime.tun_enabled,
                        adapter_kind: StatusAdapterKind::Rpc,
                        pending_operation_id: (before.runtime.capture_operation.phase
                            == CaptureOperationPhase::Pending)
                            .then(|| before.runtime.capture_operation.operation_id.clone())
                            .flatten(),
                        selection: before.runtime.capture_selection,
                    },
                    previous_host,
                    previous_runtime,
                    suppress_capture_failure_notification: false,
                }),
                target_fingerprint,
                target_profile_id: active_profile_id,
                target_revision,
                work: ProfileActivationWork::Stop,
            })
            .await
            .map_err(|error| match error {
                ProfileActivationMachineError::Conflict => {
                    ProfileActivationCoordinatorError::Conflict
                }
                ProfileActivationMachineError::Unavailable => {
                    ProfileActivationCoordinatorError::Unavailable
                }
            })?;
        Ok(admission.state.to_snapshot(self.availability))
    }

    pub async fn delete_profile(
        &self,
        profile_id: &str,
    ) -> Result<ProfileSnapshot, ProfileActivationCoordinatorError> {
        let permit = self.acquire_mutation()?;
        let snapshot = self.activation_snapshot().await;
        if snapshot.phase == ProfileActivationPhase::Pending
            || snapshot.active_profile_id.as_deref() == Some(profile_id)
        {
            return Err(ProfileActivationCoordinatorError::Conflict);
        }
        let active_profile_id = snapshot.active_profile_id;
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
        self.activation.snapshot().to_snapshot(self.availability)
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
            .activation
            .snapshot()
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
        let pending = self.activation_snapshot().await;
        if pending.phase == ProfileActivationPhase::Pending
            && let Some(command_id) = pending.command_id.as_deref()
        {
            let _ = self.cancel(command_id).await;
            if self.wait_for_terminal_activation(command_id).await.is_err() {
                self.shutting_down.store(false, Ordering::Release);
                return Err(ProfileActivationShutdownFailure::StateCommit);
            }
        }
        let _proxy_operation = self.proxy_operation.lock().await;
        let permit = match self.authority.acquire().await {
            Ok(permit) => permit,
            Err(_) => {
                self.shutting_down.store(false, Ordering::Release);
                return Err(ProfileActivationShutdownFailure::MutationBusy);
            }
        };
        let command_id = Uuid::new_v4().to_string();
        let stopped = match self.stop_with_permit(&command_id, permit).await {
            Ok(snapshot) if snapshot.phase == ProfileActivationPhase::Pending => {
                self.wait_for_terminal_activation(&command_id).await.ok()
            }
            Ok(snapshot) => Some(snapshot),
            Err(_) => None,
        };
        let state = self.activation.snapshot();
        if stopped
            .as_ref()
            .is_none_or(|snapshot| !snapshot.safe_stopped)
            || matches!(state, ProfileActivationState::RecoveryRequired { .. })
        {
            self.shutting_down.store(false, Ordering::Release);
            return Err(ProfileActivationShutdownFailure::StateCommit);
        }
        self.state.lock().await.busy_profiles.clear();
        self.activation
            .admit(ProfileActivationMachineInput::Retire {
                attempted_at: now_unix_milliseconds(),
                terminal,
            })
            .await
            .map_err(|_| ProfileActivationShutdownFailure::StateCommit)?;
        if terminal {
            self.authority.make_unavailable_until_restart();
            self.activation.shutdown().await;
        } else {
            self.shutting_down.store(false, Ordering::Release);
        }
        Ok(())
    }

    async fn release_profile(&self, profile_id: &str) {
        self.state.lock().await.busy_profiles.remove(profile_id);
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
    profile_launch_error_ref(&error)
}

fn profile_launch_error_ref(error: &ProfileActivationCoordinatorError) -> CaptureTransitionError {
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

fn capture_error_from_activation(
    failure: Option<ProfileActivationFailure>,
) -> CaptureTransitionError {
    let (kind, message) = match failure {
        Some(ProfileActivationFailure::TunHelperUnavailable) => (
            CaptureFailureKind::CapabilityUnavailable,
            "The system component required for Virtual Interface is unavailable",
        ),
        Some(ProfileActivationFailure::TunNetworkOwnershipConflict) => (
            CaptureFailureKind::ObservationFailed,
            "Virtual Interface network ownership could not be confirmed",
        ),
        Some(ProfileActivationFailure::ManagedListenerConflict) => (
            CaptureFailureKind::ListenerUnavailable,
            "Mihomo could not claim its configured local Controller endpoint",
        ),
        Some(ProfileActivationFailure::InvalidProfile)
        | Some(ProfileActivationFailure::MissingBinary)
        | Some(ProfileActivationFailure::UnsafeRuntime)
        | Some(ProfileActivationFailure::Staging)
        | Some(ProfileActivationFailure::Validation)
        | Some(ProfileActivationFailure::GeodataFailed)
        | Some(ProfileActivationFailure::GeodataTimeout) => (
            CaptureFailureKind::ConfigurationRequired,
            "The selected Profile could not prepare a safe Mihomo runtime",
        ),
        Some(ProfileActivationFailure::StateCommit) => (
            CaptureFailureKind::PersistenceFailed,
            "The Mihomo runtime switch could not be committed safely",
        ),
        Some(ProfileActivationFailure::Start)
        | Some(ProfileActivationFailure::EarlyExit)
        | Some(ProfileActivationFailure::VersionMismatch)
        | Some(ProfileActivationFailure::Controller)
        | Some(ProfileActivationFailure::Timeout)
        | Some(ProfileActivationFailure::PriorStop) => (
            CaptureFailureKind::CoreUnhealthy,
            "Mihomo did not become healthy during the runtime switch",
        ),
        Some(ProfileActivationFailure::Cancelled)
        | Some(ProfileActivationFailure::Capture)
        | None => (
            CaptureFailureKind::RuntimeTransition,
            "The Mihomo runtime switch did not complete",
        ),
    };
    CaptureTransitionError::new(kind, message)
}

fn capture_error_from_activation_snapshot(
    snapshot: &ProfileActivationSnapshot,
) -> CaptureTransitionError {
    match snapshot.capture_failure_kind {
        Some(kind) => CaptureTransitionError::new(
            kind,
            "Capture could not be reconciled during the Mihomo runtime switch",
        ),
        None => capture_error_from_activation(snapshot.failure),
    }
}

fn usable_capture_selection(
    adapter_kind: StatusAdapterKind,
    capabilities: &mish_runtime::PlatformCapabilities,
    mut selection: CaptureSelection,
) -> Result<CaptureSelection, CaptureTransitionError> {
    let explicit_selection = selection.system_proxy || selection.tun;
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
    if !explicit_selection && !selection.system_proxy && !selection.tun {
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
mod activation_machine_tests {
    use std::sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    };

    use mish_runtime::{CaptureSelection, MishRuntime, StatusAdapterKind};
    use mish_state_machine::{Machine, TaskFailure, Transition};

    use super::*;
    use crate::{DesktopMihomoProcess, DesktopMihomoProcessConfig};

    const COMMAND_ID: &str = "11111111-1111-4111-8111-111111111111";
    const NEXT_COMMAND_ID: &str = "22222222-2222-4222-8222-222222222222";
    const PROFILE_ID: &str = "33333333-3333-4333-8333-333333333333";
    const FINGERPRINT: &str = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const REVISION: &str = "44444444-4444-4444-8444-444444444444";

    fn pending_activation() -> (ProfileActivationState, ProfileActivationCommand) {
        let mut state = ProfileActivationState::idle();
        let command = state
            .begin(
                COMMAND_ID,
                ProfileActivationOperation::Activate,
                PROFILE_ID,
                Some(REVISION.into()),
                Some(FINGERPRINT.into()),
                1,
            )
            .unwrap();
        (state, command)
    }

    fn active_runtime(runtime_id: &str) -> ProfileActivationRuntime {
        ProfileActivationRuntime::Active {
            fingerprint: FINGERPRINT.into(),
            profile_id: PROFILE_ID.into(),
            revision: Some(REVISION.into()),
            runtime_id: Some(runtime_id.into()),
        }
    }

    fn safe_runtime() -> MishRuntime {
        MishRuntime::new(Arc::new(DesktopMihomoProcess::new(
            DesktopMihomoProcessConfig {
                binary: None,
                config_directory: None,
                config_file: None,
            },
        )))
    }

    #[derive(Default)]
    struct RecoveryBoundaryEffects {
        active_runtime: std::sync::Mutex<Option<MishRuntime>>,
        handoff_releases: AtomicUsize,
        managed_state: std::sync::Mutex<crate::ManagedActivationState>,
        panic_on_observation: AtomicBool,
    }

    impl ProfileActivationEffects for RecoveryBoundaryEffects {
        fn availability(&self) -> Result<(), MihomoResolveError> {
            Ok(())
        }

        fn activate_cancellable<'a>(
            &'a self,
            _operation_id: &'a str,
            _record: &'a ProfileRecord,
            _policy: &'a ManagedRuntimePolicy,
            _cancellation: CancellationToken,
            _progress: ProfileActivationProgressObserver,
            _final_capture: Option<(CaptureRequest, StatusAdapterKind)>,
        ) -> BoxFuture<'a, Result<crate::ActivationCommit, MihomoActivationError>> {
            Box::pin(async { unreachable!("recovery-boundary tests execute only finalizers") })
        }

        fn active_runtime(&self) -> BoxFuture<'_, Option<MishRuntime>> {
            Box::pin(async move {
                self.active_runtime
                    .lock()
                    .expect("recovery-boundary active runtime lock poisoned")
                    .clone()
            })
        }

        fn active_backend_matches(&self, _tun_enabled: bool) -> BoxFuture<'_, Option<bool>> {
            Box::pin(async { None })
        }

        fn managed_state(&self) -> BoxFuture<'_, crate::ManagedActivationState> {
            Box::pin(async move {
                assert!(
                    !self.panic_on_observation.load(Ordering::SeqCst),
                    "synthetic recovery observation panic"
                );
                self.managed_state
                    .lock()
                    .expect("recovery-boundary managed state lock poisoned")
                    .clone()
            })
        }

        fn complete_runtime_handoff(&self) -> BoxFuture<'_, ()> {
            Box::pin(async move {
                self.handoff_releases.fetch_add(1, Ordering::SeqCst);
            })
        }

        fn shutdown(&self) -> BoxFuture<'_, Result<(), MihomoActivationError>> {
            Box::pin(async { Ok(()) })
        }

        fn route_selections(&self, _record: &ProfileRecord) -> HashMap<String, String> {
            HashMap::new()
        }

        fn delete_route_selections(&self, _profile_id: &str) {}
    }

    fn recovery_boundary_executor(
        manager: Arc<RecoveryBoundaryEffects>,
        runtime: &MishRuntime,
        command: &ProfileActivationCommand,
    ) -> ProfileActivationMachineExecutor {
        let resources = fallback_operation_resources(runtime);
        let operations = Arc::new(std::sync::Mutex::new(HashMap::from([(
            command.command_id.clone(),
            resources,
        )])));
        ProfileActivationMachineExecutor {
            host: DesktopRuntimeHost::new(runtime.clone()),
            manager,
            operations,
            safe_runtime: runtime.clone(),
        }
    }

    #[test]
    fn effect_and_finalizer_commit_only_the_exact_profile_scope_and_runtime_authority() {
        let machine = ProfileActivationMachine;
        let (state, command) = pending_activation();
        let transition =
            machine.reduce(
                &state,
                &ProfileActivationMachineInput::TaskFinished {
                    correlation: command.correlation(PROFILE_ACTIVATION_EFFECT_ID),
                    outcome: ProfileActivationTaskOutcome::Activate(Ok(
                        crate::ActivationCommit::new(PROFILE_ID, REVISION, FINGERPRINT),
                    )),
                },
            );
        let finalizing = match transition {
            Transition::EffectEmitting { state, .. } => state,
            _ => panic!("activation completion must enter finalization"),
        };
        assert!(matches!(
            finalizing.pending(),
            Some(ProfileActivationPending {
                stage: ProfileActivationStage::Finalizing,
                ..
            })
        ));
        let finalizer_correlation = command.correlation(PROFILE_ACTIVATION_FINALIZER_EFFECT_ID);
        assert_eq!(
            finalizer_correlation,
            command.correlation(PROFILE_ACTIVATION_FINALIZER_EFFECT_ID)
        );

        let committed = machine.reduce(
            &finalizing,
            &ProfileActivationMachineInput::Finalized {
                correlation: finalizer_correlation.clone(),
                finalization: ProfileActivationFinalization::Completed(
                    ProfileActivationCompletion::Succeeded(active_runtime("runtime-authority")),
                ),
                _resources: fallback_operation_resources(&safe_runtime()),
            },
        );
        let committed = match committed {
            Transition::Committed(state) => state,
            _ => panic!("authoritative finalization must be the only commit boundary"),
        };
        assert!(matches!(
            committed,
            ProfileActivationState::Succeeded {
                runtime: ProfileActivationRuntime::Active {
                    runtime_id: Some(ref runtime_id),
                    ..
                },
                ..
            } if runtime_id == "runtime-authority"
        ));
        assert!(matches!(
            machine.reduce(
                &committed,
                &ProfileActivationMachineInput::Finalized {
                    correlation: finalizer_correlation,
                    finalization: ProfileActivationFinalization::Completed(
                        ProfileActivationCompletion::Succeeded(active_runtime("stale")),
                    ),
                    _resources: fallback_operation_resources(&safe_runtime()),
                },
            ),
            Transition::Retired
        ));
    }

    #[test]
    fn every_owned_task_failure_reobserves_once_then_requires_recovery() {
        for failure in [
            TaskFailure::Aborted,
            TaskFailure::CompletionConflict,
            TaskFailure::Panicked,
        ] {
            let machine = ProfileActivationMachine;
            let (state, command) = pending_activation();
            let finalizing = match machine.reduce(
                &state,
                &ProfileActivationMachineInput::TaskFailed {
                    correlation: command.correlation(PROFILE_ACTIVATION_EFFECT_ID),
                    failure,
                },
            ) {
                Transition::EffectEmitting { state, .. } => state,
                _ => panic!("failed activation task must be finalized"),
            };
            let recovering = match machine.reduce(
                &finalizing,
                &ProfileActivationMachineInput::TaskFailed {
                    correlation: command.correlation(PROFILE_ACTIVATION_FINALIZER_EFFECT_ID),
                    failure,
                },
            ) {
                Transition::EffectEmitting { state, .. } => state,
                _ => panic!("a failed finalizer must get one recovery observation"),
            };
            assert!(matches!(
                machine.reduce(
                    &recovering,
                    &ProfileActivationMachineInput::TaskFailed {
                        correlation: command.correlation(PROFILE_ACTIVATION_RECOVERY_EFFECT_ID),
                        failure,
                    },
                ),
                Transition::RecoveryRequired(ProfileActivationState::RecoveryRequired { .. })
            ));
        }
    }

    #[tokio::test]
    async fn cold_task_failure_accepts_only_the_confirmed_safe_stopped_baseline() {
        let runtime = safe_runtime();
        let resources = fallback_operation_resources(&runtime);
        let managed = crate::ManagedActivationState::default();

        assert!(
            prior_runtime_and_capture_restored(&managed, None, &runtime, &resources).await,
            "an observed unchanged cold baseline is a confirmed compensation"
        );
        assert!(
            !prior_runtime_and_capture_restored(&managed, Some(&runtime), &runtime, &resources,)
                .await,
            "a live runtime cannot satisfy a safe-stopped compensation contract"
        );
    }

    #[tokio::test]
    async fn recovery_required_releases_the_completed_capture_reservation() {
        let runtime = safe_runtime();
        let manager = Arc::new(RecoveryBoundaryEffects::default());
        let (_, command) = pending_activation();
        let executor = recovery_boundary_executor(manager.clone(), &runtime, &command);

        let result = executor
            .execute(
                ProfileActivationMachineEffect::Finalize {
                    correlation: command.correlation(PROFILE_ACTIVATION_FINALIZER_EFFECT_ID),
                    command,
                    outcome: ProfileActivationTaskOutcome::Activate(Ok(
                        crate::ActivationCommit::new(FINGERPRINT, PROFILE_ID, REVISION),
                    )),
                },
                CancellationToken::new(),
            )
            .await;

        assert!(matches!(
            result,
            ProfileActivationMachineInput::Finalized {
                finalization: ProfileActivationFinalization::RecoveryRequired { .. },
                ..
            }
        ));
        assert_eq!(manager.handoff_releases.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn committed_runtime_is_installed_before_capture_recovery_is_published() {
        let previous = safe_runtime();
        let candidate = safe_runtime();
        let host = DesktopRuntimeHost::new(previous.clone());
        let commit = crate::ActivationCommit::new(FINGERPRINT, "local", REVISION);
        let managed_state = serde_json::from_value(serde_json::json!({
            "activeFingerprint": FINGERPRINT,
            "activeProfileId": "local",
            "activeRevision": REVISION,
            "activeRuntimeId": commit.runtime_id(),
            "lastSuccessfulProfileId": "local",
            "lastAttempt": null,
            "schemaVersion": 2
        }))
        .expect("managed recovery fixture must deserialize");
        let manager = RecoveryBoundaryEffects {
            active_runtime: std::sync::Mutex::new(Some(candidate.clone())),
            managed_state: std::sync::Mutex::new(managed_state),
            ..RecoveryBoundaryEffects::default()
        };
        let mut state = ProfileActivationState::idle();
        let command = state
            .begin(
                COMMAND_ID,
                ProfileActivationOperation::Activate,
                "local",
                Some(REVISION.into()),
                Some(FINGERPRINT.into()),
                1,
            )
            .expect("activation command must be admitted");
        let resources = ProfileActivationOperationResources {
            _permit: None,
            final_capture: Some(ProfileActivationCaptureContract {
                active: true,
                adapter_kind: StatusAdapterKind::Rpc,
                pending_operation_id: None,
                selection: CaptureSelection {
                    system_proxy: true,
                    tun: false,
                },
            }),
            owns_final_capture: true,
            previous_capture: ProfileActivationCaptureContract {
                active: false,
                adapter_kind: StatusAdapterKind::Rpc,
                pending_operation_id: None,
                selection: CaptureSelection {
                    system_proxy: false,
                    tun: false,
                },
            },
            previous_host: previous,
            previous_runtime: ProfileActivationRuntime::SafeStopped,
            suppress_capture_failure_notification: false,
        };

        let finalization = finalize_profile_activation(
            &manager,
            &host,
            &candidate,
            &command,
            &ProfileActivationTaskOutcome::Activate(Ok(commit)),
            &resources,
        )
        .await;

        assert!(matches!(
            finalization,
            ProfileActivationFinalization::RecoveryRequired {
                evidence: ProfileActivationFailureEvidence::Capture(
                    CaptureFailureKind::ObservationFailed
                ),
                runtime: ProfileActivationRuntime::Active { ref profile_id, .. },
            } if profile_id == "local"
        ));
        assert!(
            host.current().is_same_instance(&candidate),
            "the host must follow the committed runtime before RecoveryRequired is visible"
        );
    }

    #[tokio::test]
    async fn recovery_finalizer_releases_capture_before_a_second_observation_panic() {
        let runtime = safe_runtime();
        let manager = Arc::new(RecoveryBoundaryEffects::default());
        manager.panic_on_observation.store(true, Ordering::SeqCst);
        let (_, command) = pending_activation();
        let executor = recovery_boundary_executor(manager.clone(), &runtime, &command);

        let result = tokio::spawn(executor.execute(
            ProfileActivationMachineEffect::Finalize {
                correlation: command.correlation(PROFILE_ACTIVATION_RECOVERY_EFFECT_ID),
                command,
                outcome: ProfileActivationTaskOutcome::Failed(TaskFailure::Panicked),
            },
            CancellationToken::new(),
        ))
        .await;

        let error = match result {
            Err(error) => error,
            Ok(_) => panic!("the synthetic recovery observation must panic"),
        };
        assert!(error.is_panic());
        assert_eq!(manager.handoff_releases.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn replacement_retires_stale_completion_and_cancellation_targets_only_owned_effect() {
        let machine = ProfileActivationMachine;
        let (mut state, first) = pending_activation();
        assert!(state.complete(
            &first,
            ProfileActivationCompletion::Failed {
                evidence: ProfileActivationFailureEvidence::Validation,
                runtime: ProfileActivationRuntime::SafeStopped,
            },
        ));
        let replacement = state
            .begin(
                NEXT_COMMAND_ID,
                ProfileActivationOperation::Activate,
                PROFILE_ID,
                Some(REVISION.into()),
                Some(FINGERPRINT.into()),
                2,
            )
            .unwrap();
        assert!(matches!(
            machine.reduce(
                &state,
                &ProfileActivationMachineInput::TaskFinished {
                    correlation: first.correlation(PROFILE_ACTIVATION_EFFECT_ID),
                    outcome: ProfileActivationTaskOutcome::Stop(Ok(())),
                },
            ),
            Transition::Retired
        ));
        match machine.reduce(
            &state,
            &ProfileActivationMachineInput::Cancel {
                command_id: NEXT_COMMAND_ID.into(),
            },
        ) {
            Transition::EffectEmitting { state, .. } => assert!(matches!(
                state.pending(),
                Some(ProfileActivationPending { command, .. })
                    if command == &replacement
            )),
            _ => panic!("cancellation must target the replacement effect"),
        }
    }

    #[test]
    fn compensation_has_an_explicit_terminal_boundary() {
        let machine = ProfileActivationMachine;
        let (mut state, command) = pending_activation();
        assert!(state.complete(
            &command,
            ProfileActivationCompletion::Succeeded(active_runtime("runtime-authority")),
        ));
        let runtime = safe_runtime();
        let resources = Arc::new(ProfileActivationOperationResources {
            _permit: None,
            final_capture: None,
            owns_final_capture: false,
            previous_capture: ProfileActivationCaptureContract {
                active: false,
                adapter_kind: StatusAdapterKind::Rpc,
                pending_operation_id: None,
                selection: CaptureSelection {
                    system_proxy: false,
                    tun: false,
                },
            },
            previous_host: runtime,
            previous_runtime: active_runtime("runtime-authority"),
            suppress_capture_failure_notification: true,
        });
        let compensating = match machine.reduce(
            &state,
            &ProfileActivationMachineInput::Compensate {
                command_id: COMMAND_ID.into(),
                resources: resources.clone(),
            },
        ) {
            Transition::EffectEmitting { state, .. } => state,
            _ => panic!("compensation must own an effect"),
        };
        assert!(matches!(
            machine.reduce(
                &compensating,
                &ProfileActivationMachineInput::CompensationFinished {
                    correlation: command.correlation(PROFILE_ACTIVATION_COMPENSATION_EFFECT_ID),
                    finalization: ProfileActivationCompensation::RestoredSafe,
                    _resources: resources,
                },
            ),
            Transition::Failed(ProfileActivationState::RollbackSucceeded { .. })
        ));
    }
}

#[cfg(test)]
mod capture_selection_tests {
    use std::time::Duration;

    use super::{
        ProfileActivationFailure, activation_failure_evidence, capture_error_from_activation,
        launch_duration_milliseconds, map_failure, profile_activation_failure_notification,
        should_publish_activation_failure_notification, usable_capture_selection,
    };
    use crate::MihomoActivationError;
    use mish_runtime::{
        ApplicationActionId, CapabilityAvailability, CaptureFailureKind, CaptureSelection,
        PlatformCapabilities, StatusAdapterKind,
    };

    fn capabilities(
        system_proxy: CapabilityAvailability,
        tun: CapabilityAvailability,
    ) -> PlatformCapabilities {
        PlatformCapabilities { system_proxy, tun }
    }

    #[test]
    fn backend_switch_preserves_actionable_activation_failure_kinds() {
        assert_eq!(
            capture_error_from_activation(Some(ProfileActivationFailure::ManagedListenerConflict,))
                .kind,
            CaptureFailureKind::ListenerUnavailable
        );
        assert_eq!(
            capture_error_from_activation(Some(ProfileActivationFailure::TunHelperUnavailable))
                .kind,
            CaptureFailureKind::CapabilityUnavailable
        );
        assert_eq!(
            capture_error_from_activation(Some(ProfileActivationFailure::StateCommit)).kind,
            CaptureFailureKind::PersistenceFailed
        );
    }

    #[test]
    fn native_launch_selection_preserves_explicit_modes_and_defaults_only_empty_selection() {
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
        assert!(
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
            .is_err()
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
            ProfileActivationFailure::TunNetworkOwnershipConflict,
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
            ProfileActivationFailure::TunHelperUnavailable,
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

    #[test]
    fn unavailable_privileged_service_produces_tun_setup_notification_evidence() {
        let error = MihomoActivationError::TunHelperUnavailable;
        assert_eq!(
            activation_failure_evidence(error).failure(),
            ProfileActivationFailure::TunHelperUnavailable
        );
        assert_eq!(
            map_failure(error),
            ProfileActivationFailure::TunHelperUnavailable
        );

        let notification =
            profile_activation_failure_notification(ProfileActivationFailure::TunHelperUnavailable);
        assert!(notification.action_ids.is_empty());
        assert_eq!(
            serde_json::to_value(notification.content).unwrap()["data"]["failure"],
            "tun-helper-unavailable"
        );
    }

    #[test]
    fn foreign_tun_network_state_produces_retryable_ownership_notification_evidence() {
        let error = MihomoActivationError::TunNetworkOwnershipConflict;
        assert_eq!(
            activation_failure_evidence(error).failure(),
            ProfileActivationFailure::TunNetworkOwnershipConflict
        );
        assert_eq!(
            map_failure(error),
            ProfileActivationFailure::TunNetworkOwnershipConflict
        );

        let notification = profile_activation_failure_notification(
            ProfileActivationFailure::TunNetworkOwnershipConflict,
        );
        assert_eq!(
            notification.action_ids,
            vec![ApplicationActionId::RetryProfileActivation]
        );
        assert_eq!(
            serde_json::to_value(notification.content).unwrap()["data"]["failure"],
            "tun-network-ownership-conflict"
        );
    }

    #[test]
    fn aggregate_capture_failure_uses_the_canonical_capture_notification_only() {
        assert!(!should_publish_activation_failure_notification(
            MihomoActivationError::CaptureFailed(CaptureFailureKind::RuntimeTransition),
            true,
        ));
        assert!(should_publish_activation_failure_notification(
            MihomoActivationError::CaptureFailed(CaptureFailureKind::RuntimeTransition),
            false,
        ));
        assert!(should_publish_activation_failure_notification(
            MihomoActivationError::StartFailed,
            true,
        ));
    }
}

#[cfg(test)]
mod activation_snapshot_golden_tests {
    use super::{
        ProfileActivationAvailability, ProfileActivationCompletion, ProfileActivationEvidence,
        ProfileActivationEvidenceKind, ProfileActivationFailureEvidence,
        ProfileActivationOperation, ProfileActivationRuntime, ProfileActivationScope,
        ProfileActivationState, ProfileActivationStateKind, ProfileActivationTransition,
    };
    use serde_json::{Value, json};

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
                None,
                None,
                1_721_296_000_000,
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
            revision: None,
            runtime_id: None,
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
                None,
                None,
                1_721_296_001_000,
            )
            .unwrap();

        let mut stop_pending = succeeded.clone();
        let stop_command = stop_pending
            .begin(
                COMMAND_ID,
                ProfileActivationOperation::Stop,
                PROFILE_ID,
                None,
                None,
                1_721_296_000_000,
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
            State::RecoveryRequired,
            State::Compensating,
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
            Transition::RecoveryRequire,
            Transition::Compensate,
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
                            | State::RollbackFailed
                            | State::RecoveryRequired,
                        Transition::Begin | Transition::Retry | Transition::Shutdown
                    ) | (
                        State::Pending | State::Retrying,
                        Transition::Succeed
                            | Transition::Fail
                            | Transition::Cancel
                            | Transition::RecoveryRequire
                    ) | (
                        State::Succeeded,
                        Transition::RollbackSucceed
                            | Transition::RollbackFail
                            | Transition::Compensate
                    ) | (
                        State::Compensating,
                        Transition::RollbackSucceed | Transition::RollbackFail
                    ) | (State::ShuttingDown, Transition::ShutdownComplete)
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
                None,
                None,
                1,
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
                None,
                None,
                2,
            )
            .unwrap();
        assert!(retry.scope.revision > first.scope.revision);

        assert!(!state.complete(
            &first,
            ProfileActivationCompletion::Succeeded(ProfileActivationRuntime::Active {
                fingerprint: ACTIVE_FINGERPRINT.into(),
                profile_id: PROFILE_ID.into(),
                revision: None,
                runtime_id: None,
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
                revision: None,
                runtime_id: None,
            }),
        ));
    }

    #[test]
    fn shutdown_completion_retires_terminal_authority_and_restores_nonterminal_idle() {
        let mut state = state_fixture(ProfileActivationStateKind::Succeeded);
        state.begin_shutdown(false, 2).unwrap();
        assert_eq!(state.kind(), ProfileActivationStateKind::ShuttingDown);
        assert!(state.complete_shutdown());
        assert_eq!(state.kind(), ProfileActivationStateKind::Idle);

        let mut idle = ProfileActivationState::idle();
        idle.begin_shutdown(false, 2).unwrap();
        assert!(idle.complete_shutdown());
        assert_eq!(idle.kind(), ProfileActivationStateKind::Idle);

        state.begin_shutdown(true, 3).unwrap();
        assert!(state.complete_shutdown());
        assert_eq!(state.kind(), ProfileActivationStateKind::Shutdown);
    }

    fn state_fixture(kind: ProfileActivationStateKind) -> ProfileActivationState {
        let mut pending = ProfileActivationState::idle();
        let command = pending
            .begin(
                COMMAND_ID,
                ProfileActivationOperation::Activate,
                PROFILE_ID,
                None,
                None,
                1,
            )
            .unwrap();
        let active = ProfileActivationRuntime::Active {
            fingerprint: ACTIVE_FINGERPRINT.into(),
            profile_id: PROFILE_ID.into(),
            revision: None,
            runtime_id: None,
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
                        None,
                        None,
                        2,
                    )
                    .unwrap();
                pending
            }
            ProfileActivationStateKind::RecoveryRequired => {
                assert!(pending.complete_recovery_required(
                    &command,
                    ProfileActivationFailureEvidence::StateCommit,
                    active,
                ));
                pending
            }
            ProfileActivationStateKind::Compensating => {
                assert!(
                    pending.complete(&command, ProfileActivationCompletion::Succeeded(active),)
                );
                assert!(pending.begin_compensation(COMMAND_ID).is_some());
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
        MihomoActivationError::TunHelperUnavailable => {
            ProfileActivationFailureEvidence::TunHelperUnavailable
        }
        MihomoActivationError::TunNetworkOwnershipConflict => {
            ProfileActivationFailureEvidence::TunNetworkOwnershipConflict
        }
        MihomoActivationError::EarlyExit => ProfileActivationFailureEvidence::EarlyExit,
        MihomoActivationError::ManagedListenerConflict(endpoint) => {
            ProfileActivationFailureEvidence::ManagedListenerConflict(endpoint.to_string())
        }
        MihomoActivationError::VersionMismatch => ProfileActivationFailureEvidence::VersionMismatch,
        MihomoActivationError::ControllerFailure => ProfileActivationFailureEvidence::Controller,
        MihomoActivationError::ReadinessTimeout => ProfileActivationFailureEvidence::Timeout,
        MihomoActivationError::CaptureFailed(kind) => {
            ProfileActivationFailureEvidence::Capture(kind)
        }
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
        MihomoActivationError::TunHelperUnavailable => {
            ProfileActivationFailure::TunHelperUnavailable
        }
        MihomoActivationError::TunNetworkOwnershipConflict => {
            ProfileActivationFailure::TunNetworkOwnershipConflict
        }
        MihomoActivationError::EarlyExit => ProfileActivationFailure::EarlyExit,
        MihomoActivationError::ManagedListenerConflict(_) => {
            ProfileActivationFailure::ManagedListenerConflict
        }
        MihomoActivationError::VersionMismatch => ProfileActivationFailure::VersionMismatch,
        MihomoActivationError::ControllerFailure => ProfileActivationFailure::Controller,
        MihomoActivationError::ReadinessTimeout => ProfileActivationFailure::Timeout,
        MihomoActivationError::Cancelled => ProfileActivationFailure::Cancelled,
        MihomoActivationError::CaptureFailed(_) => ProfileActivationFailure::Capture,
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
        ProfileActivationFailure::TunHelperUnavailable => "tun-helper-unavailable",
        ProfileActivationFailure::TunNetworkOwnershipConflict => "tun-network-ownership-conflict",
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
            | ProfileActivationFailure::TunNetworkOwnershipConflict
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

fn should_publish_activation_failure_notification(
    error: MihomoActivationError,
    suppress_capture_failure_notification: bool,
) -> bool {
    !suppress_capture_failure_notification
        || !matches!(error, MihomoActivationError::CaptureFailed(_))
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
