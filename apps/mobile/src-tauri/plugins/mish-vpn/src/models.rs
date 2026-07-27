use serde::{Deserialize, Serialize};

#[cfg(not(target_os = "android"))]
pub const CONTRACT_VERSION: u8 = 1;
pub const MOBILE_CORE_MAX_CONFIG_BYTES_V1: usize = 1_048_576;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileVpnSnapshot {
    pub backend_kind: String,
    pub contract_version: u8,
    pub core_abi_version: Option<u8>,
    pub core_availability: String,
    pub core_commit: Option<String>,
    pub core_version: Option<String>,
    pub core_wrapper_revision: Option<String>,
    pub foreground: bool,
    pub message: String,
    pub notification_permission: String,
    pub permission: String,
    pub phase: String,
    pub sequence: u64,
    pub session_id: String,
    pub updated_at_millis: u64,
    pub vpn_active: bool,
}

impl MobileVpnSnapshot {
    #[cfg(not(target_os = "android"))]
    pub(crate) fn unsupported() -> Self {
        Self {
            backend_kind: "fixture".into(),
            contract_version: CONTRACT_VERSION,
            core_abi_version: None,
            core_availability: "unavailable".into(),
            core_commit: None,
            core_version: None,
            core_wrapper_revision: None,
            foreground: false,
            message: "The Android VPN lifecycle fixture is unavailable on this platform.".into(),
            notification_permission: "not-required".into(),
            permission: "unknown".into(),
            phase: "unavailable".into(),
            sequence: 0,
            session_id: "non-android-fixture".into(),
            updated_at_millis: 0,
            vpn_active: false,
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
}
