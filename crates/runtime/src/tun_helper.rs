use std::{
    fmt,
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex as AsyncMutex;

pub const TUN_HELPER_EXPECTED_VERSION: &str = "3";
pub const TUN_HELPER_PROTOCOL_VERSION: u16 = 3;
pub const TUN_HELPER_MAX_MESSAGE_BYTES: usize = 16 * 1024;
pub const TUN_OBSERVATION_SCHEMA_VERSION: u16 = 1;
pub const TUN_OBSERVATION_MAX_AGE_MILLISECONDS: u64 = 10_000;
pub const TUN_APP_SIGNING_IDENTIFIER: &str = "com.asuka109.mish";
pub const TUN_HELPER_SIGNING_IDENTIFIER: &str = "com.asuka109.mish.tun-helper";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunHelperAvailability {
    Available,
    PermissionRequired,
    RepairRequired,
    Unpackaged,
    UnsignedApp,
    UnsupportedSystem,
    Unavailable,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunHelperHealth {
    Healthy,
    InvalidSignature,
    NotInstalled,
    Unknown,
    Unreachable,
    VersionMismatch,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunHelperLifecyclePhase {
    Failed,
    Idle,
    Installing,
    Removing,
    Repairing,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunHelperFailureKind {
    AuthorizationCancelled,
    ConfirmationFailed,
    ConnectionFailed,
    IdentityRejected,
    InstallationFailed,
    InstallerUnavailable,
    InvalidSignature,
    MessageTooLarge,
    OperationFailed,
    ObservationForeign,
    ObservationPartial,
    ObservationStale,
    PermissionDenied,
    PreparationFailed,
    ProtocolMismatch,
    RegistrationFailed,
    RegistrationRequiresApproval,
    Unpackaged,
    UnsignedApp,
    UnsupportedSystem,
    VersionMismatch,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunObservationComponentState {
    Absent,
    Confirmed,
    Foreign,
    Partial,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunNetworkObservation {
    pub core: TunObservationComponentState,
    pub dns: TunObservationComponentState,
    pub interface: TunObservationComponentState,
    pub observed_at: u64,
    pub routes: TunObservationComponentState,
    pub schema_version: u16,
}

impl TunNetworkObservation {
    pub const fn new(
        core: TunObservationComponentState,
        interface: TunObservationComponentState,
        routes: TunObservationComponentState,
        dns: TunObservationComponentState,
        observed_at: u64,
    ) -> Self {
        Self {
            core,
            dns,
            interface,
            observed_at,
            routes,
            schema_version: TUN_OBSERVATION_SCHEMA_VERSION,
        }
    }

    pub const fn unknown(observed_at: u64) -> Self {
        Self::new(
            TunObservationComponentState::Unknown,
            TunObservationComponentState::Unknown,
            TunObservationComponentState::Unknown,
            TunObservationComponentState::Unknown,
            observed_at,
        )
    }

    pub const fn disabled(observed_at: u64) -> Self {
        Self::new(
            TunObservationComponentState::Absent,
            TunObservationComponentState::Absent,
            TunObservationComponentState::Absent,
            TunObservationComponentState::Absent,
            observed_at,
        )
    }

    pub const fn enabled(observed_at: u64) -> Self {
        Self::new(
            TunObservationComponentState::Confirmed,
            TunObservationComponentState::Confirmed,
            TunObservationComponentState::Confirmed,
            TunObservationComponentState::Confirmed,
            observed_at,
        )
    }

    pub fn is_fresh_at(&self, now: u64) -> bool {
        self.schema_version == TUN_OBSERVATION_SCHEMA_VERSION
            && self.observed_at <= now.saturating_add(1_000)
            && now.saturating_sub(self.observed_at) <= TUN_OBSERVATION_MAX_AGE_MILLISECONDS
    }

    pub fn confirms_enabled_at(&self, now: u64) -> bool {
        self.is_fresh_at(now)
            && self.core == TunObservationComponentState::Confirmed
            && self.interface == TunObservationComponentState::Confirmed
            && self.routes == TunObservationComponentState::Confirmed
            && self.dns == TunObservationComponentState::Confirmed
    }

    pub fn confirms_disabled_at(&self, now: u64) -> bool {
        self.is_fresh_at(now)
            && self.interface == TunObservationComponentState::Absent
            && self.routes == TunObservationComponentState::Absent
            && self.dns == TunObservationComponentState::Absent
    }

    pub fn failure_kind_at(&self, now: u64) -> TunHelperFailureKind {
        if !self.is_fresh_at(now) {
            return TunHelperFailureKind::ObservationStale;
        }
        if [self.core, self.interface, self.routes, self.dns]
            .contains(&TunObservationComponentState::Foreign)
        {
            return TunHelperFailureKind::ObservationForeign;
        }
        TunHelperFailureKind::ObservationPartial
    }
}

pub fn tun_observation_now() -> u64 {
    let milliseconds = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    u64::try_from(milliseconds).unwrap_or(u64::MAX)
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TunHelperSnapshot {
    pub availability: TunHelperAvailability,
    pub expected_version: String,
    pub health: TunHelperHealth,
    pub installation_id: Option<String>,
    pub installed_version: Option<String>,
    pub last_failure: Option<TunHelperFailureKind>,
    pub phase: TunHelperLifecyclePhase,
}

impl TunHelperSnapshot {
    pub fn unavailable(
        availability: TunHelperAvailability,
        health: TunHelperHealth,
        failure: TunHelperFailureKind,
    ) -> Self {
        Self {
            availability,
            expected_version: TUN_HELPER_EXPECTED_VERSION.to_owned(),
            health,
            installation_id: None,
            installed_version: None,
            last_failure: Some(failure),
            phase: TunHelperLifecyclePhase::Idle,
        }
    }

    pub fn browser_unavailable() -> Self {
        Self {
            availability: TunHelperAvailability::Unavailable,
            expected_version: TUN_HELPER_EXPECTED_VERSION.to_owned(),
            health: TunHelperHealth::NotInstalled,
            installation_id: None,
            installed_version: None,
            last_failure: None,
            phase: TunHelperLifecyclePhase::Idle,
        }
    }

    pub fn is_healthy(&self) -> bool {
        self.has_healthy_identity()
            && self.phase == TunHelperLifecyclePhase::Idle
            && self.last_failure.is_none()
    }

    fn has_healthy_identity(&self) -> bool {
        self.availability == TunHelperAvailability::Available
            && self.health == TunHelperHealth::Healthy
            && self.installed_version.as_deref() == Some(self.expected_version.as_str())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TunHelperObservation {
    pub availability: TunHelperAvailability,
    pub health: TunHelperHealth,
    pub installation_id: Option<String>,
    pub installed_version: Option<String>,
    pub last_failure: Option<TunHelperFailureKind>,
}

impl TunHelperObservation {
    pub fn not_installed() -> Self {
        Self {
            availability: TunHelperAvailability::PermissionRequired,
            health: TunHelperHealth::NotInstalled,
            installation_id: None,
            installed_version: None,
            last_failure: None,
        }
    }

    pub fn healthy(version: impl Into<String>) -> Self {
        Self {
            availability: TunHelperAvailability::Available,
            health: TunHelperHealth::Healthy,
            installation_id: None,
            installed_version: Some(version.into()),
            last_failure: None,
        }
    }

    pub fn healthy_installation(
        version: impl Into<String>,
        installation_id: impl Into<String>,
    ) -> Self {
        Self {
            availability: TunHelperAvailability::Available,
            health: TunHelperHealth::Healthy,
            installation_id: Some(installation_id.into()),
            installed_version: Some(version.into()),
            last_failure: None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TunHelperLifecycleOperation {
    Install,
    Remove,
    Repair,
}

#[derive(Clone, Debug)]
pub struct TunHelperError {
    pub kind: TunHelperFailureKind,
    message: &'static str,
}

impl TunHelperError {
    pub const fn new(kind: TunHelperFailureKind, message: &'static str) -> Self {
        Self { kind, message }
    }
}

impl fmt::Display for TunHelperError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.message)
    }
}

impl std::error::Error for TunHelperError {}

pub trait TunHelperPlatform: Send + Sync {
    fn initial_snapshot(&self) -> TunHelperSnapshot;

    fn observe_helper(&self) -> BoxFuture<'_, Result<TunHelperObservation, TunHelperError>>;

    fn run_lifecycle(
        &self,
        operation: TunHelperLifecycleOperation,
    ) -> BoxFuture<'_, Result<(), TunHelperError>>;

    fn observe_tun(&self) -> BoxFuture<'_, Result<TunNetworkObservation, TunHelperError>>;

    fn set_tun_enabled(&self, enabled: bool) -> BoxFuture<'_, Result<(), TunHelperError>>;
}

pub struct TunHelperController {
    operation: AsyncMutex<()>,
    platform: std::sync::Arc<dyn TunHelperPlatform>,
    runtime_failure: Mutex<Option<TunHelperFailureKind>>,
    snapshot: Mutex<TunHelperSnapshot>,
}

impl TunHelperController {
    pub fn new(platform: std::sync::Arc<dyn TunHelperPlatform>) -> Self {
        let snapshot = platform.initial_snapshot();
        Self {
            operation: AsyncMutex::new(()),
            platform,
            runtime_failure: Mutex::new(None),
            snapshot: Mutex::new(snapshot),
        }
    }

    pub fn snapshot(&self) -> TunHelperSnapshot {
        self.snapshot
            .lock()
            .expect("TUN helper snapshot lock poisoned")
            .clone()
    }

    pub async fn refresh(&self) -> TunHelperSnapshot {
        let _operation = self.operation.lock().await;
        self.refresh_locked(None).await
    }

    pub fn mark_runtime_unavailable(&self, failure: TunHelperFailureKind) {
        let mut runtime_failure = self
            .runtime_failure
            .lock()
            .expect("TUN helper runtime failure lock poisoned");
        *runtime_failure = Some(failure);
        let mut snapshot = self
            .snapshot
            .lock()
            .expect("TUN helper snapshot lock poisoned");
        snapshot.availability = TunHelperAvailability::Unavailable;
        snapshot.phase = TunHelperLifecyclePhase::Failed;
        snapshot.last_failure = Some(failure);
    }

    pub async fn install(&self) -> Result<TunHelperSnapshot, TunHelperError> {
        self.run_lifecycle(TunHelperLifecycleOperation::Install)
            .await
    }

    pub async fn repair(&self) -> Result<TunHelperSnapshot, TunHelperError> {
        self.run_lifecycle(TunHelperLifecycleOperation::Repair)
            .await
    }

    pub async fn remove(&self) -> Result<TunHelperSnapshot, TunHelperError> {
        self.run_lifecycle(TunHelperLifecycleOperation::Remove)
            .await
    }

    pub async fn observe_tun(&self) -> Result<TunNetworkObservation, TunHelperError> {
        let _operation = self.operation.lock().await;
        self.observe_tun_locked().await
    }

    async fn observe_tun_locked(&self) -> Result<TunNetworkObservation, TunHelperError> {
        if !self.snapshot().has_healthy_identity() {
            return Err(TunHelperError::new(
                TunHelperFailureKind::ConnectionFailed,
                "The TUN helper is not healthy",
            ));
        }
        match self.platform.observe_tun().await {
            Ok(observed) => Ok(observed),
            Err(error) => {
                self.record_failure(error.kind);
                Err(error)
            }
        }
    }

    pub async fn set_tun_enabled(
        &self,
        enabled: bool,
    ) -> Result<TunNetworkObservation, TunHelperError> {
        let _operation = self.operation.lock().await;
        if !self.snapshot().has_healthy_identity() {
            return Err(TunHelperError::new(
                TunHelperFailureKind::ConnectionFailed,
                "The TUN helper is not healthy",
            ));
        }
        if let Err(error) = self.platform.set_tun_enabled(enabled).await {
            self.record_failure(error.kind);
            return Err(error);
        }
        let observed = self.observe_tun_locked().await?;
        let confirmed = if enabled {
            observed.confirms_enabled_at(tun_observation_now())
        } else {
            observed.confirms_disabled_at(tun_observation_now())
        };
        if !confirmed {
            let kind = observed.failure_kind_at(tun_observation_now());
            return Err(TunHelperError::new(
                kind,
                "The TUN helper did not confirm the requested state",
            ));
        }
        self.clear_failure();
        Ok(observed)
    }

    async fn run_lifecycle(
        &self,
        operation: TunHelperLifecycleOperation,
    ) -> Result<TunHelperSnapshot, TunHelperError> {
        let _operation = self.operation.lock().await;
        if matches!(
            operation,
            TunHelperLifecycleOperation::Repair | TunHelperLifecycleOperation::Remove
        ) && self.snapshot().has_healthy_identity()
        {
            if let Err(error) = self.platform.set_tun_enabled(false).await {
                self.record_failure(error.kind);
                return Err(error);
            }
            let observed = match self.platform.observe_tun().await {
                Ok(observed) => observed,
                Err(error) => {
                    self.record_failure(error.kind);
                    return Err(error);
                }
            };
            if !observed.confirms_disabled_at(tun_observation_now()) {
                let kind = observed.failure_kind_at(tun_observation_now());
                let error = TunHelperError::new(
                    kind,
                    "TUN remained enabled before the helper lifecycle operation",
                );
                self.record_failure(error.kind);
                return Err(error);
            }
        }
        self.set_phase(match operation {
            TunHelperLifecycleOperation::Install => TunHelperLifecyclePhase::Installing,
            TunHelperLifecycleOperation::Repair => TunHelperLifecyclePhase::Repairing,
            TunHelperLifecycleOperation::Remove => TunHelperLifecyclePhase::Removing,
        });
        let result = self.platform.run_lifecycle(operation).await;
        let failure = result.as_ref().err().map(|error| error.kind);
        let observed = self.refresh_locked(failure).await;
        result?;
        let confirmed = match operation {
            TunHelperLifecycleOperation::Install | TunHelperLifecycleOperation::Repair => {
                observed.is_healthy()
            }
            TunHelperLifecycleOperation::Remove => {
                observed.health == TunHelperHealth::NotInstalled
                    && observed.installed_version.is_none()
            }
        };
        if confirmed {
            if operation == TunHelperLifecycleOperation::Remove {
                *self
                    .runtime_failure
                    .lock()
                    .expect("TUN helper runtime failure lock poisoned") = None;
                let unblocked = self.refresh_locked(None).await;
                if unblocked.health != TunHelperHealth::NotInstalled
                    || unblocked.installed_version.is_some()
                    || unblocked.availability == TunHelperAvailability::Unavailable
                {
                    let error = TunHelperError::new(
                        TunHelperFailureKind::ConfirmationFailed,
                        "The TUN helper removal could not be confirmed after recovery cleared",
                    );
                    self.record_failure(error.kind);
                    return Err(error);
                }
                return Ok(unblocked);
            }
            return Ok(observed);
        }
        if matches!(
            operation,
            TunHelperLifecycleOperation::Install | TunHelperLifecycleOperation::Repair
        ) && observed.health == TunHelperHealth::Healthy
            && observed.installed_version.as_deref() == Some(TUN_HELPER_EXPECTED_VERSION)
            && let Some(runtime_failure) = *self
                .runtime_failure
                .lock()
                .expect("TUN helper runtime failure lock poisoned")
        {
            return Err(TunHelperError::new(
                runtime_failure,
                "The helper was repaired, but this application session remains unavailable",
            ));
        }
        let error = TunHelperError::new(
            TunHelperFailureKind::ConfirmationFailed,
            "The TUN helper lifecycle result could not be confirmed",
        );
        self.record_failure(error.kind);
        Err(error)
    }

    async fn refresh_locked(
        &self,
        operation_failure: Option<TunHelperFailureKind>,
    ) -> TunHelperSnapshot {
        match self.platform.observe_helper().await {
            Ok(observation) => {
                let mut snapshot = snapshot_from_observation(observation);
                let runtime_failure = self
                    .runtime_failure
                    .lock()
                    .expect("TUN helper runtime failure lock poisoned");
                if let Some(failure) = (*runtime_failure).or(operation_failure) {
                    snapshot.availability = TunHelperAvailability::Unavailable;
                    snapshot.phase = TunHelperLifecyclePhase::Failed;
                    snapshot.last_failure = Some(failure);
                }
                *self
                    .snapshot
                    .lock()
                    .expect("TUN helper snapshot lock poisoned") = snapshot.clone();
                snapshot
            }
            Err(error) => {
                self.record_failure(operation_failure.unwrap_or(error.kind));
                self.snapshot()
            }
        }
    }

    fn set_phase(&self, phase: TunHelperLifecyclePhase) {
        let mut snapshot = self
            .snapshot
            .lock()
            .expect("TUN helper snapshot lock poisoned");
        snapshot.phase = phase;
        snapshot.last_failure = None;
    }

    fn record_failure(&self, failure: TunHelperFailureKind) {
        let runtime_failure = self
            .runtime_failure
            .lock()
            .expect("TUN helper runtime failure lock poisoned");
        let failure = (*runtime_failure).unwrap_or(failure);
        let mut snapshot = self
            .snapshot
            .lock()
            .expect("TUN helper snapshot lock poisoned");
        snapshot.phase = TunHelperLifecyclePhase::Failed;
        snapshot.last_failure = Some(failure);
    }

    fn clear_failure(&self) {
        let mut snapshot = self
            .snapshot
            .lock()
            .expect("TUN helper snapshot lock poisoned");
        snapshot.phase = TunHelperLifecyclePhase::Idle;
        snapshot.last_failure = None;
    }
}

fn snapshot_from_observation(observation: TunHelperObservation) -> TunHelperSnapshot {
    let version_matches =
        observation.installed_version.as_deref() == Some(TUN_HELPER_EXPECTED_VERSION);
    let mut snapshot = TunHelperSnapshot {
        availability: observation.availability,
        expected_version: TUN_HELPER_EXPECTED_VERSION.to_owned(),
        health: observation.health,
        installation_id: observation.installation_id,
        installed_version: observation.installed_version,
        last_failure: observation.last_failure,
        phase: TunHelperLifecyclePhase::Idle,
    };
    if snapshot.health == TunHelperHealth::Healthy && !version_matches {
        snapshot.availability = TunHelperAvailability::RepairRequired;
        snapshot.health = TunHelperHealth::VersionMismatch;
        snapshot.last_failure = Some(TunHelperFailureKind::VersionMismatch);
    } else if snapshot.last_failure.is_none() {
        snapshot.last_failure = match snapshot.availability {
            TunHelperAvailability::Unpackaged => Some(TunHelperFailureKind::Unpackaged),
            TunHelperAvailability::UnsignedApp => Some(TunHelperFailureKind::UnsignedApp),
            TunHelperAvailability::UnsupportedSystem => {
                Some(TunHelperFailureKind::UnsupportedSystem)
            }
            TunHelperAvailability::Available
            | TunHelperAvailability::PermissionRequired
            | TunHelperAvailability::RepairRequired
            | TunHelperAvailability::Unavailable => None,
        };
    }
    snapshot
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TunHelperPeerIdentity {
    pub signed: bool,
    pub signing_identifier: String,
    pub team_identifier: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum TunHelperWireCommand {
    DisableTun,
    EnableTun,
    Health,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TunHelperWireRequest {
    pub command: TunHelperWireCommand,
    pub protocol_version: u16,
}

pub fn decode_tun_helper_request(
    bytes: &[u8],
    peer: &TunHelperPeerIdentity,
    expected_team_identifier: &str,
) -> Result<TunHelperWireRequest, TunHelperError> {
    if bytes.len() > TUN_HELPER_MAX_MESSAGE_BYTES {
        return Err(TunHelperError::new(
            TunHelperFailureKind::MessageTooLarge,
            "The TUN helper message exceeded the fixed size limit",
        ));
    }
    validate_peer_identity(peer, TUN_APP_SIGNING_IDENTIFIER, expected_team_identifier)?;
    let request: TunHelperWireRequest = serde_json::from_slice(bytes).map_err(|_| {
        TunHelperError::new(
            TunHelperFailureKind::ProtocolMismatch,
            "The TUN helper message did not match the closed protocol",
        )
    })?;
    if request.protocol_version != TUN_HELPER_PROTOCOL_VERSION {
        return Err(TunHelperError::new(
            TunHelperFailureKind::ProtocolMismatch,
            "The TUN helper protocol version did not match",
        ));
    }
    Ok(request)
}

pub fn validate_tun_helper_peer(
    peer: &TunHelperPeerIdentity,
    expected_team_identifier: &str,
) -> Result<(), TunHelperError> {
    validate_peer_identity(
        peer,
        TUN_HELPER_SIGNING_IDENTIFIER,
        expected_team_identifier,
    )
}

fn validate_peer_identity(
    peer: &TunHelperPeerIdentity,
    expected_signing_identifier: &str,
    expected_team_identifier: &str,
) -> Result<(), TunHelperError> {
    if !peer.signed
        || peer.signing_identifier != expected_signing_identifier
        || peer.team_identifier.as_deref() != Some(expected_team_identifier)
    {
        return Err(TunHelperError::new(
            TunHelperFailureKind::IdentityRejected,
            "The TUN helper peer identity was rejected",
        ));
    }
    Ok(())
}
