use std::{
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
    LoopbackProxyEndpoint, MishRuntime,
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
    DesktopMihomoProcess, DesktopMihomoProcessConfig, ManagedProcessValidationError,
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
    active_runtime_id: Option<String>,
    last_attempt: Option<ActivationAttempt>,
    schema_version: u32,
}

impl Default for ManagedActivationState {
    fn default() -> Self {
        Self {
            active_fingerprint: None,
            active_profile_id: None,
            active_runtime_id: None,
            last_attempt: None,
            schema_version: 1,
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
}

impl ActivationCommit {
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }

    pub fn profile_id(&self) -> &str {
        &self.profile_id
    }
}

impl fmt::Debug for ActivationCommit {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("ActivationCommit")
            .field("fingerprint", &self.fingerprint)
            .field("profile_id", &self.profile_id)
            .finish()
    }
}

struct ActiveMihomo {
    fingerprint: String,
    profile_id: String,
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
        Self {
            capture,
            resolver,
            state: Mutex::new(ActivationState::default()),
            timing,
        }
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
                }
                state.managed.active_fingerprint = None;
                state.managed.active_profile_id = None;
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
                }
                state.managed.active_fingerprint = None;
                state.managed.active_profile_id = None;
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
                }
                state.managed.active_fingerprint = None;
                state.managed.active_profile_id = None;
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
            active_runtime_id: Some(candidate.runtime_id.clone()),
            last_attempt: Some(ActivationAttempt {
                attempted_at_unix_milliseconds: now_unix_milliseconds(),
                failure: None,
                fingerprint: candidate.fingerprint.clone(),
                outcome: ActivationOutcome::Succeeded,
                profile_id: candidate.profile_id.clone(),
            }),
            schema_version: 1,
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
                }
                state.managed.active_fingerprint = None;
                state.managed.active_profile_id = None;
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
        }
        Ok(ActivationCommit {
            fingerprint: record.metadata.artifact.fingerprint.as_str().to_owned(),
            profile_id: record.metadata.id.as_str().to_owned(),
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

    pub async fn complete_runtime_handoff(&self) {
        self.state.lock().await.capture_transition = None;
    }

    pub async fn shutdown(&self) -> Result<(), MihomoActivationError> {
        let mut state = self.state.lock().await;
        state.capture_transition = None;
        if let Some(active) = state.active.as_ref() {
            active
                .runtime
                .shutdown()
                .await
                .map_err(|_| MihomoActivationError::ShutdownFailed)?;
        }
        state.active = None;
        state.managed.active_fingerprint = None;
        state.managed.active_profile_id = None;
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
        set_private_directory_permissions(&staging_root)?;
        let home = staging_root.join("home");
        create_private_runtime_directory(&home)?;
        let config_file = staging_root.join("config.yaml");
        let generated = RuntimeConfigGenerator::generate(&record.normalized_bytes, policy)
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
        if let Err(error) = validation {
            let _ = fs::remove_dir_all(&staging_root);
            return Err(error);
        }

        let candidate_root = candidates_root.join(&candidate_id);
        fs::rename(&staging_root, &candidate_root)
            .map_err(|_| MihomoActivationError::StagingFailed)?;
        let process = Arc::new(DesktopMihomoProcess::new_pinned(
            DesktopMihomoProcessConfig {
                binary: Some(resolved.binary().to_path_buf()),
                config_directory: Some(candidate_root.join("home")),
                config_file: Some(candidate_root.join("config.yaml")),
            },
            PINNED_MIHOMO_VERSION,
        ));
        let profile = ProfileMappingContext::new(
            record.metadata.id.as_str(),
            record.metadata.artifact.fingerprint.as_str(),
            &record.metadata.label,
        )
        .map_err(|_| MihomoActivationError::InvalidArtifact)?;
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
            process,
            source.clone(),
            source.clone(),
            source.clone(),
            self.capture.clone(),
        );
        Ok(ActiveMihomo {
            fingerprint: record.metadata.artifact.fingerprint.as_str().to_owned(),
            profile_id: record.metadata.id.as_str().to_owned(),
            runtime,
            runtime_id: candidate_id,
            source,
        })
    }

    async fn start_candidate(
        &self,
        candidate: &ActiveMihomo,
        cancellation: CancellationToken,
    ) -> Result<(), MihomoActivationError> {
        if candidate.runtime.start_core().await.is_err() {
            return Err(MihomoActivationError::StartFailed);
        }
        candidate.source.start().await;
        wait_for_candidate(
            &candidate.runtime,
            &candidate.source,
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
        let status = capture.status();
        if !status.system_proxy.desired {
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
    Ok(())
}

async fn wait_for_candidate(
    runtime: &MishRuntime,
    source: &ControllerStatusSource,
    timeout_after: Duration,
    cancellation: CancellationToken,
) -> Result<(), MihomoActivationError> {
    let deadline = Instant::now() + timeout_after;
    loop {
        match source.initial_observation() {
            ControllerInitialObservation::Ready => return Ok(()),
            ControllerInitialObservation::VersionMismatch => {
                return Err(MihomoActivationError::VersionMismatch);
            }
            ControllerInitialObservation::InvalidSnapshot => {
                return Err(MihomoActivationError::ControllerFailure);
            }
            ControllerInitialObservation::Pending => {}
        }
        if !matches!(runtime.core_status().await.phase, CorePhase::Running) {
            return Err(MihomoActivationError::EarlyExit);
        }
        if Instant::now() >= deadline {
            return Err(MihomoActivationError::ReadinessTimeout);
        }
        tokio::select! {
            _ = cancellation.cancelled() => return Err(MihomoActivationError::Cancelled),
            _ = tokio::time::sleep(Duration::from_millis(20)) => {}
        }
    }
}

async fn rollback_candidate(candidate: ActiveMihomo) {
    candidate.source.close().await;
    let _ = candidate.runtime.stop_core().await;
}

fn record_failed_attempt(
    state: &mut ManagedActivationState,
    record: &ProfileRecord,
    error: MihomoActivationError,
) {
    state.last_attempt = Some(ActivationAttempt {
        attempted_at_unix_milliseconds: now_unix_milliseconds(),
        failure: Some(error.failure_kind()),
        fingerprint: record.metadata.artifact.fingerprint.as_str().to_owned(),
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
            Self::VersionMismatch => ActivationFailureKind::VersionMismatch,
            Self::ControllerFailure => ActivationFailureKind::Controller,
            Self::ReadinessTimeout => ActivationFailureKind::Timeout,
            Self::Cancelled => ActivationFailureKind::Cancelled,
            Self::CaptureFailed => ActivationFailureKind::Capture,
            Self::PriorStopFailed => ActivationFailureKind::PriorStop,
            Self::StateCommitFailed | Self::RollbackFailedSafeStopped | Self::ShutdownFailed => {
                ActivationFailureKind::StateCommit
            }
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
        })
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
}

pub struct RuntimeConfigGenerator;

pub struct GeneratedRuntimeConfig {
    pub bytes: Vec<u8>,
    pub classifications: Vec<PolicyClassification>,
}

impl RuntimeConfigGenerator {
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
