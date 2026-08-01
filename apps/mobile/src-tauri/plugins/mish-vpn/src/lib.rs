use tauri::{
    AppHandle, Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
mod android;
mod error;
#[cfg(not(target_os = "android"))]
mod fallback;
mod lifecycle;
mod models;

pub use lifecycle::{
    LifecycleCommandKind, LifecycleFailure, LifecycleOperation, LifecycleOperationOutcome,
};

#[cfg(target_os = "android")]
use android as platform;
pub use error::{Error, Result};
#[cfg(not(target_os = "android"))]
use fallback as platform;
pub use models::{
    MobileConfigCancelRequest, MobileConfigCancelResult, MobileConfigLoadCancellation,
    MobileConfigLoadFailure, MobileConfigLoadOutcome, MobileConfigLoadRequest,
    MobileConfigLoadResult, MobileConfigLoadTiming, MobileConfigRollback,
    MobileConfigValidationFailure, MobileConfigValidationRequest, MobileConfigValidationResult,
    MobileVpnCommandRequest, MobileVpnCommandResult, MobileVpnSnapshot,
};

#[tauri::command]
async fn get_snapshot<R: Runtime>(app: AppHandle<R>) -> Result<MobileVpnSnapshot> {
    app.state::<platform::MishVpn<R>>().get_snapshot().await
}

#[tauri::command]
async fn request_notification_permission<R: Runtime>(
    app: AppHandle<R>,
    request: MobileVpnCommandRequest,
) -> Result<MobileVpnCommandResult> {
    app.state::<platform::MishVpn<R>>()
        .request_notification_permission(request)
        .await
}

#[tauri::command]
async fn request_vpn_consent<R: Runtime>(
    app: AppHandle<R>,
    request: MobileVpnCommandRequest,
) -> Result<MobileVpnCommandResult> {
    app.state::<platform::MishVpn<R>>()
        .request_vpn_consent(request)
        .await
}

#[tauri::command]
async fn start_fixture_lifecycle<R: Runtime>(
    app: AppHandle<R>,
    request: MobileVpnCommandRequest,
) -> Result<MobileVpnCommandResult> {
    app.state::<platform::MishVpn<R>>()
        .start_fixture_lifecycle(request)
        .await
}

#[tauri::command]
async fn stop<R: Runtime>(
    app: AppHandle<R>,
    request: MobileVpnCommandRequest,
) -> Result<MobileVpnCommandResult> {
    app.state::<platform::MishVpn<R>>().stop(request).await
}

#[tauri::command]
async fn cancel_lifecycle_operation<R: Runtime>(
    app: AppHandle<R>,
    request: MobileVpnCommandRequest,
) -> Result<MobileVpnCommandResult> {
    app.state::<platform::MishVpn<R>>()
        .cancel_lifecycle_operation(request)
        .await
}

#[tauri::command]
async fn validate_config<R: Runtime>(
    app: AppHandle<R>,
    request: MobileConfigValidationRequest,
) -> MobileConfigValidationResult {
    app.state::<platform::MishVpn<R>>()
        .validate_config(request)
        .await
}

#[tauri::command]
async fn load_config<R: Runtime>(
    app: AppHandle<R>,
    request: MobileConfigLoadRequest,
) -> MobileConfigLoadResult {
    app.state::<platform::MishVpn<R>>()
        .load_config(request)
        .await
}

#[tauri::command]
fn cancel_config_load<R: Runtime>(
    app: AppHandle<R>,
    request: MobileConfigCancelRequest,
) -> MobileConfigCancelResult {
    app.state::<platform::MishVpn<R>>()
        .cancel_config_load(request)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mish-vpn")
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            request_notification_permission,
            request_vpn_consent,
            start_fixture_lifecycle,
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
