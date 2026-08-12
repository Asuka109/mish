#[cfg(feature = "tauri-runtime")]
use tauri::{
    AppHandle, Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(all(feature = "tauri-runtime", target_os = "android"))]
mod android;
#[cfg(feature = "tauri-runtime")]
mod error;
#[cfg(all(feature = "tauri-runtime", not(target_os = "android")))]
mod fallback;
mod generated {
    pub(crate) mod platform_facts;
}
mod lifecycle;
mod mobile_traffic;
#[cfg(feature = "simulated-host")]
pub use lifecycle::simulated_host;
#[cfg(feature = "tauri-runtime")]
mod models;
#[cfg(feature = "tauri-runtime")]
mod observation;

#[cfg(feature = "simulated-host")]
pub use lifecycle::LifecyclePhase;
pub use lifecycle::{
    LifecycleCommandKind, LifecycleFailure, LifecycleOperation, LifecycleOperationOutcome,
};

#[cfg(all(feature = "tauri-runtime", target_os = "android"))]
use android as platform;
#[cfg(feature = "tauri-runtime")]
pub use error::{Error, Result};
#[cfg(all(feature = "tauri-runtime", not(target_os = "android")))]
use fallback as platform;
pub use mobile_traffic::{MobileTrafficCloseRequest, MobileTrafficCommandResult};
#[cfg(feature = "tauri-runtime")]
pub use models::{
    MobileConfigCancelRequest, MobileConfigCancelResult, MobileConfigLoadCancellation,
    MobileConfigLoadFailure, MobileConfigLoadOutcome, MobileConfigLoadRequest,
    MobileConfigLoadResult, MobileConfigLoadTiming, MobileConfigRollback,
    MobileConfigValidationFailure, MobileConfigValidationRequest, MobileConfigValidationResult,
    MobileCoreProvenanceSnapshot, MobileVpnCommandRequest, MobileVpnCommandResult,
    MobileVpnSnapshot,
};

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
async fn get_snapshot<R: Runtime>(app: AppHandle<R>) -> Result<MobileVpnSnapshot> {
    app.state::<platform::MishVpn<R>>().get_snapshot().await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
async fn get_core_provenance<R: Runtime>(
    app: AppHandle<R>,
) -> Result<MobileCoreProvenanceSnapshot> {
    app.state::<platform::MishVpn<R>>()
        .get_core_provenance()
        .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
async fn get_traffic_snapshot<R: Runtime>(
    app: AppHandle<R>,
) -> Result<mish_runtime::TrafficDataSnapshot> {
    app.state::<platform::MishVpn<R>>()
        .get_traffic_snapshot()
        .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
async fn close_traffic_connection<R: Runtime>(
    app: AppHandle<R>,
    request: MobileTrafficCloseRequest,
) -> Result<MobileTrafficCommandResult> {
    app.state::<platform::MishVpn<R>>()
        .close_traffic_connection(request)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
async fn request_notification_permission<R: Runtime>(
    app: AppHandle<R>,
    request: MobileVpnCommandRequest,
) -> Result<MobileVpnCommandResult> {
    app.state::<platform::MishVpn<R>>()
        .request_notification_permission(request)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
async fn request_vpn_consent<R: Runtime>(
    app: AppHandle<R>,
    request: MobileVpnCommandRequest,
) -> Result<MobileVpnCommandResult> {
    app.state::<platform::MishVpn<R>>()
        .request_vpn_consent(request)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
async fn start<R: Runtime>(
    app: AppHandle<R>,
    request: MobileVpnCommandRequest,
) -> Result<MobileVpnCommandResult> {
    app.state::<platform::MishVpn<R>>().start(request).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
async fn stop<R: Runtime>(
    app: AppHandle<R>,
    request: MobileVpnCommandRequest,
) -> Result<MobileVpnCommandResult> {
    app.state::<platform::MishVpn<R>>().stop(request).await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
async fn cancel_lifecycle_operation<R: Runtime>(
    app: AppHandle<R>,
    request: MobileVpnCommandRequest,
) -> Result<MobileVpnCommandResult> {
    app.state::<platform::MishVpn<R>>()
        .cancel_lifecycle_operation(request)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
async fn validate_config<R: Runtime>(
    app: AppHandle<R>,
    request: MobileConfigValidationRequest,
) -> MobileConfigValidationResult {
    app.state::<platform::MishVpn<R>>()
        .validate_config(request)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
async fn load_config<R: Runtime>(
    app: AppHandle<R>,
    request: MobileConfigLoadRequest,
) -> MobileConfigLoadResult {
    app.state::<platform::MishVpn<R>>()
        .load_config(request)
        .await
}

#[cfg(feature = "tauri-runtime")]
#[tauri::command]
fn cancel_config_load<R: Runtime>(
    app: AppHandle<R>,
    request: MobileConfigCancelRequest,
) -> MobileConfigCancelResult {
    app.state::<platform::MishVpn<R>>()
        .cancel_config_load(request)
}

#[cfg(feature = "tauri-runtime")]
pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mish-vpn")
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            get_core_provenance,
            get_traffic_snapshot,
            close_traffic_connection,
            request_notification_permission,
            request_vpn_consent,
            start,
            stop,
            cancel_lifecycle_operation,
            validate_config,
            load_config,
            cancel_config_load,
        ])
        .setup(|app, api| {
            app.manage(platform::init(app, api)?);
            Ok(())
        })
        .build()
}
