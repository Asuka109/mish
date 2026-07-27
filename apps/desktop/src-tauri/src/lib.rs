use std::{
    ffi::{OsStr, OsString},
    fmt::Write as _,
    fs, io,
    io::Read as _,
    io::Write as _,
    net::{Ipv4Addr, SocketAddr},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use mish_bridge::{
    ActivationTiming, BridgeShutdownOutcome, BrowserAsset, BrowserAssetSource,
    BrowserPairingPrompt, DesktopMihomoProcess, DesktopMihomoProcessConfig, DesktopProfileService,
    DesktopRuntimeHost, LOCAL_BACKUP_MAX_BYTES, LocalBackupError, LocalBackupPreview,
    LocalBackupScope, LocalBackupService, LocalRestoreConflictResolution, LocalRestorePreview,
    LocalRestoreResult, LoopbackPortSelection, LoopbackServerConfig, LoopbackServerHandle,
    ManagedCoreOwnership, ManagedMihomoResolver, ManagedRuntimeLease, ManagedRuntimePolicy,
    MihomoActivationManager, PreparedLocalBackup, PreparedLocalRestore, PreparedSupportBundle,
    PrivilegedCoreHost, ProfileActivationCoordinator, ProfileFileActions,
    RealManagedProcessPlatform, ReqwestHttpsSourceReader, SUPPORT_BUNDLE_MAX_BYTES,
    SupportBundleError, SupportBundlePlatform, SupportBundlePreview, SupportBundleService,
    TerminationEvidenceStore, compose_desktop_runtime_with_capture,
    start_loopback_server_with_runtime_host_and_lifecycle,
};
use mish_platform_macos::{
    DEV_TUN_SERVICE_CORE_PATH, DevelopmentTunStartup, FileCaptureJournalStore,
    MacOsLifecycleEventSource, MacOsNetworkDnsPlatform, MacOsProductionTunHelperPlatform,
    MacOsSystemProxyPlatform, MacOsTunHelperBoundary, MacOsTunHelperPlatform,
    MacOsTunServiceClient, dismiss_browser_pairing_pin, show_browser_pairing_pin,
    verify_development_core_file, verify_development_pinned_core,
};
use mish_profile::{ProfilePreview, ProfileServiceError};
use mish_runtime::{
    CaptureAuditReason, CaptureReconciler, CaptureSelection, LoopbackProxyEndpoint,
    PlatformLifecycleEventSource, StatusAdapterKind as RuntimeStatusAdapterKind,
    TunHelperController, TunHelperPlatform,
};
use mish_settings::{
    ApplicationLaunchBehavior, FileSettingsRepository, LoginLaunchBehavior, ManagedPortPreferences,
    SettingsAdapterKind, SettingsAvailability, SettingsBuildInfo, SettingsCapabilities,
    SettingsService, SettingsServiceError, SettingsSnapshot, StartupPlatform, StartupPlatformError,
    WindowSurfacePlatform, WindowSurfacePlatformError, WindowSurfacePreference,
};
use mish_state_authority::StateMutationAuthority;
use serde::Serialize;
use tauri::{
    Manager,
    window::{Effect, EffectState, EffectsBuilder},
};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

mod graceful_exit;
mod native_menu;
mod route_activity_summary;
mod status_bar;

const DEV_ORIGIN: &str = "http://127.0.0.1:4173";
const DEV_ORIGIN_ENV: &str = "MISH_DEV_ORIGIN";
const DESKTOP_DEMO_ENV: &str = "MISH_DESKTOP_DEMO";
const DEVELOPMENT_CORE_SOURCE_ENV: &str = "MISH_DEVELOPMENT_CORE_SOURCE";
const DEVTOOLS_ENV: &str = "MISH_DEVTOOLS";
const TART_TUN_ACCEPTANCE_ENV: &str = "MISH_TART_TUN_ACCEPTANCE";
const DEVTOOLS_ARGUMENT: &str = "--devtools";
const RELEASE_PROFILE_EVIDENCE_ARGUMENT: &str = "--release-profile-evidence";
const PRODUCTION_ORIGINS: [&str; 2] = ["tauri://localhost", "https://tauri.localhost"];
const LOGIN_STARTUP_ARGUMENT: &str = "--mish-login-startup";

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct StartupOptions {
    devtools: DevtoolsStartup,
    tart_tun_acceptance: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DevtoolsStartup {
    Disabled,
    Enabled(DevtoolsStartupSource),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DevtoolsStartupSource {
    CommandLine,
    Environment,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum StartupOptionsError {
    MalformedDevtoolsArgument,
    MalformedDevtoolsEnvironment,
    MalformedTartTunAcceptanceEnvironment,
}

impl std::fmt::Display for StartupOptionsError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::MalformedDevtoolsArgument => formatter.write_str(
                "--devtools does not accept a value; the WebView Inspector remains disabled",
            ),
            Self::MalformedDevtoolsEnvironment => formatter.write_str(
                "MISH_DEVTOOLS must be exactly 1 or 0; the WebView Inspector remains disabled",
            ),
            Self::MalformedTartTunAcceptanceEnvironment => formatter.write_str(
                "MISH_TART_TUN_ACCEPTANCE must be exactly 1 or 0; development TUN remains disabled",
            ),
        }
    }
}

impl std::error::Error for StartupOptionsError {}

impl StartupOptions {
    fn parse<I, S>(
        arguments: I,
        devtools_environment: Option<&OsStr>,
        tart_tun_acceptance_environment: Option<&OsStr>,
    ) -> Result<Self, StartupOptionsError>
    where
        I: IntoIterator<Item = S>,
        S: Into<OsString>,
    {
        let mut devtools_argument = false;
        for argument in arguments.into_iter().skip(1).map(Into::into) {
            if argument == OsStr::new("--") {
                break;
            }
            if argument == OsStr::new(DEVTOOLS_ARGUMENT) {
                devtools_argument = true;
                continue;
            }
            if argument
                .to_str()
                .is_some_and(|argument| argument.starts_with("--devtools="))
            {
                return Err(StartupOptionsError::MalformedDevtoolsArgument);
            }
        }

        if devtools_argument {
            return Ok(Self {
                devtools: DevtoolsStartup::Enabled(DevtoolsStartupSource::CommandLine),
                tart_tun_acceptance: exact_process_opt_in(
                    tart_tun_acceptance_environment,
                    StartupOptionsError::MalformedTartTunAcceptanceEnvironment,
                )?,
            });
        }

        let devtools = match devtools_environment {
            None => DevtoolsStartup::Disabled,
            Some(value) if value == OsStr::new("0") => DevtoolsStartup::Disabled,
            Some(value) if value == OsStr::new("1") => {
                DevtoolsStartup::Enabled(DevtoolsStartupSource::Environment)
            }
            Some(_) => return Err(StartupOptionsError::MalformedDevtoolsEnvironment),
        };
        Ok(Self {
            devtools,
            tart_tun_acceptance: exact_process_opt_in(
                tart_tun_acceptance_environment,
                StartupOptionsError::MalformedTartTunAcceptanceEnvironment,
            )?,
        })
    }

    fn devtools_enabled(self) -> bool {
        matches!(self.devtools, DevtoolsStartup::Enabled(_))
    }

    fn tart_tun_acceptance_enabled(self, is_dev: bool) -> bool {
        is_dev && self.tart_tun_acceptance
    }
}

fn exact_process_opt_in(
    value: Option<&OsStr>,
    malformed: StartupOptionsError,
) -> Result<bool, StartupOptionsError> {
    match value {
        None => Ok(false),
        Some(value) if value == OsStr::new("0") => Ok(false),
        Some(value) if value == OsStr::new("1") => Ok(true),
        Some(_) => Err(malformed),
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum DesktopWebviewInspectorSupport {
    Supported,
    UnsupportedPlatform,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeBootstrap {
    auth_token: String,
    local_backup: bool,
    rpc_url: String,
    settings_snapshot: SettingsSnapshot,
    support_bundle_export: bool,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseProfileEvidence {
    profile: &'static str,
    tun: SettingsAvailability,
    updater: mish_updater::UpdaterAvailability,
}

struct MainWindowStartup {
    reveal_on_ready: bool,
}

struct TauriBrowserAssetSource(tauri::AppHandle);

impl BrowserAssetSource for TauriBrowserAssetSource {
    fn get(&self, path: &str) -> Option<BrowserAsset> {
        self.0
            .asset_resolver()
            .get(path.to_owned())
            .map(|asset| BrowserAsset {
                bytes: asset.bytes,
                content_type: asset.mime_type,
            })
    }
}

struct TauriBrowserPairingPrompt(tauri::AppHandle);

impl BrowserPairingPrompt for TauriBrowserPairingPrompt {
    fn show_pin(&self, pin: &str) -> Result<(), String> {
        let pin = pin.to_owned();
        self.0
            .run_on_main_thread(move || show_browser_pairing_pin(&pin))
            .map_err(|_| "browser pairing prompt is unavailable".into())
    }
}

#[derive(Clone)]
struct BridgeState(Arc<Mutex<Option<LoopbackServerHandle>>>);

#[derive(Clone)]
struct ProfileState {
    service: Arc<DesktopProfileService>,
}

#[derive(Clone)]
struct SettingsState(Arc<SettingsService>);

#[derive(Clone)]
struct SupportBundleState {
    pending: Arc<Mutex<Option<PreparedSupportBundle>>>,
    service: SupportBundleService,
}

#[derive(Clone)]
struct LocalBackupState {
    activation: Arc<ProfileActivationCoordinator>,
    pending_export: Arc<Mutex<Option<PreparedLocalBackup>>>,
    pending_restore: Arc<Mutex<Option<PreparedLocalRestore>>>,
    service: LocalBackupService,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct LocalBackupCommandError {
    code: &'static str,
    message: &'static str,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct SupportBundleCommandError {
    code: &'static str,
    message: &'static str,
}

#[derive(Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
enum SupportBundleSaveStatus {
    Cancelled,
    Written,
}

#[derive(Debug, Serialize)]
struct SupportBundleSaveResult {
    status: SupportBundleSaveStatus,
}

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

struct TauriWindowSurfacePlatform(tauri::WebviewWindow);

impl WindowSurfacePlatform for TauriWindowSurfacePlatform {
    fn set_surface(
        &self,
        surface: WindowSurfacePreference,
    ) -> Result<(), WindowSurfacePlatformError> {
        match surface {
            WindowSurfacePreference::Material => self.0.set_effects(
                EffectsBuilder::new()
                    .effect(Effect::Sidebar)
                    .state(EffectState::FollowsWindowActiveState)
                    .build(),
            ),
            WindowSurfacePreference::Opaque => self.0.set_effects(None),
        }
        .map_err(|_| WindowSurfacePlatformError)
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
fn reveal_main_window(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, MainWindowStartup>,
) -> Result<(), String> {
    if !state.reveal_on_ready {
        return Ok(());
    }
    window.show().map_err(|error| error.to_string())?;
    window.unminimize().map_err(|error| error.to_string())?;
    window.set_focus().map_err(|error| error.to_string())
}

#[tauri::command]
fn open_system_proxy_settings() -> mish_platform_macos::SystemProxySettingsOpenOutcome {
    mish_platform_macos::open_system_proxy_settings()
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
        .service
        .preflight_local(path, label)
        .await
        .map(Some)
        .map_err(profile_command_error)
}

#[tauri::command]
async fn diagnostics_support_bundle_preview(
    state: tauri::State<'_, SupportBundleState>,
) -> Result<SupportBundlePreview, SupportBundleCommandError> {
    let preview_id = Uuid::new_v4().to_string();
    let prepared = state
        .service
        .prepare(preview_id, now_unix_milliseconds())
        .await
        .map_err(support_bundle_prepare_error)?;
    let preview = prepared.preview.clone();
    *state
        .pending
        .lock()
        .map_err(|_| support_bundle_state_error())? = Some(prepared);
    Ok(preview)
}

#[tauri::command]
async fn diagnostics_support_bundle_save(
    app: tauri::AppHandle,
    preview_id: String,
    state: tauri::State<'_, SupportBundleState>,
) -> Result<SupportBundleSaveResult, SupportBundleCommandError> {
    let prepared = {
        let mut pending = state
            .pending
            .lock()
            .map_err(|_| support_bundle_state_error())?;
        if !pending
            .as_ref()
            .is_some_and(|prepared| prepared.preview.preview_id == preview_id)
        {
            return Err(SupportBundleCommandError {
                code: "preview-expired",
                message: "Generate a new support bundle preview before saving",
            });
        }
        pending.take().ok_or_else(support_bundle_state_error)?
    };
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Mish support bundle", &["json"])
            .set_file_name("mish-support-bundle.json")
            .set_title("Save Mish support bundle")
            .blocking_save_file()
    })
    .await
    .map_err(|_| SupportBundleCommandError {
        code: "dialog-unavailable",
        message: "The native save dialog is unavailable",
    })?;
    let Some(selected) = selected else {
        return Ok(SupportBundleSaveResult {
            status: save_support_bundle_selection(None, &prepared.bytes)
                .map_err(|_| support_bundle_write_error())?,
        });
    };
    let destination = selected
        .into_path()
        .map_err(|_| SupportBundleCommandError {
            code: "unsupported-destination",
            message: "The selected destination cannot be written by this desktop build",
        })?;
    let bytes = prepared.bytes;
    let status = tauri::async_runtime::spawn_blocking(move || {
        save_support_bundle_selection(Some(&destination), &bytes)
    })
    .await
    .map_err(|_| support_bundle_write_error())?
    .map_err(|_| support_bundle_write_error())?;
    Ok(SupportBundleSaveResult { status })
}

#[tauri::command]
async fn local_backup_export_preview(
    scope: LocalBackupScope,
    state: tauri::State<'_, LocalBackupState>,
) -> Result<LocalBackupPreview, LocalBackupCommandError> {
    let preview_id = Uuid::new_v4().to_string();
    let service = state.service.clone();
    let prepared = tauri::async_runtime::spawn_blocking(move || {
        service.prepare_export(preview_id, scope, now_unix_milliseconds())
    })
    .await
    .map_err(|_| local_backup_state_error())?
    .map_err(local_backup_error)?;
    let preview = prepared.preview.clone();
    *state
        .pending_export
        .lock()
        .map_err(|_| local_backup_state_error())? = Some(prepared);
    Ok(preview)
}

#[tauri::command]
async fn local_backup_export_save(
    app: tauri::AppHandle,
    preview_id: String,
    state: tauri::State<'_, LocalBackupState>,
) -> Result<SupportBundleSaveResult, LocalBackupCommandError> {
    let prepared = {
        let mut pending = state
            .pending_export
            .lock()
            .map_err(|_| local_backup_state_error())?;
        if !pending
            .as_ref()
            .is_some_and(|prepared| prepared.preview.preview_id == preview_id)
        {
            return Err(LocalBackupCommandError {
                code: "preview-expired",
                message: "Generate a new local backup preview before saving",
            });
        }
        pending.take().ok_or_else(local_backup_state_error)?
    };
    let selected = tauri::async_runtime::spawn_blocking(move || {
        app.dialog()
            .file()
            .add_filter("Mish local backup", &["json"])
            .set_file_name("mish-local-backup.json")
            .set_title("Save Mish local backup")
            .blocking_save_file()
    })
    .await
    .map_err(|_| LocalBackupCommandError {
        code: "dialog-unavailable",
        message: "The native save dialog is unavailable",
    })?;
    let Some(selected) = selected else {
        return Ok(SupportBundleSaveResult {
            status: SupportBundleSaveStatus::Cancelled,
        });
    };
    let destination = selected.into_path().map_err(|_| LocalBackupCommandError {
        code: "unsupported-destination",
        message: "The selected destination cannot be written by this desktop build",
    })?;
    tauri::async_runtime::spawn_blocking(move || {
        atomic_write_bounded(
            &destination,
            &prepared.bytes,
            LOCAL_BACKUP_MAX_BYTES,
            "mish-backup",
        )
    })
    .await
    .map_err(|_| local_backup_write_error())?
    .map_err(|_| local_backup_write_error())?;
    Ok(SupportBundleSaveResult {
        status: SupportBundleSaveStatus::Written,
    })
}

#[tauri::command]
async fn local_backup_restore_preview(
    state: tauri::State<'_, LocalBackupState>,
) -> Result<Option<LocalRestorePreview>, LocalBackupCommandError> {
    invalidate_pending(&state.pending_restore)?;
    let selected = tauri::async_runtime::spawn_blocking(|| {
        rfd::FileDialog::new()
            .add_filter("Mish local backup", &["json"])
            .set_title("Choose a Mish local backup")
            .pick_file()
    })
    .await
    .map_err(|_| LocalBackupCommandError {
        code: "dialog-unavailable",
        message: "The native file picker is unavailable",
    })?;
    let Some(path) = selected else {
        return Ok(None);
    };
    let bytes = tauri::async_runtime::spawn_blocking(move || read_local_backup(&path))
        .await
        .map_err(|_| local_backup_read_error())?
        .map_err(|_| local_backup_read_error())?;
    let service = state.service.clone();
    let permit = service.try_begin_restore().map_err(local_backup_error)?;
    let active_profile_id = state
        .activation
        .active_profile_id_authorized(&permit)
        .await
        .map_err(|_| LocalBackupCommandError {
            code: "busy",
            message: "Another Profile or Settings mutation is in progress",
        })?;
    let (prepared, permit) = tauri::async_runtime::spawn_blocking(move || {
        let prepared = service.prepare_restore_authorized(
            &permit,
            Uuid::new_v4().to_string(),
            &bytes,
            active_profile_id.as_deref(),
        );
        (prepared, permit)
    })
    .await
    .map_err(|_| local_backup_state_error())?;
    let prepared = prepared.map_err(local_backup_error)?;
    drop(permit);
    let preview = prepared.preview.clone();
    *state
        .pending_restore
        .lock()
        .map_err(|_| local_backup_state_error())? = Some(prepared);
    Ok(Some(preview))
}

#[tauri::command]
async fn local_backup_restore_commit(
    preview_id: String,
    resolution: LocalRestoreConflictResolution,
    state: tauri::State<'_, LocalBackupState>,
) -> Result<LocalRestoreResult, LocalBackupCommandError> {
    let service = state.service.clone();
    let permit = service.try_begin_restore().map_err(local_backup_error)?;
    let prepared = {
        let mut pending = state
            .pending_restore
            .lock()
            .map_err(|_| local_backup_state_error())?;
        if !pending
            .as_ref()
            .is_some_and(|prepared| prepared.preview.preview_id == preview_id)
        {
            return Err(LocalBackupCommandError {
                code: "preview-expired",
                message: "Choose and validate the local backup again before restoring",
            });
        }
        pending.take().ok_or_else(local_backup_state_error)?
    };
    let active_profile_id = state
        .activation
        .active_profile_id_authorized(&permit)
        .await
        .map_err(|_| LocalBackupCommandError {
            code: "busy",
            message: "Another Profile or Settings mutation is in progress",
        })?;
    let (result, permit) = tauri::async_runtime::spawn_blocking(move || {
        let result = service.commit_restore_authorized(
            &permit,
            prepared,
            resolution,
            now_unix_milliseconds(),
            active_profile_id.as_deref(),
        );
        (result, permit)
    })
    .await
    .map_err(|_| local_backup_state_error())?;
    let result = result.map_err(local_backup_error)?;
    state.activation.publish().await;
    drop(permit);
    Ok(result)
}

fn invalidate_pending<T>(pending: &Mutex<Option<T>>) -> Result<(), LocalBackupCommandError> {
    *pending.lock().map_err(|_| local_backup_state_error())? = None;
    Ok(())
}

pub fn run() -> Result<i32, String> {
    let arguments = std::env::args_os().collect::<Vec<_>>();
    if arguments.len() == 2 && arguments[1] == OsStr::new(RELEASE_PROFILE_EVIDENCE_ARGUMENT) {
        println!(
            "{}",
            serde_json::to_string(&release_profile_evidence())
                .map_err(|_| "release profile evidence is unavailable")?
        );
        return Ok(0);
    }
    let startup_options = StartupOptions::parse(
        arguments,
        std::env::var_os(DEVTOOLS_ENV).as_deref(),
        std::env::var_os(TART_TUN_ACCEPTANCE_ENV).as_deref(),
    )
    .map_err(|error| error.to_string())?;
    let mut context = tauri::generate_context!();
    let open_devtools = configure_main_webview(&mut context, startup_options)?;
    let tart_tun_acceptance = startup_options.tart_tun_acceptance_enabled(tauri::is_dev());
    if desktop_demo_requested(
        tauri::is_dev(),
        std::env::var(DESKTOP_DEMO_ENV).ok().as_deref(),
    ) {
        return run_demo(context, open_devtools);
    }

    let requested_mihomo = std::env::var_os("MISH_MIHOMO_BIN").map(PathBuf::from);
    let development_core_source = std::env::var(DEVELOPMENT_CORE_SOURCE_ENV).ok();
    validate_development_mihomo_environment(
        tauri::is_dev(),
        requested_mihomo.as_deref(),
        development_core_source.as_deref(),
    )?;
    let bridge_state = BridgeState(Arc::new(Mutex::new(None)));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![LOGIN_STARTUP_ARGUMENT]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(
                    tauri_plugin_window_state::StateFlags::POSITION
                        | tauri_plugin_window_state::StateFlags::SIZE
                        | tauri_plugin_window_state::StateFlags::MAXIMIZED,
                )
                .build(),
        )
        .manage(graceful_exit::GracefulExitCoordinator::new())
        .manage(bridge_state.clone())
        .setup(move |app| initialize(app, requested_mihomo, open_devtools, tart_tun_acceptance))
        .on_menu_event(native_menu::handle_menu_event)
        .invoke_handler(tauri::generate_handler![
            runtime_bootstrap,
            reveal_main_window,
            open_system_proxy_settings,
            profile_preflight_local,
            diagnostics_support_bundle_preview,
            diagnostics_support_bundle_save,
            local_backup_export_preview,
            local_backup_export_save,
            local_backup_restore_preview,
            local_backup_restore_commit
        ])
        .build(context)
        .map_err(|error| error.to_string())?;
    let exit_code = app.run_return(|app, event| {
        if !cfg!(target_os = "macos") {
            return;
        }
        match event {
            tauri::RunEvent::ExitRequested { api, .. }
                if should_intercept_exit_request(
                    app.state::<graceful_exit::GracefulExitCoordinator>()
                        .exit_is_authorized(),
                ) =>
            {
                api.prevent_exit();
                request_graceful_exit(app);
            }
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { api, .. },
                ..
            } if label == "main" => {
                let behavior = app
                    .state::<SettingsState>()
                    .0
                    .snapshot(SettingsAdapterKind::Rpc)
                    .preferences
                    .window_close_behavior;
                match main_window_close_action(behavior) {
                    MainWindowCloseAction::Hide => {
                        api.prevent_close();
                        if let Some(window) = app.get_webview_window("main") {
                            let _ = window.hide();
                        }
                    }
                    MainWindowCloseAction::GracefulExit => {
                        api.prevent_close();
                        request_graceful_exit(app);
                    }
                }
            }
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => status_bar::show_main_window(app, None),
            _ => {}
        }
    });
    dismiss_browser_pairing_pin();
    let bridge = bridge_state
        .0
        .lock()
        .map_err(|_| "desktop bridge state is unavailable")?
        .take();
    if let Some(bridge) = bridge {
        match tauri::async_runtime::block_on(bridge.shutdown()) {
            BridgeShutdownOutcome::Confirmed(_) => {}
            BridgeShutdownOutcome::Failed { failure, .. } => {
                return Err(format!(
                    "desktop bridge fallback shutdown was not confirmed: {failure:?}"
                ));
            }
        }
    }
    Ok(exit_code)
}

fn run_demo(context: tauri::Context<tauri::Wry>, open_devtools: bool) -> Result<i32, String> {
    let app = tauri::Builder::default()
        .manage(graceful_exit::GracefulExitCoordinator::new())
        .manage(BridgeState(Arc::new(Mutex::new(None))))
        .manage(MainWindowStartup {
            reveal_on_ready: true,
        })
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                window.set_title("Mish Demo")?;
            }
            if cfg!(target_os = "macos") {
                native_menu::install_demo(app)?;
            }
            open_main_webview_inspector(app, open_devtools)?;
            Ok(())
        })
        .on_menu_event(native_menu::handle_menu_event)
        .invoke_handler(tauri::generate_handler![reveal_main_window])
        .build(context)
        .map_err(|error| error.to_string())?;
    let exit_code = app.run_return(|app, event| {
        if !cfg!(target_os = "macos") {
            return;
        }
        match event {
            tauri::RunEvent::WindowEvent {
                label,
                event: tauri::WindowEvent::CloseRequested { .. },
                ..
            } if label == "main" => app.exit(0),
            tauri::RunEvent::Reopen {
                has_visible_windows: false,
                ..
            } => status_bar::show_main_window(app, None),
            _ => {}
        }
    });
    dismiss_browser_pairing_pin();
    Ok(exit_code)
}

pub(crate) fn request_graceful_exit(app: &tauri::AppHandle) {
    let coordinator = app.state::<graceful_exit::GracefulExitCoordinator>();
    if coordinator.begin() != graceful_exit::GracefulExitRequest::Started {
        return;
    }

    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let bridge = app
            .state::<BridgeState>()
            .0
            .lock()
            .expect("desktop bridge state is unavailable")
            .take();
        let Some(bridge) = bridge else {
            app.state::<graceful_exit::GracefulExitCoordinator>()
                .authorize_exit();
            app.exit(0);
            return;
        };

        match bridge.shutdown().await {
            BridgeShutdownOutcome::Confirmed(report) if report.permits_exit() => {
                app.state::<SupportBundleState>()
                    .service
                    .record_normal_quit(now_unix_milliseconds());
                app.state::<graceful_exit::GracefulExitCoordinator>()
                    .authorize_exit();
                app.exit(0);
            }
            BridgeShutdownOutcome::Confirmed(_) => unreachable!("incomplete shutdown report"),
            BridgeShutdownOutcome::Failed {
                failure, handle, ..
            } => {
                *app.state::<BridgeState>()
                    .0
                    .lock()
                    .expect("desktop bridge state is unavailable") = Some(*handle);
                app.state::<graceful_exit::GracefulExitCoordinator>()
                    .record_failure(failure);
                status_bar::show_main_window(&app, Some("/status"));
                let _ = app.run_on_main_thread(mish_platform_macos::show_graceful_exit_error);
            }
        }
    });
}

fn initialize(
    app: &mut tauri::App,
    requested_mihomo: Option<PathBuf>,
    open_devtools: bool,
    tart_tun_acceptance: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    let auth_token = generate_auth_token().map_err(io::Error::other)?;
    let profile_root = app.path().app_data_dir()?;
    let runtime_root = profile_root.join("runtime");
    let runtime_lease = ManagedRuntimeLease::acquire(&runtime_root)
        .map_err(|error| io::Error::other(error.to_string()))?;
    let core_ownership = Arc::new(
        ManagedCoreOwnership::new(
            runtime_root,
            Arc::new(RealManagedProcessPlatform),
            runtime_lease,
        )
        .map_err(|error| io::Error::other(error.to_string()))?,
    );
    LocalBackupService::recover_pending(&profile_root)
        .map_err(|error| io::Error::other(error.to_string()))?;
    let mutation_authority = StateMutationAuthority::new();
    #[cfg(feature = "development-core-host")]
    let development_tun_service = (cfg!(target_os = "macos") && tauri::is_dev()).then(|| {
        let repository_root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../..");
        Arc::new(if tart_tun_acceptance {
            MacOsTunServiceClient::development_with_tart_tun_acceptance(repository_root)
        } else {
            MacOsTunServiceClient::development_with_lifecycle(repository_root)
        })
    });
    #[cfg(not(feature = "development-core-host"))]
    let development_tun_service: Option<Arc<MacOsTunServiceClient>> = None;
    let tun_helper_platform: Arc<dyn TunHelperPlatform> = match production_team_identifier() {
        Some(team_identifier) if cfg!(target_os = "macos") => {
            Arc::new(MacOsProductionTunHelperPlatform::system(team_identifier))
        }
        _ if tart_tun_acceptance => development_tun_service
            .as_ref()
            .cloned()
            .map(|service| service as Arc<dyn TunHelperPlatform>)
            .unwrap_or_else(|| {
                Arc::new(MacOsTunHelperPlatform::new(
                    MacOsTunHelperBoundary::Unpackaged,
                ))
            }),
        _ => Arc::new(MacOsTunHelperPlatform::new(if !cfg!(target_os = "macos") {
            MacOsTunHelperBoundary::UnsupportedSystem
        } else {
            MacOsTunHelperBoundary::Unpackaged
        })),
    };
    let tun_helper = Arc::new(TunHelperController::new(tun_helper_platform));
    let settings_service = Arc::new(
        SettingsService::load_with_platforms_and_authority_and_build(
            Arc::new(FileSettingsRepository::new(
                profile_root.join("settings.json"),
            )),
            startup_platform(app),
            window_surface_platform(app),
            desktop_settings_capabilities(),
            Some(tun_helper.clone()),
            cfg!(target_os = "macos").then(|| {
                Arc::new(MacOsNetworkDnsPlatform::new())
                    as Arc<dyn mish_settings::NetworkDnsPlatform>
            }),
            mutation_authority.clone(),
            SettingsBuildInfo::packaged(env!("CARGO_PKG_VERSION")),
        )
        .map_err(settings_initialization_error)?,
    );
    let profile_service = Arc::new(
        ReqwestHttpsSourceReader::profile_service_with_authority(
            profile_root.clone(),
            mutation_authority.clone(),
        )
        .map_err(|_| io::Error::other("HTTPS profile reader could not be initialized"))?,
    );
    let resource_directory = app.path().resource_dir()?;
    let lifecycle_source = platform_lifecycle_event_source()?;
    let bridge = tauri::async_runtime::block_on(async {
        tun_helper.refresh().await;
        let development_service_ready = match development_tun_service.as_ref() {
            Some(service) => match service.prepare_development_startup().await {
                DevelopmentTunStartup::Ready => true,
                DevelopmentTunStartup::ReadOnly(failure) => {
                    tun_helper.mark_runtime_unavailable(failure);
                    false
                }
            },
            _ => false,
        };
        let startup_mihomo = development_service_ready
            .then(|| PathBuf::from(DEV_TUN_SERVICE_CORE_PATH))
            .or(requested_mihomo);
        let resolver = managed_mihomo_resolver(
            tauri::is_dev(),
            startup_mihomo,
            &profile_root,
            &resource_directory,
        );
        let capture = Arc::new(CaptureReconciler::new_with_tun(
            Arc::new(MacOsSystemProxyPlatform::new()),
            Arc::new(FileCaptureJournalStore::new(
                profile_root.join("system-proxy-journal.json"),
            )),
            LoopbackProxyEndpoint::new(
                "127.0.0.1",
                settings_service
                    .snapshot(SettingsAdapterKind::Rpc)
                    .preferences
                    .managed_ports
                    .proxy,
            )
            .map_err(|_| io::Error::other("managed proxy endpoint is unavailable"))?,
            Some(tun_helper.clone()),
        ));
        capture.set_system_proxy_takeover_policy(
            settings_service
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .system_proxy_takeover_policy,
        );
        // Settings is authoritative for this durable choice.  A local-backup restore publishes
        // the same snapshot stream, so the next capture transaction observes the restored
        // policy without applying any operating-system setting during restore itself.
        let capture_policy_sync = capture.clone();
        let mut settings_policy_updates = settings_service.subscribe();
        tauri::async_runtime::spawn(async move {
            while let Ok(snapshot) = settings_policy_updates.recv().await {
                capture_policy_sync.set_system_proxy_takeover_policy(
                    snapshot.preferences.system_proxy_takeover_policy,
                );
            }
        });
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
        let runtime_host =
            DesktopRuntimeHost::with_mutation_authority(safe_runtime.clone(), mutation_authority);
        let privileged_host = development_tun_service
            .filter(|_| development_service_ready)
            .map(|service| service as Arc<dyn PrivilegedCoreHost>);
        let activation_manager = Arc::new(match privileged_host {
            Some(host) => MihomoActivationManager::new_privileged(
                resolver,
                ActivationTiming::default(),
                Some(capture.clone()),
                core_ownership,
                host,
            ),
            None => MihomoActivationManager::new_managed(
                resolver,
                ActivationTiming::default(),
                Some(capture.clone()),
                core_ownership,
            ),
        });
        let managed = activation_manager.managed_state().await;
        let prior_profile_id = managed
            .last_successful_profile_id()
            .or_else(|| managed.active_profile_id())
            .or_else(|| {
                managed
                    .last_attempt()
                    .filter(|attempt| {
                        attempt.outcome() == mish_bridge::ActivationOutcome::Succeeded
                    })
                    .map(|attempt| attempt.profile_id())
            })
            .map(str::to_owned);
        profile_service
            .initialize_selection(prior_profile_id.as_deref())
            .await
            .map_err(|_| io::Error::other("Profile selection could not be initialized"))?;
        let evidence_platform = SupportBundlePlatform {
            architecture: tauri_plugin_os::arch().to_owned(),
            operating_system: tauri_plugin_os::platform().to_owned(),
            operating_system_version: tauri_plugin_os::version().to_string(),
        };
        let termination_evidence = TerminationEvidenceStore::new(
            profile_root.join("support-evidence"),
            env!("CARGO_PKG_VERSION"),
            evidence_platform.clone(),
        );
        install_termination_panic_hook(termination_evidence.clone());
        let prior_termination_boundary =
            termination_evidence.begin_session(now_unix_milliseconds());
        let startup_recovery = activation_manager.recover_startup().await;
        if startup_recovery.is_err() {
            termination_evidence.record_startup_failure(now_unix_milliseconds());
        }
        startup_recovery.map_err(|_| {
            io::Error::other("managed Core startup recovery could not be completed")
        })?;
        if prior_termination_boundary {
            termination_evidence.record_startup_recovery(now_unix_milliseconds(), true);
        }
        let _ = capture.audit(CaptureAuditReason::Restart, false).await;
        activation_manager
            .shutdown()
            .await
            .map_err(|_| io::Error::other("safe startup state could not be recorded"))?;
        let support_bundle = SupportBundleService::new(
            runtime_host.clone(),
            activation_manager.clone(),
            env!("CARGO_PKG_VERSION"),
            SupportBundlePlatform {
                architecture: tauri_plugin_os::arch().to_owned(),
                operating_system: tauri_plugin_os::platform().to_owned(),
                operating_system_version: tauri_plugin_os::version().to_string(),
            },
            termination_evidence,
        );
        support_bundle.start_managed_core_exit_observation();
        let policy_capture = capture.clone();
        let policy_helper = tun_helper.clone();
        let policy_settings = settings_service.clone();
        let activation = Arc::new(ProfileActivationCoordinator::new(
            profile_service.clone(),
            activation_manager,
            runtime_host.clone(),
            safe_runtime,
            move || {
                let preferences = policy_settings
                    .snapshot(SettingsAdapterKind::Rpc)
                    .preferences;
                ephemeral_runtime_policy(preferences.managed_ports)?
                    .with_process_discovery_mode(preferences.process_discovery_mode)
                    .with_tart_tun_dns(tart_tun_acceptance)
                    .with_tun_enabled(
                        &policy_helper.snapshot(),
                        policy_capture.status().capture_selection.tun,
                    )
            },
        ));
        activation.start_scheduler().await;
        activation.start_directory_reconciler().await;
        let bridge = start_loopback_server_with_runtime_host_and_lifecycle(
            LoopbackServerConfig {
                allowed_origins: allowed_origins(
                    tauri::is_dev(),
                    std::env::var(DEV_ORIGIN_ENV).ok().as_deref(),
                )
                .map_err(io::Error::other)?,
                auth_token: auth_token.clone(),
                bind: SocketAddr::from((Ipv4Addr::LOCALHOST, 6474)),
                port_selection: LoopbackPortSelection::SequentialFallback,
                browser_assets: Some(Arc::new(TauriBrowserAssetSource(app.handle().clone()))),
                browser_pairing_prompt: Some(Arc::new(TauriBrowserPairingPrompt(
                    app.handle().clone(),
                ))),
                max_message_bytes: 1_048_576,
                profile_activation: Some(activation.clone()),
                profile_file_actions: Some(Arc::new(ProfileFileActions::system(
                    profile_root.join("profiles"),
                ))),
                profile_service: Some(profile_service.clone()),
                process_icon_resolver: Some(Arc::new(
                    mish_platform_macos::MacOsProcessIconResolver::default(),
                )),
                service_probes: Some(mish_bridge::ServiceProbeConfig {
                    state_path: Some(profile_root.join("service-monitors.json")),
                }),
                settings_service: Some(settings_service.clone()),
                updater_service: Some(Arc::new(mish_updater::UpdaterService::unconfigured(
                    format!("updater-{}", Uuid::new_v4()),
                ))),
            },
            runtime_host.clone(),
            lifecycle_source,
        )
        .await
        .map_err(io::Error::other)?;
        let browser_client = bridge
            .browser_client()
            .ok_or_else(|| io::Error::other("browser client host is unavailable"))?;
        if tauri::is_dev() {
            let launch_url = browser_client
                .issue_launch_url()
                .map_err(io::Error::other)?;
            println!("Mish Browser Client URL: {launch_url}");
        }
        let status_bar_state = status_bar::StatusBarState::new(
            runtime_host,
            activation.clone(),
            browser_client,
            settings_service.clone(),
        );
        Ok::<_, io::Error>((bridge, status_bar_state, support_bundle, activation))
    })?;
    let (bridge, status_bar_state, support_bundle, activation) = bridge;
    app.manage(RuntimeBootstrap {
        auth_token,
        local_backup: true,
        rpc_url: format!("ws://{}/rpc", bridge.address),
        settings_snapshot: settings_service.snapshot(SettingsAdapterKind::Rpc),
        support_bundle_export: true,
    });
    app.manage(MainWindowStartup {
        reveal_on_ready: should_show_main_window(
            std::env::args().any(|argument| argument == LOGIN_STARTUP_ARGUMENT),
            settings_service
                .snapshot(SettingsAdapterKind::Rpc)
                .preferences
                .startup
                .login_launch_behavior,
        ),
    });
    app.manage(ProfileState {
        service: profile_service,
    });
    app.manage(SettingsState(settings_service.clone()));
    app.manage(SupportBundleState {
        pending: Arc::new(Mutex::new(None)),
        service: support_bundle,
    });
    app.manage(LocalBackupState {
        activation: activation.clone(),
        pending_export: Arc::new(Mutex::new(None)),
        pending_restore: Arc::new(Mutex::new(None)),
        service: LocalBackupService::new(
            profile_root,
            settings_service.clone(),
            env!("CARGO_PKG_VERSION"),
        ),
    });
    *app.state::<BridgeState>()
        .0
        .lock()
        .map_err(|_| io::Error::other("desktop bridge state is unavailable"))? = Some(bridge);
    if cfg!(target_os = "macos") {
        native_menu::install(app, settings_service.clone())?;
        status_bar::initialize(app, status_bar_state)?;
    }
    let application_launch_behavior = settings_service
        .snapshot(SettingsAdapterKind::Rpc)
        .preferences
        .startup
        .launch_behavior;
    if application_launch_behavior != ApplicationLaunchBehavior::Off {
        launch_on_application_start(activation, application_launch_behavior);
    }
    open_main_webview_inspector(app, open_devtools)?;
    Ok(())
}

fn configure_main_webview(
    context: &mut tauri::Context<tauri::Wry>,
    startup_options: StartupOptions,
) -> Result<bool, String> {
    let open_devtools =
        resolve_devtools_behavior(startup_options, current_desktop_webview_inspector_support())?;
    let main_window = context
        .config_mut()
        .app
        .windows
        .iter_mut()
        .find(|window| window.label == "main")
        .ok_or_else(|| "the main desktop WebView configuration is unavailable".to_owned())?;
    main_window.devtools = Some(open_devtools);
    Ok(open_devtools)
}

fn resolve_devtools_behavior(
    startup_options: StartupOptions,
    support: DesktopWebviewInspectorSupport,
) -> Result<bool, String> {
    if !startup_options.devtools_enabled() {
        return Ok(false);
    }
    match support {
        DesktopWebviewInspectorSupport::Supported => Ok(true),
        DesktopWebviewInspectorSupport::UnsupportedPlatform => Err(
            "the WebView Inspector was requested, but this desktop platform is unsupported; the Inspector remains disabled"
                .to_owned(),
        ),
    }
}

fn current_desktop_webview_inspector_support() -> DesktopWebviewInspectorSupport {
    if cfg!(target_os = "macos") {
        DesktopWebviewInspectorSupport::Supported
    } else {
        DesktopWebviewInspectorSupport::UnsupportedPlatform
    }
}

fn open_main_webview_inspector(
    app: &tauri::App,
    open_devtools: bool,
) -> Result<(), Box<dyn std::error::Error>> {
    if !open_devtools {
        return Ok(());
    }
    let window = app
        .get_webview_window("main")
        .ok_or_else(|| io::Error::other("the main desktop WebView is unavailable"))?;
    window.open_devtools();
    eprintln!("Mish desktop WebView Inspector requested for this process only.");
    Ok(())
}

/// Starts the previously used Profile only after all native observers have been installed.
/// The coordinator publishes the pending activation snapshot before the Core process is started,
/// so the WebView and native status UI observe one lifecycle instead of maintaining local loaders.
fn launch_on_application_start(
    activation: Arc<ProfileActivationCoordinator>,
    behavior: ApplicationLaunchBehavior,
) {
    tauri::async_runtime::spawn(async move {
        match behavior {
            ApplicationLaunchBehavior::Core => {
                let _ = activation
                    .activate_last_successful_profile(&Uuid::new_v4().to_string())
                    .await;
            }
            ApplicationLaunchBehavior::Proxy => {
                let _ = activation
                    .launch_proxy(
                        &Uuid::new_v4().to_string(),
                        system_proxy_only_capture_selection(),
                        RuntimeStatusAdapterKind::Rpc,
                    )
                    .await;
            }
            ApplicationLaunchBehavior::Off => {}
        }
    });
}

fn system_proxy_only_capture_selection() -> CaptureSelection {
    CaptureSelection {
        system_proxy: true,
        tun: false,
    }
}

fn production_team_identifier() -> Option<&'static str> {
    production_team_identifier_for_profile(
        option_env!("MISH_MACOS_RELEASE_PROFILE"),
        option_env!("MISH_EXPECTED_APPLE_TEAM_IDENTIFIER"),
    )
}

fn release_profile_evidence() -> ReleaseProfileEvidence {
    let profile = option_env!("MISH_MACOS_RELEASE_PROFILE").unwrap_or("development");
    ReleaseProfileEvidence {
        profile,
        tun: if production_team_identifier().is_some() {
            SettingsAvailability::Supported
        } else {
            SettingsAvailability::Unavailable
        },
        updater: mish_updater::UpdaterAvailability::ContractOnly,
    }
}

fn production_team_identifier_for_profile(
    release_profile: Option<&'static str>,
    team_identifier: Option<&'static str>,
) -> Option<&'static str> {
    matches!(
        release_profile,
        Some("tun-production") | Some("tun-production-fixture")
    )
    .then_some(team_identifier.filter(|team| !team.is_empty()))
    .flatten()
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

fn window_surface_platform(app: &tauri::App) -> Option<Arc<dyn WindowSurfacePlatform>> {
    if cfg!(target_os = "macos") {
        app.get_webview_window("main").map(|window| {
            Arc::new(TauriWindowSurfacePlatform(window)) as Arc<dyn WindowSurfacePlatform>
        })
    } else {
        None
    }
}

fn desktop_settings_capabilities() -> SettingsCapabilities {
    if cfg!(target_os = "macos") {
        let mut capabilities = SettingsCapabilities::macos(true);
        capabilities.backup_restore = SettingsAvailability::Supported;
        capabilities
    } else {
        SettingsCapabilities {
            background_launch: SettingsAvailability::Unavailable,
            backup_restore: SettingsAvailability::Supported,
            expert_configuration: SettingsAvailability::ComingLater,
            launch_at_login: SettingsAvailability::Unavailable,
            native_sidebar_material: SettingsAvailability::Unavailable,
            network_dns: SettingsAvailability::Unavailable,
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
        SettingsServiceError::CapabilityUnavailable
        | SettingsServiceError::Startup
        | SettingsServiceError::WindowSurface => {
            "application settings platform integration is unavailable"
        }
        SettingsServiceError::TunHelper(_) => "TUN helper integration is unavailable",
        SettingsServiceError::Busy => "Profile and Settings mutation authority is unavailable",
    })
}

fn should_show_main_window(login_startup: bool, behavior: LoginLaunchBehavior) -> bool {
    !login_startup || behavior == LoginLaunchBehavior::ShowWindow
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum MainWindowCloseAction {
    Hide,
    GracefulExit,
}

fn main_window_close_action(behavior: mish_settings::WindowCloseBehavior) -> MainWindowCloseAction {
    if should_hide_main_window_on_close(behavior) {
        MainWindowCloseAction::Hide
    } else {
        MainWindowCloseAction::GracefulExit
    }
}

fn should_intercept_exit_request(exit_is_authorized: bool) -> bool {
    !exit_is_authorized
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
        let bundled_geodata =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../resources/geodata/snapshot");
        return ManagedMihomoResolver::development_with_bundled_geodata(
            prepared,
            runtime_root,
            bundled_geodata,
        );
    }
    ManagedMihomoResolver::production(resource_directory.to_path_buf(), runtime_root)
}

fn validate_development_mihomo_environment(
    is_dev: bool,
    requested_binary: Option<&Path>,
    source: Option<&str>,
) -> Result<(), String> {
    if is_dev {
        let requested_binary = requested_binary.ok_or_else(|| {
            "The tracked desktop development launcher did not provide a Core; restart with `pnpm desktop:dev`"
                .to_owned()
        })?;
        match source {
            Some("repository-pin") => {
                verify_development_pinned_core(requested_binary).map_err(|_| {
                    "The repository-pinned development Core failed its digest, file-type, or executable-mode check; rerun `pnpm desktop:dev`"
                        .to_owned()
                })?;
            }
            Some("explicit-override") => {
                verify_development_core_file(requested_binary).map_err(|_| {
                    "The explicit MISH_MIHOMO_BIN development Core is absent, unsafe, or not executable; restore it or unset the override"
                        .to_owned()
                })?;
            }
            _ => {
                return Err(
                    "The tracked desktop development launcher did not identify its Core source; restart with `pnpm desktop:dev`"
                        .to_owned(),
                );
            }
        }
    }
    Ok(())
}

fn install_termination_panic_hook(evidence: TerminationEvidenceStore) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        evidence.record_detected_application_crash_boundary(now_unix_milliseconds());
        previous(info);
    }));
}

fn desktop_demo_requested(is_dev: bool, requested: Option<&str>) -> bool {
    is_dev && requested == Some("1")
}

fn ephemeral_runtime_policy(
    ports: ManagedPortPreferences,
) -> Result<ManagedRuntimePolicy, mish_bridge::RuntimeConfigGenerationError> {
    let address = SocketAddr::from((Ipv4Addr::LOCALHOST, ports.controller));
    let secret = generate_auth_token()
        .map_err(|_| mish_bridge::RuntimeConfigGenerationError::InvalidControllerSecret)?;
    let endpoint = LoopbackProxyEndpoint::new("127.0.0.1", ports.proxy)
        .map_err(|_| mish_bridge::RuntimeConfigGenerationError::UnsafeController)?;
    Ok(ManagedRuntimePolicy::new(address, secret)?.with_proxy_endpoint(endpoint))
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
        ProfileServiceError::Patch(_) => ProfileCommandError {
            code: "validation-failed",
            field_identity: None,
            message: "Profile patch validation failed",
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
        ProfileServiceError::Busy => ProfileCommandError {
            code: "busy",
            field_identity: None,
            message: "Another Profile or Settings mutation is in progress",
        },
    }
}

fn allowed_origins(
    is_dev: bool,
    configured_development_origin: Option<&str>,
) -> Result<Vec<String>, &'static str> {
    if is_dev {
        let origin = configured_development_origin.unwrap_or(DEV_ORIGIN);
        let parsed = tauri::Url::parse(origin).map_err(|_| "invalid development Web origin")?;
        let port = parsed
            .port()
            .ok_or("development Web origin must include an explicit port")?;
        let expected = format!("http://127.0.0.1:{port}");
        if origin != expected {
            return Err("development Web origin must be an exact IPv4 loopback HTTP origin");
        }
        return Ok(vec![origin.to_owned()]);
    }
    Ok(PRODUCTION_ORIGINS.into_iter().map(str::to_owned).collect())
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

fn support_bundle_prepare_error(error: SupportBundleError) -> SupportBundleCommandError {
    match error {
        SupportBundleError::Serialization => SupportBundleCommandError {
            code: "manifest-failed",
            message: "The bounded support bundle manifest could not be generated",
        },
        SupportBundleError::SizeLimitExceeded => SupportBundleCommandError {
            code: "size-limit",
            message: "The support bundle exceeded its fixed size limit",
        },
    }
}

fn support_bundle_state_error() -> SupportBundleCommandError {
    SupportBundleCommandError {
        code: "state-unavailable",
        message: "The support bundle preview is unavailable",
    }
}

fn support_bundle_write_error() -> SupportBundleCommandError {
    SupportBundleCommandError {
        code: "write-failed",
        message: "The support bundle could not be saved",
    }
}

fn local_backup_error(error: LocalBackupError) -> LocalBackupCommandError {
    match error {
        LocalBackupError::InvalidScope => LocalBackupCommandError {
            code: "invalid-scope",
            message: "Select at least one valid local backup category",
        },
        LocalBackupError::InvalidManifest => LocalBackupCommandError {
            code: "invalid-manifest",
            message: "The selected file is not a valid Mish local backup",
        },
        LocalBackupError::UnsupportedVersion => LocalBackupCommandError {
            code: "unsupported-version",
            message: "The selected Mish local backup version is unsupported",
        },
        LocalBackupError::SizeLimitExceeded => LocalBackupCommandError {
            code: "size-limit",
            message: "The local backup exceeded its fixed size limit",
        },
        LocalBackupError::Storage => LocalBackupCommandError {
            code: "storage-failed",
            message: "The local backup storage operation failed",
        },
        LocalBackupError::StateChanged => LocalBackupCommandError {
            code: "preview-expired",
            message: "Local state changed after preview; validate the backup again",
        },
        LocalBackupError::Busy => LocalBackupCommandError {
            code: "busy",
            message: "Another Profile or Settings mutation is in progress",
        },
        LocalBackupError::RecoveryRequired => LocalBackupCommandError {
            code: "recovery-required",
            message: "Local restore recovery must complete before another restore",
        },
    }
}

fn local_backup_state_error() -> LocalBackupCommandError {
    LocalBackupCommandError {
        code: "state-unavailable",
        message: "The local backup preview is unavailable",
    }
}

fn local_backup_read_error() -> LocalBackupCommandError {
    LocalBackupCommandError {
        code: "read-failed",
        message: "The selected local backup could not be read safely",
    }
}

fn local_backup_write_error() -> LocalBackupCommandError {
    LocalBackupCommandError {
        code: "write-failed",
        message: "The local backup could not be saved",
    }
}

fn now_unix_milliseconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

fn atomic_write_support_bundle(destination: &Path, contents: &[u8]) -> io::Result<()> {
    atomic_write_support_bundle_with_failure(destination, contents, None)
}

fn save_support_bundle_selection(
    destination: Option<&Path>,
    contents: &[u8],
) -> io::Result<SupportBundleSaveStatus> {
    let Some(destination) = destination else {
        return Ok(SupportBundleSaveStatus::Cancelled);
    };
    atomic_write_support_bundle(destination, contents)?;
    Ok(SupportBundleSaveStatus::Written)
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum AtomicWriteFailurePoint {
    AfterCreate,
    BeforeRename,
}

fn atomic_write_support_bundle_with_failure(
    destination: &Path,
    contents: &[u8],
    failure: Option<AtomicWriteFailurePoint>,
) -> io::Result<()> {
    if contents.len() > SUPPORT_BUNDLE_MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "support bundle size limit exceeded",
        ));
    }
    let parent = destination
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "destination is unavailable"))?;
    if fs::symlink_metadata(destination).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "symbolic link destinations are unsupported",
        ));
    }
    let temporary = parent.join(format!(".mish-support-{}.tmp", Uuid::new_v4()));
    let mut guard = TemporarySupportBundle::new(temporary.clone());
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    if failure == Some(AtomicWriteFailurePoint::AfterCreate) {
        return Err(io::Error::other("injected support bundle write failure"));
    }
    file.write_all(contents)?;
    file.sync_all()?;
    drop(file);
    if failure == Some(AtomicWriteFailurePoint::BeforeRename) {
        return Err(io::Error::other("injected support bundle rename failure"));
    }
    fs::rename(&temporary, destination)?;
    guard.commit();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o600))?;
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

fn read_local_backup(path: &Path) -> io::Result<Vec<u8>> {
    let metadata = fs::symlink_metadata(path)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > LOCAL_BACKUP_MAX_BYTES as u64
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "local backup is not a bounded regular file",
        ));
    }
    let mut bytes = Vec::with_capacity(metadata.len() as usize);
    fs::File::open(path)?
        .take((LOCAL_BACKUP_MAX_BYTES + 1) as u64)
        .read_to_end(&mut bytes)?;
    if bytes.len() > LOCAL_BACKUP_MAX_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "local backup size limit exceeded",
        ));
    }
    Ok(bytes)
}

fn atomic_write_bounded(
    destination: &Path,
    contents: &[u8],
    max_bytes: usize,
    temporary_prefix: &str,
) -> io::Result<()> {
    if contents.len() > max_bytes {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "local file size limit exceeded",
        ));
    }
    let parent = destination
        .parent()
        .filter(|parent| parent.is_dir())
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "destination is unavailable"))?;
    if fs::symlink_metadata(destination).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "symbolic link destinations are unsupported",
        ));
    }
    let temporary = parent.join(format!(".{temporary_prefix}-{}.tmp", Uuid::new_v4()));
    let mut guard = TemporarySupportBundle::new(temporary.clone());
    let mut options = fs::OpenOptions::new();
    options.create_new(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&temporary)?;
    file.write_all(contents)?;
    file.sync_all()?;
    drop(file);
    fs::rename(&temporary, destination)?;
    guard.commit();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o600))?;
        fs::File::open(parent)?.sync_all()?;
    }
    Ok(())
}

struct TemporarySupportBundle {
    committed: bool,
    path: PathBuf,
}

impl TemporarySupportBundle {
    fn new(path: PathBuf) -> Self {
        Self {
            committed: false,
            path,
        }
    }

    fn commit(&mut self) {
        self.committed = true;
    }
}

impl Drop for TemporarySupportBundle {
    fn drop(&mut self) {
        if !self.committed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use std::{fs, os::unix::fs::PermissionsExt, path::PathBuf, sync::Mutex};

    use super::{
        AtomicWriteFailurePoint, DEV_ORIGIN, DesktopWebviewInspectorSupport, DevtoolsStartup,
        DevtoolsStartupSource, LOCAL_BACKUP_MAX_BYTES, MainWindowCloseAction, PRODUCTION_ORIGINS,
        SUPPORT_BUNDLE_MAX_BYTES, StartupOptions, SupportBundleSaveStatus, allowed_origins,
        atomic_write_bounded, atomic_write_support_bundle_with_failure, desktop_demo_requested,
        generate_auth_token, invalidate_pending, main_window_close_action, managed_mihomo_resolver,
        production_team_identifier_for_profile, read_local_backup, release_profile_evidence,
        resolve_devtools_behavior, save_support_bundle_selection, should_intercept_exit_request,
        should_show_main_window, system_proxy_only_capture_selection,
        validate_development_mihomo_environment,
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
    fn automatic_desktop_launch_is_system_proxy_only() {
        let selection = system_proxy_only_capture_selection();
        assert!(selection.system_proxy);
        assert!(!selection.tun);
    }

    #[test]
    fn devtools_startup_defaults_off_and_accepts_only_exact_environment_values() {
        assert_eq!(
            StartupOptions::parse(["mish"], None, None).unwrap(),
            StartupOptions {
                devtools: DevtoolsStartup::Disabled,
                tart_tun_acceptance: false,
            }
        );
        assert_eq!(
            StartupOptions::parse(["mish"], Some("0".as_ref()), None).unwrap(),
            StartupOptions {
                devtools: DevtoolsStartup::Disabled,
                tart_tun_acceptance: false,
            }
        );
        assert_eq!(
            StartupOptions::parse(["mish"], Some("1".as_ref()), None).unwrap(),
            StartupOptions {
                devtools: DevtoolsStartup::Enabled(DevtoolsStartupSource::Environment),
                tart_tun_acceptance: false,
            }
        );
        for value in ["", "true", "TRUE", "yes", " 1", "1 "] {
            let error = StartupOptions::parse(["mish"], Some(value.as_ref()), None)
                .expect_err("non-allowlisted values must fail closed")
                .to_string();
            assert!(error.contains("must be exactly 1 or 0"));
            assert!(error.contains("remains disabled"));
        }
    }

    #[test]
    fn devtools_command_line_flag_has_deterministic_environment_precedence() {
        for environment in [None, Some("0".as_ref()), Some("invalid".as_ref())] {
            assert_eq!(
                StartupOptions::parse(["mish", "--devtools"], environment, None).unwrap(),
                StartupOptions {
                    devtools: DevtoolsStartup::Enabled(DevtoolsStartupSource::CommandLine),
                    tart_tun_acceptance: false,
                }
            );
        }
        assert_eq!(
            StartupOptions::parse(["mish", "--", "--devtools"], Some("0".as_ref()), None,).unwrap(),
            StartupOptions {
                devtools: DevtoolsStartup::Disabled,
                tart_tun_acceptance: false,
            }
        );
    }

    #[test]
    fn malformed_devtools_command_line_values_fail_closed() {
        for argument in ["--devtools=1", "--devtools=true", "--devtools=0"] {
            let error = StartupOptions::parse(["mish", argument], Some("1".as_ref()), None)
                .expect_err("the flag must not accept values")
                .to_string();
            assert!(error.contains("does not accept a value"));
            assert!(error.contains("remains disabled"));
        }
    }

    #[test]
    fn devtools_opt_in_is_process_local_and_is_not_reused_by_later_parses() {
        let opted_in = StartupOptions::parse(["mish", "--devtools"], None, None).unwrap();
        let later_launch = StartupOptions::parse(["mish"], None, None).unwrap();

        assert!(opted_in.devtools_enabled());
        assert!(!later_launch.devtools_enabled());
    }

    #[test]
    fn tart_tun_acceptance_requires_an_exact_development_process_opt_in() {
        let opted_in =
            StartupOptions::parse(["mish"], None, Some("1".as_ref())).expect("exact opt-in");
        let ordinary = StartupOptions::parse(["mish"], None, None).unwrap();

        assert!(opted_in.tart_tun_acceptance_enabled(true));
        assert!(!opted_in.tart_tun_acceptance_enabled(false));
        assert!(!ordinary.tart_tun_acceptance_enabled(true));
        for value in ["", "true", "TRUE", "yes", " 1", "1 "] {
            let error = StartupOptions::parse(["mish"], None, Some(value.as_ref()))
                .expect_err("non-allowlisted values must fail closed")
                .to_string();
            assert!(error.contains("MISH_TART_TUN_ACCEPTANCE"));
            assert!(error.contains("remains disabled"));
        }
    }

    #[test]
    fn unsupported_platforms_return_a_bounded_diagnostic() {
        let requested = StartupOptions::parse(["mish", "--devtools"], None, None).unwrap();
        let error = resolve_devtools_behavior(
            requested,
            DesktopWebviewInspectorSupport::UnsupportedPlatform,
        )
        .expect_err("unsupported platforms must not claim the Inspector is enabled");

        assert!(error.contains("desktop platform is unsupported"));
        assert!(error.contains("remains disabled"));
        assert!(error.len() < 160);
    }

    #[test]
    fn supported_platform_behavior_tracks_only_the_current_startup_options() {
        let enabled = StartupOptions::parse(["mish"], Some("1".as_ref()), None).unwrap();
        let disabled = StartupOptions::parse(["mish"], None, None).unwrap();

        assert_eq!(
            resolve_devtools_behavior(enabled, DesktopWebviewInspectorSupport::Supported),
            Ok(true)
        );
        assert_eq!(
            resolve_devtools_behavior(disabled, DesktopWebviewInspectorSupport::Supported),
            Ok(false)
        );
    }

    #[test]
    fn development_accepts_only_the_explicit_vite_origin() {
        assert_eq!(allowed_origins(true, None).unwrap(), [DEV_ORIGIN]);
        assert_eq!(
            allowed_origins(true, Some("http://127.0.0.1:4174")).unwrap(),
            ["http://127.0.0.1:4174"]
        );
    }

    #[test]
    fn development_rejects_non_loopback_or_non_origin_overrides() {
        for origin in [
            "http://localhost:4174",
            "http://127.0.0.1:4174/",
            "https://127.0.0.1:4174",
            "http://example.com:4174",
        ] {
            assert!(allowed_origins(true, Some(origin)).is_err());
        }
    }

    #[test]
    fn production_accepts_only_bundled_tauri_origins() {
        assert_eq!(allowed_origins(false, None).unwrap(), PRODUCTION_ORIGINS);
    }

    #[test]
    fn only_an_explicit_tun_production_profile_can_enable_the_production_tun_capability() {
        for release_profile in [None, Some("alpha-ad-hoc"), Some("signed-direct")] {
            assert_eq!(
                production_team_identifier_for_profile(release_profile, Some("ABCDE12345")),
                None
            );
        }
        assert_eq!(
            production_team_identifier_for_profile(
                Some("tun-production-fixture"),
                Some("ABCDE12345")
            ),
            Some("ABCDE12345")
        );
    }

    #[test]
    fn packaged_release_profile_evidence_cannot_infer_tun_from_a_signing_team() {
        let evidence = release_profile_evidence();
        assert_eq!(
            evidence.updater,
            mish_updater::UpdaterAvailability::ContractOnly
        );
        assert_eq!(
            evidence.tun,
            if matches!(
                evidence.profile,
                "tun-production" | "tun-production-fixture"
            ) {
                mish_settings::SettingsAvailability::Supported
            } else {
                mish_settings::SettingsAvailability::Unavailable
            }
        );
    }

    #[test]
    fn development_requires_the_tracked_launcher_to_supply_a_verified_core() {
        let error = validate_development_mihomo_environment(true, None, None)
            .expect_err("development should fail before Tauri starts");

        assert!(error.contains("pnpm desktop:dev"));
    }

    #[test]
    fn desktop_demo_requires_an_explicit_development_only_request() {
        assert!(desktop_demo_requested(true, Some("1")));
        assert!(!desktop_demo_requested(true, None));
        assert!(!desktop_demo_requested(true, Some("true")));
        assert!(!desktop_demo_requested(false, Some("1")));
    }

    #[test]
    fn development_rejects_an_unverified_requested_mihomo_binary() {
        let requested = PathBuf::from("/private/tmp/mihomo");

        let error =
            validate_development_mihomo_environment(true, Some(&requested), Some("repository-pin"))
                .expect_err("an arbitrary development path must fail closed");
        assert!(error.contains("repository-pinned"));
    }

    #[test]
    fn development_preserves_a_safe_explicit_local_core_override() {
        let root = support_bundle_test_directory("explicit-development-core");
        let binary = root.join("local-mihomo");
        fs::write(&binary, b"fictional local Mihomo fixture").unwrap();
        let mut permissions = fs::metadata(&binary).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&binary, permissions).unwrap();

        assert_eq!(
            validate_development_mihomo_environment(true, Some(&binary), Some("explicit-override")),
            Ok(())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn development_does_not_fallback_from_a_missing_explicit_override() {
        let requested = PathBuf::from("/private/tmp/mish-fictional-missing-mihomo");
        let error = validate_development_mihomo_environment(
            true,
            Some(&requested),
            Some("explicit-override"),
        )
        .expect_err("a missing explicit override must fail before Tauri starts");

        assert!(error.contains("restore it or unset"));
    }

    #[test]
    fn production_does_not_require_the_development_environment_variable() {
        assert_eq!(
            validate_development_mihomo_environment(false, None, None),
            Ok(())
        );
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
        assert_eq!(
            main_window_close_action(WindowCloseBehavior::default()),
            MainWindowCloseAction::Hide
        );
        assert_eq!(
            main_window_close_action(WindowCloseBehavior::Quit),
            MainWindowCloseAction::GracefulExit
        );
    }

    #[test]
    fn programmatic_exit_is_intercepted_until_cleanup_authorizes_it() {
        assert!(should_intercept_exit_request(false));
        assert!(!should_intercept_exit_request(true));
    }

    #[test]
    fn cancelled_save_writes_nothing() {
        assert_eq!(
            save_support_bundle_selection(None, b"{}").unwrap(),
            SupportBundleSaveStatus::Cancelled
        );
    }

    #[test]
    fn support_bundle_write_is_private_and_atomic() {
        let root = support_bundle_test_directory("success");
        let destination = root.join("bundle.json");
        assert_eq!(
            save_support_bundle_selection(Some(&destination), b"{\"formatVersion\":1}").unwrap(),
            SupportBundleSaveStatus::Written
        );
        assert_eq!(fs::read(&destination).unwrap(), b"{\"formatVersion\":1}");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert_no_support_bundle_temporary_files(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn write_and_rename_failures_clean_temporary_files() {
        for (name, failure) in [
            ("write", AtomicWriteFailurePoint::AfterCreate),
            ("rename", AtomicWriteFailurePoint::BeforeRename),
        ] {
            let root = support_bundle_test_directory(name);
            let destination = root.join("bundle.json");
            assert!(
                atomic_write_support_bundle_with_failure(
                    &destination,
                    b"{\"formatVersion\":1}",
                    Some(failure),
                )
                .is_err()
            );
            assert!(!destination.exists());
            assert_no_support_bundle_temporary_files(&root);
            fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn oversized_support_bundle_is_rejected_without_writing() {
        let root = support_bundle_test_directory("oversized");
        let destination = root.join("bundle.json");

        assert!(
            save_support_bundle_selection(
                Some(&destination),
                &vec![b'x'; SUPPORT_BUNDLE_MAX_BYTES + 1],
            )
            .is_err()
        );
        assert!(!destination.exists());
        assert_no_support_bundle_temporary_files(&root);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn local_backup_file_boundary_is_private_atomic_and_bounded() {
        let root = support_bundle_test_directory("local-backup");
        let destination = root.join("backup.json");
        atomic_write_bounded(
            &destination,
            b"{\"formatVersion\":1}",
            LOCAL_BACKUP_MAX_BYTES,
            "mish-backup",
        )
        .unwrap();

        assert_eq!(
            read_local_backup(&destination).unwrap(),
            b"{\"formatVersion\":1}"
        );
        assert!(
            atomic_write_bounded(
                &root.join("oversized.json"),
                &vec![b'x'; LOCAL_BACKUP_MAX_BYTES + 1],
                LOCAL_BACKUP_MAX_BYTES,
                "mish-backup",
            )
            .is_err()
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&destination).unwrap().permissions().mode() & 0o777,
                0o600
            );
        }
        assert!(fs::read_dir(&root).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".mish-backup-")
        }));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn beginning_a_new_restore_preview_expires_the_previous_preview() {
        let pending = Mutex::new(Some("stale-preview"));

        invalidate_pending(&pending).unwrap();

        assert!(pending.lock().unwrap().is_none());
    }

    fn support_bundle_test_directory(name: &str) -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!(
            "mish-support-bundle-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        root
    }

    fn assert_no_support_bundle_temporary_files(root: &std::path::Path) {
        assert!(fs::read_dir(root).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".mish-support-")
        }));
    }
}
