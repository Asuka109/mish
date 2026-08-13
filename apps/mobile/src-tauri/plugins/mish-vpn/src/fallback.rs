use tauri::{AppHandle, Runtime, plugin::PluginApi};

use crate::lifecycle::LifecycleCommandKind;
use crate::{
    MobileConfigCancelRequest, MobileConfigCancelResult, MobileConfigLoadFailure,
    MobileConfigLoadRequest, MobileConfigLoadResult, MobileConfigValidationFailure,
    MobileConfigValidationRequest, MobileConfigValidationResult, MobileCoreProvenanceSnapshot,
    MobileTrafficCloseRequest, MobileTrafficCommandResult, MobileVpnCommandRequest,
    MobileVpnCommandResult, MobileVpnSnapshot, Result,
};
use crate::{
    MobileRouteCancelRequest, MobileRouteCancelResult, MobileRouteCommandRequest,
    MobileRouteCommandResult, MobileRouteSnapshot,
};

#[derive(Clone)]
pub struct MishVpn<R: Runtime>(AppHandle<R>);

pub fn init<R: Runtime>(app: &AppHandle<R>, _api: PluginApi<R, ()>) -> Result<MishVpn<R>> {
    Ok(MishVpn(app.clone()))
}

impl<R: Runtime> MishVpn<R> {
    pub async fn get_route_snapshot(&self) -> Result<MobileRouteSnapshot> {
        unreachable!("mobile Routes are not registered on non-Android targets")
    }

    pub async fn select_route_child(
        &self,
        _request: MobileRouteCommandRequest,
    ) -> Result<MobileRouteCommandResult> {
        unreachable!("mobile Routes are not registered on non-Android targets")
    }

    pub async fn cancel_route_selection(
        &self,
        request: MobileRouteCancelRequest,
    ) -> MobileRouteCancelResult {
        MobileRouteCancelResult {
            accepted: false,
            contract_version: 1,
            operation_id: request.operation_id,
        }
    }

    pub async fn get_snapshot(&self) -> Result<MobileVpnSnapshot> {
        Ok(MobileVpnSnapshot::unsupported())
    }

    pub async fn get_core_provenance(&self) -> Result<MobileCoreProvenanceSnapshot> {
        Ok(MobileCoreProvenanceSnapshot::unavailable())
    }

    pub async fn get_traffic_snapshot(&self) -> Result<mish_runtime::TrafficDataSnapshot> {
        Ok(mish_runtime::TrafficDataSnapshot::unavailable(
            mish_runtime::StatusAdapterKind::Native,
        ))
    }

    pub async fn close_traffic_connection(
        &self,
        request: MobileTrafficCloseRequest,
    ) -> Result<MobileTrafficCommandResult> {
        Ok(MobileTrafficCommandResult {
            failure: Some(mish_runtime::TrafficCommandFailureKind::Unsupported),
            operation: mish_runtime::TrafficCommandOperation::CloseConnection,
            operation_id: request.operation_id,
            remaining_connection_ids: Vec::new(),
            snapshot: mish_runtime::TrafficDataSnapshot::unavailable(
                mish_runtime::StatusAdapterKind::Native,
            ),
            status: mish_runtime::TrafficCommandStatus::Failure,
            target_count: 1,
        })
    }

    pub async fn request_notification_permission(
        &self,
        request: MobileVpnCommandRequest,
    ) -> Result<MobileVpnCommandResult> {
        Ok(MobileVpnCommandResult::unsupported(
            request.operation_id,
            LifecycleCommandKind::RequestNotificationPermission,
        ))
    }

    pub async fn request_vpn_consent(
        &self,
        request: MobileVpnCommandRequest,
    ) -> Result<MobileVpnCommandResult> {
        Ok(MobileVpnCommandResult::unsupported(
            request.operation_id,
            LifecycleCommandKind::RequestVpnConsent,
        ))
    }

    pub async fn start(&self, request: MobileVpnCommandRequest) -> Result<MobileVpnCommandResult> {
        Ok(MobileVpnCommandResult::unsupported(
            request.operation_id,
            LifecycleCommandKind::Start,
        ))
    }

    pub async fn stop(&self, request: MobileVpnCommandRequest) -> Result<MobileVpnCommandResult> {
        Ok(MobileVpnCommandResult::unsupported(
            request.operation_id,
            LifecycleCommandKind::Stop,
        ))
    }

    pub async fn cancel_lifecycle_operation(
        &self,
        request: MobileVpnCommandRequest,
    ) -> Result<MobileVpnCommandResult> {
        Ok(MobileVpnCommandResult::unsupported(
            request.operation_id,
            LifecycleCommandKind::Stop,
        ))
    }

    pub async fn validate_config(
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

    pub async fn load_config(&self, request: MobileConfigLoadRequest) -> MobileConfigLoadResult {
        if let Some(result) = MobileConfigLoadResult::preflight(&request) {
            return result;
        }
        MobileConfigLoadResult::plugin_failure(&request, Some(MobileVpnSnapshot::unsupported()))
            .with_failure(
                MobileConfigLoadFailure::CoreUnavailable,
                "Mobile Core configuration loading is unavailable on this platform.",
            )
    }

    pub fn cancel_config_load(
        &self,
        request: MobileConfigCancelRequest,
    ) -> MobileConfigCancelResult {
        MobileConfigCancelResult {
            accepted: false,
            contract_version: 1,
            operation_id: request.operation_id,
        }
    }
}
