use std::{
    fmt::Write as _,
    io,
    net::{Ipv4Addr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};

use mish_bridge::{
    ActivationTiming, DesktopMihomoProcess, DesktopMihomoProcessConfig, DesktopProfileService,
    DesktopRuntimeHost, LoopbackServerConfig, LoopbackServerHandle, ManagedMihomoResolver,
    ManagedRuntimePolicy, MihomoActivationManager, ProfileActivationCoordinator,
    ReqwestHttpsSourceReader, compose_desktop_runtime_with_capture,
    start_loopback_server_with_runtime_host_and_lifecycle,
};
use mish_platform_macos::{
    FileCaptureJournalStore, MacOsLifecycleEventSource, MacOsSystemProxyPlatform,
};
use mish_profile::{ProfilePreview, ProfileServiceError};
use mish_runtime::{CaptureReconciler, LoopbackProxyEndpoint, PlatformLifecycleEventSource};
use mish_settings::{
    FileSettingsRepository, LoginLaunchBehavior, SettingsAdapterKind, SettingsAvailability,
    SettingsCapabilities, SettingsService, SettingsServiceError, SettingsSnapshot, StartupPlatform,
    StartupPlatformError,
};
use serde::Serialize;
use tauri::Manager;
use tauri_plugin_autostart::ManagerExt;

mod status_bar;

const DEV_ORIGIN: &str = "http://127.0.0.1:4173";
const PRODUCTION_ORIGINS: [&str; 2] = ["tauri://localhost", "https://tauri.localhost"];
const LOGIN_STARTUP_ARGUMENT: &str = "--mish-login-startup";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeBootstrap {
    auth_token: String,
    native_sidebar_material: bool,
    rpc_url: String,
    settings_snapshot: SettingsSnapshot,
}

#[derive(Clone)]
struct BridgeState(Arc<Mutex<Option<LoopbackServerHandle>>>);

#[derive(Clone)]
struct ProfileState(Arc<DesktopProfileService>);

#[derive(Clone)]
struct SettingsState(Arc<SettingsService>);

struct TauriStartupPlatform(tauri::AppHandle);

impl StartupPlatform for TauriStartupPlatform {
    fn is_enabled(&self) -> Result<bool, StartupPlatformError> {
        self.0
            .autolaunch()
            .is_enabled()
            .map_err(|_| StartupPlatformError)
    }

    fn set_enabled(&self, enabled: bool) -> Result<(), StartupPlatformError> {
        let manager = self.0.autolaunch();
        if enabled {
            manager.enable()
        } else {
            manager.disable()
        }
        .map_err(|_| StartupPlatformError)
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProfileCommandError {
    code: &'static str,
    field_identity: Option<&'static str>,
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
        field_identity: None,
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
    let bridge_state = BridgeState(Arc::new(Mutex::new(None)));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![LOGIN_STARTUP_ARGUMENT]),
        ))
        .manage(bridge_state.clone())
        .setup(initialize)
        .invoke_handler(tauri::generate_handler![
            runtime_bootstrap,
            profile_preflight_local
        ])
        .build(tauri::generate_context!())
        .map_err(|error| error.to_string())?;
    let exit_code = app.run_return(|app, event| {
        if !cfg!(target_os = "macos") {
            return;
        }
        if let tauri::RunEvent::WindowEvent {
            label,
            event: tauri::WindowEvent::CloseRequested { api, .. },
            ..
        } = event
            && label == "main"
        {
            let behavior = app
                .state::<SettingsState>()
                .0
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .window_close_behavior;
            if should_hide_main_window_on_close(behavior) {
                api.prevent_close();
                if let Some(window) = app.get_webview_window("main") {
                    let _ = window.hide();
                }
            } else {
                app.exit(0);
            }
        }
    });
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
    let settings_service = Arc::new(
        SettingsService::load(
            Arc::new(FileSettingsRepository::new(
                profile_root.join("settings.json"),
            )),
            startup_platform(app),
            desktop_settings_capabilities(),
        )
        .map_err(settings_initialization_error)?,
    );
    let profile_service = Arc::new(
        ReqwestHttpsSourceReader::profile_service(profile_root.clone())
            .map_err(|_| io::Error::other("HTTPS profile reader could not be initialized"))?,
    );
    let resolver = managed_mihomo_resolver(
        tauri::is_dev(),
        std::env::var_os("MISH_MIHOMO_BIN").map(PathBuf::from),
        &profile_root,
        &app.path().resource_dir()?,
    );
    let lifecycle_source = platform_lifecycle_event_source()?;
    let bridge = tauri::async_runtime::block_on(async {
        let capture = Arc::new(CaptureReconciler::new(
            Arc::new(MacOsSystemProxyPlatform::new()),
            Arc::new(FileCaptureJournalStore::new(
                profile_root.join("system-proxy-journal.json"),
            )),
            LoopbackProxyEndpoint::managed(),
        ));
        let safe_runtime = compose_desktop_runtime_with_capture(
            Arc::new(DesktopMihomoProcess::new(DesktopMihomoProcessConfig {
                binary: None,
                config_directory: None,
                config_file: None,
            })),
            None,
            Some(capture.clone()),
        )
        .await
        .map_err(|error| io::Error::other(error.to_string()))?;
        let runtime_host = DesktopRuntimeHost::new(safe_runtime.clone());
        let activation_manager = Arc::new(MihomoActivationManager::new_with_capture(
            resolver,
            ActivationTiming::default(),
            Some(capture),
        ));
        activation_manager
            .shutdown()
            .await
            .map_err(|_| io::Error::other("safe startup state could not be recorded"))?;
        let activation = Arc::new(ProfileActivationCoordinator::new(
            profile_service.clone(),
            activation_manager,
            runtime_host.clone(),
            safe_runtime,
            ephemeral_runtime_policy,
        ));
        activation.start_scheduler().await;
        let status_bar_state =
            status_bar::StatusBarState::new(runtime_host.clone(), activation.clone());
        start_loopback_server_with_runtime_host_and_lifecycle(
            LoopbackServerConfig {
                allowed_origins: allowed_origins(tauri::is_dev()),
                auth_token: auth_token.clone(),
                bind: SocketAddr::from((Ipv4Addr::LOCALHOST, 0)),
                max_message_bytes: 1_048_576,
                profile_activation: Some(activation),
                profile_service: Some(profile_service.clone()),
                settings_service: Some(settings_service.clone()),
            },
            runtime_host,
            lifecycle_source,
        )
        .await
        .map_err(io::Error::other)
        .map(|bridge| (bridge, status_bar_state))
    })?;
    let (bridge, status_bar_state) = bridge;
    app.manage(RuntimeBootstrap {
        auth_token,
        native_sidebar_material: cfg!(target_os = "macos"),
        rpc_url: format!("ws://{}/rpc", bridge.address),
        settings_snapshot: settings_service.snapshot(SettingsAdapterKind::Rpc),
    });
    app.manage(ProfileState(profile_service));
    app.manage(SettingsState(settings_service.clone()));
    *app.state::<BridgeState>()
        .0
        .lock()
        .map_err(|_| io::Error::other("desktop bridge state is unavailable"))? = Some(bridge);
    if cfg!(target_os = "macos") {
        status_bar::initialize(app, status_bar_state)?;
    }
    if should_show_main_window(
        std::env::args().any(|argument| argument == LOGIN_STARTUP_ARGUMENT),
        settings_service
            .snapshot(SettingsAdapterKind::Rpc)
            .preferences
            .startup
            .login_launch_behavior,
    ) && let Some(window) = app.get_webview_window("main")
    {
        window.show()?;
        window.set_focus()?;
    }
    Ok(())
}

fn platform_lifecycle_event_source()
-> Result<Option<Arc<dyn PlatformLifecycleEventSource>>, io::Error> {
    #[cfg(target_os = "macos")]
    {
        MacOsLifecycleEventSource::new()
            .map(|source| Some(Arc::new(source) as Arc<dyn PlatformLifecycleEventSource>))
            .map_err(|_| io::Error::other("macOS lifecycle notifications are unavailable"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        Ok(None)
    }
}

fn startup_platform(app: &tauri::App) -> Option<Arc<dyn StartupPlatform>> {
    if cfg!(target_os = "macos") {
        Some(Arc::new(TauriStartupPlatform(app.handle().clone())))
    } else {
        None
    }
}

fn desktop_settings_capabilities() -> SettingsCapabilities {
    if cfg!(target_os = "macos") {
        SettingsCapabilities::macos(true)
    } else {
        SettingsCapabilities {
            background_launch: SettingsAvailability::Unavailable,
            backup_restore: SettingsAvailability::ComingLater,
            expert_configuration: SettingsAvailability::ComingLater,
            launch_at_login: SettingsAvailability::Unavailable,
            native_sidebar_material: SettingsAvailability::Unavailable,
            network_dns: SettingsAvailability::ComingLater,
            status_bar: SettingsAvailability::Unavailable,
            tun: SettingsAvailability::Unavailable,
            updates: SettingsAvailability::ComingLater,
            window_lifecycle: SettingsAvailability::Unavailable,
        }
    }
}

fn settings_initialization_error(error: SettingsServiceError) -> io::Error {
    io::Error::other(match error {
        SettingsServiceError::Persistence => "application settings storage is unavailable",
        SettingsServiceError::CapabilityUnavailable | SettingsServiceError::Startup => {
            "application settings platform integration is unavailable"
        }
    })
}

fn should_show_main_window(login_startup: bool, behavior: LoginLaunchBehavior) -> bool {
    !login_startup || behavior == LoginLaunchBehavior::ShowWindow
}

fn should_hide_main_window_on_close(behavior: mish_settings::WindowCloseBehavior) -> bool {
    behavior == mish_settings::WindowCloseBehavior::HideToStatusBar
}

fn managed_mihomo_resolver(
    is_dev: bool,
    explicit_development_binary: Option<PathBuf>,
    app_data_root: &Path,
    resource_directory: &Path,
) -> ManagedMihomoResolver {
    let runtime_root = app_data_root.join("runtime");
    if is_dev {
        let prepared = explicit_development_binary
            .unwrap_or_else(|| runtime_root.join("missing-explicit-development-binary"));
        return ManagedMihomoResolver::development(prepared, runtime_root);
    }
    ManagedMihomoResolver::production(resource_directory.to_path_buf(), runtime_root)
}

fn ephemeral_runtime_policy()
-> Result<ManagedRuntimePolicy, mish_bridge::RuntimeConfigGenerationError> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .map_err(|_| mish_bridge::RuntimeConfigGenerationError::UnsafeController)?;
    let address = listener
        .local_addr()
        .map_err(|_| mish_bridge::RuntimeConfigGenerationError::UnsafeController)?;
    drop(listener);
    let secret = generate_auth_token()
        .map_err(|_| mish_bridge::RuntimeConfigGenerationError::InvalidControllerSecret)?;
    ManagedRuntimePolicy::new(address, secret)
}

fn profile_command_error(error: ProfileServiceError) -> ProfileCommandError {
    match error {
        ProfileServiceError::Import(mish_profile::ImportError::UnsafeDeviceIntegration {
            field_identity,
        })
        | ProfileServiceError::Import(mish_profile::ImportError::UnsafeProviderPath {
            field_identity,
        }) => ProfileCommandError {
            code: "validation-failed",
            field_identity: Some(field_identity),
            message: "Profile validation failed",
        },
        ProfileServiceError::Import(_) => ProfileCommandError {
            code: "validation-failed",
            field_identity: None,
            message: "Profile validation failed",
        },
        ProfileServiceError::Repository(_) => ProfileCommandError {
            code: "storage-failed",
            field_identity: None,
            message: "Profile storage operation failed",
        },
        ProfileServiceError::PreviewNotFound => ProfileCommandError {
            code: "preview-not-found",
            field_identity: None,
            message: "Profile preflight was not found",
        },
        ProfileServiceError::ActiveProfileDeletionDisabled => ProfileCommandError {
            code: "activation-required",
            field_identity: None,
            message: "Active profiles cannot be deleted until transactional activation is available",
        },
        ProfileServiceError::SchedulingUnavailable => ProfileCommandError {
            code: "capability-unavailable",
            field_identity: None,
            message: "Scheduled refresh is available only for HTTPS profile sources",
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
    use super::{
        DEV_ORIGIN, PRODUCTION_ORIGINS, allowed_origins, generate_auth_token,
        managed_mihomo_resolver, should_hide_main_window_on_close, should_show_main_window,
    };
    use mish_bridge::MihomoResolveError;
    use mish_settings::{LoginLaunchBehavior, WindowCloseBehavior};

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

    #[test]
    fn development_requires_an_explicit_prepared_mihomo_binary() {
        let root = std::env::temp_dir().join("mish-tauri-dev-missing-binary-test");
        let resolver = managed_mihomo_resolver(true, None, &root, &root.join("resources"));

        assert!(matches!(
            resolver.resolve(),
            Err(MihomoResolveError::BinaryMissing)
        ));
    }

    #[test]
    fn production_reports_a_missing_packaged_mihomo_resource() {
        let root = std::env::temp_dir().join("mish-tauri-prod-missing-binary-test");
        let resolver = managed_mihomo_resolver(false, None, &root, &root.join("resources"));

        assert!(matches!(
            resolver.resolve(),
            Err(MihomoResolveError::BinaryMissing)
        ));
    }

    #[test]
    fn only_login_background_launch_keeps_the_window_hidden() {
        assert!(should_show_main_window(
            false,
            LoginLaunchBehavior::Background
        ));
        assert!(should_show_main_window(
            true,
            LoginLaunchBehavior::ShowWindow
        ));
        assert!(!should_show_main_window(
            true,
            LoginLaunchBehavior::Background
        ));
    }

    #[test]
    fn close_behavior_defaults_to_hiding_but_can_request_exit() {
        assert!(should_hide_main_window_on_close(
            WindowCloseBehavior::default()
        ));
        assert!(!should_hide_main_window_on_close(WindowCloseBehavior::Quit));
    }
}
