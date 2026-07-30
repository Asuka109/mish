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
    CoreRuntime, LoopbackProxyEndpoint, MishRuntime, PolicyGroupConnectionCleanupPreference,
};
use serde::{Deserialize, Serialize};
use serde_norway::Value;
use sha2::{Digest, Sha256};
use thiserror::Error;
use tokio::{sync::Mutex, time::Instant};
use tokio_util::sync::CancellationToken;
use url::Url;
use uuid::Uuid;

use crate::{
    ControllerInitialObservation, ControllerObservationConfig, ControllerStatusSource,
    DesktopMihomoProcess, DesktopMihomoProcessConfig, ManagedCoreOwnership,
    ManagedCoreRecoveryOutcome, PrivilegedCoreHost, PrivilegedCoreHostError, ProfileMappingContext,
};

enum ManagedBinaryLocation {
    PreparedDevelopment(PathBuf),
    ProductionResources(PathBuf),
}

pub struct ManagedMihomoResolver {
    bundled_geodata: Option<PathBuf>,
    location: ManagedBinaryLocation,
    runtime_root: PathBuf,
}

impl ManagedMihomoResolver {
    pub fn development(prepared_binary: PathBuf, runtime_root: PathBuf) -> Self {
        Self {
            bundled_geodata: None,
            location: ManagedBinaryLocation::PreparedDevelopment(prepared_binary),
            runtime_root,
        }
    }

    pub fn development_with_bundled_geodata(
        prepared_binary: PathBuf,
        runtime_root: PathBuf,
        bundled_geodata: PathBuf,
    ) -> Self {
        Self {
            bundled_geodata: Some(bundled_geodata),
            location: ManagedBinaryLocation::PreparedDevelopment(prepared_binary),
            runtime_root,
        }
    }

    pub fn production(resource_directory: PathBuf, runtime_root: PathBuf) -> Self {
        Self {
            bundled_geodata: Some(resource_directory.join("geodata/snapshot")),
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
            bundled_geodata: self.bundled_geodata.clone(),
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
    bundled_geodata: Option<PathBuf>,
    runtime_root: PathBuf,
}

impl ResolvedManagedMihomo {
    pub fn binary(&self) -> &Path {
        &self.binary
    }

    pub fn runtime_root(&self) -> &Path {
        &self.runtime_root
    }

    fn bundled_geodata(&self) -> Option<&Path> {
        self.bundled_geodata.as_deref()
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
    pub geodata_preparation_timeout: Duration,
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
            geodata_preparation_timeout: Duration::from_secs(5 * 60),
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
            && !self.geodata_preparation_timeout.is_zero()
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
    #[error("the pinned Mihomo core could not prepare required geodata")]
    GeodataFailed(crate::GeodataAsset),
    #[error("the pinned Mihomo core did not prepare required geodata before the deadline")]
    GeodataTimeout(crate::GeodataAsset),
    #[error("the candidate Mihomo core could not be started")]
    StartFailed,
    #[error("the privileged TUN service is unavailable")]
    TunHelperUnavailable,
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
    config_file: PathBuf,
    controller_address: SocketAddr,
    fingerprint: String,
    home: PathBuf,
    profile_id: String,
    process: Arc<DesktopMihomoProcess>,
    proxy_endpoint: LoopbackProxyEndpoint,
    revision: String,
    runtime: MishRuntime,
    runtime_id: String,
    source: Arc<ControllerStatusSource>,
}

#[derive(Default)]
struct ActivationState {
    active: Option<ActiveMihomo>,
    capture_transition: Option<CaptureRuntimeTransition>,
    managed: ManagedActivationState,
}

pub struct MihomoActivationManager {
    capture: Option<Arc<CaptureReconciler>>,
    connection_cleanup_preference: PolicyGroupConnectionCleanupPreference,
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
            connection_cleanup_preference: PolicyGroupConnectionCleanupPreference::default(),
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

    pub fn with_connection_cleanup_preference(
        mut self,
        preference: PolicyGroupConnectionCleanupPreference,
    ) -> Self {
        self.connection_cleanup_preference = preference;
        self
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
        prune_stale_runtime_artifacts(&self.resolver.runtime_root);
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
        self.activate_cancellable_inner(record, policy, cancellation)
            .await
    }

    async fn activate_cancellable_inner(
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
        let candidate = match self.prepare_generation(&resolved, record, policy) {
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

        if let Err(error) = seed_bundled_geodata(resolved.bundled_geodata(), &candidate.home) {
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

        if cancellation.is_cancelled() {
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
            record_failed_attempt(&mut state.managed, record, MihomoActivationError::Cancelled);
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
            return Err(MihomoActivationError::Cancelled);
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
        read_selection_cache(&global_mihomo_home(&self.resolver.runtime_root).join("cache.db"))
    }

    pub fn delete_route_selections(&self, _profile_id: &str) {
        // Mihomo owns one global cache database. Profile deletion must not remove
        // selections or provider metadata that remain useful to other Profiles.
    }

    pub async fn complete_runtime_handoff(&self) {
        self.state.lock().await.capture_transition = None;
    }

    pub async fn shutdown(&self) -> Result<(), MihomoActivationError> {
        self.recover_startup().await?;
        let mut state = self.state.lock().await;
        let capture_transition = match state.capture_transition.take() {
            Some(transition) => Some(transition),
            None => match &self.capture {
                Some(capture) => Some(
                    capture
                        .clone()
                        .begin_runtime_transition()
                        .map_err(|_| MihomoActivationError::CaptureFailed)?,
                ),
                None => None,
            },
        };
        if let Some(active) = state.active.as_ref() {
            self.suspend_capture(capture_transition.as_ref()).await?;
            active
                .runtime
                .stop_core()
                .await
                .map_err(|_| MihomoActivationError::ShutdownFailed)?;
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

    fn prepare_generation(
        &self,
        resolved: &ResolvedManagedMihomo,
        record: &ProfileRecord,
        policy: &ManagedRuntimePolicy,
    ) -> Result<ActiveMihomo, MihomoActivationError> {
        let generation_id = Uuid::new_v4().to_string();
        let mihomo_root = resolved.runtime_root().join("mihomo");
        create_private_runtime_directory(&mihomo_root)?;
        let home = global_mihomo_home(resolved.runtime_root());
        create_private_runtime_directory(&home)?;
        let configs_root = mihomo_root.join("configs");
        create_private_runtime_directory(&configs_root)?;
        let config_file = configs_root.join(format!("{generation_id}.yaml"));
        let guard = GenerationConfigGuard::new(config_file.clone());
        let generated = RuntimeConfigGenerator::generate_record(record, policy)
            .map_err(|_| MihomoActivationError::InvalidArtifact)?;
        let policy_group_order = mish_profile::configured_policy_group_order(&generated)
            .map_err(|_| MihomoActivationError::InvalidArtifact)?;
        write_private_file(&config_file, &generated)?;

        let process_config = DesktopMihomoProcessConfig {
            binary: Some(resolved.binary().to_path_buf()),
            config_directory: Some(home.clone()),
            config_file: Some(config_file.clone()),
        };
        let process = Arc::new(
            match (
                policy.execution_backend(self.privileged_host.is_some()),
                &self.privileged_host,
                &self.ownership,
            ) {
                (ManagedExecutionBackend::Privileged, Some(host), _) => {
                    DesktopMihomoProcess::new_pinned_privileged(
                        process_config,
                        PINNED_MIHOMO_VERSION,
                        host.clone(),
                    )
                }
                (_, _, Some(ownership)) => DesktopMihomoProcess::new_pinned_owned(
                    process_config,
                    PINNED_MIHOMO_VERSION,
                    ownership.clone(),
                ),
                (_, _, None) => {
                    DesktopMihomoProcess::new_pinned(process_config, PINNED_MIHOMO_VERSION)
                }
            },
        );
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
        observation.connection_cleanup_preference = self.connection_cleanup_preference.clone();
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
        guard.disarm();
        Ok(ActiveMihomo {
            config_file,
            controller_address: policy.controller_address(),
            fingerprint: record.effective_fingerprint().as_str().to_owned(),
            home,
            profile_id: record.metadata.id.as_str().to_owned(),
            process,
            proxy_endpoint: policy.proxy_endpoint().clone(),
            revision: record.metadata.revision.id.as_str().to_owned(),
            runtime,
            runtime_id: generation_id,
            source,
        })
    }

    async fn start_candidate(
        &self,
        candidate: &ActiveMihomo,
        cancellation: CancellationToken,
    ) -> Result<(), MihomoActivationError> {
        if candidate.runtime.start_core().await.is_err() {
            if candidate.process.privileged_start_failure().await
                == Some(PrivilegedCoreHostError::Unavailable)
            {
                return Err(MihomoActivationError::TunHelperUnavailable);
            }
            let status = candidate.process.status().await;
            if status.error.as_deref()
                == Some(
                    crate::ManagedProcessValidationError::VersionMismatch
                        .to_string()
                        .as_str(),
                )
            {
                return Err(MihomoActivationError::VersionMismatch);
            }
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
            candidate_readiness_timeout(&candidate.home, &self.timing),
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
    remove_generation_config(&candidate.config_file);
}

const SELECTION_CACHE_SIZE_LIMIT: u64 = 4 * 1024 * 1024;
const SELECTION_CACHE_ENTRY_LIMIT: usize = 8_192;
const BUNDLED_GEODATA_MANIFEST_SIZE_LIMIT: u64 = 64 * 1024;
const BUNDLED_GEODATA_ASSET_SIZE_LIMIT: u64 = 64 * 1024 * 1024;
const BUNDLED_GEODATA_ASSETS: [(&str, &str); 4] = [
    ("geosite.dat", "GeoSite.dat"),
    ("geoip.dat", "GeoIP.dat"),
    ("geoip.metadb", "geoip.metadb"),
    ("GeoLite2-ASN.mmdb", "ASN.mmdb"),
];

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledGeodataManifest {
    assets: Vec<BundledGeodataManifestAsset>,
    schema_version: u8,
}

#[derive(Deserialize)]
struct BundledGeodataManifestAsset {
    bytes: u64,
    name: String,
    #[serde(rename = "runtimeName")]
    runtime_name: String,
    sha256: String,
}

fn bundled_geodata_assets_complete(candidate_home: &Path) -> bool {
    BUNDLED_GEODATA_ASSETS.iter().all(|(_, runtime_name)| {
        match fs::symlink_metadata(candidate_home.join(runtime_name)) {
            Ok(metadata) => {
                !metadata.file_type().is_symlink() && metadata.is_file() && metadata.len() > 0
            }
            Err(_) => false,
        }
    })
}

fn candidate_readiness_timeout(candidate_home: &Path, timing: &ActivationTiming) -> Duration {
    if bundled_geodata_assets_complete(candidate_home) {
        timing.readiness_timeout
    } else {
        timing.geodata_preparation_timeout
    }
}

fn prune_stale_geodata_seed_files(candidate_home: &Path) -> Result<(), MihomoActivationError> {
    let entries = fs::read_dir(candidate_home).map_err(|_| MihomoActivationError::StagingFailed)?;
    for entry in entries {
        let entry = entry.map_err(|_| MihomoActivationError::StagingFailed)?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let Some(id) = name.strip_prefix(".geodata-seed-") else {
            continue;
        };
        if Uuid::parse_str(id).is_err() {
            continue;
        }
        let metadata =
            fs::symlink_metadata(entry.path()).map_err(|_| MihomoActivationError::StagingFailed)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(MihomoActivationError::StagingFailed);
        }
        fs::remove_file(entry.path()).map_err(|_| MihomoActivationError::StagingFailed)?;
    }
    Ok(())
}

fn publish_private_file_atomically(
    destination: &Path,
    contents: &[u8],
) -> Result<bool, MihomoActivationError> {
    let parent = destination
        .parent()
        .ok_or(MihomoActivationError::StagingFailed)?;
    let temporary = parent.join(format!(".geodata-seed-{}", Uuid::new_v4()));
    write_private_file(&temporary, contents)?;

    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
            let _ = fs::remove_file(&temporary);
            return Err(MihomoActivationError::StagingFailed);
        }
        Ok(metadata) if metadata.len() > 0 => {
            fs::remove_file(&temporary).map_err(|_| MihomoActivationError::StagingFailed)?;
            return Ok(false);
        }
        Ok(_) => {
            fs::remove_file(destination).map_err(|_| MihomoActivationError::StagingFailed)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => {
            let _ = fs::remove_file(&temporary);
            return Err(MihomoActivationError::StagingFailed);
        }
    }

    if fs::rename(&temporary, destination).is_err() {
        let _ = fs::remove_file(&temporary);
        return Err(MihomoActivationError::StagingFailed);
    }
    #[cfg(unix)]
    if fs::File::open(parent)
        .and_then(|directory| directory.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(destination);
        return Err(MihomoActivationError::StagingFailed);
    }
    Ok(true)
}

fn seed_bundled_geodata(
    snapshot: Option<&Path>,
    candidate_home: &Path,
) -> Result<bool, MihomoActivationError> {
    prune_stale_geodata_seed_files(candidate_home)?;
    let mut missing_asset = false;
    for (_, runtime_name) in BUNDLED_GEODATA_ASSETS {
        match fs::symlink_metadata(candidate_home.join(runtime_name)) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.is_file() => {
                return Err(MihomoActivationError::StagingFailed);
            }
            Ok(metadata) if metadata.len() == 0 => {
                missing_asset = true;
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                missing_asset = true;
            }
            Err(_) => return Err(MihomoActivationError::StagingFailed),
        }
    }
    if !missing_asset {
        return Ok(false);
    }

    let Some(snapshot) = snapshot else {
        return Ok(false);
    };
    let Ok(snapshot_metadata) = fs::symlink_metadata(snapshot) else {
        return Ok(false);
    };
    if snapshot_metadata.file_type().is_symlink() || !snapshot_metadata.is_dir() {
        return Ok(false);
    }
    let manifest_path = snapshot.join("manifest.json");
    let Ok(manifest_metadata) = fs::symlink_metadata(&manifest_path) else {
        return Ok(false);
    };
    if manifest_metadata.file_type().is_symlink()
        || !manifest_metadata.is_file()
        || manifest_metadata.len() > BUNDLED_GEODATA_MANIFEST_SIZE_LIMIT
    {
        return Ok(false);
    }
    let Ok(manifest_bytes) = fs::read(manifest_path) else {
        return Ok(false);
    };
    let Ok(manifest) = serde_json::from_slice::<BundledGeodataManifest>(&manifest_bytes) else {
        return Ok(false);
    };
    if manifest.schema_version != 2
        || manifest.assets.len() != BUNDLED_GEODATA_ASSETS.len()
        || manifest
            .assets
            .iter()
            .zip(BUNDLED_GEODATA_ASSETS)
            .any(|(asset, expected)| {
                asset.name != expected.0
                    || asset.runtime_name != expected.1
                    || asset.bytes == 0
                    || asset.bytes > BUNDLED_GEODATA_ASSET_SIZE_LIMIT
                    || !asset
                        .sha256
                        .bytes()
                        .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
                    || asset.sha256.len() != 64
            })
    {
        return Ok(false);
    }

    let mut verified = Vec::with_capacity(BUNDLED_GEODATA_ASSETS.len());
    for asset in &manifest.assets {
        let source = snapshot.join(&asset.name);
        let Ok(metadata) = fs::symlink_metadata(&source) else {
            return Ok(false);
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() || metadata.len() != asset.bytes
        {
            return Ok(false);
        }
        let Ok(content) = fs::read(source) else {
            return Ok(false);
        };
        if format!("{:x}", Sha256::digest(&content)) != asset.sha256 {
            return Ok(false);
        }
        verified.push((asset.runtime_name.as_str(), content));
    }

    let mut written = Vec::with_capacity(verified.len());
    for (name, content) in verified {
        let destination = candidate_home.join(name);
        match publish_private_file_atomically(&destination, &content) {
            Ok(true) => written.push(destination),
            Ok(false) => {}
            Err(error) => {
                for prior in written {
                    let _ = fs::remove_file(prior);
                }
                return Err(error);
            }
        }
    }
    Ok(true)
}

fn global_mihomo_home(runtime_root: &Path) -> PathBuf {
    runtime_root.join("mihomo/home")
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
}

#[cfg(test)]
mod bundled_geodata_tests {
    use sha2::{Digest, Sha256};
    use tempfile::TempDir;

    use super::*;

    const ASSETS: [(&str, &str, &[u8]); 4] = [
        ("geosite.dat", "GeoSite.dat", b"geosite fixture"),
        ("geoip.dat", "GeoIP.dat", b"geoip fixture"),
        ("geoip.metadb", "geoip.metadb", b"metadb fixture"),
        ("GeoLite2-ASN.mmdb", "ASN.mmdb", b"asn fixture"),
    ];

    fn snapshot(root: &Path) -> PathBuf {
        let snapshot = root.join("snapshot");
        fs::create_dir(&snapshot).unwrap();
        let assets = ASSETS
            .iter()
            .enumerate()
            .map(|(index, (name, runtime_name, content))| {
                fs::write(snapshot.join(name), content).unwrap();
                serde_json::json!({
                    "bytes": content.len(),
                    "name": name,
                    "releaseAssetId": index + 1,
                    "runtimeName": runtime_name,
                    "sha256": format!("{:x}", Sha256::digest(content)),
                })
            })
            .collect::<Vec<_>>();
        fs::write(
            snapshot.join("manifest.json"),
            serde_json::to_vec(&serde_json::json!({
                "assets": assets,
                "release": {
                    "id": 1234,
                    "publishedAt": "2026-07-23T00:00:00Z",
                    "tag": "latest",
                    "url": "https://github.com/MetaCubeX/meta-rules-dat/releases/tag/latest",
                },
                "schemaVersion": 2,
                "source": {
                    "license": "GPL-3.0-only",
                    "licenseUrl": "https://github.com/MetaCubeX/meta-rules-dat/blob/master/LICENSE",
                    "repository": "MetaCubeX/meta-rules-dat",
                },
            }))
            .unwrap(),
        )
        .unwrap();
        snapshot
    }

    #[test]
    fn seeds_every_verified_bundled_geodata_asset() {
        let root = TempDir::new().unwrap();
        let source = snapshot(root.path());
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();

        assert_eq!(seed_bundled_geodata(Some(&source), &home).unwrap(), true);
        for (_, runtime_name, content) in ASSETS {
            assert_eq!(fs::read(home.join(runtime_name)).unwrap(), content);
        }
        assert!(fs::read_dir(&home).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".geodata-seed-")
        }));
        assert!(bundled_geodata_assets_complete(&home));
    }

    #[test]
    fn replaces_an_incomplete_asset_through_atomic_publication() {
        let root = TempDir::new().unwrap();
        let source = snapshot(root.path());
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("GeoSite.dat"), []).unwrap();

        assert!(!bundled_geodata_assets_complete(&home));
        assert_eq!(seed_bundled_geodata(Some(&source), &home).unwrap(), true);
        assert_eq!(
            fs::read(home.join("GeoSite.dat")).unwrap(),
            b"geosite fixture"
        );
        assert!(bundled_geodata_assets_complete(&home));
    }

    #[test]
    fn prunes_interrupted_atomic_seed_before_retrying() {
        let root = TempDir::new().unwrap();
        let source = snapshot(root.path());
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        let stale = home.join(format!(".geodata-seed-{}", Uuid::new_v4()));
        fs::write(&stale, b"interrupted").unwrap();

        assert_eq!(seed_bundled_geodata(Some(&source), &home).unwrap(), true);
        assert!(!stale.exists());
        assert!(bundled_geodata_assets_complete(&home));
    }

    #[test]
    fn missing_geodata_uses_the_preparation_deadline() {
        let root = TempDir::new().unwrap();
        let timing = ActivationTiming {
            geodata_preparation_timeout: Duration::from_secs(300),
            readiness_timeout: Duration::from_secs(15),
            ..ActivationTiming::default()
        };

        assert_eq!(
            candidate_readiness_timeout(root.path(), &timing),
            Duration::from_secs(300)
        );

        let source = snapshot(root.path());
        assert_eq!(
            seed_bundled_geodata(Some(&source), root.path()).unwrap(),
            true
        );
        assert_eq!(
            candidate_readiness_timeout(root.path(), &timing),
            Duration::from_secs(15)
        );
    }

    #[test]
    fn preserves_existing_global_geodata_and_only_seeds_missing_assets() {
        let root = TempDir::new().unwrap();
        let source = snapshot(root.path());
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        fs::write(home.join("GeoSite.dat"), b"newer runtime asset").unwrap();

        assert_eq!(seed_bundled_geodata(Some(&source), &home).unwrap(), true);
        assert_eq!(
            fs::read(home.join("GeoSite.dat")).unwrap(),
            b"newer runtime asset"
        );
        for (_, runtime_name, content) in ASSETS.into_iter().skip(1) {
            assert_eq!(fs::read(home.join(runtime_name)).unwrap(), content);
        }
    }

    #[test]
    fn complete_global_geodata_does_not_revalidate_the_packaged_snapshot() {
        let root = TempDir::new().unwrap();
        let source = snapshot(root.path());
        fs::write(source.join("geoip.dat"), b"broken packaged source").unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();
        for (_, runtime_name, _) in ASSETS {
            fs::write(home.join(runtime_name), b"runtime-owned").unwrap();
        }

        assert_eq!(seed_bundled_geodata(Some(&source), &home).unwrap(), false);
        for (_, runtime_name, _) in ASSETS {
            assert_eq!(fs::read(home.join(runtime_name)).unwrap(), b"runtime-owned");
        }
    }

    #[test]
    fn ignores_a_corrupt_bundle_without_partially_seeding_the_home() {
        let root = TempDir::new().unwrap();
        let source = snapshot(root.path());
        fs::write(source.join("geoip.dat"), b"broken fixture").unwrap();
        let home = root.path().join("home");
        fs::create_dir(&home).unwrap();

        assert_eq!(seed_bundled_geodata(Some(&source), &home).unwrap(), false);
        for (_, runtime_name, _) in ASSETS {
            assert!(!home.join(runtime_name).exists());
        }
    }

    #[test]
    fn development_resolver_uses_an_explicit_bundled_snapshot() {
        let root = TempDir::new().unwrap();
        let binary = root.path().join("mihomo");
        fs::write(&binary, b"fixture").unwrap();
        let runtime = root.path().join("runtime");
        let source = snapshot(root.path());

        let resolved = ManagedMihomoResolver::development_with_bundled_geodata(
            binary,
            runtime,
            source.clone(),
        )
        .resolve()
        .unwrap();

        assert_eq!(resolved.bundled_geodata(), Some(source.as_path()));
    }

    #[test]
    fn production_resolver_uses_the_tauri_resource_layout_without_repository_state() {
        let root = TempDir::new().unwrap();
        let resources = root.path().join("Mish.app/Contents/Resources");
        fs::create_dir_all(resources.join("geodata/snapshot")).unwrap();
        let sidecar = resources.join(ManagedMihomoResolver::production_sidecar_name());
        fs::write(&sidecar, b"packaged core fixture").unwrap();
        let runtime = root
            .path()
            .join("Library/Application Support/com.asuka109.mish/runtime");

        let resolved = ManagedMihomoResolver::production(resources.clone(), runtime.clone())
            .resolve()
            .unwrap();

        assert_eq!(resolved.binary(), sidecar);
        assert_eq!(
            resolved.bundled_geodata(),
            Some(resources.join("geodata/snapshot").as_path())
        );
        assert_eq!(resolved.runtime_root(), runtime);
    }
}

fn retire_candidate(_runtime_root: &Path, active: &ActiveMihomo) {
    remove_generation_config(&active.config_file);
}

fn prune_stale_runtime_artifacts(runtime_root: &Path) {
    prune_generation_configs(runtime_root);
    prune_legacy_candidates(runtime_root);
    prune_legacy_selection_cache(runtime_root);
}

fn prune_generation_configs(runtime_root: &Path) {
    let configs_root = runtime_root.join("mihomo/configs");
    let Ok(metadata) = fs::symlink_metadata(&configs_root) else {
        return;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return;
    }
    let Ok(entries) = fs::read_dir(&configs_root) else {
        return;
    };
    for entry in entries.flatten() {
        remove_generation_config(&entry.path());
    }
}

fn prune_legacy_candidates(runtime_root: &Path) {
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

fn remove_generation_config(config_file: &Path) {
    let Some(file_name) = config_file.file_name().and_then(|name| name.to_str()) else {
        return;
    };
    let Some(generation_id) = file_name.strip_suffix(".yaml") else {
        return;
    };
    if Uuid::parse_str(generation_id).is_err()
        || config_file
            .parent()
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("configs")
        || config_file
            .parent()
            .and_then(Path::parent)
            .and_then(Path::file_name)
            .and_then(|name| name.to_str())
            != Some("mihomo")
    {
        return;
    }
    let Ok(metadata) = fs::symlink_metadata(config_file) else {
        return;
    };
    if metadata.is_file() && !metadata.file_type().is_symlink() {
        let _ = fs::remove_file(config_file);
    }
}

fn prune_legacy_selection_cache(runtime_root: &Path) {
    let cache_root = runtime_root.join("profile-selection-cache");
    let Ok(metadata) = fs::symlink_metadata(&cache_root) else {
        return;
    };
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return;
    }
    let deleting = runtime_root.join(format!(
        ".deleting-profile-selection-cache-{}",
        Uuid::new_v4()
    ));
    if fs::rename(&cache_root, &deleting).is_ok() {
        let _ = fs::remove_dir_all(deleting);
    }
}

struct GenerationConfigGuard {
    armed: bool,
    path: PathBuf,
}

impl GenerationConfigGuard {
    fn new(path: PathBuf) -> Self {
        Self { armed: true, path }
    }

    fn disarm(mut self) {
        self.armed = false;
    }
}

impl Drop for GenerationConfigGuard {
    fn drop(&mut self) {
        if self.armed {
            remove_generation_config(&self.path);
        }
    }
}

#[cfg(test)]
mod runtime_artifact_cleanup_tests {
    use tempfile::TempDir;

    use super::*;

    #[test]
    fn startup_prunes_only_uuid_candidate_and_staging_roots() {
        let root = TempDir::new().unwrap();
        let candidates = root.path().join("candidates");
        fs::create_dir(&candidates).unwrap();
        let candidate = candidates.join(Uuid::new_v4().to_string());
        let staging = candidates.join(format!(".staging-{}", Uuid::new_v4()));
        let unrelated = candidates.join("maintainer-note");
        for path in [&candidate, &staging, &unrelated] {
            fs::create_dir(path).unwrap();
            fs::write(path.join("evidence"), b"fixture").unwrap();
        }

        prune_legacy_candidates(root.path());

        assert!(!candidate.exists());
        assert!(!staging.exists());
        assert!(unrelated.join("evidence").exists());
    }

    #[test]
    fn generation_guard_removes_only_uuid_config_files() {
        let root = TempDir::new().unwrap();
        let configs = root.path().join("mihomo/configs");
        fs::create_dir_all(&configs).unwrap();
        let generation = configs.join(format!("{}.yaml", Uuid::new_v4()));
        fs::write(&generation, b"fixture").unwrap();
        {
            let _guard = GenerationConfigGuard::new(generation.clone());
        }
        assert!(!generation.exists());

        let unrelated = configs.join("maintainer-note.yaml");
        fs::write(&unrelated, b"fixture").unwrap();
        remove_generation_config(&unrelated);
        assert!(unrelated.exists());
    }

    #[test]
    fn startup_prunes_generation_configs_and_obsolete_profile_cache_but_keeps_global_home() {
        let root = TempDir::new().unwrap();
        let configs = root.path().join("mihomo/configs");
        let home = root.path().join("mihomo/home");
        let legacy_cache = root
            .path()
            .join("profile-selection-cache/profile-a/fingerprint-a");
        fs::create_dir_all(&configs).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::create_dir_all(&legacy_cache).unwrap();
        let generation = configs.join(format!("{}.yaml", Uuid::new_v4()));
        let unrelated = configs.join("maintainer-note");
        fs::write(&generation, b"fixture").unwrap();
        fs::write(&unrelated, b"fixture").unwrap();
        fs::write(home.join("cache.db"), b"global").unwrap();
        fs::write(legacy_cache.join("cache.db"), b"legacy").unwrap();

        prune_stale_runtime_artifacts(root.path());

        assert!(!generation.exists());
        assert!(unrelated.exists());
        assert_eq!(fs::read(home.join("cache.db")).unwrap(), b"global");
        assert!(!root.path().join("profile-selection-cache").exists());
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
            Self::GeodataFailed(_) => ActivationFailureKind::GeodataFailed,
            Self::GeodataTimeout(_) => ActivationFailureKind::GeodataTimeout,
            Self::StartFailed | Self::TunHelperUnavailable => ActivationFailureKind::Start,
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
    process_discovery_mode: mish_settings::ProcessDiscoveryMode,
    tart_tun_dns: bool,
    tun_enabled: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ManagedExecutionBackend {
    Managed,
    Privileged,
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
            process_discovery_mode: mish_settings::ProcessDiscoveryMode::default(),
            tart_tun_dns: false,
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

    /// Applies the TUN selection that was already admitted by the aggregate Capture authority.
    ///
    /// The caller must first validate the requested selection against current capabilities. This
    /// avoids regenerating a cold-launch Core from the still-confirmed pre-operation Capture
    /// projection while the admitted target is pending.
    pub(crate) fn with_admitted_tun_selection(mut self, enabled: bool) -> Self {
        self.tun_enabled = enabled;
        self
    }

    pub fn with_tart_tun_dns(mut self, enabled: bool) -> Self {
        self.tart_tun_dns = enabled;
        self
    }

    pub fn with_proxy_endpoint(mut self, proxy_endpoint: LoopbackProxyEndpoint) -> Self {
        self.proxy_endpoint = proxy_endpoint;
        self
    }

    pub fn with_process_discovery_mode(
        mut self,
        process_discovery_mode: mish_settings::ProcessDiscoveryMode,
    ) -> Self {
        self.process_discovery_mode = process_discovery_mode;
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

    fn execution_backend(&self, privileged_host_available: bool) -> ManagedExecutionBackend {
        if self.tun_enabled && privileged_host_available {
            ManagedExecutionBackend::Privileged
        } else {
            ManagedExecutionBackend::Managed
        }
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

#[cfg(test)]
mod managed_execution_backend_tests {
    use super::*;

    #[test]
    fn packaged_privileged_host_is_reserved_for_explicit_tun_policy() {
        let regular = ManagedRuntimePolicy::new(
            "127.0.0.1:43123".parse().unwrap(),
            "application-controller-secret",
        )
        .unwrap();
        let helper = mish_runtime::TunHelperSnapshot {
            availability: mish_runtime::TunHelperAvailability::Available,
            expected_version: mish_runtime::TUN_HELPER_EXPECTED_VERSION.to_owned(),
            health: mish_runtime::TunHelperHealth::Healthy,
            installation_id: Some("installation-alpha".to_owned()),
            installed_version: Some(mish_runtime::TUN_HELPER_EXPECTED_VERSION.to_owned()),
            last_failure: None,
            phase: mish_runtime::TunHelperLifecyclePhase::Idle,
        };
        let tun = ManagedRuntimePolicy::new(
            "127.0.0.1:43124".parse().unwrap(),
            "application-controller-secret",
        )
        .unwrap()
        .with_tun_enabled(&helper, true)
        .unwrap();

        assert_eq!(
            regular.execution_backend(true),
            ManagedExecutionBackend::Managed
        );
        assert_eq!(
            tun.execution_backend(true),
            ManagedExecutionBackend::Privileged
        );
        assert_eq!(
            tun.execution_backend(false),
            ManagedExecutionBackend::Managed
        );
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
        Self::generate_with_review_scoped(&patched.bytes, policy, Some(record.metadata.id.as_str()))
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
        Self::generate_with_review_scoped(normalized_artifact, policy, None)
    }

    fn generate_with_review_scoped(
        normalized_artifact: &[u8],
        policy: &ManagedRuntimePolicy,
        profile_id: Option<&str>,
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
                process_discovery_mode: match policy.process_discovery_mode {
                    mish_settings::ProcessDiscoveryMode::Always => "always",
                    mish_settings::ProcessDiscoveryMode::Strict => "strict",
                    mish_settings::ProcessDiscoveryMode::Off => "off",
                }
                .to_owned(),
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
        if policy.tun_enabled && policy.tart_tun_dns {
            apply_tart_tun_dns(&mut document)?;
        }
        if let Some(profile_id) = profile_id {
            namespace_explicit_provider_paths(&mut document, profile_id)?;
        }

        let bytes = serde_norway::to_string(&document)
            .map(String::into_bytes)
            .map_err(|_| RuntimeConfigGenerationError::SerializationFailed)?;
        Ok(GeneratedRuntimeConfig {
            bytes,
            classifications,
        })
    }
}

fn apply_tart_tun_dns(document: &mut Value) -> Result<(), RuntimeConfigGenerationError> {
    let root = document
        .as_mapping_mut()
        .ok_or(RuntimeConfigGenerationError::InvalidArtifact)?;
    let mut dns = serde_norway::Mapping::new();
    dns.insert(Value::String("enable".to_owned()), Value::Bool(true));
    dns.insert(
        Value::String("enhanced-mode".to_owned()),
        Value::String("fake-ip".to_owned()),
    );
    dns.insert(
        Value::String("fake-ip-range".to_owned()),
        Value::String("198.18.0.1/16".to_owned()),
    );
    dns.insert(
        Value::String("nameserver".to_owned()),
        Value::Sequence(vec![Value::String("1.1.1.1".to_owned())]),
    );
    root.insert(Value::String("dns".to_owned()), Value::Mapping(dns));
    Ok(())
}

fn namespace_explicit_provider_paths(
    document: &mut Value,
    profile_id: &str,
) -> Result<(), RuntimeConfigGenerationError> {
    let root = document
        .as_mapping_mut()
        .ok_or(RuntimeConfigGenerationError::InvalidArtifact)?;
    for section in ["proxy-providers", "rule-providers"] {
        let Some(providers) = root
            .get_mut(Value::String(section.to_owned()))
            .and_then(Value::as_mapping_mut)
        else {
            continue;
        };
        for provider in providers.values_mut() {
            let Some(mapping) = provider.as_mapping_mut() else {
                continue;
            };
            let key = Value::String("path".to_owned());
            let Some(path) = mapping.get(&key).and_then(Value::as_str) else {
                continue;
            };
            if path.is_empty() {
                continue;
            }
            let normalized = path.replace('\\', "/");
            let components = normalized
                .split('/')
                .filter(|component| !component.is_empty() && *component != ".")
                .collect::<Vec<_>>();
            if components.is_empty() || components.iter().any(|component| *component == "..") {
                return Err(RuntimeConfigGenerationError::UnsafeManagedPath);
            }
            mapping.insert(
                key,
                Value::String(format!(
                    "profile-resources/{profile_id}/{}",
                    components.join("/")
                )),
            );
        }
    }
    Ok(())
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
