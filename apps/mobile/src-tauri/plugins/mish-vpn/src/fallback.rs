use tauri::{AppHandle, Runtime, plugin::PluginApi};

use crate::{
    MobileConfigValidationFailure, MobileConfigValidationRequest, MobileConfigValidationResult,
    MobileVpnSnapshot, Result,
};

#[derive(Clone)]
pub struct MishVpn<R: Runtime>(AppHandle<R>);

pub fn init<R: Runtime>(app: &AppHandle<R>, _api: PluginApi<R, ()>) -> Result<MishVpn<R>> {
    Ok(MishVpn(app.clone()))
}

impl<R: Runtime> MishVpn<R> {
    pub fn get_snapshot(&self) -> Result<MobileVpnSnapshot> {
        Ok(MobileVpnSnapshot::unsupported())
    }

    pub fn request_notification_permission(&self) -> Result<MobileVpnSnapshot> {
        self.get_snapshot()
    }

    pub fn request_vpn_consent(&self) -> Result<MobileVpnSnapshot> {
        self.get_snapshot()
    }

    pub fn start_fixture_lifecycle(&self) -> Result<MobileVpnSnapshot> {
        self.get_snapshot()
    }

    pub fn stop(&self) -> Result<MobileVpnSnapshot> {
        self.get_snapshot()
    }

    pub fn validate_config(
        &self,
        request: MobileConfigValidationRequest,
    ) -> MobileConfigValidationResult {
        if let Some(result) = MobileConfigValidationResult::preflight(&request) {
            return result;
        }
        let snapshot = MobileVpnSnapshot::unsupported();
        if snapshot.sequence != request.sequence || snapshot.session_id != request.session_id {
            return MobileConfigValidationResult::failure(
                MobileConfigValidationFailure::StaleAuthority,
                "The mobile runtime authority is stale.",
                snapshot.sequence,
                &snapshot.session_id,
            );
        }
        MobileConfigValidationResult::failure(
            MobileConfigValidationFailure::CoreUnavailable,
            "Mobile Core configuration validation is unavailable on this platform.",
            snapshot.sequence,
            &snapshot.session_id,
        )
    }
}
