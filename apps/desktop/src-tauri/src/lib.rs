use std::{
    fmt::Write as _,
    io,
    net::{Ipv4Addr, SocketAddr},
    sync::{Arc, Mutex},
};

use mish_bridge::{
    DesktopMihomoProcess, DesktopMihomoProcessConfig, DesktopProfileService, LoopbackServerConfig,
    LoopbackServerHandle, ReqwestHttpsSourceReader, compose_desktop_runtime_with_capture,
    start_loopback_server,
};
use mish_platform_macos::{FileCaptureJournalStore, MacOsSystemProxyPlatform};
use mish_profile::{ProfilePreview, ProfileServiceError};
use mish_runtime::{CaptureReconciler, LoopbackProxyEndpoint};
use serde::Serialize;
use tauri::Manager;

const DEV_ORIGIN: &str = "http://127.0.0.1:4173";
const PRODUCTION_ORIGINS: [&str; 2] = ["tauri://localhost", "https://tauri.localhost"];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeBootstrap {
    auth_token: String,
    rpc_url: String,
}

#[derive(Clone)]
struct BridgeState(Arc<Mutex<Option<LoopbackServerHandle>>>);

#[derive(Clone)]
struct ProfileState(Arc<DesktopProfileService>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileCommandError {
    code: &'static str,
    message: &'static str,
}

#[tauri::command]
fn runtime_bootstrap(state: tauri::State<'_, RuntimeBootstrap>) -> RuntimeBootstrap {
    state.inner().clone()
}

#[tauri::command]
async fn profile_preflight_local(
    state: tauri::State<'_, ProfileState>,
    label: Option<String>,
) -> Result<Option<ProfilePreview>, ProfileCommandError> {
    let selected = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("Mihomo profile", &["yaml", "yml"])
            .set_title("Choose a Mihomo profile")
            .pick_file()
    })
    .await
    .map_err(|_| ProfileCommandError {
        code: "dialog-unavailable",
        message: "The native file picker is unavailable",
    })?;
    let Some(path) = selected else {
        return Ok(None);
    };

    state
        .0
        .preflight_local(path, label)
        .await
        .map(Some)
        .map_err(profile_command_error)
}

pub fn run() -> Result<i32, String> {
    let app = tauri::Builder::default()
        .setup(initialize)
        .invoke_handler(tauri::generate_handler![
            runtime_bootstrap,
            profile_preflight_local
        ])
        .build(tauri::generate_context!())
        .map_err(|error| error.to_string())?;
    let bridge_state = app.state::<BridgeState>().inner().clone();
    let exit_code = app.run_return(|_, _| {});
    let bridge = bridge_state
        .0
        .lock()
        .map_err(|_| "desktop bridge state is unavailable")?
        .take();
    if let Some(bridge) = bridge {
        tauri::async_runtime::block_on(bridge.shutdown());
    }
    Ok(exit_code)
}

fn initialize(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let auth_token = generate_auth_token().map_err(io::Error::other)?;
    let profile_root = app.path().app_data_dir()?;
    let profile_service = Arc::new(
        ReqwestHttpsSourceReader::profile_service(profile_root.clone())
            .map_err(|_| io::Error::other("HTTPS profile reader could not be initialized"))?,
    );
    let bridge = tauri::async_runtime::block_on(async {
        let capture = Arc::new(CaptureReconciler::new(
            Arc::new(MacOsSystemProxyPlatform::new()),
            Arc::new(FileCaptureJournalStore::new(
                profile_root.join("system-proxy-journal.json"),
            )),
            LoopbackProxyEndpoint::new("127.0.0.1", 7890)
                .map_err(|error| io::Error::other(error.to_string()))?,
        ));
        let runtime = compose_desktop_runtime_with_capture(
            Arc::new(DesktopMihomoProcess::new(DesktopMihomoProcessConfig {
                binary: None,
                config_directory: None,
                config_file: None,
            })),
            None,
            Some(capture),
        )
        .await
        .map_err(|error| io::Error::other(error.to_string()))?;
        start_loopback_server(
            LoopbackServerConfig {
                allowed_origins: allowed_origins(tauri::is_dev()),
                auth_token: auth_token.clone(),
                bind: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                max_message_bytes: 1_048_576,
                profile_service: Some(profile_service.clone()),
            },
            runtime,
        )
        .await
        .map_err(io::Error::other)
    })?;
    app.manage(RuntimeBootstrap {
        auth_token,
        rpc_url: format!("ws://{}/rpc", bridge.address),
    });
    app.manage(ProfileState(profile_service));
    app.manage(BridgeState(Arc::new(Mutex::new(Some(bridge)))));
    Ok(())
}

fn profile_command_error(error: ProfileServiceError) -> ProfileCommandError {
    match error {
        ProfileServiceError::Import(_) => ProfileCommandError {
            code: "validation-failed",
            message: "Profile validation failed",
        },
        ProfileServiceError::Repository(_) => ProfileCommandError {
            code: "storage-failed",
            message: "Profile storage operation failed",
        },
        ProfileServiceError::PreviewNotFound => ProfileCommandError {
            code: "preview-not-found",
            message: "Profile preflight was not found",
        },
        ProfileServiceError::ActiveProfileDeletionDisabled => ProfileCommandError {
            code: "activation-required",
            message: "Active profiles cannot be deleted until transactional activation is available",
        },
    }
}

fn allowed_origins(is_dev: bool) -> Vec<String> {
    if is_dev {
        return vec![DEV_ORIGIN.to_owned()];
    }
    PRODUCTION_ORIGINS.into_iter().map(str::to_owned).collect()
}

fn generate_auth_token() -> Result<String, String> {
    let mut bytes = [0_u8; 32];
    getrandom::fill(&mut bytes).map_err(|_| "the operating system did not provide entropy")?;
    let mut token = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        write!(token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(token)
}

#[cfg(test)]
mod tests {
    use super::{DEV_ORIGIN, PRODUCTION_ORIGINS, allowed_origins, generate_auth_token};

    #[test]
    fn authentication_tokens_are_fresh_256_bit_hex_values() {
        let first = generate_auth_token().expect("token generation should succeed");
        let second = generate_auth_token().expect("token generation should succeed");

        assert_eq!(first.len(), 64);
        assert!(first.bytes().all(|byte| byte.is_ascii_hexdigit()));
        assert_ne!(first, second);
    }

    #[test]
    fn development_accepts_only_the_explicit_vite_origin() {
        assert_eq!(allowed_origins(true), [DEV_ORIGIN]);
    }

    #[test]
    fn production_accepts_only_bundled_tauri_origins() {
        assert_eq!(allowed_origins(false), PRODUCTION_ORIGINS);
    }
}
