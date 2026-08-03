use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::lifecycle::{
    LifecycleFailure, LifecycleOperation, LifecycleOperationOutcome, LifecyclePhase, LifecycleState,
};

pub const CONTRACT_VERSION: u8 = 1;
pub const MOBILE_CORE_MAX_CONFIG_BYTES_V1: usize = 1_048_576;
pub const MOBILE_CORE_MAX_LOAD_TIMEOUT_MILLIS: u64 = 30_000;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileVpnSnapshot {
    pub activation_session_id: Option<String>,
    pub active_network: bool,
    pub authority_id: String,
    pub backend_kind: String,
    pub contract_version: u8,
    pub core_abi_version: Option<u8>,
    pub core_availability: String,
    pub core_commit: Option<String>,
    pub config_failure_injection_available: bool,
    pub core_version: Option<String>,
    pub core_wrapper_revision: Option<String>,
    pub core_config_state: String,
    pub core_running: bool,
    pub dns_applied: bool,
    pub failure: Option<LifecycleFailure>,
    pub foreground: bool,
    pub loaded_config_digest: Option<String>,
    pub loaded_config_revision: Option<String>,
    pub message: String,
    pub notification_permission: String,
    pub operation: Option<LifecycleOperation>,
    pub permission: String,
    pub phase: String,
    pub protected_socket_count: u64,
    pub public_request_observed: bool,
    pub revision: u64,
    pub sequence: u64,
    pub session_id: String,
    pub routes_applied: bool,
    pub tun_established: bool,
    pub updated_at_millis: u64,
    pub validated_config_digest: Option<String>,
    pub validated_config_revision: Option<String>,
    pub vpn_active: bool,
    pub vpn_availability: String,
    pub tun_availability: String,
}

impl MobileVpnSnapshot {
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn from_lifecycle(state: &LifecycleState) -> Self {
        let message = match state.phase {
            LifecyclePhase::Stopped => {
                "Android VPN lifecycle stopped safely. No TUN or Mobile Core is running."
            }
            LifecyclePhase::PermissionRequired => {
                "Android VPN permission is required. No service or traffic capture was started."
            }
            LifecyclePhase::Starting => {
                "Android VPN activation is pending complete native observation."
            }
            LifecyclePhase::Running => {
                "Android VPN, TUN, Mobile Core, protected sockets, and public traffic are observed."
            }
            LifecyclePhase::Stopping => {
                "Stopping Android VPN and cleaning up Mish-owned native resources."
            }
            LifecyclePhase::Failed => {
                "The Android lifecycle failed safely without exposing platform details."
            }
            LifecyclePhase::RecoveryRequired => {
                "The previous Android lifecycle outcome is unknown. Stop and retry explicitly."
            }
            LifecyclePhase::Unavailable => {
                "Android VPN is waiting for a usable underlying network."
            }
        };
        Self {
            activation_session_id: state.facts.activation_session_id.clone(),
            active_network: state.facts.active_network,
            authority_id: state.authority_id.clone(),
            backend_kind: "native".into(),
            contract_version: CONTRACT_VERSION,
            core_abi_version: state.facts.core_abi_version,
            core_availability: state.facts.core_availability.clone(),
            core_commit: state.facts.core_commit.clone(),
            config_failure_injection_available: state.facts.config_failure_injection_available,
            core_version: state.facts.core_version.clone(),
            core_wrapper_revision: state.facts.core_wrapper_revision.clone(),
            core_config_state: state.facts.core_config_state.clone(),
            core_running: state.facts.core_running,
            dns_applied: state.facts.dns_applied,
            failure: state.failure,
            foreground: state.facts.service_foreground,
            loaded_config_digest: state.facts.loaded_config_digest.clone(),
            loaded_config_revision: state.facts.loaded_config_revision.clone(),
            message: message.into(),
            notification_permission: state.facts.notification_permission.clone(),
            operation: state.latest_operation(),
            permission: state.facts.vpn_permission.clone(),
            phase: phase_wire_name(state.phase).into(),
            protected_socket_count: state.facts.protected_socket_count,
            public_request_observed: state.facts.public_request_observed,
            revision: state.revision,
            sequence: state.sequence,
            session_id: state.session_id.clone(),
            routes_applied: state.facts.routes_applied,
            tun_established: state.facts.tun_established,
            updated_at_millis: state.facts.observed_at_millis,
            validated_config_digest: state.facts.validated_config_digest.clone(),
            validated_config_revision: state.facts.validated_config_revision.clone(),
            vpn_active: state.facts.tun_established,
            vpn_availability: "available".into(),
            tun_availability: "available".into(),
        }
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn unsupported() -> Self {
        Self {
            activation_session_id: None,
            active_network: false,
            authority_id: "non-android-authority".into(),
            backend_kind: "fixture".into(),
            contract_version: CONTRACT_VERSION,
            core_abi_version: None,
            core_availability: "unavailable".into(),
            core_commit: None,
            config_failure_injection_available: false,
            core_version: None,
            core_wrapper_revision: None,
            core_config_state: "unloaded".into(),
            core_running: false,
            dns_applied: false,
            failure: Some(LifecycleFailure::PlatformFailure),
            foreground: false,
            loaded_config_digest: None,
            loaded_config_revision: None,
            message: "The Android VPN lifecycle fixture is unavailable on this platform.".into(),
            notification_permission: "not-required".into(),
            operation: None,
            permission: "unknown".into(),
            phase: "unavailable".into(),
            protected_socket_count: 0,
            public_request_observed: false,
            revision: 0,
            sequence: 0,
            session_id: "non-android-fixture".into(),
            routes_applied: false,
            tun_established: false,
            updated_at_millis: 0,
            validated_config_digest: None,
            validated_config_revision: None,
            vpn_active: false,
            vpn_availability: "unavailable".into(),
            tun_availability: "unavailable".into(),
        }
    }
}

#[cfg_attr(not(target_os = "android"), allow(dead_code))]
fn phase_wire_name(phase: LifecyclePhase) -> &'static str {
    match phase {
        LifecyclePhase::Stopped => "stopped",
        LifecyclePhase::PermissionRequired => "permission-required",
        LifecyclePhase::Starting => "starting",
        LifecyclePhase::Running => "running",
        LifecyclePhase::Stopping => "stopping",
        LifecyclePhase::Failed => "failed",
        LifecyclePhase::RecoveryRequired => "recovery-required",
        LifecyclePhase::Unavailable => "unavailable",
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileVpnCommandRequest {
    pub operation_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MobileVpnCommandResult {
    pub contract_version: u8,
    pub operation: LifecycleOperation,
    pub snapshot: MobileVpnSnapshot,
}

impl MobileVpnCommandResult {
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn from_state(state: &LifecycleState, operation_id: &str) -> Option<Self> {
        let operation = state.operation(operation_id)?.clone();
        if operation.outcome == LifecycleOperationOutcome::Pending {
            return None;
        }
        Some(Self::bind_operation(
            operation,
            MobileVpnSnapshot::from_lifecycle(state),
        ))
    }

    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn invalid(
        operation_id: String,
        kind: crate::lifecycle::LifecycleCommandKind,
        snapshot: MobileVpnSnapshot,
    ) -> Self {
        Self::bind_operation(
            LifecycleOperation {
                failure: Some(LifecycleFailure::InvalidCommand),
                kind,
                operation_id,
                outcome: LifecycleOperationOutcome::Rejected,
            },
            snapshot,
        )
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn unsupported(
        operation_id: String,
        kind: crate::lifecycle::LifecycleCommandKind,
    ) -> Self {
        Self::bind_operation(
            LifecycleOperation {
                failure: Some(LifecycleFailure::PlatformFailure),
                kind,
                operation_id,
                outcome: LifecycleOperationOutcome::Unknown,
            },
            MobileVpnSnapshot::unsupported(),
        )
    }

    fn bind_operation(operation: LifecycleOperation, mut snapshot: MobileVpnSnapshot) -> Self {
        snapshot.operation = Some(operation.clone());
        Self {
            contract_version: CONTRACT_VERSION,
            operation,
            snapshot,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) struct MobileVpnEvent {
    pub authority_id: String,
    pub event_kind: &'static str,
    pub event_version: u8,
    pub revision: u64,
    pub sequence: u64,
    pub session_id: String,
    pub snapshot: MobileVpnSnapshot,
}

impl MobileVpnEvent {
    #[cfg_attr(not(target_os = "android"), allow(dead_code))]
    pub(crate) fn from_state(state: &LifecycleState) -> Self {
        Self {
            authority_id: state.authority_id.clone(),
            event_kind: "snapshot-changed",
            event_version: 2,
            revision: state.revision,
            sequence: state.sequence,
            session_id: state.session_id.clone(),
            snapshot: MobileVpnSnapshot::from_lifecycle(state),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileConfigValidationRequest {
    pub config_bytes: Vec<u8>,
    pub sequence: u64,
    pub session_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileConfigValidationOutcome {
    Valid,
    Invalid,
    Failed,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileConfigValidationFailure {
    Cancelled,
    ClientUninitialized,
    ConfigurationRejected,
    ConfigurationTooLarge,
    CoreInitializationFailed,
    CoreUnavailable,
    DuplicateCommand,
    MalformedNativeResponse,
    NativeResponseTooLarge,
    NativeValidationFailed,
    PluginFailure,
    StaleAuthority,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileConfigValidationResult {
    pub contract_version: u8,
    pub failure: Option<MobileConfigValidationFailure>,
    pub message: String,
    pub outcome: MobileConfigValidationOutcome,
    pub sequence: Option<u64>,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileConfigLoadRequest {
    pub config_bytes: Vec<u8>,
    pub digest: String,
    pub inject_failure: bool,
    pub operation_id: String,
    pub revision: String,
    pub sequence: u64,
    pub session_id: String,
    pub timeout_millis: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileConfigLoadOutcome {
    FirstLoad,
    Replacement,
    NoOp,
    Failed,
    Cancelled,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileConfigLoadFailure {
    Cancelled,
    ConfigurationRejected,
    ConfigurationTooLarge,
    CoreInitializationFailed,
    CoreUnavailable,
    DigestMismatch,
    DuplicateCommand,
    InvalidInput,
    JniException,
    KotlinException,
    MalformedNativeResponse,
    NativeLoadRejected,
    NativeResponseTooLarge,
    PluginFailure,
    RuntimeReplaced,
    StaleAuthority,
    Timeout,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileConfigLoadTiming {
    OnTime,
    TimedOut,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileConfigLoadCancellation {
    NotRequested,
    BeforeLoad,
    TooLate,
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum MobileConfigRollback {
    NotNeeded,
    Preserved,
    Unloaded,
    Unknown,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileConfigLoadResult {
    pub cancellation: MobileConfigLoadCancellation,
    pub contract_version: u8,
    pub digest: String,
    pub failure: Option<MobileConfigLoadFailure>,
    pub message: String,
    pub operation_id: String,
    pub outcome: MobileConfigLoadOutcome,
    pub revision: String,
    pub rollback: MobileConfigRollback,
    pub snapshot: Option<MobileVpnSnapshot>,
    pub timing: MobileConfigLoadTiming,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileConfigCancelRequest {
    pub operation_id: String,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileConfigCancelResult {
    pub accepted: bool,
    pub contract_version: u8,
    pub operation_id: String,
}

impl MobileConfigLoadResult {
    pub(crate) fn preflight(request: &MobileConfigLoadRequest) -> Option<Self> {
        let failure = if request.session_id.is_empty() || request.session_id.len() > 128 {
            Some((
                MobileConfigLoadFailure::StaleAuthority,
                "The mobile runtime authority is stale.",
            ))
        } else if request.operation_id.is_empty()
            || request.operation_id.len() > 128
            || request.revision.is_empty()
            || request.revision.len() > 128
            || !valid_digest(&request.digest)
            || request.timeout_millis == 0
            || request.timeout_millis > MOBILE_CORE_MAX_LOAD_TIMEOUT_MILLIS
        {
            Some((
                MobileConfigLoadFailure::InvalidInput,
                "The configuration load identity is invalid.",
            ))
        } else if request.config_bytes.is_empty() {
            Some((
                MobileConfigLoadFailure::InvalidInput,
                "The configuration load input is empty.",
            ))
        } else if request.config_bytes.len() > MOBILE_CORE_MAX_CONFIG_BYTES_V1 {
            Some((
                MobileConfigLoadFailure::ConfigurationTooLarge,
                "Configuration exceeds the Mobile Core v1 size limit.",
            ))
        } else if format!("{:x}", Sha256::digest(&request.config_bytes)) != request.digest {
            Some((
                MobileConfigLoadFailure::DigestMismatch,
                "The configuration bytes do not match the admitted digest.",
            ))
        } else {
            None
        };
        failure.map(|(failure, message)| Self::failure(request, failure, message, None))
    }

    pub(crate) fn plugin_failure(
        request: &MobileConfigLoadRequest,
        snapshot: Option<MobileVpnSnapshot>,
    ) -> Self {
        Self::failure(
            request,
            MobileConfigLoadFailure::PluginFailure,
            "The Android configuration load plugin failed safely.",
            snapshot,
        )
    }

    #[cfg(not(target_os = "android"))]
    pub(crate) fn with_failure(mut self, failure: MobileConfigLoadFailure, message: &str) -> Self {
        self.failure = Some(failure);
        self.message = message.into();
        self
    }

    pub(crate) fn failure(
        request: &MobileConfigLoadRequest,
        failure: MobileConfigLoadFailure,
        message: &str,
        snapshot: Option<MobileVpnSnapshot>,
    ) -> Self {
        let rollback = match snapshot
            .as_ref()
            .map(|value| value.core_config_state.as_str())
        {
            Some("loaded") => MobileConfigRollback::Preserved,
            Some("unloaded") => MobileConfigRollback::Unloaded,
            _ => MobileConfigRollback::Unknown,
        };
        Self {
            cancellation: MobileConfigLoadCancellation::NotRequested,
            contract_version: 1,
            digest: request.digest.clone(),
            failure: Some(failure),
            message: message.into(),
            operation_id: request.operation_id.clone(),
            outcome: MobileConfigLoadOutcome::Failed,
            revision: request.revision.clone(),
            rollback,
            snapshot,
            timing: MobileConfigLoadTiming::OnTime,
        }
    }
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

impl MobileConfigValidationResult {
    pub(crate) fn failure(
        failure: MobileConfigValidationFailure,
        message: &str,
        sequence: u64,
        session_id: &str,
    ) -> Self {
        Self {
            contract_version: 1,
            failure: Some(failure),
            message: message.into(),
            outcome: MobileConfigValidationOutcome::Failed,
            sequence: Some(sequence),
            session_id: Some(session_id.into()),
        }
    }

    pub(crate) fn preflight(request: &MobileConfigValidationRequest) -> Option<Self> {
        if request.session_id.is_empty() || request.session_id.len() > 128 {
            return Some(Self {
                contract_version: 1,
                failure: Some(MobileConfigValidationFailure::StaleAuthority),
                message: "The mobile runtime authority is stale.".into(),
                outcome: MobileConfigValidationOutcome::Failed,
                sequence: None,
                session_id: None,
            });
        }
        if request.config_bytes.len() > MOBILE_CORE_MAX_CONFIG_BYTES_V1 {
            return Some(Self::failure(
                MobileConfigValidationFailure::ConfigurationTooLarge,
                "Configuration exceeds the Mobile Core v1 size limit.",
                request.sequence,
                &request.session_id,
            ));
        }
        None
    }

    #[cfg(any(target_os = "android", test))]
    pub(crate) fn plugin_failure(request: &MobileConfigValidationRequest) -> Self {
        Self::failure(
            MobileConfigValidationFailure::PluginFailure,
            "The Android validation plugin failed safely.",
            request.sequence,
            &request.session_id,
        )
    }
}

#[cfg(test)]
mod validation_tests {
    use super::*;

    fn request(length: usize) -> MobileConfigValidationRequest {
        MobileConfigValidationRequest {
            config_bytes: vec![0; length],
            sequence: 7,
            session_id: "fixture-session".into(),
        }
    }

    #[test]
    fn accepts_only_bounded_config_and_authority() {
        assert!(MobileConfigValidationResult::preflight(&request(32)).is_none());
        let oversized =
            MobileConfigValidationResult::preflight(&request(MOBILE_CORE_MAX_CONFIG_BYTES_V1 + 1))
                .expect("oversized input must fail");
        assert_eq!(
            oversized.failure,
            Some(MobileConfigValidationFailure::ConfigurationTooLarge)
        );

        let mut stale = request(1);
        stale.session_id.clear();
        assert_eq!(
            MobileConfigValidationResult::preflight(&stale)
                .expect("empty authority must fail")
                .session_id,
            None
        );
        assert_eq!(
            MobileConfigValidationResult::preflight(&stale)
                .expect("empty authority must fail")
                .failure,
            Some(MobileConfigValidationFailure::StaleAuthority)
        );
    }

    #[test]
    fn plugin_failure_is_bounded_and_redacted() {
        let result = MobileConfigValidationResult::plugin_failure(&request(1));
        assert_eq!(
            result.failure,
            Some(MobileConfigValidationFailure::PluginFailure)
        );
        assert!(result.message.len() <= 256);
        assert!(!result.message.contains("config"));
    }

    fn load_request(config: &[u8]) -> MobileConfigLoadRequest {
        MobileConfigLoadRequest {
            config_bytes: config.to_vec(),
            digest: format!("{:x}", Sha256::digest(config)),
            inject_failure: false,
            operation_id: "load-operation".into(),
            revision: "fixture-revision".into(),
            sequence: 7,
            session_id: "fixture-session".into(),
            timeout_millis: 5_000,
        }
    }

    #[test]
    fn load_preflight_binds_exact_bytes_revision_and_digest() {
        let config = b"mode: rule\nproxies: []\nrules: []\n";
        assert!(MobileConfigLoadResult::preflight(&load_request(config)).is_none());

        let mut mismatched = load_request(config);
        mismatched.config_bytes.push(b' ');
        let result = MobileConfigLoadResult::preflight(&mismatched)
            .expect("digest mismatch must fail before the Android bridge");
        assert_eq!(
            result.failure,
            Some(MobileConfigLoadFailure::DigestMismatch)
        );
        assert!(result.snapshot.is_none());

        let mut invalid = load_request(config);
        invalid.operation_id = "x".repeat(129);
        assert_eq!(
            MobileConfigLoadResult::preflight(&invalid)
                .expect("operation identity must stay bounded")
                .failure,
            Some(MobileConfigLoadFailure::InvalidInput)
        );
    }
}
