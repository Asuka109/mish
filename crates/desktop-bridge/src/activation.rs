use std::{
    collections::HashMap,
    fmt, fs,
    net::SocketAddr,
    path::{Path, PathBuf},
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use mish_mihomo_controller::PINNED_MIHOMO_VERSION;
use mish_profile::{
    Fingerprint, ManagedRuntimeValues, PolicyClassification, PolicyViolationKind, ProfileRecord,
    ValidationStatus, apply_runtime_policy,
};
use mish_runtime::{
    CaptureReconciler, CaptureRequest, CaptureRuntimeTransition, CaptureSelection, CorePhase,
    CoreRuntime, LoopbackProxyEndpoint, MishRuntime, RuntimeShutdownFailure,
};
use serde::{Deserialize, Serialize};
use serde_norway::Value;
use thiserror::Error;
use tokio::{sync::Mutex, time::Instant};
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

use crate::{
    ControllerInitialObservation, ControllerObservationConfig, ControllerStatusSource,
    DesktopMihomoProcess, DesktopMihomoProcessConfig, ManagedCoreOwnership,
    ManagedCoreRecoveryOutcome, ManagedProcessValidationError, PrivilegedCoreHost,
    ProfileMappingContext,
};

enum ManagedBinaryLocation {
    PreparedDevelopment(PathBuf),
    ProductionResources(PathBuf),
}

pub struct ManagedMihomoResolver {
    location: ManagedBinaryLocation,
    runtime_root: PathBuf,
}

impl ManagedMihomoResolver {
    pub fn development(prepared_binary: PathBuf, runtime_root: PathBuf) -> Self {
        Self {
            location: ManagedBinaryLocation::PreparedDevelopment(prepared_binary),
            runtime_root,
        }
    }

    pub fn production(resource_directory: PathBuf, runtime_root: PathBuf) -> Self {
        Self {
            location: ManagedBinaryLocation::ProductionResources(resource_directory),
            runtime_root,
        }
    }

    pub const fn production_sidecar_name() -> &'static str {
        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        return "mihomo-aarch64-apple-darwin";
        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        return "mihomo-x86_64-apple-darwin";
        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        return "mihomo-x86_64-pc-windows-msvc.exe";
        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        return "mihomo-x86_64-unknown-linux-gnu";
        #[allow(unreachable_code)]
        "mihomo-unsupported-platform"
    }

    pub const fn production_runtime_name() -> &'static str {
        #[cfg(target_os = "windows")]
        return "mihomo.exe";
        #[allow(unreachable_code)]
        "mihomo"
    }

    pub fn resolve(&self) -> Result<ResolvedManagedMihomo, MihomoResolveError> {
        if !self.runtime_root.is_absolute() {
            return Err(MihomoResolveError::UnsafeManagedPath);
        }
        let binary = match &self.location {
            ManagedBinaryLocation::PreparedDevelopment(binary) => binary.clone(),
            ManagedBinaryLocation::ProductionResources(resources) => {
                let packaged = resources.join(Self::production_runtime_name());
                if packaged.is_file() {
                    packaged
                } else {
                    resources.join(Self::production_sidecar_name())
                }
            }
        };
        if !binary.is_absolute() {
            return Err(MihomoResolveError::UnsafeManagedPath);
        }
        let metadata =
            fs::symlink_metadata(&binary).map_err(|_| MihomoResolveError::BinaryMissing)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(MihomoResolveError::UnsafeManagedPath);
        }
        create_private_directory(&self.runtime_root)?;
        Ok(ResolvedManagedMihomo {
            binary,
            runtime_root: self.runtime_root.clone(),
        })
    }
}

impl fmt::Debug for ManagedMihomoResolver {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedMihomoResolver")
            .field("location", &"[redacted]")
            .field("runtime_root", &"[redacted]")
            .finish()
    }
}

pub struct ResolvedManagedMihomo {
    binary: PathBuf,
    runtime_root: PathBuf,
}

impl ResolvedManagedMihomo {
    pub fn binary(&self) -> &Path {
        &self.binary
    }

    pub fn runtime_root(&self) -> &Path {
        &self.runtime_root
    }
}

impl fmt::Debug for ResolvedManagedMihomo {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ResolvedManagedMihomo")
            .field("binary", &"[redacted]")
            .field("runtime_root", &"[redacted]")
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum MihomoResolveError {
    #[error("the pinned managed Mihomo binary is missing")]
    BinaryMissing,
    #[error("the managed Mihomo resource path is unsafe")]
    UnsafeManagedPath,
    #[error("the private managed runtime directory could not be prepared")]
    RuntimeRootUnavailable,
}

fn create_private_directory(path: &Path) -> Result<(), MihomoResolveError> {
    fs::create_dir_all(path).map_err(|_| MihomoResolveError::RuntimeRootUnavailable)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|_| MihomoResolveError::RuntimeRootUnavailable)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(MihomoResolveError::UnsafeManagedPath);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| MihomoResolveError::RuntimeRootUnavailable)?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug)]
pub struct ActivationTiming {
    pub config_validation_timeout: Duration,
    pub controller_connect_timeout: Duration,
    pub controller_request_timeout: Duration,
    pub readiness_timeout: Duration,
    pub refresh_interval: Duration,
    pub reconnect_delay: Duration,
}

impl Default for ActivationTiming {
    fn default() -> Self {
        Self {
            config_validation_timeout: Duration::from_secs(10),
            controller_connect_timeout: Duration::from_secs(2),
            controller_request_timeout: Duration::from_secs(2),
            readiness_timeout: Duration::from_secs(15),
            refresh_interval: Duration::from_secs(2),
            reconnect_delay: Duration::from_millis(100),
        }
    }
}

impl ActivationTiming {
    fn valid(self) -> bool {
        !self.config_validation_timeout.is_zero()
            && !self.controller_connect_timeout.is_zero()
            && !self.controller_request_timeout.is_zero()
            && !self.readiness_timeout.is_zero()
            && !self.refresh_interval.is_zero()
            && !self.reconnect_delay.is_zero()
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum MihomoActivationError {
    #[error("the persisted profile does not contain a valid normalized artifact")]
    InvalidArtifact,
    #[error("managed Mihomo activation timing is invalid")]
    InvalidTiming,
    #[error(transparent)]
    Resolve(#[from] MihomoResolveError),
    #[error("the private candidate configuration could not be staged")]
    StagingFailed,
    #[error("the pinned Mihomo core rejected the candidate configuration")]
    ValidationFailed,
    #[error("the candidate Mihomo core could not be started")]
    StartFailed,
    #[error("the candidate Mihomo core exited before activation committed")]
    EarlyExit,
    #[error("a Mish-managed loopback listener is already in use")]
    ManagedListenerConflict(SocketAddr),
    #[error("the candidate Mihomo Controller reported an unsupported version")]
    VersionMismatch,
    #[error("the candidate Mihomo Controller returned an invalid first snapshot")]
    ControllerFailure,
    #[error("the candidate Mihomo Controller did not become ready before the deadline")]
    ReadinessTimeout,
    #[error("managed Mihomo activation was cancelled")]
    Cancelled,
    #[error("System Proxy could not be reconciled during managed activation")]
    CaptureFailed,
    #[error("the prior managed Mihomo core could not be stopped safely")]
    PriorStopFailed,
    #[error("the managed active state could not be committed atomically")]
    StateCommitFailed,
    #[error("activation rollback reached an explicit safe stopped state")]
    RollbackFailedSafeStopped,
    #[error("the managed Mihomo core could not be stopped safely")]
    ShutdownFailed,
    #[error("managed Mihomo ownership recovery could not be completed safely")]
    OwnershipFailed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivationOutcome {
    Succeeded,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivationFailureKind {
    InvalidArtifact,
    Resolve,
    Staging,
    Validation,
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivationAttempt {
    attempted_at_unix_milliseconds: u64,
    failure: Option<ActivationFailureKind>,
    fingerprint: String,
    outcome: ActivationOutcome,
    profile_id: String,
}

impl ActivationAttempt {
    pub fn attempted_at_unix_milliseconds(&self) -> u64 {
        self.attempted_at_unix_milliseconds
    }

    pub fn failure(&self) -> Option<ActivationFailureKind> {
        self.failure
    }

    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn outcome(&self) -> ActivationOutcome {
        self.outcome
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedActivationState {
    active_fingerprint: Option<String>,
    active_profile_id: Option<String>,
    #[serde(default)]
    active_revision: Option<String>,
    active_runtime_id: Option<String>,
    #[serde(default)]
    last_successful_profile_id: Option<String>,
    last_attempt: Option<ActivationAttempt>,
    schema_version: u32,
}

impl Default for ManagedActivationState {
    fn default() -> Self {
        Self {
            active_fingerprint: None,
            active_profile_id: None,
            active_revision: None,
            active_runtime_id: None,
            last_successful_profile_id: None,
            last_attempt: None,
            schema_version: 2,
        }
    }
}

impl ManagedActivationState {
    pub fn active_fingerprint(&self) -> Option<&str> {
        self.active_fingerprint.as_deref()
    }

    pub fn active_profile_id(&self) -> Option<&str> {
        self.active_profile_id.as_deref()
    }

    pub fn active_revision(&self) -> Option<&str> {
        self.active_revision.as_deref()
    }

    pub fn last_successful_profile_id(&self) -> Option<&str> {
        self.last_successful_profile_id.as_deref()
    }

    pub fn is_safe_stopped(&self) -> bool {
        self.active_profile_id.is_none()
    }

    pub fn last_attempt(&self) -> Option<&ActivationAttempt> {
        self.last_attempt.as_ref()
    }
}

pub struct ActivationCommit {
    fingerprint: String,
    profile_id: String,
    revision: String,
}

impl ActivationCommit {
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }
}

impl fmt::Debug for ActivationCommit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActivationCommit")
            .field("fingerprint", &self.fingerprint)
            .field("profile_id", &self.profile_id)
            .field("revision", &self.revision)
            .finish()
    }
}

struct ActiveMihomo {
    candidate_root: PathBuf,
    controller_address: SocketAddr,
    fingerprint: String,
    profile_id: String,
    process: Arc<DesktopMihomoProcess>,
    proxy_endpoint: LoopbackProxyEndpoint,
    revision: String,
    runtime: MishRuntime,
    runtime_id: String,
    source: Arc<ControllerStatusSource>,
    store_selected: bool,
}

#[derive(Default)]
struct ActivationState {
    active: Option<ActiveMihomo>,
    capture_transition: Option<CaptureRuntimeTransition>,
    managed: ManagedActivationState,
}

pub struct MihomoActivationManager {
    capture: Option<Arc<CaptureReconciler>>,
    ownership: Option<Arc<ManagedCoreOwnership>>,
    privileged_host: Option<Arc<dyn PrivilegedCoreHost>>,
    recovery_outcome: Mutex<Option<ManagedCoreRecoveryOutcome>>,
    resolver: ManagedMihomoResolver,
    state: Mutex<ActivationState>,
    timing: ActivationTiming,
}

impl MihomoActivationManager {
    pub fn new(resolver: ManagedMihomoResolver, timing: ActivationTiming) -> Self {
        Self::new_with_capture(resolver, timing, None)
    }

    pub fn new_with_capture(
        resolver: ManagedMihomoResolver,
        timing: ActivationTiming,
        capture: Option<Arc<CaptureReconciler>>,
    ) -> Self {
        Self::new_with_execution_backend(resolver, timing, capture, None, None)
    }

    pub fn new_managed(
        resolver: ManagedMihomoResolver,
        timing: ActivationTiming,
        capture: Option<Arc<CaptureReconciler>>,
        ownership: Arc<ManagedCoreOwnership>,
    ) -> Self {
        Self::new_with_execution_backend(resolver, timing, capture, Some(ownership), None)
    }

    pub fn new_privileged(
        resolver: ManagedMihomoResolver,
        timing: ActivationTiming,
        capture: Option<Arc<CaptureReconciler>>,
        ownership: Arc<ManagedCoreOwnership>,
        privileged_host: Arc<dyn PrivilegedCoreHost>,
    ) -> Self {
        Self::new_with_execution_backend(
            resolver,
            timing,
            capture,
            Some(ownership),
            Some(privileged_host),
        )
    }

    fn new_with_execution_backend(
        resolver: ManagedMihomoResolver,
        timing: ActivationTiming,
        capture: Option<Arc<CaptureReconciler>>,
        ownership: Option<Arc<ManagedCoreOwnership>>,
        privileged_host: Option<Arc<dyn PrivilegedCoreHost>>,
    ) -> Self {
        let managed = load_managed_state(&resolver.runtime_root);
        Self {
            capture,
            ownership,
            privileged_host,
            recovery_outcome: Mutex::new(None),
            resolver,
            state: Mutex::new(ActivationState {
                managed,
                ..ActivationState::default()
            }),
            timing,
        }
    }

    pub async fn recover_startup(
        &self,
    ) -> Result<ManagedCoreRecoveryOutcome, MihomoActivationError> {
        let mut recovered = self.recovery_outcome.lock().await;
        if let Some(outcome) = *recovered {
            return Ok(outcome);
        }
        let outcome = match &self.ownership {
            Some(ownership) => ownership
                .recover_startup()
                .await
                .map_err(|_| MihomoActivationError::OwnershipFailed)?,
            None => ManagedCoreRecoveryOutcome::NoRecord,
        };
        prune_stale_candidates(&self.resolver.runtime_root);
        *recovered = Some(outcome);
        Ok(outcome)
    }

    pub fn availability(&self) -> Result<(), MihomoResolveError> {
        self.resolver.resolve().map(|_| ())
    }

    pub async fn activate(
        &self,
        record: &ProfileRecord,
        policy: &ManagedRuntimePolicy,
    ) -> Result<ActivationCommit, MihomoActivationError> {
        let result = self
            .activate_cancellable(record, policy, CancellationToken::new())
            .await;
        self.complete_runtime_handoff().await;
        result
    }

    pub async fn activate_cancellable(
        &self,
        record: &ProfileRecord,
        policy: &ManagedRuntimePolicy,
        cancellation: CancellationToken,
    ) -> Result<ActivationCommit, MihomoActivationError> {
        self.recover_startup().await?;
        if !self.timing.valid() {
            return Err(MihomoActivationError::InvalidTiming);
        }
        validate_activation_record(record)?;
        let resolved = self.resolver.resolve()?;
        let mut state = self.state.lock().await;
        let candidate = match self
            .stage_candidate(&resolved, record, policy, cancellation.clone())
            .await
        {
            Ok(candidate) => candidate,
            Err(error) => {
                record_failed_attempt(&mut state.managed, record, error);
                persist_managed_state(resolved.runtime_root(), &state.managed)?;
                return Err(error);
            }
        };

        if cancellation.is_cancelled() {
            rollback_candidate(candidate).await;
            record_failed_attempt(&mut state.managed, record, MihomoActivationError::Cancelled);
            persist_managed_state(resolved.runtime_root(), &state.managed)?;
            return Err(MihomoActivationError::Cancelled);
        }

        let mut capture_transition = match &self.capture {
            Some(capture) => match capture.clone().begin_runtime_transition() {
                Ok(transition) => Some(transition),
                Err(_) => {
                    rollback_candidate(candidate).await;
                    let error = MihomoActivationError::CaptureFailed;
                    record_failed_attempt(&mut state.managed, record, error);
                    persist_managed_state(resolved.runtime_root(), &state.managed)?;
                    return Err(error);
                }
            },
            None => None,
        };

        let suspended_capture = if state.active.is_some() {
            match self.suspend_capture(capture_transition.as_ref()).await {
                Ok(selection) => selection,
                Err(error) => {
                    rollback_candidate(candidate).await;
                    record_failed_attempt(&mut state.managed, record, error);
                    persist_managed_state(resolved.runtime_root(), &state.managed)?;
                    return Err(error);
                }
            }
        } else {
            None
        };

        if let Some(previous) = state.active.as_ref()
            && previous.runtime.stop_core().await.is_err()
        {
            rollback_candidate(candidate).await;
            let restored = self
                .restore_previous(
                    state.active.as_ref(),
                    suspended_capture.as_ref(),
                    capture_transition.as_ref(),
                )
                .await;
            record_failed_attempt(
                &mut state.managed,
                record,
                MihomoActivationError::PriorStopFailed,
            );
            if !restored {
                if let Some(previous) = state.active.take() {
                    previous.source.close().await;
                    retire_candidate(resolved.runtime_root(), &previous);
                }
                state.managed.active_fingerprint = None;
                state.managed.active_profile_id = None;
                state.managed.active_revision = None;
                state.managed.active_runtime_id = None;
                persist_managed_state(resolved.runtime_root(), &state.managed)?;
                return Err(MihomoActivationError::RollbackFailedSafeStopped);
            }
            persist_managed_state(resolved.runtime_root(), &state.managed)?;
            return Err(MihomoActivationError::PriorStopFailed);
        }

        if let Err(error) = self.start_candidate(&candidate, cancellation.clone()).await {
            rollback_candidate(candidate).await;
            let restored = self
                .restore_previous(
                    state.active.as_ref(),
                    suspended_capture.as_ref(),
                    capture_transition.as_ref(),
                )
                .await;
            record_failed_attempt(&mut state.managed, record, error);
            if !restored {
                if let Some(previous) = state.active.take() {
                    previous.source.close().await;
                    retire_candidate(resolved.runtime_root(), &previous);
                }
                state.managed.active_fingerprint = None;
                state.managed.active_profile_id = None;
                state.managed.active_revision = None;
                state.managed.active_runtime_id = None;
                persist_managed_state(resolved.runtime_root(), &state.managed)?;
                return Err(MihomoActivationError::RollbackFailedSafeStopped);
            }
            persist_managed_state(resolved.runtime_root(), &state.managed)?;
            return Err(error);
        }

        if let Some(selection) = suspended_capture.as_ref()
            && self
                .resume_capture(selection, capture_transition.as_ref())
                .await
                .is_err()
        {
            rollback_candidate(candidate).await;
            let restored = self
                .restore_previous(
                    state.active.as_ref(),
                    Some(selection),
                    capture_transition.as_ref(),
                )
                .await;
            let error = MihomoActivationError::CaptureFailed;
            record_failed_attempt(&mut state.managed, record, error);
            if !restored {
                if let Some(previous) = state.active.take() {
                    previous.source.close().await;
                    retire_candidate(resolved.runtime_root(), &previous);
                }
                state.managed.active_fingerprint = None;
                state.managed.active_profile_id = None;
                state.managed.active_revision = None;
                state.managed.active_runtime_id = None;
                persist_managed_state(resolved.runtime_root(), &state.managed)?;
                return Err(MihomoActivationError::RollbackFailedSafeStopped);
            }
            persist_managed_state(resolved.runtime_root(), &state.managed)?;
            return Err(error);
        }

        let committed_state = ManagedActivationState {
            active_fingerprint: Some(candidate.fingerprint.clone()),
            active_profile_id: Some(candidate.profile_id.clone()),
            active_revision: Some(candidate.revision.clone()),
            active_runtime_id: Some(candidate.runtime_id.clone()),
            last_successful_profile_id: Some(candidate.profile_id.clone()),
            last_attempt: Some(ActivationAttempt {
                attempted_at_unix_milliseconds: now_unix_milliseconds(),
                failure: None,
                fingerprint: candidate.fingerprint.clone(),
                outcome: ActivationOutcome::Succeeded,
                profile_id: candidate.profile_id.clone(),
            }),
            schema_version: 2,
        };
        if persist_managed_state(resolved.runtime_root(), &committed_state).is_err() {
            if suspended_capture.is_some() {
                let _ = self.suspend_capture(capture_transition.as_ref()).await;
            }
            rollback_candidate(candidate).await;
            let restored = self
                .restore_previous(
                    state.active.as_ref(),
                    suspended_capture.as_ref(),
                    capture_transition.as_ref(),
                )
                .await;
            record_failed_attempt(
                &mut state.managed,
                record,
                MihomoActivationError::StateCommitFailed,
            );
            if !restored {
                if let Some(previous) = state.active.take() {
                    previous.source.close().await;
                    retire_candidate(resolved.runtime_root(), &previous);
                }
                state.managed.active_fingerprint = None;
                state.managed.active_profile_id = None;
                state.managed.active_revision = None;
                state.managed.active_runtime_id = None;
                return Err(MihomoActivationError::RollbackFailedSafeStopped);
            }
            return Err(MihomoActivationError::StateCommitFailed);
        }
        let previous = state.active.replace(candidate);
        state.capture_transition = capture_transition.take();
        state.managed = committed_state;
        if let Some(previous) = previous {
            previous.source.close().await;
            retire_candidate(resolved.runtime_root(), &previous);
        }
        Ok(ActivationCommit {
            fingerprint: record.effective_fingerprint().as_str().to_owned(),
            profile_id: record.metadata.id.as_str().to_owned(),
            revision: record.metadata.revision.id.as_str().to_owned(),
        })
    }

    pub async fn active_runtime(&self) -> Option<MishRuntime> {
        self.state
            .lock()
            .await
            .active
            .as_ref()
            .map(|active| active.runtime.clone())
    }

    pub async fn managed_state(&self) -> ManagedActivationState {
        self.state.lock().await.managed.clone()
    }

    pub fn route_selections(&self, record: &ProfileRecord) -> HashMap<String, String> {
        if !mish_profile::profile_store_selected(record).unwrap_or(false) {
            return HashMap::new();
        }
        read_selection_cache(&selection_cache_path(
            &self.resolver.runtime_root,
            record.metadata.id.as_str(),
            record.effective_fingerprint().as_str(),
        ))
    }

    pub fn delete_route_selections(&self, profile_id: &str) {
        remove_selection_cache_profile(&self.resolver.runtime_root, profile_id);
    }

    pub async fn complete_runtime_handoff(&self) {
        self.state.lock().await.capture_transition = None;
    }

    pub async fn shutdown(&self) -> Result<(), MihomoActivationError> {
        self.recover_startup().await?;
        let mut state = self.state.lock().await;
        state.capture_transition = None;
        if let Some(active) = state.active.as_ref() {
            active
                .runtime
                .shutdown()
                .await
                .map_err(|failure| match failure {
                    RuntimeShutdownFailure::CaptureRestoration => {
                        MihomoActivationError::CaptureFailed
                    }
                    RuntimeShutdownFailure::CoreStop => MihomoActivationError::ShutdownFailed,
                })?;
        }
        if let Some(active) = state.active.take() {
            active.source.close().await;
            retire_candidate(&self.resolver.runtime_root, &active);
        }
        state.managed.active_fingerprint = None;
        state.managed.active_profile_id = None;
        state.managed.active_revision = None;
        state.managed.active_runtime_id = None;
        persist_managed_state(&self.resolver.runtime_root, &state.managed)
    }

    async fn stage_candidate(
        &self,
        resolved: &ResolvedManagedMihomo,
        record: &ProfileRecord,
        policy: &ManagedRuntimePolicy,
        cancellation: CancellationToken,
    ) -> Result<ActiveMihomo, MihomoActivationError> {
        let candidate_id = Uuid::new_v4().to_string();
        let candidates_root = resolved.runtime_root().join("candidates");
        create_private_runtime_directory(&candidates_root)?;
        let staging_root = candidates_root.join(format!(".staging-{candidate_id}"));
        fs::create_dir(&staging_root).map_err(|_| MihomoActivationError::StagingFailed)?;
        let mut candidate_guard = CandidateDirectoryGuard::new(staging_root.clone());
        set_private_directory_permissions(&staging_root)?;
        let home = staging_root.join("home");
        create_private_runtime_directory(&home)?;
        let config_file = staging_root.join("config.yaml");
        let generated = RuntimeConfigGenerator::generate_record(record, policy)
            .map_err(|_| MihomoActivationError::InvalidArtifact)?;
        let store_selected = mish_profile::profile_store_selected(record)
            .map_err(|_| MihomoActivationError::InvalidArtifact)?;
        if store_selected {
            restore_selection_cache(resolved.runtime_root(), record, &home)?;
        }
        let policy_group_order = mish_profile::configured_policy_group_order(&generated)
            .map_err(|_| MihomoActivationError::InvalidArtifact)?;
        write_private_file(&config_file, &generated)?;

        let staging_process = DesktopMihomoProcess::new_pinned(
            DesktopMihomoProcessConfig {
                binary: Some(resolved.binary().to_path_buf()),
                config_directory: Some(home.clone()),
                config_file: Some(config_file.clone()),
            },
            PINNED_MIHOMO_VERSION,
        );
        let validation = tokio::select! {
            _ = cancellation.cancelled() => Err(MihomoActivationError::Cancelled),
            result = staging_process.validate_config(self.timing.config_validation_timeout) => {
                result.map_err(|error| match error {
                    ManagedProcessValidationError::VersionMismatch => MihomoActivationError::VersionMismatch,
                    _ => MihomoActivationError::ValidationFailed,
                })
            }
        };
        validation?;

        let candidate_root = candidates_root.join(&candidate_id);
        fs::rename(&staging_root, &candidate_root)
            .map_err(|_| MihomoActivationError::StagingFailed)?;
        candidate_guard.track(candidate_root.clone());
        let process_config = DesktopMihomoProcessConfig {
            binary: Some(resolved.binary().to_path_buf()),
            config_directory: Some(candidate_root.join("home")),
            config_file: Some(candidate_root.join("config.yaml")),
        };
        let process = Arc::new(match (&self.privileged_host, &self.ownership) {
            (Some(host), _) => DesktopMihomoProcess::new_pinned_privileged(
                process_config,
                PINNED_MIHOMO_VERSION,
                host.clone(),
            ),
            (None, Some(ownership)) => DesktopMihomoProcess::new_pinned_owned(
                process_config,
                PINNED_MIHOMO_VERSION,
                ownership.clone(),
            ),
            (None, None) => DesktopMihomoProcess::new_pinned(process_config, PINNED_MIHOMO_VERSION),
        });
        let profile = ProfileMappingContext::new(
            record.metadata.id.as_str(),
            record.effective_fingerprint().as_str(),
            &record.metadata.label,
        )
        .map_err(|_| MihomoActivationError::InvalidArtifact)?
        .with_policy_group_order(policy_group_order);
        let base_url = Url::parse(&format!("http://{}", policy.controller_address()))
            .map_err(|_| MihomoActivationError::ControllerFailure)?;
        let mut observation = ControllerObservationConfig::new(base_url, profile);
        observation.secret = Some(policy.controller_secret().to_owned());
        observation.connect_timeout = self.timing.controller_connect_timeout;
        observation.request_timeout = self.timing.controller_request_timeout;
        observation.refresh_interval = self.timing.refresh_interval;
        observation.reconnect_delay = self.timing.reconnect_delay;
        let source = ControllerStatusSource::new(observation, process.clone())
            .map_err(|_| MihomoActivationError::ControllerFailure)?;
        let runtime = MishRuntime::with_data_sources_events_and_capture(
            process.clone(),
            source.clone(),
            source.clone(),
            source.clone(),
            self.capture.clone(),
        );
        candidate_guard.disarm();
        Ok(ActiveMihomo {
            candidate_root,
            controller_address: policy.controller_address(),
            fingerprint: record.effective_fingerprint().as_str().to_owned(),
            profile_id: record.metadata.id.as_str().to_owned(),
            process,
            proxy_endpoint: policy.proxy_endpoint().clone(),
            revision: record.metadata.revision.id.as_str().to_owned(),
            runtime,
            runtime_id: candidate_id,
            source,
            store_selected,
        })
    }

    async fn start_candidate(
        &self,
        candidate: &ActiveMihomo,
        cancellation: CancellationToken,
    ) -> Result<(), MihomoActivationError> {
        if candidate.runtime.start_core().await.is_err() {
            if let Some(endpoint) =
                managed_listener_conflict(&candidate.proxy_endpoint, candidate.controller_address)
            {
                return Err(MihomoActivationError::ManagedListenerConflict(endpoint));
            }
            return Err(MihomoActivationError::StartFailed);
        }
        candidate.source.start().await;
        wait_for_candidate(
            &candidate.runtime,
            &candidate.source,
            &candidate.process,
            &candidate.proxy_endpoint,
            candidate.controller_address,
            self.timing.readiness_timeout,
            cancellation,
        )
        .await
    }

    async fn suspend_capture(
        &self,
        transition: Option<&CaptureRuntimeTransition>,
    ) -> Result<Option<CaptureSelection>, MihomoActivationError> {
        let Some(capture) = &self.capture else {
            return Ok(None);
        };
        let status = capture.confirmed_status();
        if !status.system_proxy.desired && !status.tun.desired {
            return Ok(None);
        }
        let transition = transition.ok_or(MihomoActivationError::CaptureFailed)?;
        capture
            .reconcile_runtime_transition(
                transition,
                CaptureRequest {
                    active: false,
                    selection: status.capture_selection.clone(),
                },
                false,
            )
            .await
            .map_err(|_| MihomoActivationError::CaptureFailed)?;
        Ok(Some(status.capture_selection))
    }

    async fn resume_capture(
        &self,
        selection: &CaptureSelection,
        transition: Option<&CaptureRuntimeTransition>,
    ) -> Result<(), MihomoActivationError> {
        let Some(capture) = &self.capture else {
            return Ok(());
        };
        let transition = transition.ok_or(MihomoActivationError::CaptureFailed)?;
        capture
            .reconcile_runtime_transition(
                transition,
                CaptureRequest {
                    active: true,
                    selection: selection.clone(),
                },
                true,
            )
            .await
            .map(|_| ())
            .map_err(|_| MihomoActivationError::CaptureFailed)
    }

    async fn restore_previous(
        &self,
        previous: Option<&ActiveMihomo>,
        capture: Option<&CaptureSelection>,
        transition: Option<&CaptureRuntimeTransition>,
    ) -> bool {
        let core_restored = match previous {
            Some(previous)
                if matches!(
                    previous.runtime.core_status().await.phase,
                    CorePhase::Running
                ) =>
            {
                true
            }
            Some(previous) => previous.runtime.start_core().await.is_ok(),
            None => true,
        };
        if !core_restored {
            return false;
        }
        match capture {
            Some(selection) => self.resume_capture(selection, transition).await.is_ok(),
            None => true,
        }
    }
}

fn validate_activation_record(record: &ProfileRecord) -> Result<(), MihomoActivationError> {
    let metadata = &record.metadata;
    if metadata.validation.status != ValidationStatus::Valid
        || !metadata.status.valid
        || metadata.artifact.fingerprint
            != Fingerprint::from_normalized_artifact(&record.normalized_bytes)
    {
        return Err(MihomoActivationError::InvalidArtifact);
    }
    let applied = mish_profile::apply_profile_patches(
        &record.normalized_bytes,
        &metadata.revision.id,
        &metadata.artifact.fingerprint,
        &record.patches,
    )
    .map_err(|_| MihomoActivationError::InvalidArtifact)?;
    if applied.effective_fingerprint != *record.effective_fingerprint() {
        return Err(MihomoActivationError::InvalidArtifact);
    }
    Ok(())
}

async fn wait_for_candidate(
    runtime: &MishRuntime,
    source: &ControllerStatusSource,
    process: &DesktopMihomoProcess,
    proxy_endpoint: &LoopbackProxyEndpoint,
    controller_address: SocketAddr,
    timeout_after: Duration,
    cancellation: CancellationToken,
) -> Result<(), MihomoActivationError> {
    let deadline = Instant::now() + timeout_after;
    let mut invalid_snapshot_observed = false;
    loop {
        match source.initial_observation() {
            ControllerInitialObservation::Ready => {
                if let Some(endpoint) =
                    unowned_managed_listener_conflict(process, proxy_endpoint, controller_address)
                        .await
                {
                    return Err(MihomoActivationError::ManagedListenerConflict(endpoint));
                }
                if process.owns_local_proxy(proxy_endpoint).await {
                    return Ok(());
                }
            }
            ControllerInitialObservation::VersionMismatch => {
                return Err(MihomoActivationError::VersionMismatch);
            }
            ControllerInitialObservation::InvalidSnapshot => {
                invalid_snapshot_observed = true;
            }
            ControllerInitialObservation::Pending => {}
        }
        if !matches!(runtime.core_status().await.phase, CorePhase::Running) {
            if let Some(endpoint) = managed_listener_conflict(proxy_endpoint, controller_address) {
                return Err(MihomoActivationError::ManagedListenerConflict(endpoint));
            }
            return Err(MihomoActivationError::EarlyExit);
        }
        if Instant::now() >= deadline {
            if let Some(endpoint) =
                unowned_managed_listener_conflict(process, proxy_endpoint, controller_address).await
            {
                return Err(MihomoActivationError::ManagedListenerConflict(endpoint));
            }
            return Err(if invalid_snapshot_observed {
                MihomoActivationError::ControllerFailure
            } else {
                MihomoActivationError::ReadinessTimeout
            });
        }
        tokio::select! {
            _ = cancellation.cancelled() => return Err(MihomoActivationError::Cancelled),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
    }
}

/// A listener collision is actionable only when the live candidate cannot prove
/// that it owns the endpoint. This avoids converting an unrelated Controller
/// readiness failure from a correctly bound managed Core into a port-conflict
/// diagnosis.
async fn unowned_managed_listener_conflict(
    process: &impl CoreRuntime,
    proxy_endpoint: &LoopbackProxyEndpoint,
    controller_address: SocketAddr,
) -> Option<SocketAddr> {
    for endpoint in managed_listener_endpoints(proxy_endpoint, controller_address) {
        if std::net::TcpListener::bind(endpoint).is_ok() {
            continue;
        }
        let listener =
            LoopbackProxyEndpoint::new(&endpoint.ip().to_string(), endpoint.port()).ok()?;
        if !process.owns_local_proxy(&listener).await {
            return Some(endpoint);
        }
    }
    None
}

/// Detect only whether Mish's fixed loopback endpoint can be bound. This does not
/// inspect arbitrary processes, command lines, configuration, or credentials.
fn managed_listener_conflict(
    proxy_endpoint: &LoopbackProxyEndpoint,
    controller_address: SocketAddr,
) -> Option<SocketAddr> {
    managed_listener_endpoints(proxy_endpoint, controller_address)
        .into_iter()
        .find(|endpoint| std::net::TcpListener::bind(endpoint).is_err())
}

fn managed_listener_endpoints(
    proxy_endpoint: &LoopbackProxyEndpoint,
    controller_address: SocketAddr,
) -> [SocketAddr; 2] {
    [
        SocketAddr::new(proxy_endpoint.host(), proxy_endpoint.port()),
        controller_address,
    ]
}

async fn rollback_candidate(candidate: ActiveMihomo) {
    candidate.source.close().await;
    let _ = candidate.runtime.stop_core().await;
    remove_candidate(&candidate.candidate_root);
}

const SELECTION_CACHE_SIZE_LIMIT: u64 = 4 * 1024 * 1024;
const SELECTION_CACHE_ENTRY_LIMIT: usize = 8_192;

fn selection_cache_path(runtime_root: &Path, profile_id: &str, fingerprint: &str) -> PathBuf {
    runtime_root
        .join("profile-selection-cache")
        .join(profile_id)
        .join(fingerprint)
        .join("cache.db")
}

fn restore_selection_cache(
    runtime_root: &Path,
    record: &ProfileRecord,
    candidate_home: &Path,
) -> Result<(), MihomoActivationError> {
    restore_selection_cache_file(
        runtime_root,
        record.metadata.id.as_str(),
        record.effective_fingerprint().as_str(),
        candidate_home,
    )
}

fn restore_selection_cache_file(
    runtime_root: &Path,
    profile_id: &str,
    fingerprint: &str,
    candidate_home: &Path,
) -> Result<(), MihomoActivationError> {
    let source = selection_cache_path(runtime_root, profile_id, fingerprint);
    let Ok(metadata) = fs::symlink_metadata(&source) else {
        return Ok(());
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > SELECTION_CACHE_SIZE_LIMIT
    {
        return Ok(());
    }
    let bytes = fs::read(source).map_err(|_| MihomoActivationError::StagingFailed)?;
    write_private_file(&candidate_home.join("cache.db"), &bytes)
}

fn persist_selection_cache(runtime_root: &Path, active: &ActiveMihomo) {
    persist_selection_cache_file(
        runtime_root,
        &active.profile_id,
        &active.fingerprint,
        active.store_selected,
        &active.candidate_root,
    );
}

fn persist_selection_cache_file(
    runtime_root: &Path,
    profile_id: &str,
    fingerprint: &str,
    store_selected: bool,
    candidate_root: &Path,
) {
    if !store_selected {
        return;
    }
    let source = candidate_root.join("home/cache.db");
    let Ok(metadata) = fs::symlink_metadata(&source) else {
        return;
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > SELECTION_CACHE_SIZE_LIMIT
    {
        return;
    }
    let Ok(bytes) = fs::read(source) else {
        return;
    };
    let destination = selection_cache_path(runtime_root, profile_id, fingerprint);
    let Some(parent) = destination.parent() else {
        return;
    };
    if create_private_runtime_directory(parent).is_err() {
        return;
    }
    let temporary = parent.join(format!(".cache-{}", Uuid::new_v4()));
    if write_private_file(&temporary, &bytes).is_ok() {
        let _ = fs::rename(&temporary, destination);
    }
    let _ = fs::remove_file(temporary);
}

fn read_selection_cache(path: &Path) -> HashMap<String, String> {
    let Ok(metadata) = fs::symlink_metadata(path) else {
        return HashMap::new();
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > SELECTION_CACHE_SIZE_LIMIT
    {
        return HashMap::new();
    }
    let Ok(database) = bolt_lite::Bolt::open_ro(path) else {
        return HashMap::new();
    };
    let Ok(transaction) = database.begin() else {
        return HashMap::new();
    };
    let Some(bucket) = transaction.bucket(b"selected") else {
        return HashMap::new();
    };
    let mut selections = HashMap::new();
    let Ok(cursor) = bucket.cursor() else {
        return HashMap::new();
    };
    for entry in cursor.take(SELECTION_CACHE_ENTRY_LIMIT) {
        let Ok(group) = String::from_utf8(entry.key) else {
            continue;
        };
        let Ok(selected) = String::from_utf8(entry.value) else {
            continue;
        };
        if !group.is_empty() && group.len() <= 512 && !selected.is_empty() && selected.len() <= 512
        {
            selections.insert(group, selected);
        }
    }
    selections
}

#[cfg(test)]
mod selection_cache_tests {
    use bbolt_rs::{Bolt, BucketRwApi, DbRwAPI, TxRwRefApi};
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn reads_mihomo_selected_bucket_from_bolt_cache() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("cache.db");
        let mut database = Bolt::open(&path).unwrap();
        database
            .update(|mut transaction| {
                let mut selected = transaction.create_bucket_if_not_exists("selected")?;
                selected.put("Default", "Tokyo")?;
                selected.put("Streaming", "Singapore")?;
                Ok(())
            })
            .unwrap();
        drop(database);

        let selections = read_selection_cache(&path);

        assert_eq!(selections.get("Default").map(String::as_str), Some("Tokyo"));
        assert_eq!(
            selections.get("Streaming").map(String::as_str),
            Some("Singapore")
        );
    }

    #[test]
    fn invalid_cache_is_treated_as_absent() {
        let root = TempDir::new().unwrap();
        let path = root.path().join("cache.db");
        fs::write(&path, b"not a Bolt database").unwrap();

        assert!(read_selection_cache(&path).is_empty());
    }

    #[test]
    fn persists_and_restores_profile_scoped_selection_cache() {
        let root = TempDir::new().unwrap();
        let candidate = root.path().join("candidates/source");
        fs::create_dir_all(candidate.join("home")).unwrap();
        let source = candidate.join("home/cache.db");
        let mut database = Bolt::open(&source).unwrap();
        database
            .update(|mut transaction| {
                transaction
                    .create_bucket_if_not_exists("selected")?
                    .put("Default", "Tokyo")?;
                Ok(())
            })
            .unwrap();
        drop(database);

        persist_selection_cache_file(root.path(), "profile-a", "fingerprint-a", true, &candidate);
        let persisted = selection_cache_path(root.path(), "profile-a", "fingerprint-a");
        assert_eq!(
            read_selection_cache(&persisted)
                .get("Default")
                .map(String::as_str),
            Some("Tokyo")
        );

        let restored_home = root.path().join("candidates/restored/home");
        fs::create_dir_all(&restored_home).unwrap();
        restore_selection_cache_file(root.path(), "profile-a", "fingerprint-a", &restored_home)
            .unwrap();
        assert_eq!(
            read_selection_cache(&restored_home.join("cache.db"))
                .get("Default")
                .map(String::as_str),
            Some("Tokyo")
        );
    }
}

fn remove_selection_cache_profile(runtime_root: &Path, profile_id: &str) {
    if mish_profile::ProfileId::parse(profile_id.to_owned()).is_err() {
        return;
    }
    let root = runtime_root.join("profile-selection-cache");
    let profile = root.join(profile_id);
    let Ok(metadata) = fs::symlink_metadata(&profile) else {
        return;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return;
    }
    let deleting = root.join(format!(".deleting-{}", Uuid::new_v4()));
    if fs::rename(&profile, &deleting).is_ok() {
        let _ = fs::remove_dir_all(deleting);
    }
}

fn retire_candidate(runtime_root: &Path, active: &ActiveMihomo) {
    persist_selection_cache(runtime_root, active);
    remove_candidate(&active.candidate_root);
}

fn prune_stale_candidates(runtime_root: &Path) {
    let candidates_root = runtime_root.join("candidates");
    let Ok(metadata) = fs::symlink_metadata(&candidates_root) else {
        return;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(&candidates_root) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let candidate_id = name.strip_prefix(".staging-").unwrap_or(name);
        if Uuid::parse_str(candidate_id).is_err() {
            continue;
        }
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if file_type.is_dir() && !file_type.is_symlink() {
            remove_candidate(&entry.path());
        }
    }
}

fn remove_candidate(candidate_root: &Path) {
    let Some(name) = candidate_root.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let candidate_id = name.strip_prefix(".staging-").unwrap_or(name);
    if Uuid::parse_str(candidate_id).is_err()
        || candidate_root
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("candidates")
    {
        return;
    }
    let Ok(metadata) = fs::symlink_metadata(candidate_root) else {
        return;
    };
    if metadata.is_dir() && !metadata.file_type().is_symlink() {
        let _ = fs::remove_dir_all(candidate_root);
    }
}

struct CandidateDirectoryGuard {
    armed: bool,
    path: PathBuf,
}

impl CandidateDirectoryGuard {
    fn new(path: PathBuf) -> Self {
        Self { armed: true, path }
    }

    fn track(&mut self, path: PathBuf) {
        self.path = path;
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for CandidateDirectoryGuard {
    fn drop(&mut self) {
        if self.armed {
            remove_candidate(&self.path);
        }
    }
}

fn record_failed_attempt(
    state: &mut ManagedActivationState,
    record: &ProfileRecord,
    error: MihomoActivationError,
) {
    state.last_attempt = Some(ActivationAttempt {
        attempted_at_unix_milliseconds: now_unix_milliseconds(),
        failure: Some(error.failure_kind()),
        fingerprint: record.effective_fingerprint().as_str().to_owned(),
        outcome: ActivationOutcome::Failed,
        profile_id: record.metadata.id.as_str().to_owned(),
    });
}

impl MihomoActivationError {
    const fn failure_kind(self) -> ActivationFailureKind {
        match self {
            Self::InvalidArtifact | Self::InvalidTiming => ActivationFailureKind::InvalidArtifact,
            Self::Resolve(_) => ActivationFailureKind::Resolve,
            Self::StagingFailed => ActivationFailureKind::Staging,
            Self::ValidationFailed => ActivationFailureKind::Validation,
            Self::StartFailed => ActivationFailureKind::Start,
            Self::EarlyExit => ActivationFailureKind::EarlyExit,
            Self::ManagedListenerConflict(_) => ActivationFailureKind::ManagedListenerConflict,
            Self::VersionMismatch => ActivationFailureKind::VersionMismatch,
            Self::ControllerFailure => ActivationFailureKind::Controller,
            Self::ReadinessTimeout => ActivationFailureKind::Timeout,
            Self::Cancelled => ActivationFailureKind::Cancelled,
            Self::CaptureFailed => ActivationFailureKind::Capture,
            Self::PriorStopFailed => ActivationFailureKind::PriorStop,
            Self::StateCommitFailed
            | Self::RollbackFailedSafeStopped
            | Self::ShutdownFailed
            | Self::OwnershipFailed => ActivationFailureKind::StateCommit,
        }
    }
}

fn persist_managed_state(
    runtime_root: &Path,
    state: &ManagedActivationState,
) -> Result<(), MihomoActivationError> {
    create_private_runtime_directory(runtime_root)
        .map_err(|_| MihomoActivationError::StateCommitFailed)?;
    let contents =
        serde_json::to_vec_pretty(state).map_err(|_| MihomoActivationError::StateCommitFailed)?;
    let temporary = runtime_root.join(format!(".activation-state-{}", Uuid::new_v4()));
    write_private_file(&temporary, &contents)
        .map_err(|_| MihomoActivationError::StateCommitFailed)?;
    fs::rename(&temporary, runtime_root.join("activation-state.json"))
        .map_err(|_| MihomoActivationError::StateCommitFailed)?;
    #[cfg(unix)]
    fs::File::open(runtime_root)
        .and_then(|directory| directory.sync_all())
        .map_err(|_| MihomoActivationError::StateCommitFailed)?;
    Ok(())
}

fn load_managed_state(runtime_root: &Path) -> ManagedActivationState {
    let path = runtime_root.join("activation-state.json");
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(_) => return ManagedActivationState::default(),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() > 32_768 {
        return ManagedActivationState::default();
    }
    #[cfg(unix)]
    if {
        use std::os::unix::fs::PermissionsExt;
        metadata.permissions().mode() & 0o777 != 0o600
    } {
        return ManagedActivationState::default();
    }
    let Ok(contents) = fs::read(path) else {
        return ManagedActivationState::default();
    };
    serde_json::from_slice(&contents).unwrap_or_default()
}

fn create_private_runtime_directory(path: &Path) -> Result<(), MihomoActivationError> {
    fs::create_dir_all(path).map_err(|_| MihomoActivationError::StagingFailed)?;
    let metadata = fs::symlink_metadata(path).map_err(|_| MihomoActivationError::StagingFailed)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(MihomoActivationError::StagingFailed);
    }
    set_private_directory_permissions(path)
}

fn set_private_directory_permissions(path: &Path) -> Result<(), MihomoActivationError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| MihomoActivationError::StagingFailed)?;
    }
    Ok(())
}

fn now_unix_milliseconds() -> u64 {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(milliseconds).unwrap_or(u64::MAX)
}

fn write_private_file(path: &Path, contents: &[u8]) -> Result<(), MihomoActivationError> {
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    use std::io::Write;
    let mut file = options
        .open(path)
        .map_err(|_| MihomoActivationError::StagingFailed)?;
    file.write_all(contents)
        .and_then(|_| file.sync_all())
        .map_err(|_| MihomoActivationError::StagingFailed)
}

pub struct ManagedRuntimePolicy {
    controller_address: SocketAddr,
    controller_secret: String,
    proxy_endpoint: LoopbackProxyEndpoint,
    tun_enabled: bool,
}

impl ManagedRuntimePolicy {
    pub fn new(
        controller_address: SocketAddr,
        controller_secret: impl Into<String>,
    ) -> Result<Self, RuntimeConfigGenerationError> {
        let controller_secret = controller_secret.into();
        if !controller_address.ip().is_loopback() {
            return Err(RuntimeConfigGenerationError::UnsafeController);
        }
        if controller_secret.is_empty() || controller_secret.contains(['\r', '\n']) {
            return Err(RuntimeConfigGenerationError::InvalidControllerSecret);
        }
        Ok(Self {
            controller_address,
            controller_secret,
            proxy_endpoint: LoopbackProxyEndpoint::managed(),
            tun_enabled: false,
        })
    }

    pub fn with_tun_enabled(
        mut self,
        helper: &mish_runtime::TunHelperSnapshot,
        explicitly_selected: bool,
    ) -> Result<Self, RuntimeConfigGenerationError> {
        if explicitly_selected && !helper.is_healthy() {
            return Err(RuntimeConfigGenerationError::TunHelperUnavailable);
        }
        self.tun_enabled = explicitly_selected;
        Ok(self)
    }

    pub fn with_proxy_endpoint(mut self, proxy_endpoint: LoopbackProxyEndpoint) -> Self {
        self.proxy_endpoint = proxy_endpoint;
        self
    }

    pub fn controller_address(&self) -> SocketAddr {
        self.controller_address
    }

    pub fn controller_secret(&self) -> &str {
        &self.controller_secret
    }

    pub fn proxy_endpoint(&self) -> &LoopbackProxyEndpoint {
        &self.proxy_endpoint
    }
}

impl fmt::Debug for ManagedRuntimePolicy {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ManagedRuntimePolicy")
            .field("controller_address", &"[redacted]")
            .field("controller_secret", &"[redacted]")
            .field("tun_enabled", &self.tun_enabled)
            .finish()
    }
}

#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum RuntimeConfigGenerationError {
    #[error("normalized artifact is not a valid Mihomo YAML mapping")]
    InvalidArtifact,
    #[error("managed Controller endpoint must be loopback-only")]
    UnsafeController,
    #[error("managed Controller secret is invalid")]
    InvalidControllerSecret,
    #[error("managed runtime configuration could not be generated")]
    SerializationFailed,
    #[error("normalized artifact contains an unsafe managed resource path")]
    UnsafeManagedPath,
    #[error("profile patches could not be applied safely")]
    InvalidPatches,
    #[error("TUN requires an explicitly selected, healthy signed helper")]
    TunHelperUnavailable,
}

pub struct RuntimeConfigGenerator;

pub struct GeneratedRuntimeConfig {
    pub bytes: Vec<u8>,
    pub classifications: Vec<PolicyClassification>,
}

impl RuntimeConfigGenerator {
    pub fn generate_record(
        record: &ProfileRecord,
        policy: &ManagedRuntimePolicy,
    ) -> Result<Vec<u8>, RuntimeConfigGenerationError> {
        Ok(Self::generate_record_with_review(record, policy)?.bytes)
    }

    pub fn generate_record_with_review(
        record: &ProfileRecord,
        policy: &ManagedRuntimePolicy,
    ) -> Result<GeneratedRuntimeConfig, RuntimeConfigGenerationError> {
        let patched = mish_profile::apply_profile_patches(
            &record.normalized_bytes,
            &record.metadata.revision.id,
            &record.metadata.artifact.fingerprint,
            &record.patches,
        )
        .map_err(|_| RuntimeConfigGenerationError::InvalidPatches)?;
        Self::generate_with_review(&patched.bytes, policy)
    }

    pub fn generate(
        normalized_artifact: &[u8],
        policy: &ManagedRuntimePolicy,
    ) -> Result<Vec<u8>, RuntimeConfigGenerationError> {
        Ok(Self::generate_with_review(normalized_artifact, policy)?.bytes)
    }

    pub fn generate_with_review(
        normalized_artifact: &[u8],
        policy: &ManagedRuntimePolicy,
    ) -> Result<GeneratedRuntimeConfig, RuntimeConfigGenerationError> {
        let mut document: Value = serde_norway::from_slice(normalized_artifact)
            .map_err(|_| RuntimeConfigGenerationError::InvalidArtifact)?;
        if document.as_mapping().is_none() {
            return Err(RuntimeConfigGenerationError::InvalidArtifact);
        }
        let classifications = apply_runtime_policy(
            &mut document,
            &ManagedRuntimeValues {
                controller_address: policy.controller_address.to_string(),
                controller_secret: policy.controller_secret.clone(),
                mixed_port: policy.proxy_endpoint.port(),
                proxy_host: policy.proxy_endpoint.host().to_string(),
                tun_enabled: policy.tun_enabled,
            },
        )
        .map_err(|violation| match violation.kind {
            PolicyViolationKind::UnsafeProviderPath => {
                RuntimeConfigGenerationError::UnsafeManagedPath
            }
            PolicyViolationKind::InvalidManagedShape
            | PolicyViolationKind::UnsafeDeviceIntegration => {
                RuntimeConfigGenerationError::InvalidArtifact
            }
        })?;

        let bytes = serde_norway::to_string(&document)
            .map(String::into_bytes)
            .map_err(|_| RuntimeConfigGenerationError::SerializationFailed)?;
        Ok(GeneratedRuntimeConfig {
            bytes,
            classifications,
        })
    }
}

#[cfg(test)]
mod managed_listener_ownership_tests {
    use std::{collections::HashSet, net::TcpListener};

    use futures_util::future::BoxFuture;
    use mish_runtime::{CoreError, CorePhase, CoreStatus};

    use super::*;

    struct CandidateOwnership {
        owned_endpoints: HashSet<SocketAddr>,
    }

    impl CandidateOwnership {
        fn owning(endpoints: impl IntoIterator<Item = SocketAddr>) -> Self {
            Self {
                owned_endpoints: endpoints.into_iter().collect(),
            }
        }
    }

    impl CoreRuntime for CandidateOwnership {
        fn configured(&self) -> bool {
            true
        }

        fn owns_local_proxy(&self, endpoint: &LoopbackProxyEndpoint) -> BoxFuture<'_, bool> {
            let owned = self
                .owned_endpoints
                .contains(&SocketAddr::new(endpoint.host(), endpoint.port()));
            Box::pin(std::future::ready(owned))
        }

        fn status(&self) -> BoxFuture<'_, CoreStatus> {
            Box::pin(std::future::ready(CoreStatus {
                error: None,
                phase: CorePhase::Stopped,
                pid: None,
                version: None,
            }))
        }

        fn start(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
            Box::pin(async { Ok(self.status().await) })
        }

        fn stop(&self) -> BoxFuture<'_, Result<CoreStatus, CoreError>> {
            Box::pin(async { Ok(self.status().await) })
        }
    }

    fn occupied_loopback_listener() -> TcpListener {
        TcpListener::bind("127.0.0.1:0").unwrap()
    }

    #[tokio::test]
    async fn owned_proxy_does_not_hide_a_foreign_controller_listener() {
        let proxy_listener = occupied_loopback_listener();
        let controller_listener = occupied_loopback_listener();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let controller_address = controller_listener.local_addr().unwrap();
        let proxy_endpoint = LoopbackProxyEndpoint::new("127.0.0.1", proxy_address.port()).unwrap();
        let candidate = CandidateOwnership::owning([proxy_address]);

        assert_eq!(
            unowned_managed_listener_conflict(&candidate, &proxy_endpoint, controller_address)
                .await,
            Some(controller_address)
        );
    }

    #[tokio::test]
    async fn foreign_proxy_listener_is_reported_before_controller() {
        let proxy_listener = occupied_loopback_listener();
        let controller_listener = occupied_loopback_listener();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let controller_address = controller_listener.local_addr().unwrap();
        let proxy_endpoint = LoopbackProxyEndpoint::new("127.0.0.1", proxy_address.port()).unwrap();
        let candidate = CandidateOwnership::owning([]);

        assert_eq!(
            unowned_managed_listener_conflict(&candidate, &proxy_endpoint, controller_address)
                .await,
            Some(proxy_address)
        );
    }

    #[tokio::test]
    async fn listeners_owned_by_the_candidate_are_not_conflicts() {
        let proxy_listener = occupied_loopback_listener();
        let controller_listener = occupied_loopback_listener();
        let proxy_address = proxy_listener.local_addr().unwrap();
        let controller_address = controller_listener.local_addr().unwrap();
        let proxy_endpoint = LoopbackProxyEndpoint::new("127.0.0.1", proxy_address.port()).unwrap();
        let candidate = CandidateOwnership::owning([proxy_address, controller_address]);

        assert_eq!(
            unowned_managed_listener_conflict(&candidate, &proxy_endpoint, controller_address)
                .await,
            None
        );
    }
}
