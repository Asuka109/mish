//! Test-only Internal TUN maintenance adapter for the shared `SimulatedHost` model.
//!
//! This module deliberately drives the production package and Helper lifecycle machines. It
//! replaces only privileged filesystem/service/process/network effects with closed synthetic
//! observations. Private key material exists only in a temporary test directory and is never
//! projected into the scenario model, semantic transcript, or a fixture.

use std::{
    fs,
    future::Future,
    os::unix::fs::PermissionsExt,
    path::PathBuf,
    pin::Pin,
    sync::{Arc, Mutex, Weak},
};

use base64::{Engine as _, engine::general_purpose::STANDARD as BASE64};
use futures_util::future::BoxFuture;
use mish_bridge::{
    ActivationTiming, DesktopRuntimeHost, ManagedMihomoResolver, ManagedRuntimePolicy,
    MihomoActivationManager, ProfileActivationCoordinator, ReqwestHttpsSourceReader,
};
use mish_platform_macos::{
    DEV_TUN_CLIENT_KEY_FILE_NAME, DEV_TUN_INSTALLATION_KEY_ALGORITHM,
    DEV_TUN_INSTALLATION_KEY_RECORD_VERSION, DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION,
    DEV_TUN_PENDING_CLIENT_KEY_FILE_NAME, InstallationClientKeyStore,
    InstallationEnrollmentOperation, InstallationKeyRotationRequest,
    apply_installation_enrollment_operation, canonical_rotation_transcript,
    load_installation_enrollment_for_user, remove_installation_enrollment,
};
use mish_platform_macos::{
    internal_tun_maintenance::{
        ArtifactDigestSet, CompensationState, EnrollmentTransition,
        INTERNAL_TUN_MAINTENANCE_JOURNAL_SCHEMA_VERSION, InternalTunMaintenanceJournal,
        MaintenanceArtifactEvidence, MaintenanceCaptureEvidence, MaintenanceCommitPoint,
        MaintenanceCompensation, MaintenanceIdentityEvidence, MaintenanceIntent, MaintenanceKind,
        MaintenanceTerminal, MaintenanceTerminalOutcome, RecoveryDecision, RecoveryObservation,
        compare_internal_tun_package_versions, decide_recovery,
    },
    internal_tun_package_machine::{
        ObservedPackageState, PackageEffect, PackageEffectOutcome, PackageFailure, PackageInput,
        PackageMachine, PackageOperation, PackageOperationKind, PackageProjection, PackageState,
        PackageSuccess,
    },
};
use mish_runtime::{
    CaptureJournalStore, CapturePlatform, CaptureReconciler, CaptureRequest, CaptureSelection,
    CoreRuntime, LoopbackProxyEndpoint, MishRuntime, StatusAdapterKind, TunHelperAvailability,
    TunHelperController, TunHelperError, TunHelperFailureKind, TunHelperHealth,
    TunHelperLifecycleOperation, TunHelperObservation, TunHelperPlatform,
    TunHelperRemovalCapability, TunHelperSnapshot, TunNetworkObservation,
    TunObservationComponentState, tun_observation_now,
};
use mish_settings::{
    FileSettingsRepository, SettingsAvailability, SettingsCapabilities, SettingsService,
};
use mish_state_authority::StateMutationAuthority;
use mish_state_machine::{
    CorrelatedEffect, Correlation, Disposition, EffectExecutor, RunnerConfig, RunnerHandle,
    TransitionObserver, spawn_runner,
};
use p256::{
    ecdsa::{Signature, SigningKey, signature::Signer},
    pkcs8::{EncodePrivateKey, EncodePublicKey},
};
use rand_core::OsRng;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tempfile::TempDir;
use thiserror::Error;
use tokio::sync::{Mutex as AsyncMutex, watch};
use tokio_util::sync::CancellationToken;

use crate::{
    EffectKind, EffectResultKind, ManagedEndpointOwner, SimulatedCorePhase, SimulatedHost,
    SimulatedHostFailure, SimulatedHostScenario,
};

const SYNTHETIC_UID: u32 = 501;
const MAINTENANCE_SERVICE_LABEL: &str = "com.asuka109.mish.tun-helper.dev";
const SYNTHETIC_OPERATION_PREFIX: &str = "maintenance-op-";
const MAX_MAINTENANCE_FAULT_OCCURRENCE: u8 = 16;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticPackageVersion {
    V1,
    V2,
}

impl SyntheticPackageVersion {
    fn package_version(self) -> &'static str {
        match self {
            Self::V1 => "0.1.0-internal-tun-alpha.5",
            Self::V2 => "0.1.0-internal-tun-alpha.7",
        }
    }

    fn installation_id(self) -> String {
        match self {
            Self::V1 => digest('1'),
            Self::V2 => digest('2'),
        }
    }

    fn artifacts(self) -> ArtifactDigestSet {
        let value = match self {
            Self::V1 => 'a',
            Self::V2 => 'b',
        };
        ArtifactDigestSet {
            application_sha256: digest(value),
            core_sha256: digest(next_hex(value)),
            helper_sha256: digest(next_hex(next_hex(value))),
            manifest_sha256: digest(next_hex(next_hex(next_hex(value)))),
            package_version: self.package_version().into(),
            plist_sha256: digest(next_hex(next_hex(next_hex(next_hex(value))))),
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticMaintenanceInitial {
    Absent,
    HealthyV1,
    HealthyV2,
    RepairRequired,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticOwnership {
    Absent,
    Mish,
    Partial,
    Unrelated,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MaintenanceFaultKind {
    AdministratorCancelled,
    CleanupFailure,
    CoreExited,
    CorruptArtifact,
    DiskFull,
    InterruptedCopy,
    Panic,
    PermissionDenied,
    ProcessTerminated,
    ReplacedArtifact,
    StaleCompletion,
}

/// A deliberate completion supplied to the real package runner while a stage effect is live.
/// This stays inside the simulator package so tests can verify runner correlation behavior
/// without reproducing the package machine's transition logic.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MaintenanceCompletionInjection {
    EqualStage,
    StaleStage,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceFault {
    pub at: MaintenanceCommitPoint,
    pub kind: MaintenanceFaultKind,
    /// Inject this fault only on the bounded Nth visit to the commit point.
    #[serde(default = "default_fault_occurrence")]
    pub occurrence: u8,
}

impl<'de> Deserialize<'de> for MaintenanceFault {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct WireMaintenanceFault {
            at: MaintenanceCommitPoint,
            kind: MaintenanceFaultKind,
            #[serde(default = "default_fault_occurrence")]
            occurrence: u8,
        }

        let wire = WireMaintenanceFault::deserialize(deserializer)?;
        if wire.occurrence == 0 || wire.occurrence > MAX_MAINTENANCE_FAULT_OCCURRENCE {
            return Err(serde::de::Error::custom(
                "maintenance fault occurrence is outside its bounded range",
            ));
        }
        Ok(Self {
            at: wire.at,
            kind: wire.kind,
            occurrence: wire.occurrence,
        })
    }
}

fn default_fault_occurrence() -> u8 {
    1
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceScenario {
    #[serde(default)]
    pub faults: Vec<MaintenanceFault>,
    pub initial: SyntheticMaintenanceInitial,
    #[serde(default)]
    pub pause_at: Option<MaintenanceCommitPoint>,
    #[serde(default)]
    pub pause_until: Option<u64>,
    pub target: SyntheticPackageVersion,
}

impl<'de> Deserialize<'de> for MaintenanceScenario {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        struct WireMaintenanceScenario {
            #[serde(default)]
            faults: Vec<MaintenanceFault>,
            initial: SyntheticMaintenanceInitial,
            #[serde(default)]
            pause_at: Option<MaintenanceCommitPoint>,
            #[serde(default)]
            pause_until: Option<u64>,
            target: SyntheticPackageVersion,
        }

        let wire = WireMaintenanceScenario::deserialize(deserializer)?;
        let scenario = Self {
            faults: wire.faults,
            initial: wire.initial,
            pause_at: wire.pause_at,
            pause_until: wire.pause_until,
            target: wire.target,
        };
        scenario
            .validate()
            .map_err(|_| serde::de::Error::custom("invalid bounded maintenance scenario"))?;
        Ok(scenario)
    }
}

impl MaintenanceScenario {
    pub fn absent() -> Self {
        Self {
            faults: Vec::new(),
            initial: SyntheticMaintenanceInitial::Absent,
            pause_at: None,
            pause_until: None,
            target: SyntheticPackageVersion::V1,
        }
    }

    pub fn healthy_v1() -> Self {
        Self {
            faults: Vec::new(),
            initial: SyntheticMaintenanceInitial::HealthyV1,
            pause_at: None,
            pause_until: None,
            target: SyntheticPackageVersion::V2,
        }
    }

    fn validate(&self) -> Result<(), MaintenanceHarnessError> {
        if self.faults.len() > 16 || self.pause_at.is_some() != self.pause_until.is_some() {
            return Err(MaintenanceHarnessError::InvalidScenario);
        }
        if self.faults.iter().any(|fault| {
            fault.occurrence == 0 || fault.occurrence > MAX_MAINTENANCE_FAULT_OCCURRENCE
        }) {
            return Err(MaintenanceHarnessError::InvalidScenario);
        }
        for (index, fault) in self.faults.iter().enumerate() {
            if self.faults[..index]
                .iter()
                .any(|previous| previous.at == fault.at && previous.occurrence == fault.occurrence)
            {
                return Err(MaintenanceHarnessError::InvalidScenario);
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyntheticArtifactIdentity {
    pub application_sha256: String,
    pub core_sha256: String,
    pub helper_sha256: String,
    pub manifest_sha256: String,
    pub package_version: String,
    pub plist_sha256: String,
}

impl From<&ArtifactDigestSet> for SyntheticArtifactIdentity {
    fn from(value: &ArtifactDigestSet) -> Self {
        Self {
            application_sha256: value.application_sha256.clone(),
            core_sha256: value.core_sha256.clone(),
            helper_sha256: value.helper_sha256.clone(),
            manifest_sha256: value.manifest_sha256.clone(),
            package_version: value.package_version.clone(),
            plist_sha256: value.plist_sha256.clone(),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyntheticUnrelatedState {
    pub dns: SyntheticOwnership,
    pub filesystem: SyntheticOwnership,
    pub key: SyntheticOwnership,
    pub process: SyntheticOwnership,
    pub route: SyntheticOwnership,
    pub service: SyntheticOwnership,
}

impl SyntheticUnrelatedState {
    fn present() -> Self {
        Self {
            dns: SyntheticOwnership::Unrelated,
            filesystem: SyntheticOwnership::Unrelated,
            key: SyntheticOwnership::Unrelated,
            process: SyntheticOwnership::Unrelated,
            route: SyntheticOwnership::Unrelated,
            service: SyntheticOwnership::Unrelated,
        }
    }
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum SyntheticPackageProjection {
    Absent,
    HealthyDisabled,
    InFlight,
    RecoveryRequired,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MaintenanceObservation {
    pub active_operation: Option<u64>,
    pub artifacts: Option<SyntheticArtifactIdentity>,
    pub capture_restore_pending: bool,
    pub core_process: SyntheticOwnership,
    pub dns: SyntheticOwnership,
    pub enrollment_generation: Option<u64>,
    pub filesystem: SyntheticOwnership,
    pub helper_process: SyntheticOwnership,
    pub installation_id: Option<String>,
    pub journal_commit_point: Option<MaintenanceCommitPoint>,
    pub journal_present: bool,
    pub key_id: Option<String>,
    pub package: SyntheticPackageProjection,
    pub recovery_required: bool,
    pub route: SyntheticOwnership,
    pub service: SyntheticOwnership,
    pub socket: SyntheticOwnership,
    pub socket_generation: u64,
    pub tun: SyntheticOwnership,
    pub unrelated: SyntheticUnrelatedState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SyntheticInstallation {
    artifacts: ArtifactDigestSet,
    generation: u64,
    installation_id: String,
    key_id: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SyntheticClientKeyRecord {
    algorithm: String,
    key_id: String,
    private_key_pkcs8: String,
    public_key_spki: String,
    schema_version: u16,
}

impl SyntheticInstallation {
    fn success(&self) -> PackageSuccess {
        PackageSuccess {
            generation: self.generation,
            installation_id: self.installation_id.clone(),
            key_id: self.key_id.clone(),
        }
    }
}

pub(crate) struct MaintenanceModel {
    active_operation: Option<u64>,
    backup: Option<SyntheticInstallation>,
    capture_before_handoff: Option<TunNetworkObservation>,
    capture_restore_pending: bool,
    core_process: SyntheticOwnership,
    fault_occurrences: Vec<(MaintenanceCommitPoint, u16)>,
    dns: SyntheticOwnership,
    enrollment_generation: Option<u64>,
    filesystem: SyntheticOwnership,
    helper_process: SyntheticOwnership,
    installed: Option<SyntheticInstallation>,
    journal: Option<InternalTunMaintenanceJournal>,
    last_verified: Option<SyntheticInstallation>,
    next_operation_id: u64,
    package: SyntheticPackageProjection,
    recovery_required: bool,
    route: SyntheticOwnership,
    service: SyntheticOwnership,
    socket: SyntheticOwnership,
    socket_generation: u64,
    tun: SyntheticOwnership,
    tun_mutation_failure: Option<TunHelperFailureKind>,
    unrelated: SyntheticUnrelatedState,
}

impl MaintenanceModel {
    pub(crate) fn observation(&self) -> MaintenanceObservation {
        MaintenanceObservation {
            active_operation: self.active_operation,
            artifacts: self
                .installed
                .as_ref()
                .map(|installation| SyntheticArtifactIdentity::from(&installation.artifacts)),
            capture_restore_pending: self.capture_restore_pending,
            core_process: self.core_process,
            dns: self.dns,
            enrollment_generation: self.enrollment_generation,
            filesystem: self.filesystem,
            helper_process: self.helper_process,
            installation_id: self
                .installed
                .as_ref()
                .map(|installation| installation.installation_id.clone()),
            journal_commit_point: self.journal.as_ref().map(|journal| journal.commit_point),
            journal_present: self.journal.is_some(),
            key_id: self
                .installed
                .as_ref()
                .map(|installation| installation.key_id.clone()),
            package: self.package,
            recovery_required: self.recovery_required,
            route: self.route,
            service: self.service,
            socket: self.socket,
            socket_generation: self.socket_generation,
            tun: self.tun,
            unrelated: self.unrelated.clone(),
        }
    }

    fn observed_package_state(&self) -> ObservedPackageState {
        match self.package {
            SyntheticPackageProjection::Absent => ObservedPackageState::Absent,
            SyntheticPackageProjection::HealthyDisabled => ObservedPackageState::HealthyDisabled,
            SyntheticPackageProjection::InFlight | SyntheticPackageProjection::RecoveryRequired => {
                ObservedPackageState::RepairRequired
            }
        }
    }

    fn network_observation(&self) -> TunNetworkObservation {
        TunNetworkObservation::new(
            component(self.core_process),
            component(self.tun),
            component(self.route),
            component(self.dns),
            tun_observation_now(),
        )
    }
}

#[derive(Debug, Error)]
pub enum MaintenanceHarnessError {
    #[error("the maintenance scenario is invalid")]
    InvalidScenario,
    #[error("the simulated maintenance host is unavailable")]
    HostUnavailable,
    #[error("the maintenance operation is already active")]
    Busy,
    #[error("the maintenance operation has no terminal projection")]
    MissingTerminal,
    #[error("the maintenance state is unavailable")]
    StateUnavailable,
    #[error("the maintenance transaction was rejected: {0}")]
    Rejected(String),
}

pub struct MaintenanceEngine {
    active_runner: Mutex<Option<RunnerHandle<PackageMachine>>>,
    client_keys: InstallationClientKeyStore,
    configuration: Mutex<MaintenanceScenario>,
    credential_backup_root: PathBuf,
    credentials_backed_up: Mutex<bool>,
    enrollment_path: PathBuf,
    host: Weak<SimulatedHost>,
    operation: AsyncMutex<()>,
    runtime_root: PathBuf,
    self_ref: Weak<MaintenanceEngine>,
    state_root: TempDir,
}

impl MaintenanceEngine {
    fn new(
        host: Weak<SimulatedHost>,
        configuration: MaintenanceScenario,
    ) -> Result<Arc<Self>, MaintenanceHarnessError> {
        configuration.validate()?;
        let state_root =
            tempfile::tempdir().map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        fs::set_permissions(state_root.path(), fs::Permissions::from_mode(0o700))
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        let runtime_root = state_root.path().join("runtime");
        let enrollment_directory = state_root.path().join("enrollment");
        fs::create_dir(&runtime_root).map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        fs::set_permissions(&runtime_root, fs::Permissions::from_mode(0o700))
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        fs::create_dir(&enrollment_directory)
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        fs::set_permissions(&enrollment_directory, fs::Permissions::from_mode(0o700))
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        let credential_backup_root = state_root.path().join("credential-backup");
        fs::create_dir(&credential_backup_root)
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        fs::set_permissions(&credential_backup_root, fs::Permissions::from_mode(0o700))
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        let client_keys = InstallationClientKeyStore::for_runtime_root(&runtime_root, uid());
        let engine = Arc::new_cyclic(|self_ref| Self {
            active_runner: Mutex::new(None),
            client_keys,
            configuration: Mutex::new(configuration.clone()),
            credential_backup_root,
            credentials_backed_up: Mutex::new(false),
            enrollment_path: enrollment_directory.join("enrollment.json"),
            host,
            operation: AsyncMutex::new(()),
            runtime_root,
            self_ref: self_ref.clone(),
            state_root,
        });
        engine.initialize(configuration.initial)?;
        Ok(engine)
    }

    fn initialize(
        &self,
        initial: SyntheticMaintenanceInitial,
    ) -> Result<(), MaintenanceHarnessError> {
        let host = self.host()?;
        let mut model = host.model.lock().expect("simulated host lock poisoned");
        let mut maintenance = MaintenanceModel {
            active_operation: None,
            backup: None,
            capture_before_handoff: None,
            capture_restore_pending: false,
            core_process: SyntheticOwnership::Absent,
            fault_occurrences: Vec::new(),
            dns: SyntheticOwnership::Absent,
            enrollment_generation: None,
            filesystem: SyntheticOwnership::Absent,
            helper_process: SyntheticOwnership::Absent,
            installed: None,
            journal: None,
            last_verified: None,
            next_operation_id: 1,
            package: SyntheticPackageProjection::Absent,
            recovery_required: false,
            route: SyntheticOwnership::Absent,
            service: SyntheticOwnership::Absent,
            socket: SyntheticOwnership::Absent,
            socket_generation: 0,
            tun: SyntheticOwnership::Absent,
            tun_mutation_failure: None,
            unrelated: SyntheticUnrelatedState::present(),
        };
        match initial {
            SyntheticMaintenanceInitial::Absent => {}
            SyntheticMaintenanceInitial::HealthyV1 | SyntheticMaintenanceInitial::HealthyV2 => {
                let version = if initial == SyntheticMaintenanceInitial::HealthyV1 {
                    SyntheticPackageVersion::V1
                } else {
                    SyntheticPackageVersion::V2
                };
                let candidate = self.enroll_candidate(version.installation_id())?;
                let enrollment =
                    load_installation_enrollment_for_user(&self.enrollment_path, uid(), false)
                        .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
                let installation = SyntheticInstallation {
                    artifacts: version.artifacts(),
                    generation: enrollment.generation,
                    installation_id: version.installation_id(),
                    key_id: candidate.key_id,
                };
                maintenance.installed = Some(installation.clone());
                maintenance.last_verified = Some(installation);
                maintenance.enrollment_generation = Some(enrollment.generation);
                maintenance.filesystem = SyntheticOwnership::Mish;
                maintenance.helper_process = SyntheticOwnership::Mish;
                maintenance.service = SyntheticOwnership::Mish;
                maintenance.socket = SyntheticOwnership::Mish;
                maintenance.socket_generation = 1;
                maintenance.package = SyntheticPackageProjection::HealthyDisabled;
                maintenance.core_process = SyntheticOwnership::Mish;
                maintenance.dns = SyntheticOwnership::Mish;
                maintenance.route = SyntheticOwnership::Mish;
                maintenance.tun = SyntheticOwnership::Mish;
                model.core_phase = SimulatedCorePhase::Running;
                model.endpoint_owner = ManagedEndpointOwner::Mish;
            }
            SyntheticMaintenanceInitial::RepairRequired => {
                maintenance.filesystem = SyntheticOwnership::Mish;
                maintenance.package = SyntheticPackageProjection::RecoveryRequired;
                maintenance.recovery_required = true;
            }
        }
        model.maintenance = Some(maintenance);
        Ok(())
    }

    fn host(&self) -> Result<Arc<SimulatedHost>, MaintenanceHarnessError> {
        self.host
            .upgrade()
            .ok_or(MaintenanceHarnessError::HostUnavailable)
    }

    pub fn configure(
        &self,
        target: SyntheticPackageVersion,
        faults: Vec<MaintenanceFault>,
    ) -> Result<(), MaintenanceHarnessError> {
        {
            let mut configuration = self
                .configuration
                .lock()
                .expect("maintenance configuration lock poisoned");
            let next = MaintenanceScenario {
                faults,
                initial: configuration.initial,
                pause_at: configuration.pause_at,
                pause_until: configuration.pause_until,
                target,
            };
            next.validate()?;
            *configuration = next;
        }
        if let Ok(host) = self.host() {
            let mut model = host.model.lock().expect("simulated host lock poisoned");
            if let Some(maintenance) = model.maintenance.as_mut() {
                maintenance.fault_occurrences.clear();
            }
        }
        Ok(())
    }

    pub fn pause_at(
        &self,
        point: MaintenanceCommitPoint,
        logical_time: u64,
    ) -> Result<(), MaintenanceHarnessError> {
        let mut configuration = self
            .configuration
            .lock()
            .expect("maintenance configuration lock poisoned");
        configuration.pause_at = Some(point);
        configuration.pause_until = Some(logical_time);
        configuration.validate()
    }

    pub fn clear_pause(&self) {
        let mut configuration = self
            .configuration
            .lock()
            .expect("maintenance configuration lock poisoned");
        configuration.pause_at = None;
        configuration.pause_until = None;
    }

    pub fn journal_snapshot(&self) -> Option<InternalTunMaintenanceJournal> {
        self.host().ok().and_then(|host| {
            host.model
                .lock()
                .expect("simulated host lock poisoned")
                .maintenance
                .as_ref()
                .and_then(|maintenance| maintenance.journal.clone())
        })
    }

    pub fn observation(&self) -> Option<MaintenanceObservation> {
        self.host()
            .ok()
            .and_then(|host| host.maintenance_observation())
    }

    pub fn set_network_ownership(
        &self,
        core: SyntheticOwnership,
        tun: SyntheticOwnership,
        route: SyntheticOwnership,
        dns: SyntheticOwnership,
    ) -> Result<(), MaintenanceHarnessError> {
        let host = self.host()?;
        let mut model = host.model.lock().expect("simulated host lock poisoned");
        let maintenance = model
            .maintenance
            .as_mut()
            .ok_or(MaintenanceHarnessError::StateUnavailable)?;
        maintenance.core_process = core;
        maintenance.tun = tun;
        maintenance.route = route;
        maintenance.dns = dns;
        Ok(())
    }

    pub fn fail_next_tun_mutation(
        &self,
        failure: TunHelperFailureKind,
    ) -> Result<(), MaintenanceHarnessError> {
        let host = self.host()?;
        let mut model = host.model.lock().expect("simulated host lock poisoned");
        let maintenance = model
            .maintenance
            .as_mut()
            .ok_or(MaintenanceHarnessError::StateUnavailable)?;
        maintenance.tun_mutation_failure = Some(failure);
        Ok(())
    }

    pub async fn abort_active(&self) {
        let runner = self
            .active_runner
            .lock()
            .expect("maintenance active runner lock poisoned")
            .clone();
        if let Some(runner) = runner {
            let _ = runner.shutdown().await;
        }
    }

    /// Injects a completion through the live runner rather than reducing the package machine in
    /// test code. Callers pause the stage effect first so the injected input is admitted while
    /// that effect remains owned by the runner.
    pub async fn inject_stage_completion(
        &self,
        injection: MaintenanceCompletionInjection,
    ) -> Result<Disposition, MaintenanceHarnessError> {
        let runner = self
            .active_runner
            .lock()
            .expect("maintenance active runner lock poisoned")
            .clone()
            .ok_or(MaintenanceHarnessError::StateUnavailable)?;
        let (operation_id, admitted_revision) = {
            let host = self.host()?;
            let model = host.model.lock().expect("simulated host lock poisoned");
            let operation_id = model
                .maintenance
                .as_ref()
                .and_then(|maintenance| maintenance.active_operation)
                .ok_or(MaintenanceHarnessError::StateUnavailable)?;
            (operation_id, operation_id)
        };
        let mut correlation = Correlation {
            machine_authority: "simulated-internal-tun-package".into(),
            scope_epoch: 1,
            operation_id: format!("{SYNTHETIC_OPERATION_PREFIX}{operation_id}"),
            admitted_revision,
            effect_id: 1,
        };
        if injection == MaintenanceCompletionInjection::StaleStage {
            correlation.scope_epoch = correlation.scope_epoch.saturating_add(1);
        }
        runner
            .admit(PackageInput::EffectCompleted {
                correlation,
                outcome: PackageEffectOutcome::Staged,
            })
            .await
            .map(|admission| admission.disposition)
            .map_err(|_| MaintenanceHarnessError::Busy)
    }

    async fn run_lifecycle(
        &self,
        operation: TunHelperLifecycleOperation,
    ) -> Result<(), TunHelperError> {
        let kind = match operation {
            TunHelperLifecycleOperation::Install => PackageOperationKind::Install,
            TunHelperLifecycleOperation::Repair => PackageOperationKind::Repair,
            TunHelperLifecycleOperation::Remove => PackageOperationKind::Uninstall,
        };
        self.run_package_operation(kind)
            .await
            .map(|_| ())
            .map_err(|error| helper_error(&error))
    }

    pub async fn run_package_operation(
        &self,
        kind: PackageOperationKind,
    ) -> Result<MaintenanceTerminalOutcome, MaintenanceHarnessError> {
        let _operation = self
            .operation
            .try_lock()
            .map_err(|_| MaintenanceHarnessError::Busy)?;
        let host = self.host()?;
        let configuration = self
            .configuration
            .lock()
            .expect("maintenance configuration lock poisoned")
            .clone();
        let (operation_id, admitted_revision, observed, target, identical, downgrade) = {
            let mut model = host.model.lock().expect("simulated host lock poisoned");
            let maintenance = model
                .maintenance
                .as_mut()
                .ok_or(MaintenanceHarnessError::StateUnavailable)?;
            let operation_id = maintenance.next_operation_id;
            maintenance.next_operation_id = maintenance.next_operation_id.saturating_add(1);
            maintenance.active_operation = Some(operation_id);
            let admitted_revision = operation_id;
            let observed = maintenance.observed_package_state();
            let installed = maintenance.installed.as_ref();
            let identical = kind != PackageOperationKind::Uninstall
                && installed.is_some_and(|installed| {
                    compare_internal_tun_package_versions(
                        configuration.target.package_version(),
                        &installed.artifacts.package_version,
                    )
                    .is_ok_and(|order| order.is_eq())
                        && installed.artifacts == configuration.target.artifacts()
                });
            let downgrade = kind != PackageOperationKind::Uninstall
                && installed.is_some_and(|installed| {
                    compare_internal_tun_package_versions(
                        configuration.target.package_version(),
                        &installed.artifacts.package_version,
                    )
                    .is_ok_and(|order| order.is_lt())
                });
            (
                operation_id,
                admitted_revision,
                observed,
                configuration.target,
                identical,
                downgrade,
            )
        };

        if downgrade {
            self.reject_terminal(
                operation_id,
                admitted_revision,
                kind,
                target,
                "maintenance-downgrade-rejected",
            )?;
            return Err(MaintenanceHarnessError::Rejected(
                "maintenance-downgrade-rejected".into(),
            ));
        }
        if identical {
            self.complete_identical(operation_id, admitted_revision, kind, target)?;
            return Ok(MaintenanceTerminalOutcome::Identical);
        }

        let initial = PackageState::initial(observed);
        let (projection, mut projection_rx) = watch::channel(initial.projection());
        let runner = spawn_runner(
            Arc::new(PackageMachine),
            initial,
            Arc::new(MaintenanceExecutor {
                engine: self.self_ref.clone(),
                kind,
                operation_id,
                admitted_revision,
                target,
            }),
            Arc::new(MaintenanceObserver {
                engine: self.self_ref.clone(),
                projection,
            }),
            RunnerConfig::default(),
        );
        *self
            .active_runner
            .lock()
            .expect("maintenance active runner lock poisoned") = Some(runner.clone());
        let operation = PackageOperation {
            correlation: Correlation {
                machine_authority: "simulated-internal-tun-package".into(),
                scope_epoch: 1,
                operation_id: format!("{SYNTHETIC_OPERATION_PREFIX}{operation_id}"),
                admitted_revision,
                effect_id: 0,
            },
            initial: observed,
            kind,
        };
        runner
            .admit(PackageInput::Begin(operation))
            .await
            .map_err(|_| MaintenanceHarnessError::Busy)?;
        let terminal = wait_for_terminal(&mut projection_rx).await;
        let _ = runner.shutdown().await;
        *self
            .active_runner
            .lock()
            .expect("maintenance active runner lock poisoned") = None;
        match terminal {
            PackageProjection::HealthyDisabled(_) => Ok(MaintenanceTerminalOutcome::Committed),
            PackageProjection::Absent => Ok(MaintenanceTerminalOutcome::Uninstalled),
            PackageProjection::Failed(failure) => {
                Err(MaintenanceHarnessError::Rejected(failure.code))
            }
            PackageProjection::Retired | PackageProjection::InFlight { .. } => {
                Err(MaintenanceHarnessError::MissingTerminal)
            }
        }
    }

    fn complete_identical(
        &self,
        operation_id: u64,
        admitted_revision: u64,
        kind: PackageOperationKind,
        target: SyntheticPackageVersion,
    ) -> Result<(), MaintenanceHarnessError> {
        let host = self.host()?;
        host.emit_maintenance(
            EffectKind::MaintenanceObserve,
            EffectResultKind::Observed,
            operation_id,
            admitted_revision,
        )
        .map_err(host_failure)?;
        let mut model = host.model.lock().expect("simulated host lock poisoned");
        let maintenance = model
            .maintenance
            .as_mut()
            .ok_or(MaintenanceHarnessError::StateUnavailable)?;
        let mut journal =
            self.journal_for(maintenance, operation_id, admitted_revision, kind, target)?;
        journal.commit_point = MaintenanceCommitPoint::Verified;
        journal.terminal = Some(MaintenanceTerminal {
            code: "identical-reinstall".into(),
            outcome: MaintenanceTerminalOutcome::Identical,
        });
        journal
            .validate()
            .map_err(|error| MaintenanceHarnessError::Rejected(error.into()))?;
        maintenance.journal = Some(journal);
        maintenance.package = SyntheticPackageProjection::HealthyDisabled;
        maintenance.active_operation = None;
        Ok(())
    }

    fn reject_terminal(
        &self,
        operation_id: u64,
        admitted_revision: u64,
        kind: PackageOperationKind,
        target: SyntheticPackageVersion,
        code: &str,
    ) -> Result<(), MaintenanceHarnessError> {
        let host = self.host()?;
        host.emit_maintenance(
            EffectKind::MaintenanceObserve,
            EffectResultKind::Rejected,
            operation_id,
            admitted_revision,
        )
        .map_err(host_failure)?;
        let mut model = host.model.lock().expect("simulated host lock poisoned");
        let maintenance = model
            .maintenance
            .as_mut()
            .ok_or(MaintenanceHarnessError::StateUnavailable)?;
        let mut journal =
            self.journal_for(maintenance, operation_id, admitted_revision, kind, target)?;
        journal.commit_point = MaintenanceCommitPoint::Verified;
        journal.terminal = Some(MaintenanceTerminal {
            code: code.into(),
            outcome: MaintenanceTerminalOutcome::Rejected,
        });
        journal
            .validate()
            .map_err(|error| MaintenanceHarnessError::Rejected(error.into()))?;
        maintenance.journal = Some(journal);
        maintenance.active_operation = None;
        Ok(())
    }

    async fn execute_effect(
        &self,
        effect: PackageEffect,
        kind: PackageOperationKind,
        operation_id: u64,
        admitted_revision: u64,
        target: SyntheticPackageVersion,
        cancellation: CancellationToken,
    ) -> PackageEffectOutcome {
        let correlation = effect.correlation().clone();
        let result = match effect {
            PackageEffect::Stage { .. } => {
                self.stage(operation_id, admitted_revision, kind, target, cancellation)
                    .await
            }
            PackageEffect::Authorize { .. } => {
                self.authorize(operation_id, admitted_revision, kind, target)
                    .await
            }
            PackageEffect::CommitReceipt { .. } => {
                self.commit_receipt(operation_id, admitted_revision)
            }
            PackageEffect::AwaitReady { .. } => self.start_service(operation_id, admitted_revision),
            PackageEffect::Verify { .. } => self.verify(operation_id, admitted_revision),
            PackageEffect::Rollback { .. } => self.rollback(operation_id, admitted_revision),
            PackageEffect::FinalizeUninstall { .. } => {
                self.finalize_uninstall(operation_id, admitted_revision)
            }
        };
        match result {
            Ok(outcome) => PackageInput::EffectCompleted {
                correlation,
                outcome,
            },
            Err(error) => PackageInput::EffectCompleted {
                correlation,
                outcome: PackageEffectOutcome::Failed(package_failure(error)),
            },
        }
        .into_effect_outcome()
    }

    async fn stage(
        &self,
        operation_id: u64,
        admitted_revision: u64,
        kind: PackageOperationKind,
        target: SyntheticPackageVersion,
        cancellation: CancellationToken,
    ) -> Result<PackageEffectOutcome, String> {
        let host = self.host().map_err(display_error)?;
        self.snapshot_credential_backup().map_err(display_error)?;
        self.with_maintenance(&host, |maintenance| {
            let journal = self
                .journal_for(maintenance, operation_id, admitted_revision, kind, target)
                .map_err(display_error)?;
            maintenance.journal = Some(journal);
            maintenance.package = SyntheticPackageProjection::InFlight;
            Ok(())
        })?;
        self.advance_journal(
            &host,
            MaintenanceCommitPoint::IntentPersisted,
            EffectKind::MaintenanceJournalPersist,
            operation_id,
            admitted_revision,
            &cancellation,
        )
        .await?;
        self.reconcile_capture(&host, operation_id, admitted_revision)
            .await?;
        self.advance_journal(
            &host,
            MaintenanceCommitPoint::CaptureReconciled,
            EffectKind::MaintenanceJournalPersist,
            operation_id,
            admitted_revision,
            &cancellation,
        )
        .await?;
        self.with_maintenance(&host, |maintenance| {
            maintenance.backup = maintenance.installed.clone();
            Ok(())
        })?;
        self.advance_journal(
            &host,
            MaintenanceCommitPoint::PriorArtifactsBackedUp,
            EffectKind::MaintenanceBackupArtifacts,
            operation_id,
            admitted_revision,
            &cancellation,
        )
        .await?;
        Ok(PackageEffectOutcome::Staged)
    }

    async fn authorize(
        &self,
        operation_id: u64,
        admitted_revision: u64,
        kind: PackageOperationKind,
        target: SyntheticPackageVersion,
    ) -> Result<PackageEffectOutcome, String> {
        let host = self.host().map_err(display_error)?;
        self.ensure_maintenance_authority(&host)?;
        self.emit(
            &host,
            EffectKind::MaintenanceAuthorize,
            EffectResultKind::Authorized,
            operation_id,
            admitted_revision,
        )?;
        self.with_maintenance(&host, |maintenance| {
            maintenance.service = SyntheticOwnership::Absent;
            maintenance.helper_process = SyntheticOwnership::Absent;
            maintenance.core_process = SyntheticOwnership::Absent;
            maintenance.socket = SyntheticOwnership::Absent;
            maintenance.tun = SyntheticOwnership::Absent;
            maintenance.route = SyntheticOwnership::Absent;
            maintenance.dns = SyntheticOwnership::Absent;
            Ok(())
        })?;
        {
            let mut model = host.model.lock().expect("simulated host lock poisoned");
            model.core_phase = SimulatedCorePhase::Stopped;
            if model.endpoint_owner == ManagedEndpointOwner::Mish {
                model.endpoint_owner = ManagedEndpointOwner::Free;
            }
        }
        self.commit_point(
            &host,
            MaintenanceCommitPoint::PriorServiceDetached,
            EffectKind::MaintenanceCommitService,
            operation_id,
            admitted_revision,
        )?;
        if kind == PackageOperationKind::Uninstall {
            return Ok(PackageEffectOutcome::Authorized);
        }
        self.with_maintenance(&host, |maintenance| {
            maintenance.filesystem = SyntheticOwnership::Mish;
            Ok(())
        })?;
        self.commit_point(
            &host,
            MaintenanceCommitPoint::HelperReplaced,
            EffectKind::MaintenanceStageArtifacts,
            operation_id,
            admitted_revision,
        )?;
        self.commit_point(
            &host,
            MaintenanceCommitPoint::CoreReplaced,
            EffectKind::MaintenanceStageArtifacts,
            operation_id,
            admitted_revision,
        )?;
        self.apply_enrollment(target)?;
        self.commit_point(
            &host,
            MaintenanceCommitPoint::EnrollmentCommitted,
            EffectKind::MaintenanceCommitEnrollment,
            operation_id,
            admitted_revision,
        )?;
        Ok(PackageEffectOutcome::Authorized)
    }

    fn commit_receipt(
        &self,
        operation_id: u64,
        admitted_revision: u64,
    ) -> Result<PackageEffectOutcome, String> {
        let host = self.host().map_err(display_error)?;
        self.commit_point(
            &host,
            MaintenanceCommitPoint::ReceiptCommitted,
            EffectKind::MaintenanceCommitReceipt,
            operation_id,
            admitted_revision,
        )?;
        Ok(PackageEffectOutcome::ReceiptCommitted)
    }

    fn start_service(
        &self,
        operation_id: u64,
        admitted_revision: u64,
    ) -> Result<PackageEffectOutcome, String> {
        let host = self.host().map_err(display_error)?;
        self.ensure_maintenance_authority(&host)?;
        if host
            .model
            .lock()
            .expect("simulated host lock poisoned")
            .endpoint_owner
            == ManagedEndpointOwner::Foreign
        {
            return Err("maintenance-core-ownership-foreign".into());
        }
        self.commit_point(
            &host,
            MaintenanceCommitPoint::LaunchDaemonCommitted,
            EffectKind::MaintenanceCommitService,
            operation_id,
            admitted_revision,
        )?;
        self.with_maintenance(&host, |maintenance| {
            maintenance.service = SyntheticOwnership::Mish;
            maintenance.helper_process = SyntheticOwnership::Mish;
            maintenance.core_process = SyntheticOwnership::Mish;
            maintenance.socket = SyntheticOwnership::Mish;
            maintenance.socket_generation = maintenance.socket_generation.saturating_add(1);
            Ok(())
        })?;
        {
            let mut model = host.model.lock().expect("simulated host lock poisoned");
            model.core_phase = SimulatedCorePhase::Running;
            model.endpoint_owner = ManagedEndpointOwner::Mish;
        }
        self.commit_point(
            &host,
            MaintenanceCommitPoint::ServiceStarted,
            EffectKind::MaintenanceStartService,
            operation_id,
            admitted_revision,
        )?;
        let success = self.success()?;
        Ok(PackageEffectOutcome::Ready(success))
    }

    fn verify(
        &self,
        operation_id: u64,
        admitted_revision: u64,
    ) -> Result<PackageEffectOutcome, String> {
        let host = self.host().map_err(display_error)?;
        self.emit(
            &host,
            EffectKind::MaintenanceVerify,
            EffectResultKind::Verified,
            operation_id,
            admitted_revision,
        )?;
        if let Some(fault) = self.fault_at(&host, MaintenanceCommitPoint::Verified) {
            if fault.kind == MaintenanceFaultKind::Panic {
                panic!("synthetic maintenance effect panic at {:?}", fault.at);
            }
            self.fail_after_mutation(&host, operation_id, admitted_revision, fault)?;
            unreachable!("failure injection always returns an error");
        }
        self.with_maintenance(&host, |maintenance| {
            let journal = maintenance
                .journal
                .as_mut()
                .ok_or_else(|| "maintenance-journal-missing".to_string())?;
            journal.commit_point = MaintenanceCommitPoint::Verified;
            journal.terminal = Some(MaintenanceTerminal {
                code: "committed".into(),
                outcome: MaintenanceTerminalOutcome::Committed,
            });
            journal.validate().map_err(str::to_owned)?;
            maintenance.package = SyntheticPackageProjection::HealthyDisabled;
            maintenance.capture_restore_pending = journal.capture.restore_capture_on_app_start;
            maintenance.last_verified = maintenance.installed.clone();
            maintenance.recovery_required = false;
            maintenance.active_operation = None;
            Ok(())
        })?;
        Ok(PackageEffectOutcome::Verified(self.success()?))
    }

    fn rollback(
        &self,
        operation_id: u64,
        admitted_revision: u64,
    ) -> Result<PackageEffectOutcome, String> {
        let host = self.host().map_err(display_error)?;
        self.emit(
            &host,
            EffectKind::MaintenanceRestore,
            EffectResultKind::RolledBack,
            operation_id,
            admitted_revision,
        )?;
        self.restore_prior(&host, "rolled-back")?;
        Ok(PackageEffectOutcome::RolledBack)
    }

    fn finalize_uninstall(
        &self,
        operation_id: u64,
        admitted_revision: u64,
    ) -> Result<PackageEffectOutcome, String> {
        let host = self.host().map_err(display_error)?;
        self.emit(
            &host,
            EffectKind::MaintenanceFinalizeUninstall,
            EffectResultKind::Completed,
            operation_id,
            admitted_revision,
        )?;
        if let Some(fault) = self.fault_at(&host, MaintenanceCommitPoint::ServiceStarted) {
            if fault.kind == MaintenanceFaultKind::Panic {
                panic!("synthetic maintenance effect panic at {:?}", fault.at);
            }
            self.fail_after_mutation(&host, operation_id, admitted_revision, fault)?;
            unreachable!("failure injection always returns an error");
        }
        if let Some(fault) = self.fault_at(&host, MaintenanceCommitPoint::Verified) {
            if fault.kind == MaintenanceFaultKind::Panic {
                panic!("synthetic maintenance effect panic at {:?}", fault.at);
            }
            self.fail_after_mutation(&host, operation_id, admitted_revision, fault)?;
            unreachable!("failure injection always returns an error");
        }
        remove_installation_enrollment(&self.enrollment_path, uid(), false)
            .map_err(str::to_owned)?;
        for file in [
            self.runtime_root.join("tun-client-key.json"),
            self.runtime_root.join("tun-client-key.pending.json"),
        ] {
            if file.exists() {
                fs::remove_file(file).map_err(|_| "client-key-cleanup-failed".to_string())?;
            }
        }
        self.with_maintenance(&host, |maintenance| {
            let mut journal = maintenance
                .journal
                .clone()
                .ok_or_else(|| "maintenance-journal-missing".to_string())?;
            journal.commit_point = MaintenanceCommitPoint::Verified;
            journal.identity.enrollment_transition = EnrollmentTransition::Removed;
            journal.identity.new_generation = None;
            journal.identity.new_installation_id = None;
            journal.identity.new_key_id = None;
            journal.terminal = Some(MaintenanceTerminal {
                code: "uninstalled".into(),
                outcome: MaintenanceTerminalOutcome::Uninstalled,
            });
            journal.validate().map_err(str::to_owned)?;
            maintenance.installed = None;
            maintenance.enrollment_generation = None;
            maintenance.filesystem = SyntheticOwnership::Absent;
            maintenance.service = SyntheticOwnership::Absent;
            maintenance.helper_process = SyntheticOwnership::Absent;
            maintenance.socket = SyntheticOwnership::Absent;
            clear_mish_owned_network(maintenance);
            maintenance.backup = None;
            maintenance.last_verified = None;
            maintenance.capture_restore_pending = false;
            maintenance.package = SyntheticPackageProjection::Absent;
            maintenance.recovery_required = false;
            maintenance.journal = Some(journal);
            maintenance.active_operation = None;
            Ok(())
        })?;
        Ok(PackageEffectOutcome::UninstallFinalized)
    }

    async fn reconcile_capture(
        &self,
        host: &Arc<SimulatedHost>,
        operation_id: u64,
        admitted_revision: u64,
    ) -> Result<(), String> {
        self.emit(
            host,
            EffectKind::MaintenanceCaptureReconcile,
            EffectResultKind::Observed,
            operation_id,
            admitted_revision,
        )?;
        let capture = host
            .capture
            .lock()
            .expect("simulated capture lock poisoned")
            .as_ref()
            .and_then(Weak::upgrade)
            .ok_or_else(|| "maintenance-capture-unavailable".to_string())?;
        let status = capture.status();
        let correlation = capture.correlation_snapshot();
        // Helper maintenance independently hands the network off before package mutation. The
        // guided first-click flow intentionally preserves Capture's prior intent until a
        // successful Helper lifecycle authorizes its serialized Capture reconciliation. A
        // stable desired TUN projection is therefore not evidence that the handoff failed;
        // pending Capture work still is, and the fresh fail-closed network observation below is
        // required in either case.
        if status.capture_operation.is_busy() {
            return Err("maintenance-capture-handoff-not-accepted".into());
        }
        let after = self.network_observation(host)?;
        ensure_maintenance_network_disabled(&after)?;
        self.with_maintenance(host, |maintenance| {
            let before = maintenance
                .capture_before_handoff
                .take()
                .unwrap_or_else(|| after.clone());
            let journal = maintenance
                .journal
                .as_mut()
                .ok_or_else(|| "maintenance-journal-missing".to_string())?;
            journal.capture.before = before;
            journal.capture.after = after;
            journal.capture.accepted_operation_id = format!(
                "capture:{}:{}:{}",
                correlation.scope_epoch,
                correlation.admitted_revision,
                correlation.operation_id.as_deref().unwrap_or("none"),
            );
            journal.capture.core_was_running = journal
                .capture
                .before
                .confirms_enabled_at(tun_observation_now());
            journal.capture.restore_capture_on_app_start = journal.capture.core_was_running;
            Ok(())
        })
    }

    async fn advance_journal(
        &self,
        host: &Arc<SimulatedHost>,
        point: MaintenanceCommitPoint,
        effect: EffectKind,
        operation_id: u64,
        admitted_revision: u64,
        cancellation: &CancellationToken,
    ) -> Result<(), String> {
        self.pause_or_fault(
            host,
            point,
            effect,
            operation_id,
            admitted_revision,
            cancellation,
        )
        .await?;
        self.with_maintenance(host, |maintenance| {
            let journal = maintenance
                .journal
                .as_mut()
                .ok_or_else(|| "maintenance-journal-missing".to_string())?;
            journal.commit_point = point;
            journal.validate().map_err(str::to_owned)
        })
    }

    fn commit_point(
        &self,
        host: &Arc<SimulatedHost>,
        point: MaintenanceCommitPoint,
        effect: EffectKind,
        operation_id: u64,
        admitted_revision: u64,
    ) -> Result<(), String> {
        self.emit(
            host,
            effect,
            EffectResultKind::Applied,
            operation_id,
            admitted_revision,
        )?;
        if let Some(fault) = self.fault_at(host, point) {
            if fault.kind == MaintenanceFaultKind::Panic {
                panic!("synthetic maintenance effect panic at {point:?}");
            }
            return self.fail_after_mutation(host, operation_id, admitted_revision, fault);
        }
        self.with_maintenance(host, |maintenance| {
            let journal = maintenance
                .journal
                .as_mut()
                .ok_or_else(|| "maintenance-journal-missing".to_string())?;
            journal.commit_point = point;
            journal.validate().map_err(str::to_owned)
        })
    }

    async fn pause_or_fault(
        &self,
        host: &Arc<SimulatedHost>,
        point: MaintenanceCommitPoint,
        effect: EffectKind,
        operation_id: u64,
        admitted_revision: u64,
        cancellation: &CancellationToken,
    ) -> Result<(), String> {
        self.emit(
            host,
            effect,
            EffectResultKind::Applied,
            operation_id,
            admitted_revision,
        )?;
        if let Some(fault) = self.fault_at(host, point) {
            if fault.kind == MaintenanceFaultKind::Panic {
                panic!("synthetic maintenance effect panic at {point:?}");
            }
            return self.fail_after_mutation(host, operation_id, admitted_revision, fault);
        }
        let pause = self
            .configuration
            .lock()
            .expect("maintenance configuration lock poisoned")
            .clone();
        if pause.pause_at == Some(point) {
            let until = pause
                .pause_until
                .expect("validated paired maintenance pause");
            tokio::select! {
                _ = host.wait_until(until) => {}
                _ = cancellation.cancelled() => return Err("effect-aborted".into()),
            }
        }
        Ok(())
    }

    fn fail_after_mutation(
        &self,
        host: &Arc<SimulatedHost>,
        operation_id: u64,
        admitted_revision: u64,
        fault: MaintenanceFault,
    ) -> Result<(), String> {
        self.emit(
            host,
            EffectKind::MaintenanceRestore,
            EffectResultKind::RolledBack,
            operation_id,
            admitted_revision,
        )?;
        match fault.kind {
            MaintenanceFaultKind::CleanupFailure => {
                self.mark_bounded_disabled(host, fault_code(fault.kind))?;
            }
            MaintenanceFaultKind::CoreExited
            | MaintenanceFaultKind::ProcessTerminated
            | MaintenanceFaultKind::CorruptArtifact
            | MaintenanceFaultKind::ReplacedArtifact
            | MaintenanceFaultKind::StaleCompletion => {
                self.leave_recovery_pending(
                    host,
                    fault_code(fault.kind),
                    matches!(
                        fault.kind,
                        MaintenanceFaultKind::CorruptArtifact
                            | MaintenanceFaultKind::ReplacedArtifact
                    ),
                )?;
            }
            MaintenanceFaultKind::AdministratorCancelled
            | MaintenanceFaultKind::DiskFull
            | MaintenanceFaultKind::InterruptedCopy
            | MaintenanceFaultKind::PermissionDenied
            | MaintenanceFaultKind::Panic => {
                self.restore_prior(host, fault_code(fault.kind))?;
            }
        }
        Err(fault_code(fault.kind).into())
    }

    fn leave_recovery_pending(
        &self,
        host: &Arc<SimulatedHost>,
        reason: &str,
        corrupt_new_artifacts: bool,
    ) -> Result<(), String> {
        self.with_maintenance(host, |maintenance| {
            if corrupt_new_artifacts && let Some(installed) = maintenance.installed.as_mut() {
                installed.artifacts.helper_sha256 = digest('0');
            }
            maintenance.helper_process = SyntheticOwnership::Absent;
            maintenance.service = SyntheticOwnership::Absent;
            maintenance.socket = SyntheticOwnership::Absent;
            clear_mish_owned_network(maintenance);
            maintenance.capture_restore_pending = false;
            maintenance.package = SyntheticPackageProjection::RecoveryRequired;
            maintenance.recovery_required = true;
            maintenance.active_operation = None;
            let journal = maintenance
                .journal
                .as_ref()
                .ok_or_else(|| "maintenance-journal-missing".to_string())?;
            journal.validate().map_err(str::to_owned)
        })?;
        let mut model = host.model.lock().expect("simulated host lock poisoned");
        let foreign_core = model
            .maintenance
            .as_ref()
            .is_some_and(|maintenance| maintenance.core_process == SyntheticOwnership::Unrelated);
        model.core_phase = SimulatedCorePhase::Stopped;
        if foreign_core {
            model.core_phase = SimulatedCorePhase::Running;
        }
        if model.endpoint_owner == ManagedEndpointOwner::Mish {
            model.endpoint_owner = ManagedEndpointOwner::Free;
        }
        let _ = reason;
        Ok(())
    }

    fn apply_enrollment(&self, target: SyntheticPackageVersion) -> Result<(), String> {
        let host = self.host().map_err(display_error)?;
        let candidate = self
            .enroll_candidate(target.installation_id())
            .map_err(display_error)?;
        let enrollment = load_installation_enrollment_for_user(&self.enrollment_path, uid(), false)
            .map_err(str::to_owned)?;
        self.with_maintenance(&host, |maintenance| {
            let old = maintenance.installed.clone();
            maintenance.installed = Some(SyntheticInstallation {
                artifacts: target.artifacts(),
                generation: enrollment.generation,
                installation_id: target.installation_id(),
                key_id: candidate.key_id.clone(),
            });
            maintenance.enrollment_generation = Some(enrollment.generation);
            let journal = maintenance
                .journal
                .as_mut()
                .ok_or_else(|| "maintenance-journal-missing".to_string())?;
            journal.identity.old_generation = old.as_ref().map(|value| value.generation);
            journal.identity.old_installation_id =
                old.as_ref().map(|value| value.installation_id.clone());
            journal.identity.old_key_id = old.as_ref().map(|value| value.key_id.clone());
            journal.identity.new_generation = Some(enrollment.generation);
            journal.identity.new_installation_id = Some(target.installation_id());
            journal.identity.new_key_id = Some(candidate.key_id);
            journal.identity.enrollment_transition = if old.is_none() {
                EnrollmentTransition::NewEnrollment
            } else {
                EnrollmentTransition::AdministratorAuthorizedRebind
            };
            Ok(())
        })
    }

    fn restore_prior(&self, host: &Arc<SimulatedHost>, reason: &str) -> Result<(), String> {
        self.restore_credential_backup().map_err(display_error)?;
        self.with_maintenance(host, |maintenance| {
            let restored = maintenance
                .backup
                .clone()
                .or_else(|| maintenance.last_verified.clone());
            maintenance.installed = restored.clone();
            maintenance.enrollment_generation = restored.as_ref().map(|value| value.generation);
            maintenance.filesystem = if restored.is_some() {
                SyntheticOwnership::Mish
            } else {
                SyntheticOwnership::Absent
            };
            maintenance.service = maintenance.filesystem;
            maintenance.helper_process = maintenance.filesystem;
            maintenance.socket = maintenance.filesystem;
            clear_mish_owned_network(maintenance);
            maintenance.package = if restored.is_some() {
                SyntheticPackageProjection::HealthyDisabled
            } else {
                SyntheticPackageProjection::Absent
            };
            maintenance.capture_restore_pending = restored.is_some();
            maintenance.recovery_required = false;
            maintenance.last_verified = restored.clone();
            let journal = maintenance
                .journal
                .as_mut()
                .ok_or_else(|| "maintenance-journal-missing".to_string())?;
            journal.commit_point = MaintenanceCommitPoint::Verified;
            journal.compensation = MaintenanceCompensation {
                artifacts: CompensationState::Restored,
                cleanup: CompensationState::Restored,
                enrollment: CompensationState::Restored,
                network: CompensationState::Restored,
                reason: Some(reason.into()),
            };
            journal.terminal = Some(MaintenanceTerminal {
                code: reason.into(),
                outcome: MaintenanceTerminalOutcome::RolledBack,
            });
            journal.validate().map_err(str::to_owned)?;
            maintenance.active_operation = None;
            Ok(())
        })?;
        let mut model = host.model.lock().expect("simulated host lock poisoned");
        let restored = model
            .maintenance
            .as_ref()
            .is_some_and(|maintenance| maintenance.installed.is_some());
        let endpoint_was_foreign = model.endpoint_owner == ManagedEndpointOwner::Foreign;
        model.core_phase = if restored {
            SimulatedCorePhase::Running
        } else {
            SimulatedCorePhase::Stopped
        };
        if !endpoint_was_foreign {
            model.endpoint_owner = if restored {
                ManagedEndpointOwner::Mish
            } else {
                ManagedEndpointOwner::Free
            };
        }
        Ok(())
    }

    fn snapshot_credential_backup(&self) -> Result<(), MaintenanceHarnessError> {
        snapshot_optional_private_file(
            &self.runtime_root.join(DEV_TUN_CLIENT_KEY_FILE_NAME),
            &self
                .credential_backup_root
                .join(DEV_TUN_CLIENT_KEY_FILE_NAME),
        )?;
        snapshot_optional_private_file(
            &self.enrollment_path,
            &self.credential_backup_root.join("enrollment.json"),
        )?;
        snapshot_optional_private_file(
            &self.runtime_root.join(DEV_TUN_PENDING_CLIENT_KEY_FILE_NAME),
            &self
                .credential_backup_root
                .join(DEV_TUN_PENDING_CLIENT_KEY_FILE_NAME),
        )?;
        *self
            .credentials_backed_up
            .lock()
            .expect("maintenance credential backup lock poisoned") = true;
        Ok(())
    }

    fn restore_credential_backup(&self) -> Result<(), MaintenanceHarnessError> {
        if !*self
            .credentials_backed_up
            .lock()
            .expect("maintenance credential backup lock poisoned")
        {
            return Err(MaintenanceHarnessError::StateUnavailable);
        }
        restore_optional_private_file_from_backup(
            &self.enrollment_path,
            &self.credential_backup_root.join("enrollment.json"),
        )?;
        restore_optional_private_file_from_backup(
            &self.runtime_root.join(DEV_TUN_CLIENT_KEY_FILE_NAME),
            &self
                .credential_backup_root
                .join(DEV_TUN_CLIENT_KEY_FILE_NAME),
        )?;
        restore_optional_private_file_from_backup(
            &self.runtime_root.join(DEV_TUN_PENDING_CLIENT_KEY_FILE_NAME),
            &self
                .credential_backup_root
                .join(DEV_TUN_PENDING_CLIENT_KEY_FILE_NAME),
        )
    }

    fn stage_pending_client_key(
        &self,
        replacement: &SigningKey,
        public_key_spki: &[u8],
        key_id: &str,
    ) -> Result<(), MaintenanceHarnessError> {
        let private_key = replacement
            .to_pkcs8_der()
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        let record = SyntheticClientKeyRecord {
            algorithm: DEV_TUN_INSTALLATION_KEY_ALGORITHM.into(),
            key_id: key_id.into(),
            private_key_pkcs8: BASE64.encode(private_key.as_bytes()),
            public_key_spki: BASE64.encode(public_key_spki),
            schema_version: DEV_TUN_INSTALLATION_KEY_RECORD_VERSION,
        };
        write_private_json(
            &self.runtime_root.join(DEV_TUN_PENDING_CLIENT_KEY_FILE_NAME),
            &record,
        )
    }

    fn promote_pending_client_key(&self, key_id: &str) -> Result<(), MaintenanceHarnessError> {
        let (_, source) = self
            .client_keys
            .sign(key_id, b"simulated-client-key-promotion")
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        self.client_keys
            .finalize_pending(source)
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)
    }

    fn discard_pending_client_key(&self) -> Result<(), MaintenanceHarnessError> {
        let path = self.runtime_root.join(DEV_TUN_PENDING_CLIENT_KEY_FILE_NAME);
        match fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err(MaintenanceHarnessError::StateUnavailable),
        }
    }

    fn mark_bounded_disabled(&self, host: &Arc<SimulatedHost>, reason: &str) -> Result<(), String> {
        self.with_maintenance(host, |maintenance| {
            clear_mish_owned_network(maintenance);
            maintenance.socket = SyntheticOwnership::Absent;
            maintenance.service = SyntheticOwnership::Absent;
            maintenance.helper_process = SyntheticOwnership::Absent;
            maintenance.package = SyntheticPackageProjection::RecoveryRequired;
            maintenance.recovery_required = true;
            maintenance.capture_restore_pending = false;
            let journal = maintenance
                .journal
                .as_mut()
                .ok_or_else(|| "maintenance-journal-missing".to_string())?;
            journal.commit_point = MaintenanceCommitPoint::Verified;
            journal.compensation = MaintenanceCompensation {
                artifacts: CompensationState::Pending,
                cleanup: CompensationState::Failed,
                enrollment: CompensationState::Pending,
                network: CompensationState::BoundedDisabled,
                reason: Some(reason.into()),
            };
            journal.terminal = Some(MaintenanceTerminal {
                code: reason.into(),
                outcome: MaintenanceTerminalOutcome::BoundedDisabled,
            });
            journal.validate().map_err(str::to_owned)?;
            maintenance.active_operation = None;
            Ok(())
        })?;
        let mut model = host.model.lock().expect("simulated host lock poisoned");
        let foreign_core = model
            .maintenance
            .as_ref()
            .is_some_and(|maintenance| maintenance.core_process == SyntheticOwnership::Unrelated);
        if !foreign_core {
            model.core_phase = SimulatedCorePhase::Stopped;
            if model.endpoint_owner == ManagedEndpointOwner::Mish {
                model.endpoint_owner = ManagedEndpointOwner::Free;
            }
        } else {
            model.core_phase = SimulatedCorePhase::Running;
        }
        Ok(())
    }

    fn enroll_candidate(
        &self,
        installation_id: String,
    ) -> Result<mish_platform_macos::InstallationPublicKeyCandidate, MaintenanceHarnessError> {
        let candidate_path = self.state_root.path().join("candidate.json");
        let candidate = self
            .client_keys
            .write_public_candidate(&candidate_path, &installation_id)
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Enroll,
            std::slice::from_ref(&candidate_path),
            &self.enrollment_path,
            &installation_id,
            uid(),
            false,
        )
        .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        Ok(candidate)
    }

    fn journal_for(
        &self,
        maintenance: &MaintenanceModel,
        operation_id: u64,
        admitted_revision: u64,
        kind: PackageOperationKind,
        target: SyntheticPackageVersion,
    ) -> Result<InternalTunMaintenanceJournal, MaintenanceHarnessError> {
        let old = maintenance.installed.as_ref();
        let target_artifacts = target.artifacts();
        let kind = match kind {
            PackageOperationKind::Install => {
                if old.is_some_and(|current| {
                    current.artifacts.package_version != target_artifacts.package_version
                }) {
                    MaintenanceKind::Upgrade
                } else {
                    MaintenanceKind::Install
                }
            }
            PackageOperationKind::Repair => {
                if old.is_some_and(|current| {
                    current.artifacts.package_version != target_artifacts.package_version
                }) {
                    MaintenanceKind::Upgrade
                } else {
                    MaintenanceKind::Repair
                }
            }
            PackageOperationKind::Uninstall => MaintenanceKind::Uninstall,
        };
        let candidate = (kind != MaintenanceKind::Uninstall)
            .then(|| {
                self.client_keys
                    .ensure_public_candidate(&target.installation_id())
            })
            .transpose()
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        let network = maintenance.network_observation();
        let journal = InternalTunMaintenanceJournal {
            artifacts: MaintenanceArtifactEvidence {
                new: (kind != MaintenanceKind::Uninstall).then_some(target_artifacts.clone()),
                old: old.map(|value| value.artifacts.clone()),
            },
            capture: MaintenanceCaptureEvidence {
                accepted_operation_id: format!("{SYNTHETIC_OPERATION_PREFIX}{operation_id}"),
                after: TunNetworkObservation::disabled(tun_observation_now()),
                before: network,
                core_was_running: maintenance.core_process == SyntheticOwnership::Mish,
                network_ownership_record_sha256: old.map(|_| digest('9')),
                restore_capture_on_app_start: maintenance.core_process == SyntheticOwnership::Mish,
            },
            commit_point: MaintenanceCommitPoint::IntentPersisted,
            compensation: MaintenanceCompensation::default(),
            identity: MaintenanceIdentityEvidence {
                enrollment_transition: if old.is_some() {
                    EnrollmentTransition::AdministratorAuthorizedRebind
                } else {
                    EnrollmentTransition::NewEnrollment
                },
                new_generation: old.map(|value| value.generation),
                new_installation_id: (kind != MaintenanceKind::Uninstall)
                    .then(|| target.installation_id()),
                new_key_id: candidate.map(|candidate| candidate.key_id),
                old_generation: old.map(|value| value.generation),
                old_installation_id: old.map(|value| value.installation_id.clone()),
                old_key_id: old.map(|value| value.key_id.clone()),
                package_manifest_sha256: target_artifacts.manifest_sha256.clone(),
                service_label: MAINTENANCE_SERVICE_LABEL.into(),
            },
            intent: MaintenanceIntent {
                admitted_revision,
                installing_uid: SYNTHETIC_UID,
                kind,
                operation_id: format!("{SYNTHETIC_OPERATION_PREFIX}{operation_id}"),
                requested_manifest_sha256: target_artifacts.manifest_sha256,
                requested_package_version: target.package_version().into(),
            },
            schema_version: INTERNAL_TUN_MAINTENANCE_JOURNAL_SCHEMA_VERSION,
            terminal: None,
        };
        journal
            .validate()
            .map_err(|error| MaintenanceHarnessError::Rejected(error.into()))?;
        Ok(journal)
    }

    fn with_maintenance<T>(
        &self,
        host: &Arc<SimulatedHost>,
        mutate: impl FnOnce(&mut MaintenanceModel) -> Result<T, String>,
    ) -> Result<T, String> {
        let mut model = host.model.lock().expect("simulated host lock poisoned");
        let maintenance = model
            .maintenance
            .as_mut()
            .ok_or_else(|| "maintenance-state-unavailable".to_string())?;
        mutate(maintenance)
    }

    fn network_observation(
        &self,
        host: &Arc<SimulatedHost>,
    ) -> Result<TunNetworkObservation, String> {
        host.model
            .lock()
            .expect("simulated host lock poisoned")
            .maintenance
            .as_ref()
            .map(MaintenanceModel::network_observation)
            .ok_or_else(|| "maintenance-state-unavailable".into())
    }

    fn ensure_maintenance_authority(&self, host: &Arc<SimulatedHost>) -> Result<(), String> {
        let observation = self.network_observation(host)?;
        ensure_maintenance_network_disabled(&observation)?;
        Ok(())
    }

    fn success(&self) -> Result<PackageSuccess, String> {
        self.host()
            .map_err(display_error)?
            .model
            .lock()
            .expect("simulated host lock poisoned")
            .maintenance
            .as_ref()
            .and_then(|maintenance| maintenance.installed.as_ref())
            .map(SyntheticInstallation::success)
            .ok_or_else(|| "maintenance-installation-missing".into())
    }

    fn fault_at(
        &self,
        host: &Arc<SimulatedHost>,
        point: MaintenanceCommitPoint,
    ) -> Option<MaintenanceFault> {
        let occurrence = {
            let mut model = host.model.lock().expect("simulated host lock poisoned");
            let maintenance = model.maintenance.as_mut()?;
            let next = maintenance
                .fault_occurrences
                .iter_mut()
                .find(|(visited, _)| *visited == point)
                .map(|(_, occurrence)| {
                    *occurrence = occurrence.saturating_add(1);
                    *occurrence
                });
            next.unwrap_or_else(|| {
                maintenance.fault_occurrences.push((point, 1));
                1
            })
        };
        self.configuration
            .lock()
            .expect("maintenance configuration lock poisoned")
            .faults
            .iter()
            .copied()
            .find(|fault| fault.at == point && u16::from(fault.occurrence) == occurrence)
    }

    fn emit(
        &self,
        host: &Arc<SimulatedHost>,
        effect: EffectKind,
        result: EffectResultKind,
        operation_id: u64,
        admitted_revision: u64,
    ) -> Result<(), String> {
        host.emit_maintenance(effect, result, operation_id, admitted_revision)
            .map_err(|error| display_error(host_failure(error)))
    }

    fn recover_on_startup(&self) -> Result<RecoveryDecision, MaintenanceHarnessError> {
        let host = self.host()?;
        let mut model = host.model.lock().expect("simulated host lock poisoned");
        let maintenance = model
            .maintenance
            .as_mut()
            .ok_or(MaintenanceHarnessError::StateUnavailable)?;
        let Some(journal) = maintenance.journal.clone() else {
            return Ok(RecoveryDecision::AlreadyTerminal);
        };
        let last_verified = maintenance
            .backup
            .as_ref()
            .or(maintenance.last_verified.as_ref());
        let observation = RecoveryObservation {
            enrollment_matches_new: maintenance
                .installed
                .as_ref()
                .zip(journal.identity.new_installation_id.as_ref())
                .is_some_and(|(installed, identity)| installed.installation_id == *identity),
            enrollment_matches_old: maintenance
                .backup
                .as_ref()
                .or(last_verified)
                .zip(journal.identity.old_installation_id.as_ref())
                .is_some_and(|(installed, identity)| installed.installation_id == *identity),
            network_confirmed_disabled: maintenance
                .network_observation()
                .confirms_disabled_at(tun_observation_now()),
            new_artifacts_verified: maintenance
                .installed
                .as_ref()
                .zip(journal.artifacts.new.as_ref())
                .is_some_and(|(installed, artifacts)| installed.artifacts == *artifacts),
            old_artifacts_verified: maintenance
                .backup
                .as_ref()
                .or(last_verified)
                .zip(journal.artifacts.old.as_ref())
                .is_some_and(|(installed, artifacts)| installed.artifacts == *artifacts),
        };
        let decision = decide_recovery(&journal, observation);
        match decision {
            RecoveryDecision::AlreadyTerminal => {}
            RecoveryDecision::CompleteCommit => {
                let journal = maintenance.journal.as_mut().expect("checked journal");
                journal.commit_point = MaintenanceCommitPoint::Verified;
                journal.terminal = Some(MaintenanceTerminal {
                    code: "restart-completed".into(),
                    outcome: MaintenanceTerminalOutcome::Committed,
                });
                journal
                    .validate()
                    .map_err(|error| MaintenanceHarnessError::Rejected(error.into()))?;
                maintenance.package = SyntheticPackageProjection::HealthyDisabled;
                maintenance.service = SyntheticOwnership::Mish;
                maintenance.helper_process = SyntheticOwnership::Mish;
                maintenance.core_process = SyntheticOwnership::Mish;
                maintenance.socket = SyntheticOwnership::Mish;
                maintenance.last_verified = maintenance.installed.clone();
                maintenance.capture_restore_pending = journal.capture.restore_capture_on_app_start;
                maintenance.recovery_required = false;
                model.core_phase = SimulatedCorePhase::Running;
                model.endpoint_owner = ManagedEndpointOwner::Mish;
            }
            RecoveryDecision::Compensate => {
                drop(model);
                self.restore_prior(&host, "restart-rolled-back")
                    .map_err(MaintenanceHarnessError::Rejected)?;
                return Ok(decision);
            }
            RecoveryDecision::RecoveryRequired => {
                let journal = maintenance.journal.as_mut().expect("checked journal");
                journal.commit_point = MaintenanceCommitPoint::Verified;
                journal.terminal = Some(MaintenanceTerminal {
                    code: "restart-recovery-required".into(),
                    outcome: MaintenanceTerminalOutcome::BoundedDisabled,
                });
                journal
                    .validate()
                    .map_err(|error| MaintenanceHarnessError::Rejected(error.into()))?;
                maintenance.package = SyntheticPackageProjection::RecoveryRequired;
                maintenance.recovery_required = true;
                maintenance.service = SyntheticOwnership::Absent;
                maintenance.helper_process = SyntheticOwnership::Absent;
                maintenance.socket = SyntheticOwnership::Absent;
                model.core_phase = SimulatedCorePhase::Stopped;
                if model.endpoint_owner == ManagedEndpointOwner::Mish {
                    model.endpoint_owner = ManagedEndpointOwner::Free;
                }
            }
        }
        Ok(decision)
    }

    async fn restore_capture_after_restart(
        &self,
        runtime: MishRuntime,
    ) -> Result<(), MaintenanceHarnessError> {
        let should_restore = self
            .host()?
            .model
            .lock()
            .expect("simulated host lock poisoned")
            .maintenance
            .as_ref()
            .is_some_and(|maintenance| {
                maintenance.capture_restore_pending && !maintenance.recovery_required
            });
        if !should_restore {
            return Ok(());
        }
        runtime
            .set_capture(
                CaptureRequest {
                    active: true,
                    selection: CaptureSelection {
                        system_proxy: false,
                        tun: true,
                    },
                },
                StatusAdapterKind::Rpc,
            )
            .await
            .map_err(|error| {
                MaintenanceHarnessError::Rejected(format!("capture-restore:{:?}", error.kind))
            })?;
        let host = self.host()?;
        self.with_maintenance(&host, |maintenance| {
            maintenance.capture_restore_pending = false;
            Ok(())
        })
        .map_err(MaintenanceHarnessError::Rejected)
    }

    pub fn rotate_key_with_dual_proof(&self) -> Result<(), MaintenanceHarnessError> {
        let host = self.host()?;
        let installation_id = {
            let model = host.model.lock().expect("simulated host lock poisoned");
            let installed = model
                .maintenance
                .as_ref()
                .and_then(|maintenance| maintenance.installed.as_ref())
                .ok_or(MaintenanceHarnessError::StateUnavailable)?;
            installed.installation_id.clone()
        };
        let enrollment = load_installation_enrollment_for_user(&self.enrollment_path, uid(), false)
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        let replacement = test_key();
        let replacement_public = replacement
            .verifying_key()
            .to_public_key_der()
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        let replacement_key_id = format!("{:x}", Sha256::digest(replacement_public.as_bytes()));
        let mut request = InstallationKeyRotationRequest {
            algorithm: DEV_TUN_INSTALLATION_KEY_ALGORITHM.into(),
            current_generation: enrollment.generation,
            current_key_id: enrollment.key_id,
            helper_installation_id: installation_id.clone(),
            installing_uid: uid(),
            new_signature: String::new(),
            old_signature: String::new(),
            replacement_key_id: replacement_key_id.clone(),
            replacement_public_key_spki: BASE64.encode(replacement_public.as_bytes()),
            schema_version: DEV_TUN_INSTALLATION_KEY_RECORD_VERSION,
            transcript_version: DEV_TUN_INSTALLATION_KEY_TRANSCRIPT_VERSION,
        };
        let transcript = canonical_rotation_transcript(&request)
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        let (old_signature, _) = self
            .client_keys
            .sign(&request.current_key_id, &transcript)
            .map_err(|_| MaintenanceHarnessError::Rejected("old-key-proof-unavailable".into()))?;
        request.old_signature = BASE64.encode(old_signature);
        request.new_signature = sign(&replacement, &transcript);
        let request_path = self.state_root.path().join("rotation.json");
        write_private_json(&request_path, &request)?;
        self.stage_pending_client_key(
            &replacement,
            replacement_public.as_bytes(),
            &replacement_key_id,
        )?;
        let receipt = match apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Rotate,
            std::slice::from_ref(&request_path),
            &self.enrollment_path,
            &installation_id,
            uid(),
            false,
        ) {
            Ok(receipt) => receipt,
            Err(_) => {
                self.discard_pending_client_key()?;
                return Err(MaintenanceHarnessError::Rejected(
                    "dual-proof-rotation-rejected".into(),
                ));
            }
        };
        self.promote_pending_client_key(&replacement_key_id)?;
        self.with_maintenance(&host, |maintenance| {
            let installed = maintenance
                .installed
                .as_mut()
                .ok_or_else(|| "maintenance-installation-missing".to_string())?;
            installed.key_id = receipt.key_id;
            installed.generation = receipt.generation;
            maintenance.enrollment_generation = Some(receipt.generation);
            Ok(())
        })
        .map_err(MaintenanceHarnessError::Rejected)
    }

    pub fn reset_lost_key(
        &self,
        administrator_authorized: bool,
    ) -> Result<(), MaintenanceHarnessError> {
        if !administrator_authorized {
            return Err(MaintenanceHarnessError::Rejected(
                "lost-key-reset-requires-administrator-authorization".into(),
            ));
        }
        let host = self.host()?;
        let installation_id = host
            .model
            .lock()
            .expect("simulated host lock poisoned")
            .maintenance
            .as_ref()
            .and_then(|maintenance| maintenance.installed.as_ref())
            .map(|installed| installed.installation_id.clone())
            .ok_or(MaintenanceHarnessError::StateUnavailable)?;
        let replacement = test_key();
        let public = replacement
            .verifying_key()
            .to_public_key_der()
            .map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
        let candidate = mish_platform_macos::InstallationPublicKeyCandidate {
            algorithm: DEV_TUN_INSTALLATION_KEY_ALGORITHM.into(),
            helper_installation_id: installation_id.clone(),
            installing_uid: uid(),
            key_id: format!("{:x}", Sha256::digest(public.as_bytes())),
            public_key_spki: BASE64.encode(public.as_bytes()),
            schema_version: DEV_TUN_INSTALLATION_KEY_RECORD_VERSION,
        };
        let path = self.state_root.path().join("reset.json");
        write_private_json(&path, &candidate)?;
        self.stage_pending_client_key(&replacement, public.as_bytes(), &candidate.key_id)?;
        let receipt = match apply_installation_enrollment_operation(
            InstallationEnrollmentOperation::Reset,
            std::slice::from_ref(&path),
            &self.enrollment_path,
            &installation_id,
            uid(),
            false,
        ) {
            Ok(receipt) => receipt,
            Err(_) => {
                self.discard_pending_client_key()?;
                return Err(MaintenanceHarnessError::Rejected(
                    "lost-key-reset-rejected".into(),
                ));
            }
        };
        self.promote_pending_client_key(&candidate.key_id)?;
        self.with_maintenance(&host, |maintenance| {
            let installed = maintenance
                .installed
                .as_mut()
                .ok_or_else(|| "maintenance-installation-missing".to_string())?;
            installed.generation = receipt.generation;
            installed.key_id = receipt.key_id;
            maintenance.enrollment_generation = Some(receipt.generation);
            Ok(())
        })
        .map_err(MaintenanceHarnessError::Rejected)
    }
}

struct MaintenanceExecutor {
    admitted_revision: u64,
    engine: Weak<MaintenanceEngine>,
    kind: PackageOperationKind,
    operation_id: u64,
    target: SyntheticPackageVersion,
}

impl EffectExecutor<PackageMachine> for MaintenanceExecutor {
    fn execute(
        &self,
        effect: PackageEffect,
        cancellation: CancellationToken,
    ) -> Pin<Box<dyn Future<Output = PackageInput> + Send + 'static>> {
        let admitted_revision = self.admitted_revision;
        let engine = self.engine.clone();
        let kind = self.kind;
        let operation_id = self.operation_id;
        let target = self.target;
        Box::pin(async move {
            let correlation = effect.correlation().clone();
            let outcome = match engine.upgrade() {
                Some(engine) => {
                    engine
                        .execute_effect(
                            effect,
                            kind,
                            operation_id,
                            admitted_revision,
                            target,
                            cancellation,
                        )
                        .await
                }
                None => PackageEffectOutcome::Failed(PackageFailure::recovery_required(
                    "simulated-maintenance-host-unavailable",
                )),
            };
            PackageInput::EffectCompleted {
                correlation,
                outcome,
            }
        })
    }
}

struct MaintenanceObserver {
    engine: Weak<MaintenanceEngine>,
    projection: watch::Sender<PackageProjection>,
}

impl TransitionObserver<PackageMachine> for MaintenanceObserver {
    fn transitioned(
        &self,
        _previous: &PackageState,
        _input: &PackageInput,
        current: &PackageState,
        _disposition: Disposition,
    ) {
        // `send_replace` deliberately does not wake receivers. The scenario waits on this
        // bounded projection to observe the terminal state of the real package machine.
        let _ = self.projection.send(current.projection());
        let Some(engine) = self.engine.upgrade() else {
            return;
        };
        let Ok(host) = engine.host() else {
            return;
        };
        let mut model = host.model.lock().expect("simulated host lock poisoned");
        let Some(maintenance) = model.maintenance.as_mut() else {
            return;
        };
        maintenance.package = match current.projection() {
            PackageProjection::Absent => SyntheticPackageProjection::Absent,
            PackageProjection::HealthyDisabled(_) => SyntheticPackageProjection::HealthyDisabled,
            PackageProjection::Failed(_) => SyntheticPackageProjection::RecoveryRequired,
            PackageProjection::InFlight { .. } => SyntheticPackageProjection::InFlight,
            // The test runner retires after the terminal projection has already been recorded.
            // Retiring its owned task must not erase that authoritative package observation.
            PackageProjection::Retired => maintenance.package,
        };
    }
}

impl SimulatedHost {
    fn maintenance_snapshot(&self) -> Result<TunHelperSnapshot, TunHelperError> {
        let model = self.model.lock().expect("simulated host lock poisoned");
        let Some(maintenance) = model.maintenance.as_ref() else {
            return Err(TunHelperError::new(
                TunHelperFailureKind::UnsupportedSystem,
                "Internal TUN simulation was not configured",
            ));
        };
        let healthy = maintenance.package == SyntheticPackageProjection::HealthyDisabled
            && maintenance.service == SyntheticOwnership::Mish
            && maintenance.helper_process == SyntheticOwnership::Mish
            && maintenance.socket == SyntheticOwnership::Mish
            && !maintenance.recovery_required;
        let network_failure = network_ownership_failure(maintenance);
        let (availability, health, installed_version, installation_id, last_failure) =
            if let Some(failure) = network_failure {
                (
                    TunHelperAvailability::RepairRequired,
                    TunHelperHealth::Unknown,
                    None,
                    maintenance
                        .installed
                        .as_ref()
                        .map(|installation| installation.installation_id.clone()),
                    Some(failure),
                )
            } else if healthy {
                (
                    TunHelperAvailability::Available,
                    TunHelperHealth::Healthy,
                    Some(mish_runtime::TUN_HELPER_EXPECTED_VERSION.into()),
                    maintenance
                        .installed
                        .as_ref()
                        .map(|installation| installation.installation_id.clone()),
                    None,
                )
            } else if maintenance.package == SyntheticPackageProjection::Absent {
                (
                    TunHelperAvailability::PermissionRequired,
                    TunHelperHealth::NotInstalled,
                    None,
                    None,
                    None,
                )
            } else {
                (
                    TunHelperAvailability::RepairRequired,
                    TunHelperHealth::Unknown,
                    None,
                    maintenance
                        .installed
                        .as_ref()
                        .map(|installation| installation.installation_id.clone()),
                    Some(TunHelperFailureKind::OperationFailed),
                )
            };
        Ok(TunHelperSnapshot {
            availability,
            expected_version: mish_runtime::TUN_HELPER_EXPECTED_VERSION.into(),
            health,
            installation_id,
            installed_version,
            last_failure,
            phase: mish_runtime::TunHelperLifecyclePhase::Idle,
            removal: match availability {
                TunHelperAvailability::Available | TunHelperAvailability::RepairRequired => {
                    TunHelperRemovalCapability::Available
                }
                TunHelperAvailability::PermissionRequired => {
                    TunHelperRemovalCapability::NotInstalled
                }
                _ => TunHelperRemovalCapability::Unavailable,
            },
        })
    }
}

impl TunHelperPlatform for SimulatedHost {
    fn initial_snapshot(&self) -> TunHelperSnapshot {
        self.maintenance_snapshot().unwrap_or_else(|error| {
            TunHelperSnapshot::unavailable(
                TunHelperAvailability::Unavailable,
                TunHelperHealth::Unknown,
                error.kind,
            )
        })
    }

    fn observe_helper(&self) -> BoxFuture<'_, Result<TunHelperObservation, TunHelperError>> {
        Box::pin(async move {
            let snapshot = self.maintenance_snapshot()?;
            Ok(TunHelperObservation {
                availability: snapshot.availability,
                health: snapshot.health,
                installation_id: snapshot.installation_id,
                installed_version: snapshot.installed_version,
                last_failure: snapshot.last_failure,
            })
        })
    }

    fn run_lifecycle(
        &self,
        operation: TunHelperLifecycleOperation,
    ) -> BoxFuture<'_, Result<(), TunHelperError>> {
        let engine = self.maintenance_engine();
        Box::pin(async move {
            let engine = engine.ok_or_else(|| {
                TunHelperError::new(
                    TunHelperFailureKind::UnsupportedSystem,
                    "Internal TUN simulation was not configured",
                )
            })?;
            engine.run_lifecycle(operation).await
        })
    }

    fn observe_tun(&self) -> BoxFuture<'_, Result<TunNetworkObservation, TunHelperError>> {
        Box::pin(async move {
            let (operation_id, revision, observation) = {
                let model = self.model.lock().expect("simulated host lock poisoned");
                let maintenance = model.maintenance.as_ref().ok_or_else(|| {
                    TunHelperError::new(
                        TunHelperFailureKind::UnsupportedSystem,
                        "Internal TUN simulation was not configured",
                    )
                })?;
                (
                    maintenance.active_operation.unwrap_or(0),
                    maintenance.active_operation.unwrap_or(0),
                    maintenance.network_observation(),
                )
            };
            self.emit_maintenance(
                EffectKind::MaintenanceObserve,
                EffectResultKind::Observed,
                operation_id,
                revision,
            )
            .map_err(|_| {
                TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "The simulated Internal TUN observation failed closed",
                )
            })?;
            Ok(observation)
        })
    }

    fn set_tun_enabled(&self, enabled: bool) -> BoxFuture<'_, Result<(), TunHelperError>> {
        Box::pin(async move {
            let (operation_id, revision, failure, ownership_failure, endpoint_owner, healthy) = {
                let mut model = self.model.lock().expect("simulated host lock poisoned");
                let maintenance = model.maintenance.as_mut().ok_or_else(|| {
                    TunHelperError::new(
                        TunHelperFailureKind::UnsupportedSystem,
                        "Internal TUN simulation was not configured",
                    )
                })?;
                let healthy = maintenance.package == SyntheticPackageProjection::HealthyDisabled
                    && !maintenance.recovery_required;
                (
                    maintenance.active_operation.unwrap_or(0),
                    maintenance.active_operation.unwrap_or(0),
                    maintenance.tun_mutation_failure.take(),
                    network_ownership_failure(maintenance),
                    model.endpoint_owner,
                    healthy,
                )
            };
            if let Some(failure) = failure {
                self.emit_maintenance(
                    EffectKind::MaintenanceSetTun,
                    EffectResultKind::FailedClosed,
                    operation_id,
                    revision,
                )
                .map_err(|_| {
                    TunHelperError::new(
                        TunHelperFailureKind::OperationFailed,
                        "The simulated Internal TUN mutation failed closed",
                    )
                })?;
                return Err(TunHelperError::new(
                    failure,
                    "The simulated Internal TUN mutation failed",
                ));
            }
            if let Some(failure) = ownership_failure {
                self.emit_maintenance(
                    EffectKind::MaintenanceSetTun,
                    if failure == TunHelperFailureKind::ObservationForeign {
                        EffectResultKind::ForeignOwned
                    } else {
                        EffectResultKind::Rejected
                    },
                    operation_id,
                    revision,
                )
                .map_err(|_| {
                    TunHelperError::new(
                        TunHelperFailureKind::OperationFailed,
                        "The simulated Internal TUN ownership check failed closed",
                    )
                })?;
                return Err(TunHelperError::new(
                    failure,
                    "Foreign or partial synthetic network state owns Internal TUN effects",
                ));
            }
            if endpoint_owner == ManagedEndpointOwner::Foreign {
                self.emit_maintenance(
                    EffectKind::MaintenanceSetTun,
                    EffectResultKind::ForeignOwned,
                    operation_id,
                    revision,
                )
                .map_err(|_| {
                    TunHelperError::new(
                        TunHelperFailureKind::OperationFailed,
                        "The simulated Internal TUN endpoint check failed closed",
                    )
                })?;
                return Err(TunHelperError::new(
                    TunHelperFailureKind::ObservationForeign,
                    "A foreign synthetic Core owns the managed endpoint",
                ));
            }
            if enabled && !healthy {
                self.emit_maintenance(
                    EffectKind::MaintenanceSetTun,
                    EffectResultKind::Rejected,
                    operation_id,
                    revision,
                )
                .map_err(|_| {
                    TunHelperError::new(
                        TunHelperFailureKind::OperationFailed,
                        "The simulated Internal TUN health check failed closed",
                    )
                })?;
                return Err(TunHelperError::new(
                    TunHelperFailureKind::ConnectionFailed,
                    "The simulated Internal TUN helper is not healthy",
                ));
            }
            self.emit_maintenance(
                EffectKind::MaintenanceSetTun,
                EffectResultKind::Applied,
                operation_id,
                revision,
            )
            .map_err(|_| {
                TunHelperError::new(
                    TunHelperFailureKind::OperationFailed,
                    "The simulated Internal TUN write failed closed",
                )
            })?;
            let mut model = self.model.lock().expect("simulated host lock poisoned");
            let maintenance = model.maintenance.as_mut().ok_or_else(|| {
                TunHelperError::new(
                    TunHelperFailureKind::UnsupportedSystem,
                    "Internal TUN simulation was not configured",
                )
            })?;
            if enabled {
                maintenance.core_process = SyntheticOwnership::Mish;
                maintenance.tun = SyntheticOwnership::Mish;
                maintenance.route = SyntheticOwnership::Mish;
                maintenance.dns = SyntheticOwnership::Mish;
                model.core_phase = SimulatedCorePhase::Running;
                model.endpoint_owner = ManagedEndpointOwner::Mish;
            } else {
                if maintenance.capture_before_handoff.is_none()
                    && maintenance.tun == SyntheticOwnership::Mish
                {
                    maintenance.capture_before_handoff = Some(maintenance.network_observation());
                }
                if maintenance.tun == SyntheticOwnership::Mish {
                    maintenance.tun = SyntheticOwnership::Absent;
                }
                if maintenance.route == SyntheticOwnership::Mish {
                    maintenance.route = SyntheticOwnership::Absent;
                }
                if maintenance.dns == SyntheticOwnership::Mish {
                    maintenance.dns = SyntheticOwnership::Absent;
                }
                if maintenance.core_process == SyntheticOwnership::Mish {
                    maintenance.core_process = SyntheticOwnership::Absent;
                }
                model.core_phase = SimulatedCorePhase::Stopped;
                if model.endpoint_owner == ManagedEndpointOwner::Mish {
                    model.endpoint_owner = ManagedEndpointOwner::Free;
                }
            }
            Ok(())
        })
    }
}

pub struct MaintenanceScenarioRuntime {
    _root: TempDir,
    pub activation: Arc<ProfileActivationCoordinator>,
    pub capture: Arc<CaptureReconciler>,
    pub helper: Arc<TunHelperController>,
    pub host: Arc<SimulatedHost>,
    pub maintenance: Arc<MaintenanceEngine>,
    pub profile_service: Arc<mish_bridge::DesktopProfileService>,
    pub runtime_host: DesktopRuntimeHost,
    pub settings_service: Arc<SettingsService>,
}

impl MaintenanceScenarioRuntime {
    pub async fn build(
        scenario: SimulatedHostScenario,
        maintenance_scenario: MaintenanceScenario,
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
        let maintenance = MaintenanceEngine::new(Arc::downgrade(&host), maintenance_scenario)?;
        host.attach_maintenance_engine(&maintenance);
        let helper = Arc::new(TunHelperController::new(host.clone()));
        let platform: Arc<dyn CapturePlatform> = host.clone();
        let journal: Arc<dyn CaptureJournalStore> = host.clone();
        let capture = Arc::new(CaptureReconciler::new_with_tun(
            platform,
            journal,
            LoopbackProxyEndpoint::managed(),
            Some(helper.clone()),
        ));
        host.attach_capture(&capture);
        let core: Arc<dyn CoreRuntime> = host.clone();
        let runtime = MishRuntime::with_capture(core, capture.clone());
        host.attach_runtime(runtime.clone());
        // Healthy v1/v2 fixtures model an already Mish-owned active TUN. Seed the real
        // Capture machine with that observed state so an authenticated application request
        // cannot mistake the synthetic owner for external drift.
        if host
            .maintenance_observation()
            .is_some_and(|observation| observation.tun == SyntheticOwnership::Mish)
        {
            runtime
                .set_capture(
                    CaptureRequest {
                        active: true,
                        selection: CaptureSelection {
                            system_proxy: false,
                            tun: true,
                        },
                    },
                    StatusAdapterKind::Rpc,
                )
                .await?;
        }
        let runtime_host = DesktopRuntimeHost::with_mutation_authority(
            runtime.clone(),
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
            runtime,
            || {
                ManagedRuntimePolicy::new(
                    "127.0.0.1:19090"
                        .parse()
                        .expect("closed simulated endpoint"),
                    "simulated-controller-secret",
                )
            },
        ));
        let settings_service = build_settings_service(
            root.path(),
            helper.clone(),
            profile_service.mutation_authority(),
        )?;
        Ok(Self {
            _root: root,
            activation,
            capture,
            helper,
            host,
            maintenance,
            profile_service,
            runtime_host,
            settings_service,
        })
    }

    pub async fn restart(self) -> Result<Self, Box<dyn std::error::Error>> {
        let Self {
            _root,
            activation,
            capture,
            helper,
            host,
            maintenance,
            profile_service,
            runtime_host,
            settings_service,
        } = self;
        drop(activation);
        drop(capture);
        drop(helper);
        drop(runtime_host);
        drop(settings_service);
        host.detach_process();
        maintenance.recover_on_startup()?;
        let helper = Arc::new(TunHelperController::new(host.clone()));
        let platform: Arc<dyn CapturePlatform> = host.clone();
        let journal: Arc<dyn CaptureJournalStore> = host.clone();
        let capture = Arc::new(CaptureReconciler::new_with_tun(
            platform,
            journal,
            LoopbackProxyEndpoint::managed(),
            Some(helper.clone()),
        ));
        host.attach_capture(&capture);
        let core: Arc<dyn CoreRuntime> = host.clone();
        let runtime = MishRuntime::with_capture(core, capture.clone());
        host.attach_runtime(runtime.clone());
        let runtime_host = DesktopRuntimeHost::with_mutation_authority(
            runtime.clone(),
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
            runtime.clone(),
            || {
                ManagedRuntimePolicy::new(
                    "127.0.0.1:19090"
                        .parse()
                        .expect("closed simulated endpoint"),
                    "simulated-controller-secret",
                )
            },
        ));
        maintenance.restore_capture_after_restart(runtime).await?;
        let settings_service = build_settings_service(
            _root.path(),
            helper.clone(),
            profile_service.mutation_authority(),
        )?;
        Ok(Self {
            _root,
            activation,
            capture,
            helper,
            host,
            maintenance,
            profile_service,
            runtime_host,
            settings_service,
        })
    }
}

async fn wait_for_terminal(receiver: &mut watch::Receiver<PackageProjection>) -> PackageProjection {
    loop {
        let current = receiver.borrow().clone();
        if !matches!(current, PackageProjection::InFlight { .. }) {
            return current;
        }
        receiver
            .changed()
            .await
            .expect("package lifecycle projection sender remains alive");
    }
}

fn build_settings_service(
    root: &std::path::Path,
    helper: Arc<TunHelperController>,
    authority: StateMutationAuthority,
) -> Result<Arc<SettingsService>, Box<dyn std::error::Error>> {
    let mut capabilities = SettingsCapabilities::macos(false);
    capabilities.tun = SettingsAvailability::Supported;
    Ok(Arc::new(
        SettingsService::load_with_platforms_and_authority(
            Arc::new(FileSettingsRepository::new(root.join("settings.json"))),
            None,
            None,
            capabilities,
            Some(helper),
            None,
            authority,
        )?,
    ))
}

fn component(owner: SyntheticOwnership) -> TunObservationComponentState {
    match owner {
        SyntheticOwnership::Absent => TunObservationComponentState::Absent,
        SyntheticOwnership::Mish => TunObservationComponentState::Confirmed,
        SyntheticOwnership::Partial => TunObservationComponentState::Partial,
        SyntheticOwnership::Unrelated => TunObservationComponentState::Foreign,
    }
}

fn ensure_maintenance_network_disabled(observation: &TunNetworkObservation) -> Result<(), String> {
    let now = tun_observation_now();
    if !observation.is_fresh_at(now) {
        return Err("maintenance-capture-observation-stale".into());
    }
    if [
        observation.core,
        observation.interface,
        observation.routes,
        observation.dns,
    ]
    .contains(&TunObservationComponentState::Foreign)
    {
        return Err("maintenance-capture-ownership-foreign".into());
    }
    if !observation.confirms_removal_safe_at(now) {
        return Err("maintenance-capture-reconciliation-unconfirmed".into());
    }
    Ok(())
}

fn network_ownership_failure(maintenance: &MaintenanceModel) -> Option<TunHelperFailureKind> {
    let owners = [
        maintenance.core_process,
        maintenance.tun,
        maintenance.route,
        maintenance.dns,
    ];
    if owners.contains(&SyntheticOwnership::Unrelated) {
        Some(TunHelperFailureKind::ObservationForeign)
    } else if owners.contains(&SyntheticOwnership::Partial) {
        Some(TunHelperFailureKind::ObservationPartial)
    } else {
        None
    }
}

fn clear_mish_owned_network(maintenance: &mut MaintenanceModel) {
    for owner in [
        &mut maintenance.core_process,
        &mut maintenance.tun,
        &mut maintenance.route,
        &mut maintenance.dns,
    ] {
        if *owner == SyntheticOwnership::Mish {
            *owner = SyntheticOwnership::Absent;
        }
    }
}

fn digest(value: char) -> String {
    value.to_string().repeat(64)
}

fn next_hex(value: char) -> char {
    match value {
        '0'..='8' => char::from_u32(value as u32 + 1).expect("hex increment"),
        '9' => 'a',
        'a'..='e' => char::from_u32(value as u32 + 1).expect("hex increment"),
        'f' => '0',
        _ => '0',
    }
}

fn fault_code(kind: MaintenanceFaultKind) -> &'static str {
    match kind {
        MaintenanceFaultKind::AdministratorCancelled => "administrator-authorization-cancelled",
        MaintenanceFaultKind::CleanupFailure => "cleanup-failed",
        MaintenanceFaultKind::CoreExited => "core-exit",
        MaintenanceFaultKind::CorruptArtifact => "artifact-corrupt",
        MaintenanceFaultKind::DiskFull => "disk-full",
        MaintenanceFaultKind::InterruptedCopy => "copy-interrupted",
        MaintenanceFaultKind::Panic => "effect-panicked",
        MaintenanceFaultKind::PermissionDenied => "permission-denied",
        MaintenanceFaultKind::ProcessTerminated => "process-terminated",
        MaintenanceFaultKind::ReplacedArtifact => "artifact-replaced",
        MaintenanceFaultKind::StaleCompletion => "effect-completion-conflict",
    }
}

fn package_failure(error: String) -> PackageFailure {
    if matches!(
        error.as_str(),
        "cleanup-failed"
            | "core-exit"
            | "effect-aborted"
            | "effect-panicked"
            | "effect-completion-conflict"
            | "artifact-corrupt"
            | "process-terminated"
            | "artifact-replaced"
    ) {
        PackageFailure::recovery_required(error)
    } else {
        PackageFailure::clean(error)
    }
}

fn helper_error(error: &MaintenanceHarnessError) -> TunHelperError {
    let (kind, message) = match error {
        MaintenanceHarnessError::Busy => (
            TunHelperFailureKind::OperationFailed,
            "A simulated Internal TUN maintenance operation is already active",
        ),
        MaintenanceHarnessError::Rejected(code) if code.contains("cancelled") => (
            TunHelperFailureKind::AuthorizationCancelled,
            "The simulated administrator authorization was cancelled",
        ),
        MaintenanceHarnessError::Rejected(code) if code.contains("permission") => (
            TunHelperFailureKind::PermissionDenied,
            "The simulated maintenance write was denied",
        ),
        MaintenanceHarnessError::Rejected(code) if code.contains("foreign") => (
            TunHelperFailureKind::ObservationForeign,
            "Foreign synthetic network ownership blocked maintenance",
        ),
        MaintenanceHarnessError::Rejected(code) if code.contains("partial") => (
            TunHelperFailureKind::ObservationPartial,
            "Partial synthetic network ownership blocked maintenance",
        ),
        MaintenanceHarnessError::Rejected(code) if code.contains("stale") => (
            TunHelperFailureKind::ObservationStale,
            "Stale synthetic network observation blocked maintenance",
        ),
        MaintenanceHarnessError::Rejected(code) if code.contains("downgrade") => (
            TunHelperFailureKind::VersionMismatch,
            "The simulated maintenance downgrade was rejected",
        ),
        _ => (
            TunHelperFailureKind::OperationFailed,
            "The simulated Internal TUN maintenance operation failed",
        ),
    };
    TunHelperError::new(kind, message)
}

fn host_failure(error: SimulatedHostFailure) -> MaintenanceHarnessError {
    MaintenanceHarnessError::Rejected(error.to_string())
}

fn display_error(error: MaintenanceHarnessError) -> String {
    error.to_string()
}

fn uid() -> u32 {
    // The temporary enrollment path is owned by the running test user. This value never enters a
    // projection; journal intent uses the closed synthetic UID instead.
    unsafe { libc::getuid() }
}

fn test_key() -> SigningKey {
    SigningKey::random(&mut OsRng)
}

fn sign(key: &SigningKey, transcript: &[u8]) -> String {
    let signature: Signature = key.sign(transcript);
    BASE64.encode(signature.to_der().as_bytes())
}

fn read_optional_private_file(
    path: &std::path::Path,
) -> Result<Option<Vec<u8>>, MaintenanceHarnessError> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(_) => Err(MaintenanceHarnessError::StateUnavailable),
    }
}

fn snapshot_optional_private_file(
    source: &std::path::Path,
    backup: &std::path::Path,
) -> Result<(), MaintenanceHarnessError> {
    match read_optional_private_file(source)? {
        Some(bytes) => write_private_bytes(backup, &bytes),
        None => remove_optional_private_file(backup),
    }
}

fn restore_optional_private_file_from_backup(
    target: &std::path::Path,
    backup: &std::path::Path,
) -> Result<(), MaintenanceHarnessError> {
    restore_optional_private_file(target, &read_optional_private_file(backup)?)
}

fn restore_optional_private_file(
    path: &std::path::Path,
    backup: &Option<Vec<u8>>,
) -> Result<(), MaintenanceHarnessError> {
    match backup {
        Some(bytes) => write_private_bytes(path, bytes),
        None => remove_optional_private_file(path),
    }
}

fn remove_optional_private_file(path: &std::path::Path) -> Result<(), MaintenanceHarnessError> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(MaintenanceHarnessError::StateUnavailable),
    }
}

fn write_private_bytes(
    path: &std::path::Path,
    bytes: &[u8],
) -> Result<(), MaintenanceHarnessError> {
    fs::write(path, bytes).map_err(|_| MaintenanceHarnessError::StateUnavailable)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
        .map_err(|_| MaintenanceHarnessError::StateUnavailable)
}

fn write_private_json(
    path: &std::path::Path,
    value: &impl Serialize,
) -> Result<(), MaintenanceHarnessError> {
    write_private_bytes(
        path,
        &serde_json::to_vec(value).map_err(|_| MaintenanceHarnessError::StateUnavailable)?,
    )
}

trait PackageInputOutcome {
    fn into_effect_outcome(self) -> PackageEffectOutcome;
}

impl PackageInputOutcome for PackageInput {
    fn into_effect_outcome(self) -> PackageEffectOutcome {
        match self {
            PackageInput::EffectCompleted { outcome, .. } => outcome,
            PackageInput::Begin(_) | PackageInput::Shutdown => PackageEffectOutcome::Failed(
                PackageFailure::recovery_required("simulated-maintenance-executor-invalid-input"),
            ),
        }
    }
}
