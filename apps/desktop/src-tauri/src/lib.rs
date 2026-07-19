use std::{
    fmt::Write as _,
    fs, io,
    io::Write as _,
    net::{Ipv4Addr, SocketAddr, TcpListener},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    time::{SystemTime, UNIX_EPOCH},
};

use mish_bridge::{
    ActivationTiming, DesktopMihomoProcess, DesktopMihomoProcessConfig, DesktopProfileService,
    DesktopRuntimeHost, LoopbackServerConfig, LoopbackServerHandle, ManagedMihomoResolver,
    ManagedRuntimePolicy, MihomoActivationManager, PreparedSupportBundle,
    ProfileActivationCoordinator, ReqwestHttpsSourceReader, SUPPORT_BUNDLE_MAX_BYTES,
    SupportBundleError, SupportBundlePlatform, SupportBundlePreview, SupportBundleService,
    compose_desktop_runtime_with_capture, start_loopback_server_with_runtime_host_and_lifecycle,
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
use tauri_plugin_dialog::DialogExt;
use uuid::Uuid;

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
    support_bundle_export: bool,
}

#[derive(Clone)]
struct BridgeState(Arc<Mutex<Option<LoopbackServerHandle>>>);

#[derive(Clone)]
struct ProfileState(Arc<DesktopProfileService>);

#[derive(Clone)]
struct SettingsState(Arc<SettingsService>);

#[derive(Clone)]
struct SupportBundleState {
    pending: Arc<Mutex<Option<PreparedSupportBundle>>>,
    service: SupportBundleService,
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

pub fn run() -> Result<i32, String> {
    let bridge_state = BridgeState(Arc::new(Mutex::new(None)));
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            Some(vec![LOGIN_STARTUP_ARGUMENT]),
        ))
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_os::init())
        .manage(bridge_state.clone())
        .setup(initialize)
        .invoke_handler(tauri::generate_handler![
            runtime_bootstrap,
            profile_preflight_local,
            diagnostics_support_bundle_preview,
            diagnostics_support_bundle_save
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
        let support_bundle = SupportBundleService::new(
            runtime_host.clone(),
            activation_manager.clone(),
            env!("CARGO_PKG_VERSION"),
            SupportBundlePlatform {
                architecture: tauri_plugin_os::arch().to_owned(),
                operating_system: tauri_plugin_os::platform().to_owned(),
                operating_system_version: tauri_plugin_os::version().to_string(),
            },
        );
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
        .map(|bridge| (bridge, status_bar_state, support_bundle))
    })?;
    let (bridge, status_bar_state, support_bundle) = bridge;
    app.manage(RuntimeBootstrap {
        auth_token,
        native_sidebar_material: cfg!(target_os = "macos"),
        rpc_url: format!("ws://{}/rpc", bridge.address),
        settings_snapshot: settings_service.snapshot(SettingsAdapterKind::Rpc),
        support_bundle_export: true,
    });
    app.manage(ProfileState(profile_service));
    app.manage(SettingsState(settings_service.clone()));
    app.manage(SupportBundleState {
        pending: Arc::new(Mutex::new(None)),
        service: support_bundle,
    });
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
    use std::fs;

    use super::{
        AtomicWriteFailurePoint, DEV_ORIGIN, PRODUCTION_ORIGINS, SUPPORT_BUNDLE_MAX_BYTES,
        SupportBundleSaveStatus, allowed_origins, atomic_write_support_bundle_with_failure,
        generate_auth_token, managed_mihomo_resolver, save_support_bundle_selection,
        should_hide_main_window_on_close, should_show_main_window,
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
