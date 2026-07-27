use tauri::{
    AppHandle, Manager, Runtime,
    plugin::{Builder, TauriPlugin},
};

#[cfg(target_os = "android")]
mod android;
mod error;
#[cfg(not(target_os = "android"))]
mod fallback;
mod models;

#[cfg(target_os = "android")]
use android as platform;
pub use error::{Error, Result};
#[cfg(not(target_os = "android"))]
use fallback as platform;
pub use models::{
    MobileConfigValidationFailure, MobileConfigValidationRequest, MobileConfigValidationResult,
    MobileVpnSnapshot,
};

#[tauri::command]
fn get_snapshot<R: Runtime>(app: AppHandle<R>) -> Result<MobileVpnSnapshot> {
    app.state::<platform::MishVpn<R>>().get_snapshot()
}

#[tauri::command]
fn request_notification_permission<R: Runtime>(app: AppHandle<R>) -> Result<MobileVpnSnapshot> {
    app.state::<platform::MishVpn<R>>()
        .request_notification_permission()
}

#[tauri::command]
fn request_vpn_consent<R: Runtime>(app: AppHandle<R>) -> Result<MobileVpnSnapshot> {
    app.state::<platform::MishVpn<R>>().request_vpn_consent()
}

#[tauri::command]
fn start_fixture_lifecycle<R: Runtime>(app: AppHandle<R>) -> Result<MobileVpnSnapshot> {
    app.state::<platform::MishVpn<R>>()
        .start_fixture_lifecycle()
}

#[tauri::command]
fn stop<R: Runtime>(app: AppHandle<R>) -> Result<MobileVpnSnapshot> {
    app.state::<platform::MishVpn<R>>().stop()
}

#[tauri::command]
fn validate_config<R: Runtime>(
    app: AppHandle<R>,
    request: MobileConfigValidationRequest,
) -> MobileConfigValidationResult {
    app.state::<platform::MishVpn<R>>().validate_config(request)
}

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("mish-vpn")
        .invoke_handler(tauri::generate_handler![
            get_snapshot,
            request_notification_permission,
            request_vpn_consent,
            start_fixture_lifecycle,
            stop,
            validate_config,
        ])
        .setup(|app, api| {
            app.manage(platform::init(app, api)?);
            Ok(())
        })
        .build()
}
