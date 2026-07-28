use serde::Serialize;
use tauri::{
    AppHandle, Runtime,
    plugin::{PluginApi, PluginHandle},
};

use crate::{
    MobileConfigCancelRequest, MobileConfigCancelResult, MobileConfigLoadRequest,
    MobileConfigLoadResult, MobileConfigValidationRequest, MobileConfigValidationResult,
    MobileVpnSnapshot, Result,
};

const PLUGIN_IDENTIFIER: &str = "com.asuka109.mish.vpn";

#[derive(Clone)]
pub struct MishVpn<R: Runtime>(PluginHandle<R>);

#[derive(Serialize)]
struct EmptyPayload {}

pub fn init<R: Runtime>(_app: &AppHandle<R>, api: PluginApi<R, ()>) -> Result<MishVpn<R>> {
    let handle = api.register_android_plugin(PLUGIN_IDENTIFIER, "MishVpnPlugin")?;
    Ok(MishVpn(handle))
}

impl<R: Runtime> MishVpn<R> {
    pub fn get_snapshot(&self) -> Result<MobileVpnSnapshot> {
        Ok(self.0.run_mobile_plugin("getSnapshot", EmptyPayload {})?)
    }

    pub fn request_notification_permission(&self) -> Result<MobileVpnSnapshot> {
        Ok(self
            .0
            .run_mobile_plugin("requestNotificationPermission", EmptyPayload {})?)
    }

    pub fn request_vpn_consent(&self) -> Result<MobileVpnSnapshot> {
        Ok(self
            .0
            .run_mobile_plugin("requestVpnConsent", EmptyPayload {})?)
    }

    pub fn start_fixture_lifecycle(&self) -> Result<MobileVpnSnapshot> {
        Ok(self
            .0
            .run_mobile_plugin("startFixtureLifecycle", EmptyPayload {})?)
    }

    pub fn stop(&self) -> Result<MobileVpnSnapshot> {
        Ok(self.0.run_mobile_plugin("stop", EmptyPayload {})?)
    }

    pub fn validate_config(
        &self,
        request: MobileConfigValidationRequest,
    ) -> MobileConfigValidationResult {
        if let Some(result) = MobileConfigValidationResult::preflight(&request) {
            return result;
        }
        self.0
            .run_mobile_plugin("validateConfig", &request)
            .unwrap_or_else(|_| MobileConfigValidationResult::plugin_failure(&request))
    }

    pub fn load_config(&self, request: MobileConfigLoadRequest) -> MobileConfigLoadResult {
        if let Some(result) = MobileConfigLoadResult::preflight(&request) {
            return result;
        }
        self.0
            .run_mobile_plugin("loadConfig", &request)
            .unwrap_or_else(|_| {
                MobileConfigLoadResult::plugin_failure(&request, self.get_snapshot().ok())
            })
    }

    pub fn cancel_config_load(
        &self,
        request: MobileConfigCancelRequest,
    ) -> MobileConfigCancelResult {
        self.0
            .run_mobile_plugin("cancelConfigLoad", &request)
            .unwrap_or(MobileConfigCancelResult {
                accepted: false,
                contract_version: 1,
                operation_id: request.operation_id,
            })
    }
}
