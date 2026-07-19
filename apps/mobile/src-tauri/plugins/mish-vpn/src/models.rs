use serde::{Deserialize, Serialize};

#[cfg(not(target_os = "android"))]
pub const CONTRACT_VERSION: u8 = 1;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileVpnSnapshot {
    pub backend_kind: String,
    pub contract_version: u8,
    pub core_availability: String,
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
            core_availability: "unavailable".into(),
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
